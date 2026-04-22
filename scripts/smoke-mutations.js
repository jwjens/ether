// scripts/smoke-mutations.js — smoke test scaffold for sync-ready 3/7 A2.2 infrastructure
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/smoke-mutations.js
// Read-only. Does NOT modify the DB.
// Verifies the mutations/client_identity/system_state tables created by migrate-mutations-phase-sync-3.js.

'use strict';

const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');

if (!fs.existsSync(dbPath)) {
  console.error('[smoke-mutations] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

// ── Expected shape ────────────────────────────────────────────

const EXPECTED_MUTATIONS_COLUMNS = [
  'id',
  'client_id',
  'station_id',
  'actor_id',
  'table_name',
  'row_id',
  'op',
  'payload_before',
  'payload_after',
  'created_at',
  'applied_at',
  'hlc',
  'parent_mutation_id',
  'schema_version',
  'origin',
  'sync_status',
  'conflict_resolution',
];

const REQUIRED_INDEXES = [
  'idx_mutations_table_row_hlc',
  'idx_mutations_client_hlc',
  'idx_mutations_station_created',
  'idx_mutations_sync_status',
  'idx_mutations_created',
];

// RFC 4122 UUID v4 regex
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// HLC format: <wall>:<logical>:<client_uuid>
const HLC_RE = /^\d+:\d+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Test harness ──────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function pass(label) {
  console.log(`  PASS  ${label}`);
  passed++;
}

function fail(label, detail) {
  const msg = detail ? `${label} — ${detail}` : label;
  console.error(`  FAIL  ${msg}`);
  failures.push(msg);
  failed++;
}

function section(title) {
  console.log('');
  console.log('═'.repeat(60));
  console.log(title);
  console.log('═'.repeat(60));
}

// ── Check 1: schema_version includes 3 ───────────────────────

section('CHECK 1 — schema_version includes 3');

const svRows = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log('  schema_version rows:', JSON.stringify(svRows));

if (svRows.includes(3)) {
  pass('schema_version contains 3');
} else {
  fail('schema_version does not contain 3', `got ${JSON.stringify(svRows)}`);
}

// ── Check 2: mutations table — 17 columns with expected names ─

section('CHECK 2 — mutations table has 17 columns with expected names');

const mutTable = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='mutations'"
).get();

if (!mutTable) {
  fail('mutations table does not exist in sqlite_master');
} else {
  pass('mutations table exists');

  const actualCols = db.prepare("PRAGMA table_info('mutations')").all().map(c => c.name);
  console.log('  actual columns:', JSON.stringify(actualCols));
  console.log('  column count:', actualCols.length);

  if (actualCols.length !== 17) {
    fail(`mutations column count`, `expected 17, got ${actualCols.length}`);
  } else {
    pass('mutations has exactly 17 columns');
  }

  for (const col of EXPECTED_MUTATIONS_COLUMNS) {
    if (!actualCols.includes(col)) {
      fail(`mutations column missing: ${col}`);
    }
  }
  const extraCols = actualCols.filter(c => !EXPECTED_MUTATIONS_COLUMNS.includes(c));
  for (const col of extraCols) {
    fail(`mutations has unexpected column: ${col}`);
  }
  if (EXPECTED_MUTATIONS_COLUMNS.every(c => actualCols.includes(c)) && extraCols.length === 0) {
    pass('all 17 column names match expected list');
  }
}

// ── Check 3: client_identity — 1 row, valid UUID ──────────────

section('CHECK 3 — client_identity has 1 row with valid RFC 4122 UUID');

const ciTable = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='client_identity'"
).get();

if (!ciTable) {
  fail('client_identity table does not exist');
} else {
  pass('client_identity table exists');

  const ciRows = db.prepare('SELECT * FROM client_identity').all();
  console.log('  row count:', ciRows.length);

  if (ciRows.length !== 1) {
    fail(`client_identity row count`, `expected 1, got ${ciRows.length}`);
  } else {
    pass('client_identity has exactly 1 row');

    const row = ciRows[0];
    console.log('  id:', row.id);
    console.log('  client_id:', row.client_id);
    console.log('  created_at:', row.created_at);
    console.log('  label:', row.label);

    if (row.id !== 1) {
      fail(`client_identity.id`, `expected 1, got ${row.id}`);
    } else {
      pass('client_identity.id = 1');
    }

    if (!row.client_id || !UUID_RE.test(row.client_id)) {
      fail('client_identity.client_id is not a valid RFC 4122 UUID', `got "${row.client_id}"`);
    } else {
      pass(`client_identity.client_id is valid UUID (${row.client_id})`);
    }

    if (!row.created_at || !/^\d{4}-\d{2}-\d{2}T/.test(row.created_at)) {
      fail('client_identity.created_at is not ISO 8601', `got "${row.created_at}"`);
    } else {
      pass(`client_identity.created_at is ISO 8601 (${row.created_at})`);
    }
  }
}

// ── Check 4: system_state hlc_last format ─────────────────────

section("CHECK 4 — system_state has hlc_last with valid HLC format");

const ssTable = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='system_state'"
).get();

if (!ssTable) {
  fail('system_state table does not exist');
} else {
  pass('system_state table exists');

  const hlcRow = db.prepare("SELECT value FROM system_state WHERE key='hlc_last'").get();

  if (!hlcRow) {
    fail("system_state has no row with key='hlc_last'");
  } else {
    console.log('  hlc_last value:', hlcRow.value);

    if (HLC_RE.test(hlcRow.value)) {
      pass(`system_state.hlc_last matches HLC format (${hlcRow.value})`);
    } else {
      fail("system_state.hlc_last does not match HLC regex /^\\d+:\\d+:<uuid>$/", `got "${hlcRow.value}"`);
    }

    // Cross-check: hlc_last UUID component must match client_identity.client_id
    const ciRow = db.prepare('SELECT client_id FROM client_identity').get();
    if (ciRow) {
      const hlcClientId = hlcRow.value.split(':').slice(2).join(':');
      if (hlcClientId === ciRow.client_id) {
        pass(`hlc_last UUID component matches client_identity.client_id`);
      } else {
        fail('hlc_last UUID component does not match client_identity.client_id',
          `hlc has "${hlcClientId}", client_identity has "${ciRow.client_id}"`);
      }
    }
  }
}

// ── Check 5: all 5 required indexes exist ─────────────────────

section('CHECK 5 — all 5 required indexes exist [N-13]');

for (const idx of REQUIRED_INDEXES) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
  ).get(idx);
  if (row) {
    pass(`index exists: ${idx}`);
  } else {
    fail(`index MISSING: ${idx}`);
  }
}

// ── Summary ───────────────────────────────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('All infrastructure checks PASSED ✓');
  console.log('═'.repeat(60));
  db.close();
  process.exit(0);
} else {
  console.error('FAILURES:');
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  console.log('═'.repeat(60));
  db.close();
  process.exit(1);
}
