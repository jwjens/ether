'use strict';

// electron/sync/handlers/spot_categories.js — mirrors the generated categories.js handler.
// IPC handlers for the spot_categories table (station-scoped — each station has its own set).
// Channels: spot_categories:list | :get-by-id | :create | :update | :update-by-id | :delete
// Preload:  window.ether.spotCategories.*
//
// All writes go through withMutation so every CRUD operation is logged to the
// mutations table for sync.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const { REGISTRY } = require('../synced-tables');

const TABLE              = 'spot_categories';
const HAS_STATION_ID_COL = true;
const PATCHABLE          = ["name", "color", "sort_order", "updated_at"];

// ── Scope guard ───────────────────────────────────────────────────────────────

function validateScope() {
  const entry = REGISTRY[TABLE];
  if (!entry) throw new Error(`[spot_categories] unknown table in registry: "${TABLE}"`);
  if (entry.scope !== 'station') {
    throw new Error(`[spot_categories] expected station-scoped table, registry has "${entry.scope}"`);
  }
}

// ── Business logic ────────────────────────────────────────────────────────────

function spotCategoriesList(db, stationId, opts) {
  let sql    = `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL`;
  const params = [];
  if (HAS_STATION_ID_COL && stationId != null) {
    sql += ' AND station_id = ?';
    params.push(stationId);
  }
  const { limit = 500, offset = 0 } = opts || {};
  sql += ' ORDER BY sort_order, rowid LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function spotCategoriesGet(db, uuid) {
  return db.prepare(
    `SELECT * FROM ${TABLE} WHERE uuid = ? AND deleted_at IS NULL`
  ).get(uuid) ?? null;
}

function spotCategoriesCreate(db, payload) {
  validateScope();
  if (HAS_STATION_ID_COL && payload.station_id == null) {
    throw new Error(`[spot_categories] station_id is required for station-scoped create`);
  }
  const now  = new Date().toISOString();
  const uuid = payload.uuid ?? crypto.randomUUID();
  const row  = {
    ...payload,
    sort_order: payload.sort_order ?? 0,
    uuid,
    created_at: now,
    updated_at: now,
    deleted_at: payload.deleted_at ?? null,
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
    // Honor an explicit id when provided (parallels the categories handler) — lets a cloud/import
    // path clone a category scheme with the SAME integer ids. Normal creates omit id → AUTOINCREMENT.
    if (payload.id != null) {
      db.prepare(
        `INSERT INTO ${TABLE} (id, name, color, sort_order, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(payload.id, row.name, row.color, row.sort_order, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
    } else {
      db.prepare(
        `INSERT INTO ${TABLE} (name, color, sort_order, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(row.name, row.color, row.sort_order, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
    }
  });
  return spotCategoriesGet(db, uuid);
}

function spotCategoriesUpdate(db, uuid, patch) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[spot_categories] row not found: ${uuid}`);

  const forbidden = Object.keys(patch).filter(k => k !== 'actor_id' && !PATCHABLE.includes(k));
  if (forbidden.length > 0) {
    throw new Error(`[spot_categories] cannot patch immutable field(s): ${forbidden.join(', ')}`);
  }

  const patchFields = PATCHABLE.filter(k => k in patch);
  if (patchFields.length === 0) {
    throw new Error(`[spot_categories] no patchable fields provided in patch`);
  }

  const now     = new Date().toISOString();
  const updated = { ...existing, updated_at: now };
  for (const k of patchFields) updated[k] = patch[k];

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
    const sets = patchFields.map(k => `${k} = ?`).join(', ');
    const vals = patchFields.map(k => patch[k]);
    db.prepare(`UPDATE ${TABLE} SET ${sets}, updated_at = ? WHERE uuid = ?`).run(...vals, now, uuid);
  });
  return spotCategoriesGet(db, uuid);
}

function spotCategoriesUpdateById(db, intId, patch) {
  let existing = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(intId);
  if (!existing) throw new Error(`[spot_categories] row not found by id: ${intId}`);
  if (!existing.uuid) {
    const newUuid = crypto.randomUUID();
    db.prepare(`UPDATE ${TABLE} SET uuid = ? WHERE id = ?`).run(newUuid, intId);
    existing = { ...existing, uuid: newUuid };
  }
  return spotCategoriesUpdate(db, existing.uuid, patch);
}

function spotCategoriesDelete(db, uuid, stationId) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[spot_categories] row not found: ${uuid}`);

  const before = serializePayload(existing, TABLE);

  withMutation(db, {
    table_name:     TABLE,
    row_id:         uuid,
    op:             'delete',
    payload_before: before,
    payload_after:  null,
    station_id:     (stationId ?? existing.station_id),
    actor_id:       null,
  }, () => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE ${TABLE} SET deleted_at = ?, updated_at = ? WHERE uuid = ?`
    ).run(now, now, uuid);
  });
  return { ok: true };
}

// ── IPC installation ──────────────────────────────────────────────────────────

function installSpotCategories(ipcMain, db) {
  const getDb = (typeof db === 'function') ? db : () => db;
  ipcMain.handle('spot_categories:list', (_, stationId, opts) => {
    try { return { ok: true, rows: spotCategoriesList(getDb(), stationId, opts) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('spot_categories:get-by-id', (_, uuid) => {
    try { return { ok: true, row: spotCategoriesGet(getDb(), uuid) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('spot_categories:create', (_, payload) => {
    try { return { ok: true, row: spotCategoriesCreate(getDb(), payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('spot_categories:update', (_, uuid, patch) => {
    try { return { ok: true, row: spotCategoriesUpdate(getDb(), uuid, patch) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('spot_categories:update-by-id', (_, intId, patch) => {
    try { return { ok: true, row: spotCategoriesUpdateById(getDb(), intId, patch) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('spot_categories:delete', (_, uuid, stationId) => {
    try { return { ok: true, ...spotCategoriesDelete(getDb(), uuid, stationId) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  console.log('[spot_categories] handlers installed');
}

module.exports = {
  installSpotCategories,
  validateScope,
  spotCategoriesList,
  spotCategoriesGet,
  spotCategoriesCreate,
  spotCategoriesUpdate,
  spotCategoriesUpdateById,
  spotCategoriesDelete,
};
