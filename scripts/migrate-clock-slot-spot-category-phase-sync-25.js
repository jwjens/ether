'use strict';
// Migration v25: clock_slots.spot_category_id — clocks become the MASTER for spots.
//
// A clock slot has a TYPE (music / spot_break / …). A music slot pulls from a SONG category
// (clock_slots.category_id → categories.id). A spot-break slot now pulls from a SPOT category
// (clock_slots.spot_category_id → spot_categories.id, added in v24). One place — the clock designer —
// defines the whole hour, spots included; the generation-time break grid is retired.
//
// Adds:
//   • clock_slots.spot_category_id column — which spot category a spot-break slot pulls from
//     (NULL = any active spot; NOT required). The legacy clock_slots.spot_type column is left in
//     place (harmless) but is no longer written or read — there is deliberately no auto-map from
//     spot_type → spot_category (different concepts).
//
// Idempotent: if the column already exists, just records v25 and returns.

function isAlreadyMigrated(db) {
  return db.prepare('PRAGMA table_info(clock_slots)').all().some(c => c.name === 'spot_category_id');
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (25)').run(); } catch (e) { /* already recorded */ }
    console.log('[migrate-v25] SKIP — clock_slots.spot_category_id already exists');
    return;
  }
  const migrate = db.transaction(() => {
    // spot-break slots reference a spot category (spot_categories.id). NULL = any active spot.
    db.prepare('ALTER TABLE clock_slots ADD COLUMN spot_category_id INTEGER').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (25)').run();
  });
  migrate();
  console.log('[migrate-v25] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — spot_category_id is brand new on clock_slots; any payload that predates it simply
    // defaults to NULL (no spot category = any active spot).
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

  console.log('=== migrate-clock-slot-spot-category-phase-sync-25.js ===');
  console.log('DB:', dbPath);

  // ── Pre-flight 1: schema_version must be 24 ───────────────────
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', currentVersion);
  if (currentVersion !== 24) {
    console.error('ABORT: expected schema_version 24, got', currentVersion);
    process.exit(1);
  }

  // ── Pre-flight 2: column must not already exist ───────────────
  if (isAlreadyMigrated(db)) {
    console.log('INFO: clock_slots.spot_category_id already exists — migration already applied, exiting cleanly.');
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
  check('schema_version = 25', newVersion === 25, `got ${newVersion}`);

  const cols = db.prepare('PRAGMA table_info(clock_slots)').all().map(r => r.name);
  check('clock_slots.spot_category_id column exists', cols.includes('spot_category_id'), cols.join(', '));
  check('clock_slots.category_id still present (song category untouched)', cols.includes('category_id'));
  check('clock_slots.spot_type still present (legacy, harmless)', cols.includes('spot_type'));

  db.close();

  if (!allPass) {
    console.error('\nOne or more post-verification checks FAILED.');
    process.exit(1);
  }
  console.log('\nAll checks PASSED — migration v25 complete.');
}
