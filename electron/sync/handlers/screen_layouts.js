'use strict';

// electron/sync/handlers/screen_layouts.js — the built-surface layouts (v64; docs/screen-builder-design-2026-10-18.md
// §2.5, Jeff's decision 3). Station-scoped and synced: every write goes through withMutation, so a layout follows its
// station to every computer on the account.
//
// Channels (window.ether.invoke — the generic bridge is enough):
//   screen_layouts:list   (stationId, ownerUserUuid)  → { ok, rows }   the station's shared layouts + this user's own
//   screen_layouts:get    (uuid, stationId)           → { ok, row }    null when it is another station's (S7)
//   screen_layouts:save   (layout)                    → { ok, row }    create (no uuid / unknown uuid) or update
//   screen_layouts:delete (uuid, stationId)           → { ok }         soft delete
//
// Hand-written (not generated): its list is per owner and its save is an upsert. Shape kept close to the generated
// handlers (see prep_notes.js).

const crypto = require('crypto');
const { REGISTRY } = require('../synced-tables');

const TABLE = 'screen_layouts';

function validateScope() {
  const entry = REGISTRY[TABLE];
  if (!entry) throw new Error(`[screen_layouts] unknown table in registry: "${TABLE}"`);
  if (entry.scope !== 'station') throw new Error(`[screen_layouts] expected station-scoped table, registry has "${entry.scope}"`);
}

/** A payload must be the versioned layout document (the renderer's src/modules/layoutPayload.ts). */
function checkPayload(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('[screen_layouts] payload is not JSON'); }
  if (!doc || doc.v !== 1 || typeof doc.panes !== 'object' || doc.dockview == null) {
    throw new Error('[screen_layouts] payload is not a v1 layout { v: 1, dockview, panes }');
  }
  return text;
}

/**
 * The layout API over a database. `write(db, mutation, fn)` is withMutation in the app (the mutation log is the sync
 * path); the tests pass a recorder.
 */
function createScreenLayoutsApi(write) {
  const get = (db, uuid, stationId) => {
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ? AND deleted_at IS NULL`).get(uuid) ?? null;
    if (row && stationId != null && row.station_id !== stationId) return null;   // another station's layout: never read
    return row;
  };

  const list = (db, stationId, ownerUserUuid) => {
    if (stationId == null) throw new Error('[screen_layouts] list needs a station');
    return db.prepare(
      `SELECT * FROM ${TABLE} WHERE station_id = ? AND deleted_at IS NULL
         AND (owner_user_uuid IS NULL OR owner_user_uuid = ?) ORDER BY name COLLATE NOCASE, id`
    ).all(stationId, ownerUserUuid ?? null);
  };

  const save = (db, layout) => {
    validateScope();
    if (!layout || layout.station_id == null) throw new Error('[screen_layouts] station_id is required');
    const name = String(layout.name || '').trim();
    if (!name) throw new Error('[screen_layouts] a layout needs a name');
    const payload = checkPayload(layout.payload);
    const now = new Date().toISOString();
    const existing = layout.uuid ? db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(layout.uuid) : null;
    if (existing && existing.station_id !== layout.station_id) throw new Error('[screen_layouts] that layout belongs to another station');

    if (!existing) {
      const row = {
        uuid: layout.uuid || crypto.randomUUID(), station_id: layout.station_id, station_uuid: layout.station_uuid ?? null,
        owner_user_uuid: layout.owner_user_uuid ?? null, name, payload, version: 1,
        created_at: now, updated_at: now, deleted_at: null,
      };
      write(db, { table_name: TABLE, row_id: row.uuid, op: 'insert', payload_before: null, payload_after: row,
        station_id: row.station_id, actor_id: layout.actor_id ?? null }, () => {
        db.prepare(`INSERT INTO ${TABLE} (uuid, station_id, station_uuid, owner_user_uuid, name, payload, version, created_at, updated_at, deleted_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(row.uuid, row.station_id, row.station_uuid, row.owner_user_uuid, row.name, row.payload, row.version, row.created_at, row.updated_at, row.deleted_at);
      });
      return get(db, row.uuid);
    }
    const updated = { ...existing, name, payload, updated_at: now, deleted_at: null };
    write(db, { table_name: TABLE, row_id: existing.uuid, op: 'update', payload_before: existing, payload_after: updated,
      station_id: existing.station_id, actor_id: layout.actor_id ?? null }, () => {
      db.prepare(`UPDATE ${TABLE} SET name = ?, payload = ?, updated_at = ?, deleted_at = NULL WHERE uuid = ?`)
        .run(name, payload, now, existing.uuid);
    });
    return get(db, existing.uuid);
  };

  const remove = (db, uuid, stationId) => {
    validateScope();
    const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE uuid = ?`).get(uuid);
    if (!existing) return { ok: true };
    if (stationId != null && existing.station_id !== stationId) throw new Error('[screen_layouts] that layout belongs to another station');
    const now = new Date().toISOString();
    write(db, { table_name: TABLE, row_id: uuid, op: 'delete', payload_before: existing, payload_after: null,
      station_id: existing.station_id, actor_id: null }, () => {
      db.prepare(`UPDATE ${TABLE} SET deleted_at = ?, updated_at = ? WHERE uuid = ?`).run(now, now, uuid);
    });
    return { ok: true };
  };

  return { list, get, save, remove };
}

function installScreenLayouts(ipcMain, db) {
  const { withMutation, serializePayload } = require('../mutation-writer');
  const api = createScreenLayoutsApi((d, m, fn) => withMutation(d, {
    ...m,
    payload_before: m.payload_before ? serializePayload(m.payload_before, TABLE) : null,
    payload_after:  m.payload_after  ? serializePayload(m.payload_after,  TABLE) : null,
  }, fn));
  const getDb = (typeof db === 'function') ? db : () => db;
  const wrap = (fn) => (...a) => { try { return fn(...a); } catch (e) { return { ok: false, error: e.message }; } };
  ipcMain.handle('screen_layouts:list',   wrap((_, stationId, owner) => ({ ok: true, rows: api.list(getDb(), stationId, owner) })));
  ipcMain.handle('screen_layouts:get',    wrap((_, uuid, stationId) => ({ ok: true, row: api.get(getDb(), uuid, stationId) })));
  ipcMain.handle('screen_layouts:save',   wrap((_, layout) => ({ ok: true, row: api.save(getDb(), layout) })));
  ipcMain.handle('screen_layouts:delete', wrap((_, uuid, stationId) => api.remove(getDb(), uuid, stationId)));
}

module.exports = { installScreenLayouts, createScreenLayoutsApi, _test: { checkPayload } };
