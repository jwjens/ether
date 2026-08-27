'use strict';
// scripts/prove-asset-field-parity.js — READ-ONLY. The other half of the 4a proof.
//
// prove-rotation-pool.js proves the eligible POOL is unchanged: rotation picks the same songs.
// That is necessary and NOT sufficient. Step 4a also swaps the fields that decide how a picked
// song AIRS — duration, intro/outro marks, the file the deck actually opens. A song can sit in
// exactly the right pool and still play with the wrong outro, or fail to load at all, if
// library_asset disagrees with songs on those values.
//
// So this compares, row by row, every ASSET column 4a would move, for every song rotation can
// reach. A single mismatch means 4a is NOT behaviour-neutral and must not be flipped.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/prove-asset-field-parity.js [db]

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const dbPath = process.argv[2] ||
  path.join(process.env.LOCALAPPDATA, 'Ether', 'profiles', 'ETH-STN-BAA8-E056-6FC8', 'openair.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== asset field parity: songs vs library_asset (READ-ONLY) ===');
console.log('DB:', dbPath, '\n');

// Exactly the columns step 4a would re-source. Programming columns are deliberately absent —
// those are 4b, they are SUPPOSED to differ, and comparing them here would be noise.
const FIELDS = ['title', 'file_path', 'file_key', 'duration_ms', 'artist_id', 'album_id',
                'intro_end', 'outro_start', 'cue_in', 'cue_out'];

const rows = db.prepare(`
  SELECT s.id, s.uuid, s.title AS s_title, s.content_class,
         a.uuid AS a_uuid, a.type AS a_type,
         ${FIELDS.map(f => `s.${f} AS s_${f}, a.${f} AS a_${f}`).join(', ')}
    FROM songs s
    LEFT JOIN library_asset a ON a.uuid = s.uuid AND a.deleted_at IS NULL
   WHERE s.deleted_at IS NULL
     AND s.file_path IS NOT NULL
     AND s.category_id IS NOT NULL
     AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
     AND (s.content_class IS NULL OR s.content_class = 'MUSIC')`).all();

console.log(`rotation-reachable songs examined: ${rows.length}\n`);

// ── 1. COVERAGE. A missing asset row is the worst failure: the song vanishes from the deck. ──
const orphans = rows.filter(r => !r.a_uuid);
console.log('── 1. every rotation-reachable song has an asset row ──');
console.log(`   missing asset rows: ${orphans.length}` + (orphans.length ? '  ✗' : '  ✓'));
for (const o of orphans.slice(0, 5)) console.log(`     id=${o.id} "${o.s_title}"`);

// ── 2. TYPE. content_class MUSIC must have become type SONG, or the pool predicate diverges. ──
const wrongType = rows.filter(r => r.a_uuid && r.a_type !== 'SONG');
console.log('\n── 2. MUSIC mapped to type SONG ──');
console.log(`   wrong type: ${wrongType.length}` + (wrongType.length ? '  ✗' : '  ✓'));
for (const w of wrongType.slice(0, 5)) console.log(`     id=${w.id} "${w.s_title}" → ${w.a_type}`);

// ── 3. VALUES. Compare loosely on purpose: SQLite stores 3 and 3.0 differently, and a
//        NULL-vs-empty-string difference changes nothing a deck can observe. What matters is
//        whether the deck would behave differently, not whether the bytes match.
const norm = (v) => (v === null || v === undefined || v === '') ? null
                  : (typeof v === 'number' ? v : (isNaN(Number(v)) ? String(v) : Number(v)));

console.log('\n── 3. field-by-field parity on the columns 4a moves ──');
let totalMismatch = 0;
const samples = {};
for (const f of FIELDS) {
  const bad = rows.filter(r => r.a_uuid && norm(r[`s_${f}`]) !== norm(r[`a_${f}`]));
  totalMismatch += bad.length;
  if (bad.length) samples[f] = bad.slice(0, 3);
  console.log(`   ${f.padEnd(13)} mismatches: ${String(bad.length).padStart(4)}` + (bad.length ? '  ✗' : '  ✓'));
}
for (const [f, bad] of Object.entries(samples)) {
  console.log(`\n   e.g. ${f}:`);
  for (const b of bad) console.log(`     id=${b.id} songs=${JSON.stringify(b[`s_${f}`])}  asset=${JSON.stringify(b[`a_${f}`])}`);
}

const fail = orphans.length + wrongType.length + totalMismatch;
console.log('\n──────────────────────────────');
console.log(fail === 0
  ? '  VERDICT: PASS — every rotation-reachable song resolves to an asset row carrying identical\n           values on every field 4a moves. The swap cannot change what airs.'
  : `  VERDICT: FAIL — ${fail} discrepancies. 4a is NOT behaviour-neutral. Do not flip.`);
console.log('──────────────────────────────');

db.close();
process.exit(fail === 0 ? 0 : 1);
