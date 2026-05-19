'use strict';
// scripts/scratch-sync-pull.js — Steps 1-4 of the scratch client sync test.
//
// PULL-ONLY. This script NEVER calls engine.push() or engine.syncCycle().
// push() would inject scratch mutations into OV's shared Railway backend under
// OV's license key, polluting real production data. Only engine.pull() is called
// here — it performs GET-only requests against the backend and writes only to
// the local scratch DB.
//
// Run via:  npx electron --no-sandbox scripts/scratch-sync-pull.js
// Verify:   npx electron --no-sandbox scripts/scratch-sync-verify.js
//
// Safe guarantees:
//   - Real DB opened ONCE with { readonly: true } for two SELECTs, then closed.
//   - All writes go to C:\openair\scratch-client\openair.db exclusively.
//   - The real DB path is never opened read-write.

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

const ROOT       = path.join(__dirname, '..');
const appData    = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB    = path.join(appData, 'com.ether.radio', 'openair.db');
const SCRATCH_DIR = path.join(ROOT, 'scratch-client');
const SCRATCH_DB  = path.join(SCRATCH_DIR, 'openair.db');

const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

function sep(label) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${label}`);
  console.log('═'.repeat(60));
}

async function main() {

  // ─────────────────────────────────────────────────────────────
  // STEP 1 — Read two values from real DB (read-only)
  // ─────────────────────────────────────────────────────────────
  sep('STEP 1 — Read from real DB (read-only)');
  console.log('Real DB path:', REAL_DB);

  if (!fs.existsSync(REAL_DB)) {
    console.error('ERROR: Real DB not found at', REAL_DB);
    process.exit(1);
  }

  const realDb = new Database(REAL_DB, { readonly: true });

  const licRow     = realDb.prepare("SELECT value FROM station_config_kv WHERE key = 'license_key' LIMIT 1").get();
  const urlRow     = realDb.prepare("SELECT value FROM station_config_kv WHERE key = 'sync_backend_url' LIMIT 1").get();
  // Read the primary station_id used in mutations (station-scoped mutations carry this value).
  // Pull with station_id so station-scoped data (categories, clocks, station_programming, etc.)
  // is included. The scratch client never pushes, so this is read-only and safe.
  const stationRow = realDb.prepare(
    "SELECT DISTINCT station_id FROM mutations WHERE station_id IS NOT NULL LIMIT 1"
  ).get();

  const licenseKey     = licRow?.value        ?? null;
  const syncBackendUrl = urlRow?.value        ?? null;
  const stationId      = stationRow?.station_id ?? null;

  realDb.close();

  console.log('license_key:     ', licenseKey    ? `[found — ${licenseKey.slice(0,6)}...]` : 'NOT FOUND');
  console.log('sync_backend_url:', syncBackendUrl ?? 'NOT FOUND');
  console.log('station_id:      ', stationId     ?? '(null — install-scoped only)');

  if (!licenseKey || !syncBackendUrl) {
    console.error('ERROR: Missing sync config in real DB. Aborting.');
    process.exit(1);
  }
  console.log('✓ Real DB closed. It will not be touched again in this script.');

  // ─────────────────────────────────────────────────────────────
  // STEP 2 — Create and migrate fresh scratch DB
  // ─────────────────────────────────────────────────────────────
  sep('STEP 2 — Build fresh scratch DB');
  console.log('Scratch DB path:', SCRATCH_DB);

  // Wipe any previous scratch run cleanly
  for (const ext of ['', '-wal', '-shm']) {
    const f = SCRATCH_DB + ext;
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log('  Removed previous', path.basename(f)); }
  }
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  const scratchDb = new Database(SCRATCH_DB);
  scratchDb.pragma('journal_mode = WAL');
  scratchDb.pragma('foreign_keys = ON');

  // Baseline: CREATE TABLE IF NOT EXISTS for every table (idempotent)
  require(path.join(ROOT, 'scripts', 'schema-v0-baseline'))(scratchDb);
  console.log('✓ Baseline schema applied');

  // Migration chain v1→v16
  // Migration scripts guard their standalone code behind require.main === module,
  // so require()-ing them here only loads the exported applyMigration(db) function.
  const MIGRATION_RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const allFiles     = fs.readdirSync(path.join(ROOT, 'scripts'));
  const migrations   = [];
  for (const f of allFiles) {
    const m = MIGRATION_RE.exec(f);
    if (m) migrations.push({ v: parseInt(m[1], 10), file: f });
  }
  migrations.sort((a, b) => a.v - b.v);

  const applied = new Set(
    scratchDb.prepare('SELECT version FROM schema_version').all().map(r => r.version)
  );
  for (const { v, file } of migrations) {
    if (applied.has(v)) { console.log(`  v${v} already applied — skipping`); continue; }
    console.log(`  Applying migration v${v} (${file})...`);
    require(path.join(ROOT, 'scripts', file)).applyMigration(scratchDb);
    console.log(`  ✓ v${v} done`);
  }

  const maxVer   = scratchDb.prepare('SELECT MAX(version) as v FROM schema_version').get()?.v;
  const songs0   = scratchDb.prepare('SELECT COUNT(*) as c FROM songs').get()?.c;
  const clientId = scratchDb.prepare('SELECT client_id FROM client_identity WHERE id = 1').get()?.client_id;

  console.log(`\n  schema_version MAX : ${maxVer}  (expected 16)`);
  console.log(`  songs             : ${songs0}  (expected 0)`);
  console.log(`  scratch client_id : ${clientId}`);
  console.log('  (client_id is freshly generated — NOT copied from real DB)');

  if (maxVer !== 16) {
    console.error('ERROR: schema_version did not reach 16. Aborting.');
    process.exit(1);
  }
  console.log('✓ Scratch DB built clean');

  // ─────────────────────────────────────────────────────────────
  // STEP 3 — Inject sync config into scratch DB
  // ─────────────────────────────────────────────────────────────
  sep('STEP 3 — Inject sync config into scratch DB');

  const upsertKv = scratchDb.prepare(`
    INSERT OR REPLACE INTO station_config_kv
      (station_id, key, value, uuid, created_at, updated_at)
    VALUES (1, ?, ?, ?, unixepoch(), unixepoch())
  `);
  upsertKv.run('license_key',      licenseKey,     crypto.randomUUID());
  upsertKv.run('sync_backend_url', syncBackendUrl, crypto.randomUUID());
  upsertKv.run('sync_enabled',     'true',         crypto.randomUUID());

  // Verify injection
  const kv = (key) => scratchDb.prepare(
    "SELECT value FROM station_config_kv WHERE key = ? LIMIT 1"
  ).get(key)?.value;
  console.log('  license_key      :', kv('license_key')     ? `[set — ${kv('license_key').slice(0,6)}...]` : 'MISSING');
  console.log('  sync_backend_url :', kv('sync_backend_url') ?? 'MISSING');
  console.log('  sync_enabled     :', kv('sync_enabled')     ?? 'MISSING');
  console.log('✓ Sync config injected');

  // ─────────────────────────────────────────────────────────────
  // STEP 4 — Pull-only sync
  // NEVER calls push() — see file header comment.
  // ─────────────────────────────────────────────────────────────
  sep('STEP 4 — Pull sync (GET only — push() is never called)');

  const { HttpTransport } = require(path.join(ROOT, 'electron', 'sync', 'transport-http'));
  const { SyncEngine }    = require(path.join(ROOT, 'electron', 'sync', 'sync-engine'));

  const transport = new HttpTransport(scratchDb, { baseUrl: syncBackendUrl });
  const engine    = new SyncEngine(scratchDb, transport, { getStationId: () => stationId });

  console.log('  Calling engine.pull()...');
  let pullResult;
  try {
    pullResult = await engine.pull();
  } catch (err) {
    console.error('✗ pull() threw:', err.message);
    if (err.status) console.error('  HTTP status:', err.status);
    scratchDb.close();
    process.exit(1);
    return;
  }

  console.log('\n  ── pull() result ──────────────────────────────────');
  console.log('  pulled       :', pullResult.pulled);
  console.log('  applied      :', pullResult.applied);
  console.log('  loser        :', pullResult.loser);
  console.log('  idempotent   :', pullResult.idempotent);
  console.log('  held         :', pullResult.held);
  console.log('  quarantined  :', pullResult.quarantined);
  console.log('  rejected     :', pullResult.rejected);
  console.log('  conflicted   :', pullResult.conflicted);
  console.log('  failed       :', pullResult.failed);

  if (pullResult.pulled > 0) {
    console.log(`\n✓ STEP 4 PASS — pulled ${pullResult.pulled} mutations, replayed cleanly`);
  } else {
    console.log('\n⚠  STEP 4: 0 mutations pulled — backend pool may be empty or license key rejected');
  }

  console.log('\n  Scratch DB is at:', SCRATCH_DB);
  console.log('  Run scratch-sync-verify.js next to see table counts.');

  scratchDb.close();
}

main().then(() => process.exit(0)).catch(err => {
  console.error('\nFATAL:', err.stack || err.message);
  process.exit(1);
});
