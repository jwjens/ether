// -- generate-core: Generate's hour walk, lifted out of main.js (Phase 1, 2026-08-11); since Phase 2 (2026-10-18) every
//    music slot is chosen by audiod/scheduler-core.js `pick`, the one pick ---------------------------------------------
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
// code — the 496 moved lines below remain byte-identical to the originals, except (2026-09-30) the five
// `file_key` basenames, which now use storedBasename: a stored Windows path on a Mac came back whole.
const { storedBasename } = require('./audio-library-index');

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

// Shared generation context: the station's rules, the one pick's timeline, spot statements, diagnostics.
//
// PHASE 2 (docs/scheduler-rotation-playout-design.md §3.2; Jeff GO 2026-10-18): the music in every slot is chosen by
// audiod/scheduler-core.js `pick` — the rules obeyed against what aired + the log on both sides, then the song that has
// waited longest, random only for an exact tie. Removed with it: the first-compliant ORDER BY RANDOM() walk, the
// least-recently-played fallback that broke rules to fill a slot, the enforce_separation switch and its second picker,
// the legacy differential, the goal-mode shadow planner, and the break "anchor-fit" that chose songs by length (3c: a
// break lands on time through Hour start and fill, never by bending the pick). A slot where nothing passes is
// UNSCHEDULED (content_class 'UNSCHEDULED', never aired) unless the station named a fallback category.
function _buildScheduleCtx(db, stationId) {
  const core = require('../audiod/scheduler-core.js');
  const rules = core.stationRules(db, stationId);
  // Clock is the master for spots: a spot_break slot pulls from its assigned SPOT category via
  // stmtSpotsByCategory (NULL spot_category_id = any active spot). Prepared defensively so a pre-v24
  // DB (no spot_category_id column) can't break generation — spot breaks just fall back to any spot.
  let stmtSpotsByCategory = null;
  try { stmtSpotsByCategory = db.prepare(SPOT_SELECT_BY_CATEGORY); } catch {}
  // Per-clock timed spot breaks (v26). Prepared defensively so a pre-v26 DB (no clock_breaks table)
  // can't break generation — if it can't prepare, break mode is simply inactive and every clock
  // generates via the sequential slot-walk.
  let stmtClockBreaks = null;
  try { stmtClockBreaks = db.prepare(`SELECT minute, spot_category_id, count FROM clock_breaks WHERE clock_id = ? AND deleted_at IS NULL ORDER BY minute, sort_order`); } catch {}
  const ctx = {
    db, core, rules, activeStationId: stationId, stmtSpotsByCategory, stmtClockBreaks,
    fallbackCat: core.fallbackCategory(db, stationId),
    // The timeline is built on the first hour generated, once the caller has said which window this run replaces
    // (planWindow). Rows of the log inside that window are about to be replaced, so they are not "the log on either
    // side"; everything outside it, and operator rows inside it, are.
    tl: null, replace: null, poolCache: new Map(),
    spotLastTs: new Map(), spotPlaysToday: new Map(), generatedRows: [],
    relaxed: [],                 // nothing is ever relaxed now; kept so callers' reports stay shaped the same
    unscheduled: [],             // { hour, ts, category_id, categoryCode, closest[] } — every slot no song could fill
    // A break that started more than the break tolerance from its minute (§3.7, 3c): visible, never fitted.
    breakDrift: [],
    // Why-nothing-filled diagnostics (surfaced to the operator so Generate never fails silently).
    diag: { noShowHours: new Set(), noClock: new Set(), emptyClocks: new Set(), emptyCats: new Set() },
    // CLOCK IS LAW (2026-07-21): read only LIVE (non-deleted) shows + slots.
    stmtShows: db.prepare(`SELECT id, start_hour, end_hour, clock_id FROM shows WHERE instr(days, ?) > 0 AND is_active = 1 AND station_id = ? AND deleted_at IS NULL ORDER BY CASE WHEN end_hour = 0 AND start_hour > 0 THEN 24 - start_hour WHEN end_hour = 0 OR end_hour = start_hour THEN 24 WHEN end_hour > start_hour THEN end_hour - start_hour ELSE 24 - start_hour + end_hour END ASC`),
    stmtSlots: db.prepare(`SELECT cs.position, cs.slot_type, cs.category_id, cs.song_id, cs.spot_type, cs.spot_category_id, cs.duration_min FROM clock_slots cs WHERE cs.clock_id = ? AND cs.deleted_at IS NULL ORDER BY cs.position`),
    // A slot that names ONE specific song: a clock slot pointing at a song the operator has since deleted must
    // resolve to nothing, not to the deleted song.
    stmtSongById: db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.file_path, s.file_key FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.id = ? AND s.deleted_at IS NULL`),
    stmtCatCode: db.prepare(`SELECT code, name FROM categories WHERE id = ?`),
  };
  /** The window this run replaces, [from, to) — every caller says it before generating. */
  ctx.planWindow = (from, to) => { ctx.replace = [from, to]; ctx.tl = null; };
  return ctx;
}

function _timeline(ctx, nowTs) {
  if (!ctx.tl) ctx.tl = ctx.core.loadTimeline(ctx.db, ctx.activeStationId, { beforeTs: nowTs, replace: ctx.replace });
  return ctx.tl;
}
function _pool(ctx, categoryId, hour) {
  const k = categoryId + '|' + hour;
  if (!ctx.poolCache.has(k)) {
    const rows = ctx.core.poolFor(ctx.db, categoryId, hour);
    if (!rows.length) ctx.diag.emptyCats.add(categoryId);
    ctx.poolCache.set(k, rows);
  }
  return ctx.poolCache.get(k);
}
/** THE ONE PICK for a music slot, then the station's fallback category if one is named. null = UNSCHEDULED. */
function _pickMusic(ctx, categoryId, ts, hour) {
  const tl = _timeline(ctx, Math.floor(Date.now() / 1000));
  let r = ctx.core.pick(_pool(ctx, categoryId, hour), ts, tl, ctx.rules);
  let usedCat = categoryId, viaFallback = false;
  if (!r.song && ctx.fallbackCat && ctx.fallbackCat !== categoryId) {
    const r2 = ctx.core.pick(_pool(ctx, ctx.fallbackCat, hour), ts, tl, ctx.rules);
    if (r2.song) { r = r2; usedCat = ctx.fallbackCat; viaFallback = true; }
  }
  if (r.song) ctx.core.commit(tl, r.song, ts);
  return { ...r, categoryId: usedCat, viaFallback };
}
function _catCode(ctx, id) { try { const c = ctx.stmtCatCode.get(id); return c ? (c.code || c.name || ('#' + id)) : ('#' + id); } catch { return '#' + id; } }
function _musicRow(ctx, r, slotCat, ts, durationS, clockId) {
  const s = r.song;
  return {
    scheduled_at: ts, song_id: s.id, title: s.title, artist: s.artist || '', file_key: s.file_path ? storedBasename(s.file_path) : (s.file || ''),
    duration_s: durationS, category_id: r.categoryId, clock_id: clockId,
    pick_reason: JSON.stringify({ m: 'one-pick', cat: r.categoryId, slotCat, lastAired: r.lastAired, passing: r.passing, ties: r.ties, fallback: r.viaFallback || undefined }),
  };
}
function _unscheduledRow(ctx, r, slotCat, ts, durationS, clockId, hour) {
  const code = _catCode(ctx, slotCat);
  const why = (r.closest || []).map(c => `${c.title}: ${c.rule} ${c.measuredMin}/${c.settingMin} min`).join('; ');
  ctx.unscheduled.push({ hour, ts, category_id: slotCat, categoryCode: code, closest: r.closest || [], fallbackTried: !!ctx.fallbackCat });
  return {
    scheduled_at: ts, song_id: null, title: `UNSCHEDULED — ${code}${why ? ' (' + why + ')' : ' (no song in the category)'}`, artist: '', file_key: '',
    duration_s: durationS, category_id: slotCat, clock_id: clockId, content_class: 'UNSCHEDULED',
    pick_reason: JSON.stringify({ m: 'unscheduled', cat: slotCat, closest: r.closest || [], pool: r.poolSize || 0, fallback: ctx.fallbackCat || null }),
  };
}

// ── TIME-SLICED YIELD (2026-08-06) ───────────────────────────────────────────────────────────────
// Yielding once per HOUR was not enough: one hour of picking could run seconds of solid CPU and an Electron main that
// does not return to the loop for that long stops pumping Windows messages → "(Not Responding)". This yields every
// ~60ms of work, inside the hour, wherever the picker loops over slots. It adds no state and no ordering.
const GEN_SLICE_MS = 60;
let _genSliceStart = 0;
async function _genMaybeYield() {
  if (Date.now() - _genSliceStart < GEN_SLICE_MS) return;
  await new Promise(r => setImmediate(r));
  _genSliceStart = Date.now();
}

async function _generateDayRows(dayBaseDate, ctx, minTs = 0, onlyHour = null) {
  const { stmtShows, stmtSlots, stmtSongById, stmtSpotsByCategory, stmtClockBreaks, spotLastTs, spotPlaysToday, activeStationId, generatedRows } = ctx;
  if (!ctx.replace) ctx.replace = [minTs, minTs + 86400];   // a caller that did not say: this day from minTs
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
    const hourEnd = hourStartTs + 3600;
    let currentTs = hourStartTs;
    const dayStr = _localDayStr(slotDate);

    // One music slot, by the one pick: a song, or an UNSCHEDULED row. Returns the seconds it takes.
    const placeMusic = (categoryId, ts, defaultDurS) => {
      const r = _pickMusic(ctx, categoryId, ts, h);
      if (r.song) {
        const d = r.song.duration_ms ? Math.round(r.song.duration_ms / 1000) : defaultDurS;
        generatedRows.push(_musicRow(ctx, r, categoryId, ts, d, show.clock_id));
        return d;
      }
      generatedRows.push(_unscheduledRow(ctx, r, categoryId, ts, defaultDurS, show.clock_id, h));
      return defaultDurS;
    };
    // Place a break's `count` spots back-to-back from its category (rotation + daily caps via the run-wide maps).
    const placeSpots = (spotCategoryId, count, ts) => {
      let cur = ts;
      for (let k = 0; k < (count || 1); k++) {
        if (cur >= hourEnd) break;
        const sp = _pickSpot(stmtSpotsByCategory, spotCategoryId, activeStationId, dayStr, spotLastTs, spotPlaysToday);
        if (!sp) break;
        spotLastTs.set(sp.id, cur);
        spotPlaysToday.set(dayStr + '|' + sp.id, (spotPlaysToday.get(dayStr + '|' + sp.id) || 0) + 1);
        const durationS = sp.length_sec || 30;
        generatedRows.push({ scheduled_at: cur, song_id: null, title: sp.title, artist: sp.advertiser || '', file_key: sp.file_path ? storedBasename(sp.file_path) : '', file_path: sp.file_path, duration_s: durationS, category_id: null, clock_id: show.clock_id, content_class: 'SPOT' });
        cur += durationS;
      }
      return cur;
    };

    // ── BREAK MODE (v26): a clock with timed spot breaks. Music fills to each break's minute in clock order; the break
    // starts after the song that reaches its minute (3c: never a song chosen for its length). A break that starts more
    // than the tolerance after its minute is a visible break-drift line. ──
    const breaks = stmtClockBreaks ? stmtClockBreaks.all(show.clock_id) : [];
    if (breaks.length > 0) {
      const musicSlots = slots.filter(s => s.slot_type === 'music' && s.category_id);
      let musicIdx = 0;
      const nextMusicSlot = () => (musicSlots.length ? musicSlots[musicIdx++ % musicSlots.length] : null);
      const TOL_S = 30;   // the break tolerance's starting value (§3.11); on air the alert uses the setting
      for (const brk of breaks.slice().sort((a, b) => (a.minute || 0) - (b.minute || 0))) {
        const target = hourStartTs + (brk.minute || 0) * 60;
        if (target >= hourEnd) break;
        while (currentTs < target) {
          await _genMaybeYield();
          const ms = nextMusicSlot(); if (!ms) break;
          currentTs += placeMusic(ms.category_id, currentTs, (ms.duration_min || 4) * 60);
        }
        if (currentTs >= hourEnd) break;
        const startTs = currentTs;
        currentTs = placeSpots(brk.spot_category_id, brk.count, currentTs);
        const driftSec = startTs - target;
        if (Math.abs(driftSec) > TOL_S) ctx.breakDrift.push({ hour: h, minute: brk.minute || 0, driftSec, direction: driftSec > 0 ? 'over' : 'under' });
      }
      while (currentTs < hourEnd) {
        await _genMaybeYield();
        const ms = nextMusicSlot(); if (!ms) break;
        currentTs += placeMusic(ms.category_id, currentTs, (ms.duration_min || 4) * 60);
      }
      continue;
    }

    for (const slot of slots) {
      await _genMaybeYield();                // keep main's message pump alive mid-hour
      if (currentTs >= hourEnd) break; // each hour is planned from its own :00 — no slot STARTS past :00
      const slotDurationS = (slot.duration_min || 4) * 60;
      // Pinned element: this slot plays ONE specific song/jingle/talk break (set by cart # in the scheduler). It is
      // the operator's choice and is placed as set; it goes on the timeline so the picks around it obey the rules.
      if (slot.song_id) {
        const pinned = stmtSongById.get(slot.song_id);
        if (pinned && pinned.file_path) {
          const durationS = pinned.duration_ms ? Math.round(pinned.duration_ms / 1000) : slotDurationS;
          generatedRows.push({ scheduled_at: currentTs, song_id: pinned.id, title: pinned.title, artist: pinned.artist_name || '', file_key: pinned.file_path ? storedBasename(pinned.file_path) : '', duration_s: durationS, category_id: slot.category_id, clock_id: show.clock_id });
          ctx.core.commit(_timeline(ctx, Math.floor(Date.now() / 1000)), { file: pinned.file_path, artist: pinned.artist_name, title: pinned.title }, currentTs);
          currentTs += durationS;
        } else { currentTs += slotDurationS; }
        continue;
      }
      // Spot break: the least-recently-aired eligible spot from the slot's SPOT category (clock is the master).
      if (slot.slot_type === 'spot_break') {
        const after = placeSpots(slot.spot_category_id, 1, currentTs);
        currentTs = after > currentTs ? after : currentTs + slotDurationS;   // no eligible spot → the slot's time passes
        continue;
      }
      if (slot.slot_type !== 'music' || !slot.category_id) { currentTs += slotDurationS; continue; }
      currentTs += placeMusic(slot.category_id, currentTs, slotDurationS);
    }
  }
}

// The slice clock lives here with the yield it drives; main.js resets it per day via this export.
function resetGenSlice() { _genSliceStart = Date.now(); }

module.exports = {
  buildScheduleCtx: _buildScheduleCtx,
  generateDayRows:  _generateDayRows,
  resetGenSlice,
  _test: { _genMaybeYield, _pickSpot, _localDayStr, GEN_SLICE_MS },
};
