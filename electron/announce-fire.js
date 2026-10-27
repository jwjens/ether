// electron/announce-fire.js — WHEN a scheduled announcement line may still fire, and when it is skipped (Jeff,
// 2026-10-26: "how late an announcement may still fire is a user setting (replacing the fixed 120 seconds), and a
// skipped announcement shows that it was skipped and why").
//
// Before: a line fired only when the tick's clock read EXACTLY its second; a tick that came late (main busy) never saw
// that second and the line was dropped without a word. A fired line was kept from firing again for a fixed 120 s.
// Now:
//   · a line may fire from its time until its time + the station's LATE LIMIT (station_config_kv
//     `announce_late_limit_sec`, Announcements → "Late limit"). Not set = 0 s: only inside its own second, exactly as
//     before — nothing new is assumed;
//   · "already fired" is: its last_played_at is at or after this scheduled time (it fired for this time), which is what the
//     fixed 120 s stood in for, now as long as the window is. Plays-in-a-row (play_count) are NOT this: they are timed
//     repeats main schedules after a fire (electron/main.js _scheduleAnnounceRepeats), untouched by any of this;
//   · past the window, unplayed, it is SKIPPED: said once, with the reason, in ether-startup.log, the health log and on
//     the line itself (skipped_at + the reason).
"use strict";

const LATE_LIMIT_KEY = "announce_late_limit_sec";
const LATE_LIMIT_RANGE = [0, 3600];

/** The stored late limit, in whole seconds, or null when it is not set or not a valid number (never a guess). */
function parseLateLimit(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < LATE_LIMIT_RANGE[0] || n > LATE_LIMIT_RANGE[1]) return null;
  return Math.round(n);
}

/** Local midnight of 'YYYY-MM-DD', epoch seconds. */
function dayStartEpoch(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
}
/** 'YYYY-MM-DD' + 'HH:MM:SS' local → epoch seconds. */
function dueEpoch(dateStr, hms) {
  const [h, mi, s] = String(hms).split(":").map(Number);
  return dayStartEpoch(dateStr) + h * 3600 + mi * 60 + (s || 0);
}
const hmsOf = (epochSec) => new Date(epochSec * 1000).toTimeString().slice(0, 8);

/**
 * One line, one tick. Returns one of:
 *   { action: "none" }                 — nothing to do (not due yet, already fired for this time, no time, skip already said)
 *   { action: "fire", lateSec }        — fire it now (lateSec 0 = on its own second)
 *   { action: "skip", why, lateSec }   — its window has passed unplayed: record the skip and say why
 *
 * row:        { uuid, last_played_at, skipped_at }
 * dateStr:    the date the line is filed under;  due: 'HH:MM:SS' it fires at on that date, or null
 * nowSec:     epoch seconds now;  lateLimit: the station's late limit in seconds, or null (not set → 0)
 * startedSec: when this Ether's scheduler started;  prevDue: the due time this line had when last looked at this session
 * seenSec:    when this session first saw the line
 */
function decide({ row, dateStr, due, nowSec, lateLimit, startedSec, prevDue, seenSec }) {
  if (!due) return { action: "none" };
  const at = dueEpoch(dateStr, due);
  if (nowSec < at) return { action: "none" };
  if (row.last_played_at && row.last_played_at >= at) return { action: "none" };   // fired for this time
  const limit = lateLimit == null ? 0 : lateLimit;
  const lateSec = nowSec - at;
  if (lateSec <= limit) return { action: "fire", lateSec };
  if (row.skipped_at && row.skipped_at >= at) return { action: "none" };           // its skip is already recorded
  const limitText = lateLimit == null ? "the late limit is not set, so it fires only on its own second"
                                      : `the late limit is ${limit} s`;
  let why;
  if (startedSec != null && startedSec > at + limit) why = `Ether started at ${hmsOf(startedSec)}, after its time ${due}; ${limitText}`;
  else if (prevDue && prevDue !== due && dueEpoch(dateStr, prevDue) > nowSec) why = `the closing time moved its time from ${prevDue} to ${due}, which had already passed; ${limitText}`;
  else if (seenSec != null && seenSec > at + limit) why = `it reached today's schedule at ${hmsOf(seenSec)}, after its time ${due}; ${limitText}`;
  else why = `it was checked ${lateSec} s after its time (Ether was busy); ${limitText}`;
  return { action: "skip", why, lateSec };
}

/** The session's memory the tick keeps between ticks. */
function createTickState(startedSec) {
  return { seen: new Map(), skipSaid: new Set(), startedSec: startedSec == null ? null : startedSec };
}

/**
 * One station's lines for one date, one tick — the loop main's announceTick runs (electron/main.js), here so it is tested
 * exactly as it runs.
 *   judge: false for yesterday's lines (a late limit past midnight): they may fire, never be skipped again
 *   dueOf(row) → 'HH:MM:SS' | null;  fire(row, { due, lateSec }) → Promise;  skip(row, due, why)
 */
async function processRows({ rows, dateStr, judge, dueOf, nowSec, lateLimit, state, fire, skip }) {
  for (const row of rows) {
    const due = dueOf(row);
    const seen = state.seen.get(row.uuid);
    const d = decide({ row, dateStr, due, nowSec, lateLimit, startedSec: state.startedSec,
                       prevDue: seen && seen.due, seenSec: seen ? seen.seenSec : nowSec });
    state.seen.set(row.uuid, { due, seenSec: seen ? seen.seenSec : nowSec });
    if (d.action === "skip") {
      const key = `${row.uuid}|${dateStr}|${due}`;
      if (!judge || state.skipSaid.has(key)) continue;
      state.skipSaid.add(key);
      skip(row, due, d.why);
      continue;
    }
    if (d.action === "fire") await fire(row, { due, lateSec: d.lateSec });
  }
}

module.exports = { LATE_LIMIT_KEY, LATE_LIMIT_RANGE, parseLateLimit, decide, dayStartEpoch, dueEpoch, createTickState, processRows };
