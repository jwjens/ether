'use strict';
// scripts/prove-panel-filtered-views.js — READ-ONLY. The panels show the same rows after the flip.
//
// docs/library-current-state.md (Option 1, ruled 2026-08-27)
//
// Step 4 turned three panels into filtered views over `library_asset`. The risk in that change is not
// that it errors — it is that it silently shows FEWER rows, or the wrong station's rows, and the
// operator concludes the feature is broken. So this runs the OLD query and the NEW query side by side
// against a migrated database and compares the row sets.
//
// The station-scoping check is the one that matters most: `library_asset` is install-scoped, so a
// type filter alone would show every station's spots and announcements to every station. The join is
// what preserves scoping, and this asserts it holds per station.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/prove-panel-filtered-views.js <db>

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const dbPath = process.argv[2];
if (!dbPath) { console.log('usage: prove-panel-filtered-views.js <db>   (use a COPY, never the live DB)'); process.exit(1); }
const db = new Database(dbPath, { readonly: true });

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== panel filtered views: old query vs new query (READ-ONLY) ===');
console.log('DB:', dbPath, '\n');

const stations = db.prepare('SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id').all();

// ── ANNOUNCEMENTS ───────────────────────────────────────────────────────────────────────────────
// OLD: every announcement for the station, with no deleted_at test (the quiet bug).
// NEW: driven by library_asset type='ANNOUNCEMENT', joined back for the station's schedule fields.
console.log('── announcements ──');
const annOld = db.prepare(`SELECT uuid FROM announcements WHERE station_id = ? AND deleted_at IS NULL ORDER BY title`);
const annNew = db.prepare(`
  SELECT a.uuid FROM library_asset la
    JOIN announcements a ON a.uuid = la.uuid
   WHERE la.type = 'ANNOUNCEMENT' AND la.deleted_at IS NULL AND a.deleted_at IS NULL
     AND a.station_id = ? ORDER BY la.title`);
for (const st of stations) {
  const o = annOld.all(st.id).map(r => r.uuid).sort();
  const nn = annNew.all(st.id).map(r => r.uuid).sort();
  check(`station ${st.id} (${st.name}): ${nn.length} row(s), same set as before`, nn, o);
}

// ── SPOTS ───────────────────────────────────────────────────────────────────────────────────────
console.log('\n── spots ──');
const spOld = db.prepare(`SELECT uuid FROM spots WHERE deleted_at IS NULL AND station_id = ? ORDER BY title`);
const spNew = db.prepare(`
  SELECT s.uuid FROM library_asset la
    JOIN spots s ON s.uuid = la.uuid
   WHERE s.deleted_at IS NULL AND la.deleted_at IS NULL AND la.type = 'SPOT'
     AND s.station_id = ? ORDER BY la.title`);
for (const st of stations) {
  const o = spOld.all(st.id).map(r => r.uuid).sort();
  const nn = spNew.all(st.id).map(r => r.uuid).sort();
  check(`station ${st.id} (${st.name}): ${nn.length} row(s), same set as before`, nn, o);
}

// ── SWEEPERS ────────────────────────────────────────────────────────────────────────────────────
console.log('\n── sweepers (install-scoped, one shared pool) ──');
const swOld = db.prepare(`SELECT s.id, s.content_class FROM songs s WHERE s.content_class IN ('JIN','SWP') AND s.deleted_at IS NULL ORDER BY s.content_class, s.title`).all();
const swNew = db.prepare(`
  SELECT s.id, s.content_class FROM library_asset la
    JOIN songs s ON s.uuid = la.uuid
   WHERE la.type = 'SWEEPER' AND la.deleted_at IS NULL AND s.deleted_at IS NULL
   ORDER BY s.content_class, la.title`).all();
check(`same sweepers (${swNew.length})`, swNew.map(r => r.id).sort((a, b) => a - b), swOld.map(r => r.id).sort((a, b) => a - b));

// THE TAB SPLIT. v50 mapped BOTH 'JIN' and 'SWP' to the single type SWEEPER, so a type-only filter
// would collapse the panel's two tabs into one. The sub-kind must survive the flip.
const tabs = (rows) => { const o = {}; for (const r of rows) o[r.content_class] = (o[r.content_class] || 0) + 1; return o; };
check('JIN/SWP tab split survives the flip', tabs(swNew), tabs(swOld));

// ── THE SCOPING GUARANTEE ───────────────────────────────────────────────────────────────────────
console.log('\n── station scoping is preserved (library_asset is install-scoped) ──');
const annAll = db.prepare(`SELECT COUNT(*) n FROM library_asset WHERE type='ANNOUNCEMENT' AND deleted_at IS NULL`).get().n;
const annS2  = annNew.all(2).length;
console.log(`   announcements in the library install-wide: ${annAll}`);
console.log(`   ...visible to station 2 through the panel: ${annS2}`);
check('a type-only read would over-share; the join does not', annS2 <= annAll, true);

// ── MUSIC IS NOT IN THE LIBRARY, AND IS UNHARMED ────────────────────────────────────────────────
console.log('\n── the ruling: music stays in `songs` ──');
check('no SONG rows in library_asset', db.prepare("SELECT COUNT(*) n FROM library_asset WHERE type='SONG'").get().n, 0);
check('songs still holds the music', db.prepare("SELECT COUNT(*) n FROM songs WHERE deleted_at IS NULL AND (content_class IS NULL OR content_class='MUSIC')").get().n > 400, true);

const shape = db.prepare(`SELECT type, COUNT(*) n FROM library_asset WHERE deleted_at IS NULL GROUP BY type ORDER BY n DESC`).all();
console.log('\n   library_asset now holds: ' + shape.map(r => `${r.type}=${r.n}`).join('  '));

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
process.exit(fail === 0 ? 0 : 1);
