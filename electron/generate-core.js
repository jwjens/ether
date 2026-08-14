// -- generate-core: the picker, lifted out of main.js (Phase 1, 2026-08-11) ----------------------
//
// A PURE MOVE. Every line below is byte-identical to the version that lived in electron/main.js,
// with exactly ONE edit: _buildScheduleCtx takes `db` as its first argument instead of closing over
// the module-level connection.
//
// WHAT IT TOOK TO FIND THE REAL BOUNDARY. A first attempt moved only the obvious functions and the
// parity harness died on `_localDayStr is not defined`. A guessed list of suspects is not a
// dependency analysis: the block also needed the SPOT_SELECT constants and _pickSpot. The boundary
// here is the one a full free-identifier scan produced, where the ONLY name crossing out is `db`.
//
// THE _genSliceStart TRAP. GEN_SLICE_MS / _genSliceStart / _genMaybeYield move together because they
// are one mechanism: yielding every ~60ms INSIDE the hour is what stopped Generate freezing the UI
// in 4.4.156 (9f8c752). _generateDayChunked stays in main.js and used to reset that clock by writing
// the module-level variable; across a module boundary it cannot, so the reset is exported as
// resetGenSlice(). Drop that call and the clock starts at 0, the first comparison is enormous, and
// the picker yields on EVERY slot instead of every 60ms - slower, not broken, and silent.
//
// READ-ONLY. Nothing here writes: _placeJingles and _commitDayRows stayed in main.js beside the
// transaction that owns playout.
"use strict";

// main.js has these at module scope; an extracted module needs its own. They are imports, not moved
// code — the 496 moved lines below remain byte-identical to the originals.
const path = require('path');

// ── Spot rotation (clock spot_break slots → spots library) ────────────────────
// A spot_break clock slot pulls from the spots table: active, inside its date window, and —
// if the slot names a spot_type — matching that type (NULL slot.spot_type = any active spot).
// Picks the least-recently-aired eligible spot, honoring max_plays_day within the generation run.
// Per-clock spot_break slots filter the spots library by spot_type (NULL = any active spot).
const SPOT_SELECT = `SELECT id, title, advertiser, file_path, length_sec, last_played_at, max_plays_day
   FROM spots
   WHERE station_id = ? AND deleted_at IS NULL AND is_active = 1 AND file_path IS NOT NULL
     AND (? IS NULL OR spot_type = ?)
     AND (start_date IS NULL OR start_date = '' OR start_date <= ?)
     AND (end_date   IS NULL OR end_date   = '' OR end_date   >= ?)`;

// Station timed-break grid filters by the break's assigned spot CATEGORY (NULL = any active spot).
// Same column shape as SPOT_SELECT so _pickSpot/placement are identical for both paths.
const SPOT_SELECT_BY_CATEGORY = `SELECT id, title, advertiser, file_path, length_sec, last_played_at, max_plays_day
   FROM spots
   WHERE station_id = ? AND deleted_at IS NULL AND is_active = 1 AND file_path IS NOT NULL
     AND (? IS NULL OR spot_category_id = ?)
     AND (start_date IS NULL OR start_date = '' OR start_date <= ?)
     AND (end_date   IS NULL OR end_date   = '' OR end_date   >= ?)`;

function _localDayStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Least-recently-aired eligible spot for this day, or null if none. `stmt` is the prepared select
// (by spot_type for clock slots, or by category for grid breaks) and `filterValue` is the matching
// spot_type string / spot_category_id integer (NULL = any). Caller records the play. The rotation +
// daily-cap logic is identical regardless of how candidates were filtered.
function _pickSpot(stmt, filterValue, stationId, dayStr, spotLastTs, spotPlaysToday) {
  const f = (filterValue == null || filterValue === '') ? null : filterValue;
  const rows = stmt.all(stationId, f, f, dayStr, dayStr);
  let best = null, bestTs = Infinity;
  for (const sp of rows) {
    if (sp.max_plays_day && (spotPlaysToday.get(dayStr + '|' + sp.id) || 0) >= sp.max_plays_day) continue;
    const lastTs = spotLastTs.get(sp.id) ?? (sp.last_played_at || 0);
    if (lastTs < bestTs) { best = sp; bestTs = lastTs; }
  }
  return best;
}

// Shared generation context (prepared statements + separation rules + tracking maps).
function _buildScheduleCtx(db, stationId) {
  let artistSepMin = 60, songRepeatMin = 180, titleSepMin = 120;
  try {
    // PER-STATION separation rules (2026-07-27). Previously these read `... AND is_active=1 LIMIT 1` with
    // NO station_id, so a multi-station install picked some other station's rule at random (cross-station
    // bleed — e.g. station 4's 180-min song window silently became station 3's 120). loggen.sepConfig
    // already scopes by station; Generate must too — it is load-bearing for correct enforcement.
    const ar = db.prepare("SELECT value FROM separation_rules WHERE station_id=? AND rule_type='artist_separation_min' AND is_active=1 LIMIT 1").get(stationId);
    if (ar) artistSepMin = ar.value;
    const sr = db.prepare("SELECT value FROM separation_rules WHERE station_id=? AND rule_type='song_separation_min' AND is_active=1 LIMIT 1").get(stationId);
    if (sr) songRepeatMin = sr.value;
    const tr = db.prepare("SELECT value FROM separation_rules WHERE station_id=? AND rule_type='title_separation_min' AND is_active=1 LIMIT 1").get(stationId);
    if (tr) titleSepMin = tr.value;
  } catch {}

  // ENFORCE-SEPARATION toggle (2026-07-27, slice 1) — per-station, station_config_kv key
  // 'enforce_separation'. Default OFF: absent/'0'/'false' = today's behavior (rest ignored at pick,
  // warn-only lint). ON = the LRP-from-play_log enforced picker (separation-enforce.pickEnforced). Opt-in
  // per station — turning it on reshapes that station's rotation, so the operator opts in and watches.
  let enforceSeparation = false;
  try {
    const t = db.prepare("SELECT value FROM station_config_kv WHERE key='enforce_separation' AND station_id=? AND deleted_at IS NULL").get(stationId);
    enforceSeparation = !!(t && (t.value === '1' || t.value === 'true'));
  } catch {}
  // Rest maps from play_log (the REAL airplay) — built ONCE per run, and ONLY when enforcing (the 2026-07-22
  // freeze precedent: never a per-candidate play_log query). songs.last_played_at is not used here.
  const { buildRestMaps } = require('./separation-enforce');
  const restMaps = enforceSeparation ? buildRestMaps(db, stationId) : { restByFile: new Map(), restByArtist: new Map(), restByTitle: new Map() };

  // ── PHASE 3 — scheduler mode + the pure engine (2026-08-10) ────────────────────────────────────
  // scheduler-core is now the AUTHORITY for clock-mode music selection. The legacy picker still runs
  // beside it (_legacyPickMusic) purely to prove they agree; see the differential in the slot walk.
  // 'goal' additionally runs the goal planner in SHADOW — logged, never aired.
  let schedulerMode = 'clock';
  try {
    const r = db.prepare("SELECT scheduler_mode FROM stations WHERE id=?").get(stationId);
    if (r && r.scheduler_mode === 'goal') schedulerMode = 'goal';
  } catch { /* pre-migration DB → 'clock' */ }
  const core = require('../audiod/scheduler-core.js');
  // Rotation goals, for goal-mode shadow only. Read once per run, never per slot.
  let goalCats = [];
  try {
    goalCats = db.prepare(
      "SELECT id, code, name, spins_per_hour AS spinsPerHour, priority FROM categories WHERE station_id=? AND deleted_at IS NULL"
    ).all(stationId);
  } catch {}
  // Clock is the master for spots: a spot_break slot pulls from its assigned SPOT category via
  // stmtSpotsByCategory (NULL spot_category_id = any active spot). Prepared defensively so a pre-v24
  // DB (no spot_category_id column) can't break generation — spot breaks just fall back to any spot.
  let stmtSpotsByCategory = null;
  try { stmtSpotsByCategory = db.prepare(SPOT_SELECT_BY_CATEGORY); } catch {}
  // Per-clock timed spot breaks (v26). Prepared defensively so a pre-v26 DB (no clock_breaks table)
  // can't break generation — if it can't prepare, break mode is simply inactive and every clock
  // generates via the unchanged sequential slot-walk.
  let stmtClockBreaks = null;
  try { stmtClockBreaks = db.prepare(`SELECT minute, spot_category_id, count FROM clock_breaks WHERE clock_id = ? AND deleted_at IS NULL ORDER BY minute, sort_order`); } catch {}
  return {
    activeStationId: stationId, artistSepMin, songRepeatMin, titleSepMin, stmtSpotsByCategory, stmtClockBreaks,
    enforceSeparation, restByFile: restMaps.restByFile, restByArtist: restMaps.restByArtist, restByTitle: restMaps.restByTitle,
    // Phase 3
    schedulerMode, core, goalCats,
    coreDiff: { agree: 0, differ: 0, skipped: 0, errors: 0, samples: [], lastError: null },
    goalShadow: { hours: 0, positions: 0, wouldDiffer: 0, samples: [] },
    songLastTs: new Map(), artistLastTs: new Map(), titleLastTs: new Map(),
    spotLastTs: new Map(), spotPlaysToday: new Map(), generatedRows: [], relaxed: [],
    // Anchor-fit (v4.4.84): breaks whose fitted landing still misses the target minute by > tolerance —
    // surfaced as a health signal so an un-fittable anchor (e.g. a category of only long songs) is visible,
    // never silent. { hour, minute, driftSec (+late/−early), direction }.
    breakDrift: [],
    // Why-nothing-filled diagnostics (surfaced to the operator so Generate never fails silently).
    diag: { noShowHours: new Set(), noClock: new Set(), emptyClocks: new Set(), emptyCats: new Set() },
    // CLOCK IS LAW (2026-07-21): read only LIVE (non-deleted) shows + slots — the same view the on-format
    // guard (loggen.getFormatCategoryIds) and the clock UI use. A re-categorized clock soft-deletes its old
    // slots; without this filter Generate walked the dead slots too and placed off-clock rows (OF: 52%
    // cat-1 "catch-all" from deleted slots the clock no longer has). See docs/log-reader-of-preflip.
    stmtShows: db.prepare(`SELECT id, start_hour, end_hour, clock_id FROM shows WHERE instr(days, ?) > 0 AND is_active = 1 AND station_id = ? AND deleted_at IS NULL ORDER BY CASE WHEN end_hour = 0 AND start_hour > 0 THEN 24 - start_hour WHEN end_hour = 0 OR end_hour = start_hour THEN 24 WHEN end_hour > start_hour THEN end_hour - start_hour ELSE 24 - start_hour + end_hour END ASC`),
    stmtSlots: db.prepare(`SELECT cs.position, cs.slot_type, cs.category_id, cs.song_id, cs.spot_type, cs.spot_category_id, cs.duration_min FROM clock_slots cs WHERE cs.clock_id = ? AND cs.deleted_at IS NULL ORDER BY cs.position`),
    // `s.deleted_at IS NULL` — THE CANDIDATE POOL USED TO INCLUDE DELETED SONGS (fixed 2026-08-13).
    // stmtShows and stmtSlots directly above both filtered it; this, the query that actually chooses
    // what airs, did not. Two songs deleted 2026-07-20 still held 63 future slots on halloVeen, and
    // across the library 28 deleted songs held 729 future rows with 438 plays logged AFTER their own
    // delete timestamps. The delete worked every time — the picker simply never looked.
    stmtCandidates: db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.last_played_at, s.no_repeat_hours, s.file_path FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.deleted_at IS NULL AND s.category_id = ? AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive') AND (s.content_class IS NULL OR s.content_class = 'MUSIC') AND (s.daypart_mask IS NULL OR ((s.daypart_mask >> ?) & 1) = 1) ORDER BY RANDOM()`),
    // Same rule for a slot that names ONE specific song: a clock slot pointing at a song the
    // operator has since deleted must resolve to nothing, not to the deleted song.
    stmtSongById: db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.file_path FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.id = ? AND s.deleted_at IS NULL`),
  };
}

// ── PHASE 3 DIFFERENTIAL COMPARATOR (2026-08-10) ─────────────────────────────────────────────────
// The pre-Phase-3 music selection, lifted VERBATIM out of the _generateDayRows slot walk and made
// side-effect free. scheduler-core is the authority now; this exists solely so every pick can be
// checked against what the old code would have chosen, on the SAME candidates array.
//
// Both are deterministic over a given array — the randomness lives in `ORDER BY RANDOM()` inside
// stmtCandidates, which runs ONCE per slot and feeds both. So the expected divergence is exactly
// zero, and any non-zero result is a real defect rather than a tie-break artifact.
//
// DELETE THIS, and the differential block that calls it, once a week of generation reports 0 diffs.
// Until then it is the only thing standing between "the engine is equivalent" and "we assume so".
function _legacyPickMusic(candidates, currentTs, win, used, maps) {
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
    if (!artistBlocked) return { song, relaxed: false };            // Tier 1
  }
  const song = _lrpFallback(candidates, used.usedSongIds, maps.songLastTs);   // Tier 2/3
  return { song: song || null, relaxed: !!song };
}

function _lrpFallback(candidates, usedSongIds, songLastTs) {
  const lrp = (s) => songLastTs.get(s.id) ?? (s.last_played_at || 0);
  const fresh = candidates.filter(s => !usedSongIds.has(s.id));
  const pool = fresh.length ? fresh : candidates;   // Tier 2 (unused-this-hour) then Tier 3 (allow reuse)
  if (!pool.length) return null;
  return pool.reduce((a, b) => (lrp(b) < lrp(a) ? b : a));
}

// ── TIME-SLICED YIELD (2026-08-06) ───────────────────────────────────────────────────────────────
// Yielding once per HOUR was not enough. Measured on Jeff's install during a real week generate:
// main ran 0.96 cores for 240s with the window unresponsive in 1028 of 1039 samples and only TWO
// moments of recovery — ~100s apart, i.e. once per DAY, not the 168 times per-hour yielding should
// have produced. One hour of picking is ~4s of solid CPU, and an Electron main that does not return
// to the loop for that long stops pumping Windows messages → "(Not Responding)".
//
// A standalone Electron harness pinned the threshold: with setImmediate yields, 120ms and 500ms
// slices stayed 100% responsive; a 9s slice went unresponsive with a 6.8s stall. So the fix is not a
// different yield primitive (all three behave the same) and not a worker — it is yielding OFTEN
// ENOUGH. This yields every ~60ms of work, inside the hour, wherever the picker loops over slots.
// Picks are unchanged: the yield adds no state and no ordering, it only lets main breathe.
const GEN_SLICE_MS = 60;
let _genSliceStart = 0;
async function _genMaybeYield() {
  if (Date.now() - _genSliceStart < GEN_SLICE_MS) return;
  await new Promise(r => setImmediate(r));
  _genSliceStart = Date.now();
}

async function _generateDayRows(dayBaseDate, ctx, minTs = 0, onlyHour = null) {
  const { stmtShows, stmtSlots, stmtCandidates, stmtSongById, stmtSpotsByCategory, stmtClockBreaks, songLastTs, artistLastTs, titleLastTs, spotLastTs, spotPlaysToday, artistSepMin, songRepeatMin, titleSepMin, activeStationId, generatedRows } = ctx;
  for (let h = 0; h < 24; h++) {
    if (onlyHour !== null && h !== onlyHour) continue;
    const slotDate = new Date(dayBaseDate.getTime()); slotDate.setHours(h, 0, 0, 0);
    const jsDay = slotDate.getDay();
    const hourStartTs = Math.floor(slotDate.getTime() / 1000);
    if (hourStartTs < minTs) continue; // never regenerate an hour that has already aired
    const shows = stmtShows.all(String(jsDay), activeStationId);
    const show = shows.find(s => {
      if (s.end_hour === 0 || s.end_hour === s.start_hour) return h >= s.start_hour;
      if (s.end_hour > s.start_hour) return h >= s.start_hour && h < s.end_hour;
      return h >= s.start_hour || h < s.end_hour;
    });
    if (!show) { ctx.diag.noShowHours.add(h); continue; }
    if (!show.clock_id) { ctx.diag.noClock.add(h); continue; }
    const slots = stmtSlots.all(show.clock_id);
    if (!slots.length) { ctx.diag.emptyClocks.add(show.clock_id); continue; }
    const usedSongIds = new Set(), usedArtistIds = new Set(), usedTitles = new Set();
    // Phase 3: the shape scheduler-core expects, built as a VIEW over the generator's own maps —
    // same object references, not copies — so the engine reads exactly the state the slot walk sees.
    // pickForCategory does not commit (the walk below still owns every mutation), so nothing here
    // can drift out of step with the rows actually being written.
    const coreStateView = {
      usedSongIds, usedArtistIds, usedTitles,
      songLastTs, artistLastTs, titleLastTs,
      spinsByCategory: new Map(),      // clock mode ignores it; goal-mode shadow fills it per hour
    };
    const hourEnd = hourStartTs + 3600;
    let currentTs = hourStartTs;

    // ── BREAK MODE (v26): if this clock has timed spot breaks, anchor the hour by them and fill
    // music to time around them. A clock with NO breaks falls through to the unchanged sequential
    // slot-walk below (byte-identical prior behavior — no regression). ──
    const breaks = stmtClockBreaks ? stmtClockBreaks.all(show.clock_id) : [];
    if (breaks.length > 0) {
      const dayStr = _localDayStr(slotDate);
      const musicSlots = slots.filter(s => s.slot_type === 'music' && s.category_id);
      let musicIdx = 0;
      const nextMusicSlot = () => (musicSlots.length ? musicSlots[musicIdx++ % musicSlots.length] : null);
      // Select a song for a category at the cursor — SAME per-hour dedup + separation as the sequential
      // path; returns the row or null (does NOT record/push). fitTargetTs (anchor-fit, v4.4.84): when set,
      // choose among the FULLY-compliant candidates the one whose duration lands cursorTs closest to the
      // anchor (closest-fit); ties keep the existing random-candidate order. fit is a tiebreaker WITHIN the
      // compliant pool — it never airs a song that violates separation. Without fitTargetTs the behavior is
      // byte-identical (first compliant, then the LRP ladder).
      const selectMusic = (categoryId, cursorTs, fitTargetTs = null, defaultDurS = 240) => {
        const candidates = stmtCandidates.all(categoryId, h);
        if (!candidates.length) ctx.diag.emptyCats.add(categoryId);
        // PHASE 3 COVERAGE — break mode stays on this picker, deliberately. It implements ANCHOR
        // FITTING (fitTargetTs: gather every compliant song, take the one whose end lands nearest the
        // break anchor), which scheduler-core does not have. Routing it through the core would take
        // the first compliant song instead and move every spot break — a change to what airs, in the
        // one phase whose whole promise is that nothing does. Counted as skipped so the differential
        // reports its true coverage instead of implying the whole generator was compared.
        ctx.coreDiff.skipped++;
        // ENFORCE-SEPARATION (2026-07-27): LRP-order the eligible pool from play_log; violator only when the
        // pool is exhausted → loud separation-relaxed event. OFF path below is byte-identical to before.
        if (ctx.enforceSeparation) {
          const { pickEnforced } = require('./separation-enforce');
          const r = pickEnforced(candidates, cursorTs, ctx, { songRepeatMin, artistSepMin, titleSepMin }, { usedSongIds, usedArtistIds, usedTitles }, fitTargetTs, defaultDurS);
          if (r && r.relaxed) ctx.relaxed.push({ hour: h, title: r.picked.title, artist: r.picked.artist_name || '', category_id: categoryId, overageSec: r.overageSec, rule: r.rule });
          return r ? r.picked : null;
        }
        let picked = null;
        const compliant = fitTargetTs != null ? [] : null;   // collect all compliant only when fitting
        for (const song of candidates) {
          if (usedSongIds.has(song.id)) continue;
          const lastSongTs = songLastTs.get(song.id) ?? (song.last_played_at || 0);
          if (cursorTs - lastSongTs < songRepeatMin * 60) continue;
          const titleKey = (song.title || '').trim().toLowerCase();
          if (titleKey) {
            const lastTitleTs = titleLastTs.get(titleKey) ?? 0;
            if (usedTitles.has(titleKey) || (cursorTs - lastTitleTs) < titleSepMin * 60) continue;
          }
          const lastArtistTs = song.artist_id ? (artistLastTs.get(song.artist_id) || 0) : 0;
          const artistBlocked = usedArtistIds.has(song.artist_id) || (song.artist_id && (cursorTs - lastArtistTs) < artistSepMin * 60);
          if (artistBlocked) continue;
          if (fitTargetTs == null) { picked = song; break; }   // Tier 1: first fully compliant (unchanged)
          compliant.push(song);                                 // fit: gather the whole compliant pool
        }
        // Fit: pick the compliant song whose end lands closest to the anchor (strict < keeps the first/random
        // candidate on ties, preserving rotation).
        if (fitTargetTs != null && compliant.length) {
          let best = compliant[0], bestScore = Infinity;
          for (const s of compliant) {
            const d = s.duration_ms ? Math.round(s.duration_ms / 1000) : defaultDurS;
            const score = Math.abs(fitTargetTs - (cursorTs + d));
            if (score < bestScore) { bestScore = score; best = s; }
          }
          picked = best;
        }
        // Tier 2/3 ladder: no compliant pick → least-recently-played candidate (never random/soft).
        if (!picked) { picked = _lrpFallback(candidates, usedSongIds, songLastTs); if (picked) ctx.relaxed.push({ hour: h, title: picked.title, artist: picked.artist_name || '', category_id: categoryId }); }
        return picked;
      };
      const recordMusic = (picked, categoryId, ts, durationS) => {
        usedSongIds.add(picked.id);
        if (picked.artist_id) usedArtistIds.add(picked.artist_id);
        const pTitleKey = (picked.title || '').trim().toLowerCase();
        if (pTitleKey) { usedTitles.add(pTitleKey); titleLastTs.set(pTitleKey, ts); }
        songLastTs.set(picked.id, ts);
        if (picked.artist_id) artistLastTs.set(picked.artist_id, ts);
        generatedRows.push({ scheduled_at: ts, song_id: picked.id, title: picked.title, artist: picked.artist_name || '', file_key: picked.file_path ? path.basename(picked.file_path) : '', duration_s: durationS, category_id: categoryId, clock_id: show.clock_id });
      };
      // Place a break's `count` spots back-to-back from its category. Shared rotation/caps via
      // spotLastTs/spotPlaysToday (the run-wide maps) so a spot won't repeat until rotation cycles.
      // NULL spot_category_id = any active spot. Returns the advanced cursor.
      const placeBreak = (brk, ts) => {
        let cur = ts;
        for (let k = 0; k < (brk.count || 1); k++) {
          if (cur >= hourEnd) break;
          const sp = _pickSpot(stmtSpotsByCategory, brk.spot_category_id, activeStationId, dayStr, spotLastTs, spotPlaysToday);
          if (!sp) break;
          spotLastTs.set(sp.id, cur);
          spotPlaysToday.set(dayStr + '|' + sp.id, (spotPlaysToday.get(dayStr + '|' + sp.id) || 0) + 1);
          const durationS = sp.length_sec || 30;
          generatedRows.push({ scheduled_at: cur, song_id: null, title: sp.title, artist: sp.advertiser || '', file_key: sp.file_path ? path.basename(sp.file_path) : '', file_path: sp.file_path, duration_s: durationS, category_id: null, clock_id: show.clock_id, content_class: 'SPOT' });
          cur += durationS;
        }
        return cur;
      };
      // Anchor-fit (v4.4.84): treat break minutes as anchors and land songs so the break hits its minute.
      // TOL = on-time band; within a song-length of the anchor (WINDOW) the last pick(s) are duration-fit
      // toward the target (closest-fit), so the break lands near :M instead of at a random boundary. Earlier
      // fill stays normal LRP rotation. The nearest-boundary decision remains the hard floor — never worse
      // than before. A landing still outside TOL is stamped as a break-drift health signal (visible).
      const FIT_TOL_S = 15, FIT_WINDOW_S = 360;
      const anchors = breaks.slice().sort((a, b) => (a.minute || 0) - (b.minute || 0));
      for (const brk of anchors) {
        const target = hourStartTs + (brk.minute || 0) * 60;
        if (target >= hourEnd) break; // anchor at/after the top of the next hour never airs this hour
        let breakPlaced = false, breakStartTs = null;
        // Fill music until the boundary NEAREST the target (minute 0 => nothing to fill => exact top of hour).
        while (currentTs < target) {
          await _genMaybeYield();            // keep main's message pump alive mid-hour
          const ms = nextMusicSlot(); if (!ms) break;
          const slotDefaultDurS = (ms.duration_min || 4) * 60;
          // Final approach → duration-aware pick so the last song lands the break on its minute; before that,
          // normal first-compliant selection (rotation preserved).
          const fitting = (target - currentTs) <= FIT_WINDOW_S;
          const picked = selectMusic(ms.category_id, currentTs, fitting ? target : null, slotDefaultDurS);
          if (!picked) break;
          const durationS = picked.duration_ms ? Math.round(picked.duration_ms / 1000) : slotDefaultDurS;
          if (currentTs + durationS <= target) {
            recordMusic(picked, ms.category_id, currentTs, durationS); currentTs += durationS;
            continue;
          }
          // This song straddles the target — choose the NEAREST boundary (not forward-only):
          const gapBefore = target - currentTs;               // drop the break BEFORE this song
          const gapAfter  = (currentTs + durationS) - target;  // drop the break AFTER this song
          if (gapAfter < gapBefore) {
            recordMusic(picked, ms.category_id, currentTs, durationS); currentTs += durationS; // song, then break
          } else {
            breakStartTs = currentTs; currentTs = placeBreak(brk, currentTs); breakPlaced = true;  // break, then song
            recordMusic(picked, ms.category_id, currentTs, durationS); currentTs += durationS;
          }
          break;
        }
        if (!breakPlaced && currentTs < hourEnd) { breakStartTs = currentTs; currentTs = placeBreak(brk, currentTs); }
        // Honest break-drift signal: if the break's actual start still misses its minute by > tolerance,
        // record it (over = late, under = early) so an un-fittable anchor surfaces instead of drifting silently.
        if (breakStartTs != null) {
          const driftSec = breakStartTs - target;
          if (Math.abs(driftSec) > FIT_TOL_S) ctx.breakDrift.push({ hour: h, minute: brk.minute || 0, driftSec, direction: driftSec > 0 ? 'over' : 'under' });
        }
      }
      // Fill the remainder of the hour with music (last song may overrun :00 and is cut, same as sequential).
      while (currentTs < hourEnd) {
        await _genMaybeYield();              // keep main's message pump alive mid-hour
        const ms = nextMusicSlot(); if (!ms) break;
        const picked = selectMusic(ms.category_id, currentTs); if (!picked) break;
        const durationS = picked.duration_ms ? Math.round(picked.duration_ms / 1000) : (ms.duration_min || 4) * 60;
        recordMusic(picked, ms.category_id, currentTs, durationS); currentTs += durationS;
      }
      continue; // hour fully built in break mode — skip the sequential slot-walk
    }

    for (const slot of slots) {
      await _genMaybeYield();                // keep main's message pump alive mid-hour
      if (currentTs >= hourEnd) break; // hard top-of-hour: each hour starts fresh, no overflow past :00
      const slotDurationS = (slot.duration_min || 4) * 60;
      // Pinned element: this slot plays ONE specific song/jingle/talk break (set by cart # in the
      // scheduler). Place that exact element regardless of slot_type/category.
      if (slot.song_id) {
        const pinned = stmtSongById.get(slot.song_id);
        if (pinned && pinned.file_path) {
          const durationS = pinned.duration_ms ? Math.round(pinned.duration_ms / 1000) : slotDurationS;
          generatedRows.push({ scheduled_at: currentTs, song_id: pinned.id, title: pinned.title, artist: pinned.artist_name || '', file_key: pinned.file_path ? path.basename(pinned.file_path) : '', duration_s: durationS, category_id: slot.category_id, clock_id: show.clock_id });
          usedSongIds.add(pinned.id);
          if (pinned.artist_id) usedArtistIds.add(pinned.artist_id);
          songLastTs.set(pinned.id, currentTs);
          if (pinned.artist_id) artistLastTs.set(pinned.artist_id, currentTs);
          currentTs += durationS;
        } else { currentTs += slotDurationS; }
        continue;
      }
      // Spot break: pull the least-recently-aired eligible spot from the spots library.
      // Spot break: pull the least-recently-aired eligible spot from the slot's SPOT category
      // (clock is the master). NULL spot_category_id = any active spot.
      if (slot.slot_type === 'spot_break') {
        const dayStr = _localDayStr(slotDate);
        const sp = _pickSpot(stmtSpotsByCategory, slot.spot_category_id, activeStationId, dayStr, spotLastTs, spotPlaysToday);
        if (sp) {
          spotLastTs.set(sp.id, currentTs);
          spotPlaysToday.set(dayStr + '|' + sp.id, (spotPlaysToday.get(dayStr + '|' + sp.id) || 0) + 1);
          const durationS = sp.length_sec || slotDurationS;
          generatedRows.push({ scheduled_at: currentTs, song_id: null, title: sp.title, artist: sp.advertiser || '', file_key: sp.file_path ? path.basename(sp.file_path) : '', file_path: sp.file_path, duration_s: durationS, category_id: null, clock_id: show.clock_id, content_class: 'SPOT' });
          currentTs += durationS;
          continue;
        }
        // no eligible spot → fall through and advance time (silent gap)
      }
      if (slot.slot_type !== 'music' || !slot.category_id) { currentTs += slotDurationS; continue; }
      const candidates = stmtCandidates.all(slot.category_id, h);
      if (!candidates.length) ctx.diag.emptyCats.add(slot.category_id);
      let picked = null;
      let pickReason = null;      // Phase 4: set by the core branch below; null for enforce-separation
      if (ctx.enforceSeparation) {
        // ENFORCE-SEPARATION (2026-07-27): LRP-order eligible from play_log; relax only when exhausted (loud).
        const { pickEnforced } = require('./separation-enforce');
        const r = pickEnforced(candidates, currentTs, ctx, { songRepeatMin, artistSepMin, titleSepMin }, { usedSongIds, usedArtistIds, usedTitles }, null, slotDurationS);
        if (r) { picked = r.picked; if (r.relaxed) ctx.relaxed.push({ hour: h, title: r.picked.title, artist: r.picked.artist_name || '', category_id: slot.category_id, overageSec: r.overageSec, rule: r.rule }); }
        // enforce_separation uses pickEnforced, which scheduler-core does not implement. Counted as
        // SKIPPED rather than compared — a station reporting 100% agreement it never measured would
        // be the most dangerous number in this ledger.
        ctx.coreDiff.skipped++;
      } else {
        // ── PHASE 3 — scheduler-core is the AUTHORITY for clock-mode selection (2026-08-10) ───────
        // The 25-line inline ladder that stood here moved into audiod/scheduler-core.js, unchanged in
        // behaviour: same Tier-1 check order, same _lrpFallback with its strict-`<` tie rule, same
        // state updates. The engine is pure and unit-tested; this call site is now just plumbing.
        const win = { songRepeatMin, artistSepMin, titleSepMin };
        const r = ctx.core.pickForCategory(slot.category_id, candidates, currentTs, coreStateView, win, h);
        picked = r.song || null;
        // PHASE 4 — capture WHY, while the losing candidates still exist. Bounded on purpose: counts,
        // not a candidate dump, so a year of logs stays small.
        if (picked) {
          pickReason = JSON.stringify({
            m: 'clock', cat: slot.category_id, pool: r.poolSize,
            veto: r.vetoed, relax: r.relaxed,
          });
        }
        // The ladder bent → record it, exactly as the legacy branch did when it fell to _lrpFallback.
        if (picked && r.relaxed.length) ctx.relaxed.push({ hour: h, title: picked.title, artist: picked.artist_name || '', category_id: slot.category_id });

        // ── DIFFERENTIAL — the old picker runs on the SAME candidates array and must agree ────────
        // Both are deterministic over one array, and stmtCandidates (with its ORDER BY RANDOM()) runs
        // once and feeds both. Expected divergence is therefore EXACTLY ZERO; anything else is a real
        // behaviour change, not a tie-break artifact. Read-only: _legacyPickMusic mutates nothing.
        try {
          const legacy = _legacyPickMusic(candidates, currentTs, win,
            { usedSongIds, usedArtistIds, usedTitles }, { songLastTs, artistLastTs, titleLastTs });
          const a = picked ? picked.id : null, b = legacy.song ? legacy.song.id : null;
          if (a === b) ctx.coreDiff.agree++;
          else {
            ctx.coreDiff.differ++;
            if (ctx.coreDiff.samples.length < 25) {
              ctx.coreDiff.samples.push({ hour: h, ts: currentTs, categoryId: slot.category_id, core: a, legacy: b, poolSize: candidates.length, coreRelaxed: r.relaxed });
            }
          }
        } catch (e) { ctx.coreDiff.errors++; ctx.coreDiff.lastError = e.message; }
      }
      if (picked) {
        usedSongIds.add(picked.id);
        if (picked.artist_id) usedArtistIds.add(picked.artist_id);
        const pTitleKey = (picked.title || '').trim().toLowerCase();
        if (pTitleKey) { usedTitles.add(pTitleKey); titleLastTs.set(pTitleKey, currentTs); }
        songLastTs.set(picked.id, currentTs);
        if (picked.artist_id) artistLastTs.set(picked.artist_id, currentTs);
        const durationS = picked.duration_ms ? Math.round(picked.duration_ms / 1000) : slotDurationS;
        generatedRows.push({ scheduled_at: currentTs, song_id: picked.id, title: picked.title, artist: picked.artist_name || '', file_key: picked.file_path ? path.basename(picked.file_path) : '', duration_s: durationS, category_id: slot.category_id, clock_id: show.clock_id, pick_reason: pickReason });
        currentTs += durationS;
      } else { currentTs += slotDurationS; }
    }

    // ── PHASE 3 — GOAL-MODE SHADOW (2026-08-10) ─────────────────────────────────────────────────
    // Runs only when the station is set to 'goal'. Plans the SAME hour with rotation goals driving
    // the category choice, records what it WOULD have aired, and throws the plan away. The rows
    // written above — by clock mode — are what actually airs. Nothing here mutates them.
    //
    // Whole-hour (planHour) rather than per-slot, because a goal decision only means anything in the
    // context of the hour's running spin counts. Timing will drift from the real log wherever a spot
    // ran long; that is expected and irrelevant — this compares WHICH CATEGORY, not when.
    if (ctx.schedulerMode === 'goal' && !ctx.enforceSeparation) {
      try {
        const musicSlots = slots.filter(s => s.slot_type === 'music' && s.category_id);
        if (musicSlots.length) {
          const pools = new Map();
          for (const cid of new Set(musicSlots.map(s => s.category_id))) pools.set(cid, stmtCandidates.all(cid, h));
          const plan = ctx.core.planHour({
            slots: musicSlots.map((s, i) => ({ index: i, type: 'music', categoryId: s.category_id, durationS: (s.duration_min || 4) * 60 })),
            hourStartTs, hour: h,
            categories: ctx.goalCats,
            candidatesByCategory: pools,
            constraints: { songRepeatMin, artistSepMin, titleSepMin },
            state: ctx.core.createState(),     // fresh — the shadow must not read the live run's state
            mode: 'goal',
          });
          ctx.goalShadow.hours++;
          ctx.goalShadow.positions += plan.picks.length;
          for (const p of plan.picks) {
            if (p.categoryId !== p.slotCategoryId) {
              ctx.goalShadow.wouldDiffer++;
              if (ctx.goalShadow.samples.length < 25) {
                ctx.goalShadow.samples.push({ hour: h, slot: p.slotIndex, clockCategory: p.slotCategoryId, goalCategory: p.categoryId, reason: p.reason });
              }
            }
          }
        }
      } catch (e) { ctx.goalShadow.error = e.message; }   // a failed shadow never touches the log
    }
  }
}

// The slice clock lives here with the yield it drives; main.js resets it per day via this export.
function resetGenSlice() { _genSliceStart = Date.now(); }

module.exports = {
  buildScheduleCtx: _buildScheduleCtx,
  generateDayRows:  _generateDayRows,
  resetGenSlice,
  _test: { _legacyPickMusic, _lrpFallback, _genMaybeYield, _pickSpot, _localDayStr, GEN_SLICE_MS },
};
