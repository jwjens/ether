// electron/sync/purge-excluded-queue.js — ONE-TIME: take the excluded tables' rows out of the sync queue (2026-10-12).
//
// docs/sync-queue-excluded-leak-2026-10-12.md. The mutation writer journalled generated_schedule (syncExcluded since
// ruling A) as 'pending', and the push never sent it, so the rows stayed forever: 217,002 on OVEVENTS. The writer no
// longer queues an excluded table (mutation-writer.js logMutation); this removes what it queued before that fix.
//   1. COUNT  — pending rows per excluded table, all pending, all rows.
//   2. BACKUP — every row about to be removed is copied into its own SQLite file (table `mutations_removed`, the same
//               columns), and the copy is COUNTED. A short copy means nothing is deleted.
//   3. DELETE — in batches (each its own short transaction), so the app and the audio engine are never locked out of
//               the database for more than a batch.
//   4. COUNT  — again; the report carries both.
// Only rows that are BOTH pending AND of an excluded table are touched. Nothing else in the queue, and no table data.
"use strict";
const { REGISTRY, isSyncExcluded } = require("./synced-tables");

function excludedTables() { return Object.keys(REGISTRY).filter(isSyncExcluded); }

function counts(db, EX) {
  const ph = EX.map(() => "?").join(", ");
  const per = {};
  for (const t of EX) per[t] = 0;
  for (const r of db.prepare(`SELECT table_name, COUNT(*) n FROM mutations WHERE sync_status = 'pending' AND table_name IN (${ph}) GROUP BY table_name`).all(...EX)) per[r.table_name] = r.n;
  return {
    excludedPending: per,
    excludedPendingTotal: Object.values(per).reduce((a, b) => a + b, 0),
    allPending: db.prepare("SELECT COUNT(*) n FROM mutations WHERE sync_status = 'pending'").get().n,
    allRows: db.prepare("SELECT COUNT(*) n FROM mutations").get().n,
  };
}

/**
 * @param db          a READ-WRITE better-sqlite3 connection to the live database
 * @param backupPath  the file the removed rows are copied to (created; must not exist)
 * @param batch       rows deleted per transaction
 * @returns report { before, after, removed, backupPath, backupRows, ms, skipped? }
 */
function purgeExcludedQueue(db, { backupPath, batch = 50, targetMs = 30, pauseMs = 100, log = () => {} } = {}) {
  const t0 = Date.now();
  const EX = excludedTables();
  const ph = EX.map(() => "?").join(", ");
  const WHERE = `sync_status = 'pending' AND table_name IN (${ph})`;
  const before = counts(db, EX);
  log(`[sync-queue] before: ${JSON.stringify(before)}`);
  if (before.excludedPendingTotal === 0) return { skipped: "nothing of an excluded table is queued", before, after: before, removed: 0, backupPath: null, backupRows: 0, ms: Date.now() - t0 };
  if (!backupPath) throw new Error("purgeExcludedQueue: a backupPath is required — nothing is removed without a backup");

  // 2 · BACKUP, verified. The file is created here with its own handle: an ATTACH inherits the main connection's open
  // flags, and the live database is opened without CREATE (fileMustExist), so ATTACH alone cannot make a new file.
  if (require("fs").existsSync(backupPath)) throw new Error(`purgeExcludedQueue: ${backupPath} already exists — nothing removed`);
  new (db.constructor)(backupPath).close();
  db.prepare("ATTACH DATABASE ? AS qbk").run(backupPath);
  let backupRows = 0;
  try {
    db.exec("CREATE TABLE qbk.mutations_removed AS SELECT * FROM main.mutations WHERE 0");
    db.prepare(`INSERT INTO qbk.mutations_removed SELECT * FROM main.mutations WHERE ${WHERE}`).run(...EX);
    backupRows = db.prepare("SELECT COUNT(*) n FROM qbk.mutations_removed").get().n;
    db.exec(`CREATE TABLE qbk.purge_report (key TEXT PRIMARY KEY, value TEXT)`);
    db.prepare("INSERT INTO qbk.purge_report VALUES ('before', ?), ('at', ?)").run(JSON.stringify(before), new Date().toISOString());
  } finally { db.exec("DETACH DATABASE qbk"); }
  log(`[sync-queue] backup: ${backupRows} row(s) copied to ${backupPath}`);
  if (backupRows !== before.excludedPendingTotal) {
    throw new Error(`purgeExcludedQueue: the backup holds ${backupRows} row(s), expected ${before.excludedPendingTotal} — nothing removed`);
  }

  // 3 · DELETE in batches.
  const del = db.prepare(`DELETE FROM mutations WHERE rowid IN (SELECT rowid FROM mutations WHERE ${WHERE} LIMIT ?)`);
  // Small, TIME-sized batches with a pause between them: each batch holds the database's write lock, and the app and the audio
  // engine wait for it (a 2,000-row batch held a writer 732 ms on OVEVENTS' data — a main-process stall). Measured per
  // batch so the report says what the cleanup cost others.
  // No AUTOMATIC checkpoint on this connection: SQLite runs it inside a commit, so a batch that crossed the WAL limit
  // also copied the WAL back while the next writer waited (measured: a 250-row batch held a writer 306 ms). Instead a
  // PASSIVE checkpoint between batches — it never takes the write lock — so the WAL is folded back as we go and the app
  // does not inherit a huge checkpoint either.
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let removed = 0, batchMsPeak = 0, batches = 0, ckptMsPeak = 0;
  // And no fsync per batch on THIS connection (synchronous=NORMAL; in WAL the flush happens at the checkpoint instead):
  // every batch's own flush queued the app's commits behind it on the disk (the app's writes waited 100–195 ms with a
  // full flush per batch; 9 ms with no cleanup running). Safe here: the cleanup is resumable, and a batch lost to a
  // power cut is simply deleted again on the next launch.
  let autoCkpt = 1000, sync = 2;
  try { autoCkpt = db.pragma("wal_autocheckpoint", { simple: true }); db.pragma("wal_autocheckpoint = 0"); } catch { /* not WAL / not better-sqlite3 */ }
  try { sync = db.pragma("synchronous", { simple: true }); db.pragma("synchronous = NORMAL"); } catch { /* ignore */ }
  try {
    for (;;) {
      const tb = Date.now();
      const n = del.run(...EX, Math.round(batch)).changes;
      const took = Date.now() - tb;
      batchMsPeak = Math.max(batchMsPeak, took);
      // Sized by TIME, not rows: the first batches read cold index pages while holding the lock (a fixed 250-row batch
      // held a writer 300 ms at the start, then ran in a few ms once warm). Halve over the target, grow slowly under it.
      if (took > targetMs) batch = Math.max(5, batch / 2);
      else if (took < targetMs / 2) batch = Math.min(2000, batch * 1.25);
      removed += n; batches++;
      if (n === 0) break;
      if (batches % 1 === 0) { const tc = Date.now(); try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {} ckptMsPeak = Math.max(ckptMsPeak, Date.now() - tc); }
      if (pauseMs > 0) Atomics.wait(nap, 0, 0, pauseMs);   // this thread only (a worker); lets the others write
    }
    try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {}
  } finally {
    try { db.pragma(`wal_autocheckpoint = ${Number(autoCkpt) || 1000}`); } catch {}
    try { db.pragma(`synchronous = ${Number(sync) || 2}`); } catch {}
  }

  // 4 · COUNT again.
  const after = counts(db, EX);
  log(`[sync-queue] after: ${JSON.stringify(after)} — removed ${removed}`);
  return { before, after, removed, backupPath, backupRows, batches, batchMsPeak, ckptMsPeak, ms: Date.now() - t0 };
}

module.exports = { purgeExcludedQueue, excludedTables, counts };
