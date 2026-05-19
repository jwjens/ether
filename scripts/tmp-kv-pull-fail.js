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
// Open scratch READ-WRITE to test
const scratch = new Database(SCRATCH);

// Look up pull.js failing mutation IDs
const failIds = [
  'a3d5a389-3f04-4b00-9e25-fac946a27055',
  'c1aee4b9-2cef-44c5-ad25-391eb7c59093',
  '7e1be244-2a0e-43f7-8674-ab95d31e5356',
  '6cc9b181-1d42-46fc-8f97-634e69f994a4',
];

console.log('Looking up pull.js failing mutations in real DB:');
for (const id of failIds) {
  const m = real.prepare("SELECT * FROM mutations WHERE id=?").get(id);
  if (!m) { console.log('  ' + id.slice(0,8) + '...: NOT IN REAL DB'); continue; }
  const pa = m.payload_after ? JSON.parse(m.payload_after) : null;
  const kvRow = real.prepare('SELECT key, station_id FROM station_config_kv WHERE uuid=?').get(m.row_id);
  console.log('  id=' + id.slice(0,8) + '...');
  console.log('    row_id=' + m.row_id);
  console.log('    key=' + (kvRow ? kvRow.key : '?') + '  station_id=' + (kvRow ? kvRow.station_id : '?'));
  console.log('    pa.station_id=' + (pa ? pa.station_id : 'NO PA') + '  pa.key=' + (pa ? pa.key : '?'));
  console.log('    pa.station_id type=' + (pa ? typeof pa.station_id : '?'));
}

// Now test the actual INSERT OR REPLACE that would fail
// Pick the first failing mutation
const failM = real.prepare("SELECT * FROM mutations WHERE id=?").get(failIds[0]);
if (failM) {
  const pa   = failM.payload_after ? JSON.parse(failM.payload_after) : null;
  const row  = pa ? deserializePayload(pa, failM.table_name) : {};
  const cols = Object.keys(row).filter(k => row[k] !== undefined);
  const vals = cols.map(c => row[c] ?? null);
  const placeholders = cols.map(() => '?').join(', ');
  const insertSql = 'INSERT OR REPLACE INTO ' + failM.table_name + ' (' + cols.join(', ') + ') VALUES (' + placeholders + ')';

  console.log('\nAttempting INSERT OR REPLACE fallback (the actual failing operation):');
  console.log('  SQL:', insertSql);
  console.log('  vals:', vals);

  // Check if the row currently exists in scratch
  const existing = scratch.prepare('SELECT * FROM station_config_kv WHERE uuid=?').get(failM.row_id);
  console.log('  Row in scratch before INSERT:', existing ? {station_id: existing.station_id, key: existing.key} : 'NOT FOUND');

  try {
    scratch.pragma('foreign_keys = OFF');
    const result = scratch.prepare(insertSql).run(...vals);
    console.log('  INSERT succeeded! changes=' + result.changes);
  } catch (err) {
    console.log('  INSERT FAILED: ' + err.message);
    console.log('  Stack:', err.stack);
  }
}

// Critical: look at what's currently in station_config_kv in scratch
console.log('\nAll rows in scratch station_config_kv:');
const allKv = scratch.prepare('SELECT station_id, key, uuid FROM station_config_kv ORDER BY key').all();
for (const r of allKv) console.log('  station_id=' + r.station_id + ' key=' + r.key + ' uuid=' + r.uuid.slice(0,8) + '...');

real.close();
scratch.close();
