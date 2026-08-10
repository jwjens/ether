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

// ── Enforce-separation toggle (2026-07-27, slice 2) — per-station, station_config_kv key
// 'enforce_separation'. Mirrors electron/main.js _buildScheduleCtx. Default OFF. When ON, the daemon's
// live-pick emergency floor (below) uses the SHARED enforced picker (electron/separation-enforce.js) —
// LRP-ordered eligible from play_log, relax only when the pool is exhausted. (Tier 0 — the generated_
// schedule read — is unaffected: it airs the log Generate already authored under enforcement.)
function enforceSeparationOn(db, stationId) {
  try {
    const t = db.prepare("SELECT value FROM station_config_kv WHERE key='enforce_separation' AND station_id=? AND deleted_at IS NULL").get(stationId);
    return !!(t && (t.value === '1' || t.value === 'true'));
  } catch { return false; }
}

// Per-station separation windows (minutes) — same source Generate uses (_buildScheduleCtx).
function sepWindows(db, stationId) {
  const g = (rt, def) => { try { const r = db.prepare("SELECT value FROM separation_rules WHERE station_id=? AND rule_type=? AND is_active=1 LIMIT 1").get(stationId, rt); return r ? r.value : def; } catch { return def; } };
  return { artistSepMin: g('artist_separation_min', 60), songRepeatMin: g('song_separation_min', 180), titleSepMin: g('title_separation_min', 120) };
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
  let c = "s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive') AND (s.content_class IS NULL OR s.content_class = 'MUSIC')";
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
const toItem = (r) => ({
  filePath: r.file_path, title: r.title, artist: r.artist_name || r.artist || "",
  durationMs: r.duration_ms || 0, introEnd: r.intro_end ?? undefined, outroStart: r.outro_start ?? undefined,
  scheduledAt: r.scheduled_at ?? undefined,
  fileKey: r.file_key ?? undefined,   // Slice B: lets the fill distinguish R2-only (prefetchable) from dead (no key)
  contentClass: r.content_class ?? undefined,   // MUSIC/SPOT — carried so the queue UI can gold-tint spots
});

// least-recently-played first: songs never aired on THIS station (MAX→NULL→0) come first, then oldest.
function lrpOrder(params, stationId) {
  params.push(stationId);
  return `ORDER BY COALESCE((SELECT MAX(pl.played_at) FROM play_log pl
            WHERE pl.file_path = s.file_path AND pl.station_id = ? AND pl.deleted_at IS NULL), 0) ASC, RANDOM()`;
}

// One tier of the ladder. order: "random" (Tier 1) or "lrp" (Tier 2/3). Returns [] on SQL error
// (never throws into the fill path). formatCats [] = no category restriction.
function pickTier(db, count, hour, stationId, formatCats, excludeIds, opts, order) {
  if (count <= 0) return [];
  const params = [];
  let cond = baseConditions(hour, params, stationId, opts);
  if (formatCats && formatCats.length) { cond += ` AND s.category_id IN (${formatCats.map(() => "?").join(",")})`; params.push(...formatCats); }
  if (excludeIds && excludeIds.length) { cond += ` AND s.id NOT IN (${excludeIds.map(() => "?").join(",")})`; params.push(...excludeIds); }
  const orderSql = order === "lrp" ? lrpOrder(params, stationId) : "ORDER BY RANDOM()";
  params.push(count);
  try { return db.prepare(`${SELECT} WHERE ${cond} ${orderSql} LIMIT ?`).all(...params); }
  catch (e) { console.error("[loggen] pickTier failed:", e.message); return []; }
}

// Clock: fill each music slot in order with a compliant pick (Tier-1 rules).
function pickFromClock(db, clockId, count, hour, stationId, opts) {
  // CLOCK IS LAW (2026-07-21): read only LIVE (non-deleted) slots — the same view getFormatCategoryIds,
  // the clock UI, and Generate now use. The flip promotes this emergency floor to load-bearing, so a
  // re-categorized clock's dead slots must never be walked here either.
  const slots = db.prepare(`SELECT category_id FROM clock_slots
    WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL AND station_id = ? AND deleted_at IS NULL ORDER BY position`).all(clockId, stationId);
  const out = [], used = [];
  for (const slot of slots) {
    if (out.length >= count) break;
    const params = [];
    let cond = baseConditions(hour, params, stationId, opts) + " AND s.category_id = ?";
    params.push(slot.category_id);
    if (used.length) { cond += ` AND s.id NOT IN (${used.map(() => "?").join(",")})`; params.push(...used); }
    let row = null;
    try { row = db.prepare(`${SELECT} WHERE ${cond} ORDER BY RANDOM() LIMIT 1`).get(...params); } catch (e) { row = null; }
    if (row) { out.push(row); used.push(row.id); }
  }
  return out;
}

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
         AND (gs.content_class IS NULL OR gs.content_class != 'JIN') ${catClause}
       ORDER BY gs.scheduled_at LIMIT ?`).all(...params);
  } catch { return []; }
  if (rows.length) _schedCursor = rows[rows.length - 1].row_id;
  return rows.filter(r => r.file_path);
}

// Top-of-hour: schedule anchored exactly at hourStartTs, no grace (daemon hard cut).
function fillFromHour(db, stationId, hourStartTs, count = 20) {
  const fmt = getFormatCategoryIds(db, stationId);
  const catClause = fmt.length ? `AND (s.id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
  const params = fmt.length ? [stationId, hourStartTs, ...fmt, count] : [stationId, hourStartTs, count];
  let rows;
  try {
    rows = db.prepare(
      `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, COALESCE(gs.file_key, s.file_key) AS file_key,
              COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start, gs.content_class,
              COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms
       FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
       WHERE gs.station_id = ? AND gs.scheduled_at >= ? AND gs.deleted_at IS NULL
         AND (gs.content_class IS NULL OR gs.content_class != 'JIN') ${catClause}
       ORDER BY gs.scheduled_at LIMIT ?`).all(...params);
  } catch { return []; }
  const playable = rows.filter(r => r.file_path);
  if (playable.length) _schedCursor = playable[playable.length - 1].row_id;
  return playable.map(r => ({ ...toItem(r), schedId: r.row_id }));   // schedId for the Phase 1 shadow playhead writer
}

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
function selectRowForNow(db, stationId, nowTs, slackSec = 60) {
  try {
    const fmt = getFormatCategoryIds(db, stationId);
    const catClause = fmt.length ? `AND (s.id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
    const base = `FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
                  WHERE gs.station_id = ? AND gs.state = 'pending' AND gs.deleted_at IS NULL
                    AND (gs.content_class IS NULL OR gs.content_class NOT IN ('JIN','SWP')) ${catClause}`;
    const cols = `gs.id AS row_id, gs.title, gs.scheduled_at, COALESCE(gs.file_path, s.file_path) AS file_path`;
    const fmtP = fmt.length ? fmt : [];
    // Current slot: the latest pending row whose scheduled_at has arrived (within slack).
    const playRow = db.prepare(
      `SELECT ${cols} ${base} AND gs.scheduled_at <= ? ORDER BY gs.scheduled_at DESC, gs.id DESC LIMIT 1`
    ).get(stationId, ...fmtP, nowTs + slackSec);
    if (playRow) {
      // How many pending rows sit BEFORE the current slot (their slots elapsed) — the flip's `missed` set.
      // NOTE this is a BACKLOG count that spans history: Phase 1 only stamped the rows legacy actually
      // aired, so every row legacy skipped stays 'pending' in the past. It is a separate signal from the
      // current anchor's drift — do NOT derive `mode` from it (a perfectly-anchored boundary can still
      // carry a large historical backlog). `mode` reflects the CHOSEN row's drift vs now only.
      const missedCount = db.prepare(
        `SELECT COUNT(*) AS n ${base} AND gs.scheduled_at < ?`
      ).get(stationId, ...fmtP, playRow.scheduled_at).n;
      const drift = nowTs - playRow.scheduled_at;   // >0 = chosen slot is in the past (running behind)
      return { playRow, missedCount, mode: drift > slackSec ? "behind" : "on-time", driftSec: drift };
    }
    // AHEAD: nothing has arrived — the earliest future pending row is the play-early candidate.
    const early = db.prepare(`SELECT ${cols} ${base} ORDER BY gs.scheduled_at LIMIT 1`).get(stationId, ...fmtP);
    if (early) return { playRow: early, missedCount: 0, mode: "ahead", driftSec: nowTs - early.scheduled_at };
    return { playRow: null, missedCount: 0, mode: "exhausted", driftSec: 0 };
  } catch { return { playRow: null, missedCount: 0, mode: "error", driftSec: 0 }; }
}

// ── Log-Reader Flip Phase 3 (ACTIVATION): the time-anchored read-through fill (§2.3 + §2.7) ────────────
// READ-ONLY. Returns the queue content (the row-for-now forward — a cache of log rows >= the playhead) +
// the skipped-past pending row ids to stamp 'missed' (BOUNDED TO THE CURRENT DAY, per the flip-activation
// ruling) + mode/drift. Rider A (AHEAD = never wait, never dead air): on 'ahead' the earliest FUTURE
// pending row is returned as the item to air early — items is never empty while any pending music row
// exists; only 'exhausted'/'error' returns no items, which the engine's emergency floor covers. The item
// shape matches loggen.fillQueue (schedId carried) so the daemon's proven preload/rotate/loadToDeck path
// consumes it unchanged. Never throws.
function readLogAnchored(db, stationId, count = 20, slackSec = 60) {
  const nowTs = Math.floor(Date.now() / 1000);
  const d = selectRowForNow(db, stationId, nowTs, slackSec);
  if (!d.playRow) return { items: [], mode: d.mode, missedRowIds: [], driftSec: 0, aheadBySec: 0 };
  const anchorTs = d.playRow.scheduled_at;
  const fmt = getFormatCategoryIds(db, stationId);
  const catClause = fmt.length ? `AND (s.id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
  const fmtP = fmt.length ? fmt : [];
  const pendBase = `FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
    WHERE gs.station_id = ? AND gs.state = 'pending' AND gs.deleted_at IS NULL
      AND (gs.content_class IS NULL OR gs.content_class NOT IN ('JIN','SWP')) ${catClause}`;
  // MISSED (day-bounded): still-pending on-format rows scheduled TODAY, before the anchor — the flip
  // stamps these 'missed' at the boundary. Bounding to today prevents a first-boundary sweep of the
  // entire historical backlog (Phase 1 only stamped aired rows).
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const dayStart = Math.floor(d0.getTime() / 1000);
  let missedRowIds = [];
  try {
    missedRowIds = db.prepare(`SELECT gs.id AS row_id ${pendBase} AND gs.scheduled_at >= ? AND gs.scheduled_at < ? ORDER BY gs.scheduled_at`)
      .all(stationId, ...fmtP, dayStart, anchorTs).map(r => r.row_id);
  } catch { /* leave empty */ }
  // ITEMS: the row-for-now forward.
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, COALESCE(gs.file_key, s.file_key) AS file_key,
              COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start, gs.content_class,
              COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms
       ${pendBase} AND gs.scheduled_at >= ? ORDER BY gs.scheduled_at LIMIT ?`
    ).all(stationId, ...fmtP, anchorTs, count);
  } catch { /* leave empty */ }
  const items = rows.filter(r => r.file_path).map(r => ({ ...toItem(r), schedId: r.row_id }));
  return { items, mode: d.mode, missedRowIds, driftSec: d.driftSec, aheadBySec: d.mode === "ahead" ? Math.max(0, -d.driftSec) : 0 };
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
    const rows = db.prepare(`${SELECT} WHERE ${cond} ${catClause} LIMIT ?`).all(...params, ...cats, limit);
    return rows.filter(r => r.file_path && r.duration_ms > 0).map(toItem);
  } catch { return []; }
}

// ── NEAREST-ANCHOR SEAM SELECTION (2026-07-30) ────────────────────────────────────────────────────────
// THE RULE (Jeff): early or late does not matter — CLOSEST TO THE ANCHOR WINS. At each seam, compare
// airing the spot now against airing it after the next music row, and take whichever lands nearer:
//
//     air the spot NOW     → |seamTs − A|
//     air the music first  → |(seamTs + d) − A|
//
// Pure, deterministic, no I/O — the same shape as selectRowForNow/_outgoingStopAction so it is benchable
// off-air (audiod/smoke-nearest-anchor.js). It only REORDERS rows that were already going to air: it
// issues no deck command, never touches the playing deck, and cannot produce silence.
//
// Worked case, live 2026-07-30, clock minute=0/20/40, anchor A = 11:19:50:
//   seam 11:17:18 → spot now 152s early vs music(164s) first 12s late  → MUSIC (log order)
//   seam 11:20:49 → spot now  59s late  vs music(211s) first 259s late → SPOT promoted
//
// Design of record: docs/design-nearest-anchor-seam-selection-2026-07-30.md
const NEAREST_ANCHOR_TIE_SEC = 2;

/** The contiguous run of SPOT rows sharing an anchor, starting at idx. A break is ATOMIC — splitting one
 *  across a song is worse than either option being compared — so it moves as a block, order preserved. */
function spotBlockAt(items, idx, groupSec = 5) {
  const a0 = items[idx].scheduledAt ?? 0;
  let end = idx;
  while (end + 1 < items.length
         && items[end + 1].contentClass === "SPOT"
         && Math.abs((items[end + 1].scheduledAt ?? 0) - a0) <= groupSec) end++;
  return { start: idx, end };
}

/**
 * Reorder the pending region so the next seam lands the spot as close to its anchor as possible.
 * Returns the SAME array (identity) when nothing should change, so callers can cheaply detect a no-op.
 *
 * @param items    pending rows in schedule order (loggen item shape: contentClass/scheduledAt/durationMs)
 * @param seamTs   projected next seam, epoch SECONDS (now + remaining on the playing deck)
 * @param opts     { tieSec, nextHourTs } — nextHourTs excludes anchors the top-of-hour hard cut owns
 */
function orderForNearestAnchor(items, seamTs, opts = {}) {
  try {
    if (!Array.isArray(items) || items.length < 2 || !Number.isFinite(seamTs)) return items;
    const tieSec = Number.isFinite(opts.tieSec) ? opts.tieSec : NEAREST_ANCHOR_TIE_SEC;

    const spotIdx = items.findIndex(it => it && it.contentClass === "SPOT");
    if (spotIdx < 0) return items;                       // no anchor in reach — nothing to weigh
    const musicIdx = items.findIndex(it => it && it.contentClass !== "SPOT");
    if (musicIdx < 0) return items;                      // nothing but spots — log order stands
    if (spotIdx < musicIdx) return items;                // the spot is ALREADY next; nothing to promote

    const A = items[spotIdx].scheduledAt;
    if (!Number.isFinite(A)) return items;               // unanchored row — never guess a time
    const d = (items[musicIdx].durationMs || 0) / 1000;
    if (!(d > 0)) return items;                          // unknown duration — cannot compare honestly

    // §4 — the top-of-hour hard cut owns :00. Never pre-empt an anchor it will fire itself.
    if (Number.isFinite(opts.nextHourTs) && A >= opts.nextHourTs) return items;

    // §1 REACH — only weigh an anchor that airing at THIS seam could actually serve. A PAST anchor is
    // always in reach (A − seamTs is negative), which is what "closest to" demands for an overdue spot.
    if ((A - seamTs) > d) return items;

    const nowDist = Math.abs(seamTs - A);
    const afterDist = Math.abs((seamTs + d) - A);

    // §2 NEAR-TIE — promote only on a clear win. seamTs is a projection that shifts between refills, so a
    // strict `<` would flap the queue head back and forth; log order is the tie-break with meaning.
    if ((afterDist - nowDist) <= tieSec) return items;

    // §3 — promote the whole break block, order preserved.
    const { start, end } = spotBlockAt(items, spotIdx);
    const block = items.slice(start, end + 1);
    const rest = items.slice(0, start).concat(items.slice(end + 1));
    return [...block, ...rest];
  } catch { return items; }                              // never throw into the fill path
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
              gs.lead_in_sec, gs.underlap_sec, gs.jingle_category_id
         FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
        WHERE gs.station_id = ? AND gs.content_class IN ('JIN','SWP') AND gs.deleted_at IS NULL
          AND gs.scheduled_at > ? AND gs.scheduled_at <= ?${notIn}
        ORDER BY gs.scheduled_at ASC LIMIT 1`).get(stationId, afterTs, beforeTs, ...ex);
    if (!row || !row.file_path) return null;
    const cls = row.content_class === 'SWP' ? 'SWP' : 'JIN';
    return {
      rowId: row.row_id, filePath: row.file_path, title: row.title || "", artist: row.artist || "",
      durationMs: row.duration_ms || 0, scheduledAt: row.scheduled_at, contentClass: cls,
      leadInSec: row.lead_in_sec != null ? row.lead_in_sec : (cls === 'SWP' ? 2 : 5),
      underlapSec: row.underlap_sec != null ? row.underlap_sec : (cls === 'SWP' ? 1 : 2),
      jingleCategoryId: row.jingle_category_id ?? null,
    };
  } catch { return null; }
}

// ── Enforced live-pick (2026-07-27, slice 2) — the emergency-floor fill when enforce_separation is ON.
// Fills `count` slots one at a time from the active clock's music categories (in position order; else
// on-format; else the station's own library), each via the SHARED pickEnforced: LRP-ordered eligible from
// play_log, relaxing (loud) only when a category's pool is exhausted. cursorTs advances by each pick's
// duration so rest windows are evaluated at each slot's projected air time. Never dead air (relax rather
// than empty while any candidate exists). Returns the fillQueue shape + relaxedCount (caller health-events).
function fillQueueEnforced(db, stationId, count, hour) {
  const path = require('path');
  const { buildRestMaps, pickEnforced } = require(path.join(__dirname, '..', 'electron', 'separation-enforce'));
  const clock = getActiveShowClock(db, stationId);
  let cats = [];
  try {
    if (clock) cats = db.prepare("SELECT category_id FROM clock_slots WHERE clock_id=? AND slot_type='music' AND category_id IS NOT NULL AND station_id=? AND deleted_at IS NULL ORDER BY position").all(clock.clockId, stationId).map(r => r.category_id);
  } catch {}
  if (!cats.length) cats = getFormatCategoryIds(db, stationId, clock && clock.clockId);
  if (!cats.length) cats = getStationCategoryIds(db, stationId);
  if (!cats.length) return { source: "enforced", tier: 1, formatCats: [], items: [], starved: true, relaxedCount: 0 };
  const win = sepWindows(db, stationId);
  const maps = { ...buildRestMaps(db, stationId), songLastTs: new Map(), artistLastTs: new Map(), titleLastTs: new Map() };
  const used = { usedSongIds: new Set(), usedArtistIds: new Set(), usedTitles: new Set() };
  let stmtC;
  try {
    stmtC = db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.file_path, s.file_key, s.intro_end, s.outro_start, s.no_repeat_hours
       FROM songs s LEFT JOIN artists a ON a.id=s.artist_id
       WHERE s.category_id=? AND s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status!='inactive')
         AND (s.content_class IS NULL OR s.content_class='MUSIC') AND (s.daypart_mask IS NULL OR ((s.daypart_mask>>?)&1)=1)`);
  } catch (e) { console.error("[loggen] enforced prepare failed:", e.message); return { source: "enforced", tier: 1, formatCats: cats, items: [], starved: true, relaxedCount: 0 }; }
  const items = []; let cursorTs = Math.floor(Date.now() / 1000); let relaxedCount = 0, ci = 0;
  for (let i = 0; i < count; i++) {
    let picked = null, guard = 0;
    while (!picked && guard++ < cats.length) {
      const cat = cats[ci++ % cats.length];
      let cands = []; try { cands = stmtC.all(cat, new Date(cursorTs * 1000).getHours()); } catch {}
      if (!cands.length) continue;
      const r = pickEnforced(cands, cursorTs, maps, win, used, null, 240);
      if (!r) continue;
      picked = r.picked; if (r.relaxed) relaxedCount++;
    }
    if (!picked) break;
    used.usedSongIds.add(picked.id); if (picked.artist_id) used.usedArtistIds.add(picked.artist_id);
    const tk = (picked.title || '').trim().toLowerCase(); if (tk) used.usedTitles.add(tk);
    maps.songLastTs.set(picked.id, cursorTs); if (picked.artist_id) maps.artistLastTs.set(picked.artist_id, cursorTs); if (tk) maps.titleLastTs.set(tk, cursorTs);
    items.push(toItem(picked));
    cursorTs += picked.duration_ms ? Math.round(picked.duration_ms / 1000) : 240;
  }
  if (relaxedCount) console.warn(`[loggen] ENFORCED live-pick relaxed ${relaxedCount}/${items.length} (category pool exhausted — loud)`);
  return { source: clock ? `enforced clock "${clock.showName}"` : "enforced on-format", tier: 1, formatCats: cats, items, starved: items.length === 0, relaxedCount };
}

// ── Main: fill `count` tracks. Never-empty priority ladder (see DESIGN LAW at top). ──
function fillQueue(db, stationId, count = 12) {
  const hour = new Date().getHours();

  // Tier 0: pre-generated log (loop back to start once exhausted).
  let sched = readGeneratedSchedule(db, count, stationId);
  if (!sched.length && _schedCursor > 0) { _schedCursor = 0; sched = readGeneratedSchedule(db, count, stationId); }
  // Carry schedId (the generated_schedule row id) on log-sourced items so the Phase 1 shadow playhead
  // writer can stamp that exact row when it goes on air. Live-picked items (Tiers 1-4 below) omit it —
  // that absence IS the off-log divergence signal.
  if (sched.length) return { source: "generated_schedule", tier: 0, formatCats: [], items: sched.map(r => ({ ...toItem(r), schedId: r.row_id })) };

  // ENFORCE-SEPARATION (slice 2): when ON, the live-pick floor uses the shared enforced picker instead of
  // the RANDOM-first-compliant ladder below. OFF path (below) is byte-identical to before.
  if (enforceSeparationOn(db, stationId)) return fillQueueEnforced(db, stationId, count, hour);

  const { rulesOn, artistSepSec } = sepConfig(db, stationId);
  const clock = getActiveShowClock(db, stationId);
  const formatCats = getFormatCategoryIds(db, stationId, clock && clock.clockId);
  const songs = [];
  const ids = () => songs.map(s => s.id);
  const add = (rows) => { for (const r of rows) if (!ids().includes(r.id)) songs.push(r); };
  let tier = 1;

  try {
    // Tier 1 — all rules satisfied. Separation applied ONLY when rules are ON (rules-off = off here).
    const t1 = { artistSepSec: rulesOn ? artistSepSec : 0, songSep: rulesOn, daypart: true };
    if (clock) add(pickFromClock(db, clock.clockId, count, hour, stationId, t1));
    if (songs.length < count) add(pickTier(db, count - songs.length, hour, stationId, formatCats, ids(), t1, "random"));

    // Tier 2 — relax soft rules → least-recently-played.
    if (songs.length < count) {
      const before = songs.length;
      add(pickTier(db, count - songs.length, hour, stationId, formatCats, ids(), { artistSepSec: 0, songSep: false, daypart: true }, "lrp"));
      if (songs.length > before) { tier = 2; console.warn(`[loggen] TIER 2 (relaxed separation → least-recently-played): +${songs.length - before}`); }
    }
    // Tier 3 — absolute LRP in-format, no rules (daypart dropped).
    if (songs.length < count) {
      const before = songs.length;
      add(pickTier(db, count - songs.length, hour, stationId, formatCats, ids(), { artistSepSec: 0, songSep: false, daypart: false }, "lrp"));
      if (songs.length > before) { tier = 3; console.warn(`[loggen] TIER 3 (absolute least-recently-played, no rules): +${songs.length - before}`); }
    }
    // Tier 3b — on-format (clock-derived) set empty/misconfigured → LRP across THIS STATION'S OWN library
    // (all of its categories), NOT the whole account. Scoping to the station's category ids means a
    // category-less orphan and every other station's songs are excluded by construction — the fallback
    // can never again borrow a foreign song (the 4-Beach-Boys / cross-station leak). If the station has
    // no categories at all, stationCats is [] and we DO NOT relax to "any category / any station" — we
    // leave the pool empty and let the loud starvation signal below fire (honest empty-library, never a
    // silent foreign-song cover-up). Separation stays off at this absolute floor (AUTO NEVER STOPS —
    // within the station), which is unchanged; the defect was cross-station borrowing, not the relax.
    if (songs.length === 0) {
      const stationCats = getStationCategoryIds(db, stationId);
      if (stationCats.length) {
        add(pickTier(db, count, hour, stationId, stationCats, [], { artistSepSec: 0, songSep: false, daypart: false }, "lrp"));
        if (songs.length) { tier = 4; console.warn(`[loggen] TIER 3b (LRP across this station's own library — no on-format candidates): +${songs.length}`); }
      }
    }
  } catch (e) {
    console.error("[loggen] ladder failed:", e.message);
  }

  // Genuine starvation: no playable song in ANY of the station's own categories. LOUD — the caller emits
  // a health event so an empty/misconfigured station library surfaces, rather than being papered over by
  // borrowing another station's songs (which is what the old account-wide Tier 3b did silently).
  const starved = songs.length === 0;
  if (starved) {
    console.error("[loggen] INVARIANT: no active in-station songs exist for this station — cannot avoid silence (STARVED).");
  }
  return { source: clock ? `clock "${clock.showName}"` : "on-format", tier, formatCats, items: songs.map(toItem), starved };
}

module.exports = { fillQueue, fillQueueEnforced, enforceSeparationOn, sepWindows, fillFromHour, getActiveShowClock, getFormatCategoryIds, getStationCategoryIds, resetScheduleCursor, sepConfig, readJingleForSeam, selectRowForNow, readLogAnchored, orderForNearestAnchor, eligibleForFit };
