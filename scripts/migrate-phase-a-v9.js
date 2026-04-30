// scripts/migrate-phase-a-v9.js — Phase A v9 schema migration
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v9.js
// Dry-run:  node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v9.js --dry-run
//
// Two changes in one transaction:
//   M1 — Change stations.icecast_server_url DEFAULT '127.0.0.1' → DEFAULT NULL
//        (SQLite cannot ALTER a column default; requires table recreation)
//   M2 — Update all stations rows where icecast_server_url = '127.0.0.1'
//        to '44.244.52.207' (the live Icecast server)
//
// Table recreation steps (S1–S5):
//   S1 — RENAME stations → _stations_old
//   S2 — CREATE stations with icecast_server_url TEXT DEFAULT NULL
//   S3 — INSERT SELECT from _stations_old, replacing '127.0.0.1' → '44.244.52.207'
//   S4 — DROP _stations_old
//   S5 — Recreate idx_stations_uuid
//   S6 — INSERT schema_version = 9

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

function indexExists(db, name) {
  return !!db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
  ).get(name);
}

// ── Announce ──────────────────────────────────────────────────────────────────

console.log('[v9-migrate] DB path:', dbPath);
if (DRY_RUN) console.log('[v9-migrate] DRY-RUN mode — no changes will be committed');
console.log('');

// ── Pre-flight 1: DB file exists ──────────────────────────────────────────────

if (!fs.existsSync(dbPath)) {
  console.error('[v9-migrate] ERROR: DB not found at', dbPath);
  process.exit(1);
}

// ── Open DB ───────────────────────────────────────────────────────────────────

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath);

// ── Backup DB file before any writes ─────────────────────────────────────────

if (!DRY_RUN) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = dbPath.replace('.db', `-backup-pre-v9-${ts}.db`);
  fs.copyFileSync(dbPath, backupPath);
  console.log('[v9-migrate] DB backup written:', backupPath);
  console.log('');
}

// ── Pre-migration snapshot ────────────────────────────────────────────────────

const currentVersions = db.prepare(
  'SELECT version FROM schema_version ORDER BY version'
).all().map(r => r.version);

const preStationCols = db.prepare('PRAGMA table_info(stations)').all();
const preStationsDdl = getDdl(db, 'stations');
const preAllTables   = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all().map(r => r.name);
const preStationRows = db.prepare(
  'SELECT id, name, icecast_server_url FROM stations ORDER BY id'
).all();

const preLines = [
  'v9 migration — pre-migration snapshot',
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
  '── stations.icecast_server_url values ──────────────────────',
  ...preStationRows.map(r =>
    `  id=${r.id}  name="${r.name}"  icecast_server_url=${JSON.stringify(r.icecast_server_url)}`
  ),
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
  const preFile = path.join(snapshotDir, 'pre-migration-snapshot-v9.txt');
  fs.writeFileSync(preFile, preText, 'utf8');
  console.log('[v9-migrate] Pre-migration snapshot written:', preFile);
  console.log('');
}

// ── Pre-flight 2: version checks ──────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('PRE-FLIGHT CHECKS');
console.log('═'.repeat(60));

if (currentVersions.includes(9)) {
  console.log('[v9-migrate] Schema version 9 already applied — nothing to do.');
  db.close();
  process.exit(0);
}

const missingVersions = [1, 2, 3, 4, 5, 6, 7, 8].filter(v => !currentVersions.includes(v));
if (missingVersions.length > 0) {
  console.error('[v9-migrate] ERROR: Missing prerequisite schema versions:', missingVersions.join(', '));
  console.error('[v9-migrate] All migrations v1–v8 must be applied before v9.');
  db.close();
  process.exit(1);
}
console.log('[v9-migrate] PASS: schema versions v1–v8 present');

// Pre-flight 3: partial run guard — _stations_old must not exist
if (tableExists(db, '_stations_old')) {
  console.error('[v9-migrate] ERROR: _stations_old table exists.');
  console.error('             This indicates a partial prior run of the S1 table rename.');
  console.error('             Manual inspection required:');
  console.error('               SELECT COUNT(*) FROM _stations_old;');
  console.error('               SELECT COUNT(*) FROM stations;');
  db.close();
  process.exit(1);
}
console.log('[v9-migrate] PASS: no partial run remnant (_stations_old absent)');

// Pre-flight 4: required table present
if (!tableExists(db, 'stations')) {
  console.error("[v9-migrate] ERROR: required table 'stations' not found");
  db.close();
  process.exit(1);
}
console.log('[v9-migrate] PASS: stations table present');
console.log('');

// ── Dry-run: print plan and exit ──────────────────────────────────────────────

if (DRY_RUN) {
  console.log('═'.repeat(60));
  console.log('DRY-RUN PLAN');
  console.log('═'.repeat(60));
  console.log('');

  const affectedRows = db.prepare(
    "SELECT COUNT(*) AS n FROM stations WHERE icecast_server_url = '127.0.0.1'"
  ).get().n;
  const totalRows = db.prepare('SELECT COUNT(*) AS n FROM stations').get().n;
  const needsDefaultFix = preStationsDdl && preStationsDdl.includes("DEFAULT '127.0.0.1'");

  const plan = [
    { label: `S1     RENAME stations → _stations_old`,                                  needed: true },
    { label: `S2     CREATE stations with icecast_server_url TEXT DEFAULT NULL`,         needed: needsDefaultFix },
    { label: `S3     INSERT SELECT (${totalRows} rows, ${affectedRows} url-rewritten)`, needed: true },
    { label: `S4     DROP _stations_old`,                                                needed: true },
    { label: `S5     Recreate idx_stations_uuid`,                                        needed: true },
    { label: `S6     INSERT schema_version = 9`,                                         needed: true },
  ];

  for (const p of plan) {
    console.log(`  ${p.needed ? 'WILL RUN' : 'SKIP    '} ${p.label}`);
  }

  console.log('');
  console.log('[v9-migrate] Dry-run complete. No changes made.');
  console.log('[v9-migrate] Remove --dry-run to execute.');
  db.close();
  process.exit(0);
}

// ── Migration transaction ─────────────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('RUNNING MIGRATION');
console.log('═'.repeat(60));
console.log('');

// SQLite 12-step table recreation requires FK enforcement to be OFF for the
// entire rename/create/copy/drop sequence. Re-enabled after commit.
db.pragma('foreign_keys = OFF');
console.log('[v9-migrate] foreign_keys pragma set OFF for table recreation');

// legacy_alter_table = ON prevents SQLite ≥3.26 from auto-rewriting FK
// references in other tables/triggers when we RENAME stations → _stations_old.
// Without this, triggers that reference 'stations' get rewritten to reference
// '_stations_old', breaking them permanently after we DROP the old table.
db.pragma('legacy_alter_table = ON');
console.log('[v9-migrate] legacy_alter_table pragma set ON (suppress FK rewrite on RENAME)');

const stepResults = {};

const migrate = db.transaction(() => {

  // Step 1 — S1: Rename stations → _stations_old
  db.prepare('ALTER TABLE stations RENAME TO _stations_old').run();
  stepResults.s1 = 'RENAMED';
  console.log('[v9-migrate] Step 1/6  S1  RENAME stations → _stations_old — RENAMED');

  // Step 2 — S2: Create new stations with icecast_server_url DEFAULT NULL
  db.prepare(`
    CREATE TABLE stations (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      name                    TEXT NOT NULL,
      callsign                TEXT,
      frequency               TEXT,
      city                    TEXT,
      state                   TEXT,
      country                 TEXT DEFAULT 'US',
      website                 TEXT,
      is_active               INTEGER DEFAULT 1,
      created_at              INTEGER DEFAULT (unixepoch()),
      icecast_server_url      TEXT DEFAULT NULL,
      icecast_mount           TEXT DEFAULT '/live',
      icecast_password        TEXT DEFAULT 'hackme',
      icecast_bitrate         INTEGER DEFAULT 128,
      icecast_format          TEXT DEFAULT 'mp3',
      uuid                    TEXT,
      updated_at              TEXT,
      deleted_at              TEXT,
      icecast_port            INTEGER DEFAULT 8000,
      audio_device_output     TEXT,
      mic_device              TEXT,
      mount_pending_provision INTEGER NOT NULL DEFAULT 1
    )
  `).run();
  stepResults.s2 = 'CREATED';
  console.log('[v9-migrate] Step 2/6  S2  CREATE stations (icecast_server_url DEFAULT NULL) — CREATED');

  // Step 3 — S3: INSERT SELECT with url rewrite
  const inserted = db.prepare(`
    INSERT INTO stations (
      id, name, callsign, frequency, city, state, country, website,
      is_active, created_at,
      icecast_server_url,
      icecast_mount, icecast_password, icecast_bitrate, icecast_format,
      uuid, updated_at, deleted_at, icecast_port, audio_device_output,
      mic_device, mount_pending_provision
    )
    SELECT
      id, name, callsign, frequency, city, state, country, website,
      is_active, created_at,
      CASE
        WHEN icecast_server_url = '127.0.0.1' THEN '44.244.52.207'
        ELSE icecast_server_url
      END,
      icecast_mount, icecast_password, icecast_bitrate, icecast_format,
      uuid, updated_at, deleted_at, icecast_port, audio_device_output,
      mic_device, mount_pending_provision
    FROM _stations_old
  `).run();
  stepResults.s3 = `${inserted.changes} rows`;
  console.log(`[v9-migrate] Step 3/6  S3  INSERT SELECT (${inserted.changes} rows, url rewritten) — OK`);

  // Step 4 — S4: Drop old table
  db.prepare('DROP TABLE _stations_old').run();
  stepResults.s4 = 'DROPPED';
  console.log('[v9-migrate] Step 4/6  S4  DROP _stations_old — DROPPED');

  // Step 5 — S5: Recreate idx_stations_uuid
  db.prepare(
    'CREATE UNIQUE INDEX "idx_stations_uuid" ON "stations"(uuid)'
  ).run();
  stepResults.s5 = 'CREATED';
  console.log('[v9-migrate] Step 5/6  S5  CREATE UNIQUE INDEX idx_stations_uuid — CREATED');

  // Step 6 — S6: schema_version bump
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (9)').run();
  stepResults.version = 'INSERTED';
  console.log('[v9-migrate] Step 6/6  S6  INSERT schema_version = 9 — DONE');

  return stepResults;
});

let results;
try {
  results = migrate();
  console.log('');
  console.log('[v9-migrate] Transaction committed.');
} catch (err) {
  console.error('');
  console.error('[v9-migrate] ERROR — transaction rolled back:', err.message);
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
  db.close();
  process.exit(1);
}

db.pragma('legacy_alter_table = OFF');
db.pragma('foreign_keys = ON');
console.log('[v9-migrate] pragmas restored (legacy_alter_table OFF, foreign_keys ON)');

// ── Post-migration verification ───────────────────────────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log('VERIFICATION');
console.log('═'.repeat(60));
console.log('');

let allPassed = true;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`[v9-migrate] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`             expected: ${JSON.stringify(expected)}`);
    console.log(`             actual:   ${JSON.stringify(actual)}`);
    allPassed = false;
  }
}

// V1: schema_version = 9 present
const postVersions = db.prepare(
  'SELECT version FROM schema_version ORDER BY version'
).all().map(r => r.version);
check('schema_version contains 9', postVersions.includes(9), true);

// V2: stations DDL has no DEFAULT '127.0.0.1'
const postDdl = getDdl(db, 'stations');
check(
  "stations DDL has no DEFAULT '127.0.0.1'",
  postDdl ? !postDdl.includes("DEFAULT '127.0.0.1'") : false,
  true
);

// V3: no stations rows with icecast_server_url = '127.0.0.1'
const localhostCount = db.prepare(
  "SELECT COUNT(*) AS n FROM stations WHERE icecast_server_url = '127.0.0.1'"
).get().n;
check('no stations rows with icecast_server_url = 127.0.0.1', localhostCount, 0);

// V4: idx_stations_uuid present
check('idx_stations_uuid index exists', indexExists(db, 'idx_stations_uuid'), true);

// V5: _stations_old cleaned up
check('_stations_old absent', tableExists(db, '_stations_old'), false);

// INFO: station url values after migration
const postStationRows = db.prepare(
  'SELECT id, name, icecast_server_url FROM stations ORDER BY id'
).all();
console.log('[v9-migrate] INFO  stations.icecast_server_url after migration:');
for (const r of postStationRows) {
  console.log(`[v9-migrate]   id=${r.id}  name="${r.name}"  → ${JSON.stringify(r.icecast_server_url)}`);
}

// ── Post-migration snapshot ───────────────────────────────────────────────────

const postStationCols = db.prepare('PRAGMA table_info(stations)').all();
const postAllTables   = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all().map(r => r.name);

const postLines = [
  'v9 migration — post-migration snapshot',
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
  '── stations.icecast_server_url values ──────────────────────',
  ...postStationRows.map(r =>
    `  id=${r.id}  name="${r.name}"  icecast_server_url=${JSON.stringify(r.icecast_server_url)}`
  ),
  '',
  '── all tables ──────────────────────────────────────────────',
  postAllTables.join(', '),
  '',
];
const postText = postLines.join('\n');

console.log('');
console.log('═'.repeat(60));
console.log('POST-MIGRATION SNAPSHOT');
console.log('═'.repeat(60));
console.log(postText);

const postFile = path.join(snapshotDir, 'post-migration-snapshot-v9.txt');
fs.writeFileSync(postFile, postText, 'utf8');
console.log('[v9-migrate] Post-migration snapshot written:', postFile);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log('═'.repeat(60));
if (allPassed) {
  console.log('[v9-migrate] Migration complete. All verification checks PASSED. ✓');
  console.log('');
  console.log('Next steps:');
  console.log('  Commit A — git add scripts/migrate-phase-a-v9.js scripts/migrate-station-schema-phase-sync-9.js');
  console.log('  Commit B — git add src/components/SettingsPanel.tsx');
} else {
  console.error('[v9-migrate] Migration committed but some verification checks FAILED.');
  console.error('[v9-migrate] Inspect snapshot files and DB state before proceeding.');
}

db.close();
process.exit(allPassed ? 0 : 1);
