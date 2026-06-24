'use strict';
// Migration v23: category codes are unique PER STATION, not globally.
//
// The categories table shipped with `code TEXT NOT NULL UNIQUE` — a GLOBAL unique constraint.
// On a multi-station install that's wrong: each station should be able to reuse the same
// category codes (POW, GLD, MO, ...). The global constraint made "create category" fail with
// "UNIQUE constraint failed: categories.code" the moment a SECOND station reused any code that
// already existed on another station — silently blocking category creation on new stations.
//
// Fix: rebuild `categories` with `code TEXT NOT NULL` (no global unique) plus a PARTIAL unique
// index on (code, station_id) WHERE deleted_at IS NULL — so codes are unique WITHIN a station,
// and a code becomes reusable again after a soft-delete. Data is fully preserved (same ids).
//
// Idempotent: skips the rebuild if the table is already per-station (e.g. an install that was
// hand-fixed), and still records v23 so the chain stays contiguous.

function isAlreadyMigrated(db) {
  const idx = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_categories_code_station'"
  ).get();
  const tbl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='categories'").get();
  const stillGlobalUnique = !!tbl && /code\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tbl.sql);
  return !!idx && !stillGlobalUnique;
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (23)').run(); } catch (e) { /* already recorded */ }
    console.log('[migrate-v23] SKIP — categories.code already unique per-station');
    return;
  }
  // PRAGMA foreign_keys cannot toggle inside a transaction — do it around the rebuild.
  const fkPrev = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE categories_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      spins_per_hour INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      station_id INTEGER NOT NULL DEFAULT 1,
      uuid TEXT,
      created_at TEXT, updated_at TEXT, deleted_at TEXT)`);
    db.exec(`INSERT INTO categories_new (id,code,name,color,spins_per_hour,priority,station_id,uuid,created_at,updated_at,deleted_at)
             SELECT id,code,name,color,spins_per_hour,priority,station_id,uuid,created_at,updated_at,deleted_at FROM categories`);
    db.exec('DROP TABLE categories');
    db.exec('ALTER TABLE categories_new RENAME TO categories');
    db.exec('CREATE UNIQUE INDEX idx_categories_uuid ON categories(uuid)');
    db.exec('CREATE UNIQUE INDEX idx_categories_code_station ON categories(code, station_id) WHERE deleted_at IS NULL');
    db.prepare('INSERT INTO schema_version (version) VALUES (23)').run();
  });
  migrate();
  db.pragma(`foreign_keys = ${fkPrev ? 'ON' : 'OFF'}`);
  console.log('[migrate-v23] categories.code now unique per-station (partial index on code, station_id)');
}

module.exports = {
  // Constraint-only migration — the synced categories payload shape is unchanged.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  // Resolve the DB the SAME way the app does — LocalAppData on Windows, NOT Roaming (see CLAUDE.md).
  const base = (process.platform === 'win32' && process.env.LOCALAPPDATA)
    ? path.join(process.env.LOCALAPPDATA, 'Ether', 'com.ether.radio')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'com.ether.radio');
  const dbPath = path.join(base, 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  console.log('=== migrate-categories-code-per-station-phase-sync-23.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  console.log('Done.');
}
