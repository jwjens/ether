'use strict';
// Migration v67 — users join sync (Jeff, 2026-10-20: "add users to sync as planned (same name + same station = one
// person)"). docs/ovevents-categories-and-users-sync-2026-10-20.md.
//
// The users table (Preferences → Users & Security) never synced: it was not in electron/sync/synced-tables.js and had no
// identity or change columns, so a user added on one computer never reached another. This adds what sync needs:
//   uuid        stable identity across computers (backfilled for every existing user)
//   created_at / updated_at   (backfilled to now) — updated_at decides which PIN wins when two computers merge a person
//   deleted_at  a removed user is a soft delete, so the removal travels too
// plus a unique index on uuid.
//
// SYNC: no users change has ever been journaled (the table was not registered), so no older payload exists to transform.
// Additive and idempotent — each column guarded by a check, no table rewrite.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-users-sync-phase-sync-67.js <copy.db>

const crypto = require('crypto');
const TABLE = 'users';
const VERSION = 67;
const COLUMNS = [
  { name: 'uuid', ddl: 'TEXT' },
  { name: 'created_at', ddl: 'TEXT' },
  { name: 'updated_at', ddl: 'TEXT' },
  { name: 'deleted_at', ddl: 'TEXT' },
];

function applyMigration(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)) {
    if (!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION)) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
    console.log('[migrate-v67] no users table — nothing to do');
    return;
  }
  const have = new Set(db.prepare(`PRAGMA table_info(${TABLE})`).all().map(c => c.name));
  const now = new Date().toISOString();
  let added = 0, backfilled = 0;
  db.transaction(() => {
    for (const c of COLUMNS) if (!have.has(c.name)) { db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN ${c.name} ${c.ddl}`).run(); added++; }
    for (const u of db.prepare(`SELECT id FROM ${TABLE} WHERE uuid IS NULL OR uuid = ''`).all()) {
      db.prepare(`UPDATE ${TABLE} SET uuid = ? WHERE id = ?`).run(crypto.randomUUID(), u.id); backfilled++;
    }
    db.prepare(`UPDATE ${TABLE} SET created_at = COALESCE(created_at, ?), updated_at = COALESCE(updated_at, ?)`).run(now, now);
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uuid ON ${TABLE}(uuid)`).run();
    if (!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION)) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  })();
  console.log(`[migrate-v67] users: +${added} column(s), ${backfilled} uuid(s) backfilled, idx_users_uuid`);
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // ADDS NOTHING: no users payload predates v67 (the table was never journaled). The chain still needs a script.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  try { applyMigration(db); } finally { db.close(); }
}
