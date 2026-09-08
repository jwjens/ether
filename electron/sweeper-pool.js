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
const SELECT_COLS = `s.id, s.title, a.name AS artist_name, s.file_path, s.duration_ms, s.content_class`;
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

module.exports = { preparePoolCandidates, MEMBER_SQL, LEGACY_SQL, hasMemberTable };
