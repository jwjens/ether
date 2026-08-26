'use strict';

// electron/sync/handlers/announcement_schedule.js — the announcement SCHEDULE (v47, pass 1).
//
// docs/announcement-schedule-frame-design-2026-08-26.md.
//
// One row = one (announcement, time) entry, attached either to a set of WEEKDAYS ('56' = Fri+Sat) or
// to a single DATE. `announcements` is now the ASSET (title, file, is_active); this is WHEN it plays,
// and there can be many per asset.
//
// The panel edits these rows DIRECTLY. There is no bridge to the old per-announcement trigger_time /
// days columns and no mirror keeping them in step — the old scheduling UI was deleted rather than
// wrapped, so this table is the single source of truth for when an announcement plays.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const { REGISTRY } = require('../synced-tables');

const TABLE = 'announcement_schedule';

function validateScope() {
  const entry = REGISTRY[TABLE];
  if (!entry) throw new Error(`[announcement_schedule] unknown table in registry: "${TABLE}"`);
  if (entry.scope !== 'station') {
    throw new Error(`[announcement_schedule] expected station-scoped table, registry has "${entry.scope}"`);
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

function scheduleList(db, stationId, opts) {
  const o = opts || {};
  let sql = `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL`;
  const params = [];
  if (stationId != null) { sql += ' AND station_id = ?'; params.push(stationId); }
  if (o.scope)            { sql += ' AND scope = ?';      params.push(o.scope); }
  if (o.date)             { sql += ' AND date = ?';       params.push(o.date); }
  if (o.announcementUuid) { sql += ' AND announcement_uuid = ?'; params.push(o.announcementUuid); }
  sql += ' ORDER BY sort_order, trigger_time, rowid';
  return db.prepare(sql).all(...params);
}

function scheduleGet(db, uuid) {
  return db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ? AND deleted_at IS NULL`).get(uuid) ?? null;
}

// ── Writes — always through withMutation, so every change journals for sync ────

function scheduleCreate(db, payload) {
  validateScope();
  if (payload.station_id == null) throw new Error('[announcement_schedule] station_id is required');
  if (!payload.announcement_uuid) throw new Error('[announcement_schedule] announcement_uuid is required');
  const scope = payload.scope || 'weekday';
  if (scope !== 'weekday' && scope !== 'date') throw new Error(`[announcement_schedule] scope must be 'weekday' or 'date', got "${scope}"`);
  if (scope === 'date' && !payload.date) throw new Error('[announcement_schedule] a date-scoped entry needs a date');

  const now  = new Date().toISOString();
  const uuid = payload.uuid ?? crypto.randomUUID();
  const row  = {
    station_id:        payload.station_id,
    uuid,
    announcement_uuid: payload.announcement_uuid,
    scope,
    days:              scope === 'weekday' ? (payload.days ?? '0123456') : null,
    date:              scope === 'date'    ? payload.date : null,
    trigger_type:      payload.trigger_type ?? 'absolute',
    trigger_time:      payload.trigger_time ?? null,
    close_offset_min:  payload.close_offset_min ?? 0,
    sort_order:        payload.sort_order ?? 0,
    last_played_at:    payload.last_played_at ?? null,
    created_at:        now,
    updated_at:        now,
    deleted_at:        null,
  };
  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'insert',
    payload_before: null, payload_after: serializePayload(row, TABLE),
    station_id: row.station_id, actor_id: null,
  }, () => {
    db.prepare(
      `INSERT INTO ${TABLE}
         (station_id, uuid, announcement_uuid, scope, days, date, trigger_type, trigger_time,
          close_offset_min, sort_order, last_played_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.station_id, row.uuid, row.announcement_uuid, row.scope, row.days, row.date,
          row.trigger_type, row.trigger_time, row.close_offset_min, row.sort_order,
          row.last_played_at, row.created_at, row.updated_at, row.deleted_at);
  });
  return scheduleGet(db, uuid);
}

const PATCHABLE = ['days', 'date', 'scope', 'trigger_type', 'trigger_time', 'close_offset_min', 'sort_order'];

function scheduleUpdate(db, uuid, patch) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[announcement_schedule] row not found: ${uuid}`);
  const fields = PATCHABLE.filter(k => k in patch);
  if (fields.length === 0) throw new Error('[announcement_schedule] no patchable fields provided');

  // NO-OP GUARD, the station_config_kv lesson: a write that changes nothing must never journal a
  // mutation, because every peer pushes, pulls, applies and retains it forever.
  if (fields.every(k => String(existing[k] ?? '') === String(patch[k] ?? '')) && existing.deleted_at == null) {
    return existing;
  }

  const now     = new Date().toISOString();
  const updated = { ...existing, updated_at: now };
  for (const k of fields) updated[k] = patch[k];

  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'update',
    payload_before: serializePayload(existing, TABLE), payload_after: serializePayload(updated, TABLE),
    station_id: existing.station_id, actor_id: null,
  }, () => {
    const sets = fields.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE ${TABLE} SET ${sets}, updated_at = ? WHERE uuid = ?`)
      .run(...fields.map(k => patch[k]), now, uuid);
  });
  return scheduleGet(db, uuid);
}

function scheduleDelete(db, uuid, stationId) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) return { ok: true, deleted: false };
  if (existing.deleted_at) return { ok: true, deleted: false };
  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'delete',
    payload_before: serializePayload(existing, TABLE), payload_after: null,
    station_id: stationId ?? existing.station_id, actor_id: null,
  }, () => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE ${TABLE} SET deleted_at = ?, updated_at = ? WHERE uuid = ?`).run(now, now, uuid);
  });
  return { ok: true, deleted: true };
}

// ── CASCADE ───────────────────────────────────────────────────────────────────────────────────────

/** The announcement is gone — its entries go with it. Soft delete, so peers converge on the same
 *  removal. This is referential cleanup, not a compatibility shim: an entry that points at a deleted
 *  asset is a row the panel would list and the tick would have to filter forever. */
function deleteEntriesForAnnouncement(db, announcementUuid, stationId) {
  if (!announcementUuid) return;
  try {
    const rows = db.prepare(
      `SELECT uuid FROM ${TABLE} WHERE announcement_uuid = ? AND deleted_at IS NULL`
    ).all(announcementUuid);
    for (const r of rows) scheduleDelete(db, r.uuid, stationId);
  } catch (e) {
    console.error('[announcement_schedule] cascade delete failed:', (e && e.message) || e);
  }
}

// ── IPC — the panel edits entries through these ───────────────────────────────

function installAnnouncementSchedule(ipcMain, db) {
  const getDb = (typeof db === 'function') ? db : () => db;

  ipcMain.handle('announcement_schedule:list', (_, stationId, opts) => {
    try { return { ok: true, rows: scheduleList(getDb(), stationId, opts) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('announcement_schedule:create', (_, payload) => {
    try { return { ok: true, row: scheduleCreate(getDb(), payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('announcement_schedule:update', (_, uuid, patch) => {
    try { return { ok: true, row: scheduleUpdate(getDb(), uuid, patch) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('announcement_schedule:delete', (_, uuid, stationId) => {
    try { return { ok: true, ...scheduleDelete(getDb(), uuid, stationId) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  console.log('[announcement_schedule] handlers installed');
}

module.exports = {
  TABLE,
  validateScope,
  scheduleList,
  scheduleGet,
  scheduleCreate,
  scheduleUpdate,
  scheduleDelete,
  deleteEntriesForAnnouncement,
  installAnnouncementSchedule,
};
