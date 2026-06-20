'use strict';
// scripts/prove-reconcile-stations.js
//
// Proves reconcileAccountStations (src/lib/ccData.ts): a running install materializes any cloud
// station missing locally, ADD-ONLY — never re-creates existing, never deletes, never switches
// the active station, and reuses the existing machine_id (no new seat). Drives the REAL function
// (transpiled from TS) with a stubbed /account/connect + a mocked window.ether whose switch/delete
// are spies that must never be called.
//
// Run:  node scripts/prove-reconcile-stations.js

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

// ── Transpile the REAL ccData.ts to CJS, stubbing its two imports ──
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
mod.filename = ccPath; mod.paths = Module._nodeModulePaths(path.dirname(ccPath));
mod._compile(code, ccPath);
Module._load = origLoad;
const { reconcileAccountStations } = mod.exports;

// ── Mutable fixture state + spies ──
let localStations, nextId, createdCalls, switchCalls, deleteCalls, dispatched, fetchCount, lastFetchBody, cloudStations;
function reset(cloud) {
  localStations = [{ id: 1, uuid: 'EXISTING' }];     // one station already present locally
  nextId = 2; createdCalls = []; switchCalls = []; deleteCalls = []; dispatched = [];
  fetchCount = 0; lastFetchBody = null; cloudStations = cloud;
}
global.window = {
  dispatchEvent: (e) => dispatched.push(e?.type || String(e)),
  ether: {
    identity: { get: async () => ({ ok: true, machine_id: 'mid', machine_name: 'box-OV' }) },
    stations: {
      list:   async () => localStations.slice(),
      create: async (p) => { createdCalls.push(p); const row = { id: nextId++, uuid: p.uuid }; localStations.push(row); return { ok: true, id: row.id }; },
      switch: async (id) => { switchCalls.push(id); },   // spy — must NEVER be called
      delete: async (id) => { deleteCalls.push(id); },   // spy — must NEVER be called
    },
  },
};
global.fetch = async (url, opts) => {
  if (!String(url).endsWith('/account/connect')) throw new Error('unexpected fetch ' + url);
  fetchCount++; lastFetchBody = JSON.parse(opts.body);
  return { ok: true, json: async () => ({ account_name: 'OV', stations: cloudStations }) };
};

(async () => {
  const checks = [];
  const pass = (label, cond, detail) => checks.push({ label, ok: !!cond, detail });

  // SCENARIO 1 — cloud has EXISTING (already local) + NEW (missing) → only NEW is created.
  reset([
    { uuid: 'EXISTING', name: 'Existing', call_letters: 'EX' },
    { uuid: 'NEW',      name: 'New OV',   call_letters: 'OV', frequency: '' },
  ]);
  const created = await reconcileAccountStations('LICENSE-19');
  pass('returns count = 1 (one materialized)', created === 1, `returned ${created}`);
  pass('exactly the MISSING station created (uuid=NEW, callsign=OV)',
       createdCalls.length === 1 && createdCalls[0].uuid === 'NEW' && createdCalls[0].callsign === 'OV', JSON.stringify(createdCalls));
  pass('existing station NOT re-created', !createdCalls.some(c => c.uuid === 'EXISTING'));
  pass('local list grew by exactly 1 (EXISTING + NEW)', localStations.length === 2);
  pass('active station NEVER switched', switchCalls.length === 0, JSON.stringify(switchCalls));
  pass('NO local station deleted', deleteCalls.length === 0, JSON.stringify(deleteCalls));
  pass('reused existing machine_id (no new seat)', lastFetchBody && lastFetchBody.machine_id === 'mid', JSON.stringify(lastFetchBody));
  pass('UI refresh nudged on change', dispatched.includes('station-switched'));

  // SCENARIO 2 — cloud == local (nothing missing) → no creates, no events.
  reset([{ uuid: 'EXISTING', name: 'Existing', call_letters: 'EX' }]);
  const created2 = await reconcileAccountStations('LICENSE-19');
  pass('no-op when nothing missing: 0 created, no switch/delete/event',
       created2 === 0 && createdCalls.length === 0 && switchCalls.length === 0 && deleteCalls.length === 0 && dispatched.length === 0);

  // SCENARIO 3 — no license → returns 0 and never calls /account/connect.
  reset([{ uuid: 'NEW2', name: 'X', call_letters: 'X' }]);
  const created3 = await reconcileAccountStations(null);
  pass('no license: returns 0 and does NOT hit /account/connect', created3 === 0 && fetchCount === 0);

  console.log('=== RECONCILE ACCOUNT STATIONS (add-only materialize) ===');
  let allOk = true;
  for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`); if (!c.ok) { allOk = false; console.log(`         detail: ${c.detail}`); } }
  console.log('\n=== RESULT:', allOk ? 'RECONCILE OK — materializes missing only; no switch/delete/new-seat ✅' : 'FAIL ❌', '===');
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
