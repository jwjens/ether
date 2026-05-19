'use strict';
const path    = require('path');
const os      = require('os');
const ROOT    = path.join(__dirname, '..');
const SCRATCH_DB = path.join(ROOT, 'scratch-client', 'openair.db');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

const s = new Database(SCRATCH_DB, { readonly: true });
const r = new Database(REAL_DB, { readonly: true });

// 1. Full FK violation list from scratch
const violations = s.pragma('foreign_key_check');
console.log('Total FK violations:', violations.length);

// Group by table
const byTable = {};
for (const v of violations) {
  const k = `${v.table}→${v.parent}`;
  byTable[k] = (byTable[k] ?? 0) + 1;
}
console.log('Breakdown:', JSON.stringify(byTable, null, 2));

// 2. clocks counts
const scratchClocks = s.prepare('SELECT COUNT(*) as c FROM clocks').get().c;
const realClocks    = r.prepare('SELECT COUNT(*) as c FROM clocks').get().c;
console.log('\nclocks: scratch=', scratchClocks, '  real=', realClocks);

const scratchClockSlots = s.prepare('SELECT COUNT(*) as c FROM clock_slots').get().c;
const realClockSlots    = r.prepare('SELECT COUNT(*) as c FROM clock_slots').get().c;
console.log('clock_slots: scratch=', scratchClockSlots, '  real=', realClockSlots);

// 3. Which clock_ids are orphaned in scratch?
const orphanedClockIds = s.prepare(`
  SELECT DISTINCT cs.clock_id
  FROM clock_slots cs
  LEFT JOIN clocks c ON c.id = cs.clock_id
  WHERE c.id IS NULL
  LIMIT 20
`).all().map(r => r.clock_id);
console.log('\nOrphaned clock_ids in scratch (up to 20):', orphanedClockIds);

// 4. Do those clock_ids exist in the real DB?
for (const cid of orphanedClockIds.slice(0, 5)) {
  const row = r.prepare('SELECT id, uuid, name FROM clocks WHERE id = ?').get(cid);
  console.log(`  clock id=${cid} in real DB:`, row ?? 'MISSING');
}

// 5. Check mutations for those clocks in real DB
if (orphanedClockIds.length > 0) {
  const placeholders = orphanedClockIds.map(() => '?').join(',');
  const clockMuts = r.prepare(
    `SELECT id, op, table_name, row_id, sync_status FROM mutations WHERE table_name='clocks' LIMIT 20`
  ).all();
  console.log('\nAll clock mutations in real DB (first 20):');
  for (const m of clockMuts) {
    console.log(`  id=${m.id}  op=${m.op}  row_id=${m.row_id}  sync_status=${m.sync_status}`);
  }
}

// 6. Check artists count
const scratchArtists = s.prepare('SELECT COUNT(*) as c FROM artists').get().c;
const realArtists    = r.prepare('SELECT COUNT(*) as c FROM artists').get().c;
console.log('\nartists: scratch=', scratchArtists, '  real=', realArtists);

// 7. Check what artist violations exist (if any)
const artistViolations = violations.filter(v => v.table !== 'clock_slots');
console.log('\nNon-clock_slots violations (up to 10):', JSON.stringify(artistViolations.slice(0, 10)));

s.close();
r.close();
