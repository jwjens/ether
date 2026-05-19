'use strict';
// Pull ONE page from backend and print the raw payload_after for any
// station_config_kv UPDATE mutations we see. This reveals exactly what
// the merge engine receives from the wire.
const path = require('path');
const os   = require('os');
const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const SCRATCH = path.join(ROOT, 'scratch-client', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

const real    = new Database(REAL_DB, { readonly: true });
const scratch = new Database(SCRATCH, { readonly: true });

const syncUrl   = scratch.prepare("SELECT value FROM station_config_kv WHERE key='sync_backend_url' LIMIT 1").get()?.value;
const since_seq = scratch.prepare("SELECT value FROM system_state WHERE key='sync_server_seq'").get()?.value ?? '0';
const clientId  = scratch.prepare('SELECT client_id FROM client_identity WHERE id=1').get()?.client_id;
const stationId = 1;

const licKey = real.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND station_id=1 LIMIT 1").get()?.value;
real.close();
scratch.close();

console.log('Pulling ONE page from backend to inspect station_config_kv mutation payloads...');
console.log('since_seq:', since_seq, '  syncUrl:', syncUrl);

const params = new URLSearchParams({ since_seq, client_id: clientId, station_id: stationId, limit: 500 });
fetch(syncUrl + '/sync/mutations?' + params.toString(), {
  headers: { 'x-license-key': licKey }
}).then(r => r.json()).then(result => {
  const kvMuts = (result.mutations ?? []).filter(m => m.table_name === 'station_config_kv' && m.op === 'update');
  console.log('Total mutations in page:', (result.mutations ?? []).length);
  console.log('station_config_kv UPDATE mutations in this page:', kvMuts.length);

  for (const m of kvMuts.slice(0, 10)) {
    const pa = m.payload_after;
    console.log('---');
    console.log('  row_id:', m.row_id);
    console.log('  payload_after type:', typeof pa);
    console.log('  payload_after.station_id:', pa ? pa.station_id : '(no payload_after)');
    console.log('  payload_after.key:', pa ? pa.key : '?');
    console.log('  payload_after keys:', pa ? Object.keys(pa) : '[]');
    // Specifically check: is station_id present in the object? (vs undefined)
    if (pa) {
      console.log('  station_id in pa:', 'station_id' in pa);
      console.log('  pa.station_id === null:', pa.station_id === null);
      console.log('  pa.station_id === undefined:', pa.station_id === undefined);
    }
  }

  // Also check: what does the merge engine's _applyToLiveTable actually get?
  // Simulate deserializePayload for the first failing mutation
  if (kvMuts.length > 0) {
    const { deserializePayload } = require(path.join(ROOT, 'electron', 'sync', 'mutation-writer'));
    const m = kvMuts[0];
    const row = deserializePayload(m.payload_after, 'station_config_kv');
    const cols = Object.keys(row).filter(k => row[k] !== undefined);
    const vals = cols.map(c => row[c] ?? null);
    const setCols = cols.filter(c => c !== 'uuid' && c !== 'id');
    console.log('\n=== SIMULATED _applyToLiveTable for first kv UPDATE mutation ===');
    console.log('  row after deserialize:', JSON.stringify(row));
    console.log('  cols (defined):', cols);
    console.log('  setCols:', setCols);
    console.log('  vals:', vals);
    console.log('  station_id in cols:', cols.includes('station_id'));
    console.log('  station_id in setCols:', setCols.includes('station_id'));
    const stationIdVal = row['station_id'];
    console.log('  row.station_id raw:', stationIdVal, '(type: ' + typeof stationIdVal + ')');
    console.log('  row.station_id ?? null:', stationIdVal ?? null);
  }

  process.exit(0);
}).catch(err => {
  console.error('fetch error:', err.message);
  process.exit(1);
});
