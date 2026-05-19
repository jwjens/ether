'use strict';
const path = require('path');
const ROOT   = path.join(__dirname, '..');
const SCRATCH = path.join(ROOT, 'scratch-client', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const { deserializePayload } = require(path.join(ROOT, 'electron', 'sync', 'mutation-writer'));

const s = new Database(SCRATCH, { readonly: true });

// Grab station_config_kv UPDATE mutations that were pulled from the backend
const kvMuts = s.prepare(
  "SELECT id, row_id, payload_after FROM mutations WHERE table_name='station_config_kv' AND op='update' ORDER BY hlc LIMIT 20"
).all();

console.log('station_config_kv UPDATE mutations in scratch (first 20):');
for (const m of kvMuts) {
  const pa = m.payload_after ? JSON.parse(m.payload_after) : null;
  if (!pa) { console.log('  id=' + m.id + ' row_id=' + m.row_id + ' payload_after=NULL'); continue; }

  // Simulate deserializePayload
  const row  = deserializePayload(pa, 'station_config_kv');
  const cols = Object.keys(row).filter(k => row[k] !== undefined);

  console.log('  id=' + m.id + ' row_id=' + m.row_id.slice(0,8) + '...');
  console.log('    pa.station_id=' + pa.station_id + '  pa.key=' + pa.key);
  console.log('    pa.station_id type=' + typeof pa.station_id + '  in pa: ' + ('station_id' in pa));
  console.log('    after deserialize: row.station_id=' + row.station_id + '  in cols: ' + cols.includes('station_id'));
  const setCols = cols.filter(c => c !== 'uuid' && c !== 'id');
  console.log('    setCols includes station_id: ' + setCols.includes('station_id'));
  const vals   = cols.map(c => row[c] ?? null);
  const sidIdx = cols.indexOf('station_id');
  console.log('    vals[station_id]=' + (sidIdx >= 0 ? vals[sidIdx] : 'NOT IN COLS'));
}

// Now specifically find mutations where the INSERT OR REPLACE would fail
// i.e. station_id is not in cols (undefined in row)
console.log('\nMutations where station_id would be MISSING from INSERT cols:');
const all = s.prepare(
  "SELECT id, row_id, payload_after FROM mutations WHERE table_name='station_config_kv' AND op='update'"
).all();
let missing = 0;
for (const m of all) {
  const pa = m.payload_after ? JSON.parse(m.payload_after) : null;
  if (!pa) continue;
  const row  = deserializePayload(pa, 'station_config_kv');
  const cols = Object.keys(row).filter(k => row[k] !== undefined);
  if (!cols.includes('station_id')) {
    missing++;
    if (missing <= 5) {
      console.log('  id=' + m.id + ' row_id=' + m.row_id + ' pa.station_id=' + pa.station_id + ' typeof=' + typeof pa.station_id);
      console.log('  full pa:', JSON.stringify(pa));
    }
  }
}
console.log('Total mutations where station_id missing from cols:', missing, '(out of', all.length, ')');

s.close();
