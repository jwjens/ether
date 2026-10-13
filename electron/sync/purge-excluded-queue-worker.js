// electron/sync/purge-excluded-queue-worker.js — runs purge-excluded-queue.js on its own thread and connection (2026-10-12).
//
// docs/sync-queue-excluded-leak-2026-10-12.md. Copying ~217k rows to the backup and deleting them takes seconds; on the
// main process that would be the very kind of stall this round removed. Here only this thread waits. The connection
// waits up to 15 s for a busy database (the app and the audio engine write between batches) instead of failing.
// Records completion in system_state so it runs once; a run cut short (the app closed) resumes on the next launch.
"use strict";
const { parentPort, workerData } = require("worker_threads");
const MARK = "sync_excluded_queue_purged_v1";
(async () => {
  let db = null;
  try {
    const Database = require("better-sqlite3");
    db = new Database(workerData.dbPath, { fileMustExist: true });
    db.pragma("busy_timeout = 15000");
    const done = db.prepare("SELECT value FROM system_state WHERE key = ?").get(MARK);
    if (done) { parentPort.postMessage({ type: "done", already: true, report: JSON.parse(done.value || "{}") }); return; }
    const { purgeExcludedQueue } = require("./purge-excluded-queue");
    const report = purgeExcludedQueue(db, { backupPath: workerData.backupPath, log: (m) => parentPort.postMessage({ type: "log", msg: m }) });
    db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(MARK, JSON.stringify(report), new Date().toISOString());
    parentPort.postMessage({ type: "done", report });
  } catch (e) {
    parentPort.postMessage({ type: "error", error: String((e && e.message) || e) });
  } finally { try { if (db) db.close(); } catch {} }
})();
