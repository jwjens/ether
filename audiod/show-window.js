// audiod/show-window.js — THE SHOW SCHEDULE IS THE BOUNDARY (Jeff, 2026-10-18).
//
// "A show that ends at 1:30 automates until 1:30. Shows start and end at any minute. The log plays what the programmer
// built. No built-in fill, no catch-up drops." One rule for which show owns a moment, used by Generate (electron/
// generate-core.js), the log reader (audiod/loggen.js) and the screens (src/lib/showWindow.ts mirrors it).
//
// A show runs from start_hour:start_minute to end_hour:end_minute (migration v65 added the minutes; NULL = :00, so
// every show made before it keeps its hours exactly). The same conventions Generate has always used:
//   end 00:00, or end == start            → from the start through midnight   (00:00–00:00 = all day)
//   end after start                        → start .. end
//   end before start                       → overnight: start .. midnight, and midnight .. end (both on the show's days)
// When two shows cover the same minute the SHORTER one wins (the most specific), as Generate's ORDER BY always did.
"use strict";

const startMin = (s) => (s.start_hour | 0) * 60 + (s.start_minute | 0);
const endMin = (s) => (s.end_hour | 0) * 60 + (s.end_minute | 0);
/** Length in minutes (for "the shorter show wins"). */
function showLength(s) {
  const a = startMin(s), b = endMin(s);
  if (b === 0 || b === a) return 1440 - a || 1440;
  if (b > a) return b - a;
  return 1440 - a + b;
}
/** Does the show cover minute-of-day `m` (0..1439) on weekday `day` (0 = Sunday)? */
function coversMinute(s, m, day) {
  if (!String(s.days ?? "").includes(String(day))) return false;
  const a = startMin(s), b = endMin(s);
  if (b === 0 || b === a) return m >= a;
  if (b > a) return m >= a && m < b;
  return m >= a || m < b;
}
const byLength = (shows) => shows.slice().sort((x, y) => showLength(x) - showLength(y));
/** The show that owns the moment `ts` (epoch seconds, local time), or null. */
function _ownerIn(sorted, ts) {
  const d = new Date(ts * 1000);
  const m = d.getHours() * 60 + d.getMinutes(), day = d.getDay();
  return sorted.find(s => coversMinute(s, m, day)) || null;
}
function showAt(shows, ts) { return _ownerIn(byLength(shows), ts); }
/**
 * The pieces of the hour starting at `hourStartTs`, each owned by one show (or none): [{ fromTs, toTs, show }].
 * The hour is cut at every show start / end minute inside it.
 */
function hourSegments(shows, hourStartTs) {
  const d = new Date(hourStartTs * 1000);
  const h = d.getHours();
  const cuts = new Set([0, 60]);
  for (const s of shows) {
    if ((s.start_hour | 0) === h) cuts.add(s.start_minute | 0);
    if ((s.end_hour | 0) === h) cuts.add(s.end_minute | 0);
  }
  const mins = [...cuts].filter(x => x >= 0 && x <= 60).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < mins.length; i++) {
    const fromTs = hourStartTs + mins[i] * 60, toTs = hourStartTs + mins[i + 1] * 60;
    const show = showAt(shows, fromTs);
    const last = out[out.length - 1];
    if (last && (last.show ? last.show.id : null) === (show ? show.id : null)) { last.toTs = toTs; continue; }
    out.push({ fromTs, toTs, show });
  }
  return out;
}
/**
 * The run of the show that owns `ts`: { show, startTs, endTs } — from where that show began (walking back minute
 * by minute while the same show owns it, across midnight) to where it ends. null when no show owns `ts`.
 * Bounded to 48 h either way.
 */
function showRunAt(shows, ts) {
  const sorted = byLength(shows);
  const show = _ownerIn(sorted, ts);
  if (!show) return null;
  const t0 = ts - (((ts % 60) + 60) % 60);
  const same = (t) => { const s = _ownerIn(sorted, t); return s && s.id === show.id; };
  let start = t0;
  for (let i = 0; i < 2 * 1440 && same(start - 60); i++) start -= 60;
  let end = t0 + 60;
  for (let i = 0; i < 2 * 1440 && same(end); i++) end += 60;
  return { show, startTs: start, endTs: end };
}

/**
 * THE PIECE that owns `ts`: the clock hour, cut at every show start/end minute inside it (Jeff, 2026-10-18: "the last
 * song before the top of the hour is the last song for that hour so it should be silent after that — the first song of
 * the new hour should always be the first song scheduled for that hour's show" — the silence half was replaced later the
 * same day, see playsStraightInto). { show, startTs, endTs, key }, where
 * show is null when no show owns it. Rows of one piece play in log order. A row of the NEXT piece starts as soon as the
 * row before it ends when both pieces are the same show's on the same day (playsStraightInto); otherwise not before
 * that piece's start.
 */
function pieceAt(shows, ts) {
  const d = new Date(ts * 1000); d.setMinutes(0, 0, 0);
  const hourStart = Math.floor(d.getTime() / 1000);
  const seg = hourSegments(shows, hourStart).find(x => ts >= x.fromTs && ts < x.toTs) || { fromTs: hourStart, toTs: hourStart + 3600, show: null };
  return { show: seg.show, startTs: seg.fromTs, endTs: seg.toTs, key: (seg.show ? seg.show.id : "none") + "@" + seg.fromTs };
}

/**
 * INSIDE A SHOW THE LOG NEVER WAITS FOR :00 (Jeff, 2026-10-18): "When a row ends, the next row plays: the rest of this
 * hour, then the next hour's first row. 'Never run ahead' only means: never play rows from outside the show schedule,
 * never jump past the show's end, never pull rows from another day."
 *
 * Can the log go from a row of piece `a` straight into a row of the later piece `b`, without waiting for b's start?
 * Yes only when both pieces belong to the SAME show, on the SAME local day, and every piece between them is that
 * show's too. A different show, no show, or another day: b's rows wait for b's start.
 */
function playsStraightInto(shows, a, b) {
  if (!a || !b) return false;
  if (a.key === b.key || b.startTs <= a.startTs) return true;
  if (!a.show || !b.show || a.show.id !== b.show.id) return false;
  const day = (ts) => { const d = new Date(ts * 1000); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
  if (day(a.startTs) !== day(b.startTs)) return false;
  let p = a;
  for (let i = 0; i < 200 && p.endTs < b.startTs; i++) {
    p = pieceAt(shows, p.endTs);
    if (!p.show || p.show.id !== a.show.id) return false;
  }
  return true;
}

module.exports = { startMin, endMin, showLength, coversMinute, showAt, hourSegments, showRunAt, pieceAt, playsStraightInto };
