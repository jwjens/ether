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
      // ANN EXCLUSION (2026-08-26). This map is keyed by TITLE and joins nothing, so every play_log
      // row reaches it whatever it was. Announcements now log as content_class='ANN'
      // (docs/announcements-in-the-log-investigation-2026-08-26.md), and an announcement titled the
      // same as a song would otherwise impose that song's title-separation rest — an announcement
      // silently resting a song is exactly the rotation effect announcements must never have. This
      // was the ONLY genuine rotation risk the play_log consumer audit found.
    for (const r of db.prepare(
      "SELECT LOWER(TRIM(title)) tk, MAX(played_at) m FROM play_log WHERE station_id=? AND deleted_at IS NULL AND title IS NOT NULL AND (content_class IS NULL OR content_class = 'MUSIC') GROUP BY LOWER(TRIM(title))").all(stationId))
      restByTitle.set(r.tk, r.m || 0);
  } catch { /* */ }
  return { restByFile, restByArtist, restByTitle };
}

// pickEnforced — the enforce_separation switch's second picker — is deleted (Phase 2, 2026-10-18): every pick is
// audiod/scheduler-core.js `pick`. What stays here is the editor's warning check (checkSeparation) and its rest maps.


// ── CHECK, not pick (Manual Log Editing / Fix 2, design §3 Layer 5) ─────────────────────────────
//
// The editor needs to WARN about a manual placement without refusing it. Returns [] when clean, else
// human-readable violations. NEVER throws, never blocks — the operator overrides and the log records
// that they did.
//
// TWO CORRECTIONS to the design doc's §4.3 snippet, both of which would have shipped a checker that
// silently never warned:
//
//   1. The snippet read `maps.artistLastTs` / `maps.songLastTs` / `maps.titleLastTs` and passed
//      `buildRestMaps(db, stationId)` as `maps`. buildRestMaps returns
//      `{restByFile, restByArtist, restByTitle}` — those three names do not exist on it, so every
//      lookup was `undefined` and the function returned [] every time. The *LastTs maps live on the
//      GENERATE RUN context (this-run placements), not on the rest maps.
//
//   2. Rest maps come from play_log — AIRED history. The case the design's own test C describes
//      ("move a track next to another by the same artist") is two rows in a FUTURE day that have not
//      aired, so play_log knows nothing about either. Checking only the rest maps could not warn on
//      the exact scenario the feature exists for.
//
// So the check reads BOTH: `neighbours` (the scheduled rows around the target time — the future) and
// the rest maps (what actually aired — the past). Same rule windows the generator uses, so a warning
// means what the generator means.
//
// Neighbour artist matching is by NAME, because generated_schedule stores `artist` as text and has no
// artist_id. Rest-map artist matching is by id. Both are reported; the name match is the one that
// fires for same-day edits.
function checkSeparation(row, atTs, ctx, win) {
  const out = [];
  if (!row || !ctx) return out;
  const w = win || {};
  const artistWin = (w.artistSepMin || 0) * 60;
  const titleWin  = (w.titleSepMin  || 0) * 60;
  const songWin   = (w.songRepeatMin || 0) * 60;
  const mins = (sec) => Math.max(1, Math.round(Math.abs(sec) / 60));
  const norm = (s) => String(s || '').trim().toLowerCase();

  const myArtist = norm(row.artist);
  const myTitle  = norm(row.title);

  // ── The future: other rows already in the log around this time ────────────────────────────────
  for (const n of (ctx.neighbours || [])) {
    if (!n || n.scheduled_at == null) continue;
    // Never compare a row against itself. uuid first (stable), then id.
    if (row.uuid && n.uuid && row.uuid === n.uuid) continue;
    if (row.id != null && n.id != null && row.id === n.id) continue;
    const gap = Math.abs(atTs - n.scheduled_at);
    if (songWin && row.song_id != null && n.song_id != null && row.song_id === n.song_id && gap < songWin) {
      out.push(`Same song scheduled ${mins(gap)} min away (rule: ${w.songRepeatMin} min)`);
      continue;                       // one violation per neighbour — the strongest one
    }
    if (artistWin && myArtist && norm(n.artist) === myArtist && gap < artistWin) {
      out.push(`Same artist "${n.artist}" ${mins(gap)} min away (rule: ${w.artistSepMin} min)`);
      continue;
    }
    if (titleWin && myTitle && norm(n.title) === myTitle && gap < titleWin) {
      out.push(`Same title "${n.title}" ${mins(gap)} min away (rule: ${w.titleSepMin} min)`);
    }
  }

  // ── The past: what actually aired (play_log), via the generator's own rest maps ────────────────
  const last = (m, k) => (m && k != null && k !== '' ? m.get(k) : undefined);
  const fileLast = last(ctx.restByFile, row.file_path);
  if (songWin && fileLast && atTs - fileLast < songWin && atTs >= fileLast) {
    out.push(`This song aired ${mins(atTs - fileLast)} min ago (rule: ${w.songRepeatMin} min)`);
  }
  const artLast = last(ctx.restByArtist, row.artist_id);
  if (artistWin && artLast && atTs - artLast < artistWin && atTs >= artLast) {
    out.push(`This artist aired ${mins(atTs - artLast)} min ago (rule: ${w.artistSepMin} min)`);
  }
  const titLast = last(ctx.restByTitle, myTitle);
  if (titleWin && titLast && atTs - titLast < titleWin && atTs >= titLast) {
    out.push(`This title aired ${mins(atTs - titLast)} min ago (rule: ${w.titleSepMin} min)`);
  }
  return out;
}

module.exports = { buildRestMaps, checkSeparation };
