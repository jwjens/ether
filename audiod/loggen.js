// audiod/loggen.js — daemon-side scheduler (Item 10, Phase 1 step 3). A node:sqlite port
// of src/audio/loggen.ts's fill, so the daemon can keep the queue full on its own (no
// renderer, no better-sqlite3). Mirrors the FIXED behavior: every fallback pull is
// restricted to the active-show clocks' categories, so off-format/seasonal songs (e.g.
// Christmas) never leak in.
//
// Fill priority (matches loggen.ts): generated_schedule → active clock → on-format random.
// Two deliberate omissions vs. the renderer, both because the daemon has no renderer:
//   • SmartRules (renderer localStorage) — legacy secondary path; not ported.
//   • generated_schedule entries with NO local file_path (cloud-only) are SKIPPED — the
//     renderer materializes those via r2:fetch-track, which needs the app. Phase-2 cutover
//     can pass resolved paths in, or the daemon can gain its own R2 fetch. Local entries
//     (the steady state on an installed station) are honored in order.

// ── Base conditions every candidate must pass (loggen.ts buildBaseConditions) ──
// NOTE: `songs` is a single shared library — it has NO station_id column (stations
// differentiate via clocks/shows/schedule, which do). So the artist-separation subquery
// is NOT station-scoped. (loggen.ts references s2.station_id here, which doesn't exist —
// its live-pick path errors in production and falls through to generated_schedule; the
// daemon uses correct SQL.) `stationId` is unused here but kept for signature parity.
function baseConditions(hour, artistSepSec, params, stationId) {
  let c = "s.file_path IS NOT NULL AND s.rotation_status != 'inactive'";
  c += " AND ((s.daypart_mask >> ?) & 1) = 1";
  params.push(hour);
  c += " AND (s.last_played_at IS NULL OR s.last_played_at < (unixepoch() - s.no_repeat_hours * 3600))";
  c += ` AND (s.artist_id IS NULL OR s.artist_id NOT IN (
    SELECT DISTINCT s2.artist_id FROM songs s2
    WHERE s2.artist_id IS NOT NULL AND s2.last_played_at > (unixepoch() - ?)))`;
  params.push(artistSepSec);
  return c;
}

function sepSeconds(db, stationId) {
  try {
    const rows = db.prepare("SELECT rule_type, value FROM separation_rules WHERE is_active = 1 AND station_id = ?").all(stationId);
    const a = rows.find(r => r.rule_type === "artist_separation_min");
    return (a ? a.value : 60) * 60;
  } catch { return 3600; }
}

// ── Active show + its clock right now (loggen.ts getActiveShowClock) ──
// ORDER BY tightest hour-range so the most-specific show wins among overlaps.
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

// ── On-format category universe (loggen.ts getFormatCategoryIds) ──
// Active clock's music cats, else cats of clocks an ACTIVE SHOW uses — never a dormant
// seasonal clock. This is the Christmas-leak fix.
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
});

function pickFromClock(db, clockId, count, hour, sepSec, stationId) {
  const slots = db.prepare(`SELECT category_id FROM clock_slots
    WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL AND station_id = ? ORDER BY position`).all(clockId, stationId);
  const out = [], used = [];
  for (const slot of slots) {
    if (out.length >= count) break;
    const params = [];
    let cond = baseConditions(hour, sepSec, params, stationId) + " AND s.category_id = ?";
    params.push(slot.category_id);
    if (used.length) { cond += ` AND s.id NOT IN (${used.map(() => "?").join(",")})`; params.push(...used); }
    const row = db.prepare(`${SELECT} WHERE ${cond} ORDER BY RANDOM() LIMIT 1`).get(...params);
    if (row) { out.push(row); used.push(row.id); }
  }
  return out;
}

function pickRandom(db, count, hour, sepSec, stationId, formatCats) {
  const params = [];
  let cond = baseConditions(hour, sepSec, params, stationId);
  if (formatCats.length) { cond += ` AND s.category_id IN (${formatCats.map(() => "?").join(",")})`; params.push(...formatCats); }
  params.push(count);
  return db.prepare(`${SELECT} WHERE ${cond} ORDER BY RANDOM() LIMIT ?`).all(...params);
}

// ── Priority 1: pre-generated log (loggen.ts readGeneratedSchedule), local files only ──
// Cursor advances across refills so we don't re-queue played rows; resets when exhausted.
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
       WHERE gs.id > ? AND gs.station_id = ? AND gs.scheduled_at >= ? - 300 AND gs.deleted_at IS NULL ${catClause}
       ORDER BY gs.scheduled_at LIMIT ?`).all(...params);
  } catch { return []; } // no generated_schedule table / empty
  if (rows.length) _schedCursor = rows[rows.length - 1].row_id;
  return rows.filter(r => r.file_path); // skip cloud-only entries (need app r2:fetch)
}

// ── Main: fill `count` on-format tracks. Priority schedule → clock → on-format random ──
function fillQueue(db, stationId, count = 12) {
  const hour = new Date().getHours();
  const sepSec = sepSeconds(db, stationId);

  // Priority 1: generated schedule (loop back to start once exhausted).
  let sched = readGeneratedSchedule(db, count, stationId);
  if (!sched.length && _schedCursor > 0) { _schedCursor = 0; sched = readGeneratedSchedule(db, count, stationId); }
  if (sched.length) return { source: "generated_schedule", formatCats: [], items: sched.map(toItem) };

  // Priority 2: active show's clock. Priority 4: on-format random. (SmartRules omitted.)
  const clock = getActiveShowClock(db, stationId);
  const formatCats = getFormatCategoryIds(db, stationId, clock && clock.clockId);
  let songs = clock ? pickFromClock(db, clock.clockId, count, hour, sepSec, stationId) : [];
  if (songs.length < count) {
    const have = new Set(songs.map(s => s.id));
    for (const e of pickRandom(db, count - songs.length, hour, sepSec, stationId, formatCats)) if (!have.has(e.id)) songs.push(e);
  }
  return { source: clock ? `clock "${clock.showName}"` : "on-format random", formatCats, items: songs.map(toItem) };
}

module.exports = { fillQueue, getActiveShowClock, getFormatCategoryIds, resetScheduleCursor };
