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

// ── CRITICAL: check backfill artist mutation payloads ─────────────────────
// Backfill mutations have high HLC (~1779166...). Check a few.
console.log('=== Sample BACKFILL artist mutations (high HLC) ===');
const backfillArtists = r.prepare(
  "SELECT id, row_id, hlc, payload_after FROM mutations WHERE table_name='artists' AND hlc > '1779000000000' ORDER BY hlc LIMIT 5"
).all();
for (const m of backfillArtists) {
  const pa = JSON.parse(m.payload_after);
  console.log(`  uuid=${m.row_id.slice(0,8)} hlc=${m.hlc.slice(0,16)} payload: id=${pa.id} name=${pa.name}`);
}

// ── Check artists 1-5 in scratch: what integer ids do they have? ──────────
console.log('\n=== First 5 artists in scratch by integer id ===');
const first5 = s.prepare('SELECT id, uuid, name FROM artists ORDER BY id LIMIT 5').all();
for (const a of first5) {
  console.log(`  scratch id=${a.id} uuid=${a.uuid} name=${a.name}`);
  const realRow = r.prepare('SELECT id FROM artists WHERE uuid=?').get(a.uuid);
  console.log(`    → real DB id: ${realRow?.id ?? 'NOT IN REAL'}`);
}

// ── Integer id distribution in scratch artists ────────────────────────────
console.log('\n=== Artist integer id range in scratch ===');
const artRange = s.prepare('SELECT MIN(id) as mn, MAX(id) as mx, COUNT(*) as cnt FROM artists').get();
console.log(`  min=${artRange.mn} max=${artRange.mx} count=${artRange.cnt}`);

// ── Check if scratch has artist with id=283 ─────────────────────────────
console.log('\n=== What is at artist id=283 in scratch? ===');
const art283 = s.prepare('SELECT id, uuid, name FROM artists WHERE id=283').get();
console.log('  scratch artists id=283:', art283 ?? 'NOT FOUND');
if (art283) {
  const realRow = r.prepare('SELECT id, name FROM artists WHERE uuid=?').get(art283.uuid);
  console.log('  in real DB:', realRow);
}

// ── The missing artists: what ids do they have in real DB vs scratch? ──────
const scratchArtistUuids = new Set(s.prepare('SELECT uuid FROM artists').all().map(a => a.uuid));
const missingArtists = r.prepare('SELECT id, uuid, name FROM artists ORDER BY id').all().filter(a => !scratchArtistUuids.has(a.uuid));

console.log('\n=== IDs of missing artists in real DB ===');
console.log(missingArtists.map(a => a.id).join(', '));

// For one missing artist, trace exactly what happens with its id
const sample = missingArtists[0];
const samplePa = r.prepare(
  "SELECT payload_after FROM mutations WHERE table_name='artists' AND row_id=?"
).get(sample.uuid);
const pa = samplePa ? JSON.parse(samplePa.payload_after) : null;
console.log(`\nSample missing artist: real id=${sample.id} uuid=${sample.uuid} name=${sample.name}`);
console.log('  payload_after.id:', pa?.id);
console.log('  payload_after keys:', pa ? Object.keys(pa).join(', ') : 'N/A');

// If payload.id is null: SQLite auto-assigns. What id would it get in scratch?
// Check: is there a scratch artist row at the id SQLite would assign?
// (It would get the max id + 1 at time of INSERT, or fill gaps)

// ── Key question: do backfill mutations include id in payload? ─────────────
// Check: the BACKFILL artists have higher HLC. Look at one of them in real DB.
const backfillSample = r.prepare(
  "SELECT payload_after, row_id FROM mutations WHERE table_name='artists' AND hlc > '1779000000000' LIMIT 1"
).get();
if (backfillSample) {
  const bpa = JSON.parse(backfillSample.payload_after);
  console.log('\n=== Backfill artist payload ===');
  console.log('  keys:', Object.keys(bpa).join(', '));
  console.log('  id:', bpa.id);
  console.log('  uuid:', bpa.uuid);
  console.log('  name:', bpa.name);

  // Does that uuid exist in scratch?
  const inScratch = s.prepare('SELECT id FROM artists WHERE uuid=?').get(backfillSample.row_id);
  console.log('  In scratch artists:', inScratch ? 'YES, id='+inScratch.id : 'NOT FOUND');

  // Is there a scratch artist with integer id = bpa.id?
  if (bpa.id) {
    const idCheck = s.prepare('SELECT id, uuid, name FROM artists WHERE id=?').get(bpa.id);
    console.log('  Scratch artist at integer id='+bpa.id+':', idCheck);
  }
}

// ── Final check: Is artist 283's REAL id in scratch taken by something else?
if (pa?.id !== undefined) {
  const whoHasId = s.prepare('SELECT id, uuid, name FROM artists WHERE id=?').get(sample.id);
  console.log(`\nWho has artist id=${sample.id} in scratch:`, whoHasId ?? 'NOBODY');
} else {
  // payload id is null — SQLite assigned some other id. What id did "Destiny's Child" get?
  // It should be in scratch mutations as insert(synced) — let's check the scratch row
  const scratchMut = s.prepare("SELECT id, op, hlc FROM mutations WHERE table_name='artists' AND row_id=?").get(sample.uuid);
  console.log('\nDestiny\'s Child scratch mutation:', scratchMut);
  // The artist row should have been created when this mutation was applied
  // But the artists table lookup by uuid returned NOT FOUND
  // So either: 1) INSERT OR REPLACE with a later backfill mutation clobbered it, or
  //            2) Something else happened
}

s.close();
r.close();
