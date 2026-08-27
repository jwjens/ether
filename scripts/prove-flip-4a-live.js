'use strict';
// scripts/prove-flip-4a-live.js — READ-ONLY. The receipt for step 4a.
//
// prove-rotation-pool.js compares two predicates I WROTE IN THE HARNESS. That proves the data
// supports the flip; it does not prove the flip was implemented correctly, because the harness never
// executes loggen's SQL. After the edit, the only thing worth proving is that THE REAL ROTATION CODE
// still selects the same songs.
//
// So this requires audiod/loggen.js and calls its actual exported internals — the same baseConditions,
// the same SELECT with the asset join, the same lrpOrder the daemon runs — and compares the resulting
// song-id SET, per station per hour, against the pre-flip predicate reconstructed from `songs`.
//
// pickTier orders by RANDOM(), so the ORDER is expected to differ every run and is deliberately not
// compared. The SET is what must be identical. A huge LIMIT is passed so the pool comes back whole.
//
// pickTier swallows SQL errors and returns [] — an empty pool and a broken query look identical from
// the outside. So console.error is captured and any "pickTier failed" is a hard FAIL, not a zero.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/prove-flip-4a-live.js [db]

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const loggen = require(path.join(__dirname, '..', 'audiod', 'loggen.js'));

const dbPath = process.argv[2] ||
  path.join(process.env.LOCALAPPDATA, 'Ether', 'profiles', 'ETH-STN-BAA8-E056-6FC8', 'openair.db');
const db = new Database(dbPath, { readonly: true });

console.log('=== step 4a live proof: real loggen SQL vs pre-flip baseline (READ-ONLY) ===');
console.log('DB:', dbPath, '\n');

if (!loggen._test || !loggen._test.pickTier) {
  console.log('FAIL: audiod/loggen.js does not export _test.pickTier — cannot prove against real SQL.');
  process.exit(1);
}

// Capture the swallowed SQL errors. Without this a broken query reports as "0 eligible".
const sqlErrors = [];
const realError = console.error;
console.error = (...a) => { const m = a.join(' '); if (/pickTier failed|prepare failed/.test(m)) sqlErrors.push(m); };

// The PRE-FLIP predicate, against `songs` only — what rotation selected before the edit.
const baseline = db.prepare(`
  SELECT s.id FROM songs s
   WHERE s.deleted_at IS NULL
     AND s.file_path IS NOT NULL
     AND s.category_id IS NOT NULL
     AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
     AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
     AND ((s.daypart_mask >> ?) & 1) = 1
     AND s.category_id IN (${'?'})`);

const stations = db.prepare('SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id').all();
const BIG = 100000;   // larger than any library, so LIMIT never truncates the pool

let anyDrift = false, totalCompared = 0;

for (const st of stations) {
  const cats = loggen.getStationCategoryIds(db, st.id);
  let drift = 0, poolTotal = 0, hours = 0, sample = null;

  for (let h = 0; h < 24; h++) {
    // REAL rotation SQL — the flipped baseConditions + SELECT + asset join.
    const live = new Set(
      loggen._test.pickTier(db, BIG, h, st.id, cats, [], { daypart: true }, 'random')
        .map(r => r.id));

    // Pre-flip baseline, one category at a time (the IN-list is per-station).
    const before = new Set();
    for (const c of cats) for (const r of baseline.all(h, c)) before.add(r.id);

    const onlyBefore = [...before].filter(x => !live.has(x));
    const onlyAfter  = [...live].filter(x => !before.has(x));
    if (onlyBefore.length || onlyAfter.length) {
      drift += onlyBefore.length + onlyAfter.length;
      if (!sample) sample = { h, onlyBefore: onlyBefore.slice(0, 3), onlyAfter: onlyAfter.slice(0, 3) };
    }
    poolTotal += live.size; hours++; totalCompared += live.size;
  }

  const pad = Math.max(0, 34 - st.name.length);
  console.log(`── station ${st.id}: ${st.name} ${'─'.repeat(pad)}`);
  console.log(`   pool from REAL loggen SQL   avg/hour: ${Math.round(poolTotal / hours)}`);
  console.log(`   vs pre-flip baseline:       ${drift === 0 ? 'IDENTICAL ✓' : `DRIFT ${drift} ✗`}`);
  if (sample) console.log(`     e.g. hour ${sample.h}: lostByFlip=${JSON.stringify(sample.onlyBefore)} gainedByFlip=${JSON.stringify(sample.onlyAfter)}`);
  if (drift) anyDrift = true;
  console.log('');
}

console.error = realError;

console.log('── SQL health (pickTier swallows errors; an empty pool can mean a broken query) ──');
console.log(`   swallowed SQL errors: ${sqlErrors.length}` + (sqlErrors.length ? '  ✗' : '  ✓'));
for (const e of sqlErrors.slice(0, 3)) console.log(`     ${e}`);
console.log(`   rows actually compared: ${totalCompared}` + (totalCompared ? '  ✓' : '  ✗ nothing ran'));

const ok = !anyDrift && sqlErrors.length === 0 && totalCompared > 0;
console.log('\n──────────────────────────────');
console.log(ok
  ? '  VERDICT: PASS — the real, flipped rotation SQL selects exactly the pre-flip song set on\n           every station and every hour. Step 4a changed no rotation output.'
  : '  VERDICT: FAIL — the flip changed rotation. Do not commit.');
console.log('──────────────────────────────');

db.close();
process.exit(ok ? 0 : 1);
