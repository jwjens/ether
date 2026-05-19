'use strict';
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

// Check mutations table schema — specifically station_id column constraints
console.log('MUTATIONS TABLE — column info:');
const mutCols = scratch.prepare("PRAGMA table_info('mutations')").all();
for (const c of mutCols) {
  if (c.name === 'station_id') console.log('  *** station_id: notnull=' + c.notnull + ' dflt=' + c.dflt_value);
  else console.log('  ' + c.name + ': notnull=' + c.notnull);
}

// Check the exact mutation envelope: does m.station_id (the wire-level station_id) differ from payload_after.station_id?
const failId = '4ad8f546-47e8-47ea-8bec-5eae72a25dcd';
const m = real.prepare("SELECT * FROM mutations WHERE id=?").get(failId);
if (m) {
  const pa = m.payload_after ? JSON.parse(m.payload_after) : null;
  console.log('\nFailing mutation envelope (real DB):');
  console.log('  m.station_id (envelope):', m.station_id, '  (type: ' + typeof m.station_id + ')');
  console.log('  m.table_name:', m.table_name);
  console.log('  m.op:', m.op);
  console.log('  m.row_id:', m.row_id);
  console.log('  payload_after.station_id:', pa ? pa.station_id : '(null payload)');

  // Simulate _logRemote: what station_id does it store in the mutations table?
  console.log('\n  In _logRemote: m.station_id ?? null =', m.station_id ?? null);

  // Now simulate the full _applyToLiveTable + _logRemote sequence
  const row = pa ? deserializePayload(pa, m.table_name) : {};
  const cols = Object.keys(row).filter(k => row[k] !== undefined);
  console.log('\n  After deserializePayload: cols =', cols);
  const setCols = cols.filter(c => c !== 'uuid' && c !== 'id');
  console.log('  setCols =', setCols);
  const setVals = setCols.map(c => row[c] ?? null);
  console.log('  setVals =', setVals);

  // Check the scratch canvas_layout row
  const kvRow = scratch.prepare('SELECT * FROM station_config_kv WHERE uuid=?').get(m.row_id);
  console.log('\n  Scratch canvas_layout row:', kvRow ? JSON.stringify({station_id: kvRow.station_id, key: kvRow.key, uuid: kvRow.uuid}) : 'NOT FOUND');

  // Try the actual UPDATE on scratch
  if (kvRow) {
    console.log('\n  Attempting actual UPDATE on a COPY of the scratch DB...');
    const setClause = setCols.map(c => c + ' = ?').join(', ');
    const sql = 'UPDATE station_config_kv SET ' + setClause + ' WHERE uuid = ?';
    console.log('  SQL:', sql);
    console.log('  params:', [...setVals, m.row_id]);
    // DON'T actually run it on scratch (readonly). Just show what would happen.
  }
} else {
  console.log('\nMutation ' + failId + ' not found in real DB');
}

// Check: is there a UNIQUE constraint on station_config_kv?
console.log('\nstation_config_kv INDEXES:');
const kvIdx = scratch.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='station_config_kv'").all();
for (const idx of kvIdx) console.log('  ' + (idx.sql || '(auto-index)'));

real.close();
scratch.close();
