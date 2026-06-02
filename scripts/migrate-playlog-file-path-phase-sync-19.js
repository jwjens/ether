'use strict';
// Migration v19: add file_path to play_log.
//
// - file_path TEXT — the audio file that aired, copied from the deck state at
//                    log time. Synced as 'blob-ref' (same as every other
//                    file_path in the registry) so all clients agree on the
//                    same source for the same play.
//
// WHY: this is the stable join key for the advertiser affidavit / proof-of-
// performance report. A spot's file_path is its identity (spots are de-duped by
// file_path), and unlike the display title it survives a rename. The backend
// affidavit joins station_play_history.file_path -> the mirrored spots table to
// attribute each aired spot to its advertiser. Songs get a file_path too; they
// simply don't match a spot row, so they're naturally excluded from the report.
//
// No backfill: historical play_log rows have no recoverable source path, so the
// affidavit is correct going forward only (expected — it reports what aired).

function applyMigration(db) {
  const migrate = db.transaction(() => {
    const existingCols = new Set(
      db.prepare('PRAGMA table_info(play_log)').all().map(r => r.name)
    );

    if (!existingCols.has('file_path')) {
      db.prepare('ALTER TABLE play_log ADD COLUMN file_path TEXT').run();
      console.log('[migrate-v19] ALTER  play_log.file_path TEXT');
    } else {
      console.log('[migrate-v19] SKIP   play_log.file_path — column already exists');
    }

    db.prepare('INSERT INTO schema_version (version) VALUES (19)').run();
  });
  migrate();
  console.log('[migrate-v19] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — file_path defaults to null for older payloads (a receiver on an
    // earlier schema simply has no path for that historical play).
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-playlog-file-path-phase-sync-19.js ===');
  console.log('DB:', dbPath);

  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', currentVersion);
  if (currentVersion !== 18) {
    console.error('ABORT: expected schema_version 18, got', currentVersion);
    process.exit(1);
  }

  const tableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='play_log'").get();
  if (!tableExists) {
    console.error('ABORT: play_log table does not exist');
    process.exit(1);
  }

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!pass) allPass = false;
  };

  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 19', newVersion === 19, `got ${newVersion}`);

  const cols = db.prepare('PRAGMA table_info(play_log)').all().map(r => r.name);
  check('play_log.file_path column exists', cols.includes('file_path'));

  db.close();

  if (!allPass) {
    console.error('\nOne or more post-verification checks FAILED.');
    process.exit(1);
  }
  console.log('\nAll checks PASSED — migration v19 complete.');
}
