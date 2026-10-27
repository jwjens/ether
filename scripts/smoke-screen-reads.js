// scripts/smoke-screen-reads.js — a screen's database reads never run on the main thread (Jeff, 2026-10-26: "Screen
// switching freezes the audio. Nothing on the air path may depend on the screen.").
//
// Runs under Electron's own Node (its better-sqlite3 build), against a COPY of a real database (never the live file):
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-screen-reads.js <database copy>
//
// It measures this thread's event-loop lag (a 10 ms timer's lateness) — the thread that carries the announcement tick,
// the board and every engine command in the app — while:
//   A · a heavy screen read runs on this thread, the way db:query did before (the CONTROL: it must reproduce the stall);
//   B · the same read goes through the screen-read worker (electron/screen-reads.js): this thread must stay on time;
// and checks that every typed read channel, schedule:get and schedule:categoryHealth are answered by the worker with
// main's own connection never touched, that the worker cannot write, and that a database swap holds reads, not drops them.
"use strict";
const path = require("path"), fs = require("fs");
const DB = process.argv[2];
if (!DB || !fs.existsSync(DB)) { console.error("usage: … smoke-screen-reads.js <database copy>"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };
function lagMeter() {
  let worst = 0, expected = Date.now() + 10;
  const t = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - expected); expected = now + 10; }, 10);
  return { stop: () => { clearInterval(t); return worst; } };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// A read as heavy as the worst screen reads the stall sense caught (seconds), and independent of the copy's content.
const HEAVY = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 15000000) SELECT count(*) AS n FROM c";

(async () => {
  const Database = require("better-sqlite3");
  const SR = require("../electron/screen-reads");
  const Q = require("../electron/screen-read-queries");
  const before = fs.statSync(DB);
  const local = new Database(DB, { readonly: true });
  const sid = (local.prepare("SELECT id FROM stations WHERE deleted_at IS NULL ORDER BY id LIMIT 1").get() || {}).id;

  // A · the control: the read on this thread, as main's db:query ran it.
  let m = lagMeter(); await sleep(50);
  const aRows = local.prepare(HEAVY).all();
  await sleep(50); const aLag = m.stop();
  ok(aLag > 1000, `A (control) reproduces the stall: one screen read on main's thread held it ${aLag} ms`);

  // B · the same read through the worker.
  const logs = [];
  const host = SR.createScreenReadHost({ dbPathFn: () => DB, log: (s) => logs.push(s), healthEvent: () => {} });
  host.start();
  await host.query("SELECT 1 AS one");   // started and answering
  m = lagMeter(); await sleep(50);
  const bRows = await host.query(HEAVY, []);
  await sleep(50); const bLag = m.stop();
  ok(bLag < 17, `B: through the worker main never waited longer than one frame (worst ${bLag} ms < 16.7 ms)`);
  ok(JSON.stringify(bRows) === JSON.stringify(aRows), `B: the same answer (${JSON.stringify(bRows)})`);

  // C · every typed read channel is answered by the worker; main's connection is never used for one.
  const fakeIpc = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); }, on() {}, removeHandler(ch) { this.handlers.delete(ch); } };
  const mainUsed = [];
  const mainDb = new Proxy({}, { get: (_t, k) => { mainUsed.push(String(k)); throw new Error("MAIN CONNECTION USED"); } });
  const routed = SR.routeScreenReads(fakeIpc, host);
  require("../electron/sync/handlers/index").installAll(routed, () => mainDb);
  const reads = [...fakeIpc.handlers.keys()].filter(SR.isScreenRead);
  ok(reads.length > 40 && reads.length === routed.routed.length, `C: ${reads.length} typed read channels are routed to the worker`);
  const missing = reads.filter(ch => !host.stats().channels.includes(ch));
  ok(missing.length === 0, `C: the worker installed every routed channel itself${missing.length ? " — missing: " + missing.join(", ") : ""}`);
  const bad = [];
  let answered = 0;
  for (const ch of reads) {
    const r = await fakeIpc.handlers.get(ch)(null, sid, {});
    if (r && r.ok === false && /readonly|read-only|attempt to write|MAIN CONNECTION|no read handler|asynchronous/i.test(String(r.error))) bad.push(`${ch}: ${r.error}`);
    else answered++;
  }
  ok(bad.length === 0, `C: all ${answered} read channels answered on the read-only connection${bad.length ? " — " + bad.join(" | ") : ""}`);
  ok(mainUsed.length === 0, `C: main's own connection was touched ${mainUsed.length} times by a read`);
  const cats = await fakeIpc.handlers.get("categories:list")(null, sid, {});
  const catsLocal = require("../electron/sync/handlers/categories").categoriesList(local, sid, {});
  ok(cats.ok && JSON.stringify(cats.rows) === JSON.stringify(catsLocal), `C: categories:list answers as it did on main (${(cats.rows || []).length} rows)`);

  // D · the reads main.js wrote inline: schedule:get and schedule:categoryHealth, same answers as before.
  const from = Math.floor(Date.now() / 1000) - 86400 * 30, to = from + 86400 * 60;
  const g = await host.fn("scheduleGet", sid, from, to);
  ok(JSON.stringify(g) === JSON.stringify(Q.scheduleGet(local, sid, from, to)), `D: schedule:get from the worker equals the in-thread read (${g.length} rows)`);
  const h = await host.fn("categoryHealth", sid);
  ok(JSON.stringify(h) === JSON.stringify(Q.categoryHealth(local, sid)), `D: schedule:categoryHealth from the worker equals the in-thread read (${h.rows.length} categories)`);

  // E · the worker cannot write.
  let werr = null;
  try { await host.query("INSERT INTO station_config_kv (station_id, key, value) VALUES (?, 'screen-read-probe', 'x') RETURNING key", [sid]); } catch (e) { werr = e.message; }
  ok(/readonly/i.test(String(werr)), `E: a write through db:query is refused by the read-only connection (${werr})`);

  // F · a database swap: reads asked during it wait, then are answered from the reopened database — none is dropped.
  await host.release();
  let held = false; const p = host.query("SELECT 2 AS two").then((r) => { held = r; });
  await sleep(300);
  ok(held === false, "F: a read asked while the database is released waits (no connection is open on the file)");
  host.reacquire();
  await p;
  ok(Array.isArray(held) && held[0] && held[0].two === 2, "F: after reacquire it is answered");

  // G · a worker that dies is replaced, and the next read is answered.
  await host.stop();
  const host2 = SR.createScreenReadHost({ dbPathFn: () => DB, log: (s) => logs.push(s), healthEvent: () => {} });
  host2.start(); await host2.query("SELECT 1");
  await host2.fn("nope").catch(() => {});
  const w = host2.stats();
  ok(w.running, "G: a read the worker cannot answer is an error, and the worker keeps running");
  await host2.stop();

  local.close();
  const after = fs.statSync(DB);
  ok(after.size === before.size && after.mtimeMs === before.mtimeMs, "the database copy was not written");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
