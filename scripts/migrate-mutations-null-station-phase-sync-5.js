'use strict';

// scripts/migrate-mutations-null-station-phase-sync-5.js — Phase Sync-5
//
// Run with: npx electron scripts\migrate-mutations-null-station-phase-sync-5.js
// IMPORTANT: Stop the Ether app before running.
//
// What it does (single atomic transaction):
//   1. Backs up openair.db to openair.db.pre-v5.<timestamp>.bak
//   2. Pre-flight: schema_version must be [1,2,3,4]; station_id must be NOT NULL
//   3. Transaction:
//        a. CREATE TABLE mutations_new (station_id TEXT — NOT NULL removed)
//        b. INSERT INTO mutations_new SELECT * FROM mutations
//        c. Row count preservation check (throws inside txn if mismatch)
//        d. DROP TABLE mutations (drops all 5 indexes automatically)
//        e. ALTER TABLE mutations_new RENAME TO mutations
//        f. Recreate 5 indexes (copied verbatim from migrate-mutations-phase-sync-3.js)
//        g. INSERT version=5 into schema_version
//   4. Post-migration verification

// payloadTransformer: identity. v5 changes only the schema constraint, not any
// payload fields. Receivers apply no field transforms when upgrading from v4.
module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    if (!payload || typeof payload !== 'object') return payload;
    return payload;
  },
};

// ── Migration body ────────────────────────────────────────────

if (require.main === module) {

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');

if (!fs.existsSync(dbPath)) {
  console.error('[migrate-v5] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));

// ── Helpers ───────────────────────────────────────────────────

function abort(db, msg) {
  console.error('[migrate-v5] ABORT:', msg);
  try { db.close(); } catch (_) {}
  process.exit(1);
}

// ── Backup ────────────────────────────────────────────────────

// Produces: YYYYMMDD-HHmmss  e.g. 20260426-131049
const datestamp = new Date().toISOString()
  .replace('T', '-')
  .replace(/:/g, '')
  .replace(/\..+Z$/, '')
  .replace(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/, '$1$2$3-$4$5$6');
const bakPath = dbPath + '.pre-v5.' + datestamp + '.bak';
console.log('[migrate-v5] Backing up DB to:', bakPath);
fs.copyFileSync(dbPath, bakPath);
console.log('[migrate-v5] Backup created ✓');
console.log('');

// ── Open DB ───────────────────────────────────────────────────

const db = new Database(dbPath, { timeout: 10000 });

// ── Pre-flight check 1: schema_version ───────────────────────

console.log('═'.repeat(60));
console.log('PRE-FLIGHT CHECKS');
console.log('═'.repeat(60));

const svVersions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log('[migrate-v5] schema_version rows:', JSON.stringify(svVersions));

if (svVersions.includes(5)) {
  abort(db, 'v5 already applied — schema_version contains 5. Nothing to do.');
}
if (svVersions.length !== 4 || !([1,2,3,4].every((v,i) => svVersions[i] === v))) {
  abort(db, `expected schema_version = [1,2,3,4], got ${JSON.stringify(svVersions)}. Ensure migrations 1-4 have run.`);
}
console.log('[migrate-v5] Pre-flight 1: schema_version = [1,2,3,4] ✓');

// ── Pre-flight check 2: station_id is currently NOT NULL ──────
// Belt-and-suspenders: if notnull=0, schema is already nullable.
// This catches the case where the schema was changed but version=5 was not written.

const mutCols = db.prepare("PRAGMA table_info('mutations')").all();
const stationIdCol = mutCols.find(c => c.name === 'station_id');
if (!stationIdCol) {
  abort(db, 'mutations.station_id column not found — unexpected schema state');
}
console.log('[migrate-v5] mutations.station_id notnull =', stationIdCol.notnull, '(1 = NOT NULL)');
if (stationIdCol.notnull === 0) {
  abort(db, 'mutations.station_id is already nullable — schema already patched. version marker may be inconsistent; check schema_version table.');
}
console.log('[migrate-v5] Pre-flight 2: station_id is NOT NULL (as expected for v4) ✓');

// ── Pre-migration row count ───────────────────────────────────

const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
console.log('[migrate-v5] mutations row count before migration:', beforeCount);
console.log('');

// ── Atomic migration transaction ──────────────────────────────

console.log('═'.repeat(60));
console.log('RUNNING MIGRATION');
console.log('═'.repeat(60));
console.log('');

db.transaction(() => {

  // Step 1: CREATE mutations_new with station_id TEXT (NOT NULL removed)
  console.log('[migrate-v5] Step 1: CREATE TABLE mutations_new');
  db.prepare(`
    CREATE TABLE mutations_new (
      id                   TEXT PRIMARY KEY NOT NULL,
      client_id            TEXT NOT NULL,
      station_id           TEXT,
      actor_id             TEXT,
      table_name           TEXT NOT NULL,
      row_id               TEXT NOT NULL,
      op                   TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete', 'checkpoint')),
      payload_before       TEXT,
      payload_after        TEXT,
      created_at           TEXT NOT NULL,
      applied_at           TEXT NOT NULL,
      hlc                  TEXT NOT NULL,
      parent_mutation_id   TEXT,
      schema_version       INTEGER NOT NULL,
      origin               TEXT NOT NULL CHECK (origin IN ('local', 'remote', 'system', 'migration')),
      sync_status          TEXT NOT NULL CHECK (sync_status IN ('pending', 'syncing', 'synced', 'conflicted')),
      conflict_resolution  TEXT
    )
  `).run();
  console.log('[migrate-v5] Step 1: mutations_new created ✓');

  // Step 2: Copy all rows
  console.log('[migrate-v5] Step 2: INSERT INTO mutations_new SELECT * FROM mutations');
  db.prepare('INSERT INTO mutations_new SELECT * FROM mutations').run();
  console.log('[migrate-v5] Step 2: rows copied ✓');

  // Step 3: Row count preservation check (inside transaction — throws and rolls back on mismatch)
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM mutations_new').get().n;
  console.log('[migrate-v5] Step 3: row count before =', beforeCount, '| row count after =', afterCount);
  if (beforeCount !== afterCount) {
    throw new Error(
      `[migrate-v5] Row count mismatch: before=${beforeCount} after=${afterCount}. Transaction rolled back.`
    );
  }
  console.log('[migrate-v5] Step 3: row count preserved ✓');

  // Step 4: DROP old table (drops all 5 indexes automatically)
  console.log('[migrate-v5] Step 4: DROP TABLE mutations');
  db.prepare('DROP TABLE mutations').run();
  console.log('[migrate-v5] Step 4: mutations dropped ✓');

  // Step 5: RENAME mutations_new → mutations
  console.log('[migrate-v5] Step 5: ALTER TABLE mutations_new RENAME TO mutations');
  db.prepare('ALTER TABLE mutations_new RENAME TO mutations').run();
  console.log('[migrate-v5] Step 5: rename complete ✓');

  // Step 6: Recreate 5 indexes
  // Indexes copied from migrate-mutations-phase-sync-3.js to preserve original definitions
  console.log('[migrate-v5] Step 6: recreate indexes');
  db.prepare("CREATE INDEX idx_mutations_table_row_hlc    ON mutations (table_name, row_id, hlc)").run();
  console.log('[migrate-v5] Step 6: idx_mutations_table_row_hlc ✓');
  db.prepare("CREATE INDEX idx_mutations_client_hlc       ON mutations (client_id, hlc)").run();
  console.log('[migrate-v5] Step 6: idx_mutations_client_hlc ✓');
  db.prepare("CREATE INDEX idx_mutations_station_created  ON mutations (station_id, created_at)").run();
  console.log('[migrate-v5] Step 6: idx_mutations_station_created ✓');
  db.prepare("CREATE INDEX idx_mutations_sync_status      ON mutations (sync_status)").run();
  console.log('[migrate-v5] Step 6: idx_mutations_sync_status ✓');
  db.prepare("CREATE INDEX idx_mutations_created          ON mutations (created_at)").run();
  console.log('[migrate-v5] Step 6: idx_mutations_created ✓');

  // Step 7: Record schema version
  console.log('[migrate-v5] Step 7: INSERT version=5 into schema_version');
  db.prepare("INSERT INTO schema_version (version) VALUES (5)").run();
  console.log('[migrate-v5] Step 7: schema_version=5 written ✓');

})();

// ── Post-migration verification ───────────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log('POST-MIGRATION VERIFICATION');
console.log('═'.repeat(60));

let allOk = true;
function verify(label, ok, detail) {
  if (ok) { console.log('  PASS  ' + label); }
  else     { console.error('  FAIL  ' + label + (detail ? ' — ' + detail : '')); allOk = false; }
}

// Row count (final)
const finalCount = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
console.log('[migrate-v5] Final mutations row count:', finalCount);
verify('Row count preserved', finalCount === beforeCount, `expected ${beforeCount} got ${finalCount}`);

// station_id is now nullable
const newCols = db.prepare("PRAGMA table_info('mutations')").all();
const newStationIdCol = newCols.find(c => c.name === 'station_id');
verify('station_id notnull = 0 (nullable)', newStationIdCol && newStationIdCol.notnull === 0);

// All 5 indexes exist
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mutations'").all().map(r => r.name);
const EXPECTED_INDEXES = [
  'idx_mutations_table_row_hlc',
  'idx_mutations_client_hlc',
  'idx_mutations_station_created',
  'idx_mutations_sync_status',
  'idx_mutations_created',
];
for (const idx of EXPECTED_INDEXES) {
  verify(`index exists: ${idx}`, indexes.includes(idx));
}

// schema_version contains [1,2,3,4,5]
const newSv = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
verify('schema_version = [1,2,3,4,5]', JSON.stringify(newSv) === '[1,2,3,4,5]', `got ${JSON.stringify(newSv)}`);

console.log('');
if (allOk) {
  console.log('v5 migration COMPLETE ✓');
  console.log('mutations.station_id is now nullable. Install-scoped handlers may pass null.');
} else {
  console.error('One or more post-migration checks FAILED. DB backup preserved at:', bakPath);
}

db.close();
process.exit(allOk ? 0 : 1);

} // end if (require.main === module)
