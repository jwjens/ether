'use strict';
// electron/sync/id-numbering.js — EACH MACHINE'S NUMBERING, PUBLISHED (2026-10-19).
//
// Local integer ids are per machine: the same category is 22 on one install and 23 on the other once either has
// created a row the other has not (Aug 13, "Early tracks" twice). A reference that went out as a bare integer can only
// be understood through the numbering of the machine that sent it. New mutations carry the parent's uuid
// (`ref_uuids`), so they never need this. Two things still do:
//
//   · the ONE-TIME REPAIR (uuid-ref-repair.js) — every assignment already in the log was made in some machine's
//     numbering; "which machine made it, and what did its number mean there" is answered here;
//   · a mutation from a machine still on an older build (or one already in flight) — merge-engine translates its
//     integers through this when it has the sender's map.
//
// Each machine publishes `install_config_kv` key `id_numbering:<client_id>` = { v, client_id, at, tables: { <table>:
// { <id>: <uuid> } } } through the sanctioned journalled writer, so it syncs install-wide to every machine on the
// account like any other row. Deleted rows are included: an old assignment may point at a category deleted since.
// docs/sync-uuid-references-2026-10-19.md.

const crypto = require('crypto');
const { REGISTRY } = require('./synced-tables');
const { withMutation, serializePayload, getClientId } = require('./mutation-writer');

const KEY_PREFIX = 'id_numbering:';
const NUMBERING_VERSION = 1;
// The tables a synced reference can point at that the repair and legacy translation need (synced-tables refs).
const NUMBERED_TABLES = ['categories', 'jingle_categories', 'artists', 'albums', 'songs', 'shows', 'clocks'];

const physical = (t) => (REGISTRY[t] && REGISTRY[t].tableName) || t;

/** This machine's numbering: { table: { id: uuid } } for every row that has a uuid, deleted rows included. */
function buildNumbering(db) {
  const tables = {};
  for (const t of NUMBERED_TABLES) {
    const map = {};
    try {
      for (const r of db.prepare(`SELECT id, uuid FROM ${physical(t)} WHERE uuid IS NOT NULL AND id IS NOT NULL`).iterate()) {
        map[String(r.id)] = r.uuid;
      }
    } catch { /* table absent on this install */ }
    tables[t] = map;
  }
  return tables;
}

/**
 * Publish this machine's numbering when it differs from what is published. Returns { published, key, sizes }.
 * Journalled with withMutation so it syncs like any install-scoped row; a no-op when nothing changed.
 */
function publishNumbering(db) {
  const clientId = getClientId(db);
  if (!clientId) return { published: false, reason: 'no client_id' };
  const key = KEY_PREFIX + clientId;
  const tables = buildNumbering(db);
  const existing = db.prepare('SELECT * FROM install_config_kv WHERE key = ?').get(key) || null;
  try {
    const prev = existing && existing.value ? JSON.parse(existing.value) : null;
    if (prev && JSON.stringify(prev.tables) === JSON.stringify(tables) && !existing.deleted_at) {
      return { published: false, key, reason: 'unchanged' };
    }
  } catch { /* unreadable → republish */ }
  const value = JSON.stringify({ v: NUMBERING_VERSION, client_id: clientId, at: new Date().toISOString(), tables });
  const now = new Date().toISOString();
  const row = existing
    ? { ...existing, value, updated_at: now, deleted_at: null }
    : { key, value, uuid: crypto.randomUUID(), created_at: now, updated_at: now, deleted_at: null };
  withMutation(db, {
    table_name:     'install_config_kv',
    row_id:         row.uuid,
    op:             existing ? 'update' : 'insert',
    payload_before: existing ? serializePayload(existing, 'install_config_kv') : null,
    payload_after:  serializePayload(row, 'install_config_kv'),
    station_id:     null,
  }, () => {
    if (existing) {
      db.prepare('UPDATE install_config_kv SET value = ?, updated_at = ?, deleted_at = NULL WHERE key = ?').run(value, now, key);
    } else {
      db.prepare('INSERT INTO install_config_kv (key, value, uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(key, value, row.uuid, now, now);
    }
  });
  const sizes = Object.fromEntries(Object.entries(tables).map(([t, m]) => [t, Object.keys(m).length]));
  return { published: true, key, sizes };
}

// Parsed maps, cached by the row's updated_at so a republish from the other machine is picked up on the next read.
const _cache = new Map();   // clientId → { updated_at, tables }

/** Another (or this) machine's published numbering, or null when it has not published one. */
function readNumbering(db, clientId) {
  if (!clientId) return null;
  let row;
  try { row = db.prepare('SELECT value, updated_at FROM install_config_kv WHERE key = ? AND deleted_at IS NULL').get(KEY_PREFIX + clientId); }
  catch { return null; }
  if (!row || !row.value) return null;
  const hit = _cache.get(clientId);
  if (hit && hit.updated_at === row.updated_at) return hit.tables;
  try {
    const tables = JSON.parse(row.value).tables || null;
    _cache.set(clientId, { updated_at: row.updated_at, tables });
    return tables;
  } catch { return null; }
}

/**
 * A sender's integer for `table`, read through the sender's own numbering.
 *   undefined → the sender has published no numbering (cannot tell)
 *   null      → it has, and that number is not in it
 *   string    → the uuid that number meant on the sender
 */
function uuidThroughNumbering(db, senderClientId, table, id) {
  const tables = readNumbering(db, senderClientId);
  if (!tables) return undefined;
  const m = tables[table];
  if (!m) return undefined;
  return m[String(id)] ?? null;
}

function _resetCacheForTest() { _cache.clear(); }

module.exports = { KEY_PREFIX, NUMBERED_TABLES, buildNumbering, publishNumbering, readNumbering, uuidThroughNumbering, _resetCacheForTest };
