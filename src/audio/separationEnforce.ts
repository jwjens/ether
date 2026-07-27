// src/audio/separationEnforce.ts — renderer (in-process cold-stage twin) port of the enforced-separation
// picker. FAITHFUL PARALLEL of electron/separation-enforce.js `pickEnforced` — the codebase keeps
// runtime-parallel impls rather than crossing the electron↔renderer boundary (cf. electron/levels-scope.js
// ↔ src/lib/levelsScope.ts). Keep the two in lockstep; the shared algorithm is proven in
// scripts/prove-separation-enforce.js. Pure (no DB / no IO) — the caller supplies candidates + rest maps.
//
// Order the ELIGIBLE pool (all rest windows satisfied) by least-recently-played and pick the most-rested;
// only when NO candidate is eligible RELAX by shortest overage (closest to rested), tie-break LRP, and flag
// relaxed:true so the caller can log a loud separation-relaxed event. Never returns null while a candidate
// exists → never dead air. Song window = no_repeat_hours (hours) when set, else station song_separation_min.

export interface RestMaps {
  restByFile: Map<string, number>;
  restByArtist: Map<number, number>;
  restByTitle: Map<string, number>;
  songLastTs: Map<number, number>;
  artistLastTs: Map<number, number>;
  titleLastTs: Map<string, number>;
}
export interface SepWin { songRepeatMin: number; artistSepMin: number; titleSepMin: number; }
export interface UsedSets { usedSongIds: Set<number>; usedArtistIds: Set<number>; usedTitles: Set<string>; }
export interface PickResult { picked: any; relaxed: boolean; overageSec: number; rule: string | null; }

export function pickEnforced(
  candidates: any[], cursorTs: number, maps: RestMaps, win: SepWin, used: UsedSets,
  fitTargetTs: number | null = null, defaultDurS = 240,
): PickResult | null {
  if (!candidates || !candidates.length) return null;
  const { restByFile, restByArtist, restByTitle, songLastTs, artistLastTs, titleLastTs } = maps;
  const artistWin = win.artistSepMin * 60, titleWin = win.titleSepMin * 60, songDefWin = win.songRepeatMin * 60;
  const maxN = (a: number | undefined, b: number | undefined) => Math.max(a || 0, b || 0);
  for (const s of candidates) {
    const tk = (s.title || "").trim().toLowerCase(); s.__tk = tk;
    s.__ls = maxN(restByFile.get(s.file_path), songLastTs.get(s.id));
    const la = s.artist_id ? maxN(restByArtist.get(s.artist_id), artistLastTs.get(s.artist_id)) : 0;
    const lt = tk ? maxN(restByTitle.get(tk), titleLastTs.get(tk)) : 0;
    const songWin = (s.no_repeat_hours != null ? s.no_repeat_hours * 3600 : songDefWin);
    const songOver = songWin - (cursorTs - s.__ls);
    const artOver = s.artist_id ? artistWin - (cursorTs - la) : -Infinity;   // -Infinity = no artist constraint
    const titOver = tk ? titleWin - (cursorTs - lt) : -Infinity;
    s.__songOver = songOver; s.__artOver = artOver; s.__titOver = titOver;    // per-rule overages
    s.__over = Math.max(songOver, artOver, titOver);
    s.__rule = (songOver >= artOver && songOver >= titOver) ? "song" : (artOver >= titOver ? "artist" : "title");
  }
  // LRP ROTATION (lockstep with electron/separation-enforce.js) — no rule ranked/scored in isolation. Walk
  // the pool least-recently-played first; the artist test skips a dominant artist until other artists (also
  // in LRP order) fill the gap, so the dominant artist lands only in the spaces. Never two same-artist
  // adjacent while any other artist is available.
  const ordered = candidates.slice().sort((a, b) => a.__ls - b.__ls);
  const artOk = (s: any) => s.__artOver <= 0 && !(s.artist_id && used.usedArtistIds.has(s.artist_id));
  const titOk = (s: any) => s.__titOver <= 0 && !(s.__tk && used.usedTitles.has(s.__tk));
  const songOk = (s: any) => s.__songOver <= 0 && !used.usedSongIds.has(s.id);
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
    return { picked: eligible[0], relaxed: false, overageSec: 0, rule: null };
  }
  // Thin library — keep the artist/title rotation intact; the dominant artist waits for a gap.
  const picked =
       ordered.find(s => artOk(s) && titOk(s))
    || ordered.find(s => artOk(s))
    || ordered.find(s => !(s.artist_id && used.usedArtistIds.has(s.artist_id)))
    || ordered[0];
  return { picked, relaxed: true, overageSec: Math.max(0, Math.round(picked.__songOver)), rule: picked.__rule };
}
