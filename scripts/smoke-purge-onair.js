// scripts/smoke-purge-onair.js — the one-time sync-queue cleanup never runs while anything is on air (2026-10-12).
//
// docs/sync-queue-excluded-leak-2026-10-12.md. Jeff: "the one-time cleanup must not run while anything is playing on air.
// Have it wait until no deck is playing and pause if playback starts, then resume. Machines that update during a show
// must never see a slowdown from it. Test that."
// Runs the REAL worker against a COPY of a real database. This thread plays main: it owns the on-air flag (as main.js
// anyDeckPlaying does) and writes to the database every 50 ms, timing each write.
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-purge-onair.js <database COPY>
// The quiet spell is 2 s here (15 s in the app) so the run stays short.
"use strict";
const path = require("path"), fs = require("fs"), os = require("os");
const { Worker } = require("worker_threads");
const DB = process.argv[2];
if (!DB || !fs.existsSync(DB)) { console.error("usage: … smoke-purge-onair.js <database COPY>"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const Database = require("better-sqlite3");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "purge-onair-"));
const QUIET = 2000;

(async () => {
  const app = new Database(DB);
  app.pragma("busy_timeout = 15000");
  app.prepare("DELETE FROM system_state WHERE key = 'sync_excluded_queue_purged_v1'").run();
  const exCount = () => app.prepare("SELECT COUNT(*) n FROM mutations WHERE sync_status='pending' AND table_name IN ('generated_schedule','install_secrets_kv','monitor_routing')").get().n;
  const start = exCount();
  console.log(`  ..   queued excluded rows: ${start}`);

  const onAirFlag = new SharedArrayBuffer(4), flag = new Int32Array(onAirFlag);
  const setAir = (v) => { Atomics.store(flag, 0, v); Atomics.notify(flag, 0); };
  const t0 = Date.now(), at = () => `+${((Date.now() - t0) / 1000).toFixed(1)} s`;

  // "Main": a write every 50 ms, timed, tagged with whether a deck was playing at that moment.
  const hb = app.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('smoke_heartbeat', ?, 'now') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const onAirWrites = [], offAirWrites = [], slowAir = [];
  let flipAt = 0;
  let running = true;
  const beat = setInterval(() => { if (!running) return; const air = Atomics.load(flag, 0) === 1; const t = Date.now(); hb.run(String(t)); const ms = Date.now() - t; (air ? onAirWrites : offAirWrites).push(ms); if (air && ms > 30) slowAir.push(`${ms} ms at ${t - flipAt} ms after the deck started`); }, 50);

  const logs = [];
  const backupPath = path.join(TMP, "sync-queue-purge-onair.db");
  setAir(1);                                                     // 1 · a show is on when the cleanup is due
  const w = new Worker(path.join(__dirname, "..", "electron", "sync", "purge-excluded-queue-worker.js"),
    { workerData: { dbPath: DB, backupPath, onAirFlag, quietMs: QUIET } });
  let result = null;
  w.on("message", (m) => { if (m.type === "log") { logs.push(`${at()} ${m.msg}`); console.log(`  ..   ${at()} ${m.msg.slice(0, 150)}`); } else result = m; });
  const exited = new Promise(r => w.on("exit", r));

  await sleep(5000);
  ok(!logs.some(l => /before:/.test(l)) && exCount() === start && !fs.existsSync(backupPath), "1 · on air at the start: the cleanup did not touch the database (no counts, no backup, nothing removed) for 5 s");

  setAir(0); await sleep(1000); setAir(1);                       // 2 · a 1 s gap between two songs
  await sleep(1500);
  ok(!logs.some(l => /resumed/.test(l)) && exCount() === start, "2 · a 1 s gap between songs (shorter than the quiet spell) did not let it start");

  setAir(0);                                                     // 3 · off air → it starts after the quiet spell
  const offAt = Date.now();
  while (!logs.some(l => /resumed/.test(l)) && Date.now() - offAt < 10000) await sleep(100);
  ok(Date.now() - offAt >= QUIET - 100, `3 · it started only after ${QUIET / 1000} s of silence (${((Date.now() - offAt) / 1000).toFixed(1)} s)`);

  // 4 · wait until deleting is under way, then a deck starts for 8 s.
  const dl = Date.now();
  while (exCount() === start && Date.now() - dl < 120000) await sleep(200);
  const midBefore = exCount();
  flipAt = Date.now();
  setAir(1);
  const airFrom = onAirWrites.length;
  await sleep(500);                                              // one batch may have been in flight at the flip
  const atPause = exCount();
  await sleep(8000);
  const afterPause = exCount();
  ok(midBefore < start, `4 · deleting was under way (${start - midBefore} removed) when a deck started`);
  ok(afterPause === atPause, `4 · while the deck played, nothing more was removed (${atPause} → ${afterPause} over 8 s)`);
  const airW = onAirWrites.slice(airFrom), worstAir = Math.max(0, ...airW);
  console.log(`  ..   slow on-air writes: ${slowAir.join("; ") || "none"}`);
  // The flag is read BETWEEN steps, so the one step already running when the deck starts finishes (a batch is sized to
  // ~30 ms). Everything after that instant must run at normal speed; the instant itself is reported, bounded.
  const afterFlip = airW.slice(1), worstAfter = Math.max(0, ...afterFlip);
  ok(worstAfter <= 30, `4 · after the instant the deck started, main's writes ran at normal speed: worst ${worstAfter} ms over ${afterFlip.length} writes`);
  ok((airW[0] || 0) <= 250, `4 · the one write AT that instant (the step already running) took ${airW[0] || 0} ms`);
  ok(logs.some(l => /paused/.test(l)), "4 · the pause was logged");

  if (process.env.ONAIR_STOP_AFTER_4) { setAir(1); await sleep(200); process.exit(fail ? 1 : 0); }
  setAir(0);                                                     // 5 · off air → it resumes and finishes
  await exited;
  running = false; clearInterval(beat);
  const r = result && result.report;
  ok(result && result.type === "done" && r && r.removed === start && r.backupRows === start && r.after.excludedPendingTotal === 0,
     `5 · resumed and finished: removed ${r && r.removed}, backup ${r && r.backupRows}, left ${r && r.after.excludedPendingTotal} — waited ${r && Math.round(r.pausedMs / 1000)} s across ${r && r.pauses} on-air pause(s)`);
  ok(logs.filter(l => /resumed/.test(l)).length >= 2, "5 · resumed twice (after the start-of-show wait and after the mid-run pause)");
  console.log(`  ..   main's writes off air (cleanup working): worst ${Math.max(0, ...offAirWrites)} ms over ${offAirWrites.length}; on air: worst ${Math.max(0, ...onAirWrites)} ms over ${onAirWrites.length}`);
  app.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
