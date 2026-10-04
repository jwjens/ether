// ── HOUR JOIN — the new hour plays after the song that crosses :00 (2026-10-04) ──────────────────────
//
// Jeff's ruling: there is no top-of-hour hard cut. At :00 no deck is stopped and the queue is not
// cleared; the song crossing the hour plays to its end and the new hour JOINS after it.
//
// Generate lets each hour's last song overrun :00 (electron/generate-core.js), so at every hour the new
// hour's first rows have their slots pass while the old song is still on air. The time-anchored reader
// (loggen.selectRowForNow) picks the LATEST pending row whose slot has arrived and stamps every earlier
// one `missed` — left alone, it would skip the 13:00:00 legal ID and a 13:00:10 spot straight to the
// 13:00:40 song. The hard cut used to hide that by re-reading the log from the hour boundary.
//
// This module decides when that skip must not happen. It is PURE (no DB, no clock of its own) and
// returns a WINDOW of scheduled_at in which the reader must take the EARLIEST pending row instead of
// its latest-arrived candidate — or null, which leaves the reader's ordinary catch-up untouched.
//
//   Not joined yet — the playing row belongs to the PREVIOUS hour (the crossing song) and nothing of
//     the candidate's hour has aired: window [hourStart, candidate). The head of the hour is next.
//   Joined late — the hour's first aired row went on air after its slot (the overrun): window
//     (firstAired.scheduledAt, firstAired.playedAt]. Rows whose slots passed during the overrun play
//     in order; after them the ordinary catch-up resumes.
//
// Bounded by MAX_JOIN_LATE_SEC so a stale `playing` row (a station stopped for hours) can never drag
// the reader back to an old hour top.
"use strict";

const MAX_JOIN_LATE_SEC = 900;   // 15 min — longer than any song that can cross the hour

/** Local start of the hour containing ts (epoch seconds). Local, like the station's clock. */
function hourStartOf(ts) {
  const d = new Date(ts * 1000);
  d.setMinutes(0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * @param {object} p
 * @param {number} p.nowTs        wall clock, epoch seconds
 * @param {number} p.candidateTs  scheduled_at of the reader's latest-arrived pending row
 * @param {number|null} p.playingTs  scheduled_at of the row on air (state 'playing'), or null
 * @param {{scheduledAt:number, playedAt:number|null}|null} p.firstAired  earliest aired row
 *        (played/playing) scheduled inside the candidate's hour, or null when none has aired
 * @returns {{fromTs:number, toTs:number, fromInclusive:boolean}|null}  pick the earliest pending row
 *        with fromTs <(=) scheduled_at < min(toTs+1, candidateTs); null = no join, keep the candidate
 */
function joinWindow({ nowTs, candidateTs, playingTs, firstAired }) {
  if (!Number.isFinite(candidateTs)) return null;
  const H = hourStartOf(candidateTs);
  if (!firstAired) {
    if (!Number.isFinite(playingTs)) return null;                 // nothing crossing the hour
    if (!(playingTs < H && playingTs >= H - 3600)) return null;   // the crossing song is the previous hour's
    if (nowTs - H > MAX_JOIN_LATE_SEC) return null;               // stale playing row — ordinary catch-up
    return { fromTs: H, toTs: candidateTs, fromInclusive: true };
  }
  const { scheduledAt, playedAt } = firstAired;
  if (!Number.isFinite(playedAt) || !(playedAt > scheduledAt)) return null;   // joined on time
  if (playedAt - H > MAX_JOIN_LATE_SEC) return null;
  return { fromTs: scheduledAt, toTs: Math.min(playedAt, candidateTs), fromInclusive: false };
}

module.exports = { joinWindow, hourStartOf, MAX_JOIN_LATE_SEC };
