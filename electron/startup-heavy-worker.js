// electron/startup-heavy-worker.js — runs electron/startup-heavy.js on its own thread and its own connection, after the
// window is on screen. Messages: { type: "step", name, ms, waitedMs, skipped, error } per step, { type: "log", msg }, then
// { type: "done", report }.
//
// THE SILENCE GATE (same as electron/sync/purge-excluded-queue-worker.js): main writes 1 into workerData.onAirFlag while
// any deck plays on air, 0 when none does. A step that must BUILD an index waits until the flag has been 0 for QUIET_MS
// without a break — a build holds SQLite's write lock throughout, and the engine's writes behind it would fail.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const Database = require("better-sqlite3");
const { runHeavySteps } = require("./startup-heavy");

const flag = workerData.onAirFlag ? new Int32Array(workerData.onAirFlag) : new Int32Array(new SharedArrayBuffer(4));
const QUIET_MS = Number(workerData.quietMs) >= 0 ? Number(workerData.quietMs) : 15000;
const say = (msg) => parentPort.postMessage({ type: "log", msg });
function waitSilence() {
  const t0 = Date.now();
  let said = false;
  for (;;) {
    if (Atomics.load(flag, 0) === 1) {
      if (!said) { said = true; say("[startup] an index must be built — waiting until nothing has been on air for 15 s (a build would hold up the engine's writes)"); }
      Atomics.wait(flag, 0, 1, 1000);
      continue;
    }
    const quietUntil = Date.now() + QUIET_MS;
    let broke = false;
    while (Date.now() < quietUntil) { if (Atomics.load(flag, 0) === 1) { broke = true; break; } Atomics.wait(flag, 0, 0, 250); }
    if (broke) continue;
    return Date.now() - t0;
  }
}

let db = null;
try {
  db = new Database(workerData.dbPath, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 15000");      // it is the one that waits, not the app
  const report = runHeavySteps(db, { waitSilence, onStep: (r) => parentPort.postMessage({ type: "step", ...r }) });
  parentPort.postMessage({ type: "done", report });
} catch (e) {
  parentPort.postMessage({ type: "error", error: (e && e.message) || String(e) });
} finally {
  try { if (db) db.close(); } catch { /* closing */ }
}
