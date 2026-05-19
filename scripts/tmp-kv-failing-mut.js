'use strict';
// Look up specific failing mutation UUIDs from the drain run to see their payload.
// The failing mutation IDs come from the drain log output.
const path = require('path');
const os   = require('os');
const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const SCRATCH = path.join(ROOT, 'scratch-client', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const { deserializePayload } = require(path.join(ROOT, 'electron', 'sync', 'mutation-writer'));

const real    = new Database(REAL_DB, { readonly: true });
const scratch = new Database(SCRATCH, { readonly: true });

// These are actual failing mutation IDs from the drain log output
const failingIds = [
  '4ad8f546-47e8-47ea-8bec-5eae72a25dcd',
  '52767d24-0476-4c23-be92-d41e1f001bfe',
  'efeb6ee1-d4de-4690-847c-fb47242cb05f',
  'ca37b162-843c-45cb-b9ea-4f46e596f120',
  '8b68beed-f707-4af6-bf15-2b02188eba6e',
];

console.log('Looking up failing mutations in real DB:');
for (const id of failingIds) {
  const m = real.prepare(
    "SELECT id, row_id, op, table_name, payload_after FROM mutations WHERE id=?"
  ).get(id);
  if (!m) {
    console.log('  id=' + id + ' → NOT IN REAL DB');
    continue;
  }
  const pa = m.payload_after ? JSON.parse(m.payload_after) : null;
  if (!pa) { console.log('  id=' + id + ' payload_after=NULL'); continue; }
  const row = deserializePayload(pa, m.table_name);
  const cols = Object.keys(row).filter(k => row[k] !== undefined);
  console.log('  id=' + id.slice(0,8) + '... table=' + m.table_name + ' op=' + m.op);
  console.log('    row_id=' + m.row_id);
  console.log('    pa.station_id=' + pa.station_id + '  pa.key=' + pa.key);
  console.log('    cols include station_id: ' + cols.includes('station_id'));
}

// Check: do these IDs appear in scratch mutations table?
console.log('\nChecking if failing mutations are in SCRATCH mutations table:');
for (const id of failingIds) {
  const m = scratch.prepare("SELECT id, row_id, table_name FROM mutations WHERE id=?").get(id);
  console.log('  ' + id.slice(0,8) + '...: ' + (m ? 'FOUND in scratch' : 'NOT in scratch'));
}

// Check: are these IDs perhaps from a DIFFERENT client_id (not this machine)?
console.log('\nChecking client_id for failing mutations (real DB):');
for (const id of failingIds) {
  const m = real.prepare("SELECT id, client_id, row_id FROM mutations WHERE id=?").get(id);
  if (!m) { console.log('  ' + id.slice(0,8) + '...: not found'); continue; }
  const localId = real.prepare('SELECT client_id FROM client_identity WHERE id=1').get()?.client_id;
  console.log('  ' + id.slice(0,8) + '...: client_id=' + m.client_id + (m.client_id === localId ? ' (LOCAL)' : ' (REMOTE)'));
}

// Important: look up one failing mutation's row_id in scratch table
// to see if the UUID mismatch IS the cause
console.log('\nFor each failing mutation: check if row_id is in scratch station_config_kv:');
for (const id of failingIds) {
  const m = real.prepare("SELECT row_id, payload_after FROM mutations WHERE id=?").get(id);
  if (!m) { console.log('  ' + id.slice(0,8) + '...: not in real DB'); continue; }
  const inScratch = scratch.prepare('SELECT uuid, key FROM station_config_kv WHERE uuid=?').get(m.row_id);
  const pa = m.payload_after ? JSON.parse(m.payload_after) : null;
  console.log('  ' + id.slice(0,8) + '...: row_id=' + m.row_id.slice(0,8) + '...'
    + '  in_scratch=' + (inScratch ? inScratch.key : 'NO')
    + '  pa.station_id=' + (pa ? pa.station_id : '?')
    + '  pa.key=' + (pa ? pa.key : '?'));
}

real.close();
scratch.close();
