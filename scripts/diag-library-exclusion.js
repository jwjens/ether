'use strict';
// diag-library-exclusion.js — READ-ONLY. Why is half a station's library excluded from rotation +
// Generate + A/B/C deck-load, while the cue editor plays it? Characterizes file-resolution state of
// the station's library and dumps 3 excluded samples with the exact gating predicates.
// Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/diag-library-exclusion.js [stationId] [db]
const path = require('path'), os = require('os'), fs = require('fs');
const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const sid = Number(process.argv[2] || 2);   // HalloVeen = 2
const dbPath = process.argv[3] || path.join(lad, 'Ether', 'com.ether.radio', 'openair.db');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath, { readonly: true });
const exists = (fp) => { try { return !!fp && fs.existsSync(fp); } catch { return false; } };
const day = (ts) => ts ? new Date((String(ts).length>12?ts:ts*1000)).toISOString().slice(0,10) : '(null)';

const stName = (db.prepare("SELECT name FROM stations WHERE id=?").get(sid)||{}).name || sid;
console.log(`=== LIBRARY EXCLUSION DIAG — station ${sid} (${stName}) ===\nDB: ${dbPath}\n`);

// Station library = songs whose category belongs to this station.
const cats = db.prepare("SELECT id FROM categories WHERE station_id=? AND deleted_at IS NULL").all(sid).map(r=>r.id);
if (!cats.length) { console.log("no categories for this station"); process.exit(0); }
const inCats = `(${cats.join(',')})`;
const songs = db.prepare(
  `SELECT s.id, s.title, s.file_path, s.file_key, s.duration_ms, s.rotation_status, s.content_class,
          s.daypart_mask, s.category_id, s.artist_id, s.deleted_at, s.created_at, s.r2_uploaded_at
     FROM songs s WHERE s.category_id IN ${inCats}`).all();

let localOk=0, missKey=0, missNoKey=0, nullPath=0, del=0;
const excluded = [];   // in-library, not deleted, but local file missing
for (const s of songs) {
  if (s.deleted_at) { del++; continue; }
  if (!s.file_path) { nullPath++; continue; }
  if (exists(s.file_path)) { localOk++; continue; }
  if (s.file_key) { missKey++; excluded.push(s); } else { missNoKey++; excluded.push(s); }
}
const total = songs.length - del;
console.log(`(2) EXCLUDED SET COUNT — station library = ${total} active songs:`);
console.log(`   local file EXISTS (playable everywhere) : ${localOk}  (${Math.round(localOk/total*100)}%)`);
console.log(`   local MISSING, HAS r2 file_key          : ${missKey}  (${Math.round(missKey/total*100)}%)  <-- cue-editor plays via R2, deck/rotation refuse`);
console.log(`   local MISSING, NO file_key              : ${missNoKey}`);
console.log(`   NULL file_path                          : ${nullPath}`);
console.log(`   (deleted, ignored: ${del})`);

// Shared attribute — import clustering (created_at day) of the excluded set.
console.log(`\n   SHARED ATTRIBUTE of the excluded set (created_at day → import batch):`);
const byDay = {}; for (const s of excluded) { const d = day(s.created_at); byDay[d] = (byDay[d]||0)+1; }
for (const [d,n] of Object.entries(byDay).sort((a,b)=>b[1]-a[1]).slice(0,6)) console.log(`     ${d}: ${n} songs`);
// prefix clustering — do excluded file_paths share a root the local ones don't?
const rootOf = (fp) => (fp||'').replace(/\\/g,'/').split('/').slice(0,3).join('/');
const roots = {}; for (const s of excluded) { const r = rootOf(s.file_path); roots[r]=(roots[r]||0)+1; }
console.log(`   file_path roots (excluded set):`);
for (const [r,n] of Object.entries(roots).sort((a,b)=>b[1]-a[1]).slice(0,4)) console.log(`     ${r}…  ${n}`);
const okRoots = {}; for (const s of songs) if (!s.deleted_at && s.file_path && exists(s.file_path)) { const r=rootOf(s.file_path); okRoots[r]=(okRoots[r]||0)+1; }
console.log(`   file_path roots (PLAYABLE set):`);
for (const [r,n] of Object.entries(okRoots).sort((a,b)=>b[1]-a[1]).slice(0,4)) console.log(`     ${r}…  ${n}`);

// (1) Trace 3 excluded songs through the exact predicates.
console.log(`\n(1) THREE EXCLUDED SONGS — exact gating predicate per door:`);
for (const s of excluded.slice(0,3)) {
  console.log(`\n  • "${s.title}" (id ${s.id})`);
  console.log(`     file_path      = ${s.file_path}`);
  console.log(`     exists locally = ${exists(s.file_path)}   file_key(R2) = ${s.file_key ? 'YES ('+String(s.file_key).slice(0,24)+'…)' : 'no'}   r2_uploaded_at=${s.r2_uploaded_at?day(s.r2_uploaded_at):'no'}`);
  console.log(`     duration_ms=${s.duration_ms}  content_class=${s.content_class}  rotation_status=${s.rotation_status}  category_id=${s.category_id} (in-format=${cats.includes(s.category_id)})  deleted_at=${s.deleted_at||'null'}`);
  // (a)/(b) rotation baseConditions predicates:
  const cc = (s.content_class==null || s.content_class==='MUSIC');
  const rot = (s.rotation_status==null || s.rotation_status!=='inactive');
  const fpNotNull = s.file_path!=null;
  console.log(`     ROTATION/GENERATE baseConditions: file_path IS NOT NULL=${fpNotNull} · rotation!=inactive=${rot} · content_class=MUSIC=${cc} · in on-format cat=${cats.includes(s.category_id)}  => SELECTED=${fpNotNull&&rot&&cc&&cats.includes(s.category_id)}`);
  console.log(`     A/B/C deck-load _fileOk(file_path): fs.existsSync=${exists(s.file_path)} => loadToDeck returns ${exists(s.file_path)?'true':'FALSE (silent skip)'}`);
  console.log(`     CUE EDITOR audio:resolve-local-path: local-first then R2-by-file_key => ${s.file_key?'RESOLVES via R2 → plays':'would fail (no key)'}`);
}
db.close();
console.log(`\nRead-only. If SELECTED=true but deck-load=FALSE, the song is picked by rotation then silently skipped at load = never airs (pool shrinks → repeats).`);
