// electron/sync/restore-sync.js — WHAT A RESTORE DOES TO SYNC (Jeff, 2026-10-20).
//
//   "Restoring a backup while sync is off discards every unsent change made before the restore, so turning sync back on
//    never sends the mistake out. After the restore, the computer catches up from the other machines."
//   "After a restore, give me an admin action 'Send this restore to every machine' (with a confirm) that makes the
//    restored data replace the mistake on every computer. Without that action, use (a)." — and "only this computer's
//    changes since the backup".
//
// discardUnsent  — every change in the restored file's outgoing queue is retired (sync_status 'conflicted',
//                  conflict_resolution 'discarded-by-restore'): it is never sent. Counted.
// captureRestorePoint — read from the database being REPLACED (the .pre-restore copy, before it is deleted): this
//                  computer's own changes that were already SENT and are not in the restored file — i.e. made after
//                  the backup. Saved beside the database (restore-point.json). Local, works offline.
// sendRestore    — for every row those changes touched, journal the RESTORED version as a new change (it is newest, so
//                  it wins on every computer, and the old mistake loses when it comes back — merge-engine last-writer
//                  rule), or a removal where the row did not exist in the backup. Plays (play_log) are history, not a
//                  mistake: never touched. Nothing is written to this computer's rows — they already ARE the backup.
"use strict";
const fs = require("fs");
const path = require("path");
const { REGISTRY, isSyncExcluded } = require("./synced-tables");
const { logMutation, serializePayload, getClientId } = require("./mutation-writer");

const POINT_FILE = "restore-point.json";
const NEVER_SENT_BACK = new Set(["play_log"]);   // what aired is the record — a restore never retracts a play
const physical = (t) => (REGISTRY[t] && REGISTRY[t].tableName) || t;

function discardUnsent(db) {
  const r = db.prepare(
    "UPDATE mutations SET sync_status = 'conflicted', conflict_resolution = 'discarded-by-restore' WHERE sync_status IN ('pending', 'syncing')"
  ).run();
  return r.changes;
}

/**
 * @param db           the RESTORED database (live handle)
 * @param preRestore   path of the database it replaced
 * @returns {{ rows: number, changes: number, file: string|null }}
 */
function captureRestorePoint(db, preRestore, { dir, backupLabel } = {}) {
  if (!preRestore || !fs.existsSync(preRestore)) return { rows: 0, changes: 0, file: null };
  db.prepare("ATTACH DATABASE ? AS pre").run(preRestore);
  let list = [], me = null;
  try {
    // THIS computer is who the REPLACED database says it is — a backup restored from another computer carries that
    // computer's identity until main re-stamps ours after the swap.
    try { me = db.prepare("SELECT client_id FROM pre.client_identity LIMIT 1").get()?.client_id || null; } catch { me = null; }
    if (!me) me = getClientId(db);
    if (!me) return { rows: 0, changes: 0, file: null };
    list = db.prepare(
      `SELECT m.id, m.table_name, m.row_id, m.hlc, m.station_id, m.op, m.payload_before, m.payload_after, m.created_at
         FROM pre.mutations m
        WHERE m.client_id = ? AND m.sync_status = 'synced'
          AND NOT EXISTS (SELECT 1 FROM main.mutations x WHERE x.id = m.id)
        ORDER BY m.hlc`).all(me);
  } finally { try { db.prepare("DETACH DATABASE pre").run(); } catch { /* best effort */ } }
  const byRow = new Map();
  for (const m of list) {
    if (!REGISTRY[m.table_name] || isSyncExcluded(m.table_name) || NEVER_SENT_BACK.has(m.table_name)) continue;
    const k = `${m.table_name}|${m.row_id}`;
    const last = m.payload_after || m.payload_before;
    byRow.set(k, { table: m.table_name, row_id: m.row_id, station_id: m.station_id, last: last ? JSON.parse(last) : null, changes: ((byRow.get(k) || {}).changes || 0) + 1 });
  }
  const point = { v: 1, at: new Date().toISOString(), backup: backupLabel || null, clientId: me, changes: list.length, rows: [...byRow.values()], sent: null };
  let file = null;
  if (dir) { file = path.join(dir, POINT_FILE); fs.writeFileSync(file, JSON.stringify(point)); }
  return { rows: point.rows.length, changes: list.length, file };
}

function readRestorePoint(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, POINT_FILE), "utf8")); } catch { return null; }
}

/** What "Send this restore" would do — for the confirm. */
function previewRestore(db, point) {
  let putBack = 0, remove = 0;
  for (const r of (point && point.rows) || []) {
    let here = null;
    try { here = db.prepare(`SELECT 1 FROM ${physical(r.table)} WHERE uuid = ?`).get(r.row_id); } catch { here = null; }
    if (here) putBack++; else remove++;
  }
  return { putBack, remove, rows: putBack + remove };
}

/** Journal the restored version of every row the mistake touched. → { putBack, removed, skipped } */
function sendRestore(db, point, dir) {
  const out = { putBack: 0, removed: 0, skipped: 0 };
  if (!point || point.sent) return out;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of point.rows || []) {
      const entry = REGISTRY[r.table];
      if (!entry || isSyncExcluded(r.table) || NEVER_SENT_BACK.has(r.table)) { out.skipped++; continue; }
      let row = null;
      try { row = db.prepare(`SELECT * FROM ${physical(r.table)} WHERE uuid = ?`).get(r.row_id); } catch { row = null; }
      if (row) {
        logMutation(db, { table_name: r.table, row_id: r.row_id, op: "update", payload_before: r.last,
                          payload_after: serializePayload(row, r.table), station_id: row.station_id ?? r.station_id ?? null });
        out.putBack++;
      } else if (entry.columns && entry.columns.deleted_at && r.last) {
        // The row did not exist in the backup: removed everywhere (soft delete, which travels like any change).
        logMutation(db, { table_name: r.table, row_id: r.row_id, op: "update", payload_before: r.last,
                          payload_after: { ...r.last, deleted_at: now, updated_at: now }, station_id: r.station_id ?? null });
        out.removed++;
      } else if (r.last) {
        logMutation(db, { table_name: r.table, row_id: r.row_id, op: "delete", payload_before: r.last, payload_after: null, station_id: r.station_id ?? null });
        out.removed++;
      } else out.skipped++;
    }
  })();
  point.sent = { at: now, ...out };
  if (dir) { try { fs.writeFileSync(path.join(dir, POINT_FILE), JSON.stringify(point)); } catch { /* the journal is the record */ } }
  return out;
}

module.exports = { discardUnsent, captureRestorePoint, readRestorePoint, previewRestore, sendRestore, POINT_FILE, NEVER_SENT_BACK };
