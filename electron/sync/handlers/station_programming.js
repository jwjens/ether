'use strict';

// electron/sync/handlers/station_programming.js
// Five IPC handlers for the station_programming table (Phase 4, Direction C).
//
// Channels: station_programming:list | :get | :add | :update | :remove
// Preload:  window.ether.stationProgramming.*
//
// All writes go through withMutation so every CRUD operation is logged to the
// mutations table for future sync. station_programming is station-scoped;
// validateScope() enforces this at the boundary so the code generator can
// reuse the pattern for other station-scoped tables without accidentally
// writing install-scoped tables (songs/artists/albums/mood_tags) through a
// station handler.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const { REGISTRY } = require('../synced-tables');

const TABLE = 'station_programming';

// ── Scope guard ───────────────────────────────────────────────────────────────

function validateScope(tableName) {
  const entry = REGISTRY[tableName];
  if (!entry) {
    throw new Error(`[station_programming] unknown table: "${tableName}"`);
  }
  if (entry.scope !== 'station') {
    throw new Error(
      `[station_programming] table "${tableName}" is ${entry.scope}-scoped; ` +
      `station-scoped handler cannot write it`
    );
  }
}

// ── Business logic (exported for smoke tests) ─────────────────────────────────

function spList(db, stationId, opts) {
  const { categoryId, rotationStatus, limit = 500, offset = 0 } = opts || {};
  let sql = `SELECT * FROM ${TABLE} WHERE station_id = ? AND deleted_at IS NULL`;
  const params = [stationId];
  if (categoryId != null)     { sql += ' AND category_id = ?';     params.push(categoryId); }
  if (rotationStatus != null) { sql += ' AND rotation_status = ?'; params.push(rotationStatus); }
  sql += ' ORDER BY id LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function spGet(db, uuid) {
  return db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid) ?? null;
}

function spAdd(db, payload) {
  validateScope(TABLE);
  const now  = new Date().toISOString();
  const uuid = payload.uuid ?? crypto.randomUUID();
  const row = {
    uuid,
    song_id:         payload.song_id,
    station_id:      payload.station_id,
    category_id:     payload.category_id,
    energy:          payload.energy          ?? null,
    daypart_mask:    payload.daypart_mask     ?? 16777215,
    rotation_status: payload.rotation_status  ?? 'active',
    no_repeat_hours: payload.no_repeat_hours  ?? null,
    last_played_at:  payload.last_played_at   ?? null,
    play_count:      payload.play_count        ?? 0,
    notes:           payload.notes             ?? null,
    added_at:        payload.added_at          ?? now,
    created_at:      now,
    updated_at:      now,
    deleted_at:      null,
  };
  const payloadAfter = serializePayload(row, TABLE);
  withMutation(db, {
    table_name:     TABLE,
    row_id:         uuid,
    op:             'insert',
    payload_before: null,
    payload_after:  payloadAfter,
    station_id:     payload.station_id,
    actor_id:       payload.actor_id ?? null,
  }, () => {
    db.prepare(`
      INSERT INTO ${TABLE}
        (uuid, song_id, station_id, category_id, energy, daypart_mask, rotation_status,
         no_repeat_hours, last_played_at, play_count, notes, added_at, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.uuid, row.song_id, row.station_id, row.category_id,
      row.energy, row.daypart_mask, row.rotation_status, row.no_repeat_hours,
      row.last_played_at, row.play_count, row.notes, row.added_at,
      row.created_at, row.updated_at, row.deleted_at
    );
  });
  return spGet(db, uuid);
}

const PATCHABLE = [
  'category_id', 'energy', 'daypart_mask', 'rotation_status',
  'no_repeat_hours', 'notes', 'last_played_at', 'play_count',
];

function spUpdate(db, uuid, patch) {
  validateScope(TABLE);
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[station_programming] row not found: ${uuid}`);

  const now     = new Date().toISOString();
  const updated = { ...existing, updated_at: now };
  for (const key of PATCHABLE) {
    if (key in patch) updated[key] = patch[key];
  }

  const before = serializePayload(existing, TABLE);
  const after  = serializePayload(updated,  TABLE);

  withMutation(db, {
    table_name:     TABLE,
    row_id:         uuid,
    op:             'update',
    payload_before: before,
    payload_after:  after,
    station_id:     existing.station_id,
    actor_id:       patch.actor_id ?? null,
  }, () => {
    db.prepare(`
      UPDATE ${TABLE}
      SET category_id=?, energy=?, daypart_mask=?, rotation_status=?,
          no_repeat_hours=?, notes=?, last_played_at=?, play_count=?, updated_at=?
      WHERE uuid=?
    `).run(
      updated.category_id, updated.energy, updated.daypart_mask, updated.rotation_status,
      updated.no_repeat_hours, updated.notes, updated.last_played_at, updated.play_count,
      updated.updated_at, uuid
    );
  });
  return spGet(db, uuid);
}

function spRemove(db, uuid, stationId) {
  validateScope(TABLE);
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[station_programming] row not found: ${uuid}`);

  const before = serializePayload(existing, TABLE);

  withMutation(db, {
    table_name:     TABLE,
    row_id:         uuid,
    op:             'delete',
    payload_before: before,
    payload_after:  null,
    station_id:     stationId ?? existing.station_id,
    actor_id:       null,
  }, () => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE ${TABLE} SET deleted_at=?, updated_at=? WHERE uuid=?`).run(now, now, uuid);
  });
  return { ok: true };
}

// ── IPC installation ──────────────────────────────────────────────────────────

function installStationProgramming(ipcMain, db) {
  ipcMain.handle('station_programming:list', (_, stationId, opts) => {
    try { return { ok: true, rows: spList(db, stationId, opts) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('station_programming:get-by-id', (_, uuid) => {
    try { return { ok: true, row: spGet(db, uuid) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('station_programming:create', (_, payload) => {
    try { return { ok: true, row: spAdd(db, payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('station_programming:update', (_, uuid, patch) => {
    try { return { ok: true, row: spUpdate(db, uuid, patch) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('station_programming:delete', (_, uuid, stationId) => {
    try { return { ok: true, ...spRemove(db, uuid, stationId) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  console.log('[station_programming] handlers installed');
}

module.exports = {
  installStationProgramming,
  validateScope,
  spList,
  spGet,
  spAdd,
  spUpdate,
  spRemove,
};
