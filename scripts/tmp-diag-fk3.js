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

// ── Schema of song_metadata_values ───────────────────────────────────────
console.log('=== song_metadata_values schema (scratch) ===');
const smvSchema = s.pragma('table_info(song_metadata_values)');
console.log(smvSchema.map(c => `${c.name} ${c.type}`).join('\n'));

// ── metadata_definitions: how many INSERT mutations on server? ─────────────
console.log('\n=== metadata_definitions mutations in real DB ===');
const mdMuts = r.prepare(
  "SELECT op, COUNT(*) as c FROM mutations WHERE table_name='metadata_definitions' GROUP BY op"
).all();
console.log('By op:', mdMuts);

const mdInsertMut = r.prepare(
  "SELECT id, op, payload_after FROM mutations WHERE table_name='metadata_definitions' AND op='insert' LIMIT 2"
).all();
for (const m of mdInsertMut) {
  const pa = JSON.parse(m.payload_after);
  console.log('\nSample INSERT payload_after keys:', Object.keys(pa).join(', '));
  console.log('  has id?', pa.hasOwnProperty('id'), '  id value:', pa.id);
}

// ── How many metadata_definition INSERTs are synced vs pending? ────────────
const mdSyncStatus = r.prepare(
  "SELECT sync_status, COUNT(*) as c FROM mutations WHERE table_name='metadata_definitions' GROUP BY sync_status"
).all();
console.log('\nmetadata_definitions sync_status:', mdSyncStatus);

// ── metadata_vocabulary ───────────────────────────────────────────────────
console.log('\n=== metadata_vocabulary mutations in real DB ===');
const mvMuts = r.prepare(
  "SELECT op, COUNT(*) as c FROM mutations WHERE table_name='metadata_vocabulary' GROUP BY op"
).all();
console.log('By op:', mvMuts);

// ── How many total INSERT mutations exist for metadata tables in real DB ───
const mvInsertCount = r.prepare(
  "SELECT COUNT(*) as c FROM mutations WHERE table_name='metadata_vocabulary' AND op='insert'"
).get().c;
const mdInsertCount = r.prepare(
  "SELECT COUNT(*) as c FROM mutations WHERE table_name='metadata_definitions' AND op='insert'"
).get().c;
console.log('metadata_definitions INSERT mutations:', mdInsertCount);
console.log('metadata_vocabulary INSERT mutations:', mvInsertCount);

// ── Check if backfill mutations include 'id' in payload ───────────────────
const backfillMd = r.prepare(
  "SELECT payload_after FROM mutations WHERE table_name='metadata_definitions' AND op='insert' LIMIT 5"
).all();
console.log('\nSample metadata_definitions INSERT payloads (id field):');
for (const m of backfillMd) {
  const pa = JSON.parse(m.payload_after);
  console.log(`  id=${pa.id ?? '(missing)'} uuid=${pa.uuid ?? '?'} name=${pa.name ?? '?'}`);
}

// ── Check scratch: which metadata_definition IDs are missing ─────────────
console.log('\n=== IDs in real but not scratch: metadata_definitions ===');
const realMdIds = r.prepare('SELECT id FROM metadata_definitions ORDER BY id').all().map(r => r.id);
const scratchMdIds = new Set(s.prepare('SELECT id FROM metadata_definitions').all().map(r => r.id));
const missingMdIds = realMdIds.filter(id => !scratchMdIds.has(id));
console.log('Missing metadata_definition ids (first 20):', missingMdIds.slice(0, 20).join(', '));
console.log('Total missing:', missingMdIds.length);

// For missing IDs, check if mutations exist for their UUIDs
for (const id of missingMdIds.slice(0, 5)) {
  const realRow = r.prepare('SELECT id, uuid, name FROM metadata_definitions WHERE id = ?').get(id);
  const muts = r.prepare(
    "SELECT op, sync_status FROM mutations WHERE table_name='metadata_definitions' AND row_id = ?"
  ).all(realRow.uuid);
  console.log(`  id=${id} uuid=${realRow.uuid} "${realRow.name}": mutations=${muts.map(m => m.op+'('+m.sync_status+')').join(',') || 'NONE'}`);
}

// ── CLOCK diagnostic ──────────────────────────────────────────────────────
console.log('\n=== CLOCKS ===');
// Which clock UUIDs are in real but not scratch?
const scratchClockUuids = new Set(s.prepare('SELECT uuid FROM clocks').all().map(c => c.uuid));
const realClocks = r.prepare('SELECT id, uuid, name FROM clocks').all();
const missingClockUuids = realClocks.filter(c => !scratchClockUuids.has(c.uuid));
console.log('Missing clock UUIDs:', missingClockUuids.map(c => `id=${c.id} uuid=${c.uuid} "${c.name}"`).join('\n  '));

for (const mc of missingClockUuids) {
  const muts = r.prepare(
    "SELECT op, sync_status FROM mutations WHERE table_name='clocks' AND row_id = ?"
  ).all(mc.uuid);
  console.log(`  mutations for uuid=${mc.uuid}: ${muts.map(m => m.op+'('+m.sync_status+')').join(', ') || 'NONE'}`);
}

// Clock DELETE mutations — what clock_slot DELETEs exist for those clocks?
const clockDelMuts = r.prepare(
  "SELECT row_id FROM mutations WHERE table_name='clocks' AND op='delete'"
).all();
console.log('\nClock DELETE row_ids:', clockDelMuts.map(m => m.row_id).join(', '));
for (const dm of clockDelMuts) {
  const realClock = r.prepare('SELECT id FROM clocks WHERE uuid = ?').get(dm.row_id);
  console.log(`  Deleted clock uuid=${dm.row_id} → real DB id: ${realClock?.id ?? 'not in real (truly deleted)'}`);
  // Count clock_slots DELETE mutations for this clock's slots
  // (need to cross-reference by clock_id, but clock_slots row_id is the slot UUID, not clock id)
  // Instead check: does scratch have clock_slots with a clock_id that maps to this uuid?
  if (realClock) {
    const slotCount = s.prepare('SELECT COUNT(*) as c FROM clock_slots WHERE clock_id = ?').get(realClock.id).c;
    console.log(`    clock_slots in scratch pointing to clock_id=${realClock.id}: ${slotCount}`);
  }
}

// ── ARTISTS ───────────────────────────────────────────────────────────────
console.log('\n=== ARTISTS ===');
const scratchArtistUuids = new Set(s.prepare('SELECT uuid FROM artists').all().map(a => a.uuid));
const missingArtists = r.prepare('SELECT id, uuid, name FROM artists ORDER BY id').all().filter(a => !scratchArtistUuids.has(a.uuid));
console.log('Missing artists count:', missingArtists.length);
console.log('First 10:', missingArtists.slice(0, 10).map(a => `id=${a.id} "${a.name}"`).join(', '));

let withInsert = 0, withoutInsert = 0, onlyUpdate = 0;
for (const a of missingArtists) {
  const muts = r.prepare(
    "SELECT op, sync_status FROM mutations WHERE table_name='artists' AND row_id = ?"
  ).all(a.uuid);
  const hasInsert = muts.some(m => m.op === 'insert');
  if (hasInsert) withInsert++; else withoutInsert++;
  if (!hasInsert && muts.length > 0) onlyUpdate++;
}
console.log(`Missing artists: withInsert=${withInsert} withoutInsert=${withoutInsert} (onlyUpdate=${onlyUpdate})`);

// ── CATEGORIES ────────────────────────────────────────────────────────────
console.log('\n=== CATEGORIES ===');
const scratchCatUuids = new Set(s.prepare('SELECT uuid FROM categories').all().map(c => c.uuid));
const missingCats = r.prepare('SELECT id, uuid, name FROM categories').all().filter(c => !scratchCatUuids.has(c.uuid));
console.log('Missing categories:', missingCats.length);
for (const cat of missingCats) {
  const muts = r.prepare(
    "SELECT op, sync_status FROM mutations WHERE table_name='categories' AND row_id = ?"
  ).all(cat.uuid);
  console.log(`  id=${cat.id} "${cat.name}" uuid=${cat.uuid}: mutations=${muts.map(m => m.op+'('+m.sync_status+')').join(',') || 'NONE'}`);
}

s.close();
r.close();
