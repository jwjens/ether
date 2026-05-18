'use strict';
// Migration v16: create quarantine_mutations table for forward-schema-version holds [N-64].
//
// quarantine_mutations is an infrastructure table (not a synced table per [N-12]).
// Mutations land here when their schema_version > local at receive time.
// Drain logic (Step 5) replays them after local schema advances to >= foreign_schema_version.
//
// retry_count counts genuine apply failures only (schema-compatible but replay failed).
// A mutation that is still "too new" (foreign_schema_version > local after upgrade) is
// never retried and retry_count is never incremented for it — it waits for the next upgrade.

function applyMigration(db) {
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE quarantine_mutations (
        id                     TEXT PRIMARY KEY,
        raw_json               TEXT NOT NULL,
        foreign_schema_version INTEGER NOT NULL,
        local_schema_version   INTEGER NOT NULL,
        received_at            TEXT NOT NULL,
        retry_after            TEXT,
        retry_count            INTEGER NOT NULL DEFAULT 0,
        drain_status           TEXT NOT NULL DEFAULT 'pending'
                                 CHECK (drain_status IN ('pending', 'drained', 'failed'))
      )
    `).run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_quarantine_drain ON quarantine_mutations(drain_status, foreign_schema_version)').run();
    db.prepare('INSERT INTO schema_version (version) VALUES (16)').run();
  });
  migrate();
  console.log('[migrate-v16] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — quarantine_mutations is not a synced table; no payload transformation needed.
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

  console.log('=== migrate-quarantine-store-phase-sync-16.js ===');
  console.log('DB:', dbPath);

  // ── Pre-flight 1: schema_version must be 15 ───────────────────
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', currentVersion);
  if (currentVersion !== 15) {
    console.error('ABORT: expected schema_version 15, got', currentVersion);
    process.exit(1);
  }

  // ── Pre-flight 2: quarantine_mutations must not already exist ──
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quarantine_mutations'").get();
  if (existing) {
    console.log('INFO: quarantine_mutations already exists — migration already applied, exiting cleanly.');
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
  check('schema_version = 16', newVersion === 16, `got ${newVersion}`);

  const tableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quarantine_mutations'").get();
  check('quarantine_mutations table exists', tableExists);

  const cols = db.prepare('PRAGMA table_info(quarantine_mutations)').all().map(r => r.name);
  const expectedCols = ['id', 'raw_json', 'foreign_schema_version', 'local_schema_version', 'received_at', 'retry_after', 'retry_count', 'drain_status'];
  for (const col of expectedCols) {
    check(`column ${col} exists`, cols.includes(col), cols.join(', '));
  }

  const idxExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_quarantine_drain'").get();
  check('idx_quarantine_drain index exists', idxExists);

  const rowCount = db.prepare('SELECT COUNT(*) as c FROM quarantine_mutations').get().c;
  check('quarantine_mutations is empty', rowCount === 0, `rows: ${rowCount}`);

  db.close();

  if (!allPass) {
    console.error('\nOne or more post-verification checks FAILED.');
    process.exit(1);
  }
  console.log('\nAll checks PASSED — migration v16 complete.');
}
