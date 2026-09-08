'use strict';
// electron/sweeper-pool.js — WHICH CUTS ARE IN A POOL. One answer, one place.
//
// This existed inline in main.js as a prepared statement inside _placeJingles. It is a module now for
// two reasons, and the second is the important one:
//
//   1. v55 moves membership from `songs.jingle_category_id` (one integer on a SHARED song row, so one
//      cut could be in exactly one pool owned by exactly one station) to `sweeper_pool_member`, a join
//      table keyed on the asset uuid. A cut can now be in several stations' pools at once, which is
//      what "one library, many uses" has always meant for songs.
//   2. So that the verification harness runs THE REAL QUERY rather than a copy of it. A test that
//      reimplements the thing it is testing proves the reimplementation.
//
// THE ORDERING IS LOAD-BEARING AND IS NOT TOUCHED. Least-recently-played first, id as the tiebreak —
// the same ORDER BY, the same correlated play_log subquery, the same station scoping. _placeJingles
// resolves this ONCE per run and caches it (the 2026-08-06 Generate freeze: 898ms per call x452 rows);
// nothing here re-queries per row.
//
// LEGACY FALLBACK IS DELIBERATE. A database that has not run v55 — a rollback to a previous build, or
// a profile restored from before the migration — still has the old column and no join table. This
// module picks the shape the database actually has, so an older DB keeps working instead of losing
// every pool. Robustness rule: open ANY state a prior or future build made.

/** The candidate columns and ordering, shared by both shapes so they cannot drift apart. */
// `cue_out` / `outro_start` / `duration_ms` are here because AUTO-POST measures a cut by its AUDIBLE
// END FROM FILE START — not by a trimmed length. The engine plays every file from sample 0, so firing
// at `post - cut_end` puts the last audible moment on the post with no seek and no engine change; any
// leading silence simply plays silently inside the intro. cue_out is the operator's mark, outro_start
// the analyser's, duration the fallback — see audibleEndMs below.
const SELECT_COLS = `s.id, s.title, a.name AS artist_name, s.file_path, s.duration_ms, s.content_class,
       s.cue_out, s.cue_out_ms, s.outro_start`;
const FILTERS = `s.content_class = ? AND s.file_path IS NOT NULL
        AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')`;
const ORDER = `ORDER BY COALESCE((SELECT MAX(pl.played_at) FROM play_log pl
               WHERE pl.file_path = s.file_path AND pl.station_id = ? AND pl.deleted_at IS NULL), 0) ASC, s.id ASC`;

/** v55 and later — membership is a join table, so a cut can be in many pools. */
const MEMBER_SQL = `SELECT ${SELECT_COLS}
       FROM sweeper_pool_member m
       JOIN songs s ON s.uuid = m.asset_uuid
       LEFT JOIN artists a ON a.id = s.artist_id
      WHERE m.pool_id = ? AND m.deleted_at IS NULL
        AND ${FILTERS}
      ${ORDER}`;

/** Pre-v55 — one integer on the song row. Kept verbatim, including the absence of a deleted_at check
 *  on songs: adding a filter here would change which cuts a pool returns, and this shape exists to
 *  reproduce the old behaviour exactly, not to improve it. */
const LEGACY_SQL = `SELECT ${SELECT_COLS}
       FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
      WHERE s.jingle_category_id = ? AND ${FILTERS}
      ${ORDER}`;

function hasMemberTable(db) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sweeper_pool_member'").get();
  } catch { return false; }
}

/**
 * Prepare the pool-candidate reader for a database, picking the shape that database actually has.
 * Returns { shape: 'member'|'legacy', all(poolId, contentClass, stationId) → rows in play order }.
 * `force` ('member' | 'legacy') is for the verification harness, which runs both against one file.
 */
function preparePoolCandidates(db, force) {
  const shape = force || (hasMemberTable(db) ? 'member' : 'legacy');
  const stmt = db.prepare(shape === 'member' ? MEMBER_SQL : LEGACY_SQL);
  return {
    shape,
    all(poolId, contentClass, stationId) {
      try { return stmt.all(poolId, contentClass, stationId); } catch { return []; }
    },
  };
}

/**
 * The AUDIBLE END of a cut, in ms from file start. Operator mark first, analyser second, whole file
 * last — and each fallback is a real answer, not a guess: a file with no marks at all IS audible to its
 * final sample as far as anything here knows.
 */
function audibleEndMs(row) {
  if (!row) return null;
  if (row.cue_out_ms != null && row.cue_out_ms > 0) return Math.round(row.cue_out_ms);
  if (row.cue_out    != null && row.cue_out    > 0) return Math.round(row.cue_out * 1000);
  if (row.outro_start != null && row.outro_start > 0) return Math.round(row.outro_start * 1000);
  return row.duration_ms != null ? Math.round(row.duration_ms) : null;
}

/**
 * AUTO-POST SELECTION. A cut qualifies when its audible end fits inside the intro with the segue
 * overlap held back:
 *
 *     audibleEnd <= post - segueOverlap
 *
 * The subtraction is what keeps a sweeper off BOTH songs. Off the incoming, because the cut ends at or
 * before the vocal. Off the OUTGOING, because the incoming starts when the outgoing has segueOverlap
 * left to run, so a cut that fits inside `post - segueOverlap` fires at or after the moment the
 * outgoing finishes — measured on the deck, not assumed. Jeff's ruling, 2026-09-08: strict, not clever.
 *
 * Returns the candidates in the order given (least-recently-played first), filtered. Never reorders:
 * rotation is the caller's, and a filter that also sorted would quietly change which cut repeats.
 */
function qualifyingCandidates(cands, postMs, segueOverlapSec) {
  const room = postMs - Math.round((segueOverlapSec || 0) * 1000);
  if (!(room > 0)) return [];
  const out = [];
  for (const c of cands || []) {
    const end = audibleEndMs(c);
    if (end != null && end <= room) out.push(c);
  }
  return out;
}

module.exports = { preparePoolCandidates, MEMBER_SQL, LEGACY_SQL, hasMemberTable,
                   audibleEndMs, qualifyingCandidates };
