'use strict';

// electron/sync/handlers/users.js — the in-app users (Preferences → Users & Security) as a SYNCED table (v67; Jeff,
// 2026-10-20: "switch PINs to a slow hash first, then add users to sync as planned (same name + same station = one
// person)"). Hand-written: PINs are hashed here, in main (electron/pin-hash.js), and the same-person merge lives here.
//
// Channels (window.ether.users.*): user:add | user:update | user:set-pin | user:remove — every write journaled through
// withMutation, so it reaches every computer on the account. A removal is a soft delete (deleted_at), so it travels.
//
// SAME NAME + SAME STATION = ONE PERSON (mergeSamePerson). When two live users share a station and a name (trimmed,
// any case) — a person added on both computers before users synced — the one with the smaller uuid is kept on every
// computer (the same answer everywhere, with no coordination); it takes the role, colour and PIN of whichever of them
// was changed most recently; the other is removed. Both writes are journaled, so the computers agree.

const crypto = require('crypto');
const { withMutation, serializePayload } = require('../mutation-writer');
const PinHash = require('../../pin-hash');

const TABLE = 'users';
const live = "deleted_at IS NULL";

function _row(db, where, ...args) { return db.prepare(`SELECT * FROM ${TABLE} WHERE ${where}`).get(...args) || null; }

function _update(db, before, patch) {
  const now = new Date().toISOString();
  const after = { ...before, ...patch, updated_at: now };
  withMutation(db, {
    table_name: TABLE, row_id: before.uuid, op: 'update',
    payload_before: serializePayload(before, TABLE), payload_after: serializePayload(after, TABLE),
    station_id: before.station_id,
  }, () => {
    const cols = Object.keys(patch);
    db.prepare(`UPDATE ${TABLE} SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE uuid = ?`).run(...cols.map(c => patch[c]), now, before.uuid);
  });
  return _row(db, 'uuid = ?', before.uuid);
}

async function userAdd(db, { name, role, pin, color, station_id }) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('a user needs a name');
  if (station_id == null) throw new Error('station_id is required');
  if (pin != null && pin !== '' && !/^\d{4}$/.test(String(pin))) throw new Error('PIN must be exactly 4 digits');
  const pin_hash = pin ? await PinHash.hashPin(String(pin)) : null;
  const now = new Date().toISOString();
  const row = { name: clean, role: role || 'jock', pin_hash, color: color || '#22d3ee', station_id, uuid: crypto.randomUUID(), created_at: now, updated_at: now, deleted_at: null };
  withMutation(db, {
    table_name: TABLE, row_id: row.uuid, op: 'insert', payload_before: null, payload_after: serializePayload(row, TABLE),
    station_id,
  }, () => {
    db.prepare(`INSERT INTO ${TABLE} (name, role, pin_hash, color, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(row.name, row.role, row.pin_hash, row.color, row.station_id, row.uuid, row.created_at, row.updated_at);
  });
  return _row(db, 'uuid = ?', row.uuid);
}

function userUpdate(db, id, { name, role, color }) {
  const before = _row(db, `id = ? AND ${live}`, id);
  if (!before) throw new Error(`no user ${id}`);
  const patch = {};
  if (name != null) { const n = String(name).trim(); if (!n) throw new Error('a user needs a name'); patch.name = n; }
  if (role != null) patch.role = role;
  if (color != null) patch.color = color;
  return Object.keys(patch).length ? _update(db, before, patch) : before;
}

async function userSetPin(db, id, pin) {
  const before = _row(db, `id = ? AND ${live}`, id);
  if (!before) throw new Error(`no user ${id}`);
  if (pin != null && pin !== '' && !/^\d{4}$/.test(String(pin))) throw new Error('PIN must be exactly 4 digits');
  return _update(db, before, { pin_hash: pin ? await PinHash.hashPin(String(pin)) : null });
}

/** Store an already-computed hash (the scrypt upgrade of a PIN just verified). */
function userStorePinHash(db, id, pinHash) {
  const before = _row(db, `id = ? AND ${live}`, id);
  if (!before) return null;
  return _update(db, before, { pin_hash: pinHash });
}

function userRemove(db, id) {
  const before = _row(db, `id = ? AND ${live}`, id);
  if (!before) return false;
  if (before.role === 'admin') {
    const admins = db.prepare(`SELECT COUNT(*) n FROM ${TABLE} WHERE role = 'admin' AND ${live}`).get().n;
    if (admins <= 1) throw new Error('Cannot delete the last administrator.');
  }
  _update(db, before, { deleted_at: new Date().toISOString() });
  return true;
}

/** Same name + same station = one person. → [{ kept, removed, name, station_id }] */
function mergeSamePerson(db) {
  const out = [];
  const groups = new Map();
  for (const u of db.prepare(`SELECT * FROM ${TABLE} WHERE ${live} AND uuid IS NOT NULL`).all()) {
    const k = `${u.station_id}|${String(u.name || '').trim().toLowerCase()}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.uuid).localeCompare(String(b.uuid)));
    const keep = list[0];
    const newest = list.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
    db.transaction(() => {
      const patch = {};
      for (const c of ['role', 'color', 'pin_hash']) if (newest[c] !== keep[c]) patch[c] = newest[c];
      if (Object.keys(patch).length) _update(db, keep, patch);
      for (const u of list.slice(1)) {
        _update(db, u, { deleted_at: new Date().toISOString() });
        out.push({ kept: keep.uuid, removed: u.uuid, name: keep.name, station_id: keep.station_id, took: newest.uuid === keep.uuid ? 'its own' : `the newer one's (${Object.keys(patch).join(', ') || 'nothing different'})` });
      }
    })();
  }
  return out;
}

function installUsers(ipcMain, db) {
  const d = () => (typeof db === 'function' ? db() : db);
  ipcMain.handle('user:add', async (_e, payload) => { try { return { ok: true, user: await userAdd(d(), payload || {}) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('user:update', (_e, id, patch) => { try { return { ok: true, user: userUpdate(d(), id, patch || {}) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('user:set-pin', async (_e, id, pin) => { try { return { ok: true, user: await userSetPin(d(), id, pin) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('user:remove', (_e, id) => { try { return { ok: userRemove(d(), id) }; } catch (e) { return { ok: false, error: e.message }; } });
}

module.exports = { installUsers, userAdd, userUpdate, userSetPin, userStorePinHash, userRemove, mergeSamePerson };
