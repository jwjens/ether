'use strict';
// Look at the actual payload_after for station_config_kv mutations whose
// row_ids are NOT in scratch — these are the mutations that fail on drain.
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

// Get distinct row_ids from backend mutations that are NOT in scratch station_config_kv
const realMuts = real.prepare(
  "SELECT DISTINCT row_id FROM mutations WHERE table_name='station_config_kv' AND op='update'"
).all().map(r => r.row_id);

console.log('Distinct row_ids in real DB station_config_kv UPDATE mutations:', realMuts.length);

const notInScratch = [];
for (const rid of realMuts) {
  const inScratch = scratch.prepare('SELECT uuid FROM station_config_kv WHERE uuid=?').get(rid);
  if (!inScratch) notInScratch.push(rid);
}
console.log('Row_ids NOT in scratch station_config_kv:', notInScratch.length);

// For each missing row_id, get one mutation and inspect its payload
for (const rid of notInScratch) {
  const m = real.prepare(
    "SELECT id, row_id, payload_after FROM mutations WHERE table_name='station_config_kv' AND op='update' AND row_id=? LIMIT 1"
  ).get(rid);
  if (!m) continue;

  const pa = m.payload_after ? JSON.parse(m.payload_after) : null;
  if (!pa) { console.log('  ' + rid.slice(0,8) + '...: payload_after=NULL'); continue; }

  const row   = deserializePayload(pa, 'station_config_kv');
  const cols  = Object.keys(row).filter(k => row[k] !== undefined);
  const hasStation = cols.includes('station_id');

  const kvRow = real.prepare('SELECT key, station_id FROM station_config_kv WHERE uuid=?').get(rid);

  console.log('  row_id=' + rid.slice(0,8) + '...'
    + '  key=' + (kvRow ? kvRow.key : '?')
    + '  real.station_id=' + (kvRow ? kvRow.station_id : '?')
    + '  pa.station_id=' + pa.station_id
    + '  pa.station_id type=' + typeof pa.station_id
    + '  in cols: ' + hasStation
    + '  cols.length=' + cols.length
  );

  if (!hasStation || pa.station_id === null || pa.station_id === undefined) {
    console.log('  *** STATION_ID PROBLEM *** full payload:', JSON.stringify(pa));
  }
}

// Count how many of these would trigger INSERT OR REPLACE fallback in scratch
// (i.e., UPDATE WHERE uuid = row_id → changes = 0, then INSERT OR REPLACE)
// And simulate whether the INSERT would succeed
console.log('\nSimulating INSERT OR REPLACE for non-scratch row_ids:');
let wouldSucceed = 0, wouldFail = 0;
for (const rid of notInScratch) {
  const mutations = real.prepare(
    "SELECT id, row_id, payload_after FROM mutations WHERE table_name='station_config_kv' AND op='update' AND row_id=? LIMIT 1"
  ).get(rid);
  if (!mutations) continue;
  const pa = mutations.payload_after ? JSON.parse(mutations.payload_after) : null;
  if (!pa) { wouldFail++; continue; }
  const row  = deserializePayload(pa, 'station_config_kv');
  const cols = Object.keys(row).filter(k => row[k] !== undefined);
  if (!cols.includes('station_id') || (row['station_id'] ?? null) === null) {
    wouldFail++;
    console.log('  FAIL: row_id=' + rid + ' pa.station_id=' + pa.station_id);
  } else {
    wouldSucceed++;
  }
}
console.log('Would succeed:', wouldSucceed, '  Would fail:', wouldFail);

// Critical check: what does scratch-sync-pull step 3 inject?
console.log('\nScratch station_config_kv rows currently in scratch:');
const scratchRows = scratch.prepare('SELECT uuid, key, station_id FROM station_config_kv ORDER BY key').all();
for (const r of scratchRows) {
  const inRealMut = notInScratch.includes(r.uuid) ? 'NOT IN MUTATIONS' : 'has mutations';
  console.log('  uuid=' + r.uuid.slice(0,8) + '... key=' + r.key + ' station_id=' + r.station_id + ' [' + inRealMut + ']');
}

// Big picture: how many station_config_kv UPDATE mutations have station_id=3 or system
// (those are the ones pulled despite scratch being station_id=1)?
const bySid = real.prepare(
  "SELECT json_extract(payload_after, '$.station_id') as sid, COUNT(*) as c FROM mutations WHERE table_name='station_config_kv' AND op='update' GROUP BY sid ORDER BY c DESC"
).all();
console.log('\nstation_config_kv UPDATE mutations grouped by payload_after.station_id:');
for (const r of bySid) console.log('  station_id=' + r.sid + '  count=' + r.c);

real.close();
scratch.close();
