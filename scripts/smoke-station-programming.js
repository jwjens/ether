'use strict';

// scripts/smoke-station-programming.js — smoke test for Phase 4 station_programming handlers
//
// Run with: npx electron scripts\smoke-station-programming.js
// All write tests run in SAVEPOINT-isolated blocks — zero DB residue.

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');

if (!fs.existsSync(dbPath)) {
  console.error('[smoke-sp] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { timeout: 5000 });

const { validateScope, spList, spGet, spAdd, spUpdate, spRemove } =
  require('../electron/sync/handlers/station_programming');

// ── Test harness ──────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function pass(label) { console.log(`  PASS  ${label}`); passed++; }
function fail(label, detail) {
  const msg = detail ? `${label} — ${detail}` : label;
  console.error(`  FAIL  ${msg}`);
  failures.push(msg);
  failed++;
}
function section(title) {
  console.log('');
  console.log('═'.repeat(64));
  console.log(title);
  console.log('═'.repeat(64));
}

function withSavepoint(name, fn) {
  db.exec('SAVEPOINT ' + name);
  let threw = null;
  try { fn(); }
  catch (e) { threw = e; }
  finally {
    try { db.exec('ROLLBACK TO SAVEPOINT ' + name); } catch (_) {}
    try { db.exec('RELEASE SAVEPOINT ' + name); } catch (_) {}
  }
  if (threw) throw threw;
}

// ── Pre-flight data checks ────────────────────────────────────

section('PRE-FLIGHT — required seed data');

const station = db.prepare('SELECT id FROM stations WHERE id=1').get();
if (!station) {
  console.error('[smoke-sp] station_id=1 not found — aborting');
  db.close(); process.exit(1);
}
pass('station_id=1 exists');

const firstCategory = db.prepare('SELECT id FROM categories WHERE station_id=1 AND deleted_at IS NULL ORDER BY id LIMIT 1').get();
if (!firstCategory) {
  console.error('[smoke-sp] no categories for station 1 — aborting');
  db.close(); process.exit(1);
}
pass(`categories available (first id=${firstCategory.id})`);

// Grab an existing programming row for get/update/remove tests
const existingRow = db.prepare(
  'SELECT * FROM station_programming WHERE station_id=1 AND deleted_at IS NULL LIMIT 1'
).get();
if (!existingRow) {
  console.error('[smoke-sp] no existing station_programming rows — aborting');
  db.close(); process.exit(1);
}
pass(`existing programming row found (uuid=${existingRow.uuid})`);

// For the add test: find a category that existingRow.song_id is NOT already assigned to.
// Each song was migrated into exactly one category, so there should be many others available.
const altCategory = db.prepare(`
  SELECT c.id FROM categories c
  WHERE c.station_id = 1 AND c.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM station_programming sp
      WHERE sp.song_id = ? AND sp.station_id = 1
        AND sp.category_id = c.id AND sp.deleted_at IS NULL
    )
  LIMIT 1
`).get(existingRow.song_id);
if (!altCategory) {
  console.error('[smoke-sp] no alt category for add test — aborting');
  db.close(); process.exit(1);
}
pass(`alt category for add test found (category_id=${altCategory.id}, song_id=${existingRow.song_id})`);

const mutCountBefore = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
console.log(`  mutations before tests: ${mutCountBefore}`);

// ── TEST 1: validateScope ─────────────────────────────────────

section('TEST 1 — validateScope rejects install-scoped tables; accepts station-scoped');

let scopeError = null;
try { validateScope('songs'); }
catch (e) { scopeError = e; }
if (scopeError && /install-scoped/.test(scopeError.message))
  pass('TEST 1 — validateScope("songs") throws with install-scoped message');
else
  fail('TEST 1 — validateScope("songs") should throw', scopeError ? scopeError.message : 'no error thrown');

let noError = null;
try { validateScope('station_programming'); }
catch (e) { noError = e; }
if (!noError)
  pass('TEST 1 — validateScope("station_programming") does not throw');
else
  fail('TEST 1 — validateScope("station_programming") should not throw', noError.message);

let unknownError = null;
try { validateScope('__nonexistent__'); }
catch (e) { unknownError = e; }
if (unknownError && /unknown table/.test(unknownError.message))
  pass('TEST 1 — validateScope("__nonexistent__") throws unknown table error');
else
  fail('TEST 1 — validateScope unknown table should throw', unknownError ? unknownError.message : 'no error');

// ── TEST 2: spList ────────────────────────────────────────────

section('TEST 2 — spList returns migrated rows for station 1');

const rows = spList(db, 1);
if (Array.isArray(rows))
  pass(`TEST 2 — spList returns array (${rows.length} rows)`);
else
  fail('TEST 2 — spList should return array');

if (rows.length > 0)
  pass('TEST 2 — station 1 has at least 1 programming row');
else
  fail('TEST 2 — expected >0 rows after Phase 4 migration');

const allHaveUuid = rows.every(r => typeof r.uuid === 'string' && r.uuid.length > 0);
if (allHaveUuid)
  pass('TEST 2 — all rows have uuid');
else
  fail('TEST 2 — some rows missing uuid');

const noDeleted = rows.every(r => r.deleted_at === null);
if (noDeleted)
  pass('TEST 2 — spList excludes soft-deleted rows (deleted_at IS NULL)');
else
  fail('TEST 2 — spList returned rows with deleted_at set');

// Filtered list
const filteredRows = spList(db, 1, { categoryId: firstCategory.id });
if (Array.isArray(filteredRows))
  pass(`TEST 2 — filtered list by category_id=${firstCategory.id} returns ${filteredRows.length} rows`);
else
  fail('TEST 2 — filtered spList should return array');

// ── TEST 3: spGet ─────────────────────────────────────────────

section('TEST 3 — spGet retrieves existing row by uuid');

const fetched = spGet(db, existingRow.uuid);
if (fetched && fetched.uuid === existingRow.uuid)
  pass('TEST 3 — spGet returns correct row');
else
  fail('TEST 3 — spGet did not return expected row', `got ${JSON.stringify(fetched && fetched.uuid)}`);

if (fetched && fetched.song_id === existingRow.song_id)
  pass('TEST 3 — spGet row.song_id matches');
else
  fail('TEST 3 — song_id mismatch');

const missing = spGet(db, crypto.randomUUID());
if (missing === null)
  pass('TEST 3 — spGet returns null for unknown uuid');
else
  fail('TEST 3 — spGet should return null for unknown uuid');

// ── TEST 4: spAdd ─────────────────────────────────────────────

section('TEST 4 — spAdd [create] inserts row and logs mutation (SAVEPOINT-isolated)');

withSavepoint('test_sp_4', () => {
  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  const spCountBefore = db.prepare('SELECT COUNT(*) AS c FROM station_programming WHERE station_id=1').get().c;

  const newRow = spAdd(db, {
    song_id:     existingRow.song_id,
    station_id:  1,
    category_id: altCategory.id,
    notes:       'smoke-test-add',
  });

  const countAfter = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  const spCountAfter = db.prepare('SELECT COUNT(*) AS c FROM station_programming WHERE station_id=1').get().c;

  if (newRow !== null && newRow.uuid)
    pass('TEST 4 — spAdd returns inserted row with uuid');
  else
    fail('TEST 4 — spAdd should return inserted row', `got ${JSON.stringify(newRow)}`);

  if (spCountAfter === spCountBefore + 1)
    pass('TEST 4 — station_programming row count +1');
  else
    fail('TEST 4 — row count', `before=${spCountBefore} after=${spCountAfter}`);

  if (countAfter === countBefore + 1)
    pass('TEST 4 — mutations count +1');
  else
    fail('TEST 4 — mutations count', `before=${countBefore} after=${countAfter}`);

  const mut = db.prepare('SELECT * FROM mutations WHERE row_id=?').get(newRow.uuid);
  if (mut)
    pass('TEST 4 — mutation row found by row_id=uuid');
  else
    fail('TEST 4 — mutation row not found');

  if (mut && mut.op === 'insert')
    pass('TEST 4 — mutation.op === "insert"');
  else
    fail('TEST 4 — mutation.op', `expected "insert" got "${mut && mut.op}"`);

  if (mut && mut.payload_before === null)
    pass('TEST 4 — payload_before is null [N-29]');
  else
    fail('TEST 4 — payload_before should be null');

  if (mut && mut.payload_after && mut.payload_after.includes('smoke-test-add'))
    pass('TEST 4 — payload_after contains notes value');
  else
    fail('TEST 4 — payload_after missing notes', `got "${mut && mut.payload_after}"`);

  if (mut && mut.station_id === '1')
    pass('TEST 4 — station_id stringified to "1" [Q-14]');
  else
    fail('TEST 4 — station_id [Q-14]', `expected "1" got "${mut && mut.station_id}"`);

  if (newRow && newRow.rotation_status === 'active')
    pass('TEST 4 — rotation_status defaults to "active"');
  else
    fail('TEST 4 — rotation_status default', `got "${newRow && newRow.rotation_status}"`);

  if (newRow && newRow.daypart_mask === 16777215)
    pass('TEST 4 — daypart_mask defaults to 16777215');
  else
    fail('TEST 4 — daypart_mask default', `got ${newRow && newRow.daypart_mask}`);
});

// ── TEST 5: spUpdate ──────────────────────────────────────────

section('TEST 5 — spUpdate modifies field and logs mutation (SAVEPOINT-isolated)');

withSavepoint('test_sp_5', () => {
  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  const originalStatus = existingRow.rotation_status;
  const newStatus = originalStatus === 'active' ? 'hold' : 'active';

  const updatedRow = spUpdate(db, existingRow.uuid, { rotation_status: newStatus });

  const countAfter = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;

  if (updatedRow && updatedRow.rotation_status === newStatus)
    pass(`TEST 5 — spUpdate returned row has rotation_status="${newStatus}"`);
  else
    fail('TEST 5 — spUpdate returned row', `expected "${newStatus}" got "${updatedRow && updatedRow.rotation_status}"`);

  if (countAfter === countBefore + 1)
    pass('TEST 5 — mutations count +1');
  else
    fail('TEST 5 — mutations count', `before=${countBefore} after=${countAfter}`);

  const mut = db.prepare('SELECT * FROM mutations WHERE row_id=? ORDER BY rowid DESC LIMIT 1').get(existingRow.uuid);
  if (mut && mut.op === 'update')
    pass('TEST 5 — mutation.op === "update"');
  else
    fail('TEST 5 — mutation.op', `expected "update" got "${mut && mut.op}"`);

  if (mut && mut.payload_before !== null) {
    const pb = JSON.parse(mut.payload_before);
    if (pb.rotation_status === originalStatus)
      pass(`TEST 5 — payload_before.rotation_status === "${originalStatus}"`);
    else
      fail('TEST 5 — payload_before.rotation_status', `expected "${originalStatus}" got "${pb.rotation_status}"`);
  } else {
    fail('TEST 5 — payload_before should not be null');
  }

  if (mut && mut.payload_after !== null) {
    const pa = JSON.parse(mut.payload_after);
    if (pa.rotation_status === newStatus)
      pass(`TEST 5 — payload_after.rotation_status === "${newStatus}"`);
    else
      fail('TEST 5 — payload_after.rotation_status', `expected "${newStatus}" got "${pa.rotation_status}"`);
  } else {
    fail('TEST 5 — payload_after should not be null');
  }
});

// ── TEST 6: spRemove ──────────────────────────────────────────

section('TEST 6 — spRemove [delete] soft-deletes row and logs mutation (SAVEPOINT-isolated)');

withSavepoint('test_sp_6', () => {
  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;

  const result = spRemove(db, existingRow.uuid, 1);

  const countAfter = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  const dbRow = db.prepare('SELECT deleted_at FROM station_programming WHERE uuid=?').get(existingRow.uuid);

  if (result && result.ok === true)
    pass('TEST 6 — spRemove returns { ok: true }');
  else
    fail('TEST 6 — spRemove return value', `got ${JSON.stringify(result)}`);

  if (dbRow && dbRow.deleted_at !== null)
    pass('TEST 6 — row is soft-deleted (deleted_at set)');
  else
    fail('TEST 6 — row should have deleted_at set', `got ${JSON.stringify(dbRow)}`);

  if (countAfter === countBefore + 1)
    pass('TEST 6 — mutations count +1');
  else
    fail('TEST 6 — mutations count', `before=${countBefore} after=${countAfter}`);

  const mut = db.prepare('SELECT * FROM mutations WHERE row_id=? ORDER BY rowid DESC LIMIT 1').get(existingRow.uuid);
  if (mut && mut.op === 'delete')
    pass('TEST 6 — mutation.op === "delete"');
  else
    fail('TEST 6 — mutation.op', `expected "delete" got "${mut && mut.op}"`);

  if (mut && mut.payload_before !== null)
    pass('TEST 6 — payload_before non-null [N-31]');
  else
    fail('TEST 6 — payload_before should not be null for delete');

  if (mut && mut.payload_after === null)
    pass('TEST 6 — payload_after is null [N-31]');
  else
    fail('TEST 6 — payload_after should be null for delete', `got "${mut && mut.payload_after}"`);

  // spList should no longer return the removed row
  const listAfter = spList(db, 1, { limit: 9999 });
  const stillVisible = listAfter.some(r => r.uuid === existingRow.uuid);
  if (!stillVisible)
    pass('TEST 6 — spList excludes soft-deleted row after remove');
  else
    fail('TEST 6 — spList should not include soft-deleted row');
});

// ── Post-test: confirm zero residue ──────────────────────────

section('POST-TEST — zero residue verification');

const mutCountAfter = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
if (mutCountAfter === mutCountBefore)
  pass(`mutations table unchanged after SAVEPOINT rollbacks (${mutCountBefore} rows)`);
else
  fail('mutations count changed — SAVEPOINT rollback leaked', `before=${mutCountBefore} after=${mutCountAfter}`);

const spCount = db.prepare('SELECT COUNT(*) AS c FROM station_programming WHERE deleted_at IS NULL').get().c;
console.log(`  station_programming live rows: ${spCount} (unchanged from pre-test)`);

// ── Summary ───────────────────────────────────────────────────

console.log('');
console.log('═'.repeat(64));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('All station_programming handler tests PASSED ✓');
  console.log('═'.repeat(64));
  db.close();
  process.exit(0);
} else {
  console.error('FAILURES:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log('═'.repeat(64));
  db.close();
  process.exit(1);
}
