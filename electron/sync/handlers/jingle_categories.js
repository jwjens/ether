'use strict';

// electron/sync/handlers/jingle_categories.js — mirrors the spot_categories handler (JINGLES overlay v1).
// IPC handlers for the jingle_categories table (station-scoped — each station has its own set + timing).
// Channels: jingle_categories:list | :get-by-id | :create | :update | :update-by-id | :refs | :delete
// Preload:  window.ether.jingleCategories.*
//
// Carries the per-category overlay timing/cadence (lead_in_sec / underlap_sec / cadence_every_n) that
// Generate snapshots onto each JIN placement row. Soft-delete does NOT cascade to songs: an orphaned JIN
// song (jingle_category_id → a deleted category) is simply never PLACED (Generate only selects categories
// WHERE deleted_at IS NULL), which is safe — the operator can reassign it. All writes go through
// withMutation so every CRUD op is logged for sync.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const { REGISTRY } = require('../synced-tables');

const TABLE              = 'jingle_categories';
const HAS_STATION_ID_COL = true;
const PATCHABLE          = ["name", "color", "lead_in_sec", "underlap_sec", "cadence_every_n", "sort_order", "updated_at"];

function validateScope() {
  const entry = REGISTRY[TABLE];
  if (!entry) throw new Error(`[jingle_categories] unknown table in registry: "${TABLE}"`);
  if (entry.scope !== 'station') throw new Error(`[jingle_categories] expected station-scoped table, registry has "${entry.scope}"`);
}

function jingleCategoriesList(db, stationId, opts) {
  let sql = `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL`;
  const params = [];
  if (HAS_STATION_ID_COL && stationId != null) { sql += ' AND station_id = ?'; params.push(stationId); }
  const { limit = 500, offset = 0 } = opts || {};
  sql += ' ORDER BY sort_order, rowid LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function jingleCategoriesGet(db, uuid) {
  return db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ? AND deleted_at IS NULL`).get(uuid) ?? null;
}

function jingleCategoriesCreate(db, payload) {
  validateScope();
  if (HAS_STATION_ID_COL && payload.station_id == null) throw new Error(`[jingle_categories] station_id is required for station-scoped create`);
  const now  = new Date().toISOString();
  const uuid = payload.uuid ?? crypto.randomUUID();
  const row  = {
    ...payload,
    lead_in_sec:     payload.lead_in_sec ?? 5,
    underlap_sec:    payload.underlap_sec ?? 2,
    cadence_every_n: payload.cadence_every_n ?? 4,
    sort_order:      payload.sort_order ?? 0,
    uuid, created_at: now, updated_at: now, deleted_at: payload.deleted_at ?? null,
  };
  const payloadAfter = serializePayload(row, TABLE);
  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'insert', payload_before: null, payload_after: payloadAfter,
    station_id: payload.station_id, actor_id: payload.actor_id ?? null,
  }, () => {
    if (payload.id != null) {
      db.prepare(`INSERT INTO ${TABLE} (id, name, color, lead_in_sec, underlap_sec, cadence_every_n, sort_order, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(payload.id, row.name, row.color, row.lead_in_sec, row.underlap_sec, row.cadence_every_n, row.sort_order, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
    } else {
      db.prepare(`INSERT INTO ${TABLE} (name, color, lead_in_sec, underlap_sec, cadence_every_n, sort_order, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.name, row.color, row.lead_in_sec, row.underlap_sec, row.cadence_every_n, row.sort_order, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
    }
  });
  return jingleCategoriesGet(db, uuid);
}

function jingleCategoriesUpdate(db, uuid, patch) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[jingle_categories] row not found: ${uuid}`);
  const forbidden = Object.keys(patch).filter(k => k !== 'actor_id' && !PATCHABLE.includes(k));
  if (forbidden.length > 0) throw new Error(`[jingle_categories] cannot patch immutable field(s): ${forbidden.join(', ')}`);
  const patchFields = PATCHABLE.filter(k => k in patch);
  if (patchFields.length === 0) throw new Error(`[jingle_categories] no patchable fields provided in patch`);
  const now = new Date().toISOString();
  const updated = { ...existing, updated_at: now };
  for (const k of patchFields) updated[k] = patch[k];
  const before = serializePayload(existing, TABLE);
  const after  = serializePayload(updated,  TABLE);
  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'update', payload_before: before, payload_after: after,
    station_id: existing.station_id, actor_id: patch.actor_id ?? null,
  }, () => {
    const sets = patchFields.map(k => `${k} = ?`).join(', ');
    const vals = patchFields.map(k => patch[k]);
    db.prepare(`UPDATE ${TABLE} SET ${sets}, updated_at = ? WHERE uuid = ?`).run(...vals, now, uuid);
  });
  return jingleCategoriesGet(db, uuid);
}

function jingleCategoriesUpdateById(db, intId, patch) {
  let existing = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(intId);
  if (!existing) throw new Error(`[jingle_categories] row not found by id: ${intId}`);
  if (!existing.uuid) {
    const newUuid = crypto.randomUUID();
    db.prepare(`UPDATE ${TABLE} SET uuid = ? WHERE id = ?`).run(newUuid, intId);
    existing = { ...existing, uuid: newUuid };
  }
  return jingleCategoriesUpdate(db, existing.uuid, patch);
}

// Read-only: how many JIN songs are assigned to this category (for an honest delete confirm / list badge).
function jingleCategoriesRefs(db, uuid) {
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) return { songs: 0 };
  let songs = 0;
  try { songs = db.prepare(`SELECT COUNT(*) c FROM songs WHERE jingle_category_id = ? AND deleted_at IS NULL`).get(existing.id).c; } catch {}
  return { songs };
}

function jingleCategoriesDelete(db, uuid, stationId) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[jingle_categories] row not found: ${uuid}`);
  const before = serializePayload(existing, TABLE);
  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'delete', payload_before: before, payload_after: null,
    station_id: (stationId ?? existing.station_id), actor_id: null,
  }, () => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE ${TABLE} SET deleted_at = ?, updated_at = ? WHERE uuid = ?`).run(now, now, uuid);
  });
  return { ok: true };
}

function installJingleCategories(ipcMain, db) {
  const getDb = (typeof db === 'function') ? db : () => db;
  ipcMain.handle('jingle_categories:list', (_, stationId, opts) => { try { return { ok: true, rows: jingleCategoriesList(getDb(), stationId, opts) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('jingle_categories:get-by-id', (_, uuid) => { try { return { ok: true, row: jingleCategoriesGet(getDb(), uuid) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('jingle_categories:create', (_, payload) => { try { return { ok: true, row: jingleCategoriesCreate(getDb(), payload) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('jingle_categories:update', (_, uuid, patch) => { try { return { ok: true, row: jingleCategoriesUpdate(getDb(), uuid, patch) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('jingle_categories:update-by-id', (_, intId, patch) => { try { return { ok: true, row: jingleCategoriesUpdateById(getDb(), intId, patch) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('jingle_categories:refs', (_, uuid) => { try { return { ok: true, ...jingleCategoriesRefs(getDb(), uuid) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('jingle_categories:delete', (_, uuid, stationId) => { try { return { ok: true, ...jingleCategoriesDelete(getDb(), uuid, stationId) }; } catch (e) { return { ok: false, error: e.message }; } });
  console.log('[jingle_categories] handlers installed');
}

module.exports = {
  installJingleCategories, validateScope,
  jingleCategoriesList, jingleCategoriesGet, jingleCategoriesCreate,
  jingleCategoriesUpdate, jingleCategoriesUpdateById, jingleCategoriesRefs, jingleCategoriesDelete,
};
