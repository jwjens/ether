'use strict';

// electron/sync/handlers/sweeper_pool_member.js — WHICH CUTS ARE IN WHICH POOL (migration v55).
//
// Derived from the station-scoped handler shape the generator emits (clock_breaks is the closest
// sibling) and hand-placed rather than generated: scripts/generate-handlers.js rewrites ALL 30 handler
// files unconditionally, which would clobber the hand-customised ones (announcements' fire, the
// categories PATCHABLE list). If the generator is ever run, this file is regenerable from the same
// template — only LIST's pool filter and PATCHABLE below are specific to it.
//
// A membership is (pool_id, asset_uuid): a cut can be in several pools, and pools belong to stations,
// so one cut is now in halloVeen's Halloween AND Christmas in Jully's Summer Christmas at once.
// IPC handlers for the sweeper_pool_member table (station-scoped).
// Channels: sweeper_pool_member:list | :get-by-id | :create | :update | :update-by-id | :delete
// Preload:  window.ether.sweeperPoolMember.*
//
// All writes go through withMutation so every CRUD operation is logged to the
// mutations table for sync.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const { REGISTRY } = require('../synced-tables');

const TABLE              = 'sweeper_pool_member';
const HAS_STATION_ID_COL = true;
// asset_uuid and pool_id are the KEY — a membership is created or deleted, never repointed.
const PATCHABLE          = ["sort_order", "updated_at"];

// ── Scope guard ───────────────────────────────────────────────────────────────

function validateScope() {
  const entry = REGISTRY[TABLE];
  if (!entry) throw new Error(`[sweeper_pool_member] unknown table in registry: "${TABLE}"`);
  if (entry.scope !== 'station') {
    throw new Error(`[sweeper_pool_member] expected station-scoped table, registry has "${entry.scope}"`);
  }
}

// ── Business logic ────────────────────────────────────────────────────────────

function sweeperPoolMemberList(db, stationId, opts) {
  let sql    = `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL`;
  const params = [];
  if (HAS_STATION_ID_COL && stationId != null) {
    sql += ' AND station_id = ?';
    params.push(stationId);
  }
  // Optional pool filter — POOLS lists one pool's members at a time.
  if (opts && opts.poolId != null) {
    sql += ' AND pool_id = ?';
    params.push(opts.poolId);
  }
  const { limit = 500, offset = 0 } = opts || {};
  sql += ' ORDER BY pool_id, sort_order, rowid LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function sweeperPoolMemberGet(db, uuid) {
  return db.prepare(
    `SELECT * FROM ${TABLE} WHERE uuid = ? AND deleted_at IS NULL`
  ).get(uuid) ?? null;
}

function sweeperPoolMemberCreate(db, payload) {
  validateScope();
  if (HAS_STATION_ID_COL && payload.station_id == null) {
    throw new Error(`[sweeper_pool_member] station_id is required for station-scoped create`);
  }
  if (payload.pool_id == null) {
    throw new Error(`[sweeper_pool_member] pool_id is required`);
  }
  if (!payload.asset_uuid) {
    // The KEY is the asset uuid, never a local integer id: this row syncs, and an id does not mean the
    // same cut on another machine.
    throw new Error(`[sweeper_pool_member] asset_uuid is required`);
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
    if (payload.id != null) {
      db.prepare(
        `INSERT INTO ${TABLE} (id, pool_id, asset_uuid, sort_order, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(payload.id, row.pool_id, row.asset_uuid, row.sort_order, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
    } else {
      db.prepare(
        `INSERT INTO ${TABLE} (pool_id, asset_uuid, sort_order, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(row.pool_id, row.asset_uuid, row.sort_order, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
    }
  });
  return sweeperPoolMemberGet(db, uuid);
}

function sweeperPoolMemberUpdate(db, uuid, patch) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[sweeper_pool_member] row not found: ${uuid}`);

  const forbidden = Object.keys(patch).filter(k => k !== 'actor_id' && !PATCHABLE.includes(k));
  if (forbidden.length > 0) {
    throw new Error(`[sweeper_pool_member] cannot patch immutable field(s): ${forbidden.join(', ')}`);
  }

  const patchFields = PATCHABLE.filter(k => k in patch);
  if (patchFields.length === 0) {
    throw new Error(`[sweeper_pool_member] no patchable fields provided in patch`);
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
  return sweeperPoolMemberGet(db, uuid);
}

function sweeperPoolMemberUpdateById(db, intId, patch) {
  let existing = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(intId);
  if (!existing) throw new Error(`[sweeper_pool_member] row not found by id: ${intId}`);
  if (!existing.uuid) {
    const newUuid = crypto.randomUUID();
    db.prepare(`UPDATE ${TABLE} SET uuid = ? WHERE id = ?`).run(newUuid, intId);
    existing = { ...existing, uuid: newUuid };
  }
  return sweeperPoolMemberUpdate(db, existing.uuid, patch);
}

function sweeperPoolMemberDelete(db, uuid, stationId) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[sweeper_pool_member] row not found: ${uuid}`);

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

function installSweeperPoolMember(ipcMain, db) {
  const getDb = (typeof db === 'function') ? db : () => db;
  ipcMain.handle('sweeper_pool_member:list', (_, stationId, opts) => {
    try { return { ok: true, rows: sweeperPoolMemberList(getDb(), stationId, opts) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('sweeper_pool_member:get-by-id', (_, uuid) => {
    try { return { ok: true, row: sweeperPoolMemberGet(getDb(), uuid) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('sweeper_pool_member:create', (_, payload) => {
    try { return { ok: true, row: sweeperPoolMemberCreate(getDb(), payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('sweeper_pool_member:update', (_, uuid, patch) => {
    try { return { ok: true, row: sweeperPoolMemberUpdate(getDb(), uuid, patch) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('sweeper_pool_member:update-by-id', (_, intId, patch) => {
    try { return { ok: true, row: sweeperPoolMemberUpdateById(getDb(), intId, patch) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('sweeper_pool_member:delete', (_, uuid, stationId) => {
    try { return { ok: true, ...sweeperPoolMemberDelete(getDb(), uuid, stationId) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  console.log('[sweeper_pool_member] handlers installed');
}

module.exports = {
  installSweeperPoolMember,
  validateScope,
  sweeperPoolMemberList,
  sweeperPoolMemberGet,
  sweeperPoolMemberCreate,
  sweeperPoolMemberUpdate,
  sweeperPoolMemberUpdateById,
  sweeperPoolMemberDelete,
};
