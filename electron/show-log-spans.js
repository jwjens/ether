// electron/show-log-spans.js — WHICH SHOW HOURS HAVE NO LOG YET (the check behind "the log is built before a show
// starts", main.js _buildShowLogs). Pure over a database handle; run by electron/show-log-worker.js on its own thread.
//
// 4.6.60 FROZE MAIN ~58 s EVERY MINUTE (ovowforestmusic, 2026-10-20; health-events main-stall
// "_missingShowSpans electron/main.js:12016 ← _buildShowLogs"). Three causes, three rules here:
//   1. One query per hour, none indexed (COALESCE(log_hour_ts, scheduled_at) range) — a full scan of the station's log
//      for every empty hour. Now: ONE query per station, a range on idx_gensched_station_at (station_id, scheduled_at),
//      and the hours are matched in memory. No per-hour query.
//   2. A 24/7 show is one endless run, so the walk ran its full 768 hours (32 days). Now: the show on now and the next
//      show — an OCCURRENCE ends where the show's day ends (a daily 0:00–0:00 show is a new occurrence each midnight).
//   3. The spans were worked out for every station before asking whether this machine builds it. Now the gate is first.
// It runs on a worker thread, so the main thread never waits on the database for it (Jeff, 2026-10-20).
"use strict";
const SW = require("../audiod/show-window.js");

// A row's log hour (COALESCE(log_hour_ts, scheduled_at)) is never more than this before or after its scheduled_at: a
// row is scheduled inside its hour, or after it when the hour runs over (a crossing song). Used only to widen the
// indexed scheduled_at range so no row of a window hour is missed; the exact match is done in memory.
const ROW_SLACK_S = 6 * 3600;
// The walk passes empty time cheaply (no query per piece any more); this only bounds a schedule whose next show is
// a week away.
const MAX_PIECES = 8 * 24 * 4;

const _minuteOfDay = (ts) => { const d = new Date(ts * 1000); return d.getHours() * 60 + d.getMinutes(); };

/**
 * The pieces of the show on now (from now) and of the next show's occurrence. An occurrence begins where a different
 * show (or a gap) gives way to a show, or where the same show reaches its own start minute again — so a show that runs
 * 24 h every day is one occurrence per day, not one endless run.
 */
function windowPieces(shows, nowTs) {
  const out = [];
  const want = SW.pieceAt(shows, nowTs).show ? 2 : 1;
  let seen = 0, prev = null, occStart = null, t = nowTs;
  for (let i = 0; i < MAX_PIECES; i++) {
    const p = SW.pieceAt(shows, t);
    if (p.show) {
      const fresh = !prev || prev.show.id !== p.show.id
        || (_minuteOfDay(p.startTs) === SW.startMin(p.show) && p.startTs > occStart);
      if (fresh) { seen++; occStart = p.startTs; }
      if (seen > want) break;
      if (p.show.clock_id != null) out.push(p);
      prev = p;
    } else prev = null;
    t = p.endTs;
  }
  return out;
}

/** The hours of `pieces` with no log row, merged into spans: [{ fromLk, toTs, show }]. One query. */
function missingSpans(db, stationId, pieces) {
  if (!pieces.length) return [];
  const from = pieces[0].startTs, to = pieces[pieces.length - 1].endTs;
  const hours = db.prepare(
    `SELECT DISTINCT COALESCE(log_hour_ts, scheduled_at) AS h FROM generated_schedule
      WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ? AND deleted_at IS NULL`
  ).all(stationId, from - ROW_SLACK_S, to + ROW_SLACK_S).map(r => r.h).sort((a, b) => a - b);
  const has = (a, b) => { let lo = 0, hi = hours.length; while (lo < hi) { const m = (lo + hi) >> 1; if (hours[m] < a) lo = m + 1; else hi = m; } return lo < hours.length && hours[lo] < b; };
  const spans = [];
  for (const p of pieces) {
    if (has(p.startTs, p.endTs)) continue;
    const last = spans[spans.length - 1];
    if (last && last.toTs === p.startTs) last.toTs = p.endTs;
    else spans.push({ fromLk: p.startTs, toTs: p.endTs, show: p.show.name });
  }
  return spans;
}

/**
 * Every station this machine builds, and the show hours of it with no log yet.
 * gate(stationId) → { allow, reason } is asked FIRST; a station it refuses costs nothing more.
 * @returns [{ stationId, name, spans, skipped? }]
 */
function stationsToBuild(db, nowTs, gate) {
  const out = [];
  for (const st of db.prepare("SELECT id, name FROM stations WHERE deleted_at IS NULL").all()) {
    const g = gate(st.id);
    if (!g.allow) { out.push({ stationId: st.id, name: st.name, spans: [], skipped: g.reason }); continue; }
    const shows = db.prepare("SELECT * FROM shows WHERE station_id = ? AND is_active = 1 AND deleted_at IS NULL").all(st.id);
    if (!shows.length) { out.push({ stationId: st.id, name: st.name, spans: [] }); continue; }
    out.push({ stationId: st.id, name: st.name, spans: missingSpans(db, st.id, windowPieces(shows, nowTs)) });
  }
  return out;
}

module.exports = { windowPieces, missingSpans, stationsToBuild, ROW_SLACK_S };
