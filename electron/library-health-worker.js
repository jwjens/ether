// electron/library-health-worker.js — the library-health sweep, OFF the main process (2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md. RECEIPT: the sweep (computeAll, every 2 min) ran synchronously on
// the main process and measured 4.0–9.2 s per run on OVEVENTS (its own sweepMs in health-events.jsonl), the same
// minutes /health showed eventLoopLagPeakMs 8,005–9,313 ms. A main process blocked that long is "Not Responding" in the
// title bar and swallows the first click. The sweep and the on-demand queries (eligibility, queue
// lint, rotation goals) now run HERE, on their own thread with their own read-only database connection. Main keeps a
// thin proxy (electron/library-health-host.js) and is never blocked by them.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const LH = require("./library-health");

let Database = null;
try { Database = require("better-sqlite3"); } catch (e) { parentPort.postMessage({ type: "fatal", error: `better-sqlite3: ${e && e.message}` }); }

const ctx = { dbPath: workerData.dbPath, musicDir: workerData.musicDir || null, restoreInFlight: false,
              licenseKey: null, backendUrl: workerData.backendUrl || null };
let db = null, dbFor = null, released = false;
function getDb() {
  // Released for a database swap (electron/db-holders.js): no reopen until main says the new file is in place.
  if (released) throw new Error("RESTORE_IN_PROGRESS: the station database is being replaced");
  if (!db || dbFor !== ctx.dbPath) {
    try { if (db) db.close(); } catch {}
    db = new Database(ctx.dbPath, { readonly: true, fileMustExist: true });
    try { db.pragma("busy_timeout = 5000"); } catch {}
    dbFor = ctx.dbPath;
  }
  return db;
}

const lh = LH.createLibraryHealth({
  getDb,
  backendUrl: ctx.backendUrl,
  licenseKeyFn: () => ctx.licenseKey,
  broadcast: (channel, data) => parentPort.postMessage({ type: "broadcast", channel, data }),
  musicDirFn: () => ctx.musicDir,
  restoreInFlightFn: () => !!ctx.restoreInFlight,
  userDataDir: workerData.userDataDir,
});

const CALLS = {
  computeAll: () => lh.computeAll(),
  snapshot: () => lh.snapshot(),
  eligibilityRows: (sid) => lh.eligibilityRows(sid),
  lintRows: (sid) => lh.lintRows(sid),
  goalCheck: (sid) => lh.goalCheck(getDb(), sid),
  // The health frame's database part (health:frames, every 60 s / 5 s while the web monitor watches): each station's
  // runway and its 7-day trend. Was synchronous on main: 0.46–1.4 s per call on OVEVENTS (docs/perf-pass-round2-2026-10-12.md).
  // schedule:playhead-view (UpNext's 30 s shadow-compare) — 186–207 ms of main per call on OVEVENTS.
  playheadView: (sid, n) => require("./runway").playheadView(getDb(), sid, n),
  runwayFrames: (sids) => {
    const R = require("./runway"), d = getDb(), out = {};
    for (const sid of Array.isArray(sids) ? sids : []) out[sid] = { runway: R.computeRunway(d, sid) || null, series: R.runwaySeries(d, sid) };
    return out;
  },
  // A heavy READ for main's callers (db:query-offmain) — the 60 s library mirror's full-library join. Read-only connection,
  // and SELECT only, so it can never write.
  query: (sql, params) => {
    if (!/^\s*(select|with)\b/i.test(String(sql || ""))) throw new Error("db:query-offmain runs SELECT only");
    return getDb().prepare(String(sql)).all(...(Array.isArray(params) ? params : []));
  },
};
const NOTES = {
  noteSkip: (...a) => lh.noteSkip(...a),
  noteGenerate: (...a) => lh.noteGenerate(...a),
};

parentPort.on("message", async (m) => {
  if (!m || typeof m !== "object") return;
  if (m.type === "ctx") { Object.assign(ctx, m.ctx || {}); return; }
  if (m.type === "release") {
    released = true;
    try { if (db) db.close(); } catch {}
    db = null; dbFor = null;
    parentPort.postMessage({ type: "released", id: m.id });
    return;
  }
  if (m.type === "reacquire") { released = false; return; }
  if (m.type === "note") { try { NOTES[m.method] && NOTES[m.method](...(m.args || [])); } catch { /* best-effort, as in main */ } return; }
  if (m.type === "call") {
    const t0 = Date.now();
    try {
      const fn = CALLS[m.method];
      if (!fn) throw new Error(`unknown call ${m.method}`);
      const value = await fn(...(m.args || []));
      parentPort.postMessage({ type: "result", id: m.id, ok: true, value, ms: Date.now() - t0 });
    } catch (e) { parentPort.postMessage({ type: "result", id: m.id, ok: false, error: String(e && e.message || e), ms: Date.now() - t0 }); }
    return;
  }
  // The same cadence as before (electron/library-health.js start(): sweep every 2 min), on this
  // thread. Each sweep's snapshot reaches main through `broadcast("library-health", snap)` above.
  if (m.type === "start") { try { lh.start(); } catch (e) { parentPort.postMessage({ type: "log", msg: `[library-health worker] start ✗ ${e && e.message}` }); } }
});
parentPort.postMessage({ type: "ready" });
