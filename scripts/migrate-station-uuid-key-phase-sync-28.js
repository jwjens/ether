'use strict';
// Migration v28 — station UUID re-key (v4.5.0), Phase 0 (ADDITIVE, non-switching).
//
// Adds a `station_uuid TEXT` column to EVERY station-scoped table (any table that has a `station_id`
// column), backfills it from stations.uuid via station_id, and indexes it. This is the persistence
// half of the re-key foundation: it does NOT change any query — scoped queries still filter by integer
// station_id until Phase 3. Dual-keyed transitional state; station_id is retained (Decision 2A: it stays
// as a private DB PK/join key, never exposed above persistence).
//
// Robust by construction: it derives the scoped-table list from PRAGMA table_info (tables carrying
// station_id) rather than a hardcoded list, so it can't miss a table. Fully idempotent — re-running is a
// no-op. Verify on a COPY first: `node scripts/migrate-station-uuid-key-phase-sync-28.js <copy.db>`.

function scopedTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(r => r.name)
    .filter(t => db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === 'station_id'));
}
function hasCol(db, t, col) {
  return db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === col);
}

function isAlreadyMigrated(db) {
  // Migrated when a representative scoped table already carries station_uuid.
  const t = scopedTables(db)[0];
  return t ? hasCol(db, t, 'station_uuid') : false;
}

function applyMigration(db) {
  const migrate = db.transaction(() => {
    const tables = scopedTables(db);
    let added = 0, backfilled = 0;
    for (const t of tables) {
      if (!hasCol(db, t, 'station_uuid')) {
        db.prepare(`ALTER TABLE "${t}" ADD COLUMN station_uuid TEXT`).run();
        added++;
      }
      const r = db.prepare(
        `UPDATE "${t}" SET station_uuid = (SELECT uuid FROM stations WHERE stations.id = "${t}".station_id)
         WHERE station_uuid IS NULL AND station_id IS NOT NULL`
      ).run();
      backfilled += r.changes;
      db.prepare(`CREATE INDEX IF NOT EXISTS "idx_${t}_station_uuid" ON "${t}"(station_uuid)`).run();
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (28)').run(); } catch { /* already recorded */ }
    console.log(`[migrate-v28] station_uuid: +${added} columns, backfilled ${backfilled} rows across ${tables.length} scoped tables (${tables.join(', ')})`);
  });
  migrate();
  console.log('[migrate-v28] Transaction committed.');
}

module.exports = { applyMigration };

if (require.main === module) {
  const path = require('path');
  const os = require('os');
  // Resolve the DB the SAME way the app does (LocalAppData, NOT Roaming). Accept an explicit path as
  // argv[2] so this runs against a COPY for verification (per standing rules — never the live DB).
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  console.log('=== migrate-station-uuid-key-phase-sync-28.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op)' : '');
  applyMigration(db);
  // Verification readout: show a sample of tables with their station_id vs station_uuid coverage.
  const tables = scopedTables(db);
  console.log('--- verification (rows with station_uuid / total, per scoped table) ---');
  for (const t of tables) {
    try {
      const tot = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n;
      const withU = db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE station_uuid IS NOT NULL`).get().n;
      const orphan = db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE station_id IS NOT NULL AND station_uuid IS NULL`).get().n;
      console.log(`  ${t}: ${withU}/${tot} have station_uuid${orphan ? `  ⚠ ${orphan} station_id rows unresolved` : ''}`);
    } catch (e) { console.log(`  ${t}: (readout failed: ${e.message})`); }
  }
  db.close();
}
