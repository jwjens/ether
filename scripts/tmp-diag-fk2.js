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

// ── 1. metadata_definitions / metadata_vocabulary in scratch ──────────────
console.log('=== METADATA ===');
console.log('metadata_definitions in scratch:', s.prepare('SELECT COUNT(*) as c FROM metadata_definitions').get().c);
console.log('metadata_definitions in real:   ', r.prepare('SELECT COUNT(*) as c FROM metadata_definitions').get().c);
console.log('metadata_vocabulary in scratch:', s.prepare('SELECT COUNT(*) as c FROM metadata_vocabulary').get().c);
console.log('metadata_vocabulary in real:   ', r.prepare('SELECT COUNT(*) as c FROM metadata_vocabulary').get().c);
console.log('song_metadata_values in scratch:', s.prepare('SELECT COUNT(*) as c FROM song_metadata_values').get().c);
console.log('song_metadata_values in real:   ', r.prepare('SELECT COUNT(*) as c FROM song_metadata_values').get().c);

// 2. Sample a metadata_definition from scratch — does id match?
const scratchDefs = s.prepare('SELECT id, uuid, name FROM metadata_definitions LIMIT 5').all();
console.log('\nScratch metadata_definitions (first 5):');
for (const d of scratchDefs) {
  const realRow = r.prepare('SELECT id, uuid FROM metadata_definitions WHERE uuid = ?').get(d.uuid);
  console.log(`  scratch id=${d.id} uuid=${d.uuid} name=${d.name} → real id=${realRow?.id ?? 'MISSING'}`);
}

// 3. Sample orphaned song_metadata_values
console.log('\nSample orphaned song_metadata_values (definition missing):');
const orphanedSmv = s.prepare(`
  SELECT smv.id, smv.definition_id, smv.vocabulary_id
  FROM song_metadata_values smv
  LEFT JOIN metadata_definitions md ON md.id = smv.definition_id
  WHERE md.id IS NULL
  LIMIT 5
`).all();
for (const smv of orphanedSmv) {
  // Does that definition_id exist in scratch at all?
  const inScratch = s.prepare('SELECT id, uuid FROM metadata_definitions WHERE id = ?').get(smv.definition_id);
  // Does that definition_id exist in real?
  const inReal = r.prepare('SELECT id, uuid FROM metadata_definitions WHERE id = ?').get(smv.definition_id);
  console.log(`  smv.id=${smv.id} definition_id=${smv.definition_id} → scratch: ${inScratch ? 'EXISTS uuid='+inScratch.uuid : 'MISSING'} | real: ${inReal ? 'EXISTS uuid='+inReal.uuid : 'MISSING'}`);
}

// 4. Check if backfill mutations for metadata_definitions include 'id'
const mdMut = r.prepare(
  "SELECT id, op, payload_after FROM mutations WHERE table_name='metadata_definitions' LIMIT 1"
).get();
if (mdMut) {
  const pa = JSON.parse(mdMut.payload_after);
  console.log('\nSample metadata_definitions mutation payload_after keys:', Object.keys(pa).join(', '));
  console.log('  includes id?', pa.hasOwnProperty('id'));
  console.log('  id value:', pa.id);
}

// ── 5. clock diagnostics ──────────────────────────────────────────────────
console.log('\n=== CLOCKS ===');
const scratchClockIds = s.prepare('SELECT id, uuid FROM clocks').all();
const realClockIds    = r.prepare('SELECT id, uuid FROM clocks').all();
console.log('Scratch clock ids:', scratchClockIds.map(c => c.id).join(', '));
console.log('Real clock ids:   ', realClockIds.map(c => c.id).join(', '));

// Which real clock UUIDs are missing from scratch?
const scratchUuids = new Set(scratchClockIds.map(c => c.uuid));
const missingClocks = realClockIds.filter(c => !scratchUuids.has(c.uuid));
console.log('Missing from scratch:', missingClocks.map(c => `id=${c.id} uuid=${c.uuid}`).join(', '));

// Are there mutations for those missing clocks?
for (const mc of missingClocks) {
  const muts = r.prepare(
    "SELECT id, op, sync_status FROM mutations WHERE table_name='clocks' AND row_id = ?"
  ).all(mc.uuid);
  console.log(`  Clock uuid=${mc.uuid}: ${muts.length} mutations:`, muts.map(m => `${m.op}(${m.sync_status})`).join(', '));
}

// Are there DELETE mutations for clocks that were applied?
const clockDeletes = r.prepare(
  "SELECT id, row_id, op, sync_status FROM mutations WHERE table_name='clocks' AND op='delete'"
).all();
console.log('\nClock DELETE mutations in real DB:');
for (const d of clockDeletes) {
  // Does this uuid exist in scratch clocks?
  const inScratch = s.prepare('SELECT id FROM clocks WHERE uuid = ?').get(d.row_id);
  console.log(`  row_id=${d.row_id} sync_status=${d.sync_status} → in scratch: ${inScratch ? 'YES id='+inScratch.id : 'NO (correctly deleted or never inserted)'}`);
  // How many clock_slots reference this clock in scratch?
  const slotsForClock = s.prepare(`
    SELECT COUNT(*) as c FROM clock_slots cs
    JOIN clocks cl ON cl.id = cs.clock_id
    WHERE cl.uuid = ?
  `).get(d.row_id)?.c;
  console.log(`    clock_slots referencing this clock in scratch: ${slotsForClock ?? '?'}`);
}

// Orphaned clock_slot clock_ids
const orphanedSlotClockIds = s.prepare(`
  SELECT DISTINCT cs.clock_id FROM clock_slots cs
  LEFT JOIN clocks c ON c.id = cs.clock_id WHERE c.id IS NULL
`).all().map(r => r.clock_id);
console.log('\nOrphaned clock_ids in scratch clock_slots:', orphanedSlotClockIds.join(', '));

// For each orphaned clock_id, find what it would be in real DB
for (const cid of orphanedSlotClockIds) {
  const realClock = r.prepare('SELECT id, uuid, name FROM clocks WHERE id = ?').get(cid);
  console.log(`  clock_id=${cid} → real DB: ${realClock ? `uuid=${realClock.uuid} name=${realClock.name}` : 'MISSING in real too!'}`);
  // Check if there's a delete mutation for that uuid
  if (realClock) {
    const delMut = r.prepare(
      "SELECT id, op FROM mutations WHERE table_name='clocks' AND row_id = ? AND op='delete'"
    ).get(realClock.uuid);
    console.log(`    delete mutation: ${delMut ? 'YES id='+delMut.id : 'NONE'}`);
    // Count clock_slots for this clock in scratch
    const slotCount = s.prepare('SELECT COUNT(*) as c FROM clock_slots WHERE clock_id = ?').get(cid).c;
    console.log(`    clock_slots in scratch for clock_id=${cid}: ${slotCount}`);
  }
}

// ── 6. missing artists ────────────────────────────────────────────────────
console.log('\n=== ARTISTS ===');
// Which artists are in real but not in scratch (by uuid)?
const scratchArtistUuids = new Set(s.prepare('SELECT uuid FROM artists').all().map(a => a.uuid));
const missingArtists = r.prepare('SELECT id, uuid, name FROM artists LIMIT 400').all().filter(a => !scratchArtistUuids.has(a.uuid));
console.log('Missing artists count:', missingArtists.length);
console.log('First 10 missing:', missingArtists.slice(0, 10).map(a => `id=${a.id} "${a.name}"`).join(', '));

// Do missing artists have INSERT mutations?
let withInsert = 0, withoutInsert = 0;
for (const a of missingArtists.slice(0, 30)) {
  const muts = r.prepare(
    "SELECT op, sync_status FROM mutations WHERE table_name='artists' AND row_id = ?"
  ).all(a.uuid);
  const hasInsert = muts.some(m => m.op === 'insert');
  if (hasInsert) withInsert++; else withoutInsert++;
}
console.log(`Missing artists with INSERT mutation: ${withInsert}, WITHOUT: ${withoutInsert} (sample of up to 30)`);

// ── 7. missing category ──────────────────────────────────────────────────
console.log('\n=== CATEGORIES ===');
const scratchCatUuids = new Set(s.prepare('SELECT uuid FROM categories').all().map(c => c.uuid));
const missingCats = r.prepare('SELECT id, uuid, name FROM categories').all().filter(c => !scratchCatUuids.has(c.uuid));
console.log('Missing categories:', missingCats.map(c => `id=${c.id} uuid=${c.uuid} "${c.name}"`).join(', '));
for (const cat of missingCats) {
  const muts = r.prepare(
    "SELECT op, sync_status FROM mutations WHERE table_name='categories' AND row_id = ?"
  ).all(cat.uuid);
  console.log(`  mutations for uuid ${cat.uuid}:`, muts.map(m => `${m.op}(${m.sync_status})`).join(', ') || 'NONE');
}

s.close();
r.close();
