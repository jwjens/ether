'use strict';

// scripts/migrate-station-schema-phase-sync-12.js — Phase Sync-12
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-station-schema-phase-sync-12.js
// IMPORTANT: Stop the Ether app before running.
//
// What it does (single atomic transaction):
//   1. Backs up openair.db to openair.db.pre-v12.<timestamp>.bak
//   2. Pre-flight 1: schema_version must be exactly [1..11]; aborts if already v12
//   3. Pre-flight 2: songs.station_id column must exist
//   4. Records pre-migration row counts for songs
//   5. Transaction:
//        a. ALTER TABLE songs DROP COLUMN station_id
//        b. INSERT version=12 into schema_version
//   6. Post-migration verification:
//        - songs.station_id absent
//        - songs row count unchanged
//        - mutations row count unchanged
//        - schema_version = [1..12]

// payloadTransformer: strips station_id from incoming SONG payloads sent by v11 nodes.
// Guard is scoped to table_name='songs' — other tables (station_config_kv, categories,
// clocks, stations) carry station_id as a legitimate column and must not be stripped.

function applyMigration(db) {
  const migrate = db.transaction(() => {
    // Only drop station_id if it exists — v0 baseline fresh installs never add it
    const hasSid = db.prepare('PRAGMA table_info(songs)').all().some(c => c.name === 'station_id');
    if (hasSid) {
      db.exec('ALTER TABLE songs DROP COLUMN station_id');
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(12);
  });
  migrate();
  console.log('[migrate-v12] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion, envelope) {
    if (!payload || typeof payload !== 'object') return payload;
    if (fromVersion < 12 && envelope?.table_name === 'songs' && 'station_id' in payload) {
      const { station_id, ...rest } = payload;
      return rest;
    }
    return payload;
  },
  applyMigration,
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
  console.error('[migrate-v12] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));

// ── Backup ────────────────────────────────────────────────────
const ts     = Date.now();
const bakPath = dbPath.replace(/\.db$/, `.db.pre-v12.${ts}.bak`);
fs.copyFileSync(dbPath, bakPath);
console.log(`[migrate-v12] Backup written: ${bakPath}`);

const db = new Database(dbPath);

try {

// ── Pre-flight 1: schema_version ─────────────────────────────
const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log('[migrate-v12] Current schema_version:', versions);

if (versions.includes(12)) {
  console.error('[migrate-v12] ERROR: version 12 already present — migration already applied. Aborting.');
  db.close(); process.exit(1);
}

const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const missing  = expected.filter(v => !versions.includes(v));
if (missing.length > 0) {
  console.error('[migrate-v12] ERROR: prerequisite versions missing:', missing, '— expected', expected);
  db.close(); process.exit(1);
}
console.log('[migrate-v12] Pre-flight 1 PASS — schema_version = [1..11]');

// ── Pre-flight 2: confirm station_id present on songs ────────
const songsCols = db.prepare('PRAGMA table_info(songs)').all().map(r => r.name);

if (!songsCols.includes('station_id')) {
  console.error('[migrate-v12] ERROR: songs.station_id already absent — was DROP COLUMN already run?');
  db.close(); process.exit(1);
}
console.log('[migrate-v12] Pre-flight 2 PASS — songs.station_id present');

// ── Pre-migration row counts ──────────────────────────────────
const preSongs = db.prepare('SELECT COUNT(*) AS c FROM songs').get().c;
const preMuts  = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
console.log(`[migrate-v12] Pre-migration: songs=${preSongs}, mutations=${preMuts}`);

// ── Atomic transaction ────────────────────────────────────────
applyMigration(db);

// ── Post-verification ─────────────────────────────────────────
let ok = true;

const postSongsCols = db.prepare('PRAGMA table_info(songs)').all().map(r => r.name);

if (postSongsCols.includes('station_id')) {
  console.error('[migrate-v12] FAIL: songs.station_id still present after DROP');
  ok = false;
} else {
  console.log('[migrate-v12] PASS: songs.station_id absent');
}

const postSongs = db.prepare('SELECT COUNT(*) AS c FROM songs').get().c;
const postMuts  = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;

if (postSongs !== preSongs) {
  console.error(`[migrate-v12] FAIL: songs count changed: ${preSongs} → ${postSongs}`);
  ok = false;
} else {
  console.log(`[migrate-v12] PASS: songs row count unchanged (${postSongs})`);
}

if (postMuts !== preMuts) {
  console.error(`[migrate-v12] FAIL: mutations count changed: ${preMuts} → ${postMuts}`);
  ok = false;
} else {
  console.log(`[migrate-v12] PASS: mutations count unchanged (${postMuts})`);
}

const postVersions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
const wantVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
if (JSON.stringify(postVersions) !== JSON.stringify(wantVersions)) {
  console.error(`[migrate-v12] FAIL: schema_version mismatch: got ${JSON.stringify(postVersions)}, expected ${JSON.stringify(wantVersions)}`);
  ok = false;
} else {
  console.log(`[migrate-v12] PASS: schema_version = [1..12]`);
}

if (!ok) {
  console.error('[migrate-v12] One or more post-verification checks FAILED.');
  db.close(); process.exit(1);
}

console.log('[migrate-v12] All post-verification checks PASSED.');
console.log('[migrate-v12] Migration complete.');

} catch (err) {
  console.error('[migrate-v12] FATAL:', err.message);
  db.close(); process.exit(1);
}

db.close();

} // end if (_isMain)
