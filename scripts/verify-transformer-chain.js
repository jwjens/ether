// scripts/verify-transformer-chain.js — transformer chain harness per [N-71]/[N-72]
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/verify-transformer-chain.js
// Also runs as pre-commit hook per [N-73].
//
// Verifies:
//   - Every migration script matching migrate-*-phase-sync-N.js exports a payloadTransformer function.
//   - The set of discovered migrations covers every integer from 2 to the current schema_version.
//   - No holes, no duplicates.
//   - Each transformer is callable with a trivial input without throwing.

'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ── DB path ───────────────────────────────────────────────────

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');
const scriptsDir = path.join(__dirname);

// ── Test harness ──────────────────────────────────────────────

let passed   = 0;
let failed   = 0;
const failures = [];

function pass(label) {
  console.log('  PASS  ' + label);
  passed++;
}

function fail(label, detail) {
  const msg = detail ? `${label} — ${detail}` : label;
  console.error('  FAIL  ' + msg);
  failures.push(msg);
  failed++;
}

function info(msg) {
  console.log('  INFO  ' + msg);
}

function section(title) {
  console.log('');
  console.log('═'.repeat(60));
  console.log(title);
  console.log('═'.repeat(60));
}

// ── Step 1: read current schema_version from DB ───────────────

section('STEP 1 — Read current schema_version from DB');

if (!fs.existsSync(dbPath)) {
  console.error('[verify-transformer-chain] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

const svRows = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
db.close();

console.log('  schema_version rows:', JSON.stringify(svRows));

const currentVersion = svRows[svRows.length - 1];
if (typeof currentVersion !== 'number' || currentVersion < 2) {
  console.error('[verify-transformer-chain] ERROR: cannot determine current schema_version from DB.');
  process.exit(1);
}
console.log('  current schema_version:', currentVersion);

// v1 is the implicit starting schema — no migration script expected for v1.
info('v1 is the implicit starting schema — no migration script expected for v1.');
info(`Transformer coverage required: v2 → v${currentVersion} (${currentVersion - 1} migration(s)).`);

// ── Step 2: discover migration scripts ───────────────────────

section('STEP 2 — Discover migration scripts in scripts/');

// Pattern: migrate-*-phase-sync-N.js where N is the target version integer.
const MIGRATION_RE = /^migrate-.+-phase-sync-(\d+)\.js$/;

const allScripts = fs.readdirSync(scriptsDir).filter(f => MIGRATION_RE.test(f));
console.log('  Migration scripts found:', allScripts.length);

// Build map: targetVersion -> [filenames]
const byVersion = {};
for (const filename of allScripts) {
  const match = MIGRATION_RE.exec(filename);
  const v = parseInt(match[1], 10);
  if (!byVersion[v]) byVersion[v] = [];
  byVersion[v].push(filename);
  console.log(`  Discovered: ${filename} → target v${v}`);
}

if (allScripts.length === 0) {
  fail('No migration scripts found in scripts/');
} else {
  pass(`${allScripts.length} migration script(s) discovered`);
}

// ── Step 3: check for duplicates ─────────────────────────────

section('STEP 3 — Check for duplicate target versions');

let duplicatesFound = false;
for (const [v, files] of Object.entries(byVersion)) {
  if (files.length > 1) {
    fail(`Duplicate migrations for v${v}`, files.join(', '));
    duplicatesFound = true;
  }
}
if (!duplicatesFound) {
  pass('No duplicate target versions');
}

// ── Step 4: check coverage v2 → currentVersion ───────────────

section(`STEP 4 — Check coverage: v2 → v${currentVersion} (no holes)`);

const gaps = [];
for (let v = 2; v <= currentVersion; v++) {
  if (!byVersion[v] || byVersion[v].length === 0) {
    gaps.push(v);
    fail(`No migration script found for target v${v}`);
  } else {
    pass(`Migration script present for target v${v}: ${byVersion[v][0]}`);
  }
}

// ── Step 5: require each migration and verify transformer ─────

section('STEP 5 — require() each migration and verify payloadTransformer export');

const loaded = {};
for (let v = 2; v <= currentVersion; v++) {
  if (!byVersion[v] || byVersion[v].length === 0) continue;

  const filename = byVersion[v][0];
  const fullPath = path.join(scriptsDir, filename);

  let mod;
  try {
    mod = require(fullPath);
  } catch (e) {
    fail(`require("${filename}") threw`, e.message);
    continue;
  }

  if (typeof mod.payloadTransformer !== 'function') {
    fail(
      `"${filename}" missing payloadTransformer export`,
      `got typeof ${typeof mod.payloadTransformer} (value: ${JSON.stringify(mod.payloadTransformer)})`
    );
    continue;
  }

  pass(`"${filename}" exports payloadTransformer as function`);
  loaded[v] = { filename, transformer: mod.payloadTransformer };
}

// ── Step 6: call each transformer with trivial input ─────────

section('STEP 6 — Call each transformer with trivial input {}');

for (const [v, entry] of Object.entries(loaded)) {
  const { filename, transformer } = entry;
  try {
    const result = transformer({}, parseInt(v, 10) - 1);
    // Identity transformers return the input unchanged; non-identity may return a new object.
    // We only verify it doesn't throw and returns something non-null.
    if (result === null || result === undefined) {
      fail(`"${filename}" transformer returned ${result} for input {}`, 'expected an object');
    } else {
      pass(`"${filename}" transformer callable, returned ${JSON.stringify(result)}`);
    }
  } catch (e) {
    fail(`"${filename}" transformer threw on trivial input {}`, e.message);
  }
}

// ── Summary ───────────────────────────────────────────────────

section('SUMMARY');

const totalDiscovered = allScripts.length;
const gapList = gaps.length > 0 ? gaps.map(v => `v${v}`).join(', ') : 'none';

console.log(`  Total migrations discovered: ${totalDiscovered} | Expected coverage: v2 → v${currentVersion} | Gaps: ${gapList}`);
console.log('');

if (failed === 0) {
  console.log(`Transformer chain verified: v2 → v${currentVersion}, ${totalDiscovered} migrations, all transformers present and callable.`);
  console.log('');
  process.exit(0);
} else {
  console.error(`FAILED: ${failed} check(s) failed, ${passed} passed.`);
  console.error('Failures:');
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  console.error('');
  process.exit(1);
}
