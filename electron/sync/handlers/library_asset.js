'use strict';

// electron/sync/handlers/library_asset.js — the unified library (v50).
//
// docs/library-asset-build-plan-2026-08-26.md · docs/unified-library-architecture-2026-08-26.md
//
// ONE row per playable asset, INSTALL-SCOPED: an asset is a FILE, and every station draws from one
// shared library. There is deliberately no station_id.
//
// THIS TABLE CARRIES DEFAULTS, NEVER TRUTHS. Title and Artist here are what a station sees UNTIL it
// overrides them in song_metadata_values. Any writer that treats a column here as the authoritative
// value for a station is wrong — resolution is override-then-default, and it lives in one resolver.
//
// THE THREE AXES (docs/three-axes-preserved-2026-08-26.md):
//   TYPE     — this table's `type`. 8 codes, developer-defined, install-wide.
//   CATEGORY — `categories`. UNLIMITED, operator-created, per station. NOT here.
//   METADATA — `metadata_definitions`. UNLIMITED custom fields, per station. NOT here.
// Nothing in this handler may collapse one into another.
//
// NOTHING READS THIS YET. v50 is additive: `songs` and `spots` remain authoritative and the reader
// flip is a later, separately-verified step.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const { REGISTRY } = require('../synced-tables');
const assetTypes = require('../../asset-types');

const TABLE = 'library_asset';

function validateScope() {
  const entry = REGISTRY[TABLE];
  if (!entry) throw new Error(`[library_asset] unknown table in registry: "${TABLE}"`);
  if (entry.scope !== 'install') {
    throw new Error(`[library_asset] expected install-scoped table, registry has "${entry.scope}" — ` +
                    `an asset is a FILE and the library is shared across stations`);
  }
}

const PATCHABLE = [
  'type', 'title', 'artist_id', 'album_id', 'genre', 'file_path', 'file_key', 'duration_ms',
  'bpm', 'energy', 'mood', 'gender', 'is_explicit', 'spotify_uri', 'cart_id',
  'cue_in', 'cue_out', 'cue_in_ms', 'cue_out_ms', 'intro_end', 'outro_start',
  'intro_end_ms', 'outro_start_ms', 'has_intro', 'intro_version_path',
  'lufs_measured', 'peak_db', 'gain_db', 'is_processed', 'last_played_at', 'play_count',
  'raw_metadata', 'r2_uploaded_at',
];

// ── Reads ─────────────────────────────────────────────────────────────────────

function assetList(db, opts) {
  const o = opts || {};
  let sql = `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL`;
  const params = [];
  // Types come from the REGISTRY, never from a literal — a ninth type is included the moment it is
  // declared, with no edit here.
  if (Array.isArray(o.types) && o.types.length) {
    sql += ` AND type IN (${assetTypes.placeholders(o.types)})`;
    params.push(...o.types.map(t => assetTypes.normalizeType(t)));
  }
  if (o.search) {
    sql += ' AND (title LIKE ? OR file_path LIKE ?)';
    params.push(`%${o.search}%`, `%${o.search}%`);
  }
  const { limit = 500, offset = 0 } = o;
  sql += ' ORDER BY title, rowid LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function assetGet(db, uuid) {
  return db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ? AND deleted_at IS NULL`).get(uuid) ?? null;
}

/** Counts per type — what the Library tabs show beside each name. */
function assetCounts(db) {
  const out = {};
  for (const r of db.prepare(`SELECT type, COUNT(*) n FROM ${TABLE} WHERE deleted_at IS NULL GROUP BY type`).all()) {
    out[assetTypes.normalizeType(r.type)] = (out[assetTypes.normalizeType(r.type)] || 0) + r.n;
  }
  return out;
}

// ── Writes — always through withMutation, so every change journals for sync ────

function assetCreate(db, payload) {
  validateScope();
  if (!payload || !payload.title) throw new Error('[library_asset] title is required');
  // An unrecognised type is STORED AS GIVEN, not rejected: a newer peer may know a type this build
  // does not, and refusing it would drop that asset from this install entirely. normalizeType only
  // decides how it DISPLAYS.
  const type = String(payload.type || assetTypes.FALLBACK_TYPE).trim().toUpperCase();
  const now  = new Date().toISOString();
  const uuid = payload.uuid ?? crypto.randomUUID();
  const row  = { ...payload, uuid, type, created_at: now, updated_at: now, deleted_at: null };

  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'insert',
    payload_before: null, payload_after: serializePayload(row, TABLE),
    station_id: null, actor_id: null,          // install-scoped: no station owns an asset
  }, () => {
    const cols = ['uuid', 'type', 'created_at', 'updated_at', 'deleted_at', ...PATCHABLE.filter(c => c !== 'type')];
    const uniq = [...new Set(cols)];
    db.prepare(`INSERT INTO ${TABLE} (${uniq.join(', ')}) VALUES (${uniq.map(() => '?').join(', ')})`)
      .run(...uniq.map(c => row[c] ?? null));
  });
  return assetGet(db, uuid);
}

function assetUpdate(db, uuid, patch) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) throw new Error(`[library_asset] row not found: ${uuid}`);
  const fields = PATCHABLE.filter(k => k in patch);
  if (!fields.length) throw new Error('[library_asset] no patchable fields provided');

  // NO-OP GUARD, the station_config_kv lesson: a write that changes nothing must never journal a
  // mutation, because every peer pushes, pulls, applies and retains it forever.
  if (fields.every(k => String(existing[k] ?? '') === String(patch[k] ?? '')) && existing.deleted_at == null) {
    return existing;
  }

  const now = new Date().toISOString();
  const updated = { ...existing, updated_at: now };
  for (const k of fields) updated[k] = patch[k];

  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'update',
    payload_before: serializePayload(existing, TABLE), payload_after: serializePayload(updated, TABLE),
    station_id: null, actor_id: null,
  }, () => {
    db.prepare(`UPDATE ${TABLE} SET ${fields.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE uuid = ?`)
      .run(...fields.map(k => patch[k]), now, uuid);
  });
  return assetGet(db, uuid);
}

/** Soft delete. The per-station overlays are left alone — an override for a deleted asset is
 *  harmless and preserves what the station had chosen if the delete is ever undone. */
function assetDelete(db, uuid) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
  if (!existing) return { ok: true, deleted: false };
  if (existing.deleted_at) return { ok: true, deleted: false };
  withMutation(db, {
    table_name: TABLE, row_id: uuid, op: 'delete',
    payload_before: serializePayload(existing, TABLE), payload_after: null,
    station_id: null, actor_id: null,
  }, () => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE ${TABLE} SET deleted_at = ?, updated_at = ? WHERE uuid = ?`).run(now, now, uuid);
  });
  return { ok: true, deleted: true };
}

// ── IPC ───────────────────────────────────────────────────────────────────────

function installLibraryAsset(ipcMain, db) {
  const getDb = (typeof db === 'function') ? db : () => db;

  ipcMain.handle('library_asset:list', (_, opts) => {
    try { return { ok: true, rows: assetList(getDb(), opts) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('library_asset:get-by-id', (_, uuid) => {
    try { return { ok: true, row: assetGet(getDb(), uuid) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('library_asset:counts', () => {
    try { return { ok: true, counts: assetCounts(getDb()) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('library_asset:create', (_, payload) => {
    try { return { ok: true, row: assetCreate(getDb(), payload) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('library_asset:update', (_, uuid, patch) => {
    try { return { ok: true, row: assetUpdate(getDb(), uuid, patch) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('library_asset:delete', (_, uuid) => {
    try { return { ok: true, ...assetDelete(getDb(), uuid) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  console.log('[library_asset] handlers installed');
}

module.exports = {
  TABLE, validateScope,
  assetList, assetGet, assetCounts, assetCreate, assetUpdate, assetDelete,
  installLibraryAsset,
};
