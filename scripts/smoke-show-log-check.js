// scripts/smoke-show-log-check.js — the "build the log before a show starts" check must never hold the main thread
// (Jeff, 2026-10-20: 4.6.60 froze main ~58 s every minute on ovowforestmusic — _missingShowSpans, one unindexed query
// per hour over 32 days of every 24/7 show).
//
//   npm run test:show-log-check            synthetic: 24/7 stations with 120,000+ log rows each
//   npm run test:show-log-check -- --db <copy of a real openair.db>     also time it on that copy (read-only)
//
// Drives the REAL worker (electron/show-log-worker.js) with main's message protocol, while main ticks every 10 ms and
// records how late each tick fires. FAILS if any tick is more than MAIN_BUDGET_MS late, or if the answer is wrong.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Worker } = require("worker_threads");
const Database = require("better-sqlite3");
const ROOT = path.join(__dirname, "..");
const S = require(path.join(ROOT, "electron", "show-log-spans.js"));

// Main counts as blocked when a 10 ms timer fires more than this late. Timers on an idle event loop fire within a few ms;
// 4.6.60's check held main for 58,000 ms.
const MAIN_BUDGET_MS = 50;
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? "  — " + extra : ""}`); } };

const HOUR = 3600;
const localHour = (ts) => { const d = new Date(ts * 1000); d.setMinutes(0, 0, 0); return Math.floor(d.getTime() / 1000); };
const MACHINE = "machine-test-a";

function buildDb(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT, deleted_at INTEGER);
    CREATE TABLE shows (id INTEGER PRIMARY KEY, station_id INTEGER, name TEXT, days TEXT, start_hour INTEGER, start_minute INTEGER,
                        end_hour INTEGER, end_minute INTEGER, clock_id INTEGER, is_active INTEGER DEFAULT 1, deleted_at INTEGER);
    CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at INTEGER);
    CREATE TABLE client_identity (client_id TEXT);
    CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, station_id INTEGER, scheduled_at INTEGER, log_hour_ts INTEGER, deleted_at INTEGER, title TEXT);
    CREATE INDEX idx_gensched_station_at ON generated_schedule(station_id, scheduled_at);
  `);
  db.prepare("INSERT INTO client_identity VALUES (?)").run(MACHINE);
  const rec = (id) => JSON.stringify({ machine_id: id, machine_name: id, designated_at: 1, last_checked: 1 });
  // 1, 3, 4: a single 24/7 show every day (as Open Format / Christmas / Summer Christmas on ovowforestmusic).
  // 2: an evening show 18:00–22:00 daily. 5: designated to ANOTHER machine — must cost nothing.
  for (const [id, name] of [[1, "Open Format"], [2, "Evenings"], [3, "Christmas"], [4, "Summer Christmas"], [5, "Elsewhere"]]) {
    db.prepare("INSERT INTO stations (id, name) VALUES (?, ?)").run(id, name);
    db.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (?, 'designated_generator', ?)").run(id, rec(id === 5 ? "machine-other" : MACHINE));
  }
  for (const id of [1, 3, 4, 5]) db.prepare("INSERT INTO shows (id, station_id, name, days, start_hour, start_minute, end_hour, end_minute, clock_id) VALUES (?, ?, ?, '0123456', 0, 0, 0, 0, 1)").run(id * 10, id, `24/7 ${id}`);
  db.prepare("INSERT INTO shows (id, station_id, name, days, start_hour, start_minute, end_hour, end_minute, clock_id) VALUES (20, 2, 'Evening Show', '0123456', 18, 0, 22, 0, 1)").run();
  // History: 120,000+ rows per 24/7 station, ending 6 hours from now (16 rows an hour), so the hours after that are empty.
  const now = Math.floor(Date.now() / 1000), endFilled = localHour(now) + 6 * HOUR;
  const ins = db.prepare("INSERT INTO generated_schedule (station_id, scheduled_at, log_hour_ts, title) VALUES (?, ?, ?, 'x')");
  db.transaction(() => {
    for (const sid of [1, 3, 4, 5]) {
      for (let h = endFilled - 7600 * HOUR; h < endFilled; h += HOUR) for (let k = 0; k < 16; k++) ins.run(sid, h + k * 225, h);
    }
    // Evenings: today's show has rows (if it is still to come or on), tomorrow's has none.
  })();
  const counts = db.prepare("SELECT station_id, COUNT(*) n FROM generated_schedule GROUP BY station_id").all();
  db.close();
  return { now, endFilled, counts };
}

function runWorkerCheck(dbPath, nowTs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(ROOT, "electron", "show-log-worker.js"), { workerData: { dbPath } });
    const lags = [];
    let last = Date.now();
    const tick = setInterval(() => { const t = Date.now(); lags.push(t - last - 10); last = t; }, 10);
    const t0 = Date.now();
    w.on("message", (m) => {
      if (!m || m.type !== "result") return;
      clearInterval(tick);
      const wall = Date.now() - t0;
      w.terminate().then(() => resolve({ m, wall, maxLag: Math.max(0, ...lags), ticks: lags.length }));
    });
    w.on("error", (e) => { clearInterval(tick); reject(e); });
    w.postMessage({ type: "check", id: 1, nowTs, dbPath });
  });
}

// The 4.6.60 check, for the comparison only (its exact query and walk).
function oldCheckMs(dbPath, stationId, nowTs) {
  const SW = require(path.join(ROOT, "audiod", "show-window.js"));
  const db = new Database(dbPath, { readonly: true });
  const shows = db.prepare("SELECT * FROM shows WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(stationId);
  const t0 = Date.now();
  const hasRows = db.prepare("SELECT 1 FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL AND COALESCE(log_hour_ts, scheduled_at) >= ? AND COALESCE(log_hour_ts, scheduled_at) < ? LIMIT 1");
  const runs = SW.pieceAt(shows, nowTs).show ? 2 : 1;
  let runsSeen = 0, lastShowId = null, t = nowTs, n = 0;
  for (let i = 0; i < 8 * 24 * 4; i++) {
    const p = SW.pieceAt(shows, t);
    if (p.show) { if (p.show.id !== lastShowId) { runsSeen++; if (runsSeen > runs) break; } hasRows.get(stationId, p.startTs, p.endTs); n++; lastShowId = p.show.id; } else lastShowId = null;
    t = p.endTs;
  }
  const ms = Date.now() - t0;
  db.close();
  return { ms, hours: n };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-showlog-"));
  const file = path.join(dir, "showlog.db");
  const { now, endFilled, counts } = buildDb(file);
  console.log(`synthetic database: ${counts.map(c => `station ${c.station_id} ${c.n} rows`).join(", ")}`);

  // 1 · the walk is the show on now + the next occurrence, not 32 days
  const shows247 = [{ id: 10, name: "24/7", days: "0123456", start_hour: 0, start_minute: 0, end_hour: 0, end_minute: 0, clock_id: 1 }];
  const pcs = S.windowPieces(shows247, now);
  const spanH = (pcs[pcs.length - 1].endTs - pcs[0].startTs) / HOUR;
  check(`a 24/7 show: the window is the rest of today + tomorrow (${pcs.length} pieces, ${spanH} h), not 768`, pcs.length <= 48 && spanH <= 48 && spanH > 24);
  const shows6 = [{ id: 11, name: "6 to 6", days: "0123456", start_hour: 6, start_minute: 0, end_hour: 6, end_minute: 0, clock_id: 1 }];
  const p6 = S.windowPieces(shows6, now);
  check(`a 24 h show starting 06:00: also one occurrence per day (${p6.length} pieces)`, p6.length <= 48 && p6.length > 24);
  const evening = [{ id: 20, name: "Evening", days: "0123456", start_hour: 18, start_minute: 0, end_hour: 22, end_minute: 0, clock_id: 1 }];
  const pe = S.windowPieces(evening, now);
  const onNowE = new Date(now * 1000).getHours() >= 18 && new Date(now * 1000).getHours() < 22;
  check(`an evening show: ${onNowE ? "the rest of tonight's + tomorrow's" : "only the next one"} (${pe.length} pieces)`, onNowE ? pe.length <= 8 : pe.length === 4);

  // 2 · the real worker, main ticking — main must never be held
  const r = await runWorkerCheck(file, now);
  check(`the check answered (${r.m.ok ? "ok" : r.m.error})`, r.m.ok);
  check(`main was never held: worst timer lateness ${r.maxLag} ms over ${r.ticks} ticks (budget ${MAIN_BUDGET_MS} ms); the worker took ${r.m.ms} ms`, r.maxLag <= MAIN_BUDGET_MS);
  const by = Object.fromEntries((r.m.stations || []).map(s => [s.stationId, s]));
  const firstEmpty = endFilled;
  const s1 = by[1] || { spans: [] };
  check(`station 1 (24/7, rows until +6 h): one missing span, from the first empty hour to the end of tomorrow`,
    s1.spans.length === 1 && s1.spans[0].fromLk === firstEmpty, JSON.stringify(s1.spans.map(x => [new Date(x.fromLk * 1000).toISOString(), new Date(x.toTs * 1000).toISOString()])));
  check(`station 5 (designated to another machine): skipped before any work — "${by[5] && by[5].skipped}"`, !!(by[5] && by[5].skipped && by[5].spans.length === 0));

  // 3 · gate first: a refused station never touches generated_schedule
  const db = new Database(file, { readonly: true });
  let logQueries = 0;
  const spy = { prepare: (sql) => { if (/generated_schedule/.test(sql)) logQueries++; return db.prepare(sql); } };
  S.stationsToBuild(spy, now, () => ({ allow: false, reason: "not this machine" }));
  check(`gate first: with every station refused, 0 log queries (got ${logQueries})`, logQueries === 0);
  logQueries = 0;
  S.stationsToBuild(spy, now, () => ({ allow: true }));
  check(`one log query per station with shows, no per-hour queries (${logQueries} for the 5 stations with shows)`, logQueries === 5);
  db.close();

  // 4 · for the record: the 4.6.60 check on the same data
  const old = oldCheckMs(file, 1, now);
  console.log(`INFO  4.6.60's check, station 1 alone, on main: ${old.ms} ms over ${old.hours} hourly queries (this database)`);

  // 5 · optional: a copy of a real database
  const i = process.argv.indexOf("--db");
  if (i > 0 && process.argv[i + 1]) {
    const real = process.argv[i + 1];
    const rr = await runWorkerCheck(real, now);
    check(`real copy ${path.basename(real)}: answered (${rr.m.ok ? "ok" : rr.m.error}), worker ${rr.m.ms} ms`, rr.m.ok);
    check(`real copy: main never held — worst timer lateness ${rr.maxLag} ms (budget ${MAIN_BUDGET_MS} ms)`, rr.maxLag <= MAIN_BUDGET_MS);
    for (const s of rr.m.stations || []) console.log(`INFO  real copy: station ${s.stationId} ${s.name}: ${s.skipped ? "skipped — " + s.skipped : s.spans.length + " missing span(s)"}`);
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
