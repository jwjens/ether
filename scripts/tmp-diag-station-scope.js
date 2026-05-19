'use strict';
const path    = require('path');
const os      = require('os');
const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB = path.join(appData, 'com.ether.radio', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const r = new Database(REAL_DB, { readonly: true });

function checkMutStation(table, uuid) {
  return r.prepare(
    "SELECT station_id, op, sync_status FROM mutations WHERE table_name=? AND row_id=? LIMIT 5"
  ).all(table, uuid);
}

// ── metadata_definitions: station_id of missing ids (48-99) ─────────────
console.log('=== metadata_definitions missing (ids 48-99) ===');
const missingMdIds = [];
const allMd = r.prepare('SELECT id, uuid, name, station_id FROM metadata_definitions ORDER BY id').all();
for (const md of allMd) {
  if (md.id >= 48) missingMdIds.push(md);
}
// Group by station_id
const mdByStation = {};
for (const md of missingMdIds) {
  const k = md.station_id ?? 'null';
  mdByStation[k] = (mdByStation[k] ?? 0) + 1;
}
console.log('metadata_definitions ids>=48 grouped by station_id:', mdByStation);
// Sample 5
for (const md of missingMdIds.slice(0, 5)) {
  const muts = checkMutStation('metadata_definitions', md.uuid);
  console.log(`  id=${md.id} station_id=${md.station_id} "${md.name}" → mut station_ids: ${muts.map(m => m.station_id+' op='+m.op).join(', ')}`);
}

// ── clocks: station_id of missing clocks (14, 15, 16) ────────────────────
console.log('\n=== clocks: missing ids 14, 15, 16 ===');
const missingClockIds = [14, 15, 16];
for (const id of missingClockIds) {
  const row = r.prepare('SELECT id, uuid, name, station_id FROM clocks WHERE id=?').get(id);
  if (row) {
    const muts = checkMutStation('clocks', row.uuid);
    console.log(`  clock id=${id} station_id=${row.station_id} "${row.name}" uuid=${row.uuid}`);
    console.log(`    mutations: ${muts.map(m => 'station_id='+m.station_id+' op='+m.op).join(', ')}`);
  }
}

// ── clock_slots: what station_id do the orphaned slots have? ─────────────
console.log('\n=== clock_slots: mutation station_id for slots pointing to clock_ids 5, 14 ===');
// Get some clock_slots that point to clock_id 5 or 14
const orphanSlots = r.prepare(
  "SELECT id, uuid, clock_id, station_id FROM clock_slots WHERE clock_id IN (5, 14) LIMIT 10"
).all();
for (const cs of orphanSlots) {
  const muts = checkMutStation('clock_slots', cs.uuid);
  console.log(`  clock_slot id=${cs.id} clock_id=${cs.clock_id} station_id=${cs.station_id} → mut station_ids: ${muts.map(m => 'station_id='+m.station_id+' op='+m.op).join(', ') || 'NONE'}`);
}

// ── clock_slots: all mutation station_id grouping ─────────────────────────
console.log('\n=== clock_slots mutations grouped by station_id ===');
const csGroups = r.prepare(
  "SELECT station_id, op, COUNT(*) as c FROM mutations WHERE table_name='clock_slots' GROUP BY station_id, op"
).all();
console.log(csGroups);

// ── categories: the missing one (id=15 "Commercials") ───────────────────
console.log('\n=== missing category id=15 ===');
const cat15 = r.prepare("SELECT id, uuid, name, station_id FROM categories WHERE id=15").get();
if (cat15) {
  const muts = checkMutStation('categories', cat15.uuid);
  console.log(`  id=${cat15.id} station_id=${cat15.station_id} "${cat15.name}" uuid=${cat15.uuid}`);
  console.log(`  mutations: ${muts.map(m => 'station_id='+m.station_id+' op='+m.op).join(', ')}`);
}

// ── artists: missing artists station_id check ─────────────────────────────
console.log('\n=== missing artists: sample station_id ===');
const missingArtistUuids = [
  // ids 283-292 from previous diagnostic
].concat([]);
// Get actual UUIDs from real DB for ids 283-292
const missArt = r.prepare("SELECT id, uuid, name, station_id FROM artists WHERE id BETWEEN 283 AND 295").all();
for (const a of missArt) {
  const muts = checkMutStation('artists', a.uuid);
  const mutStation = muts[0]?.station_id ?? '?';
  console.log(`  artist id=${a.id} row.station_id=${a.station_id} "${a.name}" → mut station_id=${mutStation}`);
}

// ── summary of mutations by station_id across all tables ─────────────────
console.log('\n=== mutation pool by station_id ===');
const pool = r.prepare(
  "SELECT station_id, COUNT(*) as c FROM mutations GROUP BY station_id ORDER BY station_id"
).all();
console.log(pool);

r.close();
