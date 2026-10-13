// electron/sync/purge-excluded-queue-worker.js — runs purge-excluded-queue.js on its own thread and connection (2026-10-12).
//
// docs/sync-queue-excluded-leak-2026-10-12.md. Copying ~217k rows to the backup and deleting them takes minutes; on the
// main process that would be the very kind of stall the performance pass removed. Here only this thread waits. The
// connection waits up to 15 s for a busy database (the app and the audio engine write between batches) instead of failing.
// Records completion in system_state so it runs once; a run cut short (the app closed) resumes on the next launch.
//
// THE ON-AIR GATE. Main writes 1 into the shared flag (workerData.onAirFlag) while any deck is playing on air, 0 when
// none is (main.js anyDeckPlaying). Before every chunk of work: wait while it is 1, and once it drops, wait for QUIET_MS of
// continuous 0 — so a gap between two songs, or a jock between two carts, never lets a batch in. Each pause and resume
// is reported.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const MARK = "sync_excluded_queue_purged_v1";
(async () => {
  let db = null;
  try {
    const Database = require("better-sqlite3");
    const flag = workerData.onAirFlag ? new Int32Array(workerData.onAirFlag) : new Int32Array(new SharedArrayBuffer(4));
    const QUIET_MS = Number(workerData.quietMs) >= 0 ? Number(workerData.quietMs) : 15000;
    const say = (msg) => parentPort.postMessage({ type: "log", msg });
    const waitOffAir = () => {
      const t0 = Date.now();
      let paused = false;
      for (;;) {
        if (Atomics.load(flag, 0) === 1) {
          if (!paused) { paused = true; say("[sync-queue] paused — something is playing on air; waiting for silence"); }
          Atomics.wait(flag, 0, 1, 1000);
          continue;
        }
        if (!paused) return 0;                                     // was not on air: no wait at all
        const quietUntil = Date.now() + QUIET_MS;                  // off air now: hold until quiet for QUIET_MS
        let interrupted = false;
        while (Date.now() < quietUntil) { if (Atomics.load(flag, 0) === 1) { interrupted = true; break; } Atomics.wait(flag, 0, 0, 250); }
        if (interrupted) continue;
        say(`[sync-queue] resumed — nothing on air for ${Math.round(QUIET_MS / 1000)} s (waited ${Math.round((Date.now() - t0) / 1000)} s)`);
        return Date.now() - t0;
      }
    };
    // Nothing touches the database before the first quiet spell either — not even the counts.
    if (Atomics.load(flag, 0) === 1) waitOffAir();
    db = new Database(workerData.dbPath, { fileMustExist: true });
    db.pragma("busy_timeout = 15000");
    const done = db.prepare("SELECT value FROM system_state WHERE key = ?").get(MARK);
    if (done) { parentPort.postMessage({ type: "done", already: true, report: JSON.parse(done.value || "{}") }); return; }
    const { purgeExcludedQueue } = require("./purge-excluded-queue");
    const report = purgeExcludedQueue(db, { backupPath: workerData.backupPath, waitOffAir, onAirNow: () => Atomics.load(flag, 0) === 1, log: say });
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(MARK, JSON.stringify(report), new Date().toISOString());
    parentPort.postMessage({ type: "done", report });
  } catch (e) {
    parentPort.postMessage({ type: "error", error: String((e && e.message) || e) });
  } finally { try { if (db) db.close(); } catch {} }
})();
