// ── runway.js — how much log a station actually has left (2026-08-11) ───────────────────────────
//
// ONE implementation, required by both the auto-extend engine (main.js) and the Health Monitor gauge
// (library-health.js). They previously each had their own copy of the arithmetic, which is how the
// screen and the engine come to disagree. The finishGenerateRun lesson, applied before it bites.
//
// ── WHY "MAX(scheduled_at) - now" IS THE WRONG MEASURE ─────────────────────────────────────────
//
// It counts straight past a HOLE. A station with rows through Friday but nothing tomorrow at 03:00
// reports four days of runway when its real runway is one — and on a flipped station, where
// generated_schedule IS playout, that hole is dead air. The old measure could not see the only
// failure it existed to prevent.
//
// So: runway is the distance to the FIRST HOUR THAT SHOULD HAVE ROWS AND HAS NONE.
//
// ── "SHOULD HAVE" IS THE OTHER HALF ────────────────────────────────────────────────────────────
//
// An hour no show covers is not a gap. A station running 06:00-00:00 has no 03:00 rows by design,
// and a gauge that reported a cliff every night would be trained away within a week. Coverage is
// read from the same shows table Generate reads, with the same semantics (JS-day digits in `days`,
// end_hour 0 meaning "through midnight"), so the gauge and the generator agree about what is
// supposed to exist rather than holding two opinions.
//
// A station with NO active show returns grey / days null: nothing is meant to air, so nothing is
// starving. A red gauge on an unconfigured station is the false alarm that teaches people to ignore
// the gauge.
"use strict";

const HOUR = 3600;
/** How far ahead to look before declaring the runway simply "deep". 30 days is well past any
 *  sensible auto-extend target, so a capped result means healthy, not unknown. */
const SCAN_DAYS = 30;

/** Mirrors the show-hour semantics Generate uses (see stmtShows' ORDER BY in generate-core.js):
 *  end_hour 0 with start_hour 0, or end_hour == start_hour, is a full 24 hours; end_hour 0 with a
 *  start is "start through midnight"; otherwise a plain range, wrapping midnight when end < start. */
function showCoversHour(show, hour) {
  const s = show.start_hour | 0, e = show.end_hour | 0;
  if (e === s) return true;              // covers 0-0 (all day) and any full-24h show
  if (e === 0) return hour >= s;         // start .. midnight
  if (e > s) return hour >= s && hour < e;
  return hour >= s || hour < e;          // wraps midnight
}

/**
 * @returns {{metric:'first-gap', days:number|null, hours:number|null, level:'green'|'yellow'|'red'|'grey',
 *            gapAt:number|null, through:number|null, capped:boolean, reason?:string}}
 *   days/hours null only when level is 'grey'. gapAt is the epoch second of the first missing hour.
 */
function computeRunway(db, stationId, nowSec) {
  const now = nowSec != null ? nowSec : Math.floor(Date.now() / 1000);
  try {
    const shows = db.prepare(
      `SELECT start_hour, end_hour, days FROM shows
        WHERE station_id = ? AND is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL`
    ).all(stationId) || [];
    if (!shows.length) {
      return { metric: 'first-gap', days: null, hours: null, level: 'grey', gapAt: null, through: null, capped: false, reason: 'no active show' };
    }

    const startHour = Math.floor(now / HOUR);              // the hour we are inside right now
    const endHour = startHour + SCAN_DAYS * 24;
    // One query, then an in-memory walk: 720 buckets is nothing, and this keeps the DB work O(1)
    // regardless of how deep the log runs.
    const filled = new Set(
      (db.prepare(
        `SELECT DISTINCT CAST(scheduled_at / ${HOUR} AS INTEGER) hr
           FROM generated_schedule
          WHERE station_id = ? AND deleted_at IS NULL AND scheduled_at >= ? AND scheduled_at < ?`
      ).all(stationId, startHour * HOUR, endHour * HOUR) || []).map(r => r.hr)
    );

    let gapAt = null;
    for (let h = startHour; h < endHour; h++) {
      if (filled.has(h)) continue;
      const d = new Date(h * HOUR * 1000);
      const day = String(d.getDay());
      const localHour = d.getHours();
      const covered = shows.some(s => (s.days || '').includes(day) && showCoversHour(s, localHour));
      if (!covered) continue;                              // nothing is meant to air here — not a gap
      gapAt = h * HOUR;
      break;
    }

    const capped = gapAt === null;
    const sec = Math.max(0, (capped ? endHour * HOUR : gapAt) - now);
    const through = (db.prepare(
      "SELECT MAX(scheduled_at) m FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL"
    ).get(stationId) || {}).m || null;

    const days = Math.round((sec / 86400) * 10) / 10;
    // green >= 5 days, yellow < 3, red < 1. 3-5 is green: the auto-extend trigger sits inside the
    // green band on purpose, so a gauge that goes yellow means auto-extend is FAILING, not that the
    // system is working as designed.
    const level = days < 1 ? 'red' : days < 3 ? 'yellow' : 'green';
    return { metric: 'first-gap', days, hours: Math.round(sec / 360) / 10, level, gapAt, through, capped };
  } catch (e) {
    // Never throw at a caller: the gauge is an observer, and auto-extend must not be broken by it.
    return { metric: 'first-gap', days: null, hours: null, level: 'grey', gapAt: null, through: null, capped: false, reason: 'unavailable' };
  }
}

/** Seconds of runway — the shape the auto-extend engine consumed from its old local helper. */
function runwaySec(db, stationId, nowSec) {
  const r = computeRunway(db, stationId, nowSec);
  if (r.days == null) return 0;
  return Math.round(r.days * 86400);
}

module.exports = { computeRunway, runwaySec, showCoversHour, SCAN_DAYS };
