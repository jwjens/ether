'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SCRATCH_DB = path.join(ROOT, 'scratch-client', 'openair.db');
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const s = new Database(SCRATCH_DB, { readonly: true });

// Full FK violation list
const violations = s.pragma('foreign_key_check');
console.log('Total foreign_key_check violations:', violations.length);

// Group by table
const byTable = {};
for (const v of violations) {
  const k = `${v.table}→${v.parent}`;
  byTable[k] = (byTable[k] ?? 0) + 1;
}
console.log('By table:', JSON.stringify(byTable));

// For each violation: check if the violating row is soft-deleted
let softDeletedCount = 0;
let liveCount = 0;
for (const v of violations) {
  const row = s.prepare(`SELECT deleted_at FROM "${v.table}" WHERE rowid = ?`).get(v.rowid);
  if (row?.deleted_at !== null && row?.deleted_at !== undefined) {
    softDeletedCount++;
  } else {
    liveCount++;
    console.log(`  LIVE violation: table=${v.table} rowid=${v.rowid} parent=${v.parent}`);
  }
}

console.log(`\nSoft-deleted violations: ${softDeletedCount}`);
console.log(`Live (non-deleted) violations: ${liveCount}`);
console.log('');
if (liveCount === 0) {
  console.log('✓ ALL remaining violations are from soft-deleted rows (deleted_at IS NOT NULL)');
  console.log('  These are benign: soft-deleted rows are invisible to the application.');
  console.log('  A live-data FK check would return 0 violations.');
} else {
  console.log('✗ Some live rows still have FK violations — requires further investigation.');
}

// Run a custom live-data FK check for the key relationships
console.log('\n=== LIVE-DATA FK CHECK (deleted_at IS NULL only) ===');

const songArtist = s.prepare(`
  SELECT COUNT(*) as c FROM songs s
  LEFT JOIN artists a ON a.id = s.artist_id
  WHERE s.deleted_at IS NULL AND s.artist_id IS NOT NULL AND a.id IS NULL
`).get().c;
console.log('songs→artists (live): ', songArtist, songArtist === 0 ? '✓' : '✗');

const clkSlotClock = s.prepare(`
  SELECT COUNT(*) as c FROM clock_slots cs
  LEFT JOIN clocks c ON c.id = cs.clock_id
  WHERE cs.deleted_at IS NULL AND c.id IS NULL
`).get().c;
console.log('clock_slots→clocks (live): ', clkSlotClock, clkSlotClock === 0 ? '✓' : '✗');

const clkSlotCat = s.prepare(`
  SELECT COUNT(*) as c FROM clock_slots cs
  LEFT JOIN categories cat ON cat.id = cs.category_id
  WHERE cs.deleted_at IS NULL AND cs.category_id IS NOT NULL AND cat.id IS NULL
`).get().c;
console.log('clock_slots→categories (live): ', clkSlotCat, clkSlotCat === 0 ? '✓' : '✗');

// song_metadata_values → metadata_definitions
try {
  const smvDef = s.prepare(`
    SELECT COUNT(*) as c FROM song_metadata_values smv
    LEFT JOIN metadata_definitions md ON md.id = smv.definition_id
    WHERE smv.deleted_at IS NULL AND md.id IS NULL
  `).get().c;
  console.log('song_metadata_values→metadata_definitions (live):', smvDef, smvDef === 0 ? '✓' : '✗');
} catch(e) { console.log('song_metadata_values→metadata_definitions: query error:', e.message); }

// Check what clock_id the 41 orphaned clock_slots point to
const orphanClockIds = s.prepare(`
  SELECT DISTINCT cs.clock_id FROM clock_slots cs
  LEFT JOIN clocks c ON c.id = cs.clock_id WHERE c.id IS NULL
`).all().map(r => r.clock_id);
console.log('\nOrphaned clock_ids in scratch:', orphanClockIds);

// Are ALL orphaned slots soft-deleted?
for (const cid of orphanClockIds) {
  const live = s.prepare('SELECT COUNT(*) as c FROM clock_slots WHERE clock_id=? AND deleted_at IS NULL').get(cid).c;
  const total = s.prepare('SELECT COUNT(*) as c FROM clock_slots WHERE clock_id=?').get(cid).c;
  console.log(`  clock_id=${cid}: ${total} slots total, ${live} live (non-deleted), ${total-live} soft-deleted`);
}

s.close();
