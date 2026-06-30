'use strict';
// Migration v24: spot categories — a first-class, PER-STATION grouping for spots
// (e.g. "Top-of-Hour IDs", "Local Sponsors", "Ad Campaign", "Marketing"). Each spot can belong to
// one spot_category; the station timed-break grid assigns a category per break time and the
// generator auto-fills each break by rotating that category.
//
// Adds:
//   • spot_categories table — per-station, soft-deletable, synced (station_id scopes it; each
//     station gets its own independent set, and names are reusable across stations).
//   • spots.spot_category_id column — which category a spot belongs to (NULL = uncategorized).
//   • partial unique index on (name, station_id) WHERE deleted_at IS NULL — names unique WITHIN a
//     station, reusable again after a soft-delete (mirrors the per-station categories pattern, v23).
//
// Idempotent: if spot_categories already exists, just records v24 and returns.

function isAlreadyMigrated(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spot_categories'").get();
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (24)').run(); } catch (e) { /* already recorded */ }
    console.log('[migrate-v24] SKIP — spot_categories already exists');
    return;
  }
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE spot_categories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        color       TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        station_id  INTEGER,
        uuid        TEXT,
        created_at  TEXT,
        updated_at  TEXT,
        deleted_at  TEXT
      )
    `).run();
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_spot_categories_name_station ON spot_categories(name, station_id) WHERE deleted_at IS NULL').run();
    // spots.spot_category_id — which spot category each spot belongs to (NULL = uncategorized).
    const spotsCols = db.prepare('PRAGMA table_info(spots)').all().map(c => c.name);
    if (!spotsCols.includes('spot_category_id')) {
      db.prepare('ALTER TABLE spots ADD COLUMN spot_category_id INTEGER').run();
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (24)').run();
  });
  migrate();
  console.log('[migrate-v24] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — spot_categories is brand new (no older payloads to transform), and the new
    // spots.spot_category_id simply defaults to NULL on any payload that predates it.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path   = require('path');
  const os     = require('os');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-spot-categories-phase-sync-24.js ===');
  console.log('DB:', dbPath);

  // ── Pre-flight 1: schema_version must be 23 ───────────────────
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', currentVersion);
  if (currentVersion !== 23) {
    console.error('ABORT: expected schema_version 23, got', currentVersion);
    process.exit(1);
  }

  // ── Pre-flight 2: spot_categories must not already exist ──────
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spot_categories'").get();
  if (existing) {
    console.log('INFO: spot_categories already exists — migration already applied, exiting cleanly.');
    process.exit(0);
  }

  // ── Atomic transaction ─────────────────────────────────────────
  applyMigration(db);

  // ── Post-verification ──────────────────────────────────────────
  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!pass) allPass = false;
  };

  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 24', newVersion === 24, `got ${newVersion}`);

  const tableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='spot_categories'").get();
  check('spot_categories table exists', tableExists);

  const cols = db.prepare('PRAGMA table_info(spot_categories)').all().map(r => r.name);
  for (const col of ['id', 'name', 'color', 'sort_order', 'station_id', 'uuid', 'created_at', 'updated_at', 'deleted_at']) {
    check(`column ${col} exists`, cols.includes(col), cols.join(', '));
  }

  const idxExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_spot_categories_name_station'").get();
  check('idx_spot_categories_name_station index exists', idxExists);

  const spotsCols = db.prepare('PRAGMA table_info(spots)').all().map(r => r.name);
  check('spots.spot_category_id column exists', spotsCols.includes('spot_category_id'), spotsCols.join(', '));

  const rowCount = db.prepare('SELECT COUNT(*) as c FROM spot_categories').get().c;
  check('spot_categories is empty', rowCount === 0, `rows: ${rowCount}`);

  db.close();

  if (!allPass) {
    console.error('\nOne or more post-verification checks FAILED.');
    process.exit(1);
  }
  console.log('\nAll checks PASSED — migration v24 complete.');
}
