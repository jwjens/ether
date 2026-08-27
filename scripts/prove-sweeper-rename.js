'use strict';
// scripts/prove-sweeper-rename.js — READ-ONLY. v52 retired the name without taking imaging off air.
//
// docs/jingle-eradication-plan-2026-08-27.md
//
// Counting rows only proves the UPDATE ran. The thing that can actually break is subtler: the
// overlay scheduler selects imaging with
//     WHERE s.jingle_category_id = ? AND s.content_class = ?     (electron/main.js:7887)
// supplying the second parameter from the POOL'S TYPE (main.js:7914). If pools and songs ever
// disagree, resolvePool() returns an empty candidate list, the error is swallowed by a catch, and
// imaging stops airing with nothing in the log to say why. So this replays that exact query per pool
// and asserts it still returns candidates.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/prove-sweeper-rename.js <db>

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const dbPath = process.argv[2] ||
  path.join(process.env.LOCALAPPDATA, 'Ether', 'profiles', 'ETH-STN-BAA8-E056-6FC8', 'openair.db');
const db = new Database(dbPath, { readonly: true });

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== prove-sweeper-rename (READ-ONLY) ===');
console.log('DB:', dbPath, '\n');

console.log('── 1. the name is gone from the data ──');
for (const [t, c] of [['jingle_categories', 'type'], ['songs', 'content_class'],
                      ['generated_schedule', 'content_class'], ['play_log', 'content_class']]) {
  check(`${t}: zero 'JIN' rows`, db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c} = 'JIN'`).get().n, 0);
}

console.log('\n── 2. nothing was lost — the rows became SWP, they did not vanish ──');
check('jingle_categories SWP pools', db.prepare("SELECT COUNT(*) n FROM jingle_categories WHERE type='SWP' AND deleted_at IS NULL").get().n, 4);
check('songs SWP (was 64 JIN)',      db.prepare("SELECT COUNT(*) n FROM songs WHERE content_class='SWP' AND deleted_at IS NULL").get().n, 64);
const gs = db.prepare("SELECT COUNT(*) n FROM generated_schedule WHERE content_class='SWP'").get().n;
const pl = db.prepare("SELECT COUNT(*) n FROM play_log WHERE content_class='SWP'").get().n;
console.log(`         generated_schedule SWP: ${gs}   play_log SWP: ${pl}`);
check('generated_schedule kept its rows', gs > 46000, true);
check('play_log kept its rows',           pl > 16000, true);

console.log('\n── 3. THE ONE THAT MATTERS: resolvePool still finds candidates ──');
// main.js:7914-7915 verbatim in shape: the pool's type IS the content_class it searches for.
const poolType = db.prepare("SELECT type FROM jingle_categories WHERE id = ? AND deleted_at IS NULL");
const poolCands = db.prepare(`
  SELECT COUNT(*) n FROM songs s
   WHERE s.jingle_category_id = ? AND s.content_class = ? AND s.file_path IS NOT NULL
     AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')`);

// An EMPTY pool is not a failure — an operator can create a pool and not fill it yet, and pool 2
// ("Christmas", Magical Forest) was already empty before v52 ran. Asserting non-empty would fail on
// a legitimate data state. What must hold is that the type match LOSES NOTHING: every live sweeper
// song still resolves through its pool.
let resolved = 0;
for (const p of db.prepare("SELECT id, name, station_id FROM jingle_categories WHERE deleted_at IS NULL ORDER BY id").all()) {
  const t = (poolType.get(p.id) || {}).type || 'JIN';
  const n = poolCands.get(p.id, t).n;
  resolved += n;
  console.log(`         pool ${p.id} "${p.name}" (station ${p.station_id}) type=${t} → ${n} candidate(s)`
    + (n === 0 ? '   (empty pool — was empty before v52 too)' : ''));
}
const assigned = db.prepare(`SELECT COUNT(*) n FROM songs
   WHERE content_class = 'SWP' AND deleted_at IS NULL AND jingle_category_id IS NOT NULL
     AND file_path IS NOT NULL AND (rotation_status IS NULL OR rotation_status != 'inactive')`).get().n;
check(`every assigned sweeper resolves through its pool (${resolved} of ${assigned})`, resolved, assigned);

console.log('\n── 4. no sweeper song points at a pool of a different type ──');
check('zero mismatched song/pool pairs',
  db.prepare(`SELECT COUNT(*) n FROM songs s JOIN jingle_categories jc ON jc.id = s.jingle_category_id
              WHERE s.deleted_at IS NULL AND s.content_class = 'SWP' AND jc.type != 'SWP'`).get().n, 0);

console.log('\n── 5. the library and the rest of the model are untouched ──');
check('library_asset SWEEPER still 64', db.prepare("SELECT COUNT(*) n FROM library_asset WHERE type='SWEEPER' AND deleted_at IS NULL").get().n, 64);
check('no SONG rows crept back',        db.prepare("SELECT COUNT(*) n FROM library_asset WHERE type='SONG'").get().n, 0);
check('music is untouched',             db.prepare("SELECT COUNT(*) n FROM songs WHERE deleted_at IS NULL AND (content_class IS NULL OR content_class='MUSIC')").get().n > 400, true);
check('every sweeper still has its pool',
  db.prepare("SELECT COUNT(*) n FROM songs WHERE content_class='SWP' AND deleted_at IS NULL AND jingle_category_id IS NULL").get().n, 0);

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
process.exit(fail === 0 ? 0 : 1);
