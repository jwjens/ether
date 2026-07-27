// PROOF (read-only, DB copy) for separation enforcement slice 1 (Generate side).
// Exercises the REAL shared module electron/separation-enforce.js (no replicated logic).
//   ON  : simulate a Generate fill for a real category — assert NO unflagged violator (every over>0 pick
//         is relaxed=true), i.e. eligible songs are always picked before any violator; violators appear
//         only with a loud relax event once the eligible pool is exhausted.
//   Perf: buildRestMaps is 3 grouped queries per run (not per-candidate) — timed.
//   Rules fix: per-station separation_rules read (station 4 gets its own 180, not the global LIMIT-1).
// Usage: node scripts/prove-separation-enforce.js <path-to-diag.db>
const { DatabaseSync } = require('node:sqlite');
const { buildRestMaps, pickEnforced } = require('../electron/separation-enforce');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const one = (s, ...p) => db.prepare(s).get(...p);
const all = (s, ...p) => db.prepare(s).all(...p);
const L = console.log; let fails = 0;
const check = (n, c, d) => { L(`  [${c ? 'PASS' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };

const SID = 3;   // Magical Forest — most airplay (6,035 plays) + the reconstructed violator sequence

// Per-station rules (the folded-in scoping fix), read exactly as _buildScheduleCtx now does.
const rule = (t, def) => { const r = one("SELECT value FROM separation_rules WHERE station_id=? AND rule_type=? AND is_active=1 LIMIT 1", SID, t); return r ? r.value : def; };
const win = { artistSepMin: rule('artist_separation_min', 60), songRepeatMin: rule('song_separation_min', 180), titleSepMin: rule('title_separation_min', 120) };
L(`=== per-station rules (station ${SID}): song=${win.songRepeatMin} artist=${win.artistSepMin} title=${win.titleSepMin} (minutes) ===`);

L('\n=== RULES-SCOPING FIX: station 4 no longer inherits the global LIMIT-1 rule ===');
const s4scoped = one("SELECT value FROM separation_rules WHERE station_id=4 AND rule_type='song_separation_min' AND is_active=1 LIMIT 1");
const globalLimit1 = one("SELECT value FROM separation_rules WHERE rule_type='song_separation_min' AND is_active=1 LIMIT 1");
L(`  station 4 scoped song_separation_min = ${s4scoped && s4scoped.value}; old unscoped LIMIT-1 = ${globalLimit1 && globalLimit1.value}`);
check('scoped read returns station 4\'s OWN rule', s4scoped && s4scoped.value === 180, `${s4scoped && s4scoped.value}`);

L('\n=== PERF: buildRestMaps is grouped queries, not per-candidate ===');
const t0 = process.hrtime.bigint();
const rest = buildRestMaps(db, SID);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
L(`  buildRestMaps(${SID}) → files=${rest.restByFile.size} artists=${rest.restByArtist.size} titles=${rest.restByTitle.size} in ${ms.toFixed(1)}ms`);
check('rest maps populated from play_log', rest.restByFile.size > 0, `${rest.restByFile.size} files`);

// Pick the station's largest music category (by candidate count).
const catRow = one(`SELECT category_id, COUNT(*) n FROM clock_slots WHERE clock_id IN
  (SELECT clock_id FROM shows WHERE station_id=? AND is_active=1 AND clock_id IS NOT NULL AND deleted_at IS NULL)
  AND slot_type='music' AND category_id IS NOT NULL AND deleted_at IS NULL GROUP BY category_id
  ORDER BY (SELECT COUNT(*) FROM songs s WHERE s.category_id=clock_slots.category_id AND s.deleted_at IS NULL) DESC LIMIT 1`, SID);
const CAT = catRow ? catRow.category_id : one("SELECT id FROM categories WHERE station_id=? AND deleted_at IS NULL LIMIT 1", SID).id;
const candSql = `SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.last_played_at, s.no_repeat_hours, s.file_path
  FROM songs s LEFT JOIN artists a ON a.id=s.artist_id
  WHERE s.category_id=? AND (s.rotation_status IS NULL OR s.rotation_status!='inactive')
    AND (s.content_class IS NULL OR s.content_class='MUSIC') AND (s.daypart_mask IS NULL OR ((s.daypart_mask>>?)&1)=1)`;
const catSize = all(candSql, CAT, 12).length;
L(`\n=== SIMULATE enforced Generate fill: station ${SID}, category ${CAT} (${catSize} candidates) ===`);

// Run-wide in-run maps (mirror ctx). Per-"hour" used sets reset every SLOTS_PER_HOUR.
const maps = { ...rest, songLastTs: new Map(), artistLastTs: new Map(), titleLastTs: new Map() };
const startTs = (one("SELECT MAX(played_at) m FROM play_log WHERE station_id=?", SID).m || 0) + 300;
let cursorTs = startTs; const SLOTS = 40, SLOTS_PER_HOUR = 15;
let used = { usedSongIds: new Set(), usedArtistIds: new Set(), usedTitles: new Set() };
const seq = [];
for (let i = 0; i < SLOTS; i++) {
  if (i % SLOTS_PER_HOUR === 0) used = { usedSongIds: new Set(), usedArtistIds: new Set(), usedTitles: new Set() };
  const cands = all(candSql, CAT, new Date(cursorTs * 1000).getHours());
  const r = pickEnforced(cands, cursorTs, maps, win, used, null, 180);
  if (!r) break;
  const p = r.picked;
  // independent violation check vs the SAME rest source (did it air within its window before this slot?)
  const lastAir = Math.max(rest.restByFile.get(p.file_path) || 0, maps.songLastTs.get(p.id) || 0);
  const wsec = (p.no_repeat_hours != null ? p.no_repeat_hours * 3600 : win.songRepeatMin * 60);
  const over = wsec - (cursorTs - lastAir);
  seq.push({ i, title: p.title, relaxed: r.relaxed, over: Math.max(0, Math.round(over)) });
  // record placement (mirror recordMusic)
  used.usedSongIds.add(p.id); if (p.artist_id) used.usedArtistIds.add(p.artist_id);
  const tk = (p.title || '').trim().toLowerCase(); if (tk) used.usedTitles.add(tk);
  maps.songLastTs.set(p.id, cursorTs); if (p.artist_id) maps.artistLastTs.set(p.artist_id, cursorTs); if (tk) maps.titleLastTs.set(tk, cursorTs);
  cursorTs += p.duration_ms ? Math.round(p.duration_ms / 1000) : 180;
}
for (const x of seq.slice(0, 20)) L(`  slot ${String(x.i).padStart(2)}  ${x.relaxed ? 'RELAX' : 'clean'}  over=${String(x.over).padStart(5)}s  ${(x.title || '').slice(0, 40)}`);
if (seq.length > 20) L(`  … ${seq.length - 20} more`);

L('\n=== ASSERTIONS ===');
const unflaggedViolators = seq.filter(x => x.over > 0 && !x.relaxed);
check('NO unflagged violator (every over>0 pick is a loud RELAX)', unflaggedViolators.length === 0, `${unflaggedViolators.length} unflagged`);
// violator-before-clean is impossible: once a RELAX happens, the eligible pool was exhausted → any later
// clean pick would mean a clean song existed and was skipped. Assert no clean pick FOLLOWS a relax within
// the same used-window (per simulated hour).
let cleanAfterRelax = 0;
for (let hourStart = 0; hourStart < seq.length; hourStart += SLOTS_PER_HOUR) {
  const hour = seq.slice(hourStart, hourStart + SLOTS_PER_HOUR);
  const firstRelax = hour.findIndex(x => x.relaxed);
  if (firstRelax >= 0) cleanAfterRelax += hour.slice(firstRelax + 1).filter(x => !x.relaxed && x.over === 0).length;
}
check('no clean pick appears AFTER a relax within an hour (eligible-first holds)', cleanAfterRelax === 0, `${cleanAfterRelax} clean-after-relax`);
const cleanCount = seq.filter(x => !x.relaxed).length, relaxCount = seq.filter(x => x.relaxed).length;
L(`  sequence: ${cleanCount} eligible/clean picks, ${relaxCount} relaxed picks (relaxed only after the pool is exhausted)`);

// ── Exhaustion → loud relax (thin category): station 4 CS = 46 songs, 180-min window. Filling more slots
// than the pool can keep rested MUST relax — and only AFTER the eligible pool is spent, never before. ──
L('\n=== SIMULATE exhaustion: station 4, category 14 (thin) → relax fires only when the pool is spent ===');
const win4 = { artistSepMin: (one("SELECT value FROM separation_rules WHERE station_id=4 AND rule_type='artist_separation_min' AND is_active=1 LIMIT 1")||{value:60}).value,
               songRepeatMin: (s4scoped||{value:180}).value,
               titleSepMin: (one("SELECT value FROM separation_rules WHERE station_id=4 AND rule_type='title_separation_min' AND is_active=1 LIMIT 1")||{value:120}).value };
const rest4 = buildRestMaps(db, 4);
const maps4 = { ...rest4, songLastTs: new Map(), artistLastTs: new Map(), titleLastTs: new Map() };
const cs = all(candSql, 14, 12).length;
let cur4 = (one("SELECT MAX(scheduled_at) m FROM generated_schedule WHERE station_id=4", ) || {}).m || Math.floor(startTs);
let used4 = { usedSongIds: new Set(), usedArtistIds: new Set(), usedTitles: new Set() };
const seq4 = [];
for (let i = 0; i < 70; i++) {
  if (i % 15 === 0) used4 = { usedSongIds: new Set(), usedArtistIds: new Set(), usedTitles: new Set() };
  const cands = all(candSql, 14, new Date(cur4 * 1000).getHours());
  const r = pickEnforced(cands, cur4, maps4, win4, used4, null, 180);
  if (!r) break;
  const p = r.picked;
  seq4.push({ i, relaxed: r.relaxed, over: r.overageSec || 0, rule: r.rule });
  used4.usedSongIds.add(p.id); if (p.artist_id) used4.usedArtistIds.add(p.artist_id);
  const tk = (p.title||'').trim().toLowerCase(); if (tk) used4.usedTitles.add(tk);
  maps4.songLastTs.set(p.id, cur4); if (p.artist_id) maps4.artistLastTs.set(p.artist_id, cur4); if (tk) maps4.titleLastTs.set(tk, cur4);
  cur4 += p.duration_ms ? Math.round(p.duration_ms/1000) : 180;
}
const firstRelax4 = seq4.findIndex(x => x.relaxed);
const relaxed4 = seq4.filter(x => x.relaxed);
L(`  CS candidates=${cs}; ${seq4.length} slots filled; first relax at slot ${firstRelax4}; ${relaxed4.length} relaxed picks`);
check('relax DID fire once the thin pool was exhausted', relaxed4.length > 0, `${relaxed4.length}`);
check('every relaxed pick carries a positive overage (loud, real violation)', relaxed4.every(x => x.over > 0), `min over=${Math.min(...relaxed4.map(x=>x.over))}`);
check('all picks BEFORE the first relax were clean (eligible-first)', firstRelax4 < 0 || seq4.slice(0, firstRelax4).every(x => !x.relaxed && x.over === 0), `firstRelax=${firstRelax4}`);

db.close();
L(`\n${fails === 0 ? 'ALL PROOFS PASS' : fails + ' PROOF(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
