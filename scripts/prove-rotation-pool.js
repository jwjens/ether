'use strict';
// scripts/prove-rotation-pool.js — READ-ONLY. The before/after proof harness for step 4.
//
// Rotation picks with `ORDER BY <least-recently-played>, RANDOM()`, so comparing the SEQUENCE it
// produces proves nothing — two identical systems give different sequences. What must be identical
// is the ELIGIBLE POOL: the exact set of songs rotation is allowed to choose from, per station, per
// hour. If the pool is unchanged, rotation is unchanged; if the pool moves, rotation moves.
//
// So this computes the pool three ways and diffs them, per station:
//
//   A  TODAY          — the live predicate, reading the INSTALL-SCOPED columns on `songs`
//                       (category_id, rotation_status, daypart_mask). audiod/loggen.js:70.
//   B  ASSET-ONLY     — the same predicate reading library_asset for the ASSET fields
//                       (file_path, type) and still `songs` for the programming fields.
//                       This is what step 4a would do. A ≡ B is the claim it has to earn.
//   C  PER-STATION    — programming fields read from station_programming instead.
//                       This is step 4b, and the diff A vs C is the number that decides whether it
//                       can be done at all yet.
//
// Nothing is written. Nothing is flipped. This runs against the live DB read-only and prints the
// numbers Jeff asked to see before any reader changes.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/prove-rotation-pool.js [db]

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const dbPath = process.argv[2] ||
  path.join(process.env.LOCALAPPDATA, 'Ether', 'profiles', 'ETH-STN-BAA8-E056-6FC8', 'openair.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== rotation pool comparison (READ-ONLY) ===');
console.log('DB:', dbPath, '\n');

const stations = db.prepare('SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id').all();
const hasLibraryAsset = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_asset'").get();

// ── A — TODAY. Lifted verbatim from audiod/loggen.js baseConditions, daypart included. ───────────
const poolToday = db.prepare(`
  SELECT s.id FROM songs s
   WHERE s.deleted_at IS NULL
     AND s.file_path IS NOT NULL
     AND s.category_id IS NOT NULL
     AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
     AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
     AND ((s.daypart_mask >> ?) & 1) = 1
     AND s.category_id IN (SELECT id FROM categories WHERE station_id = ? AND deleted_at IS NULL)`);

// ── B — ASSET FIELDS FROM library_asset, programming still from songs. Step 4a. ──────────────────
const poolAssetOnly = hasLibraryAsset ? db.prepare(`
  SELECT s.id FROM songs s
     JOIN library_asset a ON a.uuid = s.uuid AND a.deleted_at IS NULL
   WHERE s.deleted_at IS NULL
     AND a.file_path IS NOT NULL
     AND s.category_id IS NOT NULL
     AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
     AND a.type = 'SONG'
     AND ((s.daypart_mask >> ?) & 1) = 1
     AND s.category_id IN (SELECT id FROM categories WHERE station_id = ? AND deleted_at IS NULL)`) : null;

// ── C — PROGRAMMING FROM station_programming. Step 4b. ───────────────────────────────────────────
const poolPerStation = db.prepare(`
  SELECT s.id FROM songs s
     JOIN station_programming sp ON sp.song_id = s.id AND sp.station_id = ? AND sp.deleted_at IS NULL
   WHERE s.deleted_at IS NULL
     AND s.file_path IS NOT NULL
     AND sp.category_id IS NOT NULL
     AND (sp.rotation_status IS NULL OR sp.rotation_status != 'inactive')
     AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
     AND ((sp.daypart_mask >> ?) & 1) = 1`);

const setOf = (rows) => new Set(rows.map(r => r.id));
const diff  = (a, b) => [...a].filter(x => !b.has(x));

let anyDrift = false;
const HOURS = [...Array(24).keys()];

for (const st of stations) {
  console.log(`── station ${st.id}: ${st.name} ${'─'.repeat(Math.max(0, 46 - st.name.length))}`);

  let totalA = 0, driftAB = 0, driftAC = 0, hoursChecked = 0;
  let sampleAB = null, sampleAC = null;

  for (const h of HOURS) {
    const A = setOf(poolToday.all(h, st.id));
    totalA += A.size;
    hoursChecked++;

    if (poolAssetOnly) {
      const B = setOf(poolAssetOnly.all(h, st.id));
      const onlyA = diff(A, B), onlyB = diff(B, A);
      if (onlyA.length || onlyB.length) {
        driftAB += onlyA.length + onlyB.length;
        if (!sampleAB) sampleAB = { h, onlyA: onlyA.slice(0, 3), onlyB: onlyB.slice(0, 3) };
      }
    }

    const C = setOf(poolPerStation.all(st.id, h));
    const onlyA2 = diff(A, C), onlyC = diff(C, A);
    if (onlyA2.length || onlyC.length) {
      driftAC += onlyA2.length + onlyC.length;
      if (!sampleAC) sampleAC = { h, onlyA: onlyA2.slice(0, 3), onlyC: onlyC.slice(0, 3) };
    }
  }

  const avgA = Math.round(totalA / hoursChecked);
  console.log(`   A  today (songs columns)      avg eligible/hour: ${avgA}`);

  if (poolAssetOnly) {
    const verdict = driftAB === 0 ? 'IDENTICAL ✓' : `DRIFT ${driftAB} across 24h ✗`;
    console.log(`   B  asset fields → library_asset   vs A: ${verdict}`);
    if (sampleAB) console.log(`        e.g. hour ${sampleAB.h}: onlyA=${JSON.stringify(sampleAB.onlyA)} onlyB=${JSON.stringify(sampleAB.onlyB)}`);
    if (driftAB) anyDrift = true;
  } else {
    console.log('   B  asset fields → library_asset   SKIPPED (library_asset absent — run v50 first)');
  }

  const cAvg = Math.round(HOURS.reduce((n, h) => n + poolPerStation.all(st.id, h).length, 0) / 24);
  const verdictC = driftAC === 0 ? 'IDENTICAL ✓' : `DRIFT ${driftAC} across 24h ✗`;
  console.log(`   C  programming → station_programming  avg eligible/hour: ${cAvg}   vs A: ${verdictC}`);
  if (sampleAC) console.log(`        e.g. hour ${sampleAC.h}: onlyA=${JSON.stringify(sampleAC.onlyA)} onlyC=${JSON.stringify(sampleAC.onlyC)}`);
  console.log('');
}

console.log('── why C differs, if it does ──');
const spRows   = db.prepare('SELECT COUNT(*) n FROM station_programming WHERE deleted_at IS NULL').get().n;
const catSongs = db.prepare('SELECT COUNT(*) n FROM songs WHERE deleted_at IS NULL AND category_id IS NOT NULL').get().n;
console.log(`   songs carrying a category (install-scoped):  ${catSongs}`);
console.log(`   station_programming rows (per-station):      ${spRows}`);
console.log(`   → C can only ever offer what has a programming row. Until every categorised song has`);
console.log(`     one, flipping rotation onto station_programming SHRINKS the pool by construction.`);

// The verdict must never claim a comparison that did not run. An earlier version printed
// "A = B on every station" when B had been SKIPPED for a missing table — a false green of exactly
// the kind this harness exists to prevent.
console.log('');
if (!hasLibraryAsset) {
  console.log('VERDICT (B): NOT EVALUATED - library_asset is absent on this DB. Apply v50 (relaunch)');
  console.log('             and re-run. The asset-field flip is UNPROVEN until this shows IDENTICAL.');
} else if (anyDrift) {
  console.log('VERDICT (B): DRIFT - do NOT flip the asset-field readers until the diff is zero.');
} else {
  console.log('VERDICT (B): A = B on every station and every hour - the asset-field flip is pool-neutral.');
}
console.log('VERDICT (C): see the per-station drift above. A non-zero drift means flipping the');
console.log('             programming readers onto station_programming would CHANGE what airs.');

db.close();
