'use strict';
const path = require('path');
const os   = require('os');
const ROOT     = path.join(__dirname, '..');
const appData  = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB  = path.join(appData, 'com.ether.radio', 'openair.db');
const SCRATCH  = path.join(ROOT, 'scratch-client', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

const real    = new Database(REAL_DB, { readonly: true });
const scratch = new Database(SCRATCH, { readonly: true });

function sep(t) { console.log('\n' + '='.repeat(68)); console.log('  ' + t); console.log('='.repeat(68)); }

// ── 1. clock_slots gap ────────────────────────────────────────────────────
sep('1. CLOCK_SLOTS GAP — real DB breakdown');

const realTotal    = real.prepare('SELECT COUNT(*) as c FROM clock_slots').get().c;
const realLive     = real.prepare('SELECT COUNT(*) as c FROM clock_slots WHERE deleted_at IS NULL').get().c;
const realDeleted  = real.prepare('SELECT COUNT(*) as c FROM clock_slots WHERE deleted_at IS NOT NULL').get().c;
const scratchTotal = scratch.prepare('SELECT COUNT(*) as c FROM clock_slots').get().c;
const scratchLive  = scratch.prepare('SELECT COUNT(*) as c FROM clock_slots WHERE deleted_at IS NULL').get().c;
const scratchDel   = scratch.prepare('SELECT COUNT(*) as c FROM clock_slots WHERE deleted_at IS NOT NULL').get().c;

console.log('  real    total=' + realTotal + '  live=' + realLive + '  soft-deleted=' + realDeleted);
console.log('  scratch total=' + scratchTotal + '  live=' + scratchLive + '  soft-deleted=' + scratchDel);
console.log('  gap = ' + (realTotal - scratchTotal) + '  live gap = ' + (realLive - scratchLive));

console.log('\n  real DB clock_slots per clock_id:');
const realByClock = real.prepare(
  'SELECT clock_id, COUNT(*) as total, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) as live FROM clock_slots GROUP BY clock_id ORDER BY clock_id'
).all();
for (const r of realByClock) {
  console.log('    clock_id=' + r.clock_id + '  total=' + r.total + '  live=' + r.live + '  deleted=' + (r.total - r.live));
}

console.log('\n  scratch DB clock_slots per clock_id:');
const scratchByClock = scratch.prepare(
  'SELECT clock_id, COUNT(*) as total, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) as live FROM clock_slots GROUP BY clock_id ORDER BY clock_id'
).all();
for (const r of scratchByClock) {
  console.log('    clock_id=' + r.clock_id + '  total=' + r.total + '  live=' + r.live + '  deleted=' + (r.total - r.live));
}

console.log('\n  clock_slots mutations in real DB by op:');
const csMutCount = real.prepare("SELECT op, COUNT(*) as c FROM mutations WHERE table_name='clock_slots' GROUP BY op").all();
for (const r of csMutCount) console.log('    op=' + r.op + '  count=' + r.c);

console.log('\n  clock_slots in real DB with NO mutations (pre-sync rows):');
const noBFSlots = real.prepare(`
  SELECT cs.id, cs.clock_id, cs.uuid, cs.deleted_at
  FROM clock_slots cs
  LEFT JOIN mutations m ON m.table_name='clock_slots' AND m.row_id=cs.uuid
  WHERE m.id IS NULL
  ORDER BY cs.clock_id, cs.id
`).all();
console.log('  count = ' + noBFSlots.length);
for (const r of noBFSlots.slice(0, 30)) {
  console.log('    id=' + r.id + ' clock_id=' + r.clock_id + ' deleted=' + (r.deleted_at ? 'yes' : 'no') + ' uuid=' + r.uuid);
}
if (noBFSlots.length > 30) console.log('  ... (' + noBFSlots.length + ' total, first 30 shown)');

// ── 2. station_programming ────────────────────────────────────────────────
sep('2. STATION_PROGRAMMING — scratch vs real');

try {
  const spReal      = real.prepare('SELECT COUNT(*) as c FROM station_programming').get().c;
  const spScratch   = scratch.prepare('SELECT COUNT(*) as c FROM station_programming').get().c;
  const spRealLive  = real.prepare('SELECT COUNT(*) as c FROM station_programming WHERE deleted_at IS NULL').get().c;
  const spScrLive   = scratch.prepare('SELECT COUNT(*) as c FROM station_programming WHERE deleted_at IS NULL').get().c;
  console.log('  real    total=' + spReal    + '  live=' + spRealLive);
  console.log('  scratch total=' + spScratch + '  live=' + spScrLive);
  console.log('  total gap=' + (spReal - spScratch) + '  live gap=' + (spRealLive - spScrLive));

  const spMuts = real.prepare("SELECT op, COUNT(*) as c FROM mutations WHERE table_name='station_programming' GROUP BY op").all();
  console.log('  mutations in real DB:');
  if (spMuts.length === 0) console.log('    (none)');
  for (const r of spMuts) console.log('    op=' + r.op + '  count=' + r.c);

  const spNoMut = real.prepare(`
    SELECT COUNT(*) as c FROM station_programming sp
    LEFT JOIN mutations m ON m.table_name='station_programming' AND m.row_id=sp.uuid
    WHERE m.id IS NULL
  `).get().c;
  console.log('  rows with NO mutation (pre-sync): ' + spNoMut);
} catch(e) {
  console.log('  ERROR: ' + e.message);
}

// ── 3. station_config_kv UUID mismatch ───────────────────────────────────
sep('3. STATION_CONFIG_KV — UUID mismatch investigation');

console.log('  Scratch station_config_kv rows:');
const scratchKv = scratch.prepare('SELECT id, uuid, key, station_id FROM station_config_kv ORDER BY key').all();
for (const r of scratchKv) {
  console.log('    id=' + r.id + ' uuid=' + r.uuid + ' key=' + r.key + ' station_id=' + r.station_id);
}

console.log('\n  Real DB station_config_kv rows:');
const realKv = real.prepare('SELECT id, uuid, key, station_id FROM station_config_kv ORDER BY key').all();
for (const r of realKv) {
  console.log('    id=' + r.id + ' uuid=' + r.uuid + ' key=' + r.key + ' station_id=' + r.station_id);
}

console.log('\n  Sample station_config_kv UPDATE mutations (first 5):');
const kvMuts = real.prepare(
  "SELECT row_id, hlc, payload_before, payload_after FROM mutations WHERE table_name='station_config_kv' AND op='update' LIMIT 5"
).all();
for (const m of kvMuts) {
  const pa = m.payload_after  ? JSON.parse(m.payload_after)  : null;
  const pb = m.payload_before ? JSON.parse(m.payload_before) : null;
  console.log('    row_id=' + m.row_id + '  pb.station_id=' + (pb ? pb.station_id : '(null)') + '  pa.station_id=' + (pa ? pa.station_id : '(null)'));
}

const kvTotal  = real.prepare("SELECT COUNT(*) as c FROM mutations WHERE table_name='station_config_kv' AND op='update'").get().c;
const kvNullSt = real.prepare("SELECT COUNT(*) as c FROM mutations WHERE table_name='station_config_kv' AND op='update' AND json_extract(payload_after, '$.station_id') IS NULL").get().c;
console.log('\n  Total station_config_kv UPDATE mutations: ' + kvTotal);
console.log('  ...where payload_after.station_id IS NULL: ' + kvNullSt);

const kvTable = real.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='station_config_kv'").get();
console.log('\n  station_config_kv schema:');
console.log('  ' + (kvTable ? kvTable.sql : 'not found'));

// Do the mutation row_ids match any scratch uuid?
console.log('\n  Do mutation row_ids match scratch UUIDs?');
const kvMutRowIds = real.prepare("SELECT DISTINCT row_id FROM mutations WHERE table_name='station_config_kv'").all().map(r => r.row_id);
for (const rid of kvMutRowIds.slice(0, 10)) {
  const inScratch = scratch.prepare('SELECT uuid, key FROM station_config_kv WHERE uuid=?').get(rid);
  const inReal    = real.prepare('SELECT uuid, key FROM station_config_kv WHERE uuid=?').get(rid);
  console.log('    row_id=' + rid + '  in_real=' + (inReal ? inReal.key : 'NO') + '  in_scratch=' + (inScratch ? inScratch.key : 'NO'));
}
console.log('  (' + kvMutRowIds.length + ' distinct row_ids in mutations)');

real.close();
scratch.close();
