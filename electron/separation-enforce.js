'use strict';
// electron/separation-enforce.js — enforced-separation picker (2026-07-27, slice 1: Generate side).
//
// Pure, testable core shared by Generate (electron/main.js) and its proof
// (scripts/prove-separation-enforce.js). The daemon fill + the in-process TS twin reuse this in the
// follow-up slices.
//
// The rest source is play_log — the REAL airplay — pre-loaded ONCE per Generate run into in-memory maps
// by buildRestMaps, so the picker never runs a play_log subquery per-candidate-per-slot (the 2026-07-22
// main-loop-freeze precedent). songs.last_played_at is deliberately NOT used (populated ~54/530 and never
// written by the daemon airplay path — that mismatch is the "violator-before-clean" bug this slice fixes).

// Pre-load per-station last-air maps from play_log. Returns { restByFile, restByArtist, restByTitle }.
// Each maps an identity → the most recent played_at (unix seconds) on THIS station.
function buildRestMaps(db, stationId) {
  const restByFile = new Map(), restByArtist = new Map(), restByTitle = new Map();
  try {
    for (const r of db.prepare(
      "SELECT file_path, MAX(played_at) m FROM play_log WHERE station_id=? AND deleted_at IS NULL AND file_path IS NOT NULL GROUP BY file_path").all(stationId))
      restByFile.set(r.file_path, r.m || 0);
  } catch { /* empty play_log → all songs read as never-aired */ }
  try {
    for (const r of db.prepare(
      "SELECT s.artist_id aid, MAX(pl.played_at) m FROM play_log pl JOIN songs s ON s.file_path=pl.file_path WHERE pl.station_id=? AND pl.deleted_at IS NULL AND s.artist_id IS NOT NULL GROUP BY s.artist_id").all(stationId))
      restByArtist.set(r.aid, r.m || 0);
  } catch { /* */ }
  try {
    for (const r of db.prepare(
      "SELECT LOWER(TRIM(title)) tk, MAX(played_at) m FROM play_log WHERE station_id=? AND deleted_at IS NULL AND title IS NOT NULL GROUP BY LOWER(TRIM(title))").all(stationId))
      restByTitle.set(r.tk, r.m || 0);
  } catch { /* */ }
  return { restByFile, restByArtist, restByTitle };
}

// Pick ONE song for a category-fill slot with separation ENFORCED.
//   candidates: rows { id, title, artist_name, artist_id, duration_ms, file_path, no_repeat_hours }
//   cursorTs:   slot air time (unix seconds)
//   maps:       { restByFile, restByArtist, restByTitle, songLastTs, artistLastTs, titleLastTs }
//               restBy* = play_log (this run's starting truth); *LastTs = placements made earlier THIS run.
//   win:        { songRepeatMin, artistSepMin, titleSepMin }  — minutes
//   used:       { usedSongIds, usedArtistIds, usedTitles }    — per-hour dedup Sets
//   fitTargetTs/defaultDurS: anchor-fit (optional) — closest-duration tiebreak WITHIN the eligible pool.
//
// Behavior: order the ELIGIBLE pool (all rest windows satisfied) by least-recently-played and pick the
// most-rested; only when NO candidate is eligible does it RELAX — by SHORTEST overage (the pick closest to
// rested), tie-break LRP — and flag relaxed:true so the caller logs a loud separation-relaxed event. Never
// returns null while the category has any candidate → never dead air. Song window = no_repeat_hours (hours)
// when set, else the station song_separation_min. effective last-air = max(real airplay, this-run placement).
function pickEnforced(candidates, cursorTs, maps, win, used, fitTargetTs = null, defaultDurS = 240) {
  if (!candidates || !candidates.length) return null;
  const { restByFile, restByArtist, restByTitle, songLastTs, artistLastTs, titleLastTs } = maps;
  const artistWin = win.artistSepMin * 60, titleWin = win.titleSepMin * 60, songDefWin = win.songRepeatMin * 60;
  const maxN = (a, b) => Math.max(a || 0, b || 0);
  for (const s of candidates) {
    const tk = (s.title || '').trim().toLowerCase(); s.__tk = tk;
    s.__ls = maxN(restByFile.get(s.file_path), songLastTs.get(s.id));       // effective last-air (song)
    const la = s.artist_id ? maxN(restByArtist.get(s.artist_id), artistLastTs.get(s.artist_id)) : 0;
    const lt = tk ? maxN(restByTitle.get(tk), titleLastTs.get(tk)) : 0;
    const songWin = (s.no_repeat_hours != null ? s.no_repeat_hours * 3600 : songDefWin);
    const songOver = songWin - (cursorTs - s.__ls);                          // >0 = still resting on this rule
    const artOver  = s.artist_id ? artistWin - (cursorTs - la) : -Infinity;   // -Infinity = no artist constraint
    const titOver  = tk ? titleWin - (cursorTs - lt) : -Infinity;
    s.__songOver = songOver; s.__artOver = artOver; s.__titOver = titOver;     // per-rule overages
    s.__over = Math.max(songOver, artOver, titOver);
    s.__rule = (songOver >= artOver && songOver >= titOver) ? 'song' : (artOver >= titOver ? 'artist' : 'title');
  }
  // ── LRP ROTATION (2026-07-27) — NO rule is ranked or scored "least-bad in isolation". Walk the pool in
  // least-recently-played order and take the first candidate that keeps the most separation. Because the
  // ARTIST test (window + not-used-this-hour) skips a dominant artist until OTHER artists — also in LRP
  // order — have filled the gap, the dominant artist's tracks land only in the spaces between everyone
  // else's rotation. On CS (46 songs, 14 one artist) there is no reason to ever place two same-artist
  // adjacent, and this never does while any other artist is available. Song-repeat on a thin library is an
  // accepted consequence of rotation (the LRP order makes it the most-rested song), not a ranked decision.
  const ordered = candidates.slice().sort((a, b) => a.__ls - b.__ls);   // rotation backbone: most-overdue first
  const artOk  = s => s.__artOver <= 0 && !(s.artist_id && used.usedArtistIds.has(s.artist_id));  // artist rested + not this-hour
  const titOk  = s => s.__titOver <= 0 && !(s.__tk && used.usedTitles.has(s.__tk));
  const songOk = s => s.__songOver <= 0 && !used.usedSongIds.has(s.id);
  // Fully eligible (all windows satisfied, no this-hour dup) — the normal rotation pick.
  const eligible = ordered.filter(s => songOk(s) && artOk(s) && titOk(s));
  if (eligible.length) {
    if (fitTargetTs != null) {
      let best = eligible[0], bestScore = Infinity;
      for (const s of eligible) {
        const d = s.duration_ms ? Math.round(s.duration_ms / 1000) : defaultDurS;
        const sc = Math.abs(fitTargetTs - (cursorTs + d));
        if (sc < bestScore) { bestScore = sc; best = s; }
      }
      return { picked: best, relaxed: false, overageSec: 0, rule: null };
    }
    return { picked: eligible[0], relaxed: false, overageSec: 0, rule: null };   // LRP-first eligible
  }
  // Thin library — the song window can't be met. Keep the ARTIST/title rotation intact: take the most-
  // overdue (LRP-first) song whose artist is still available; the dominant artist waits for a gap. Only
  // when NO artist is available at all do we allow an artist repeat (never dead air).
  const picked =
       ordered.find(s => artOk(s) && titOk(s))                                        // rotate artists (song repeats)
    || ordered.find(s => artOk(s))                                                    // keep artist rotation
    || ordered.find(s => !(s.artist_id && used.usedArtistIds.has(s.artist_id)))       // at least not a this-hour artist dup
    || ordered[0];                                                                    // absolute last resort
  return { picked, relaxed: true, overageSec: Math.max(0, Math.round(picked.__songOver)), rule: picked.__rule };
}

module.exports = { buildRestMaps, pickEnforced };
