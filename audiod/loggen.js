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

const hourJoin = require("./hour-join");   // the new hour joins after the song crossing :00 (no hard cut)

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
  const hour = new Date().getHours();
  const day = String(new Date().getDay());
  const rows = db.prepare(
    `SELECT clock_id, name, start_hour, end_hour, days FROM shows
     WHERE is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?
     ORDER BY CASE
       WHEN end_hour = 0 AND start_hour > 0 THEN 24 - start_hour
       WHEN end_hour = 0 OR end_hour = start_hour THEN 24
       WHEN end_hour > start_hour THEN end_hour - start_hour
       ELSE 24 - start_hour + end_hour END ASC`).all(stationId);
  for (const r of rows) {
    if (!r.days.includes(day)) continue;
    const sh = r.start_hour, eh = r.end_hour;
    let active;
    if (eh === 0 || eh === sh) active = hour >= sh;
    else if (eh > sh) active = hour >= sh && hour < eh;
    else active = hour >= sh || hour < eh;
    if (active) return { clockId: r.clock_id, showName: r.name };
  }
  return null;
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
function selectRowForNow(db, stationId, nowTs, slackSec = 60, opts = null) {
  try {
    const fmt = getFormatCategoryIds(db, stationId);
    const catClause = fmt.length ? `AND (s.id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
    const asP = opts && opts.asPending != null && Number.isInteger(Number(opts.asPending)) ? Number(opts.asPending) : null;
    const limitTs = _hourEnd(Math.max(nowTs, (opts && opts.seamTs) || nowTs));
    const base = `FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
                  WHERE gs.station_id = ? AND (gs.state = 'pending'${asP != null ? " OR gs.id = " + asP : ""}) AND gs.deleted_at IS NULL
                    AND (gs.content_class IS NULL OR gs.content_class NOT IN ('JIN','SWP','UNSCHEDULED')) ${catClause}`;
    const cols = `gs.id AS row_id, gs.title, gs.scheduled_at, COALESCE(gs.file_path, s.file_path) AS file_path`;
    const fmtP = fmt.length ? fmt : [];
    // Current slot: the latest pending row whose scheduled_at has arrived (within slack), in an hour that has started.
    let playRow = db.prepare(
      `SELECT ${cols} ${base} AND gs.scheduled_at <= ? AND gs.scheduled_at < ? ORDER BY gs.scheduled_at DESC, gs.id DESC LIMIT 1`
    ).get(stationId, ...fmtP, nowTs + slackSec, limitTs);
    // HOUR JOIN (2026-10-04, top-of-hour hard cut removed): the new hour plays AFTER the song that
    // crosses :00 — its head is never skipped or stamped `missed` because that song ran over. See
    // audiod/hour-join.js; a null window leaves the ordinary catch-up below unchanged.
    if (playRow) {
      const H = hourJoin.hourStartOf(playRow.scheduled_at);
      const playing = db.prepare(
        `SELECT MAX(scheduled_at) AS ts FROM generated_schedule
          WHERE station_id = ? AND state = 'playing' AND deleted_at IS NULL`).get(stationId);
      const aired = db.prepare(
        `SELECT scheduled_at, played_at FROM generated_schedule
          WHERE station_id = ? AND state IN ('played','playing') AND deleted_at IS NULL
            AND (content_class IS NULL OR content_class NOT IN ('JIN','SWP'))
            AND scheduled_at >= ? AND scheduled_at < ?
          ORDER BY scheduled_at, id LIMIT 1`).get(stationId, H, H + 3600);
      const win = hourJoin.joinWindow({
        nowTs, candidateTs: playRow.scheduled_at,
        playingTs: playing && playing.ts != null ? playing.ts : null,
        firstAired: aired ? { scheduledAt: aired.scheduled_at, playedAt: aired.played_at } : null,
      });
      if (win) {
        const head = db.prepare(
          `SELECT ${cols} ${base} AND gs.scheduled_at ${win.fromInclusive ? ">=" : ">"} ? AND gs.scheduled_at <= ?
             AND gs.scheduled_at < ? ORDER BY gs.scheduled_at, gs.id LIMIT 1`
        ).get(stationId, ...fmtP, win.fromTs, win.toTs, playRow.scheduled_at);
        if (head) playRow = head;
      }
    }
    if (playRow) {
      const missedCount = db.prepare(
        `SELECT COUNT(*) AS n ${base} AND gs.scheduled_at < ?`
      ).get(stationId, ...fmtP, playRow.scheduled_at).n;
      const drift = nowTs - playRow.scheduled_at;   // >0 = chosen slot is in the past (running behind)
      return { playRow, missedCount, mode: drift > slackSec ? "behind" : "on-time", driftSec: drift, limitTs };
    }
    // Nothing due yet, but the hour has started and still has rows later on: the station is a little early INSIDE its
    // own hour (songs ran short). The next row of THIS hour plays — that is not ahead of the clock.
    const inHour = db.prepare(`SELECT ${cols} ${base} AND gs.scheduled_at >= ? AND gs.scheduled_at < ? ORDER BY gs.scheduled_at LIMIT 1`)
      .get(stationId, ...fmtP, limitTs - 3600, limitTs);
    if (inHour) return { playRow: inHour, missedCount: 0, mode: "on-time", driftSec: nowTs - inHour.scheduled_at, limitTs };
    // NOTHING DUE: no row of a started hour. Never a future hour's row. The next due time is reported.
    const next = db.prepare(`SELECT MIN(gs.scheduled_at) AS ts ${base} AND gs.scheduled_at >= ?`).get(stationId, ...fmtP, limitTs);
    return { playRow: null, missedCount: 0, mode: "nothing-due", driftSec: 0, limitTs, nextDueTs: next && next.ts != null ? next.ts : null };
  } catch { return { playRow: null, missedCount: 0, mode: "error", driftSec: 0 }; }
}

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
  const d = selectRowForNow(db, stationId, nowTs, slackSec, { seamTs });
  if (!d.playRow) return { items: [], mode: d.mode, missedRowIds: [], skip: [], driftSec: 0, aheadBySec: 0, nextDueTs: d.nextDueTs ?? null, limitTs: d.limitTs ?? null };
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
  // ITEMS: the row-for-now forward, inside the hours that have started (never ahead of the clock).
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, COALESCE(gs.file_key, s.file_key) AS file_key,
              COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start, gs.content_class,
              COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms, s.title AS song_title, a.name AS song_artist, s.no_repeat_hours, gs.category_id
       ${pendBase} AND gs.scheduled_at >= ? AND gs.scheduled_at < ? ORDER BY gs.scheduled_at LIMIT ?`
    ).all(stationId, ...fmtP, anchorTs, d.limitTs, count);
  } catch {
    // An older or partial database (no artists table, no no_repeat_hours column): the same rows without the song's
    // own artist and rest. The playout check then measures on the row's own title and artist.
    try {
      rows = db.prepare(
        `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, COALESCE(gs.file_key, s.file_key) AS file_key,
                COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start, gs.content_class,
                COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms
         ${pendBase.replace(" LEFT JOIN artists a ON a.id = s.artist_id", "")} AND gs.scheduled_at >= ? AND gs.scheduled_at < ? ORDER BY gs.scheduled_at LIMIT ?`
      ).all(stationId, ...fmtP, anchorTs, d.limitTs, count);
    } catch { /* leave empty */ }
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
  return { items, mode: items.length ? d.mode : "nothing-due", missedRowIds, skip, driftSec: d.driftSec, aheadBySec: 0, limitTs: d.limitTs,
    nextDueTs: items.length ? null : (d.nextDueTs ?? null) };
}

// ── A SHORT HOUR FILLS FROM ITS OWN CLOCK (design §3.7, Phase 3) ─────────────────────────────────────────────────────
// Nothing of this hour is left to air and :00 is still ahead: the hour's own clock supplies the next song, chosen by the
// ONE pick (scheduler-core) under the station's rules against what aired and the log on either side, and it is WRITTEN
// INTO THE LOG as a fill row (source 'fill') before it airs, so the record stays complete. Returns the new row id, or
// null with a reason when there is nothing to fill from:
//   'no-show'   — no show (clock) covers this hour: the station WAITS for its next row (Jeff: automation started
//                 before the first log row waits for it);
//   'tolerance' — less than the station's fill tolerance (setting fill_tolerance_sec; none unless set) is left before :00;
//   'nothing-passes' — no song in the clock's categories (or the fallback) passes the rules.
// opts.categoryId: the slot's own category first (a row the playout check refused: "the pick is run again for that slot",
// design §3.2.2), then the clock's order.
function fillShortHour(db, stationId, atTs, opts = null) {
  try {
    const core = require("./scheduler-core.js");
    const hourEnd = _hourEnd(atTs);
    let tol = 0;   // nothing built in (Jeff, 2026-10-18): until the station sets fill_tolerance_sec, a short hour fills up to :00
    try { const r = db.prepare("SELECT value FROM station_config_kv WHERE station_id=? AND key='fill_tolerance_sec' AND deleted_at IS NULL").get(stationId); if (r && r.value !== "" && Number.isFinite(Number(r.value)) && Number(r.value) >= 0) tol = Number(r.value); } catch {}
    if (hourEnd - atTs < tol) return { rowId: null, reason: "tolerance", retryAt: hourEnd };
    const hour = new Date(atTs * 1000).getHours(), day = String(new Date(atTs * 1000).getDay());
    const show = db.prepare(`SELECT clock_id, start_hour, end_hour, days FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?`).all(stationId)
      .find(r => r.days.includes(day) && ((r.end_hour === 0 || r.end_hour === r.start_hour) ? hour >= r.start_hour : r.end_hour > r.start_hour ? (hour >= r.start_hour && hour < r.end_hour) : (hour >= r.start_hour || hour < r.end_hour)));
    if (!show) return { rowId: null, reason: "no-show", retryAt: hourEnd };
    const cats = db.prepare(`SELECT category_id FROM clock_slots WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL AND deleted_at IS NULL ORDER BY position`).all(show.clock_id).map(r => r.category_id);
    if (!cats.length) return { rowId: null, reason: "no-show", retryAt: hourEnd };
    // The clock's next music category: after the last music row of this hour (in clock order), else the first.
    const hs = hourEnd - 3600;
    const last = db.prepare(`SELECT category_id FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL AND song_id IS NOT NULL AND (content_class IS NULL OR content_class = 'MUSIC')
        AND scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at DESC LIMIT 1`).get(stationId, hs, hourEnd);
    let i = last ? cats.indexOf(last.category_id) : -1;
    if (opts && opts.categoryId != null && cats.includes(opts.categoryId)) i = cats.indexOf(opts.categoryId) - 1;
    const rules = core.stationRules(db, stationId);
    const fallback = core.fallbackCategory(db, stationId);
    // ON THE AIR LOOP: read only what the rules can reach (the longest rule, or the longest per-song no-repeat hours)
    // plus each candidate's one last airing — never the whole history (T19: nothing on the air loop waits on the DB).
    const pools = new Map();
    for (const c of [...new Set([...cats, ...(fallback ? [fallback] : [])])]) pools.set(c, core.poolFor(db, c, hour));
    let reach = Math.max(rules.songMin || 0, rules.artistMin || 0, rules.titleMin || 0);
    for (const pl of pools.values()) for (const so of pl) if (so.noRepeatHours) reach = Math.max(reach, Number(so.noRepeatHours) * 60);
    const files = [...new Set([...pools.values()].flat().map(so => so.file_path).filter(Boolean))];
    const tl = core.loadTimeline(db, stationId, { beforeTs: atTs, sinceTs: atTs - reach * 60, poolFiles: files });
    // Songs already planned later TODAY are spoken for (scheduler-core pick opts.spokenFor).
    const spokenFor = new Map();
    try {
      const d1 = new Date(atTs * 1000); d1.setHours(24, 0, 0, 0);
      for (const r of db.prepare(`SELECT COALESCE(gs.file_key, gs.file_path, s.file_path) f, MIN(gs.scheduled_at) t FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
          WHERE gs.station_id = ? AND gs.deleted_at IS NULL AND gs.state = 'pending' AND gs.song_id IS NOT NULL AND gs.scheduled_at > ? AND gs.scheduled_at < ? GROUP BY 1`).all(stationId, atTs, Math.floor(d1.getTime() / 1000)))
        { const k = core.recordingKey(r.f); if (k) spokenFor.set(k, r.t); }
    } catch {}
    let chosen = null, cat = null, shortest = Infinity;
    const tryCat = (c) => { const r = core.pick(pools.get(c) || [], atTs, tl, rules, Math.random, { spokenFor }); if (r.song) return r; for (const x of (r.closest || [])) shortest = Math.min(shortest, x.shortMin); return null; };
    for (let k = 0; k < cats.length && !chosen; k++) {
      i = (i + 1) % cats.length;
      const r = tryCat(cats[i]);
      if (r) { chosen = r; cat = cats[i]; }
    }
    if (!chosen && fallback) { const r = tryCat(fallback); if (r) { chosen = r; cat = fallback; } }
    // Nothing passes: try again when the closest blocked song becomes free (the rule says when), or at :00.
    if (!chosen) return { rowId: null, reason: "nothing-passes", retryAt: Number.isFinite(shortest) ? Math.min(hourEnd, atTs + Math.ceil(shortest * 60)) : hourEnd };
    const s = chosen.song, iso = new Date().toISOString();
    const res = db.prepare(`INSERT INTO generated_schedule (scheduled_at, song_id, title, artist, file_key, file_path, duration_s, category_id, clock_id, station_id, uuid, state, source, content_class, pick_reason, created_at, updated_at, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'fill', 'MUSIC', ?, ?, ?, ?)`)
      .run(atTs, s.id, s.title, s.artist || "", String(s.file_path || s.file || "").split(/[\\/]/).pop(), s.file_path || null, s.duration_ms ? Math.round(s.duration_ms / 1000) : null,
           cat, show.clock_id, stationId, require("crypto").randomUUID(), JSON.stringify({ m: "fill", cat, lastAired: chosen.lastAired, passing: chosen.passing }), iso, iso, atTs);
    return { rowId: Number(res.lastInsertRowid), reason: null, title: s.title };
  } catch (e) { return { rowId: null, reason: "error: " + String(e && e.message || e) }; }
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

module.exports = { fillQueue, getActiveShowClock, getFormatCategoryIds, getStationCategoryIds, resetScheduleCursor, sepConfig, readJingleForSeam, readAutoPostForSong, selectRowForNow, readLogAnchored, fillShortHour, eligibleForFit,
  // Internals, exposed for tests only — not part of the daemon's API. The category gate is the kind
  // of rule that is silently deleted by a future refactor unless something asserts it.
  _test: { baseConditions } };
