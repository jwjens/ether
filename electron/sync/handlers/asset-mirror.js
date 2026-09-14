'use strict';
// electron/sync/handlers/asset-mirror.js — ONE definition of "an audio row is also a library asset".
//
// Jeff, 2026-09-14: "make the asset row structural at the handler layer, not per table. Three
// readers, two forgetful writers is the copy-on-import shape again, and spots prove it belongs lower
// than songsCreate."
//
// WHAT WENT WRONG, TWICE, THE SAME WAY. Three panels list their content by INNER JOINing
// library_asset:
//     SweepersPanel.tsx:113   FROM library_asset la JOIN songs s ON s.uuid = la.uuid  ... type='SWEEPER'
//     Spots.tsx:87            FROM library_asset la JOIN spots s ON s.uuid = la.uuid
//     Announcements           (same shape)
// v50 backfilled library_asset AT MIGRATION TIME and nothing maintained it afterwards, except
// announcements.js, which mirrors its own by hand. So songsCreate and spotsCreate each produced a row
// their own panel could not see: the import reported success, the audio landed in the catalogue, and
// the list stayed empty. Two separate days of hunting, one cause.
//
// THE FIX IS NOT "REMEMBER IN THREE PLACES". It is one function, driven by the REGISTRY, plus a guard
// that fails if a table declares itself audio-bearing and its handler does not call this. Forgetting
// stops being invisible — which is the only property that actually holds over time.
//
// IDENTITY: the asset uuid IS the row's uuid. v50 chose that deliberately ("A song's uuid is REUSED
// as the asset uuid") so the two can never drift apart and no join needs a mapping table.
//
// NOT MUTATION-LOGGED FROM HERE. assetCreate/assetUpdate journal their own mutations through
// withMutation; this module only decides WHEN to call them and with what type.

const libraryAsset = require('./library_asset');
const { REGISTRY } = require('../synced-tables');

/** Tables that are audio-bearing, and the library_asset.type each maps to. Read from the REGISTRY so
 *  there is one list, not a copy that drifts. */
function assetTypeFor(tableName) {
  const entry = REGISTRY[tableName];
  return entry && entry.assetType ? entry.assetType : null;
}

/** Every table the registry says is audio-bearing. Used by the guard and by the backfills. */
function audioBearingTables() {
  return Object.entries(REGISTRY)
    .filter(([, e]) => e && e.assetType)
    .map(([wireName, e]) => ({ table: wireName, assetType: e.assetType }));
}

/**
 * Mirror a created/updated row into library_asset. Safe to call for any table: a table the registry
 * does not mark audio-bearing is a no-op, so a caller never has to ask whether it applies.
 *
 * NEVER THROWS. A panel being unable to list something is bad; an import failing outright because a
 * mirror write failed is worse, and the caller has already committed the real row. Failures are
 * logged loudly and reported in the return value so a caller that WANTS to surface them can.
 */
function mirrorAsset(db, tableName, row, opts = {}) {
  // opts.type lets a caller state the type explicitly. songs needs it: every song is mirrored as
  // SONG on create, and MARKING one a sweeper later has to re-type the asset — otherwise the cut is
  // a sweeper in `songs` and a SONG in `library_asset`, and the Sweepers panel (which filters on the
  // ASSET type) still cannot see it. Same defect, one layer along.
  const type = opts.type || assetTypeFor(tableName);
  if (!assetTypeFor(tableName)) return { ok: true, skipped: 'not_audio_bearing' };
  if (!row || !row.uuid) return { ok: false, error: 'row has no uuid — cannot mirror without identity' };

  const title = row.title || row.name || '(untitled)';
  const patch = {
    title,
    file_path:   row.file_path ?? null,
    file_key:    row.file_key ?? null,
    duration_ms: row.duration_ms ?? (row.length_sec != null ? Math.round(row.length_sec * 1000) : null),
  };

  try {
    const existing = libraryAsset.assetGet(db, row.uuid);
    if (existing) {
      // assetUpdate carries its own no-op guard, so an unchanged title/path journals nothing.
      libraryAsset.assetUpdate(db, row.uuid, opts.retype === false ? patch : { ...patch, type });
      return { ok: true, updated: true };
    }
    libraryAsset.assetCreate(db, { uuid: row.uuid, type, ...patch });
    return { ok: true, created: true };
  } catch (e) {
    console.error(`[asset-mirror] ${tableName} ${row.uuid} could not be mirrored: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** A row is going away. The asset goes with it — otherwise the panels list a ghost. */
function mirrorAssetDelete(db, tableName, uuid) {
  if (!assetTypeFor(tableName) || !uuid) return { ok: true, skipped: true };
  try {
    if (libraryAsset.assetGet(db, uuid)) libraryAsset.assetDelete(db, uuid);
    return { ok: true };
  } catch (e) {
    console.error(`[asset-mirror] ${tableName} ${uuid} could not be un-mirrored: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** `songs.content_class` is the operator-facing marking; library_asset.type is what the panels
 *  filter on. ONE mapping, here, so a new class cannot mean two different things in two files. */
function assetTypeForContentClass(cls) {
  switch (String(cls || '').toUpperCase()) {
    case 'SWP':  return 'SWEEPER';
    case 'SPOT': return 'SPOT';
    default:     return 'SONG';
  }
}

module.exports = { mirrorAsset, mirrorAssetDelete, assetTypeFor, audioBearingTables, assetTypeForContentClass };
