'use strict';
// scripts/prove-staged-import.js
//
// Proves the cloud-staged-programming sign-in import end-to-end against a real better-sqlite3 DB,
// using the REAL importStagedProgramming + applyDbMutation (transpiled from ccData.ts) and the
// REAL sync handlers (categoriesCreate/clocksCreate/clockSlotsCreate/showsCreate → withMutation).
//
// Asserts: station_uuid + cross-row parent UUIDs resolve to local ids; categories carry DJ's ids
// (id-passthrough) so the BORROWED LIBRARY's songs fill OV's clocks; idempotent re-import (imported
// gate AND uuid-UNIQUE safety net); and the core sync/merge path is untouched (all mutations local).
//
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/prove-staged-import.js

const fs = require('fs'); const path = require('path'); const Module = require('module');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

const OV_UUID = 'OV-STATION-UUID', OV_ID = 7, LICENSE = 'OV-LICENSE';
const db = new Database(':memory:');

// ── Machinery the handlers (withMutation) require ──
db.exec(`
  CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (22);
  CREATE TABLE client_identity (client_id TEXT); INSERT INTO client_identity VALUES ('11111111-1111-1111-1111-111111111111');
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  INSERT INTO system_state VALUES ('hlc_last','1745000000000:0:11111111-1111-1111-1111-111111111111','2026-01-01T00:00:00Z');
  CREATE TABLE install_config_kv (key TEXT PRIMARY KEY, value TEXT, deleted_at TEXT);
  CREATE TABLE mutations (
    id TEXT PRIMARY KEY, client_id TEXT, station_id TEXT, actor_id TEXT, table_name TEXT, row_id TEXT, op TEXT,
    payload_before TEXT, payload_after TEXT, created_at TEXT, applied_at TEXT, hlc TEXT, parent_mutation_id TEXT,
    schema_version INTEGER, origin TEXT, sync_status TEXT, conflict_resolution TEXT );
  CREATE TABLE stations (id INTEGER PRIMARY KEY, uuid TEXT, deleted_at TEXT);
  INSERT INTO stations VALUES (${OV_ID}, '${OV_UUID}', NULL);
  CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, color TEXT, spins_per_hour INTEGER, priority INTEGER, station_id INTEGER, uuid TEXT UNIQUE, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE clocks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, show_id INTEGER, description TEXT, color TEXT, station_id INTEGER, uuid TEXT UNIQUE, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE shows (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, start_hour INTEGER, end_hour INTEGER, days TEXT, color TEXT, description TEXT, is_active INTEGER, clock_id INTEGER, station_id INTEGER, uuid TEXT UNIQUE, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE clock_slots (id INTEGER PRIMARY KEY AUTOINCREMENT, clock_id INTEGER, position INTEGER, slot_type TEXT, category_id INTEGER, song_id INTEGER, label TEXT, duration_min INTEGER, spot_type TEXT, station_id INTEGER, uuid TEXT UNIQUE, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  -- BORROWED library: DJ's songs carry DJ's category_id (101,102); song C (999) is off OV's clocks.
  CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, category_id INTEGER, deleted_at TEXT);
  INSERT INTO songs VALUES (1,'Borrowed A',101,NULL),(2,'Borrowed B',102,NULL),(3,'Borrowed C',999,NULL);
`);

// ── Load REAL ccData.ts (importStagedProgramming + applyDbMutation), stubbing its 2 imports.
const ccPath = path.join(__dirname, '..', 'src', 'lib', 'ccData.ts');
const code = ts.transpileModule(fs.readFileSync(ccPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const origLoad = Module._load;
Module._load = function (req) {
  if (req === './etherBackend') return { ETHER_BACKEND_URL: 'http://stub' };
  if (req === '../db/client') return { query: async (sql, params) => db.prepare(sql).all(...(params || [])) }; // real DB
  return origLoad.apply(this, arguments);
};
const mod = new Module(ccPath, module); mod.filename = ccPath; mod.paths = Module._nodeModulePaths(path.dirname(ccPath));
mod._compile(code, ccPath); Module._load = origLoad;
const { importStagedProgramming } = mod.exports;

// ── REAL handlers ──
const H = {
  categories: require('../electron/sync/handlers/categories').categoriesCreate,
  clocks:     require('../electron/sync/handlers/clocks').clocksCreate,
  clockSlots: require('../electron/sync/handlers/clock_slots').clockSlotsCreate,
  shows:      require('../electron/sync/handlers/shows').showsCreate,
};

// ── The cloud-staged programming for OV (parents by UUID; categories carry DJ's ids) ──
const STAGED = [
  { table_name: 'categories', row_uuid: 'cat-pg', payload: { id: 101, code: 'PG', name: 'Power Gold', color: '#f00', spins_per_hour: 3, priority: 1 } },
  { table_name: 'categories', row_uuid: 'cat-re', payload: { id: 102, code: 'RE', name: 'Recurrent', color: '#0f0', spins_per_hour: 2, priority: 2 } },
  { table_name: 'clocks',     row_uuid: 'clk-am', payload: { name: 'AM Drive', color: '#00f' } },
  { table_name: 'shows',      row_uuid: 'shw-1',  payload: { name: 'Morning', start_hour: 6, end_hour: 10, days: '1,2,3,4,5', is_active: 1, clock_uuid: 'clk-am' } },
  { table_name: 'clock_slots',row_uuid: 'slot-1', payload: { position: 0, slot_type: 'music', duration_min: 15, clock_uuid: 'clk-am', category_uuid: 'cat-pg' } },
  { table_name: 'clock_slots',row_uuid: 'slot-2', payload: { position: 1, slot_type: 'music', duration_min: 15, clock_uuid: 'clk-am', category_uuid: 'cat-re' } },
];
const imported = new Set();           // row_uuids the backend has marked imported
let forcePending = false;             // when true, /pending returns rows even if imported (uuid safety-net test)

global.window = {
  dispatchEvent: () => {},
  ether: {
    identity: { get: async () => ({ ok: true, machine_id: 'mid', machine_name: 'box' }) },
    stations: { list: async () => db.prepare('SELECT id, uuid FROM stations WHERE deleted_at IS NULL').all() },
    categories: { create: async (p) => H.categories(db, p), list: async (sid) => ({ rows: db.prepare('SELECT * FROM categories WHERE station_id=? AND deleted_at IS NULL').all(sid) }) },
    clocks:     { create: async (p) => H.clocks(db, p),     list: async (sid) => ({ rows: db.prepare('SELECT * FROM clocks WHERE station_id=? AND deleted_at IS NULL').all(sid) }) },
    clockSlots: { create: async (p) => H.clockSlots(db, p), list: async (sid) => ({ rows: db.prepare('SELECT * FROM clock_slots WHERE station_id=? AND deleted_at IS NULL').all(sid) }) },
    shows:      { create: async (p) => H.shows(db, p),      list: async (sid) => ({ rows: db.prepare('SELECT * FROM shows WHERE station_id=? AND deleted_at IS NULL').all(sid) }) },
  },
};
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/staged/pending')) {
    const rows = STAGED.filter(r => forcePending || !imported.has(r.row_uuid));
    return { ok: true, json: async () => ({ rows }) };
  }
  if (u.endsWith('/staged/mark-imported')) { JSON.parse(opts.body).row_uuids.forEach(id => imported.add(id)); return { ok: true, json: async () => ({ ok: true }) }; }
  if (u.includes('/api/account/data/sync')) return { ok: true, json: async () => ({ ok: true }) }; // applyDbMutation's re-push — no-op
  throw new Error('unexpected fetch ' + u);
};

const checks = []; const pass = (l, c, d) => checks.push({ l, ok: !!c, d });
const cnt = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE deleted_at IS NULL`).get().n;

(async () => {
  // ── IMPORT #1 ──
  await importStagedProgramming(LICENSE);

  const cats = db.prepare('SELECT id, code FROM categories ORDER BY id').all();
  pass('categories imported with DJ ids (id-passthrough): 101,102', cats.length === 2 && cats[0].id === 101 && cats[1].id === 102, JSON.stringify(cats));
  pass('all categories scoped to OV station 7', db.prepare('SELECT COUNT(*) n FROM categories WHERE station_id=7').get().n === 2);

  const clk = db.prepare('SELECT id, station_id FROM clocks').get();
  pass('clock imported, station_id resolved to 7', clk && clk.station_id === 7, JSON.stringify(clk));

  const show = db.prepare('SELECT clock_id, station_id FROM shows').get();
  pass('show.clock_id resolved (uuid→local clock id) + station 7', show && show.clock_id === clk.id && show.station_id === 7, JSON.stringify(show));

  const slots = db.prepare('SELECT clock_id, category_id, station_id FROM clock_slots ORDER BY position').all();
  pass('clock_slots FKs resolved: clock_id→local, category_id∈{101,102}, station 7',
    slots.length === 2 && slots.every(s => s.clock_id === clk.id && s.station_id === 7) && slots.map(s => s.category_id).sort().join() === '101,102', JSON.stringify(slots));

  // ── THE PAYOFF: borrowed library matches OV's categories → fills rotation ──
  const fill = db.prepare(`
    SELECT s.title FROM songs s
     WHERE s.deleted_at IS NULL
       AND s.category_id IN (SELECT DISTINCT category_id FROM clock_slots WHERE slot_type='music' AND deleted_at IS NULL)
     ORDER BY s.title`).all().map(r => r.title);
  pass('BORROWED LIBRARY MATCHES: songs fill OV clocks via DJ category ids → [Borrowed A, Borrowed B]',
    fill.length === 2 && fill[0] === 'Borrowed A' && fill[1] === 'Borrowed B', JSON.stringify(fill));

  // ── Core sync path untouched: every mutation is a normal LOCAL mutation (merge engine never ran) ──
  const muts = db.prepare("SELECT origin, COUNT(*) n FROM mutations GROUP BY origin").all();
  pass('core sync untouched: all mutations origin=local (no remote/merge writes), count>0',
    muts.length === 1 && muts[0].origin === 'local' && muts[0].n >= 6, JSON.stringify(muts));

  // ── Idempotency #1: imported-gate — re-import sees empty /pending → no new rows ──
  const before = [cnt('categories'), cnt('clocks'), cnt('shows'), cnt('clock_slots')].join();
  await importStagedProgramming(LICENSE);
  pass('idempotent (imported-gate): re-import adds nothing', [cnt('categories'), cnt('clocks'), cnt('shows'), cnt('clock_slots')].join() === before, before);

  // ── Idempotency #2: uuid-UNIQUE safety net — force /pending to redeliver everything → still no dups ──
  forcePending = true;
  await importStagedProgramming(LICENSE);
  pass('idempotent (uuid-UNIQUE safety net): forced redelivery adds nothing', [cnt('categories'), cnt('clocks'), cnt('shows'), cnt('clock_slots')].join() === before, [cnt('categories'), cnt('clocks'), cnt('shows'), cnt('clock_slots')].join());

  console.log('=== STAGED PROGRAMMING IMPORT — FULL CHAIN ===');
  let ok = true;
  for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.l}`); if (!c.ok) { ok = false; console.log(`         detail: ${c.d}`); } }
  console.log('\n=== RESULT:', ok ? 'STAGING WORKS — FKs resolved, DJ-aligned categories fill from the borrowed library, idempotent, core sync untouched ✅' : 'FAIL ❌', '===');
  db.close(); process.exit(ok ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
