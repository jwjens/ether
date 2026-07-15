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
function getFormatCategoryIds(db, stationId, clockId) {
  try {
    const rows = clockId
      ? db.prepare(`SELECT DISTINCT category_id FROM clock_slots
          WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?`).all(clockId, stationId)
      : db.prepare(`SELECT DISTINCT cs.category_id FROM clock_slots cs
          WHERE cs.slot_type = 'music' AND cs.category_id IS NOT NULL AND cs.deleted_at IS NULL AND cs.station_id = ?
            AND cs.clock_id IN (SELECT clock_id FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?)`).all(stationId, stationId);
    return rows.map(r => r.category_id).filter(c => c != null);
  } catch { return []; }
}

const SELECT = `SELECT s.id, s.title, a.name AS artist_name, s.file_path, s.duration_ms, s.intro_end, s.outro_start
  FROM songs s LEFT JOIN artists a ON a.id = s.artist_id`;
const toItem = (r) => ({
  filePath: r.file_path, title: r.title, artist: r.artist_name || r.artist || "",
  durationMs: r.duration_ms || 0, introEnd: r.intro_end ?? undefined, outroStart: r.outro_start ?? undefined,
  scheduledAt: r.scheduled_at ?? undefined,
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
  const slots = db.prepare(`SELECT category_id FROM clock_slots
    WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL AND station_id = ? ORDER BY position`).all(clockId, stationId);
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
let _schedCursor = 0;
function resetScheduleCursor() { _schedCursor = 0; }

function readGeneratedSchedule(db, count, stationId) {
  const nowTs = Math.floor(Date.now() / 1000);
  const fmt = getFormatCategoryIds(db, stationId);
  const catClause = fmt.length ? `AND (s.category_id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
  const params = fmt.length ? [_schedCursor, stationId, nowTs, ...fmt, count] : [_schedCursor, stationId, nowTs, count];
  let rows;
  try {
    rows = db.prepare(
      `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, gs.file_key,
              COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start,
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
  const catClause = fmt.length ? `AND (s.category_id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
  const params = fmt.length ? [stationId, hourStartTs, ...fmt, count] : [stationId, hourStartTs, count];
  let rows;
  try {
    rows = db.prepare(
      `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, gs.file_key,
              COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start,
              COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms
       FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
       WHERE gs.station_id = ? AND gs.scheduled_at >= ? AND gs.deleted_at IS NULL
         AND (gs.content_class IS NULL OR gs.content_class != 'JIN') ${catClause}
       ORDER BY gs.scheduled_at LIMIT ?`).all(...params);
  } catch { return []; }
  const playable = rows.filter(r => r.file_path);
  if (playable.length) _schedCursor = playable[playable.length - 1].row_id;
  return playable.map(toItem);
}

// ── JINGLES overlay v1: read the transition-attached JIN placement for the upcoming seam ──────────────
// The daemon is a LOG-READER (D1=A′): Generate placed JIN rows in generated_schedule bound to the seam
// (scheduled_at = the incoming music row's start). Given the currently-playing row's scheduled_at (afterTs)
// and the incoming row's scheduled_at (beforeTs), return the JIN placement bridging THIS seam — resolving
// the jingle's file via the songs join (like readGeneratedSchedule). excludeIds skips already-fired rows.
// Returns null on any miss / SQL error (never throws — a jingle miss never disturbs playout).
function readJingleForSeam(db, stationId, afterTs, beforeTs, excludeIds) {
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

// ── Main: fill `count` tracks. Never-empty priority ladder (see DESIGN LAW at top). ──
function fillQueue(db, stationId, count = 12) {
  const hour = new Date().getHours();

  // Tier 0: pre-generated log (loop back to start once exhausted).
  let sched = readGeneratedSchedule(db, count, stationId);
  if (!sched.length && _schedCursor > 0) { _schedCursor = 0; sched = readGeneratedSchedule(db, count, stationId); }
  if (sched.length) return { source: "generated_schedule", tier: 0, formatCats: [], items: sched.map(toItem) };

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
    // Tier 3b — on-format set empty/misconfigured → LRP across ALL active songs, any category.
    if (songs.length === 0) {
      add(pickTier(db, count, hour, stationId, [], [], { artistSepSec: 0, songSep: false, daypart: false }, "lrp"));
      if (songs.length) { tier = 4; console.warn(`[loggen] TIER 3b (LRP across all active songs — no on-format candidates): +${songs.length}`); }
    }
  } catch (e) {
    console.error("[loggen] ladder failed:", e.message);
  }

  if (songs.length === 0) {
    // Only reachable if the station genuinely has ZERO active songs (empty library) — nothing to play.
    console.error("[loggen] INVARIANT: no active songs exist for this station — cannot avoid silence.");
  }
  return { source: clock ? `clock "${clock.showName}"` : "on-format", tier, formatCats, items: songs.map(toItem) };
}

module.exports = { fillQueue, fillFromHour, getActiveShowClock, getFormatCategoryIds, resetScheduleCursor, sepConfig, readJingleForSeam };
