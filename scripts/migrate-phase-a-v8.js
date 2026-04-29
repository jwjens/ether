// scripts/migrate-phase-a-v8.js — Phase A v8 schema migration (Commit 1 of 5)
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v8.js
// Dry-run:  node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v8.js --dry-run
//
// Applies schema changes S1–S7 from docs/phase-a-step-2-v8-migration-plan.md.
// M8 (null-UUID backfill) pulled into Commit 1 from Commit 2 — S7 cannot proceed
// with uuid TEXT NOT NULL if any rows have uuid IS NULL.
// Remaining data migrations (M1–M7) are still Commit 2.
// Registry change S8 is a code edit — electron/sync/synced-tables.js.
//
// Transaction body (12 steps):
//   Step  1  S1    — stations.icecast_port INTEGER DEFAULT 8000
//   Step  2  S2    — stations.audio_device_output TEXT
//   Step  3  S3    — stations.mic_device TEXT
//   Step  4  S3.5  — stations.mount_pending_provision INTEGER NOT NULL DEFAULT 1
//   Step  5  S4    — CREATE TABLE monitor_routing
//   Step  6  S5    — CREATE TABLE install_config_kv
//   Step  7  S6    — CREATE TABLE install_secrets_kv
//   Pre-S7 backfill (M8): null-UUID rows in station_config_kv get
//                         filled with crypto.randomUUID() before the
//                         destructive table recreation. Pulled into
//                         Commit 1 from Commit 2 because S7 cannot
//                         proceed with null UUIDs.
//   Step  8  S7-a  — RENAME station_config_kv → _station_config_kv_old
//   Step  9  S7-b  — CREATE new station_config_kv (no DEFAULT 0)
//   Step 10  S7-c  — INSERT SELECT from _station_config_kv_old
//   Step 11  S7-d  — DROP _station_config_kv_old
//   Step 12        — INSERT schema_version = 8

'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN     = process.argv.includes('--dry-run');
const appData     = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath      = path.join(appData, 'com.ether.radio', 'openair.db');
const snapshotDir = path.join(__dirname);

// ── Helpers ───────────────────────────────────────────────────────────────────

function colExists(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

function tableExists(db, name) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

function getDdl(db, name) {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
  return row ? row.sql : null;
}

// ── Announce ──────────────────────────────────────────────────────────────────

console.log('[v8-migrate] DB path:', dbPath);
if (DRY_RUN) console.log('[v8-migrate] DRY-RUN mode — no changes will be committed');
console.log('');

// ── Pre-flight 1: DB file exists ──────────────────────────────────────────────

if (!fs.existsSync(dbPath)) {
  console.error('[v8-migrate] ERROR: DB not found at', dbPath);
  process.exit(1);
}

// ── Open DB ───────────────────────────────────────────────────────────────────

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath);

// ── Backup DB file before any writes ─────────────────────────────────────────

if (!DRY_RUN) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = dbPath.replace('.db', `-backup-pre-v8-${ts}.db`);
  fs.copyFileSync(dbPath, backupPath);
  console.log('[v8-migrate] DB backup written:', backupPath);
  console.log('');
}

// ── Pre-migration snapshot ────────────────────────────────────────────────────

const currentVersions = db.prepare(
  'SELECT version FROM schema_version ORDER BY version'
).all().map(r => r.version);

const preStationCols  = db.prepare('PRAGMA table_info(stations)').all();
const preCkvDdl       = getDdl(db, 'station_config_kv');
const preAllTables    = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all().map(r => r.name);

const preLines = [
  'v8 migration — pre-migration snapshot',
  `Generated: ${new Date().toISOString()}`,
  `DB path: ${dbPath}`,
  '',
  '── schema_version ──────────────────────────────────────────',
  'Versions: ' + currentVersions.join(', '),
  '',
  '── PRAGMA table_info(stations) ─────────────────────────────',
  ...preStationCols.map(c =>
    `  ${c.name.padEnd(30)} ${c.type.padEnd(15)}${c.dflt_value != null ? ' DEFAULT ' + c.dflt_value : ''}`
  ),
  '',
  '── station_config_kv DDL ───────────────────────────────────',
  preCkvDdl || '(not found)',
  '',
  '── all tables ──────────────────────────────────────────────',
  preAllTables.join(', '),
  '',
];
const preText = preLines.join('\n');

console.log('═'.repeat(60));
console.log('PRE-MIGRATION SNAPSHOT');
console.log('═'.repeat(60));
console.log(preText);

if (!DRY_RUN) {
  const preFile = path.join(snapshotDir, 'pre-migration-snapshot-v8.txt');
  fs.writeFileSync(preFile, preText, 'utf8');
  console.log('[v8-migrate] Pre-migration snapshot written:', preFile);
  console.log('');
}

// ── Pre-flight 2: version checks ──────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('PRE-FLIGHT CHECKS');
console.log('═'.repeat(60));

if (currentVersions.includes(8)) {
  console.log('[v8-migrate] Schema version 8 already applied — nothing to do.');
  db.close();
  process.exit(0);
}

const missingVersions = [1, 2, 3, 4, 5, 6, 7].filter(v => !currentVersions.includes(v));
if (missingVersions.length > 0) {
  console.error('[v8-migrate] ERROR: Missing prerequisite schema versions:', missingVersions.join(', '));
  console.error('[v8-migrate] All migrations v1–v7 must be applied before v8.');
  db.close();
  process.exit(1);
}
console.log('[v8-migrate] PASS: schema versions v1–v7 present');

// Pre-flight 3: partial S7 guard — _station_config_kv_old must not exist
if (tableExists(db, '_station_config_kv_old')) {
  console.error('[v8-migrate] ERROR: _station_config_kv_old table exists.');
  console.error('             This indicates a partial prior run of the S7 table swap.');
  console.error('             Manual inspection required:');
  console.error('               SELECT COUNT(*) FROM _station_config_kv_old;');
  console.error('               SELECT COUNT(*) FROM station_config_kv;');
  db.close();
  process.exit(1);
}
console.log('[v8-migrate] PASS: no partial S7 remnant (_station_config_kv_old absent)');

// Pre-flight 4: required tables present
for (const t of ['stations', 'station_config_kv']) {
  if (!tableExists(db, t)) {
    console.error(`[v8-migrate] ERROR: required table '${t}' not found`);
    db.close();
    process.exit(1);
  }
}
console.log('[v8-migrate] PASS: stations and station_config_kv tables present');
console.log('');

// ── Dry-run: print plan and exit ──────────────────────────────────────────────

if (DRY_RUN) {
  console.log('═'.repeat(60));
  console.log('DRY-RUN PLAN');
  console.log('═'.repeat(60));
  console.log('');

  const stationColNames = preStationCols.map(c => c.name);

  const dryNullUuidCount = db.prepare(
    'SELECT COUNT(*) AS n FROM station_config_kv WHERE uuid IS NULL'
  ).get().n;

  const plan = [
    { label: 'Step  1  S1    stations.icecast_port',                                   needed: !stationColNames.includes('icecast_port') },
    { label: 'Step  2  S2    stations.audio_device_output',                            needed: !stationColNames.includes('audio_device_output') },
    { label: 'Step  3  S3    stations.mic_device',                                     needed: !stationColNames.includes('mic_device') },
    { label: 'Step  4  S3.5  stations.mount_pending_provision',                        needed: !stationColNames.includes('mount_pending_provision') },
    { label: 'Step  5  S4    CREATE TABLE monitor_routing',                            needed: !tableExists(db, 'monitor_routing') },
    { label: 'Step  6  S5    CREATE TABLE install_config_kv',                          needed: !tableExists(db, 'install_config_kv') },
    { label: 'Step  7  S6    CREATE TABLE install_secrets_kv',                         needed: !tableExists(db, 'install_secrets_kv') },
    { label: `Pre-S7    backfill null UUIDs (${dryNullUuidCount} rows on this DB)`,    needed: dryNullUuidCount > 0 },
    { label: 'Steps 8-11 S7  recreate station_config_kv',                             needed: !!(preCkvDdl && preCkvDdl.includes('DEFAULT 0')) },
    { label: 'Step 12        INSERT schema_version = 8',                               needed: true },
  ];

  for (const p of plan) {
    console.log(`  ${p.needed ? 'WILL RUN' : 'SKIP    '} ${p.label}`);
  }

  console.log('');
  console.log('[v8-migrate] Dry-run complete. No changes made.');
  console.log('[v8-migrate] Remove --dry-run to execute.');
  db.close();
  process.exit(0);
}

// ── Migration transaction ─────────────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('RUNNING MIGRATION');
console.log('═'.repeat(60));
console.log('');

const stepResults = {};

const migrate = db.transaction(() => {

  // Step 1 — S1: stations.icecast_port
  if (!colExists(db, 'stations', 'icecast_port')) {
    db.prepare('ALTER TABLE stations ADD COLUMN icecast_port INTEGER DEFAULT 8000').run();
    stepResults.s1 = 'ADDED';
  } else {
    stepResults.s1 = 'SKIP';
  }
  console.log(`[v8-migrate] Step  1/12  S1    stations.icecast_port — ${stepResults.s1}`);

  // Step 2 — S2: stations.audio_device_output
  if (!colExists(db, 'stations', 'audio_device_output')) {
    db.prepare('ALTER TABLE stations ADD COLUMN audio_device_output TEXT').run();
    stepResults.s2 = 'ADDED';
  } else {
    stepResults.s2 = 'SKIP';
  }
  console.log(`[v8-migrate] Step  2/12  S2    stations.audio_device_output — ${stepResults.s2}`);

  // Step 3 — S3: stations.mic_device
  if (!colExists(db, 'stations', 'mic_device')) {
    db.prepare('ALTER TABLE stations ADD COLUMN mic_device TEXT').run();
    stepResults.s3 = 'ADDED';
  } else {
    stepResults.s3 = 'SKIP';
  }
  console.log(`[v8-migrate] Step  3/12  S3    stations.mic_device — ${stepResults.s3}`);

  // Step 4 — S3.5: stations.mount_pending_provision
  if (!colExists(db, 'stations', 'mount_pending_provision')) {
    db.prepare(
      'ALTER TABLE stations ADD COLUMN mount_pending_provision INTEGER NOT NULL DEFAULT 1'
    ).run();
    stepResults.s35 = 'ADDED';
  } else {
    stepResults.s35 = 'SKIP';
  }
  console.log(`[v8-migrate] Step  4/12  S3.5  stations.mount_pending_provision — ${stepResults.s35}`);

  // Step 5 — S4: CREATE TABLE monitor_routing
  db.prepare(`
    CREATE TABLE IF NOT EXISTS monitor_routing (
      output_device_id TEXT PRIMARY KEY,
      station_id       INTEGER,
      uuid             TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      deleted_at       TEXT
    )
  `).run();
  stepResults.s4 = 'OK';
  console.log('[v8-migrate] Step  5/12  S4    CREATE TABLE monitor_routing — OK');

  // Step 6 — S5: CREATE TABLE install_config_kv
  db.prepare(`
    CREATE TABLE IF NOT EXISTS install_config_kv (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      uuid       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `).run();
  stepResults.s5 = 'OK';
  console.log('[v8-migrate] Step  6/12  S5    CREATE TABLE install_config_kv — OK');

  // Step 7 — S6: CREATE TABLE install_secrets_kv
  db.prepare(`
    CREATE TABLE IF NOT EXISTS install_secrets_kv (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      uuid       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `).run();
  stepResults.s6 = 'OK';
  console.log('[v8-migrate] Step  7/12  S6    CREATE TABLE install_secrets_kv — OK');

  // Steps 8–11 — S7: Recreate station_config_kv without DEFAULT 0

  // Pre-S7 backfill (M8 pulled into Commit 1): any rows with null UUIDs
  // or null timestamps get cleaned up before the destructive table
  // recreation. The new schema's uuid TEXT NOT NULL constraint requires
  // every row have a UUID. Rows broken by pre-v8 INSERT paths get fixed
  // here so the migration can proceed atomically. This handles the
  // 4 null-UUID rows surfaced in OV's data and any equivalent rows in
  // customer installs.

  const crypto = require('crypto');
  const nullUuidRows = db.prepare(
    'SELECT rowid, station_id, key FROM station_config_kv WHERE uuid IS NULL'
  ).all();

  if (nullUuidRows.length > 0) {
    console.log(`[v8-migrate] Pre-S7 backfill: ${nullUuidRows.length} rows with null UUIDs, generating`);
    const now = new Date().toISOString();
    const updateStmt = db.prepare(
      'UPDATE station_config_kv SET uuid = ?, created_at = COALESCE(created_at, ?), updated_at = COALESCE(updated_at, ?) WHERE rowid = ?'
    );
    for (const row of nullUuidRows) {
      updateStmt.run(crypto.randomUUID(), now, now, row.rowid);
      console.log(`[v8-migrate]   backfilled rowid=${row.rowid} (station_id=${row.station_id}, key=${row.key})`);
    }
    console.log(`[v8-migrate] Pre-S7 backfill: ${nullUuidRows.length} rows updated`);
  } else {
    console.log('[v8-migrate] Pre-S7 backfill: no null UUIDs detected');
  }

  const remainingNulls = db.prepare(
    'SELECT COUNT(*) AS n FROM station_config_kv WHERE uuid IS NULL'
  ).get().n;
  if (remainingNulls > 0) {
    throw new Error(
      `Pre-S7 abort: ${remainingNulls} rows still have uuid IS NULL after backfill. ` +
      'Investigation required before proceeding.'
    );
  }

  const ckvDdl = getDdl(db, 'station_config_kv');
  if (ckvDdl && ckvDdl.includes('DEFAULT 0')) {

    // Step 8 — S7-a: Rename old table
    db.prepare(
      'ALTER TABLE station_config_kv RENAME TO _station_config_kv_old'
    ).run();
    console.log('[v8-migrate] Step  8/12  S7-a  RENAME station_config_kv → _station_config_kv_old — RENAMED');

    // Step 9 — S7-b: Create new table without DEFAULT 0
    db.prepare(`
      CREATE TABLE station_config_kv (
        station_id INTEGER NOT NULL,
        key        TEXT    NOT NULL,
        value      TEXT,
        uuid       TEXT    NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        deleted_at INTEGER,
        PRIMARY KEY (station_id, key)
      )
    `).run();
    console.log('[v8-migrate] Step  9/12  S7-b  CREATE station_config_kv (no DEFAULT 0) — CREATED');

    // Step 10 — S7-c: Copy rows from old table
    const copied = db.prepare(`
      INSERT INTO station_config_kv
        (station_id, key, value, uuid, created_at, updated_at, deleted_at)
      SELECT station_id, key, value, uuid, created_at, updated_at, deleted_at
      FROM _station_config_kv_old
    `).run();
    console.log(`[v8-migrate] Step 10/12  S7-c  copied ${copied.changes} rows into new station_config_kv — OK`);

    // Step 11 — S7-d: Drop old table
    db.prepare('DROP TABLE _station_config_kv_old').run();
    console.log('[v8-migrate] Step 11/12  S7-d  DROP _station_config_kv_old — DROPPED');

    stepResults.s7 = `swapped (${copied.changes} rows)`;

  } else {
    stepResults.s7 = 'SKIP (DEFAULT 0 already absent)';
    console.log('[v8-migrate] Steps 8-11  S7    station_config_kv — SKIP (DEFAULT 0 already absent)');
  }

  // Step 12 — schema_version bump
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (8)').run();
  stepResults.version = 'INSERTED';
  console.log('[v8-migrate] Step 12/12        INSERT schema_version = 8 — DONE');

  return stepResults;
});

let results;
try {
  results = migrate();
  console.log('');
  console.log('[v8-migrate] Transaction committed.');
} catch (err) {
  console.error('');
  console.error('[v8-migrate] ERROR — transaction rolled back:', err.message);
  db.close();
  process.exit(1);
}

// ── Post-migration verification ───────────────────────────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log('VERIFICATION');
console.log('═'.repeat(60));
console.log('');

let allPassed = true;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`[v8-migrate] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`             expected: ${JSON.stringify(expected)}`);
    console.log(`             actual:   ${JSON.stringify(actual)}`);
    allPassed = false;
  }
}

// V1: schema_version = 8 present
const postVersions = db.prepare(
  'SELECT version FROM schema_version ORDER BY version'
).all().map(r => r.version);
check('schema_version contains 8', postVersions.includes(8), true);

// V2: new columns on stations
const postStationColNames = db.prepare('PRAGMA table_info(stations)').all().map(c => c.name);
for (const col of ['icecast_port', 'audio_device_output', 'mic_device', 'mount_pending_provision']) {
  check(`stations.${col} exists`, postStationColNames.includes(col), true);
}

// V3: new tables exist
for (const t of ['monitor_routing', 'install_config_kv', 'install_secrets_kv']) {
  check(`table ${t} exists`, tableExists(db, t), true);
}

// V4: station_config_kv DDL has no DEFAULT 0
const postCkvDdl = getDdl(db, 'station_config_kv');
check(
  'station_config_kv DDL has no DEFAULT 0',
  postCkvDdl ? !postCkvDdl.includes('DEFAULT 0') : false,
  true
);

// V5: _station_config_kv_old cleaned up
check('_station_config_kv_old absent', tableExists(db, '_station_config_kv_old'), false);

// V6: station_config_kv row count (informational — data must survive the swap)
const ckvCount = db.prepare('SELECT COUNT(*) AS n FROM station_config_kv').get().n;
console.log(`[v8-migrate] INFO  station_config_kv rows after migration: ${ckvCount}`);

// ── Post-migration snapshot ───────────────────────────────────────────────────

const postStationCols = db.prepare('PRAGMA table_info(stations)').all();
const postAllTables   = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all().map(r => r.name);

const postLines = [
  'v8 migration — post-migration snapshot',
  `Generated: ${new Date().toISOString()}`,
  `DB path: ${dbPath}`,
  '',
  '── schema_version ──────────────────────────────────────────',
  'Versions: ' + postVersions.join(', '),
  '',
  '── PRAGMA table_info(stations) ─────────────────────────────',
  ...postStationCols.map(c =>
    `  ${c.name.padEnd(30)} ${c.type.padEnd(15)}${c.dflt_value != null ? ' DEFAULT ' + c.dflt_value : ''}`
  ),
  '',
  '── station_config_kv DDL ───────────────────────────────────',
  postCkvDdl || '(not found)',
  '',
  '── all tables ──────────────────────────────────────────────',
  postAllTables.join(', '),
  '',
  '── new tables ──────────────────────────────────────────────',
  ...['monitor_routing', 'install_config_kv', 'install_secrets_kv'].map(
    t => `  ${t}: ${tableExists(db, t) ? 'EXISTS' : 'MISSING'}`
  ),
  '',
];
const postText = postLines.join('\n');

console.log('');
console.log('═'.repeat(60));
console.log('POST-MIGRATION SNAPSHOT');
console.log('═'.repeat(60));
console.log(postText);

const postFile = path.join(snapshotDir, 'post-migration-snapshot-v8.txt');
fs.writeFileSync(postFile, postText, 'utf8');
console.log('[v8-migrate] Post-migration snapshot written:', postFile);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log('═'.repeat(60));
if (allPassed) {
  console.log('[v8-migrate] Migration complete. All verification checks PASSED. ✓');
  console.log('');
  console.log('Next steps:');
  console.log('  Commit 2 — data migration: scripts/migrate-phase-a-v8-data.js');
  console.log('  Commit 3 — code rewires: C1–C4 callsite updates');
  console.log('  Commit 4 — new typed handlers: C5–C9');
  console.log('  Commit 5 — verification + gate lift');
} else {
  console.error('[v8-migrate] Migration committed but some verification checks FAILED.');
  console.error('[v8-migrate] Inspect snapshot files and DB state before proceeding.');
}

db.close();
process.exit(allPassed ? 0 : 1);
