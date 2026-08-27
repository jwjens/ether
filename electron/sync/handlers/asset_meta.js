'use strict';

// electron/sync/handlers/asset_meta.js — the type-specific side tables (v50).
//
// docs/library-asset-build-plan-2026-08-26.md
//
// IDENTITY UNIFIES, TYPE DETAIL SITS BESIDE IT. A spot's ISCI code has no business on a sweeper row,
// and a rotation query has no business joining past columns it will never read. So library_asset
// holds what every asset has, and these hold what one kind of asset has.
//
//   asset_spot_meta     STATION-SCOPED — the same audio file can be sold to two stations on
//                       different terms, so the traffic row is per (asset, station).
//   asset_sweeper_meta  install-scoped — keyed by the asset alone.
//
// Both handlers live in one file because they are the same shape and the same rules; splitting them
// would duplicate the guards without separating anything.
//
// NOTHING READS THESE YET. v50 is additive; `spots` remains authoritative until the reader flip.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const { REGISTRY } = require('../synced-tables');

// ── shared helpers ────────────────────────────────────────────────────────────

function expectScope(table, want) {
  const entry = REGISTRY[table];
  if (!entry) throw new Error(`[${table}] unknown table in registry`);
  if (entry.scope !== want) throw new Error(`[${table}] expected ${want}-scoped, registry has "${entry.scope}"`);
}

/** One upsert shape for both tables: journal every write, and never journal a no-op. */
function upsert(db, { table, findSql, findArgs, insertCols, row, stationId }) {
  const existing = db.prepare(findSql).get(...findArgs);
  const now = new Date().toISOString();

  if (!existing) {
    const uuid = row.uuid || crypto.randomUUID();
    const full = { ...row, uuid, created_at: now, updated_at: now, deleted_at: null };
    withMutation(db, {
      table_name: table, row_id: uuid, op: 'insert',
      payload_before: null, payload_after: serializePayload(full, table),
      station_id: stationId ?? null, actor_id: null,
    }, () => {
      db.prepare(`INSERT INTO ${table} (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`)
        .run(...insertCols.map(c => full[c] ?? null));
    });
    return db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid);
  }

  // NO-OP GUARD (the station_config_kv lesson): every mutation is pushed, pulled, applied and
  // retained by every peer forever, so a write that changes nothing must not become one.
  const changing = Object.keys(row).filter(k => k !== 'uuid' && k !== 'created_at');
  if (changing.every(k => String(existing[k] ?? '') === String(row[k] ?? '')) && existing.deleted_at == null) {
    return existing;
  }

  const updated = { ...existing, ...row, deleted_at: null, updated_at: now };
  withMutation(db, {
    table_name: table, row_id: existing.uuid, op: 'update',
    payload_before: serializePayload(existing, table), payload_after: serializePayload(updated, table),
    station_id: stationId ?? null, actor_id: null,
  }, () => {
    const sets = changing.map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE ${table} SET ${sets}, deleted_at = NULL, updated_at = ? WHERE uuid = ?`)
      .run(...changing.map(k => row[k] ?? null), now, existing.uuid);
  });
  return db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(existing.uuid);
}

function softDelete(db, table, uuid, stationId) {
  const existing = db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid);
  if (!existing || existing.deleted_at) return { ok: true, deleted: false };
  withMutation(db, {
    table_name: table, row_id: uuid, op: 'delete',
    payload_before: serializePayload(existing, table), payload_after: null,
    station_id: stationId ?? existing.station_id ?? null, actor_id: null,
  }, () => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE uuid = ?`).run(now, now, uuid);
  });
  return { ok: true, deleted: true };
}

// ── asset_spot_meta — the traffic row, PER STATION ────────────────────────────

const SPOT = 'asset_spot_meta';
const SPOT_COLS = ['asset_uuid', 'station_id', 'spot_type', 'advertiser', 'agency', 'isci_code',
  'cart_number', 'spot_category_id', 'start_date', 'end_date', 'max_plays_day', 'play_count',
  'last_played_at', 'length_sec', 'notes', 'art_image', 'is_active',
  'uuid', 'created_at', 'updated_at', 'deleted_at'];

function spotMetaList(db, stationId, opts) {
  const o = opts || {};
  let sql = `SELECT * FROM ${SPOT} WHERE deleted_at IS NULL`;
  const params = [];
  if (stationId != null) { sql += ' AND station_id = ?'; params.push(stationId); }
  if (o.assetUuid)       { sql += ' AND asset_uuid = ?'; params.push(o.assetUuid); }
  sql += ' ORDER BY advertiser, rowid';
  return db.prepare(sql).all(...params);
}

function spotMetaUpsert(db, payload) {
  expectScope(SPOT, 'station');
  if (!payload.asset_uuid) throw new Error('[asset_spot_meta] asset_uuid is required');
  if (payload.station_id == null) throw new Error('[asset_spot_meta] station_id is required — traffic terms are per station');
  const row = {};
  for (const c of SPOT_COLS) if (c in payload) row[c] = payload[c];
  row.asset_uuid = payload.asset_uuid; row.station_id = payload.station_id;
  return upsert(db, {
    table: SPOT,
    findSql: `SELECT * FROM ${SPOT} WHERE asset_uuid = ? AND station_id = ? ORDER BY deleted_at IS NULL DESC, rowid DESC LIMIT 1`,
    findArgs: [payload.asset_uuid, payload.station_id],
    insertCols: SPOT_COLS, row, stationId: payload.station_id,
  });
}

const spotMetaDelete = (db, uuid, stationId) => softDelete(db, SPOT, uuid, stationId);

// ── asset_sweeper_meta — install-scoped ───────────────────────────────────────

const SWEEP = 'asset_sweeper_meta';
const SWEEP_COLS = ['asset_uuid', 'sweeper_category_id', 'uuid', 'created_at', 'updated_at', 'deleted_at'];

function sweeperMetaList(db, opts) {
  const o = opts || {};
  let sql = `SELECT * FROM ${SWEEP} WHERE deleted_at IS NULL`;
  const params = [];
  if (o.assetUuid) { sql += ' AND asset_uuid = ?'; params.push(o.assetUuid); }
  return db.prepare(sql).all(...params);
}

function sweeperMetaUpsert(db, payload) {
  expectScope(SWEEP, 'install');
  if (!payload.asset_uuid) throw new Error('[asset_sweeper_meta] asset_uuid is required');
  const row = {};
  for (const c of SWEEP_COLS) if (c in payload) row[c] = payload[c];
  row.asset_uuid = payload.asset_uuid;
  return upsert(db, {
    table: SWEEP,
    findSql: `SELECT * FROM ${SWEEP} WHERE asset_uuid = ? ORDER BY deleted_at IS NULL DESC, rowid DESC LIMIT 1`,
    findArgs: [payload.asset_uuid],
    insertCols: SWEEP_COLS, row, stationId: null,
  });
}

const sweeperMetaDelete = (db, uuid) => softDelete(db, SWEEP, uuid, null);

// ── IPC ───────────────────────────────────────────────────────────────────────

function installAssetMeta(ipcMain, db) {
  const getDb = (typeof db === 'function') ? db : () => db;
  const wrap = (fn) => (...a) => { try { return { ok: true, ...fn(...a) }; } catch (e) { return { ok: false, error: e.message }; } };

  ipcMain.handle('asset_spot_meta:list',   (_, stationId, opts) => wrap(() => ({ rows: spotMetaList(getDb(), stationId, opts) }))());
  ipcMain.handle('asset_spot_meta:upsert', (_, payload)         => wrap(() => ({ row: spotMetaUpsert(getDb(), payload) }))());
  ipcMain.handle('asset_spot_meta:delete', (_, uuid, stationId) => wrap(() => spotMetaDelete(getDb(), uuid, stationId))());

  ipcMain.handle('asset_sweeper_meta:list',   (_, opts)    => wrap(() => ({ rows: sweeperMetaList(getDb(), opts) }))());
  ipcMain.handle('asset_sweeper_meta:upsert', (_, payload) => wrap(() => ({ row: sweeperMetaUpsert(getDb(), payload) }))());
  ipcMain.handle('asset_sweeper_meta:delete', (_, uuid)    => wrap(() => sweeperMetaDelete(getDb(), uuid))());

  console.log('[asset_meta] handlers installed');
}

module.exports = {
  spotMetaList, spotMetaUpsert, spotMetaDelete,
  sweeperMetaList, sweeperMetaUpsert, sweeperMetaDelete,
  installAssetMeta,
};
