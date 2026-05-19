'use strict';
// Try to reproduce the NOT NULL station_config_kv failure.
// Opens scratch DB with WRITE access and runs the exact UPDATE that fails.
const path = require('path');
const os   = require('os');
const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const SCRATCH = path.join(ROOT, 'scratch-client', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const { deserializePayload } = require(path.join(ROOT, 'electron', 'sync', 'mutation-writer'));

const real    = new Database(REAL_DB, { readonly: true });
// Open scratch READ-WRITE to test the actual SQL
const scratch = new Database(SCRATCH);

// Get the failing mutation from real DB
const failId = '4ad8f546-47e8-47ea-8bec-5eae72a25dcd';
const m = real.prepare("SELECT * FROM mutations WHERE id=?").get(failId);
const pa = m ? JSON.parse(m.payload_after) : null;
const row = deserializePayload(pa, 'station_config_kv');
const cols = Object.keys(row).filter(k => row[k] !== undefined);
const setCols = cols.filter(c => c !== 'uuid' && c !== 'id');
const setVals = setCols.map(c => row[c] ?? null);

console.log('Reproducing failure for canvas_layout mutation...');
console.log('row_id:', m.row_id);
console.log('setCols:', setCols);
console.log('setVals:', setVals);

// Check current state of canvas_layout in scratch
const kvRow = scratch.prepare('SELECT * FROM station_config_kv WHERE uuid=?').get(m.row_id);
console.log('\nCurrent canvas_layout in scratch:', kvRow ? {station_id: kvRow.station_id, key: kvRow.key} : 'NOT FOUND');

// Check if there's ANOTHER row with the same (station_id, key)
const dupRows = scratch.prepare('SELECT * FROM station_config_kv WHERE station_id=1 AND key=?').all('canvas_layout');
console.log('Rows with station_id=1, key=canvas_layout:', dupRows.length);
for (const r of dupRows) {
  console.log('  uuid=' + r.uuid + ' station_id=' + r.station_id);
}

// Try the exact UPDATE
const setClause = setCols.map(c => c + ' = ?').join(', ');
const sql = 'UPDATE station_config_kv SET ' + setClause + ' WHERE uuid = ?';
console.log('\nAttempting: ' + sql);
console.log('params:', [...setVals, m.row_id]);

try {
  scratch.pragma('foreign_keys = OFF');
  const result = scratch.prepare(sql).run(...setVals, m.row_id);
  console.log('UPDATE succeeded! changes=' + result.changes);
} catch (err) {
  console.log('UPDATE FAILED: ' + err.message);
}

// Now try the full merge engine apply path in isolation
console.log('\n--- Full mergeEngine.apply() simulation ---');
try {
  const { SyncEngine } = require(path.join(ROOT, 'electron', 'sync', 'sync-engine'));
  // We need a transport stub — won't actually call network
  // Just test the merge engine directly
  const { MergeEngine } = (() => {
    try { return require(path.join(ROOT, 'electron', 'sync', 'merge-engine')); }
    catch(e) { return {}; }
  })();

  if (!MergeEngine) {
    console.log('MergeEngine not exported directly, trying manual application...');
  }
} catch(e) {
  console.log('Cannot load MergeEngine:', e.message);
}

// Try applying via SyncEngine in a pull-like manner
// Build a fake wire mutation from the real DB mutation
const wireMut = {
  id:               m.id,
  client_id:        m.client_id,
  station_id:       m.station_id,
  actor_id:         m.actor_id,
  table_name:       m.table_name,
  row_id:           m.row_id,
  op:               m.op,
  payload_before:   m.payload_before ? JSON.parse(m.payload_before) : null,
  payload_after:    pa,
  created_at:       m.created_at,
  hlc:              m.hlc,
  parent_mutation_id: m.parent_mutation_id,
  schema_version:   m.schema_version,
};

console.log('\nTrying MergeEngine.apply() directly on scratch...');
// We need to construct the merge engine the same way sync-engine does
const { MergeEngine: ME } = (() => {
  try {
    // merge-engine is not exported in isolation, check
    return require(path.join(ROOT, 'electron', 'sync', 'merge-engine'));
  } catch(e) {
    console.log('merge-engine module error:', e.message);
    return {};
  }
})();
if (ME) {
  const { CausalOrderQueue } = require(path.join(ROOT, 'electron', 'sync', 'causal-order'));
  const cq = new CausalOrderQueue();
  const engine = new ME(scratch, {
    localSchemaVersion: 16,
    causalQueue: cq,
    onCursorAdvance: () => {},
  });
  try {
    const outcome = engine.apply(wireMut);
    console.log('MergeEngine.apply() outcome:', outcome);
  } catch(e) {
    console.log('MergeEngine.apply() THREW:', e.message);
    console.log('Stack:', e.stack);
  }
}

real.close();
scratch.close();
