'use strict';
// scripts/prove-db-apply-bootstrap.js
//
// Proves the first-row bootstrap fix: the install resolves station_uuid -> its LOCAL integer
// station_id in applyDbMutation (src/lib/ccData.ts), so the dashboard can create the FIRST
// category/clock/etc on a brand-new station without supplying the integer. Drives the REAL
// applyDbMutation (transpiled from TS) against a better-sqlite3 fixture with a mocked
// window.ether. licenseKey=null makes the re-push a no-op (no network).
//
// Run:  ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/prove-db-apply-bootstrap.js

const fs = require('fs');
const path = require('path');
const Module = require('module');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

// ── Transpile the REAL ccData.ts to CJS and load it with its two imports stubbed ──
const ccPath = path.join(__dirname, '..', 'src', 'lib', 'ccData.ts');
const code = ts.transpileModule(fs.readFileSync(ccPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === './etherBackend') return { ETHER_BACKEND_URL: 'http://stub' };
  if (request === '../db/client') return { query: async () => [] };
  return origLoad.apply(this, arguments);
};
const mod = new Module(ccPath, module);
mod.filename = ccPath;
mod.paths = Module._nodeModulePaths(path.dirname(ccPath));
mod._compile(code, ccPath);
Module._load = origLoad;
const { applyDbMutation } = mod.exports;

// ── Fixture: a local station id=7 uuid=X, and ZERO categories ──
const STATION_UUID = 'STATION-X-UUID';
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE stations (id INTEGER PRIMARY KEY, uuid TEXT, deleted_at TEXT);
  INSERT INTO stations (id, uuid, deleted_at) VALUES (7, '${STATION_UUID}', NULL);
  CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, code TEXT, name TEXT, station_id INTEGER);
`);

// ── Mock window.ether — stations.list reads the DB; categories.create writes it ──
let createdPayloads = [];
global.window = {
  ether: {
    stations: { list: async () => db.prepare('SELECT id, uuid FROM stations WHERE deleted_at IS NULL').all() },
    categories: {
      create: async (payload) => {
        createdPayloads.push(payload);
        db.prepare('INSERT INTO categories (uuid, code, name, station_id) VALUES (?,?,?,?)')
          .run(`cat-${createdPayloads.length}`, payload.code, payload.name, payload.station_id ?? null);
        return { ok: true };
      },
    },
  },
};

// Capture console.error so we can assert the loud bail fired.
const errors = [];
const realErr = console.error;
console.error = (...a) => { errors.push(a.join(' ')); };

(async () => {
  const checks = [];
  const pass = (label, cond, detail) => checks.push({ label, ok: !!cond, detail });

  // TEST 1 — create the FIRST category with station_uuid and NO integer station_id.
  await applyDbMutation(null, {
    table: 'categories', op: 'create', station_uuid: STATION_UUID,
    payload: { code: 'PG', name: 'Power Gold' },          // note: NO station_id supplied
  });
  const rows1 = db.prepare('SELECT code, name, station_id FROM categories').all();
  pass('first-row bootstrap: category written', rows1.length === 1, JSON.stringify(rows1));
  pass('install resolved station_uuid -> local station_id = 7', rows1[0] && rows1[0].station_id === 7, JSON.stringify(rows1[0]));
  pass('dashboard supplied NO station_id (install stamped it)', createdPayloads[0] && createdPayloads[0].station_id === 7);

  // TEST 2 — a station_uuid not on this install → loud bail, NO write.
  errors.length = 0;
  const before = db.prepare('SELECT COUNT(*) n FROM categories').get().n;
  await applyDbMutation(null, {
    table: 'categories', op: 'create', station_uuid: 'NOT-ON-THIS-INSTALL',
    payload: { code: 'XX', name: 'Should not write' },
  });
  const after = db.prepare('SELECT COUNT(*) n FROM categories').get().n;
  pass('unresolved UUID: NO row written (bailed)', after === before, `before=${before} after=${after}`);
  pass('unresolved UUID: loud error logged', errors.some(e => /not found on this install/i.test(e)), JSON.stringify(errors));

  console.error = realErr;
  console.log('=== DB:APPLY BOOTSTRAP (UUID -> local station_id) ===');
  let allOk = true;
  for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`); if (!c.ok) { allOk = false; console.log(`         detail: ${c.detail}`); } }
  console.log('\n=== RESULT:', allOk ? 'BOOTSTRAP FIX WORKS — first row creates remotely; unknown station bails ✅' : 'FAIL ❌', '===');
  db.close();
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error = realErr; console.error('HARNESS ERROR:', e); process.exit(2); });
