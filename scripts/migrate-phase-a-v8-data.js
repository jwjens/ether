// scripts/migrate-phase-a-v8-data.js — Phase A v8 data migration (Commit 2 of 5)
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v8-data.js
// Dry-run:  node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v8-data.js --dry-run
//
// Requires schema_version=8 (scripts/migrate-phase-a-v8.js must have run first).
//
// Lean Commit 2: only M5 (stations.uuid backfill for id=3) and M6 (distinct icecast mounts
// /ov and /usph) ship in this commit. These are the two data fixes that directly unblock
// multi-station streaming. M1–M4 and M7 are deferred — they are architectural cleanup that
// becomes valuable alongside Commit 3's code rewires but doesn't block the single-station MVP
// path. Shipping the data changes without the corresponding code changes would cause
// user-visible glitches (license appearing inactive, first-run wizard reappearing, etc.)
// between Commit 2 and Commit 3.
//
//   M5 — Backfill stations.uuid for id=3 if NULL
//   M6 — Set distinct icecast mounts: id=1 → '/ov', id=3 → '/usph'
//
// Deferred to Commit 3 (ships alongside code rewires C1–C4):
//   M1 — Move 8 install-level keys: station_config_kv → install_config_kv
//   M2 — Move secrets: station_config_kv → install_secrets_kv
//   M3 — Delete 3 orphan rows at station_id=0 (canvas_layout, last_operator_id, station_logo)
//   M4 — Theme row cleanup (deferred further — see Open Item #9 in migration plan)
//   M7 — eq_deck_*/eq_master integrity check
//
// NOTE: icecast_admin_credentials seeding is deferred to Step 4.5.

'use strict';

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

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

function truncVal(v, n) {
  if (v == null) return '(null)';
  const s = String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── Announce ──────────────────────────────────────────────────────────────────

console.log('[v8-data] DB path:', dbPath);
if (DRY_RUN) console.log('[v8-data] DRY-RUN mode — no changes will be committed');
console.log('');

// ── Pre-flight 1: DB file exists ──────────────────────────────────────────────

if (!fs.existsSync(dbPath)) {
  console.error('[v8-data] ERROR: DB not found at', dbPath);
  process.exit(1);
}

// ── Open DB ───────────────────────────────────────────────────────────────────

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath);

// ── Pre-flight 2: schema_version=8 present + stations table exists ────────────

const versions = db.prepare(
  'SELECT version FROM schema_version ORDER BY version'
).all().map(r => r.version);

console.log('═'.repeat(60));
console.log('PRE-FLIGHT CHECKS');
console.log('═'.repeat(60));

if (!versions.includes(8)) {
  console.error('[v8-data] ERROR: schema_version=8 not found.');
  console.error('[v8-data] Run scripts/migrate-phase-a-v8.js (Commit 1) first.');
  db.close();
  process.exit(1);
}
console.log('[v8-data] PASS: schema_version=8 present');

if (!tableExists(db, 'stations')) {
  console.error('[v8-data] ERROR: required table \'stations\' not found');
  db.close();
  process.exit(1);
}
console.log('[v8-data] PASS: stations table present');
console.log('');

// ── Backup DB file before any writes ─────────────────────────────────────────

if (!DRY_RUN) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = dbPath.replace('.db', `-backup-pre-v8-data-${ts}.db`);
  fs.copyFileSync(dbPath, backupPath);
  console.log('[v8-data] DB backup written:', backupPath);
  console.log('');
}

// ── Pre-migration snapshot ────────────────────────────────────────────────────

const preStations = db.prepare(
  'SELECT id, name, icecast_mount, uuid FROM stations ORDER BY id'
).all();

const preLines = [
  'v8 data migration — pre-migration snapshot',
  `Generated: ${new Date().toISOString()}`,
  `DB path: ${dbPath}`,
  '',
  '── schema_version ──────────────────────────────────────────',
  'Versions: ' + versions.join(', '),
  '',
  '── stations (pre) ──────────────────────────────────────────',
  ...preStations.map(r =>
    `  id=${r.id}  name=${truncVal(r.name, 24)}  mount=${r.icecast_mount || '(null)'}  uuid=${r.uuid ? r.uuid.slice(0, 8) + '…' : 'NULL'}`
  ),
  '',
];
const preText = preLines.join('\n');

console.log('═'.repeat(60));
console.log('PRE-MIGRATION SNAPSHOT');
console.log('═'.repeat(60));
console.log(preText);

if (!DRY_RUN) {
  const preFile = path.join(snapshotDir, 'pre-migration-snapshot-v8-data.txt');
  fs.writeFileSync(preFile, preText, 'utf8');
  console.log('[v8-data] Pre-migration snapshot written:', preFile);
  console.log('');
}

// ── Dry-run plan ──────────────────────────────────────────────────────────────

if (DRY_RUN) {
  console.log('═'.repeat(60));
  console.log('DRY-RUN PLAN');
  console.log('═'.repeat(60));
  console.log('');

  // M5
  const st3 = db.prepare('SELECT id, uuid FROM stations WHERE id = 3').get();
  console.log('M5 — stations.uuid backfill for id=3:');
  if (!st3) {
    console.log('  SKIP — station id=3 not found');
  } else if (st3.uuid) {
    console.log(`  SKIP — uuid already set: ${st3.uuid.slice(0, 16)}…`);
  } else {
    console.log('  WILL SET uuid (currently NULL)');
  }
  console.log('');

  // M6
  console.log('M6 — icecast_mount update:');
  for (const { id, target } of [{ id: 1, target: '/ov' }, { id: 3, target: '/usph' }]) {
    const st = db.prepare('SELECT icecast_mount FROM stations WHERE id = ?').get(id);
    if (!st) {
      console.log(`  SKIP — station id=${id} not found`);
    } else if (st.icecast_mount === target) {
      console.log(`  SKIP — station id=${id} already '${target}'`);
    } else {
      console.log(`  UPDATE station id=${id}: '${st.icecast_mount}' → '${target}'`);
    }
  }
  console.log('');

  console.log('[v8-data] Dry-run complete. No changes made.');
  console.log('[v8-data] Remove --dry-run to execute.');
  db.close();
  process.exit(0);
}

// ── Migration transaction ─────────────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('RUNNING MIGRATION');
console.log('═'.repeat(60));
console.log('');

const migrationResults = {};
const now = new Date().toISOString();

const migrate = db.transaction(() => {

  // ── M5 — stations.uuid backfill for id=3 ─────────────────────────────────

  console.log('[v8-data] M5: stations.uuid backfill for id=3');
  const st3 = db.prepare('SELECT id, uuid FROM stations WHERE id = 3').get();
  if (st3 && st3.uuid == null) {
    const newUuid = crypto.randomUUID();
    db.prepare(
      'UPDATE stations SET uuid = ?, updated_at = ? WHERE id = 3 AND uuid IS NULL'
    ).run(newUuid, now);
    console.log(`[v8-data]   SET uuid=${newUuid}`);
    migrationResults.m5 = `backfilled: ${newUuid}`;
  } else if (!st3) {
    console.log('[v8-data]   SKIP — station id=3 not found');
    migrationResults.m5 = 'skip: not found';
  } else {
    console.log(`[v8-data]   SKIP — uuid already set: ${st3.uuid.slice(0, 16)}…`);
    migrationResults.m5 = 'skip: already set';
  }
  console.log('');

  // ── M6 — Distinct icecast mounts ─────────────────────────────────────────

  console.log('[v8-data] M6: set distinct icecast mounts');
  for (const { id, mount } of [{ id: 1, mount: '/ov' }, { id: 3, mount: '/usph' }]) {
    const st = db.prepare('SELECT icecast_mount FROM stations WHERE id = ?').get(id);
    if (!st) {
      console.log(`[v8-data]   SKIP — station id=${id} not found`);
    } else {
      db.prepare('UPDATE stations SET icecast_mount = ?, updated_at = ? WHERE id = ?').run(mount, now, id);
      const changed = st.icecast_mount !== mount;
      console.log(`[v8-data]   station id=${id}: '${st.icecast_mount}' → '${mount}' — ${changed ? 'UPDATED' : 'no change'}`);
    }
  }
  migrationResults.m6 = 'done';
  console.log('');

  return migrationResults;
});

let results;
try {
  results = migrate();
  console.log('[v8-data] Transaction committed.');
  console.log('');
} catch (err) {
  console.error('[v8-data] ERROR — transaction rolled back:', err.message);
  db.close();
  process.exit(1);
}

// ── Post-migration verification ───────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('VERIFICATION');
console.log('═'.repeat(60));
console.log('');

let allPassed = true;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`[v8-data] ${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`           expected: ${JSON.stringify(expected)}`);
    console.log(`           actual:   ${JSON.stringify(actual)}`);
    allPassed = false;
  }
}

// V5: stations id=3 uuid non-null
console.log('[v8-data] V5 — stations id=3 uuid:');
const st3Post = db.prepare('SELECT uuid FROM stations WHERE id = 3').get();
if (st3Post) {
  check('  stations id=3 uuid NOT NULL', st3Post.uuid != null, true);
} else {
  console.log('[v8-data] INFO   station id=3 not found — V5 skipped');
}
console.log('');

// V6: distinct icecast mounts
console.log('[v8-data] V6 — icecast mounts:');
const mountRows = db.prepare(
  'SELECT id, icecast_mount FROM stations WHERE id IN (1, 3) ORDER BY id'
).all();
const mountMap = new Map(mountRows.map(r => [r.id, r.icecast_mount]));
if (mountMap.has(1)) check("  station id=1 mount='/ov'",   mountMap.get(1), '/ov');
if (mountMap.has(3)) check("  station id=3 mount='/usph'", mountMap.get(3), '/usph');
console.log('');

// ── Post-migration snapshot ───────────────────────────────────────────────────

const postStations = db.prepare(
  'SELECT id, name, icecast_mount, uuid FROM stations ORDER BY id'
).all();
const postVersions = db.prepare(
  'SELECT version FROM schema_version ORDER BY version'
).all().map(r => r.version);

const postLines = [
  'v8 data migration — post-migration snapshot',
  `Generated: ${new Date().toISOString()}`,
  `DB path: ${dbPath}`,
  '',
  '── schema_version ──────────────────────────────────────────',
  'Versions: ' + postVersions.join(', '),
  '',
  '── stations (post) ─────────────────────────────────────────',
  ...postStations.map(r =>
    `  id=${r.id}  name=${truncVal(r.name, 24)}  mount=${r.icecast_mount || '(null)'}  uuid=${r.uuid ? r.uuid.slice(0, 16) + '…' : 'NULL'}`
  ),
  '',
  '── migration results ───────────────────────────────────────',
  `  M5: ${results.m5}`,
  `  M6: ${results.m6}`,
  '',
  '── deferred (ships with Commit 3) ──────────────────────────',
  '  M1: install-level keys → install_config_kv',
  '  M2: secrets → install_secrets_kv',
  '  M3: orphan row deletion at station_id=0',
  '  M4: theme row cleanup (Open Item #9)',
  '  M7: eq_deck_*/eq_master integrity check',
  '',
];
const postText = postLines.join('\n');

console.log('═'.repeat(60));
console.log('POST-MIGRATION SNAPSHOT');
console.log('═'.repeat(60));
console.log(postText);

const postFile = path.join(snapshotDir, 'post-migration-snapshot-v8-data.txt');
fs.writeFileSync(postFile, postText, 'utf8');
console.log('[v8-data] Post-migration snapshot written:', postFile);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log('═'.repeat(60));
if (allPassed) {
  console.log('[v8-data] Data migration complete. All verification checks PASSED. ✓');
  console.log('');
  console.log('Next steps:');
  console.log('  Commit 3 — code rewires: C1–C4 callsite updates + M1/M2/M3/M7 data migration');
  console.log('  Commit 4 — new typed handlers: C5–C9');
  console.log('  Commit 5 — verification + gate lift');
} else {
  console.error('[v8-data] Data migration committed but some verification checks FAILED.');
  console.error('[v8-data] Inspect snapshot and DB state before proceeding.');
}

db.close();
process.exit(allPassed ? 0 : 1);
