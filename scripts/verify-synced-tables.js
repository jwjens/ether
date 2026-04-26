// scripts/verify-synced-tables.js — audit the synced-tables registry against the live DB
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/verify-synced-tables.js
// Read-only. Does NOT modify the DB or registry.

'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const { SYNCED_TABLES, REGISTRY } = require(path.join(__dirname, '../electron/sync/synced-tables'));

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');

if (!fs.existsSync(dbPath)) {
  console.error('[verify] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

const VALID_CATEGORIES = new Set(['scalar', 'json-text', 'blob-ref', 'local-only']);
const VALID_SCOPES     = new Set(['install', 'station']);

let allPass = true;

function pass(msg) { console.log('  PASS  ' + msg); }
function fail(msg) { console.error('  FAIL  ' + msg); allPass = false; }

// ── Helper: get all user tables with a uuid column from sqlite_master ────────

function getDbSyncedTables() {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(r => r.name);

  return tables.filter(name => {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
    return cols.includes('uuid');
  });
}

function getDbCols(tableName) {
  return db.prepare(`PRAGMA table_info("${tableName}")`).all();
}

// ── Check 1: every registry table exists in DB and has a uuid column ─────────

console.log('\n═════════════════════════════════════════════════════════════════');
console.log('CHECK 1 — Every SYNCED_TABLES entry exists in DB with uuid column');
console.log('═════════════════════════════════════════════════════════════════');

let check1Failures = 0;
for (const tableName of SYNCED_TABLES) {
  const cols = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName);
  if (!cols) {
    fail(`"${tableName}" not found in sqlite_master`);
    check1Failures++;
    continue;
  }
  const hasUuid = db.prepare(`PRAGMA table_info("${tableName}")`).all().some(c => c.name === 'uuid');
  if (!hasUuid) {
    fail(`"${tableName}" exists but has no uuid column`);
    check1Failures++;
  }
}
if (check1Failures === 0) pass(`All ${SYNCED_TABLES.length} registry tables exist in DB with uuid column`);

// ── Check 2: every DB table with uuid column appears in SYNCED_TABLES ────────

console.log('\n═════════════════════════════════════════════════════════════════');
console.log('CHECK 2 — Every DB table with uuid column appears in SYNCED_TABLES');
console.log('═════════════════════════════════════════════════════════════════');

const dbSyncedTables = getDbSyncedTables();
const registrySet    = new Set(SYNCED_TABLES);
let check2Failures   = 0;

for (const tableName of dbSyncedTables) {
  if (!registrySet.has(tableName)) {
    fail(`"${tableName}" has uuid column in DB but is missing from SYNCED_TABLES`);
    check2Failures++;
  }
}
if (check2Failures === 0) pass(`All ${dbSyncedTables.length} DB tables with uuid column are in SYNCED_TABLES`);

// ── Check 3: every DB column appears in registry ─────────────────────────────

console.log('\n═════════════════════════════════════════════════════════════════');
console.log('CHECK 3 — Every DB column appears in each table\'s registry');
console.log('═════════════════════════════════════════════════════════════════');

let check3Failures = 0;
for (const tableName of SYNCED_TABLES) {
  const entry   = REGISTRY[tableName];
  if (!entry) { fail(`"${tableName}" has no REGISTRY entry`); check3Failures++; continue; }
  const dbCols  = getDbCols(tableName).map(c => c.name);
  const regCols = Object.keys(entry.columns);
  for (const col of dbCols) {
    if (!regCols.includes(col)) {
      fail(`"${tableName}".${col} is in DB but missing from registry`);
      check3Failures++;
    }
  }
}
if (check3Failures === 0) pass('All DB columns are present in their registry entries');

// ── Check 4: no phantom columns in registry ──────────────────────────────────

console.log('\n═════════════════════════════════════════════════════════════════');
console.log('CHECK 4 — No phantom columns in registry (every registry column exists in DB)');
console.log('═════════════════════════════════════════════════════════════════');

let check4Failures = 0;
for (const tableName of SYNCED_TABLES) {
  const entry  = REGISTRY[tableName];
  if (!entry) continue;
  const dbCols = new Set(getDbCols(tableName).map(c => c.name));
  for (const col of Object.keys(entry.columns)) {
    if (!dbCols.has(col)) {
      fail(`"${tableName}".${col} is in registry but NOT in DB`);
      check4Failures++;
    }
  }
}
if (check4Failures === 0) pass('No phantom columns found in registry');

// ── Check 5: all category values are valid ───────────────────────────────────

console.log('\n═════════════════════════════════════════════════════════════════');
console.log('CHECK 5 — All category values are one of: scalar, json-text, blob-ref, local-only');
console.log('═════════════════════════════════════════════════════════════════');

let check5Failures = 0;
for (const tableName of SYNCED_TABLES) {
  const entry = REGISTRY[tableName];
  if (!entry) continue;
  for (const [col, cat] of Object.entries(entry.columns)) {
    if (!VALID_CATEGORIES.has(cat)) {
      fail(`"${tableName}".${col} has invalid category "${cat}"`);
      check5Failures++;
    }
  }
}
if (check5Failures === 0) pass('All category values are valid');

// ── Check 6: BLOB type columns are categorized as blob-ref per [N-20] ────────

console.log('\n═════════════════════════════════════════════════════════════════');
console.log('CHECK 6 — Columns with SQLite type BLOB are categorized as blob-ref [N-20]');
console.log('═════════════════════════════════════════════════════════════════');

let check6Failures = 0;
for (const tableName of SYNCED_TABLES) {
  const entry  = REGISTRY[tableName];
  if (!entry) continue;
  const dbCols = getDbCols(tableName);
  for (const col of dbCols) {
    if (col.type && col.type.toUpperCase() === 'BLOB') {
      const cat = entry.columns[col.name];
      if (cat !== 'blob-ref') {
        fail(`"${tableName}".${col.name} has SQLite type BLOB but is categorized as "${cat}" (expected "blob-ref")`);
        check6Failures++;
      }
    }
  }
}
if (check6Failures === 0) pass('All BLOB-type columns are correctly categorized as blob-ref');

// ── Check 7: column count totals ─────────────────────────────────────────────

console.log('\n═════════════════════════════════════════════════════════════════');
console.log('CHECK 7 — Column count totals');
console.log('═════════════════════════════════════════════════════════════════');

let totalCols  = 0;
let nScalar    = 0;
let nJsonText  = 0;
let nBlobRef   = 0;
let nLocalOnly = 0;

for (const tableName of SYNCED_TABLES) {
  const entry = REGISTRY[tableName];
  if (!entry) continue;
  for (const cat of Object.values(entry.columns)) {
    totalCols++;
    if (cat === 'scalar')     nScalar++;
    if (cat === 'json-text')  nJsonText++;
    if (cat === 'blob-ref')   nBlobRef++;
    if (cat === 'local-only') nLocalOnly++;
  }
}

const catSum = nScalar + nJsonText + nBlobRef + nLocalOnly;
console.log(`  Total columns: ${totalCols} | scalar: ${nScalar} | json-text: ${nJsonText} | blob-ref: ${nBlobRef} | local-only: ${nLocalOnly}`);

if (totalCols !== catSum) {
  fail(`Column total ${totalCols} does not equal sum of categories ${catSum}`);
} else {
  pass(`Column totals consistent (${totalCols} = ${nScalar} + ${nJsonText} + ${nBlobRef} + ${nLocalOnly})`);
}

// ── Check 8: every entry has a valid scope field per Phase 4 ─────────────────

console.log('\n═════════════════════════════════════════════════════════════════');
console.log('CHECK 8 — Every REGISTRY entry has scope: \'install\' | \'station\' (Phase 4)');
console.log('═════════════════════════════════════════════════════════════════');

let check8Failures = 0;
let nInstall = 0;
let nStation = 0;
for (const tableName of SYNCED_TABLES) {
  const entry = REGISTRY[tableName];
  if (!entry) continue;
  if (entry.scope === undefined) {
    fail(`"${tableName}" has no scope field`);
    check8Failures++;
    continue;
  }
  if (!VALID_SCOPES.has(entry.scope)) {
    fail(`"${tableName}" has invalid scope "${entry.scope}" (expected 'install' or 'station')`);
    check8Failures++;
    continue;
  }
  if (entry.scope === 'install') nInstall++;
  else nStation++;
}
if (check8Failures === 0) {
  pass(`All ${SYNCED_TABLES.length} entries have valid scope (${nInstall} install, ${nStation} station)`);
}

// ── Final summary ────────────────────────────────────────────────────────────

console.log('\n═════════════════════════════════════════════════════════════════');
if (allPass) {
  console.log('ALL CHECKS PASSED ✓');
  console.log(`Total: ${totalCols} | scalar: ${nScalar} | json-text: ${nJsonText} | blob-ref: ${nBlobRef} | local-only: ${nLocalOnly}`);
  console.log(`Scope: ${nInstall} install | ${nStation} station`);
} else {
  console.error('ONE OR MORE CHECKS FAILED ✗ — see FAIL lines above');
}
console.log('═════════════════════════════════════════════════════════════════');

db.close();
process.exit(allPass ? 0 : 1);
