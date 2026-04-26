// scripts/smoke-mutations.js — smoke test scaffold for sync-ready 3/7 A2.2 + A2.3 infrastructure
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/smoke-mutations.js
// Checks 1-5: read-only infrastructure checks (A2.2).
// Tests 1-9: writer tests — SAVEPOINT-isolated, zero residue (A2.3 part 2b).

'use strict';

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');

if (!fs.existsSync(dbPath)) {
  console.error('[smoke-mutations] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath);

const writer       = require('../electron/sync/mutation-writer');
const { REGISTRY } = require('../electron/sync/synced-tables');

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

// Current max schema_version — used by writer tests to validate mutation.schema_version
const currentSchemaVersion = svRows[svRows.length - 1];

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

// ══════════════════════════════════════════════════════════════
// WRITER TESTS (SAVEPOINT-isolated, zero residue)
// ══════════════════════════════════════════════════════════════

section('═══ WRITER TESTS (SAVEPOINT-isolated, zero residue) ═══');

// getClientId's module cache survives across tests within a single Node process
// (correct behavior — client_id is stable per [N-79]). No reset needed.

if (db.prepare("SELECT COUNT(*) AS c FROM stations WHERE id=1").get().c !== 1) {
  throw new Error(
    'station_id=1 missing — tests assume single seed station. ' +
    'If seed data has changed, update makeStarterRow defaults and this assertion.'
  );
}

const clientIdentity = db.prepare('SELECT client_id FROM client_identity').get();

function withSavepoint(name, fn) {
  // Each writer test runs inside a SAVEPOINT that is unconditionally rolled back.
  // This isolates tests from each other AND leaves zero residue in the live DB.
  // It also exercises withMutation's composition with an outer transaction:
  // better-sqlite3's db.transaction() promotes to a nested SAVEPOINT when
  // called from inside an existing transaction.
  db.exec('SAVEPOINT ' + name);
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  } finally {
    try { db.exec('ROLLBACK TO SAVEPOINT ' + name); } catch (_) {}
    try { db.exec('RELEASE SAVEPOINT ' + name); } catch (_) {}
  }
  if (threw) throw threw;
}

function makeStarterRow(tableName, overrides = {}) {
  // Returns a row object suitable for INSERT into the given synced table.
  // Generates uuid, station_id, created_at, updated_at, deleted_at automatically.
  // Caller supplies table-specific required fields via overrides.
  const now = new Date().toISOString();
  const baseRow = {
    uuid:       crypto.randomUUID(),
    station_id: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  return Object.assign(baseRow, overrides);
}

// Parse HLC 'wall:logical:uuid' into comparable tuple
function parseHlcTuple(hlc) {
  const parts = hlc.split(':');
  return { wall: parseInt(parts[0], 10), logical: parseInt(parts[1], 10), uuid: parts[2] };
}

function hlcLessThan(a, b) {
  const pa = parseHlcTuple(a), pb = parseHlcTuple(b);
  return pa.wall < pb.wall || (pa.wall === pb.wall && pa.logical < pb.logical);
}

// ── TEST 1: Insert flow ───────────────────────────────────────

section('TEST 1 — Insert flow (withMutation insert logs correct mutation)');

withSavepoint('test_1', () => {
  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  const row = makeStarterRow('cart_slots', { slot_number: 999, title: 'TEST_INSERT', file_path: '/test/path.mp3' });
  const payload_after = writer.serializePayload(row, 'cart_slots');

  writer.withMutation(db, {
    table_name:     'cart_slots',
    row_id:         row.uuid,
    op:             'insert',
    payload_before: null,
    payload_after,
    station_id:     1,
    actor_id:       null,
  }, () => {
    db.prepare(
      'INSERT INTO cart_slots (slot_number, title, file_path, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.slot_number, row.title, row.file_path, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
  });

  const countAfter = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  const rowCount   = db.prepare('SELECT COUNT(*) AS c FROM cart_slots WHERE uuid=?').get(row.uuid).c;
  const mut        = db.prepare('SELECT * FROM mutations WHERE row_id=?').get(row.uuid);

  if (rowCount === 1)                                 pass('TEST 1 — cart_slots row exists after insert');
  else                                                fail('TEST 1 — cart_slots row exists', `count=${rowCount}`);

  if (countAfter === countBefore + 1)                 pass('TEST 1 — mutations count +1');
  else                                                fail('TEST 1 — mutations count +1', `before=${countBefore} after=${countAfter}`);

  if (!mut) { fail('TEST 1 — mutation row not found by row_id'); return; }
  pass('TEST 1 — mutation row found by row_id');

  if (mut.op === 'insert')                            pass('TEST 1 — mutation.op === "insert"');
  else                                                fail('TEST 1 — mutation.op', `expected "insert" got "${mut.op}"`);

  if (mut.payload_before === null)                    pass('TEST 1 — payload_before is null [N-29]');
  else                                                fail('TEST 1 — payload_before should be null', `got "${mut.payload_before}"`);

  if (mut.payload_after !== null && mut.payload_after.includes('TEST_INSERT'))
                                                      pass('TEST 1 — payload_after non-null and contains TEST_INSERT');
  else                                                fail('TEST 1 — payload_after', `got "${mut.payload_after}"`);

  if (mut.station_id === '1')                         pass('TEST 1 — station_id stringified to "1" [Q-14]');
  else                                                fail('TEST 1 — station_id [Q-14]', `expected "1" got "${mut.station_id}"`);

  if (mut.client_id === clientIdentity.client_id)     pass('TEST 1 — client_id matches client_identity');
  else                                                fail('TEST 1 — client_id mismatch', `mut="${mut.client_id}" ci="${clientIdentity.client_id}"`);

  if (HLC_RE.test(mut.hlc))                           pass('TEST 1 — hlc matches HLC format');
  else                                                fail('TEST 1 — hlc format', `got "${mut.hlc}"`);

  if (mut.schema_version === currentSchemaVersion)    pass(`TEST 1 — schema_version === ${currentSchemaVersion}`);
  else                                                fail('TEST 1 — schema_version', `expected ${currentSchemaVersion} got ${mut.schema_version}`);

  if (mut.origin === 'local')                         pass('TEST 1 — origin === "local"');
  else                                                fail('TEST 1 — origin', `expected "local" got "${mut.origin}"`);

  if (mut.sync_status === 'pending')                  pass('TEST 1 — sync_status === "pending"');
  else                                                fail('TEST 1 — sync_status', `expected "pending" got "${mut.sync_status}"`);
});

// ── TEST 2: Update flow ───────────────────────────────────────

section('TEST 2 — Update flow (payload_before captures old state)');

withSavepoint('test_2', () => {
  const row = makeStarterRow('cart_slots', { slot_number: 998, title: 'TEST_ORIGINAL', file_path: '/test/orig.mp3' });
  db.prepare(
    'INSERT INTO cart_slots (slot_number, title, file_path, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(row.slot_number, row.title, row.file_path, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);

  const oldRow     = db.prepare('SELECT * FROM cart_slots WHERE uuid=?').get(row.uuid);
  const oldPayload = writer.serializePayload(oldRow, 'cart_slots');
  const newTitle   = 'TEST_UPDATE';
  const newUpdated = new Date().toISOString();
  const newPayload = writer.serializePayload(
    Object.assign({}, oldRow, { title: newTitle, updated_at: newUpdated }),
    'cart_slots'
  );

  writer.withMutation(db, {
    table_name:     'cart_slots',
    row_id:         row.uuid,
    op:             'update',
    payload_before: oldPayload,
    payload_after:  newPayload,
    station_id:     1,
    actor_id:       null,
  }, () => {
    db.prepare('UPDATE cart_slots SET title=?, updated_at=? WHERE uuid=?').run(newTitle, newUpdated, row.uuid);
  });

  const mut = db.prepare('SELECT * FROM mutations WHERE row_id=?').get(row.uuid);
  if (!mut) { fail('TEST 2 — mutation row not found'); return; }

  if (mut.op === 'update')                            pass('TEST 2 — op === "update"');
  else                                                fail('TEST 2 — op', `expected "update" got "${mut.op}"`);

  const pb = mut.payload_before !== null ? JSON.parse(mut.payload_before) : null;
  if (pb !== null)                                    pass('TEST 2 — payload_before non-null');
  else                                               { fail('TEST 2 — payload_before is null'); return; }

  if (pb.title === 'TEST_ORIGINAL')                   pass('TEST 2 — payload_before.title === "TEST_ORIGINAL"');
  else                                                fail('TEST 2 — payload_before.title', `expected "TEST_ORIGINAL" got "${pb.title}"`);

  const pa = mut.payload_after !== null ? JSON.parse(mut.payload_after) : null;
  if (pa !== null)                                    pass('TEST 2 — payload_after non-null');
  else                                               { fail('TEST 2 — payload_after is null'); return; }

  if (pa.title === 'TEST_UPDATE')                     pass('TEST 2 — payload_after.title === "TEST_UPDATE"');
  else                                                fail('TEST 2 — payload_after.title', `expected "TEST_UPDATE" got "${pa.title}"`);
});

// ── TEST 3: Delete flow ───────────────────────────────────────

section('TEST 3 — Delete flow (payload_after is null) [N-31]');

withSavepoint('test_3', () => {
  const row = makeStarterRow('cart_slots', { slot_number: 997, title: 'TEST_DELETE', file_path: '/test/del.mp3' });
  db.prepare(
    'INSERT INTO cart_slots (slot_number, title, file_path, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(row.slot_number, row.title, row.file_path, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);

  const oldRow     = db.prepare('SELECT * FROM cart_slots WHERE uuid=?').get(row.uuid);
  const oldPayload = writer.serializePayload(oldRow, 'cart_slots');

  writer.withMutation(db, {
    table_name:     'cart_slots',
    row_id:         row.uuid,
    op:             'delete',
    payload_before: oldPayload,
    payload_after:  null,
    station_id:     1,
    actor_id:       null,
  }, () => {
    db.prepare('DELETE FROM cart_slots WHERE uuid=?').run(row.uuid);
  });

  const rowCount = db.prepare('SELECT COUNT(*) AS c FROM cart_slots WHERE uuid=?').get(row.uuid).c;
  const mut      = db.prepare('SELECT * FROM mutations WHERE row_id=?').get(row.uuid);

  if (rowCount === 0)                                 pass('TEST 3 — cart_slots row deleted');
  else                                                fail('TEST 3 — row should be gone', `count=${rowCount}`);

  if (!mut) { fail('TEST 3 — mutation row not found'); return; }

  if (mut.op === 'delete')                            pass('TEST 3 — op === "delete"');
  else                                                fail('TEST 3 — op', `expected "delete" got "${mut.op}"`);

  if (mut.payload_before !== null)                    pass('TEST 3 — payload_before non-null');
  else                                                fail('TEST 3 — payload_before should not be null');

  if (mut.payload_after === null)                     pass('TEST 3 — payload_after is null [N-31]');
  else                                                fail('TEST 3 — payload_after should be null', `got "${mut.payload_after}"`);
});

// ── TEST 4: HLC monotonicity ──────────────────────────────────

section('TEST 4 — HLC monotonicity across 3 sequential mutations [N-43]');

withSavepoint('test_4', () => {
  const hlcs = [];

  for (let i = 0; i < 3; i++) {
    const r  = makeStarterRow('cart_slots', {
      slot_number: 1000 + i,
      title:       'TEST_MONO_' + i,
      file_path:   '/test/mono_' + i + '.mp3',
    });
    const pa = writer.serializePayload(r, 'cart_slots');
    writer.withMutation(db, {
      table_name:     'cart_slots',
      row_id:         r.uuid,
      op:             'insert',
      payload_before: null,
      payload_after:  pa,
      station_id:     1,
      actor_id:       null,
    }, () => {
      db.prepare(
        'INSERT INTO cart_slots (slot_number, title, file_path, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(r.slot_number, r.title, r.file_path, r.station_id, r.uuid, r.created_at, r.updated_at, r.deleted_at);
    });
    const m = db.prepare('SELECT hlc FROM mutations WHERE row_id=?').get(r.uuid);
    if (!m) { fail(`TEST 4 — mutation ${i+1} not found`); return; }
    hlcs.push(m.hlc);
  }

  let allValidFormat = true;
  for (let i = 0; i < 3; i++) {
    if (!HLC_RE.test(hlcs[i])) {
      fail(`TEST 4 — HLC ${i+1} does not match HLC format`, `got "${hlcs[i]}"`);
      allValidFormat = false;
    }
  }
  if (allValidFormat) pass('TEST 4 — all 3 HLCs match HLC format');

  const allMatchClient = hlcs.every(h => parseHlcTuple(h).uuid === clientIdentity.client_id);
  if (allMatchClient)   pass('TEST 4 — all HLC uuid components match client_id');
  else                  fail('TEST 4 — HLC uuid component mismatch',
                          `hlcs=${JSON.stringify(hlcs)} expected client="${clientIdentity.client_id}"`);

  if (hlcLessThan(hlcs[0], hlcs[1]))  pass('TEST 4 — HLC1 < HLC2 strictly increasing [N-43]');
  else                                fail('TEST 4 — HLC1 not < HLC2', `hlc1="${hlcs[0]}" hlc2="${hlcs[1]}"`);

  if (hlcLessThan(hlcs[1], hlcs[2]))  pass('TEST 4 — HLC2 < HLC3 strictly increasing [N-43]');
  else                                fail('TEST 4 — HLC2 not < HLC3', `hlc2="${hlcs[1]}" hlc3="${hlcs[2]}"`);

  const hlcLast = db.prepare("SELECT value FROM system_state WHERE key='hlc_last'").get().value;
  if (hlcLast === hlcs[2])            pass('TEST 4 — system_state.hlc_last equals HLC of mutation 3');
  else                                fail('TEST 4 — system_state.hlc_last mismatch',
                                        `last="${hlcLast}" hlc3="${hlcs[2]}"`);

  console.log('  NOTE: monotonicity verified WITHIN a SAVEPOINT — nextClock reads see prior writes in same txn context.');
});

// ── TEST 5: Local-only column exclusion ───────────────────────

section('TEST 5 — Local-only column exclusion (stream_key absent) [N-24]/[Q-13]');

withSavepoint('test_5', () => {
  const row = makeStarterRow('rtmp_destinations', {
    name:       'TEST',
    url:        'rtmp://test',
    stream_key: 'SECRET_KEY_DO_NOT_LEAK',
    is_active:  1,
  });
  const payload = writer.serializePayload(row, 'rtmp_destinations');

  if (!('stream_key' in payload))                     pass('TEST 5 — stream_key not in payload [N-24]');
  else                                                fail('TEST 5 — stream_key should be excluded', `found "${payload.stream_key}"`);

  const payloadStr = JSON.stringify(payload);
  if (!payloadStr.includes('SECRET_KEY_DO_NOT_LEAK')) pass('TEST 5 — SECRET_KEY_DO_NOT_LEAK absent from serialized payload');
  else                                                fail('TEST 5 — SECRET_KEY_DO_NOT_LEAK leaked into payload string');

  if ('name' in payload)                              pass('TEST 5 — "name" present in payload');
  else                                                fail('TEST 5 — "name" missing from payload');

  if ('url' in payload)                               pass('TEST 5 — "url" present in payload');
  else                                                fail('TEST 5 — "url" missing from payload');

  if ('is_active' in payload)                         pass('TEST 5 — "is_active" present in payload');
  else                                                fail('TEST 5 — "is_active" missing from payload');

  if ('station_id' in payload)                        pass('TEST 5 — "station_id" present in payload');
  else                                                fail('TEST 5 — "station_id" missing from payload');

  if ('uuid' in payload)                              pass('TEST 5 — "uuid" present in payload');
  else                                                fail('TEST 5 — "uuid" missing from payload');

  // Integration: write mutation, read back stored payload_after, assert stream_key still absent
  writer.withMutation(db, {
    table_name:     'rtmp_destinations',
    row_id:         row.uuid,
    op:             'insert',
    payload_before: null,
    payload_after:  payload,
    station_id:     1,
    actor_id:       null,
  }, () => {
    db.prepare(
      'INSERT INTO rtmp_destinations (name, url, stream_key, is_active, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.name, row.url, row.stream_key, row.is_active, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
  });

  const mut = db.prepare('SELECT * FROM mutations WHERE row_id=?').get(row.uuid);
  if (!mut) {
    fail('TEST 5 — integration: mutation row not found');
  } else {
    const storedPa = JSON.parse(mut.payload_after);
    if (!('stream_key' in storedPa)) pass('TEST 5 — stored mutation payload_after has no stream_key (integration)');
    else                             fail('TEST 5 — stream_key found in stored payload_after', `got "${storedPa.stream_key}"`);
  }
});

// ── TEST 6: JSON-text column handling ─────────────────────────

section('TEST 6 — JSON-text column handling [N-17]/[N-18]');

withSavepoint('test_6', () => {
  // Valid JSON branch
  const actionsObj = { steps: [{ type: 'play', deck: 1 }, { type: 'fade', ms: 1000 }] };
  const row = makeStarterRow('macros', {
    name:    'TEST_MACRO',
    actions: JSON.stringify(actionsObj),
  });
  const payload = writer.serializePayload(row, 'macros');

  if (typeof payload.actions === 'object' && payload.actions !== null)
                                                      pass('TEST 6 — payload.actions is object (not string) [N-17]');
  else                                                fail('TEST 6 — payload.actions type', `expected object got ${typeof payload.actions}`);

  if (Array.isArray(payload.actions && payload.actions.steps) && payload.actions.steps.length === 2)
                                                      pass('TEST 6 — payload.actions.steps is array of length 2');
  else                                                fail('TEST 6 — payload.actions.steps', `got ${JSON.stringify(payload.actions)}`);

  if (payload.actions && payload.actions.steps && payload.actions.steps[0] && payload.actions.steps[0].type === 'play')
                                                      pass('TEST 6 — payload.actions.steps[0].type === "play"');
  else                                                fail('TEST 6 — payload.actions.steps[0].type', `got ${JSON.stringify(payload.actions && payload.actions.steps && payload.actions.steps[0])}`);

  // Round-trip: deserializePayload should stringify actions back to TEXT for DB storage
  const deserialized = writer.deserializePayload(payload, 'macros');
  if (typeof deserialized.actions === 'string')       pass('TEST 6 — round-trip: deserializePayload.actions is string');
  else                                                fail('TEST 6 — round-trip actions type', `expected string got ${typeof deserialized.actions}`);

  // Malformed JSON branch [N-18]
  const row2 = makeStarterRow('macros', {
    name:    'TEST_MACRO_BAD',
    actions: '{not valid json',
  });
  const payload2 = writer.serializePayload(row2, 'macros');

  if (payload2.actions && payload2.actions.__raw_text === '{not valid json')
                                                      pass('TEST 6 — malformed JSON stored as __raw_text sentinel [N-18]');
  else                                                fail('TEST 6 — malformed JSON __raw_text', `got ${JSON.stringify(payload2.actions)}`);

  if (payload2.actions && payload2.actions.__json_parse_failed === true)
                                                      pass('TEST 6 — malformed JSON has __json_parse_failed === true [N-18]');
  else                                                fail('TEST 6 — malformed JSON __json_parse_failed', `got ${JSON.stringify(payload2.actions)}`);
});

// ── TEST 7: BLOB-ref envelope ─────────────────────────────────

section('TEST 7 — BLOB-ref envelope (songs.file_path) [N-22]/[N-23]');

withSavepoint('test_7', () => {
  const row = makeStarterRow('songs', {
    title:      'TEST_SONG',
    file_path:  'C:/music/test.mp3',
    cue_in_ms:  0,
    cue_out_ms: 1000,
  });
  const payload = writer.serializePayload(row, 'songs');

  if (payload.file_path !== null && typeof payload.file_path === 'object')
                                                      pass('TEST 7 — payload.file_path is object [N-22]');
  else                                                fail('TEST 7 — payload.file_path type', `got ${typeof payload.file_path}: "${payload.file_path}"`);

  if (payload.file_path && payload.file_path.__blob_ref === 'C:/music/test.mp3')
                                                      pass('TEST 7 — payload.file_path.__blob_ref === "C:/music/test.mp3" [N-23]');
  else                                                fail('TEST 7 — __blob_ref', `got "${payload.file_path && payload.file_path.__blob_ref}"`);

  if (payload.file_path && payload.file_path.__blob_size === null)
                                                      pass('TEST 7 — payload.file_path.__blob_size === null [N-23]');
  else                                                fail('TEST 7 — __blob_size', `expected null got "${payload.file_path && payload.file_path.__blob_size}"`);

  if (payload.file_path && payload.file_path.__blob_origin === 'C:/music/test.mp3')
                                                      pass('TEST 7 — payload.file_path.__blob_origin === "C:/music/test.mp3" [N-23]');
  else                                                fail('TEST 7 — __blob_origin', `got "${payload.file_path && payload.file_path.__blob_origin}"`);

  // Round-trip: deserializePayload should extract __blob_origin back to raw string
  const deserialized = writer.deserializePayload(payload, 'songs');
  if (deserialized.file_path === 'C:/music/test.mp3') pass('TEST 7 — round-trip: deserialized file_path === "C:/music/test.mp3"');
  else                                                fail('TEST 7 — round-trip file_path', `expected "C:/music/test.mp3" got "${deserialized.file_path}"`);
});

// ── TEST 8: compactMutations throws ──────────────────────────

section('TEST 8 — compactMutations() throws with [N-88] reference');

withSavepoint('test_8', () => {
  let threw = false;
  let err   = null;
  try {
    writer.compactMutations(db);
  } catch (e) {
    threw = true;
    err   = e;
  }

  if (threw)                                          pass('TEST 8 — compactMutations throws');
  else                                                fail('TEST 8 — compactMutations should throw but did not');

  if (err && err.message.includes('compactMutations')) pass('TEST 8 — error message includes "compactMutations"');
  else                                                fail('TEST 8 — error message missing "compactMutations"', `got "${err && err.message}"`);

  if (err && err.message.includes('[N-88]'))           pass('TEST 8 — error message includes "[N-88]"');
  else                                                fail('TEST 8 — error message missing "[N-88]"', `got "${err && err.message}"`);
});

// ── TEST 9: toWireFormat strips local-only fields ────────────

section('TEST 9 — toWireFormat produces exactly 14 fields [N-49]');

withSavepoint('test_9', () => {
  const row = makeStarterRow('cart_slots', { slot_number: 999, title: 'TEST_WIRE', file_path: '/test/wire.mp3' });
  const payload_after = writer.serializePayload(row, 'cart_slots');

  writer.withMutation(db, {
    table_name:     'cart_slots',
    row_id:         row.uuid,
    op:             'insert',
    payload_before: null,
    payload_after,
    station_id:     1,
    actor_id:       null,
  }, () => {
    db.prepare(
      'INSERT INTO cart_slots (slot_number, title, file_path, station_id, uuid, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.slot_number, row.title, row.file_path, row.station_id, row.uuid, row.created_at, row.updated_at, row.deleted_at);
  });

  const mutRow = db.prepare('SELECT * FROM mutations WHERE row_id=?').get(row.uuid);
  if (!mutRow) { fail('TEST 9 — mutation row not found'); return; }

  const wire     = writer.toWireFormat(mutRow);
  const wireKeys = Object.keys(wire);

  if (wireKeys.length === 14)                         pass('TEST 9 — wire format has exactly 14 fields [N-49]');
  else                                                fail('TEST 9 — wire field count', `expected 14 got ${wireKeys.length}: ${JSON.stringify(wireKeys)}`);

  if (!('applied_at' in wire))                        pass('TEST 9 — applied_at absent from wire [N-08]');
  else                                                fail('TEST 9 — applied_at should not be in wire format');

  if (!('origin' in wire))                            pass('TEST 9 — origin absent from wire [N-08]');
  else                                                fail('TEST 9 — origin should not be in wire format');

  if (!('sync_status' in wire))                       pass('TEST 9 — sync_status absent from wire [N-08]');
  else                                                fail('TEST 9 — sync_status should not be in wire format');

  const WIRE_FIELDS = [
    'id', 'client_id', 'station_id', 'actor_id',
    'table_name', 'row_id', 'op',
    'payload_before', 'payload_after',
    'created_at', 'hlc',
    'parent_mutation_id', 'schema_version',
    'conflict_resolution',
  ];
  let allPresent = true;
  for (const f of WIRE_FIELDS) {
    if (!(f in wire)) {
      fail(`TEST 9 — wire missing expected field: ${f}`);
      allPresent = false;
    }
  }
  if (allPresent) pass('TEST 9 — all 14 expected wire fields present');

  if (wire.payload_after !== null && typeof wire.payload_after === 'object')
                                                      pass('TEST 9 — wire.payload_after is object (not string) [N-51]');
  else                                                fail('TEST 9 — wire.payload_after should be parsed object', `got ${typeof wire.payload_after}`);
});

// ── TEST 10: null station_id for install-scoped table ─────────

section('TEST 10 — null station_id accepted for install-scoped table (mood_tags) [N-89]');

withSavepoint('test_10', () => {
  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  const now  = new Date().toISOString();
  const uuid = crypto.randomUUID();
  const row  = { id: undefined, uuid, name: 'smoke-test-mood', description: null, color: '#ff0000', created_at: now, updated_at: now, deleted_at: null };
  const payload_after = writer.serializePayload(row, 'mood_tags');

  // station_id: null — install-scoped, must not throw [N-89]
  let threw = false;
  try {
    writer.withMutation(db, {
      table_name:     'mood_tags',
      row_id:         uuid,
      op:             'insert',
      payload_before: null,
      payload_after,
      station_id:     null,
      actor_id:       null,
    }, () => {
      db.prepare(
        'INSERT INTO mood_tags (uuid, name, description, color, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(uuid, row.name, row.description, row.color, row.created_at, row.updated_at, row.deleted_at);
    });
  } catch (e) {
    threw = true;
    fail('TEST 10 — withMutation(null station_id) should not throw', e.message);
  }

  if (!threw) pass('TEST 10 — withMutation(station_id: null) did not throw [N-89]');

  const countAfter = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  if (countAfter === countBefore + 1)     pass('TEST 10 — mutations count +1');
  else                                    fail('TEST 10 — mutations count', `before=${countBefore} after=${countAfter}`);

  const mut = db.prepare('SELECT * FROM mutations WHERE row_id=?').get(uuid);
  if (!mut) { fail('TEST 10 — mutation row not found'); return; }
  pass('TEST 10 — mutation row found by row_id');

  if (mut.station_id === null)            pass('TEST 10 — mut.station_id is SQL NULL (not string "null") [N-89]');
  else                                    fail('TEST 10 — mut.station_id should be NULL', `got "${mut.station_id}"`);

  if (mut.op === 'insert')                pass('TEST 10 — op === "insert"');
  else                                    fail('TEST 10 — op', `expected "insert" got "${mut.op}"`);

  if (mut.payload_before === null)        pass('TEST 10 — payload_before is null [N-29]');
  else                                    fail('TEST 10 — payload_before should be null');

  if (mut.payload_after && mut.payload_after.includes('smoke-test-mood'))
                                          pass('TEST 10 — payload_after contains mood_tags name');
  else                                    fail('TEST 10 — payload_after', `got "${mut.payload_after}"`);

  // Confirm undefined station_id still throws [N-89]
  let undefinedThrew = false;
  try {
    writer.withMutation(db, {
      table_name: 'mood_tags', row_id: crypto.randomUUID(), op: 'insert',
      payload_before: null, payload_after,
      /* station_id intentionally omitted → undefined */
      actor_id: null,
    }, () => {});
  } catch (e) {
    undefinedThrew = e.message.includes('[N-89]');
  }
  if (undefinedThrew)                     pass('TEST 10 — undefined station_id throws with [N-89] reference');
  else                                    fail('TEST 10 — undefined station_id should throw [N-89]');
});

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
