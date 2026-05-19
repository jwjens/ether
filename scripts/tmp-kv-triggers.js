'use strict';
const path = require('path');
const ROOT   = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, 'scratch-client', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const s = new Database(SCRATCH, { readonly: true });

// Check for triggers on station_config_kv
console.log('Triggers on station_config_kv:');
const triggers = s.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='station_config_kv'").all();
if (triggers.length === 0) {
  console.log('  (none)');
} else {
  for (const t of triggers) console.log('  ' + t.sql);
}

// Check if there's a separate table or view that station_config_kv is backed by
console.log('\nAll views:');
const views = s.prepare("SELECT name FROM sqlite_master WHERE type='view'").all();
for (const v of views) console.log('  ' + v.name);

// Key question: what is the EXACT sequence that causes the failure?
// During round 1 of drain, canvas_layout UPDATE arrives BEFORE its INSERT.
// Let's simulate: remove canvas_layout from scratch, then try the UPDATE INSERT fallback.
console.log('\nChecking: what row_ids are NOT in scratch at drain start?');
// The drain starts from since_seq=550 (from pull.js which did one pull).
// pull.js did one pull of 500 mutations (since_seq=0). The canvas_layout row
// was created in that first pull IF its INSERT mutation was in the first 500.
// If the INSERT was AFTER seq 500, the row doesn't exist at drain start.
// Then when the UPDATE arrives in round 1, it tries INSERT OR REPLACE fallback.

// Check current state: is canvas_layout in scratch right now?
const kv = s.prepare('SELECT uuid, key, station_id FROM station_config_kv WHERE key=?').get('canvas_layout');
console.log('\ncanvas_layout in scratch:', kv);

// What is the mutation sequence for canvas_layout in the real DB?
const os   = require('os');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const r = new Database(REAL_DB, { readonly: true });
const clMuts = r.prepare(
  "SELECT id, op, hlc, json_extract(payload_after,'$.station_id') as sid FROM mutations WHERE table_name='station_config_kv' AND row_id='4736e818-1eb8-4269-9d27-c5c8e2ed87f0' ORDER BY hlc"
).all();
console.log('\ncanvas_layout (uuid=4736e818) mutations in real DB (' + clMuts.length + ' total):');
console.log('  (first INSERT is the key one — must arrive before UPDATEs)');
for (const m of clMuts.slice(0, 5)) {
  console.log('  op=' + m.op + ' sid=' + m.sid + ' hlc=' + m.hlc.slice(0, 15) + '...');
}
if (clMuts.length > 5) {
  console.log('  ... (' + clMuts.length + ' total)');
}

// How many INSERT vs UPDATE mutations for canvas_layout?
const clIns = clMuts.filter(m => m.op === 'insert');
const clUpd = clMuts.filter(m => m.op === 'update');
console.log('  INSERT count:', clIns.length);
console.log('  UPDATE count:', clUpd.length);

// Now check: what if the INSERT arrives AFTER some UPDATEs?
// The failure is the INSERT OR REPLACE fallback. Let's manually test it.
// Simulate: canvas_layout NOT in scratch, then run INSERT OR REPLACE
// from a canvas_layout UPDATE mutation's payload_after
const { deserializePayload } = require(path.join(ROOT, 'electron', 'sync', 'mutation-writer'));
const sampleUpd = r.prepare(
  "SELECT * FROM mutations WHERE table_name='station_config_kv' AND op='update' AND row_id='4736e818-1eb8-4269-9d27-c5c8e2ed87f0' LIMIT 1"
).get();
if (sampleUpd) {
  const pa   = JSON.parse(sampleUpd.payload_after);
  const row  = deserializePayload(pa, 'station_config_kv');
  const cols = Object.keys(row).filter(k => row[k] !== undefined);
  const vals = cols.map(c => row[c] ?? null);
  const placeholders = cols.map(() => '?').join(', ');
  const iSql = 'INSERT OR REPLACE INTO station_config_kv (' + cols.join(', ') + ') VALUES (' + placeholders + ')';
  console.log('\nINSERT OR REPLACE that fallback would run (if row not in scratch):');
  console.log('  SQL:', iSql);
  console.log('  station_id param:', vals[cols.indexOf('station_id')]);
  console.log('  Would this succeed? station_id is not null:', vals[cols.indexOf('station_id')] !== null);
}

r.close();
s.close();
