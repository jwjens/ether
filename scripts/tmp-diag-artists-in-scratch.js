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

// Get the 28 missing artists' UUIDs
const scratchArtistUuids = new Set(s.prepare('SELECT uuid FROM artists').all().map(a => a.uuid));
const missingArtists = r.prepare('SELECT id, uuid, name FROM artists ORDER BY id').all().filter(a => !scratchArtistUuids.has(a.uuid));

console.log('Missing artists count:', missingArtists.length);

// For each missing artist, check scratch's mutations table to see if it was received
for (const a of missingArtists.slice(0, 10)) {
  const scratchMuts = s.prepare(
    "SELECT id, op, sync_status, hlc FROM mutations WHERE table_name='artists' AND row_id=?"
  ).all(a.uuid);
  const realMuts = r.prepare(
    "SELECT id, op, sync_status, station_id, hlc FROM mutations WHERE table_name='artists' AND row_id=?"
  ).all(a.uuid);

  console.log(`\nArtist id=${a.id} "${a.name}" uuid=${a.uuid}`);
  console.log(`  Real DB mutations:   ${realMuts.map(m => `${m.op}(station_id=${m.station_id} sync=${m.sync_status})`).join(', ')}`);
  console.log(`  Scratch mutations:   ${scratchMuts.length ? scratchMuts.map(m => `${m.op}(${m.sync_status})`).join(', ') : 'NONE — not received by scratch'}`);

  // Check if the artist itself exists in scratch (maybe soft-deleted)
  const inScratch = s.prepare('SELECT id, deleted_at FROM artists WHERE uuid=?').get(a.uuid);
  console.log(`  In scratch artists:  ${inScratch ? `EXISTS id=${inScratch.id} deleted_at=${inScratch.deleted_at}` : 'NOT FOUND'}`);
}

// Total mutations in scratch vs real
const scratchMutCount = s.prepare("SELECT COUNT(*) as c FROM mutations WHERE table_name='artists'").get().c;
const realMutCount    = r.prepare("SELECT COUNT(*) as c FROM mutations WHERE table_name='artists'").get().c;
console.log('\nTotal artist mutations: scratch=', scratchMutCount, '  real=', realMutCount);

// Check all artist mutations in real DB by sync_status
const realArtistSync = r.prepare(
  "SELECT sync_status, COUNT(*) as c FROM mutations WHERE table_name='artists' GROUP BY sync_status"
).all();
console.log('Real DB artist mutations by sync_status:', realArtistSync);

// Is there an artist in scratch with the wrong UUID for a given name?
// E.g., "Destiny's Child" might be in scratch under a different UUID
for (const a of missingArtists.slice(0, 5)) {
  const nameMatch = s.prepare("SELECT id, uuid, name FROM artists WHERE name = ?").get(a.name);
  console.log(`\n  Real "${a.name}" (uuid=${a.uuid}) → in scratch by name:`, nameMatch ?? 'NOT FOUND');
}

// Check backfill: are there ALSO backfill mutations for these same artist names (different UUIDs)?
console.log('\n=== Checking if missing artists have duplicate names in backfill ===');
for (const a of missingArtists.slice(0, 10)) {
  // Are there multiple INSERT mutations for artists with this name?
  const nameRows = r.prepare("SELECT id, uuid, name FROM artists WHERE name = ?").all(a.name);
  if (nameRows.length > 1) {
    console.log(`  DUPLICATE: "${a.name}" appears ${nameRows.length} times in real DB:`, nameRows.map(r => `id=${r.id} uuid=${r.uuid}`).join(', '));
  }
}

// Summary: how many artist INSERT mutations are synced vs pending in real
const artistSyncStatus = r.prepare(
  "SELECT sync_status, op, COUNT(*) as c FROM mutations WHERE table_name='artists' GROUP BY sync_status, op ORDER BY c DESC"
).all();
console.log('\nArtist mutations by sync_status+op:', artistSyncStatus);

s.close();
r.close();
