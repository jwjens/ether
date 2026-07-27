// PROOF (read-only, DB copy) for separation enforcement slice 3 (TS TWIN). The renderer twin
// (src/audio/separationEnforce.ts) is a runtime-parallel port of the proven JS picker
// (electron/separation-enforce.js). This proves the port is BEHAVIORALLY IDENTICAL: over the same
// candidate pools + rest maps + advancing cursor, both pickers choose the SAME song at every slot.
// The compiled TS lives at scratchpad/separationEnforce.cjs (esbuild); pass its path as argv[3].
// Usage: node scripts/prove-separation-enforce-twin.js <diag.db> <separationEnforce.cjs>
const { DatabaseSync } = require('node:sqlite');
const jsMod = require('../electron/separation-enforce');            // proven JS
const tsMod = require(process.argv[3]);                            // compiled TS twin
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const one = (s, ...p) => db.prepare(s).get(...p);
const all = (s, ...p) => db.prepare(s).all(...p);
const L = console.log; let fails = 0;
const check = (n, c, d) => { L(`  [${c ? 'PASS' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };

const SID = 3;
const rule = (t, def) => { const r = one("SELECT value FROM separation_rules WHERE station_id=? AND rule_type=? AND is_active=1 LIMIT 1", SID, t); return r ? r.value : def; };
const win = { artistSepMin: rule('artist_separation_min', 60), songRepeatMin: rule('song_separation_min', 180), titleSepMin: rule('title_separation_min', 120) };
const rest = jsMod.buildRestMaps(db, SID);
const CAT = (one(`SELECT category_id FROM clock_slots WHERE clock_id IN (SELECT clock_id FROM shows WHERE station_id=? AND is_active=1 AND clock_id IS NOT NULL AND deleted_at IS NULL) AND slot_type='music' AND category_id IS NOT NULL AND deleted_at IS NULL LIMIT 1`, SID) || {}).category_id
  || one("SELECT id FROM categories WHERE station_id=? AND deleted_at IS NULL LIMIT 1", SID).id;
const candSql = `SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.no_repeat_hours, s.file_path
  FROM songs s LEFT JOIN artists a ON a.id=s.artist_id WHERE s.category_id=? AND (s.rotation_status IS NULL OR s.rotation_status!='inactive')
    AND (s.content_class IS NULL OR s.content_class='MUSIC') AND (s.daypart_mask IS NULL OR ((s.daypart_mask>>?)&1)=1)`;

L(`=== JS vs TS-twin pickEnforced — identical picks over ${'a'} simulated fill (station ${SID}, cat ${CAT}) ===`);
// Two independent map/used states so each picker mutates its OWN copy (pickEnforced mutates candidate rows).
const mk = () => ({ ...{ restByFile: rest.restByFile, restByArtist: rest.restByArtist, restByTitle: rest.restByTitle }, songLastTs: new Map(), artistLastTs: new Map(), titleLastTs: new Map() });
const mapsJs = mk(), mapsTs = mk();
const usedJs = { usedSongIds: new Set(), usedArtistIds: new Set(), usedTitles: new Set() };
const usedTs = { usedSongIds: new Set(), usedArtistIds: new Set(), usedTitles: new Set() };
let cur = (one("SELECT MAX(played_at) m FROM play_log WHERE station_id=?", SID).m || 0) + 300;
let mismatches = 0, n = 0, relaxes = 0;
for (let i = 0; i < 60; i++) {
  const hour = new Date(cur * 1000).getHours();
  // fresh candidate arrays per picker (rows are mutated with __ fields)
  const cj = all(candSql, CAT, hour), ct = all(candSql, CAT, hour);
  const rj = jsMod.pickEnforced(cj, cur, mapsJs, win, usedJs, null, 240);
  const rt = tsMod.pickEnforced(ct, cur, mapsTs, win, usedTs, null, 240);
  if (!rj && !rt) break;
  n++;
  const idJ = rj && rj.picked.id, idT = rt && rt.picked.id;
  if (idJ !== idT || (!!rj.relaxed !== !!rt.relaxed)) { mismatches++; if (mismatches <= 3) L(`  slot ${i}: JS=${idJ}(relax=${rj && rj.relaxed}) TS=${idT}(relax=${rt && rt.relaxed})`); }
  if (rj && rj.relaxed) relaxes++;
  // advance BOTH identically using the JS pick (they match, so equivalent)
  const p = rj.picked;
  usedJs.usedSongIds.add(p.id); usedTs.usedSongIds.add(p.id);
  if (p.artist_id) { usedJs.usedArtistIds.add(p.artist_id); usedTs.usedArtistIds.add(p.artist_id); }
  const tk = (p.title || '').trim().toLowerCase(); if (tk) { usedJs.usedTitles.add(tk); usedTs.usedTitles.add(tk); }
  mapsJs.songLastTs.set(p.id, cur); mapsTs.songLastTs.set(p.id, cur);
  if (p.artist_id) { mapsJs.artistLastTs.set(p.artist_id, cur); mapsTs.artistLastTs.set(p.artist_id, cur); }
  if (tk) { mapsJs.titleLastTs.set(tk, cur); mapsTs.titleLastTs.set(tk, cur); }
  cur += p.duration_ms ? Math.round(p.duration_ms / 1000) : 240;
}
L(`  compared ${n} slots; ${relaxes} relaxed; mismatches=${mismatches}`);
check('TS twin picks IDENTICALLY to the proven JS picker at every slot', mismatches === 0, `${mismatches}`);
check('simulation actually ran', n > 0, `${n} slots`);

db.close();
L(`\n${fails === 0 ? 'ALL PROOFS PASS' : fails + ' PROOF(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
