'use strict';
// electron/announce-time.js — the announcement scheduler's pure time arithmetic (2026-10-04).
//
// Pulled out of main.js so it can be tested: main.js only loads under Electron. main.js's dueTimeFor
// calls offsetDueTime for "before closing" lines, and the fire path calls repeatStartsMs.
//
// SECONDS ON BEFORE-CLOSING LINES. Jeff: the top-of-hour announcement and the legal ID played over each
// other, and a before-closing line could only move in whole minutes. close_offset_sec (migration v62)
// carries the seconds. They take the MINUTES' sign — "-30 min 15 s" is thirty minutes fifteen seconds
// BEFORE close, the way it reads — and when the minutes are 0 the seconds keep their own sign.
//
// PLAYS IN A ROW. play_count (v62) on a schedule line: ×3 means the announcement plays three times back
// to back. Each repeat starts when the previous one ENDS, plus REPEAT_GAP_MS, timed from the file's own
// length. A file whose length cannot be read plays ONCE — guessing a length risks starting a repeat on
// top of the play before it.

const MAX_PLAY_COUNT = 20;
/** Silence between back-to-back plays — enough that the end of one is never clipped by the next load. */
const REPEAT_GAP_MS = 500;

function hhmmToSeconds(t) {
  if (!t || typeof t !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]), s = m[3] ? Number(m[3]) : 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
}

function secondsToHms(n) {
  const w = ((n % 86400) + 86400) % 86400;   // wrap, so 15 minutes after a midnight close is 00:15:00
  const p = (x) => String(x).padStart(2, '0');
  return p(Math.floor(w / 3600)) + ':' + p(Math.floor(w % 3600 / 60)) + ':' + p(w % 60);
}

/** Signed offset in seconds: minutes, plus seconds carrying the minutes' sign. */
function offsetSeconds(offsetMin, offsetSec) {
  const m = Math.trunc(Number(offsetMin) || 0);
  const s = Math.trunc(Number(offsetSec) || 0);
  if (m < 0) return m * 60 - Math.abs(s);
  if (m > 0) return m * 60 + Math.abs(s);
  return s;
}

/** The clock time a before-closing line fires at, 'HH:MM:SS', or null when there is no closing time. */
function offsetDueTime(closingHHMM, offsetMin, offsetSec) {
  const base = hhmmToSeconds(closingHHMM);
  if (base == null) return null;
  return secondsToHms(base + offsetSeconds(offsetMin, offsetSec));
}

function clampPlayCount(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PLAY_COUNT);
}

/** Start times (ms after the first play started) of the 2nd..nth plays. [] when there is nothing to repeat
 *  or the length is unknown. */
function repeatStartsMs(durationSec, playCount) {
  const n = clampPlayCount(playCount);
  const d = Number(durationSec);
  if (n <= 1 || !Number.isFinite(d) || d <= 0) return [];
  const step = Math.round(d * 1000) + REPEAT_GAP_MS;
  return Array.from({ length: n - 1 }, (_, i) => (i + 1) * step);
}

module.exports = { offsetDueTime, offsetSeconds, repeatStartsMs, clampPlayCount, hhmmToSeconds, secondsToHms, REPEAT_GAP_MS, MAX_PLAY_COUNT };
