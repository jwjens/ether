'use strict';
const path = require('path');
const os   = require('os');
const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const SCRATCH = path.join(ROOT, 'scratch-client', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

const real    = new Database(REAL_DB, { readonly: true });
const scratch = new Database(SCRATCH, { readonly: true });

// Schema
const kvSchema = real.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='station_config_kv'").get();
console.log('station_config_kv schema:');
console.log(kvSchema ? kvSchema.sql : 'not found');

// Scratch rows
console.log('\nScratch station_config_kv:');
const scratchKv = scratch.prepare('SELECT rowid, uuid, key, station_id FROM station_config_kv ORDER BY key').all();
for (const r of scratchKv) {
  console.log('  rowid=' + r.rowid + ' uuid=' + r.uuid + ' key=' + r.key + ' station_id=' + r.station_id);
}

// Real DB rows
console.log('\nReal DB station_config_kv:');
const realKv = real.prepare('SELECT rowid, uuid, key, station_id FROM station_config_kv ORDER BY key').all();
for (const r of realKv) {
  console.log('  rowid=' + r.rowid + ' uuid=' + r.uuid + ' key=' + r.key + ' station_id=' + r.station_id);
}

// Sample mutation payloads — what station_id do they carry?
console.log('\nSample station_config_kv UPDATE mutation payloads (first 5):');
const kvMuts = real.prepare(
  "SELECT row_id, hlc, payload_before, payload_after FROM mutations WHERE table_name='station_config_kv' AND op='update' LIMIT 5"
).all();
for (const m of kvMuts) {
  const pa = m.payload_after  ? JSON.parse(m.payload_after)  : null;
  const pb = m.payload_before ? JSON.parse(m.payload_before) : null;
  console.log('  row_id=' + m.row_id
    + '  pb.station_id=' + (pb ? pb.station_id : '(null)')
    + '  pa.station_id=' + (pa ? pa.station_id : '(null)')
    + '  pa.key=' + (pa ? pa.key : '?'));
}

// How many mutations vs distinct row_ids vs scratch uuids
const kvTotal  = real.prepare("SELECT COUNT(*) as c FROM mutations WHERE table_name='station_config_kv' AND op='update'").get().c;
const kvNullSt = real.prepare("SELECT COUNT(*) as c FROM mutations WHERE table_name='station_config_kv' AND op='update' AND json_extract(payload_after, '$.station_id') IS NULL").get().c;
console.log('\nTotal station_config_kv UPDATE mutations: ' + kvTotal);
console.log('...where payload_after.station_id IS NULL: ' + kvNullSt);

// Do mutation row_ids match scratch UUIDs?
console.log('\nDo mutation row_ids match scratch UUIDs? (first 10 distinct row_ids):');
const kvMutRowIds = real.prepare("SELECT DISTINCT row_id FROM mutations WHERE table_name='station_config_kv'").all().map(r => r.row_id);
for (const rid of kvMutRowIds.slice(0, 10)) {
  const inScratch = scratch.prepare('SELECT uuid, key FROM station_config_kv WHERE uuid=?').get(rid);
  const inReal    = real.prepare('SELECT uuid, key FROM station_config_kv WHERE uuid=?').get(rid);
  console.log('  row_id=' + rid
    + '  in_real=' + (inReal ? inReal.key : 'NO')
    + '  in_scratch=' + (inScratch ? inScratch.key : 'NO'));
}
console.log('(' + kvMutRowIds.length + ' distinct row_ids in mutations)');

// Show what the merge engine would try to do on an UPDATE where row_id not found
// The NOT NULL failure means the UPDATE applies payload_after.station_id=null to a row
// that has NOT NULL on station_id. Confirm which column has NOT NULL.
console.log('\nColumn info for station_config_kv:');
const cols = real.prepare("PRAGMA table_info('station_config_kv')").all();
for (const c of cols) {
  console.log('  col=' + c.name + '  notnull=' + c.notnull + '  dflt=' + c.dflt_value);
}

real.close();
scratch.close();
