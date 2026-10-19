// audiod/segue-overlap.js — THE station's segue overlap, read one way by everything that needs it.
//
// The engine starts the next song this many seconds before the song on air ends (engine.js _segueTick), music → music
// only — never into or out of a spot (clean spot edges). Generate times the log with the SAME number (Jeff, 2026-10-18:
// "All timing uses each song's real segue/overlay point, not its file length"), so the log's hour adds up to what
// actually airs. The number is the operator's: station_config_kv 'segue_overlap_sec' (Settings), 0..10 s.
"use strict";

const MAX_SEGUE_OVERLAP_S = 10;

/** The station's segue overlap in seconds, or null when the station has not set one. Never throws. */
function readSegueOverlapSec(db, stationId) {
  try {
    const row = db.prepare(
      "SELECT value FROM station_config_kv WHERE station_id=? AND key='segue_overlap_sec' AND deleted_at IS NULL"
    ).get(stationId);
    if (!row || row.value == null || row.value === "") return null;
    const v = parseInt(row.value, 10);
    if (isNaN(v)) return null;
    return Math.max(0, Math.min(MAX_SEGUE_OVERLAP_S, v));
  } catch { return null; }
}

/** How far the next item starts before this one ends: the overlap between two songs, 0 at a spot edge. */
function overlapBetween(prevClass, nextClass, overlapSec) {
  const music = (c) => !c || String(c).toUpperCase() === "MUSIC";
  return music(prevClass) && music(nextClass) ? (overlapSec || 0) : 0;
}

module.exports = { readSegueOverlapSec, overlapBetween, MAX_SEGUE_OVERLAP_S };
