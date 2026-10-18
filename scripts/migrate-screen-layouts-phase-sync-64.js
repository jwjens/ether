'use strict';
// Migration v64 — screen_layouts: a built surface saved as data (docs/screen-builder-design-2026-10-18.md §2.5;
// Jeff's decision 3, 2026-10-18: a synced table, per station plus per user profile).
//
// One row = one layout of one station:
//   uuid             the layout's identity (a pop-out window and its machine-local bounds are keyed by it)
//   station_id       this install's local station id — the sync engine's station scope (remapped per install by
//                    merge-engine, like every station-scoped table)
//   station_uuid     the station's uuid — the layout's station by identity (decision 1: one station per layout)
//   owner_user_uuid  an in-app user profile's uuid, or NULL = the station's shared layout (profiles are in-app
//                    preferences, not the account — CLAUDE.md)
//   name             what the operator called it
//   payload          versioned JSON: { v: 1, dockview: <dockview toJSON()>, panes: { <panelId>: { type, instanceId, options } } }
//   version          the payload format version (1)
//   created_at / updated_at / deleted_at   the usual sync columns (ISO text, like the other synced tables)
//
// Machine-local, NOT here: which monitor a surface window opens on and its size (popout-bounds.json, keyed by panel).
//
// SHAPE: additive and idempotent — one new table (CREATE TABLE IF NOT EXISTS) and its two indexes. No data is touched.
// SYNC NOTE (as v62/v63): a mutation stamped v64 is quarantined by a pre-v64 peer (merge-engine.js) until it
// upgrades. Ship v64 to the whole fleet together.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-screen-layouts-phase-sync-64.js <copy.db>

const VERSION = 64;

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS screen_layouts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid             TEXT NOT NULL UNIQUE,
  station_id       INTEGER NOT NULL DEFAULT 1,
  station_uuid     TEXT,
  owner_user_uuid  TEXT,
  name             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT,
  updated_at       TEXT,
  deleted_at       TEXT
)`;
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_screen_layouts_station ON screen_layouts (station_id, deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_screen_layouts_station_uuid ON screen_layouts (station_uuid)',
];

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);
  const migrate = db.transaction(() => {
    db.prepare(TABLE_DDL).run();
    for (const sql of INDEXES) db.prepare(sql).run();
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();
  console.log(`[migrate-v64] screen_layouts ${already ? 'checked' : 'added'}`);
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // ADDS NOTHING (the v62 lesson): a pre-v64 peer has no screen_layouts rows to send, and no other table changed.
    // A transformer must still exist: the chain dead-letters a version with no script.
    return payload;
  },
  applyMigration,
  _test: { TABLE_DDL, INDEXES },
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-screen-layouts-phase-sync-64.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
