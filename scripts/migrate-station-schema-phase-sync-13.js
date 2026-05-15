'use strict';

// scripts/migrate-station-schema-phase-sync-13.js — Phase Sync-13
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-station-schema-phase-sync-13.js
// IMPORTANT: Stop the Ether app before running.
//
// What it does (single atomic transaction):
//   1. Backs up openair.db to openair.db.pre-v13.<timestamp>.bak
//   2. Pre-flight 1: schema_version must be exactly [1..12]; aborts if already v13
//   3. Pre-flight 2: eas_tests.station_id must NOT yet exist
//   4. Records pre-migration row counts for eas_tests
//   5. Transaction:
//        a. ALTER TABLE eas_tests ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1
//        b. CREATE INDEX IF NOT EXISTS idx_eas_tests_station_id ON eas_tests(station_id)
//        c. INSERT version=13 into schema_version
//   6. Post-migration verification:
//        - eas_tests.station_id present
//        - all existing rows have station_id = 1
//        - idx_eas_tests_station_id index exists
//        - eas_tests row count unchanged
//        - schema_version = [1..13]

// payloadTransformer: eas_tests is intentionally non-synced (local-only FCC log per
// machine). No payload transform is needed — this is a trivial identity function
// required by the pre-commit hook's migration-chain validator.
module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    return payload;
  },
};

// ── Migration body ────────────────────────────────────────────
// _isMain guard: required because Electron's bootstrapper owns require.main.

const _scriptArg = process.argv.slice(1).find(a => !a.startsWith('-'));
const _isMain = require.main === module ||
  (_scriptArg && require('path').resolve(_scriptArg) === __filename);
if (_isMain) {

const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');

if (!fs.existsSync(dbPath)) {
  console.error('[migrate-v13] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));

// ── Backup ────────────────────────────────────────────────────
const ts     = Date.now();
const bakPath = dbPath.replace(/\.db$/, `.db.pre-v13.${ts}.bak`);
fs.copyFileSync(dbPath, bakPath);
console.log(`[migrate-v13] Backup written: ${bakPath}`);

const db = new Database(dbPath);

try {

// ── Pre-flight 1: schema_version ─────────────────────────────
const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log('[migrate-v13] Current schema_version:', versions);

if (versions.includes(13)) {
  console.error('[migrate-v13] ERROR: version 13 already present — migration already applied. Aborting.');
  db.close(); process.exit(1);
}

const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const missing  = expected.filter(v => !versions.includes(v));
if (missing.length > 0) {
  console.error('[migrate-v13] ERROR: prerequisite versions missing:', missing, '— expected', expected);
  db.close(); process.exit(1);
}
console.log('[migrate-v13] Pre-flight 1 PASS — schema_version = [1..12]');

// ── Pre-flight 2: confirm station_id absent from eas_tests ───
const easCols = db.prepare('PRAGMA table_info(eas_tests)').all().map(r => r.name);

if (easCols.includes('station_id')) {
  console.error('[migrate-v13] ERROR: eas_tests.station_id already present — migration already applied?');
  db.close(); process.exit(1);
}
console.log('[migrate-v13] Pre-flight 2 PASS — eas_tests.station_id absent (expected)');

// ── Pre-migration row counts ──────────────────────────────────
const preEas  = db.prepare('SELECT COUNT(*) AS c FROM eas_tests').get().c;
const preMuts = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
console.log(`[migrate-v13] Pre-migration: eas_tests=${preEas}, mutations=${preMuts}`);

// ── Atomic transaction ────────────────────────────────────────
db.transaction(() => {
  db.exec('ALTER TABLE eas_tests ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE INDEX IF NOT EXISTS idx_eas_tests_station_id ON eas_tests(station_id)');
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(13);
})();
console.log('[migrate-v13] Transaction committed.');

// ── Post-verification ─────────────────────────────────────────
let ok = true;

const postEasCols = db.prepare('PRAGMA table_info(eas_tests)').all().map(r => r.name);
if (!postEasCols.includes('station_id')) {
  console.error('[migrate-v13] FAIL: eas_tests.station_id not present after ALTER');
  ok = false;
} else {
  console.log('[migrate-v13] PASS: eas_tests.station_id present');
}

const wrongRows = db.prepare('SELECT COUNT(*) AS c FROM eas_tests WHERE station_id != 1').get().c;
if (wrongRows !== 0) {
  console.error(`[migrate-v13] FAIL: ${wrongRows} rows have station_id != 1 after DEFAULT 1 backfill`);
  ok = false;
} else {
  console.log(`[migrate-v13] PASS: all eas_tests rows have station_id = 1 (${preEas} rows)`);
}

const indexes = db.prepare('PRAGMA index_list(eas_tests)').all().map(r => r.name);
if (!indexes.includes('idx_eas_tests_station_id')) {
  console.error('[migrate-v13] FAIL: idx_eas_tests_station_id index not found');
  ok = false;
} else {
  console.log('[migrate-v13] PASS: idx_eas_tests_station_id index created');
}

const postEas  = db.prepare('SELECT COUNT(*) AS c FROM eas_tests').get().c;
const postMuts = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;

if (postEas !== preEas) {
  console.error(`[migrate-v13] FAIL: eas_tests count changed: ${preEas} → ${postEas}`);
  ok = false;
} else {
  console.log(`[migrate-v13] PASS: eas_tests row count unchanged (${postEas})`);
}

if (postMuts !== preMuts) {
  console.error(`[migrate-v13] FAIL: mutations count changed: ${preMuts} → ${postMuts}`);
  ok = false;
} else {
  console.log(`[migrate-v13] PASS: mutations count unchanged (${postMuts})`);
}

const postVersions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
const wantVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
if (JSON.stringify(postVersions) !== JSON.stringify(wantVersions)) {
  console.error(`[migrate-v13] FAIL: schema_version mismatch: got ${JSON.stringify(postVersions)}, expected ${JSON.stringify(wantVersions)}`);
  ok = false;
} else {
  console.log(`[migrate-v13] PASS: schema_version = [1..13]`);
}

if (!ok) {
  console.error('[migrate-v13] One or more post-verification checks FAILED.');
  db.close(); process.exit(1);
}

console.log('[migrate-v13] All post-verification checks PASSED.');
console.log('[migrate-v13] Migration complete.');

} catch (err) {
  console.error('[migrate-v13] FATAL:', err.message);
  db.close(); process.exit(1);
}

db.close();

} // end if (_isMain)
