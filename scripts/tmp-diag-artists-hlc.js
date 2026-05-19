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

// Get a sample missing artist
const uuid = '4db3f916-8472-4e94-a2f6-4d6229a6e108'; // Destiny's Child id=283

// HLC of its INSERT mutation in real DB
const realMut = r.prepare(
  "SELECT id, op, hlc, station_id, payload_after FROM mutations WHERE table_name='artists' AND row_id=?"
).get(uuid);
console.log('Real DB mutation for Destiny\'s Child:');
console.log('  id:', realMut?.id);
console.log('  op:', realMut?.op);
console.log('  hlc:', realMut?.hlc);
console.log('  station_id:', realMut?.station_id);
if (realMut?.payload_after) {
  const pa = JSON.parse(realMut.payload_after);
  console.log('  payload id:', pa.id, 'name:', pa.name);
}

// HLC of its mutation in scratch
const scratchMut = s.prepare(
  "SELECT id, op, hlc, sync_status FROM mutations WHERE table_name='artists' AND row_id=?"
).get(uuid);
console.log('\nScratch mutation for same uuid:');
console.log('  id:', scratchMut?.id);
console.log('  hlc:', scratchMut?.hlc);
console.log('  sync_status:', scratchMut?.sync_status);

// What is the LATEST mutation for artists in scratch, ordered by HLC?
console.log('\n=== ALL artist mutations in scratch (by HLC desc, first 20) ===');
const allScratchArtistMuts = s.prepare(
  "SELECT row_id, op, hlc, sync_status FROM mutations WHERE table_name='artists' ORDER BY hlc DESC LIMIT 20"
).all();
for (const m of allScratchArtistMuts) {
  const inArtists = s.prepare('SELECT id, name FROM artists WHERE uuid=?').get(m.row_id);
  console.log(`  hlc=${m.hlc} op=${m.op} row_id=${m.row_id} → artists table: ${inArtists ? 'EXISTS name='+inArtists.name : 'MISSING'}`);
}

// Is there a mutation for row_id=uuid with a HIGHER HLC in scratch?
// The LWW check: SELECT hlc FROM mutations WHERE table_name='artists' AND row_id=? ORDER BY hlc DESC LIMIT 1
const lwwCheck = s.prepare(
  "SELECT hlc FROM mutations WHERE table_name='artists' AND row_id=? ORDER BY hlc DESC LIMIT 1"
).get(uuid);
console.log('\nLWW check for Destiny\'s Child uuid in scratch:');
console.log('  localLatest hlc:', lwwCheck?.hlc);
console.log('  incoming hlc:', realMut?.hlc);

if (lwwCheck && realMut) {
  // Compare: if localLatest > incoming, it was a loser
  function cmpHLC(a, b) {
    const [wA, lA] = a.split(':').map((v, i) => i < 2 ? parseInt(v) : v);
    const [wB, lB] = b.split(':').map((v, i) => i < 2 ? parseInt(v) : v);
    if (wA !== wB) return wA < wB ? -1 : 1;
    return lA < lB ? -1 : lA > lB ? 1 : 0;
  }
  const cmp = cmpHLC(realMut.hlc, lwwCheck.hlc);
  console.log('  HLC comparison (incoming vs localLatest):', cmp, cmp < 0 ? '→ LOSER' : cmp > 0 ? '→ WINNER' : '→ TIE');
}

// ── Integer ID collision check ────────────────────────────────────────────
// What integer id does Destiny's Child have in real DB?
const pa = realMut?.payload_after ? JSON.parse(realMut.payload_after) : null;
const destinyId = pa?.id;
console.log('\nDestiny\'s Child integer id (from payload):', destinyId);

if (destinyId) {
  // Is there an artist with that integer id in scratch?
  const idCollision = s.prepare('SELECT id, uuid, name FROM artists WHERE id=?').get(destinyId);
  console.log('Artist with that id in scratch:', idCollision ?? 'NONE');

  // What mutation created that row in scratch?
  if (idCollision) {
    const colMut = s.prepare(
      "SELECT id, op, hlc FROM mutations WHERE table_name='artists' AND row_id=?"
    ).get(idCollision.uuid);
    console.log('Mutation that created colliding artist:', colMut);
  }
}

// ── The key: check all mutations for table=artists in scratch, count per row_id ───
const multiMuts = s.prepare(
  "SELECT row_id, COUNT(*) as c FROM mutations WHERE table_name='artists' GROUP BY row_id HAVING c > 1"
).all();
console.log('\nArtist row_ids with >1 mutation in scratch:', multiMuts.length);

// ── Check: do the missing artists have DELETE mutations they lost to? ─────
// i.e., did a backfill mutation with HIGHER hlc exist for same row_id?
const missingArtistUuids = r.prepare('SELECT uuid FROM artists ORDER BY id').all().map(a => a.uuid)
  .filter(uuid => !s.prepare('SELECT 1 FROM artists WHERE uuid=?').get(uuid));
console.log('\nChecking LWW for first 5 missing artists:');
for (const uuid of missingArtistUuids.slice(0, 5)) {
  const incoming = r.prepare(
    "SELECT hlc, op FROM mutations WHERE table_name='artists' AND row_id=?"
  ).get(uuid);
  const localLatest = s.prepare(
    "SELECT hlc, op FROM mutations WHERE table_name='artists' AND row_id=? ORDER BY hlc DESC LIMIT 1"
  ).get(uuid);
  console.log(`  uuid=${uuid.slice(0,8)}... incoming=${incoming?.op}@${incoming?.hlc?.slice(0,16)} localLatest=${localLatest?.op}@${localLatest?.hlc?.slice(0,16)}`);
}

s.close();
r.close();
