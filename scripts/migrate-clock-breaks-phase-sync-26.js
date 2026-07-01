'use strict';
// Migration v26: clock_breaks — per-clock timed spot breaks (the "Timed Spot Breaks" grid,
// re-homed from Spots & Promos onto the CLOCK, since clocks are the master for spots).
//
// Each row is one break on one clock: air at `minute` past the hour, drop `count` spots pulled
// from `spot_category_id` (NULL = any active spot). Fully user-defined — the user types any
// minute (0-59), picks any spot category, sets any count. Nothing is hardcoded.
//
// Why a dedicated table (vs. columns on clock_slots): a timed break is a distinct per-clock
// concept anchored to a MINUTE, not an ordered slot in the sequential clock-slot list. A separate
// table keeps clock_slots' position semantics intact, gives clean sync refs (clock + spot_category),
// and leaves the existing spot_break slot behavior untouched (clean no-regression). Synced,
// station-scoped, soft-deletable — mirrors the spot_categories (v24) pattern.
//
// Idempotent: if clock_breaks already exists, just records v26 and returns.

function isAlreadyMigrated(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='clock_breaks'").get();
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (26)').run(); } catch (e) { /* already recorded */ }
    console.log('[migrate-v26] SKIP — clock_breaks already exists');
    return;
  }
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE clock_breaks (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        clock_id         INTEGER NOT NULL,
        minute           INTEGER NOT NULL DEFAULT 0,   -- 0..59: air this break at :minute past the hour
        spot_category_id INTEGER,                      -- FK -> spot_categories.id; NULL = any active spot
        count            INTEGER NOT NULL DEFAULT 1,   -- how many spots to drop, back-to-back
        sort_order       INTEGER NOT NULL DEFAULT 0,
        station_id       INTEGER,
        uuid             TEXT,
        created_at       TEXT,
        updated_at       TEXT,
        deleted_at       TEXT
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_clock_breaks_clock ON clock_breaks(clock_id) WHERE deleted_at IS NULL').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (26)').run();
  });
  migrate();
  console.log('[migrate-v26] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — clock_breaks is brand new (no older payloads to transform).
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  // Resolve the DB the SAME way the app does (LocalAppData, NOT Roaming). Accept an optional
  // explicit path as argv[2] so this can be run against a COPY for verification.
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-clock-breaks-phase-sync-26.js ===');
  console.log('DB:', dbPath);

  // ── Pre-flight 1: schema_version must be 25 ───────────────────
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', currentVersion);
  if (currentVersion !== 25) {
    console.error('ABORT: expected schema_version 25, got', currentVersion);
    process.exit(1);
  }

  // ── Pre-flight 2: table must not already exist ────────────────
  if (isAlreadyMigrated(db)) {
    console.log('INFO: clock_breaks already exists — migration already applied, exiting cleanly.');
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
  check('schema_version = 26', newVersion === 26, `got ${newVersion}`);

  const tableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clock_breaks'").get();
  check('clock_breaks table exists', tableExists);

  const cols = db.prepare('PRAGMA table_info(clock_breaks)').all().map(r => r.name);
  for (const col of ['id', 'clock_id', 'minute', 'spot_category_id', 'count', 'sort_order', 'station_id', 'uuid', 'created_at', 'updated_at', 'deleted_at']) {
    check(`column ${col} exists`, cols.includes(col), cols.join(', '));
  }

  const idxExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_clock_breaks_clock'").get();
  check('idx_clock_breaks_clock index exists', idxExists);

  const rowCount = db.prepare('SELECT COUNT(*) as c FROM clock_breaks').get().c;
  check('clock_breaks is empty', rowCount === 0, `rows: ${rowCount}`);

  db.close();

  if (!allPass) {
    console.error('\nOne or more post-verification checks FAILED.');
    process.exit(1);
  }
  console.log('\nAll checks PASSED — migration v26 complete.');
}
