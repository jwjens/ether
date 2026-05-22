'use strict';
// Migration v18: delete legacy R2 credential keys from station_config_kv.
//
// Phase 1.3f (a0316ee) stopped reading cloud_backup_r2 / r2_config from KV
// when the customer→backend-signed migration shipped, but left the existing
// rows in place so v17 installs would still load + run during the transition.
// v18 is the cleanup pass: removes both keys from every install so customer
// machines hold no R2 credentials anywhere — the architecture lock from the
// session ("customer never holds R2 credentials") becomes physically true.
//
// These KV rows were always written via raw INSERT OR REPLACE in cloud-
// backup.js's saveR2Config (line 369), which bypasses the typed handler and
// therefore never logged a mutation. So the rows are local-only despite
// living in the synced station_config_kv table — each install has its own
// copy, and the raw DELETE here cleans up locally without needing sync
// coordination.

function applyMigration(db) {
  const migrate = db.transaction(() => {
    const { changes } = db.prepare(
      "DELETE FROM station_config_kv WHERE key IN ('cloud_backup_r2', 'r2_config')"
    ).run();
    console.log(`[migrate-v18] DELETE  legacy R2 credentials — removed ${changes} row(s)`);
    db.prepare('INSERT INTO schema_version (version) VALUES (18)').run();
  });
  migrate();
  console.log('[migrate-v18] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — these KV keys never entered the mutation log (raw INSERT OR
    // REPLACE in saveR2Config bypassed the typed handler), so no inbound
    // payloads carry them and no transformation is required.
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

  console.log('=== migrate-cleanup-r2-credentials-phase-sync-18.js ===');
  console.log('DB:', dbPath);

  // ── Pre-flight 1: schema_version must be 17 ───────────────────
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', currentVersion);
  if (currentVersion !== 17) {
    console.error('ABORT: expected schema_version 17, got', currentVersion);
    process.exit(1);
  }

  // ── Pre-flight 2: station_config_kv table must exist ──────────
  const tableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='station_config_kv'").get();
  if (!tableExists) {
    console.error('ABORT: station_config_kv table does not exist');
    process.exit(1);
  }

  // ── Pre-count: how many rows match the cleanup criteria ──────
  const beforeCount = db.prepare(
    "SELECT COUNT(*) as n FROM station_config_kv WHERE key IN ('cloud_backup_r2', 'r2_config')"
  ).get().n;
  console.log(`pre-flight: ${beforeCount} legacy credential row(s) found`);

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
  check('schema_version = 18', newVersion === 18, `got ${newVersion}`);

  const remaining = db.prepare(
    "SELECT COUNT(*) as n FROM station_config_kv WHERE key IN ('cloud_backup_r2', 'r2_config')"
  ).get().n;
  check('cloud_backup_r2 / r2_config rows fully removed', remaining === 0, `remaining: ${remaining}`);

  db.close();

  if (!allPass) {
    console.error('\nOne or more post-verification checks FAILED.');
    process.exit(1);
  }
  console.log('\nAll checks PASSED — migration v18 complete.');
}
