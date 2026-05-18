'use strict';

// scripts/migrate-library-install-scoped-phase-sync-7.js — Phase Sync-7
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-library-install-scoped-phase-sync-7.js
// IMPORTANT: Stop the Ether app before running.
//
// What it does (single atomic transaction):
//   1. Backs up openair.db to openair.db.pre-v7.<timestamp>.bak
//   2. Pre-flight 1: schema_version must be exactly [1,2,3,4,5,6]; aborts if already v7
//   3. Pre-flight 2: station_id column must exist on both artists and albums
//   4. Records pre-migration row counts for artists and albums
//   5. Transaction:
//        a. ALTER TABLE artists DROP COLUMN station_id
//        b. ALTER TABLE albums  DROP COLUMN station_id
//        c. INSERT version=7 into schema_version
//   6. Post-migration verification:
//        - artists.station_id absent
//        - albums.station_id absent
//        - songs.station_id STILL present (deferred to v8)
//        - artists row count unchanged
//        - albums row count unchanged
//        - mutations row count unchanged
//        - schema_version = [1,2,3,4,5,6,7]

// payloadTransformer: identity. v7 drops physical columns only; no payload field mapping needed
// (install-scoped handlers already exclude station_id from payloads per [N-89]).

function applyMigration(db) {
  const migrate = db.transaction(() => {
    // Guard: only drop if present — fresh installs (v0 baseline never adds station_id to
    // artists/albums) would crash on unconditional DROP. Upgrade installs that previously
    // ran a pre-DROP revision of v7 (OV case) will be skipped since schema_version=7 exists.
    const artistsCols = db.prepare('PRAGMA table_info(artists)').all().map(c => c.name);
    if (artistsCols.includes('station_id')) {
      db.exec('ALTER TABLE artists DROP COLUMN station_id');
    }
    const albumsCols = db.prepare('PRAGMA table_info(albums)').all().map(c => c.name);
    if (albumsCols.includes('station_id')) {
      db.exec('ALTER TABLE albums  DROP COLUMN station_id');
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(7);
  });
  migrate();
  console.log('[migrate-v7] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    if (!payload || typeof payload !== 'object') return payload;
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
  console.error('[migrate-v7] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));

// ── Backup ────────────────────────────────────────────────────
const ts     = Date.now();
const bakPath = dbPath.replace(/\.db$/, `.db.pre-v7.${ts}.bak`);
fs.copyFileSync(dbPath, bakPath);
console.log(`[migrate-v7] Backup written: ${bakPath}`);

const db = new Database(dbPath);

try {

// ── Pre-flight 1: schema_version ─────────────────────────────
const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log('[migrate-v7] Current schema_version:', versions);

if (versions.includes(7)) {
  console.error('[migrate-v7] ERROR: version 7 already present — migration already applied. Aborting.');
  db.close(); process.exit(1);
}

const expected = [1, 2, 3, 4, 5, 6];
const missing  = expected.filter(v => !versions.includes(v));
if (missing.length > 0) {
  console.error('[migrate-v7] ERROR: prerequisite versions missing:', missing, '— expected', expected);
  db.close(); process.exit(1);
}
console.log('[migrate-v7] Pre-flight 1 PASS — schema_version = [1..6]');

// ── Pre-flight 2: confirm station_id present on both tables ──
const artistsCols = db.prepare('PRAGMA table_info(artists)').all().map(r => r.name);
const albumsCols  = db.prepare('PRAGMA table_info(albums)').all().map(r => r.name);

if (!artistsCols.includes('station_id')) {
  console.error('[migrate-v7] ERROR: artists.station_id already absent — was DROP COLUMN already run?');
  db.close(); process.exit(1);
}
if (!albumsCols.includes('station_id')) {
  console.error('[migrate-v7] ERROR: albums.station_id already absent — was DROP COLUMN already run?');
  db.close(); process.exit(1);
}
console.log('[migrate-v7] Pre-flight 2 PASS — station_id present on artists and albums');

// ── Pre-migration row counts ──────────────────────────────────
const preArtists  = db.prepare('SELECT COUNT(*) AS c FROM artists').get().c;
const preAlbums   = db.prepare('SELECT COUNT(*) AS c FROM albums').get().c;
const preMuts     = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
console.log(`[migrate-v7] Pre-migration: artists=${preArtists}, albums=${preAlbums}, mutations=${preMuts}`);

// ── Atomic transaction ────────────────────────────────────────
applyMigration(db);

// ── Post-verification ─────────────────────────────────────────
let ok = true;

const postArtistsCols = db.prepare('PRAGMA table_info(artists)').all().map(r => r.name);
const postAlbumsCols  = db.prepare('PRAGMA table_info(albums)').all().map(r => r.name);
const postSongsCols   = db.prepare('PRAGMA table_info(songs)').all().map(r => r.name);

if (postArtistsCols.includes('station_id')) {
  console.error('[migrate-v7] FAIL: artists.station_id still present after DROP');
  ok = false;
} else {
  console.log('[migrate-v7] PASS: artists.station_id absent');
}

if (postAlbumsCols.includes('station_id')) {
  console.error('[migrate-v7] FAIL: albums.station_id still present after DROP');
  ok = false;
} else {
  console.log('[migrate-v7] PASS: albums.station_id absent');
}

if (!postSongsCols.includes('station_id')) {
  console.error('[migrate-v7] FAIL: songs.station_id absent — should still be present (deferred to v8)');
  ok = false;
} else {
  console.log('[migrate-v7] PASS: songs.station_id still present (deferred to v8)');
}

const postArtists = db.prepare('SELECT COUNT(*) AS c FROM artists').get().c;
const postAlbums  = db.prepare('SELECT COUNT(*) AS c FROM albums').get().c;
const postMuts    = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;

if (postArtists !== preArtists) {
  console.error(`[migrate-v7] FAIL: artists count changed: ${preArtists} → ${postArtists}`);
  ok = false;
} else {
  console.log(`[migrate-v7] PASS: artists row count unchanged (${postArtists})`);
}

if (postAlbums !== preAlbums) {
  console.error(`[migrate-v7] FAIL: albums count changed: ${preAlbums} → ${postAlbums}`);
  ok = false;
} else {
  console.log(`[migrate-v7] PASS: albums row count unchanged (${postAlbums})`);
}

if (postMuts !== preMuts) {
  console.error(`[migrate-v7] FAIL: mutations count changed: ${preMuts} → ${postMuts}`);
  ok = false;
} else {
  console.log(`[migrate-v7] PASS: mutations count unchanged (${postMuts})`);
}

const postVersions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
const wantVersions = [1, 2, 3, 4, 5, 6, 7];
if (JSON.stringify(postVersions) !== JSON.stringify(wantVersions)) {
  console.error(`[migrate-v7] FAIL: schema_version mismatch: got ${JSON.stringify(postVersions)}, expected ${JSON.stringify(wantVersions)}`);
  ok = false;
} else {
  console.log(`[migrate-v7] PASS: schema_version = [1,2,3,4,5,6,7]`);
}

if (!ok) {
  console.error('[migrate-v7] One or more post-verification checks FAILED.');
  db.close(); process.exit(1);
}

console.log('[migrate-v7] All post-verification checks PASSED.');
console.log('[migrate-v7] Migration complete.');

} catch (err) {
  console.error('[migrate-v7] FATAL:', err.message);
  db.close(); process.exit(1);
}

db.close();

} // end if (_isMain)
