'use strict';
// Migration v17: add R2 audio sync fields to songs.
//
// - file_key TEXT          — basename used as the R2 object key (under the
//                            customer's license_key_id prefix). Synced as
//                            'scalar' so all clients agree on the same key
//                            for the same song row.
// - r2_uploaded_at TIMESTAMP — local marker set by the uploader after a
//                            successful PUT. NOT synced (local-only in
//                            REGISTRY) so each machine tracks its own
//                            upload state independently. Use GET /audio/list
//                            to cross-check against R2 reality.
//
// Note on local-only semantics: the existing local-only columns on songs
// (cue_in / cue_out / intro_end / outro_start) are local-only because they
// represent legacy user-editing decisions that shouldn't propagate to other
// machines. r2_uploaded_at is local-only for a different reason: it tracks
// per-machine infrastructure state — whether THIS machine has uploaded the
// file. Different semantic, same mechanism.
//
// Backfill: file_key = basename(file_path) for rows where file_path is set
// and file_key is still NULL. Pure-JS basename handles both '/' and '\\'
// separators so paths from any host platform resolve correctly.

function basename(p) {
  if (p === null || p === undefined) return null;
  const s = String(p);
  if (s === '') return null;
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx === -1 ? s : s.slice(idx + 1);
}

function applyMigration(db) {
  const migrate = db.transaction(() => {
    const existingCols = new Set(
      db.prepare('PRAGMA table_info(songs)').all().map(r => r.name)
    );

    if (!existingCols.has('file_key')) {
      db.prepare('ALTER TABLE songs ADD COLUMN file_key TEXT').run();
      console.log('[migrate-v17] ALTER  songs.file_key TEXT');
    } else {
      console.log('[migrate-v17] SKIP   songs.file_key — column already exists');
    }

    if (!existingCols.has('r2_uploaded_at')) {
      db.prepare('ALTER TABLE songs ADD COLUMN r2_uploaded_at TIMESTAMP').run();
      console.log('[migrate-v17] ALTER  songs.r2_uploaded_at TIMESTAMP');
    } else {
      console.log('[migrate-v17] SKIP   songs.r2_uploaded_at — column already exists');
    }

    // Backfill file_key from file_path basenames. Idempotent — only touches
    // rows where file_key is still NULL.
    const eligible = db.prepare(
      "SELECT id, file_path FROM songs " +
      "WHERE file_path IS NOT NULL AND file_path != '' AND file_key IS NULL"
    ).all();

    const update = db.prepare('UPDATE songs SET file_key = ? WHERE id = ?');
    let backfilled = 0;
    for (const r of eligible) {
      const key = basename(r.file_path);
      if (key) {
        update.run(key, r.id);
        backfilled++;
      }
    }
    console.log(`[migrate-v17] FILL   songs.file_key backfilled ${backfilled} of ${eligible.length} eligible row(s)`);

    db.prepare('INSERT INTO schema_version (version) VALUES (17)').run();
  });
  migrate();
  console.log('[migrate-v17] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — file_key defaults to null for older payloads (receiver
    // can backfill from file_path basename if needed). r2_uploaded_at is
    // local-only and never appears in payloads.
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

  console.log('=== migrate-songs-r2-fields-phase-sync-17.js ===');
  console.log('DB:', dbPath);

  // ── Pre-flight 1: schema_version must be 16 ───────────────────
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', currentVersion);
  if (currentVersion !== 16) {
    console.error('ABORT: expected schema_version 16, got', currentVersion);
    process.exit(1);
  }

  // ── Pre-flight 2: songs table must exist ──────────────────────
  const tableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='songs'").get();
  if (!tableExists) {
    console.error('ABORT: songs table does not exist');
    process.exit(1);
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
  check('schema_version = 17', newVersion === 17, `got ${newVersion}`);

  const cols = db.prepare('PRAGMA table_info(songs)').all().map(r => r.name);
  check('songs.file_key column exists',       cols.includes('file_key'));
  check('songs.r2_uploaded_at column exists', cols.includes('r2_uploaded_at'));

  // Sample the backfill: any row with file_path set should now have file_key
  // (the basename of file_path).
  const orphans = db.prepare(
    "SELECT COUNT(*) as n FROM songs WHERE file_path IS NOT NULL AND file_path != '' AND file_key IS NULL"
  ).get().n;
  check('no rows with file_path AND file_key=NULL', orphans === 0, `orphans: ${orphans}`);

  const filled = db.prepare(
    "SELECT COUNT(*) as n FROM songs WHERE file_key IS NOT NULL"
  ).get().n;
  console.log(`INFO   songs with file_key set: ${filled}`);

  db.close();

  if (!allPass) {
    console.error('\nOne or more post-verification checks FAILED.');
    process.exit(1);
  }
  console.log('\nAll checks PASSED — migration v17 complete.');
}
