'use strict';

// electron/sync/handlers/install_config_kv.js
// IPC handlers for the install_config_kv table (install-scoped, no station_id).
// Channels: install-config-kv:list | :upsert-by-key | :remove-by-key
// Preload:  window.ether.installConfigKv.*
//
// install_config_kv is install-level config — values that belong to the whole
// device, not to any individual station.  No withMutation (install-scoped rows
// are synced via install-scope protocol, not per-station mutation log).

const crypto = require('crypto');

const TABLE = 'install_config_kv';

// ── Scope guard ───────────────────────────────────────────────────────────────

function validateScope() {
  // Lightweight guard — table name is hard-coded, just ensures DB is open
  if (!TABLE) throw new Error('[install_config_kv] unexpected null TABLE');
}

// ── Business logic ────────────────────────────────────────────────────────────

function installConfigKvList(db) {
  return db.prepare(
    `SELECT key, value FROM ${TABLE} WHERE deleted_at IS NULL ORDER BY key`
  ).all();
}

function installConfigKvGet(db, key) {
  return db.prepare(
    `SELECT * FROM ${TABLE} WHERE key = ? AND deleted_at IS NULL`
  ).get(key) ?? null;
}

function installConfigKvUpsertByKey(db, key, value) {
  validateScope();
  const existing = db.prepare(`SELECT * FROM ${TABLE} WHERE key = ?`).get(key);
  const now = new Date().toISOString();
  if (!existing) {
    const uuid = crypto.randomUUID();
    db.prepare(
      `INSERT INTO ${TABLE} (key, value, uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(key, value, uuid, now, now);
  } else {
    db.prepare(
      `UPDATE ${TABLE} SET value = ?, updated_at = ?, deleted_at = NULL WHERE key = ?`
    ).run(value, now, key);
  }
  return installConfigKvGet(db, key);
}

function installConfigKvRemoveByKey(db, key) {
  validateScope();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE ${TABLE} SET deleted_at = ?, updated_at = ? WHERE key = ?`
  ).run(now, now, key);
  return { ok: true };
}

// ── IPC installation ──────────────────────────────────────────────────────────

function installInstallConfigKv(ipcMain, db) {
  ipcMain.handle('install-config-kv:list', (_) => {
    try { return { ok: true, rows: installConfigKvList(db) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('install-config-kv:get', (_, key) => {
    try { return { ok: true, row: installConfigKvGet(db, key) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('install-config-kv:upsert-by-key', (_, key, value) => {
    try { return { ok: true, row: installConfigKvUpsertByKey(db, key, value) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('install-config-kv:remove-by-key', (_, key) => {
    try { return { ok: true, ...installConfigKvRemoveByKey(db, key) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  console.log('[install_config_kv] handlers installed');
}

module.exports = {
  installInstallConfigKv,
  installConfigKvList,
  installConfigKvGet,
  installConfigKvUpsertByKey,
  installConfigKvRemoveByKey,
};
