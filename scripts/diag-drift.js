'use strict';
// diag-drift.js — READ-ONLY drift diagnosis (pre-Phase-3). Why does playout run ahead of scheduled_at?
// Decomposes the drift budget: density (audio-min/hour) vs overlap (gain/song) vs off-log divergence.
// Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/diag-drift.js [db]
const path = require('path'), os = require('os');
const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const dbPath = process.argv[2] || path.join(lad, 'Ether', 'com.ether.radio', 'openair.db');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath, { readonly: true });
const now = Math.floor(Date.now() / 1000);
const hms = (s) => { s = Math.round(s); const sign = s < 0 ? '-' : ''; s = Math.abs(s); return `${sign}${Math.floor(s/60)}m${String(s%60).padStart(2,'0')}s`; };
const clk = (ts) => ts ? new Date(ts*1000).toISOString().slice(11,19) : '(none)';
const med = (a) => a.length ? a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)] : NaN;

console.log(`=== DRIFT DIAGNOSIS ===\nDB: ${dbPath}\nnow: ${new Date(now*1000).toISOString().slice(0,19)}\n`);
const stations = db.prepare("SELECT DISTINCT station_id FROM generated_schedule WHERE deleted_at IS NULL ORDER BY station_id").all().map(r=>r.station_id);

for (const sid of stations) {
  const name = (db.prepare("SELECT name FROM stations WHERE id=?").get(sid) || {}).name || sid;
  console.log(`\n────────── station ${sid} (${name}) ──────────`);

  // Deck rows = music/spot (exclude JIN/SWP overlays).
  const deckWhere = `station_id=${sid} AND deleted_at IS NULL AND (content_class IS NULL OR content_class NOT IN ('JIN','SWP'))`;

  // (1) DENSITY per scheduled hour (today ± a few hrs around now): sum(duration_s) vs 3600.
  console.log(`\n(1) GENERATE DENSITY — audio-seconds scheduled per wall-hour (target 3600):`);
  const dens = db.prepare(
    `SELECT (scheduled_at/3600)*3600 AS hr, COUNT(*) n, SUM(COALESCE(duration_s,0)) dur
       FROM generated_schedule WHERE ${deckWhere} AND scheduled_at BETWEEN ? AND ?
      GROUP BY hr ORDER BY hr`).all(now-3*3600, now+3*3600);
  let overSum=0, cnt=0;
  for (const h of dens) {
    const pct = Math.round(h.dur/3600*100);
    console.log(`   ${clk(h.hr)}  ${h.n} rows  ${hms(h.dur)} audio  = ${pct}% of the hour ${pct>105?'⚠ OVER':pct<95?'⚠ UNDER':'ok'}`);
    overSum += (h.dur-3600); cnt++;
  }
  console.log(`   => avg per hour: ${hms(3600 + overSum/Math.max(cnt,1))} (${Math.round((3600+overSum/Math.max(cnt,1))/3600*100)}% of real time); systematic over-pack/hr = ${hms(overSum/Math.max(cnt,1))}`);

  // (2) SCHEDULING MODEL — is scheduled_at spaced by song duration? ratio = gap/duration.
  const rows = db.prepare(`SELECT scheduled_at, COALESCE(duration_s,0) d FROM generated_schedule WHERE ${deckWhere} AND scheduled_at BETWEEN ? AND ? ORDER BY scheduled_at`).all(now-3600, now+3*3600);
  const ratios=[]; for (let i=0;i<rows.length-1;i++){ const gap=rows[i+1].scheduled_at-rows[i].scheduled_at; if(rows[i].d>0&&gap>0&&gap<3600) ratios.push(gap/rows[i].d); }
  console.log(`\n(2) SCHEDULING MODEL — median (gap between scheduled starts)/(song duration) = ${med(ratios).toFixed(2)}  ${Math.abs(med(ratios)-1)<0.1?'(duration-based: scheduled_at = cumulative durations)':'(NOT duration-based — grid/gaps)'}`);

  // (3) DRIFT NOW — the playhead's scheduled_at vs wall-clock.
  const ph = db.prepare(`SELECT id,title,scheduled_at,played_at FROM generated_schedule WHERE station_id=? AND state='playing' AND deleted_at IS NULL ORDER BY scheduled_at LIMIT 1`).get(sid);
  if (ph) console.log(`\n(3) DRIFT NOW — playhead "${ph.title}" scheduled ${clk(ph.scheduled_at)}, wall ${clk(now)}  => AHEAD by ${hms(ph.scheduled_at-now)}`);
  else console.log(`\n(3) DRIFT NOW — no 'playing' row (off-log or not started)`);

  // (4) DRIFT TREND + (5) PER-SONG GAIN/OVERLAP — from shadow-stamped played rows (played_at present).
  const played = db.prepare(`SELECT scheduled_at, played_at, COALESCE(duration_s,0) d, title FROM generated_schedule WHERE station_id=? AND state='played' AND played_at IS NOT NULL AND deleted_at IS NULL ORDER BY played_at DESC LIMIT 80`).all(sid).reverse();
  if (played.length < 3) { console.log(`\n(4/5) not enough shadow-stamped history yet (${played.length} rows) — let it air longer.`); continue; }
  const firstDrift = played[0].scheduled_at - played[0].played_at, lastDrift = played[played.length-1].scheduled_at - played[played.length-1].played_at;
  const spanSec = played[played.length-1].played_at - played[0].played_at;
  console.log(`\n(4) DRIFT TREND — over the last ${played.length} aired songs (${hms(spanSec)} of airtime):`);
  console.log(`   drift ${hms(firstDrift)} → ${hms(lastDrift)}  (change ${hms(lastDrift-firstDrift)})  ${lastDrift-firstDrift>60?'⚠ growing (no effective re-anchor)':''}`);
  // per-song gain = scheduled_gap - actual_gap; overlap ratio = actual_gap/duration.
  const gains=[], ov=[]; let skips=0;
  for (let i=0;i<played.length-1;i++){
    const sg = played[i+1].scheduled_at - played[i].scheduled_at;
    const ag = played[i+1].played_at - played[i].played_at;
    if (sg>0 && sg<1800 && ag>0 && ag<1800) { gains.push(sg-ag); if(played[i].d>0) ov.push(ag/played[i].d); }
    else skips++;   // a large jump = a skip / re-anchor / off-log gap
  }
  console.log(`\n(5) PER-SONG GAIN & OVERLAP:`);
  console.log(`   median gain/song (scheduled_gap - actual_airtime) = ${hms(med(gains))}  (positive = playout gains time each song)`);
  console.log(`   median actual_airtime / song duration            = ${(med(ov)*100).toFixed(0)}%  (${med(ov)<0.98?'songs air SHORTER than full length = segue overlap':'≈ full length'})`);
  console.log(`   large jumps (skips / re-anchors / off-log gaps)   = ${skips} of ${played.length-1} boundaries`);

  // (6) OFF-LOG — recent airs with no matching schedule row (Phase 1 divergence).
  let logn=0, off=0;
  try {
    const lg = db.prepare(`SELECT title,file_path,played_at FROM play_log WHERE station_id=? AND deleted_at IS NULL AND (content_class IS NULL OR content_class='MUSIC') ORDER BY played_at DESC LIMIT 30`).all(sid);
    const m = db.prepare(`SELECT 1 FROM generated_schedule g LEFT JOIN songs s ON s.id=g.song_id WHERE g.station_id=? AND g.deleted_at IS NULL AND COALESCE(g.file_path,s.file_path)=? AND ABS(g.scheduled_at-?)<=1800 LIMIT 1`);
    for (const r of lg){ logn++; if(!(r.file_path && m.get(sid,r.file_path,r.played_at||0))) off++; }
  } catch {}
  console.log(`\n(6) OFF-LOG airs (last ${logn}): ${off} had no schedule row = ${logn?Math.round(off/logn*100):0}% off-log (operator loads + live-picks)`);

  // (7) BUDGET — attribute the current drift.
  const gpp = med(gains); const nSongsToDrift = ph && gpp>0 ? Math.round((ph.scheduled_at-now)/gpp) : NaN;
  console.log(`\n(7) DRIFT BUDGET (station ${sid}):`);
  console.log(`   • Density:  ${hms(overSum/Math.max(cnt,1))}/hr over 60 min  → ${overSum/Math.max(cnt,1)>60?'schedule over-packs; scheduled_at outruns wall-clock':'schedule ≈ real-time; density NOT the driver'}`);
  console.log(`   • Overlap:  ${hms(med(gains))}/song gained → ~${Number.isFinite(nSongsToDrift)?nSongsToDrift:'?'} songs would build the current ${ph?hms(ph.scheduled_at-now):'?'} drift`);
  console.log(`   • Off-log:  ${logn?Math.round(off/logn*100):0}% of airs off the log (skips/loads)`);
}
db.close();
console.log(`\nRead-only. Density>>60min/hr ⇒ Generate fix; drift from overlap/song ⇒ Phase 3 time-anchor; both ⇒ both.`);
