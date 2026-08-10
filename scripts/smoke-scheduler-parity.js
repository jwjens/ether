// PARITY FUZZ — scheduler-core vs the pre-Phase-3 picker (2026-08-10).
//   node scripts/smoke-scheduler-parity.js      (exit 0 = pass)
//
// Phase 3 made audiod/scheduler-core.js the AUTHORITY for clock-mode music selection in
// electron/main.js `_generateDayRows`. The promise is that nothing airs differently. This bench is
// the evidence for that promise: it runs both algorithms over thousands of randomised pools and
// states and asserts they choose the same song every time.
//
// The legacy algorithm below is a VERBATIM copy of `_legacyPickMusic` (electron/main.js), which is
// itself the pre-Phase-3 slot-walk logic lifted unchanged. Copying rather than importing is
// deliberate: main.js cannot be required outside Electron. If the two ever drift, this bench stops
// being evidence — so it must be re-synced whenever _legacyPickMusic changes, and both should be
// deleted together once the live differential has reported 0 for a week.
//
// Deterministic on purpose (seeded LCG, no Math.random): a fuzz failure has to be reproducible.
"use strict";
const path = require("path");
const core = require(path.join(__dirname, "..", "audiod", "scheduler-core.js"));

let seed = 20260810;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const ri = (n) => Math.floor(rnd() * n);

// ── verbatim legacy ──────────────────────────────────────────────────────────────────────────────
function lrpFallbackLegacy(candidates, usedSongIds, songLastTs) {
  const lrp = (s) => songLastTs.get(s.id) ?? (s.last_played_at || 0);
  const fresh = candidates.filter(s => !usedSongIds.has(s.id));
  const pool = fresh.length ? fresh : candidates;
  if (!pool.length) return null;
  return pool.reduce((a, b) => (lrp(b) < lrp(a) ? b : a));
}
function legacyPick(candidates, currentTs, win, used, maps) {
  for (const song of candidates) {
    if (used.usedSongIds.has(song.id)) continue;
    const lastSongTs = maps.songLastTs.get(song.id) ?? (song.last_played_at || 0);
    if (currentTs - lastSongTs < win.songRepeatMin * 60) continue;
    const titleKey = (song.title || '').trim().toLowerCase();
    if (titleKey) {
      const lastTitleTs = maps.titleLastTs.get(titleKey) ?? 0;
      if (used.usedTitles.has(titleKey) || (currentTs - lastTitleTs) < win.titleSepMin * 60) continue;
    }
    const lastArtistTs = song.artist_id ? (maps.artistLastTs.get(song.artist_id) || 0) : 0;
    const artistBlocked = used.usedArtistIds.has(song.artist_id) || (song.artist_id && (currentTs - lastArtistTs) < win.artistSepMin * 60);
    if (!artistBlocked) return song;
  }
  return lrpFallbackLegacy(candidates, used.usedSongIds, maps.songLastTs);
}

// ── randomised world ─────────────────────────────────────────────────────────────────────────────
const TITLES = ["Halo", "Drive", "Nightcall", "Halo", "Ocean", "Reset", "Drive", "Wander"];
const NOW = 1_754_000_000;

function makeCase() {
  const n = 1 + ri(12);
  const candidates = [];
  for (let i = 0; i < n; i++) {
    candidates.push({
      id: 1 + ri(30),                              // ids collide on purpose → duplicate candidates
      title: TITLES[ri(TITLES.length)],            // titles collide on purpose → title separation
      artist_id: rnd() < 0.15 ? null : 1 + ri(8),  // sometimes no artist at all
      artist_name: "A",
      duration_ms: 120000 + ri(120000),
      last_played_at: rnd() < 0.3 ? 0 : NOW - ri(400000),
    });
  }
  const used = { usedSongIds: new Set(), usedArtistIds: new Set(), usedTitles: new Set() };
  const maps = { songLastTs: new Map(), artistLastTs: new Map(), titleLastTs: new Map() };
  for (let i = 0; i < ri(5); i++) used.usedSongIds.add(1 + ri(30));
  for (let i = 0; i < ri(3); i++) used.usedArtistIds.add(1 + ri(8));
  for (let i = 0; i < ri(3); i++) used.usedTitles.add(TITLES[ri(TITLES.length)].toLowerCase());
  for (let i = 0; i < ri(8); i++) maps.songLastTs.set(1 + ri(30), NOW - ri(400000));
  for (let i = 0; i < ri(6); i++) maps.artistLastTs.set(1 + ri(8), NOW - ri(400000));
  for (let i = 0; i < ri(6); i++) maps.titleLastTs.set(TITLES[ri(TITLES.length)].toLowerCase(), NOW - ri(400000));
  const win = {
    songRepeatMin: [0, 60, 180, 360][ri(4)],
    artistSepMin:  [0, 15, 60, 120][ri(4)],
    titleSepMin:   [0, 30, 120, 240][ri(4)],
  };
  return { candidates, used, maps, win };
}

const N = 20000;
let mismatches = 0;
const firstFew = [];

for (let k = 0; k < N; k++) {
  const { candidates, used, maps, win } = makeCase();
  const legacy = legacyPick(candidates, NOW, win, used, maps);

  const state = {
    usedSongIds: used.usedSongIds, usedArtistIds: used.usedArtistIds, usedTitles: used.usedTitles,
    songLastTs: maps.songLastTs, artistLastTs: maps.artistLastTs, titleLastTs: maps.titleLastTs,
    spinsByCategory: new Map(),
  };
  const r = core.pickForCategory(1, candidates, NOW, state, win, 9);

  const a = legacy ? legacy.id : null;
  const b = r.song ? r.song.id : null;
  if (a !== b) {
    mismatches++;
    if (firstFew.length < 3) firstFew.push({ case: k, legacy: a, core: b, win, pool: candidates.map(c => c.id) });
  }
}

console.log(`Fuzzed ${N} randomised pools/states against the pre-Phase-3 picker.`);
if (mismatches === 0) {
  console.log("PASS  scheduler-core and the legacy picker agree on every case (0 mismatches)");
  console.log("      → clock-driven mode is behaviour-identical; nothing airs differently.");
} else {
  console.log(`FAIL  ${mismatches}/${N} mismatches`);
  for (const f of firstFew) console.log("      " + JSON.stringify(f));
}
process.exit(mismatches === 0 ? 0 : 1);
