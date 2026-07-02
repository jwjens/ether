'use strict';
// Migration v27 (Ether v2 data architecture, spec §2.1): client-side library tables.
//
//   songs_v2    — one row per unique piece of audio content, keyed by content_hash (sha256 hex).
//                 install-scoped (shared across stations). Populated by the /library/snapshot +
//                 /library/changes REST flow (spec D2/§4), NOT by mutation-log replay — so it is
//                 deliberately NOT registered in synced-tables.js. file_path is retired as identity.
//   local_files — where the bytes are on THIS machine right now. Machine-local, never synced;
//                 rebuilt by scanning the content store.
//
// Additive only: creates two new tables, touches nothing existing. The old `songs` table is left
// untouched (dropped in week 4 after cutover). Idempotent: if songs_v2 exists, just records v27.

function isAlreadyMigrated(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='songs_v2'").get();
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (27)').run(); } catch (e) { /* already recorded */ }
    console.log('[migrate-v27] SKIP — songs_v2 already exists');
    return;
  }
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE songs_v2 (
        content_hash   TEXT PRIMARY KEY,          -- sha256 hex of file bytes (identity)
        title          TEXT NOT NULL,
        artist         TEXT,
        album          TEXT,
        duration_ms    INTEGER,
        ext            TEXT NOT NULL,             -- 'mp3', 'wav', ...
        size_bytes     INTEGER NOT NULL,
        source_folder  TEXT,                      -- display metadata: 'Daytime', 'Halloween', ...
        original_name  TEXT,                      -- display metadata: filename at import time
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      )
    `).run();
    db.prepare(`
      CREATE TABLE local_files (
        content_hash   TEXT PRIMARY KEY REFERENCES songs_v2(content_hash),
        local_path     TEXT NOT NULL,             -- <content-store>/<hash>.<ext>
        verified_at    TEXT NOT NULL              -- last time existence+size was confirmed
      )
    `).run();
    db.prepare('INSERT INTO schema_version (version) VALUES (27)').run();
  });
  migrate();
  console.log('[migrate-v27] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — songs_v2 / local_files are not mutation-log-synced (populated via REST snapshot/tail),
    // so there are no payloads to transform. Present to satisfy the transformer-chain contract.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-songs-v2-phase-sync-27.js ===');
  console.log('DB:', dbPath);

  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', currentVersion);
  if (currentVersion !== 26) {
    console.error('ABORT: expected schema_version 26, got', currentVersion);
    process.exit(1);
  }
  if (isAlreadyMigrated(db)) {
    console.log('INFO: songs_v2 already exists — migration already applied, exiting cleanly.');
    process.exit(0);
  }

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!pass) allPass = false;
  };
  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 27', newVersion === 27, `got ${newVersion}`);
  const sv2 = db.prepare('PRAGMA table_info(songs_v2)').all().map(r => r.name);
  for (const c of ['content_hash','title','artist','album','duration_ms','ext','size_bytes','source_folder','original_name','created_at','updated_at'])
    check(`songs_v2.${c}`, sv2.includes(c), sv2.join(', '));
  const lf = db.prepare('PRAGMA table_info(local_files)').all().map(r => r.name);
  for (const c of ['content_hash','local_path','verified_at']) check(`local_files.${c}`, lf.includes(c), lf.join(', '));
  const pk = db.prepare("PRAGMA table_info(songs_v2)").all().find(r => r.name === 'content_hash');
  check('songs_v2.content_hash is PRIMARY KEY', pk && pk.pk === 1);
  check('songs_v2 empty', db.prepare('SELECT COUNT(*) c FROM songs_v2').get().c === 0);
  check('old songs table untouched (still present)', !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='songs'").get());

  db.close();
  if (!allPass) { console.error('\nFAIL'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v27 complete.');
}
