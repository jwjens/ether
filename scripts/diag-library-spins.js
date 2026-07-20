'use strict';
// diag-library-spins.js — READ-ONLY, data-first. Partition a station's library by ACTUAL airplay
// (play_log, last 7d) into zero-spin vs spun, then mechanically diff attributes to find the gate.
// Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/diag-library-spins.js [stationId] [db]
const path = require('path'), os = require('os'), fs = require('fs');
const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const sid = Number(process.argv[2] || 2);
const dbPath = process.argv[3] || path.join(lad, 'Ether', 'com.ether.radio', 'openair.db');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath, { readonly: true });
const exists = (fp) => { try { return !!fp && fs.existsSync(fp); } catch { return false; } };
const day = (ts) => {
  if (ts == null) return '(null)';
  let d;
  if (typeof ts === 'string' && /[-T:]/.test(ts)) d = new Date(ts);
  else { const n = Number(ts); d = new Date(String(n).length > 12 ? n : n*1000); }
  return isNaN(d.getTime()) ? String(ts).slice(0,10) : d.toISOString().slice(0,10);
};
const stName = (db.prepare("SELECT name FROM stations WHERE id=?").get(sid)||{}).name || sid;
const weekAgo = Math.floor(Date.now()/1000) - 7*86400;

console.log(`=== LIBRARY SPIN PARTITION — station ${sid} (${stName}) — last 7 days ===\nDB: ${dbPath}\n`);

const cats = db.prepare("SELECT id FROM categories WHERE station_id=? AND deleted_at IS NULL").all(sid).map(r=>r.id);
const inCats = cats.length ? `(${cats.join(',')})` : '(-1)';
const songs = db.prepare(
  `SELECT s.id, s.title, s.file_path, s.file_key, s.duration_ms, s.rotation_status, s.content_class,
          s.category_id, s.deleted_at, s.created_at
     FROM songs s WHERE s.category_id IN ${inCats} AND s.deleted_at IS NULL`).all();
const spinStmt = db.prepare(`SELECT COUNT(*) c FROM play_log WHERE station_id=? AND file_path=? AND deleted_at IS NULL AND played_at > ?`);

// (1) spin count per song → two sets.
const spun = [], zero = [];
for (const s of songs) { s._spins = s.file_path ? spinStmt.get(sid, s.file_path, weekAgo).c : 0; (s._spins>0 ? spun : zero).push(s); }
spun.sort((a,b)=>b._spins-a._spins);
console.log(`(1) SPIN PARTITION — ${songs.length} active library songs:`);
console.log(`    SPUN (>=1 spin/7d):  ${spun.length}   total spins=${spun.reduce((a,s)=>a+s._spins,0)}`);
console.log(`    ZERO-SPIN (0/7d):    ${zero.length}   (${Math.round(zero.length/songs.length*100)}% of the library never aired)`);
console.log(`    heavy repeaters (top 5): ${spun.slice(0,5).map(s=>`"${s.title}"×${s._spins}`).join(', ')}`);
const avgSpun = spun.length ? (spun.reduce((a,s)=>a+s._spins,0)/spun.length).toFixed(1) : 0;
console.log(`    avg spins across the SPUN set = ${avgSpun}/7d  (a ${spun.length}-song pool cycling instead of ${songs.length})`);

// (2) mechanical attribute diff — which attribute partitions zero vs spun cleanly?
const feat = {
  'local file EXISTS':   s => exists(s.file_path),
  'has file_key (R2)':   s => !!s.file_key,
  'duration_ms present': s => !!s.duration_ms,
  'content_class=MUSIC':  s => (s.content_class==null||s.content_class==='MUSIC'),
  'rotation active':     s => (s.rotation_status==null||s.rotation_status!=='inactive'),
  'in on-format cat':    s => cats.includes(s.category_id),
};
console.log(`\n(2) MECHANICAL ATTRIBUTE DIFF (share of each set with the attribute):`);
console.log(`    attribute                SPUN     ZERO-SPIN   partitions?`);
for (const [name, fn] of Object.entries(feat)) {
  const ps = spun.length ? spun.filter(fn).length/spun.length : 0;
  const pz = zero.length ? zero.filter(fn).length/zero.length : 0;
  const clean = Math.abs(ps-pz) > 0.9 ? '  <== CLEAN GATE' : (Math.abs(ps-pz)>0.4?'  (partial)':'');
  console.log(`    ${name.padEnd(24)} ${(ps*100).toFixed(0).padStart(3)}%     ${(pz*100).toFixed(0).padStart(3)}%      ${clean}`);
}
// import batch (created_at day) distribution per set.
const dist = (arr) => { const d={}; for(const s of arr){const k=day(s.created_at); d[k]=(d[k]||0)+1;} return Object.entries(d).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,n])=>`${k}:${n}`).join('  '); };
console.log(`\n    import batch (created_at) — SPUN:      ${dist(spun)}`);
console.log(`    import batch (created_at) — ZERO-SPIN: ${dist(zero)}`);

// (3) verify 3 zero-spin through the doors.
console.log(`\n(3) THREE ZERO-SPIN SONGS — the gate at each door:`);
for (const s of zero.slice(0,3)) {
  const cc=(s.content_class==null||s.content_class==='MUSIC'), rot=(s.rotation_status==null||s.rotation_status!=='inactive');
  const sel = s.file_path!=null && rot && cc && cats.includes(s.category_id);
  console.log(`\n  • "${s.title}" (id ${s.id})  spins=0`);
  console.log(`     file_path=${s.file_path}`);
  console.log(`     local-exists=${exists(s.file_path)}  file_key=${s.file_key?'YES':'no'}  dur=${s.duration_ms}  class=${s.content_class}  rot=${s.rotation_status}  cat=${s.category_id}(in-format=${cats.includes(s.category_id)})`);
  console.log(`     Generate/live-pick baseConditions SELECT = ${sel}  (file_path IS NOT NULL passes even though the file is absent)`);
  console.log(`     A/B/C deck-load _fileOk(fs.existsSync) = ${exists(s.file_path)} → loadToDeck ${exists(s.file_path)?'true':'FALSE = silent skip'}`);
}
db.close();
console.log(`\nRead-only. Gate = the attribute marked CLEAN above. If SELECT=true but deck-load=FALSE, the song is chosen then silently dropped at load → 0 spins → the spun pool repeats.`);
