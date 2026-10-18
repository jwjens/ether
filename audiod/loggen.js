// audiod/loggen.js — daemon-side scheduler (Item 10). node:sqlite port of loggen.ts's fill.
//
// DESIGN LAW (Jeff): AUTO NEVER STOPS. The selector is a priority ladder that CANNOT return empty
// while the category has an active song — silence is never the fallback.
//   Tier 0: pre-generated log (generated_schedule), in order.
//   Tier 1: all rules satisfied — pick normally (clock categories in order, then on-format random).
//   Tier 2: compliant pool empty → relax soft rules, pick LEAST-RECENTLY-PLAYED (aired longest ago
//           first), working forward. Each relaxed pick is logged so the operator sees it.
//   Tier 3: absolute least-recently-played in the on-format categories, NO rules (daypart dropped).
//   Tier 3b: on-format set empty/misconfigured → LRP across ALL active songs, any category.
//
// SCOPE FIX: separation + LRP are evaluated against play_log for THIS station (station_id-scoped,
// real airplay) — NOT the shared songs.last_played_at column (which has no station_id, so it bled
// across stations, and which the daemon never even writes). This is the second bug under the dead air.
//
// RULES-OFF actually means off here: with no ACTIVE separation rule, Tier 1 applies no separation
// (it no longer silently falls back to a hidden 60-min default).

const showWindow = require("./show-window");   // the show schedule is the boundary (v65: shows start and end at any minute)

// ── Separation config — station-scoped, honors rules-off ──
// rulesOn = an ACTIVE artist-separation rule exists for this station. No active rule → separation OFF.
function sepConfig(db, stationId) {
  try {
    const rows = db.prepare("SELECT rule_type, value, is_active FROM separation_rules WHERE station_id = ?").all(stationId);
    const artist = rows.find(r => r.rule_type === "artist_separation_min");
    const rulesOn = !!(artist && artist.is_active);
    return { rulesOn, artistSepSec: rulesOn ? (artist.value || 60) * 60 : 0 };
  } catch { return { rulesOn: false, artistSepSec: 0 }; }
}

// ── Base conditions. opts toggles each soft rule so the ladder can relax tier by tier ──
//   opts.daypart      (default on)  — current-hour daypart mask
//   opts.songSep      (bool)        — per-song no_repeat_hours, station-scoped via play_log
//   opts.artistSepSec (seconds, >0) — artist separation, station-scoped via play_log
// rotation_status='inactive' is ALWAYS excluded (that song is deliberately out of rotation), so the
// "category has an active song" invariant is well-defined.
function baseConditions(hour, params, stationId, opts) {
  opts = opts || {};
  // content_class gate: MUSIC only. Jingles (JIN) / spots (SPOT) NEVER fill a music slot. IS NULL covers a
  // pre-v29 / partially-migrated row (post-migration the column defaults to 'MUSIC'). (jingles design 1b)
  // category gate: a MUSIC song with no category can NEVER air — every on-format read derives its
  // universe from clock_slots.category_id, so an uncategorised song is in no category and is dropped
  // by all of them. Placing one produces a row that sits pending forever.
  //
  // This belongs here rather than in each tier because pickTier applies its category filter only when
  // formatCats is non-empty ("formatCats [] = no category restriction") — so the LAST-DITCH tier, the
  // one that runs when the station has no usable categories, was the single path that could reach an
  // uncategorised song. Guarding baseConditions closes every tier at once.
  //
  // MUSIC ONLY, and that is the whole point: jingles and spots do not have categories and must not.
  // They are filed by jingle_category_id / spot_category_id, are selected by their own paths, and
  // never come through here — baseConditions is already MUSIC-gated on the line below.
  let c = "s.file_path IS NOT NULL AND s.category_id IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive') AND (s.content_class IS NULL OR s.content_class = 'MUSIC')";
  if (opts.daypart !== false) { c += " AND ((s.daypart_mask >> ?) & 1) = 1"; params.push(hour); }
  if (opts.songSep) {
    c += ` AND NOT EXISTS (SELECT 1 FROM play_log pl
             WHERE pl.file_path = s.file_path AND pl.station_id = ? AND pl.deleted_at IS NULL
               AND pl.played_at > (unixepoch() - COALESCE(s.no_repeat_hours, 3) * 3600))`;
    params.push(stationId);
  }
  if (opts.artistSepSec && opts.artistSepSec > 0) {
    c += ` AND (s.artist_id IS NULL OR s.artist_id NOT IN (
             SELECT s2.artist_id FROM play_log pl JOIN songs s2 ON s2.file_path = pl.file_path
             WHERE pl.station_id = ? AND pl.deleted_at IS NULL AND pl.played_at > (unixepoch() - ?)
               AND s2.artist_id IS NOT NULL
               AND (s2.content_class IS NULL OR s2.content_class = 'MUSIC')))`;
    params.push(stationId, opts.artistSepSec);
  }
  return c;
}

// ── Active show + its clock right now (loggen.ts getActiveShowClock) ──
function getActiveShowClock(db, stationId) {
  // To the minute (v65, audiod/show-window.js): at 21:15 a show running 15:00–21:30 is on, not the one starting 21:30.
  let rows = [];
  try { rows = db.prepare(`SELECT * FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?`).all(stationId); } catch { return null; }
  const s = showWindow.showAt(rows, Math.floor(Date.now() / 1000));
  return s ? { clockId: s.clock_id, showName: s.name } : null;
}

// ── On-format category universe (loggen.ts getFormatCategoryIds) — Christmas-leak fix ──
//
// PHASE 3 (2026-08-10) — goal mode widens this to the station's whole active category set.
//
// ⚠ READ BEFORE TOUCHING. This guard IS the Christmas-leak fix: an off-format category sitting in a
// DORMANT clock leaked into rotation via auto-fill, and the fix was to restrict the universe to the
// ACTIVE show's clock. Widening re-opens that door. It is gated on scheduler_mode='goal' precisely so
// it stays shut on every station that has not been deliberately switched — which today is all of them.
//
// It is also, as far as I can determine, currently unnecessary: scheduler-core's goal ranking is
// bounded to the hour's own clock categories ("never selects a category the clock's hour does not
// use", unit-tested), so a goal-chosen row is already on-format under the narrow query below. The
// widening is built because it was specified and because it must land with goal selection rather than
// after it — but if the goal shadow shows the engine never leaves the clock's categories, this should
// be reverted rather than left standing.
//
// This does NOT make the daemon goal-aware in the R3 sense: it reads a flag to size a filter, and
// still performs no goal ranking, scoring or selection of its own.
function getFormatCategoryIds(db, stationId, clockId) {
  try {
    let goalMode = false;
    try {
      const m = db.prepare("SELECT scheduler_mode FROM stations WHERE id = ?").get(stationId);
      goalMode = !!(m && m.scheduler_mode === 'goal');
    } catch { /* pre-migration DB → narrow (safe) behaviour */ }
    if (goalMode) return getStationCategoryIds(db, stationId);

    const rows = clockId
      ? db.prepare(`SELECT DISTINCT category_id FROM clock_slots
          WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?`).all(clockId, stationId)
      : db.prepare(`SELECT DISTINCT cs.category_id FROM clock_slots cs
          WHERE cs.slot_type = 'music' AND cs.category_id IS NOT NULL AND cs.deleted_at IS NULL AND cs.station_id = ?
            AND cs.clock_id IN (SELECT clock_id FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?)`).all(stationId, stationId);
    return rows.map(r => r.category_id).filter(c => c != null);
  } catch { return []; }
}

// ── This station's OWN category universe (the honest last-resort pool for Tier 3b) ──
// Every non-deleted category owned by the station. Used only when the on-format (clock-derived) set is
// empty/misconfigured: the fallback stays inside the STATION'S library instead of borrowing the whole
// account. A NULL-category orphan and any other station's songs are excluded by construction (their
// category_id is not in this list). Read-only; [] means the station has no categories at all.
function getStationCategoryIds(db, stationId) {
  try {
    return db.prepare("SELECT id FROM categories WHERE station_id = ? AND deleted_at IS NULL").all(stationId).map(r => r.id);
  } catch { return []; }
}

const SELECT = `SELECT s.id, s.title, a.name AS artist_name, s.file_path, s.file_key, s.duration_ms, s.intro_end, s.outro_start
  FROM songs s LEFT JOIN artists a ON a.id = s.artist_id`;
// NEVER PLAY A DELETED SONG (2026-08-13). Every candidate query in all three generators was missing
// this; 28 deleted songs held 729 future rows and 438 plays logged after their own deletes. Applied
// at each WHERE rather than folded into SELECT, because every caller supplies its own conditions.
const NOT_DELETED = `s.deleted_at IS NULL`;
const toItem = (r) => ({
  filePath: r.file_path, title: r.title, artist: r.artist_name || r.artist || "",
  durationMs: r.duration_ms || 0, introEnd: r.intro_end ?? undefined, outroStart: r.outro_start ?? undefined,
  scheduledAt: r.scheduled_at ?? undefined,
  fileKey: r.file_key ?? undefined,   // Slice B: lets the fill distinguish R2-only (prefetchable) from dead (no key)
  contentClass: r.content_class ?? undefined,   // MUSIC/SPOT — carried so the queue UI can gold-tint spots
});

// ── Priority 0: pre-generated log (local files only) ──
// FORMAT GATE (all four log readers below use this shape): a scheduled row airs on this station only if
// its joined song sits in an on-format category — OR the song JOIN is ABSENT (s.id IS NULL), which is a
// legacy/SPOT snapshot row that carries its own file_path/title on the generated_schedule row. The gate
// is `s.id IS NULL`, NOT `s.category_id IS NULL`: an ORPHAN song (row exists but category_id = NULL →
// belongs to no category → no station) must NOT pass. The old `s.category_id IS NULL` arm let a
// category-less orphan pass EVERY station's filter, which put a NULL-category "Munsters Theme" on air
// on a Christmas station, back-to-back (munsters-repeat-diagnosis-2026-07-26.md).
let _schedCursor = 0;
function resetScheduleCursor() { _schedCursor = 0; }

function readGeneratedSchedule(db, count, stationId) {
  const nowTs = Math.floor(Date.now() / 1000);
  const fmt = getFormatCategoryIds(db, stationId);
  const catClause = fmt.length ? `AND (s.id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
  const params = fmt.length ? [_schedCursor, stationId, nowTs, ...fmt, count] : [_schedCursor, stationId, nowTs, count];
  let rows;
  try {
    rows = db.prepare(
      `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, COALESCE(gs.file_key, s.file_key) AS file_key,
              COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start, gs.content_class,
              COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms
       FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
       WHERE gs.id > ? AND gs.station_id = ? AND gs.scheduled_at >= ? - 300 AND gs.deleted_at IS NULL
         AND (gs.content_class IS NULL OR gs.content_class NOT IN ('JIN','SWP')) ${catClause}
       ORDER BY gs.scheduled_at LIMIT ?`).all(...params);
  } catch { return []; }
  if (rows.length) _schedCursor = rows[rows.length - 1].row_id;
  return rows.filter(r => r.file_path);
}

// (fillFromHour — the top-of-hour hard cut's re-read from the hour boundary — was removed 2026-10-04
// with the cut. The new hour now joins after the crossing song through selectRowForNow's hour join.)

// ── Log-Reader Flip Phase 3 (§2.7): the TIME-ANCHORED playhead selector ───────────────────────────────
// Pure, read-only, deterministic (NO LLM). Given the wall clock, return the generated_schedule row that
// SHOULD be on air "now" — the decision the flip will act on and the shadow observes:
//   • BEHIND / ON-TIME: the LATEST still-`pending` music row whose slot has arrived
//     (scheduled_at <= now + slack) — i.e. the current slot. Any earlier still-`pending` rows are
//     `missed` (their slots elapsed because a song ran long / legacy aired something else); the flip
//     would stamp them `missed`, so the count is the reconciliation the flip would perform here.
//   • AHEAD: if NO pending row has arrived yet (all future beyond slack), the earliest pending row is
//     the play-early candidate — never wait, never dead-air (§2.7(b)).
//   • EXHAUSTED: no pending music rows at all — the emergency-floor condition (§2.6).
// JIN/SWP overlays are excluded (seam overlays, never a deck track), matching the daemon reader's
// content_class guard (loggen.readGeneratedSchedule). driftSec = now − chosen row's scheduled_at
// (positive = the chosen slot is in the past = running behind). Never throws.
// opts.asPending (Phase 1, 2026-10-18): a row id to treat as still pending — the engine's go-live shadow asks "what would
// you air now?" just after it has stamped the row that went live, and must ask it with that row still in the running.
//
// THE STATION NEVER RUNS AHEAD (Phase 3, Jeff 2026-10-18: "When nothing is due, the reader does NOT pull a future row; a
// short hour fills from its own clock. Automation started before the first log row waits for it."). Only rows of hours
// that have STARTED can be the row for now: `limitTs` is the end of the hour now is in (or of the hour the next seam is
// in, when the song on air runs past :00 — those rows start after :00, never early). The rule this replaces ("AHEAD:
// nothing has arrived — the earliest future pending row is the play-early candidate", Rider A) is what aired 3–5 PM rows
// in the morning on 10/17. Now that case is mode 'nothing-due', with the time the next row becomes due.
// UNSCHEDULED rows (Phase 2: a slot no song could fill) are never offered: they are not audio.
function _hourEnd(ts) { const d = new Date(ts * 1000); d.setMinutes(0, 0, 0); return Math.floor(d.getTime() / 1000) + 3600; }

// THE SHOW SCHEDULE IS THE BOUNDARY; THE LOG PLAYS AS BUILT (Jeff, 2026-10-18: "a show that ends at 1:30 automates until
// 1:30. Shows start and end at any minute. The log plays what the programmer built. No built-in fill, no catch-up
// drops."). Which show owns a moment: audiod/show-window.js.
//   • A LOG ROW IS ON AIR (opts.onAirRowId, else the row stamped 'playing' that is still inside its own length): the row
//     for now is the NEXT row in log order after it. Nothing is passed over for being late, nothing is filled. The one
//     wait is a show boundary: a row of a different show run (or of no show) does not start before its show's start
//     (mode 'nothing-due', nextDueTs = that start).
//   • NOTHING OF THE LOG IS ON AIR (automation just started, or the operator played something off the log): the row for
//     now is the latest row whose time has arrived INSIDE A SHOW THAT IS ON NOW — never a row of a show that has ended
//     (a show ending at 1:30 does not air at 1:45), never a row of a show that has not begun. Rows of today before it are
//     returned to be stamped 'missed': they passed while nothing of the log was on air.
// UNSCHEDULED rows (a slot no song could fill) and imaging are never offered: they are not deck audio.
// opts.asPending: a row id to treat as still pending (the engine's go-live shadow). Never throws.
function _activeShows(db, stationId) {
  try { return db.prepare("SELECT * FROM shows WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(stationId); } catch { return []; }
}
function _onAirRow(db, stationId, nowTs, slackSec, opts) {
  try {
    if (opts && opts.onAirRowId != null) return db.prepare("SELECT id, scheduled_at FROM generated_schedule WHERE id = ? AND station_id = ?").get(opts.onAirRowId, stationId) || null;
    if (opts && opts.onAirRowId === null) return null;   // the engine says: nothing of the log is on air
    const r = db.prepare(`SELECT id, scheduled_at, played_at, duration_s FROM generated_schedule WHERE station_id = ? AND state = 'playing' AND deleted_at IS NULL
        AND (content_class IS NULL OR content_class NOT IN ('JIN','SWP','UNSCHEDULED')) ORDER BY played_at DESC, id DESC LIMIT 1`).get(stationId);
    if (r && r.played_at != null && r.played_at + (r.duration_s || 0) + slackSec >= nowTs) return r;   // still inside its own length
  } catch {}
  return null;
}
function selectRowForNow(db, stationId, nowTs, slackSec = 60, opts = null) {
  try {
    const fmt = getFormatCategoryIds(db, stationId);
    const catClause = fmt.length ? `AND (s.id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
    const asP = opts && opts.asPending != null && Number.isInteger(Number(opts.asPending)) ? Number(opts.asPending) : null;
    const t = Math.max(nowTs, (opts && opts.seamTs) || nowTs);   // when the next row would start
    const base = `FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
                  WHERE gs.station_id = ? AND (gs.state = 'pending'${asP != null ? " OR gs.id = " + asP : ""}) AND gs.deleted_at IS NULL
                    AND (gs.content_class IS NULL OR gs.content_class NOT IN ('JIN','SWP','UNSCHEDULED')) ${catClause}`;
    const cols = `gs.id AS row_id, gs.title, gs.scheduled_at, COALESCE(gs.file_path, s.file_path) AS file_path`;
    const fmtP = fmt.length ? fmt : [];
    const shows = _activeShows(db, stationId);
    const pieceNow = showWindow.pieceAt(shows, t);
    const runNow = pieceNow.show ? pieceNow : null;   // a show owns this moment
    const onAir = _onAirRow(db, stationId, nowTs, slackSec, opts);
    if (onAir && (asP == null || asP !== onAir.id)) {
      // The next row in log order — but a row may only START inside its own piece: the hour, cut at show starts/ends.
      // A row whose piece has ended by the time it would start is not played (Jeff: "the last song before the top of the
      // hour is the last song for that hour"; a show ending at 1:30 automates until 1:30). The song on air finishes.
      let next = null;
      for (const c of db.prepare(`SELECT ${cols} ${base} AND (gs.scheduled_at > ? OR (gs.scheduled_at = ? AND gs.id > ?)) ORDER BY gs.scheduled_at, gs.id LIMIT 400`)
        .all(stationId, ...fmtP, onAir.scheduled_at, onAir.scheduled_at, onAir.id)) {
        if (showWindow.pieceAt(shows, c.scheduled_at).endTs > t) { next = c; break; }
      }
      if (!next) return { playRow: null, missedCount: 0, mode: "nothing-due", driftSec: 0, nextDueTs: null, inShow: !!runNow, onAirRowId: onAir.id };
      // The only wait: the next row is in the NEXT piece (a new hour, or a show starting or ending inside the hour) —
      // it starts at that piece's start, never before (silence after the hour's last song until the top of the hour).
      const a = showWindow.pieceAt(shows, onAir.scheduled_at), b = showWindow.pieceAt(shows, next.scheduled_at);
      const gateTs = a.key === b.key ? null : b.startTs;
      if (gateTs != null && t < gateTs) return { playRow: null, missedCount: 0, mode: "nothing-due", driftSec: 0, nextDueTs: gateTs, inShow: !!runNow, onAirRowId: onAir.id };
      const missedCount = db.prepare(`SELECT COUNT(*) AS n ${base} AND gs.scheduled_at < ? AND gs.scheduled_at >= ?`).get(stationId, ...fmtP, next.scheduled_at, _dayStart(nowTs)).n;
      const drift = t - next.scheduled_at;
      return { playRow: next, missedCount, mode: drift > slackSec ? "behind" : "on-time", driftSec: drift, onAirRowId: onAir.id, continuing: true };
    }
    // Nothing of the log on air: the latest arrived row of a show that is on now — or, when AUTO came on at the show's
    // start (opts.fromPieceStart), the piece's FIRST row: the first song of the hour is the first one scheduled.
    if (runNow && opts && opts.fromPieceStart) {
      const head = db.prepare(`SELECT ${cols} ${base} AND gs.scheduled_at >= ? AND gs.scheduled_at < ? ORDER BY gs.scheduled_at, gs.id LIMIT 1`)
        .get(stationId, ...fmtP, runNow.startTs, runNow.endTs);
      if (head && head.scheduled_at <= t + slackSec) return { playRow: head, missedCount: 0, mode: "on-time", driftSec: t - head.scheduled_at };
    }
    if (runNow) {
      const playRow = db.prepare(`SELECT ${cols} ${base} AND gs.scheduled_at >= ? AND gs.scheduled_at <= ? AND gs.scheduled_at < ? ORDER BY gs.scheduled_at DESC, gs.id DESC LIMIT 1`)
        .get(stationId, ...fmtP, runNow.startTs, t + slackSec, runNow.endTs);
      if (playRow) {
        const missedCount = db.prepare(`SELECT COUNT(*) AS n ${base} AND gs.scheduled_at < ? AND gs.scheduled_at >= ?`).get(stationId, ...fmtP, playRow.scheduled_at, _dayStart(nowTs)).n;
        const drift = t - playRow.scheduled_at;
        return { playRow, missedCount, mode: drift > slackSec ? "behind" : "on-time", driftSec: drift };
      }
    }
    // Nothing due: the next row, and when it may start — its piece's start (a later piece), or its own time.
    const next = db.prepare(`SELECT ${cols} ${base} AND gs.scheduled_at > ? ORDER BY gs.scheduled_at, gs.id LIMIT 1`).get(stationId, ...fmtP, t + slackSec);
    let nextDueTs = null;
    if (next) { const b = showWindow.pieceAt(shows, next.scheduled_at); nextDueTs = b.key === pieceNow.key ? next.scheduled_at : Math.max(b.startTs, t); }
    return { playRow: null, missedCount: 0, mode: "nothing-due", driftSec: 0, nextDueTs, inShow: !!runNow };
  } catch { return { playRow: null, missedCount: 0, mode: "error", driftSec: 0 }; }
}
function _dayStart(ts) { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); }

// ── THE PLAYOUT CHECK (design §3.8, Phase 3): before a log row is offered to air, it must pass every rule against what
// has AIRED on this station by now. Generate placed it under the rules; drift on air (songs longer or shorter than
// planned) can still bring it inside a rule. A row that fails is returned in `skip` with the rule; the engine stamps it
// 'skipped' (never 'missed': it was not passed over by the clock, it was refused) and the next row is checked.
function _playoutChecker(db, stationId, nowTs) {
  const core = require("./scheduler-core.js");
  const rules = core.stationRules(db, stationId);
  let maxMin = Math.max(rules.songMin || 0, rules.artistMin || 0, rules.titleMin || 0);
  try { const r = db.prepare("SELECT MAX(no_repeat_hours) h FROM songs WHERE deleted_at IS NULL").get(); if (r && r.h) maxMin = Math.max(maxMin, Number(r.h) * 60); } catch {}
  if (!(maxMin > 0)) return () => null;
  const tl = new core.Timeline(core.makeSplitter());
  try {
    for (const p of db.prepare(`SELECT pl.file_path, pl.played_at, COALESCE(s.title, pl.title) title, COALESCE(a.name, pl.artist) artist
        FROM play_log pl LEFT JOIN songs s ON s.file_path = pl.file_path AND s.deleted_at IS NULL LEFT JOIN artists a ON a.id = s.artist_id
       WHERE pl.station_id = ? AND pl.deleted_at IS NULL AND (pl.content_class IS NULL OR pl.content_class = 'MUSIC') AND pl.played_at > ? AND pl.played_at <= ?`)
      .all(stationId, nowTs - maxMin * 60, nowTs)) tl.add({ file: p.file_path, artist: p.artist, title: p.title }, p.played_at);
  } catch {}
  return (row) => core.breach(tl, { file: row.file_path || row.file_key, title: row.song_title || row.title, artist: row.song_artist || row.artist, noRepeatHours: row.no_repeat_hours }, nowTs, rules);
}

// ── Log-Reader Flip Phase 3 (ACTIVATION): the time-anchored read-through fill (§2.3 + §2.7) ────────────
// READ-ONLY. Returns the queue content (the row-for-now forward — a cache of log rows >= the playhead) +
// the skipped-past pending row ids to stamp 'missed' (BOUNDED TO THE CURRENT DAY, per the flip-activation
// ruling) + mode/drift. Rider A (AHEAD = never wait, never dead air): on 'ahead' the earliest FUTURE
// pending row is returned as the item to air early — items is never empty while any pending music row
// exists; only 'exhausted'/'error' returns no items, which the engine's emergency floor covers. The item
// shape matches loggen.fillQueue (schedId carried) so the daemon's proven preload/rotate/loadToDeck path
// consumes it unchanged. Never throws.
function readLogAnchored(db, stationId, count = 20, slackSec = 60, opts = null) {
  const nowTs = Math.floor(Date.now() / 1000);
  const seamTs = opts && opts.seamTs ? opts.seamTs : nowTs;
  const d = selectRowForNow(db, stationId, nowTs, slackSec, { seamTs, ...(opts && "onAirRowId" in opts ? { onAirRowId: opts.onAirRowId } : {}), ...(opts && opts.fromPieceStart ? { fromPieceStart: true } : {}) });
  if (!d.playRow) return { items: [], mode: d.mode, missedRowIds: [], skip: [], driftSec: 0, aheadBySec: 0, nextDueTs: d.nextDueTs ?? null, inShow: !!d.inShow };
  const anchorTs = d.playRow.scheduled_at;
  const fmt = getFormatCategoryIds(db, stationId);
  const catClause = fmt.length ? `AND (s.id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
  const fmtP = fmt.length ? fmt : [];
  const pendBase = `FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id LEFT JOIN artists a ON a.id = s.artist_id
    WHERE gs.station_id = ? AND gs.state = 'pending' AND gs.deleted_at IS NULL
      AND (gs.content_class IS NULL OR gs.content_class NOT IN ('JIN','SWP','UNSCHEDULED')) ${catClause}`;
  // MISSED (day-bounded): still-pending on-format rows scheduled TODAY, before the anchor — the flip
  // stamps these 'missed' at the boundary. Bounding to today prevents a first-boundary sweep of the
  // entire historical backlog (Phase 1 only stamped aired rows).
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const dayStart = Math.floor(d0.getTime() / 1000);
  let missedRowIds = [];
  try {
    missedRowIds = db.prepare(`SELECT gs.id AS row_id ${pendBase} AND gs.scheduled_at >= ? AND gs.scheduled_at < ? ORDER BY gs.scheduled_at`)
      .all(stationId, ...fmtP, dayStart, anchorTs).map(r => r.row_id);
  } catch { /* leave empty */ }
  // ITEMS: the row-for-now forward in log order, up to the next show boundary (a row of another show run, or of no
  // show, is offered only once its show has started — the next read offers it).
  const anchorId = d.playRow.row_id;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, COALESCE(gs.file_key, s.file_key) AS file_key,
              COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start, gs.content_class,
              COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms, s.title AS song_title, a.name AS song_artist, s.no_repeat_hours, gs.category_id
       ${pendBase} AND (gs.scheduled_at > ? OR (gs.scheduled_at = ? AND gs.id >= ?)) ORDER BY gs.scheduled_at, gs.id LIMIT ?`
    ).all(stationId, ...fmtP, anchorTs, anchorTs, anchorId, count);
  } catch {
    // An older or partial database (no artists table, no no_repeat_hours column): the same rows without the song's
    // own artist and rest. The playout check then measures on the row's own title and artist.
    try {
      rows = db.prepare(
        `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, COALESCE(gs.file_key, s.file_key) AS file_key,
                COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start, gs.content_class,
                COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms
         ${pendBase.replace(" LEFT JOIN artists a ON a.id = s.artist_id", "")} AND (gs.scheduled_at > ? OR (gs.scheduled_at = ? AND gs.id >= ?)) ORDER BY gs.scheduled_at, gs.id LIMIT ?`
      ).all(stationId, ...fmtP, anchorTs, anchorTs, anchorId, count);
    } catch { /* leave empty */ }
  }
  { // cut at the boundary
    const shows = _activeShows(db, stationId);
    const t = Math.max(nowTs, seamTs);
    const pA = showWindow.pieceAt(shows, anchorTs);
    const k = rows.findIndex(r => { const b = showWindow.pieceAt(shows, r.scheduled_at); return b.key !== pA.key && b.startTs > t; });
    if (k > 0) rows = rows.slice(0, k);
  }
  // THE PLAYOUT CHECK on the rows about to air: from the anchor forward, every music row that now breaks a rule against
  // what aired is refused, until one passes. Rows further on are checked when they come up.
  const skip = [];
  const fails = _playoutChecker(db, stationId, nowTs);
  while (rows.length) {
    const r0 = rows[0];
    if (r0.content_class && r0.content_class !== "MUSIC") break;          // spots and imaging are not songs
    const b = fails(r0);
    if (!b) break;
    skip.push({ rowId: r0.row_id, title: r0.title, categoryId: r0.category_id ?? null, rule: b.rule, measuredMin: b.measuredMin, settingMin: b.settingMin });
    rows.shift();
  }
  const items = rows.filter(r => r.file_path).map(r => ({ ...toItem(r), schedId: r.row_id }));
  // Rows the playout check refused, and nothing passed after them in this read: 'skipping' — the caller stamps them and
  // reads again. Never 'nothing-due' (that is a wait, and at no show it turns AUTO off).
  const inShow = !!showWindow.pieceAt(_activeShows(db, stationId), Math.max(nowTs, seamTs)).show;
  return { items, mode: items.length ? d.mode : (skip.length ? "skipping" : "nothing-due"), missedRowIds, skip, driftSec: d.driftSec, aheadBySec: 0, continuing: !!d.continuing, inShow,
    nextDueTs: items.length ? null : (d.nextDueTs ?? null) };
}

// ── AUTO-FITTER SUPPORT (2026-07-30) — the ELIGIBLE pool a fit may draw from ──────────────────────────
// The fitter never invents a pick: it size-matches against whatever this returns. Eligibility uses the
// SAME separation predicates as every other selection path (baseConditions + sepConfig, station-scoped
// via play_log), so a swap the fitter proposes cannot break separation — a fit that violates separation
// is not a fit. On-format only, MUSIC only, read-only, never throws.
//
// `categoryId` narrows to one category (an overshoot swap replaces like with like); omit it to draw from
// the whole on-format set (an undershoot fill, which the ruling says comes from the clock's current
// category — the caller passes that in).
function eligibleForFit(db, stationId, categoryId, limit = 200) {
  try {
    const hour = new Date().getHours();
    const cfg = sepConfig(db, stationId);
    const clock = getActiveShowClock(db, stationId);
    const fmt = getFormatCategoryIds(db, stationId, clock && clock.clockId);
    if (!fmt.length) return [];
    const params = [];
    const cond = baseConditions(hour, params, stationId, { daypart: true, songSep: true, artistSepSec: cfg.artistSepSec });
    const cats = (categoryId != null && fmt.includes(categoryId)) ? [categoryId] : fmt;
    const catClause = `AND s.category_id IN (${cats.map(() => "?").join(",")})`;
    const rows = db.prepare(`${SELECT} WHERE ${NOT_DELETED} AND (${cond}) ${catClause} LIMIT ?`).all(...params, ...cats, limit);
    return rows.filter(r => r.file_path && r.duration_ms > 0).map(toItem);
  } catch { return []; }
}
// ── JINGLES overlay v1: read the transition-attached JIN placement for the upcoming seam ──────────────
// The daemon is a LOG-READER (D1=A′): Generate placed JIN rows in generated_schedule bound to the seam
// (scheduled_at = the incoming music row's start). Given the currently-playing row's scheduled_at (afterTs)
// and the incoming row's scheduled_at (beforeTs), return the JIN placement bridging THIS seam — resolving
// the jingle's file via the songs join (like readGeneratedSchedule). excludeIds skips already-fired rows.
// Returns null on any miss / SQL error (never throws — a jingle miss never disturbs playout).
// KILL-SWITCH — re-ENABLED in v4.4.62 now the CART-exhaustion crash is fixed + PROVEN. History: the maiden
// jingle overlay (v4.4.59) played a CART source to natural end, tripping a latent Rust out-of-bounds
// (audio.rs:988 — DECK_LETTERS len 6 indexed at the CART slot 6) that killed the cpal output thread →
// permanent dead air; 4.4.61 stood jingles down (this flag false). v4.4.62 ships the audio.rs:988 guard
// (CART slot handled by its own "CART" key) and PROVED it off-air: `node scripts/test-cart-exhaustion.js`
// (isolated daemon, DB copy, muted) — CART plays to natural end, no panic, output thread alive (frames
// advancing), CART finished-flag set, station keeps rotating. ALL PASS. So jingles fire again. To disable
// again in an emergency, flip this to false (gates only the FIRE; Generate placement is harmless).
const JINGLES_ENABLED = true;

/**
 * AUTO-POST lookup — the placement that belongs to the song ALREADY PLAYING on a deck.
 *
 * readJingleForSeam (below) answers "what fires at the seam ahead of the outgoing deck", and arms
 * BEFORE the rotate. AUTO-POST cannot use it: the fire point is inside the incoming song, and an entry
 * armed before the rotate is cancelled BY the rotate — _jingleSuperseded treats an airGen bump, the
 * armed deck ceasing to play, and a deckGen change as supersession, and a rotate is all three at once.
 * That is Bug-A immunity working as designed, and it is not something to work around.
 *
 * So AUTO-POST arms AFTER the rotate instead, against the deck that is now playing. This finds its
 * placement by exact scheduled_at — _placeJingles writes the sweeper row at the incoming song's own
 * scheduled_at, so the song's slot IS the key. A window of +/- 1s absorbs the second-rounding between
 * a deck's stored schedule and the placement's.
 *
 * Returns null unless the placement asks for auto_post AND carries the numbers to do it, so a row
 * without them can never take this path.
 */
function readAutoPostForSong(db, stationId, songScheduledAt, excludeIds) {
  if (!JINGLES_ENABLED) return null;
  if (songScheduledAt == null) return null;
  const ex = Array.isArray(excludeIds) ? excludeIds.filter(n => Number.isFinite(n)) : [];
  const notIn = ex.length ? ` AND gs.id NOT IN (${ex.map(() => "?").join(",")})` : "";
  try {
    const row = db.prepare(
      `SELECT gs.id AS row_id, gs.scheduled_at, gs.title, gs.artist, gs.content_class,
              COALESCE(gs.file_path, s.file_path) AS file_path,
              COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms,
              gs.lead_in_sec, gs.jingle_category_id, gs.chain_type, gs.post_ms, gs.cut_end_ms
         FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
        WHERE gs.station_id = ? AND gs.content_class IN ('JIN','SWP') AND gs.deleted_at IS NULL
          AND gs.chain_type = 'auto_post'
          AND gs.scheduled_at >= ? AND gs.scheduled_at <= ?${notIn}
        ORDER BY gs.scheduled_at ASC LIMIT 1`)
      .get(stationId, songScheduledAt - 1, songScheduledAt + 1, ...ex);
    if (!row || !row.file_path) return null;
    if (row.post_ms == null || row.cut_end_ms == null) return null;   // cannot be timed → not this path
    return {
      rowId: row.row_id, filePath: row.file_path, title: row.title || "", artist: row.artist || "",
      durationMs: row.duration_ms || 0, scheduledAt: row.scheduled_at, contentClass: 'SWP',
      leadInSec: row.lead_in_sec != null ? row.lead_in_sec : 2,
      jingleCategoryId: row.jingle_category_id ?? null,
      chainType: 'auto_post', postMs: row.post_ms, cutEndMs: row.cut_end_ms,
    };
  } catch { return null; }
}

function readJingleForSeam(db, stationId, afterTs, beforeTs, excludeIds) {
  if (!JINGLES_ENABLED) return null;   // kill-switch — see comment above
  if (afterTs == null || beforeTs == null || beforeTs <= afterTs) return null;
  const ex = Array.isArray(excludeIds) ? excludeIds.filter(n => Number.isFinite(n)) : [];
  const notIn = ex.length ? ` AND gs.id NOT IN (${ex.map(() => "?").join(",")})` : "";
  try {
    const row = db.prepare(
      `SELECT gs.id AS row_id, gs.scheduled_at, gs.title, gs.artist, gs.content_class,
              COALESCE(gs.file_path, s.file_path) AS file_path,
              COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms,
              gs.lead_in_sec, gs.jingle_category_id
         FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
        WHERE gs.station_id = ? AND gs.content_class IN ('JIN','SWP') AND gs.deleted_at IS NULL
          AND gs.scheduled_at > ? AND gs.scheduled_at <= ?${notIn}
        ORDER BY gs.scheduled_at ASC LIMIT 1`).get(stationId, afterTs, beforeTs, ...ex);
    if (!row || !row.file_path) return null;
    const cls = row.content_class === 'SWP' ? 'SWP' : 'JIN';
    return {
      rowId: row.row_id, filePath: row.file_path, title: row.title || "", artist: row.artist || "",
      durationMs: row.duration_ms || 0, scheduledAt: row.scheduled_at, contentClass: cls,
      // Fallback only — lead_in_sec is written per row by _placeJingles from the category's LEAD
      // setting. One number, no class fork: SWP and JIN forked 2-vs-5, so the same seam timed
      // differently depending on a label. Must match SWEEPER_DEFAULT in electron/main.js.
      leadInSec: row.lead_in_sec != null ? row.lead_in_sec : 2,
      jingleCategoryId: row.jingle_category_id ?? null,
    };
  } catch { return null; }
}

// ── fillQueue: the queue for a station that is NOT on the log-reader flip (the legacy path) ───────────────────────────
// Tier 0 is the pre-generated log, in order. When the log has nothing, the queue is filled by THE ONE PICK
// (scheduler-core, Phase 2) from the active show's clock, slot by slot, under the station's rules against what aired —
// never by a second picker, never with a rule relaxed. The random-first ladder (Tiers 1–3b), the enforce_separation
// switch and its second picker that stood here are deleted. Nothing passes → fewer items (honest), `starved` when none.
function fillQueue(db, stationId, count = 12) {
  let sched = readGeneratedSchedule(db, count, stationId);
  if (!sched.length && _schedCursor > 0) { _schedCursor = 0; sched = readGeneratedSchedule(db, count, stationId); }
  if (sched.length) return { source: "generated_schedule", tier: 0, formatCats: [], items: sched.map(r => ({ ...toItem(r), schedId: r.row_id })) };
  const core = require("./scheduler-core.js");
  const clock = getActiveShowClock(db, stationId);
  let cats = [];
  try {
    if (clock) cats = db.prepare("SELECT category_id FROM clock_slots WHERE clock_id=? AND slot_type='music' AND category_id IS NOT NULL AND station_id=? AND deleted_at IS NULL ORDER BY position").all(clock.clockId, stationId).map(r => r.category_id);
  } catch {}
  const items = [];
  if (cats.length) {
    const rules = core.stationRules(db, stationId);
    let ts = Math.floor(Date.now() / 1000);
    const tl = core.loadTimeline(db, stationId, { beforeTs: ts });
    const fallback = core.fallbackCategory(db, stationId);
    for (let i = 0; i < count; i++) {
      const hour = new Date(ts * 1000).getHours();
      let r = core.pick(core.poolFor(db, cats[i % cats.length], hour), ts, tl, rules);
      if (!r.song && fallback) r = core.pick(core.poolFor(db, fallback, hour), ts, tl, rules);
      if (!r.song) continue;
      core.commit(tl, r.song, ts);
      const s2 = r.song;
      items.push(toItem({ file_path: s2.file_path, title: s2.title, artist: s2.artist, duration_ms: s2.duration_ms, file_key: null }));
      ts += s2.duration_ms ? Math.round(s2.duration_ms / 1000) : 240;
    }
  }
  const starved = items.length === 0;
  if (starved) console.error("[loggen] no song passes the rules in this station's clock right now (fill empty) — nothing is relaxed");
  return { source: clock ? `one pick: clock "${clock.showName}"` : "no clock", tier: 1, formatCats: cats, items, starved };
}

module.exports = { fillQueue, getActiveShowClock, getFormatCategoryIds, getStationCategoryIds, resetScheduleCursor, sepConfig, readJingleForSeam, readAutoPostForSong, selectRowForNow, readLogAnchored, eligibleForFit,
  // Internals, exposed for tests only — not part of the daemon's API. The category gate is the kind
  // of rule that is silently deleted by a future refactor unless something asserts it.
  _test: { baseConditions } };
