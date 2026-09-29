// wedge-judge.js — the per-station silent-wedge VERDICT, one pure function (used by main.js
// startAudioLivenessWatchdog; tested by scripts/smoke-wedge-judge.js).
//
// THE RULE (OV dead air on 4.6.51): a STALE CPAL CALLBACK IS A WEDGE, whatever the levels say. When the output
// callback stops, the engine's dispatch thread keeps re-publishing the LAST meter frame, so the level meter keeps
// reporting the last (non-zero) value and "levels fresh" is a lie. The old watchdog skipped any station whose
// levels looked fresh BEFORE it read the callback stamp — so OV sat 19.5 minutes silent with the detector
// suppressing. Now the callback stamp is read first, and levels are consulted only when the engine cannot report
// a stamp at all (an engine too old to have one).
"use strict";

/** The callback stamp older than this = the output callback has stopped. */
const CB_STALE_MS = 3000;
/** Levels older than this = the levels hint says silent (used ONLY when there is no callback stamp). */
const LEVELS_STALE_MS = 6000;
/** enginestate=live may hold a levels-only verdict this long (it is rotation bookkeeping, not proof of PCM). */
const ENGINE_LIVE_CEILING_MS = 12000;

/**
 * @param {object} a
 * @param {number|null} a.cbStaleMs   ms since this station's last output callback; null = the engine can't say
 * @param {number} a.levelsAgeMs      ms since this station's levels last showed audio (Infinity = never)
 * @param {boolean} a.playing         a deck reports "playing"
 * @param {boolean} a.engineLive      the daemon's enginestate for this station is "live"
 * @param {number} a.wedgeMs          how long this station has already been held as a wedge candidate
 * @returns {{verdict: "healthy"|"idle"|"held"|"wedge", reason: string}}
 */
function judge({ cbStaleMs, levelsAgeMs, playing, engineLive, wedgeMs }) {
  // 1 · AUTHORITATIVE: the callback stamp. Stale = the card stopped calling back — a wedge now, no hold:
  //     not by fresh levels (they re-report the last frame), not by enginestate (rotation, not PCM).
  if (cbStaleMs != null && cbStaleMs >= CB_STALE_MS) {
    return { verdict: "wedge", reason: `cpal callback STALE ${cbStaleMs}ms (levels ${fmt(levelsAgeMs)} not trusted: a stopped callback re-reports its last meter frame)` };
  }
  // 2 · Fresh callback = the output is being called. Silence here is the programme's (or the station is idle).
  if (cbStaleMs != null) return { verdict: "healthy", reason: `cpal callback fresh (${cbStaleMs}ms)` };
  // 3 · No stamp (an engine that cannot report one): the old levels-based judgement, unchanged.
  if (levelsAgeMs < LEVELS_STALE_MS) return { verdict: "healthy", reason: `no callback stamp; levels fresh (${fmt(levelsAgeMs)})` };
  if (!playing) return { verdict: "idle", reason: "no callback stamp; nothing playing" };
  if (engineLive && wedgeMs < ENGINE_LIVE_CEILING_MS) return { verdict: "held", reason: `no callback stamp; enginestate=live, wedge ${wedgeMs}ms < ceiling` };
  return { verdict: "wedge", reason: `no callback stamp; levels stale ${fmt(levelsAgeMs)} while playing` };
}
const fmt = (ms) => (ms === Infinity || ms == null ? "never" : `${Math.round(ms)}ms`);

module.exports = { judge, CB_STALE_MS, LEVELS_STALE_MS, ENGINE_LIVE_CEILING_MS };
