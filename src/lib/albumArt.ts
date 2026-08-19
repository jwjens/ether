// Artwork resolution for anything that can be on air.
//
// THE RULE: a spot is not music, so THE SPOT PATH HAS NO MUSIC-STORE LOOKUP IN IT.
// This is not a guard around a shared lookup — `getSpotArt` below contains no iTunes/Wikipedia
// call to reach. A commercial searched by TITLE against a music store returns a band's album
// cover, which is confidently wrong art; it was wrong from the start, not a missing check.
//
// Spot / imaging chain (JIN, SWP, SPOT):   operator override → embedded cover → nothing (neutral)
// Music chain (everything else):           embedded cover → music store
//
// Route through `resolveArtwork()`. Call sites do not choose the chain themselves.

import { query } from "../db/client";

const _localArtCache: Record<string, string | null> = {};
const _spotArtCache: Record<string, string | null> = {};
const _musicArtCache: Record<string, string | null> = {};

/** Content classes that are imaging/commercials, never music. */
export function isImagingClass(cc: string | null | undefined): boolean {
  return ["JIN", "SWP", "SPOT"].includes(String(cc || "").toUpperCase());
}

/** Embedded cover art for a local file as a data: URL, or null if the file has none
 *  (or isn't a local path). Reads the audio file itself — no network. */
export async function getLocalArt(filePath: string | null | undefined): Promise<string | null> {
  if (!filePath) return null;
  if (filePath in _localArtCache) return _localArtCache[filePath];
  let url: string | null = null;
  try {
    url = (await (window as any).ether?.audio?.embeddedArt?.(filePath)) ?? null;
  } catch { url = null; }
  _localArtCache[filePath] = url;
  return url;
}

/** Music-store artwork by title/artist. MUSIC ONLY — never call this for a spot or imaging.
 *  `resolveArtwork` is the only thing that should be calling it.
 *
 *  RESOLVED IN MAIN as of 2026-08-19 (electron/artwork-cache.js). This used to fetch iTunes straight
 *  from the renderer into an in-memory object — which meant the cache died with every window reload,
 *  so closing and reopening a pop-out re-fetched the entire visible wall, and two windows open at once
 *  each hammered the API independently. Main now owns one disk cache, one provenance row per lookup
 *  (source='itunes', migration v41) and one ~20-calls/minute limiter shared by every window.
 *
 *  The map below stays as an L1: it saves an IPC round trip per repeated tile within a session. It is
 *  no longer the only thing standing between a wall of 3,000 tiles and Apple's rate limit. */
export async function fetchMusicStoreArt(title: string, artist: string): Promise<string | null> {
  const key = `${title}::${artist}`;
  if (_musicArtCache[key] !== undefined) return _musicArtCache[key] || null;
  try {
    const url = (await (window as any).ether?.audio?.musicStoreArt?.(title, artist)) ?? null;
    _musicArtCache[key] = url || "";
    return url;
  } catch { _musicArtCache[key] = ""; return null; }
}

/** Spot-art cache key. STATION-SCOPED, deliberately: two stations can legitimately build a spot on the
 *  SAME audio file (observed 2026-08-05 — station 2 "Commercial Spot" with art, station 3
 *  "11 sec test spot" without). Keying by filePath alone would serve one station's artwork to the other
 *  from cache even after the SQL below is scoped — reproducing the exact bug the scoping closes. */
const spotArtKey = (stationId: number | null | undefined, filePath: string) => `${stationId ?? 0}:${filePath}`;

/** Artwork for a spot / imaging item: the operator's override, else the file's embedded cover,
 *  else nothing. There is deliberately NO music-store fallback in this function. */
export async function getSpotArt(
  filePath: string | null | undefined,
  stationId: number | null | undefined,
): Promise<string | null> {
  if (!filePath) return null;
  const ck = spotArtKey(stationId, filePath);
  if (ck in _spotArtCache) return _spotArtCache[ck];

  // 1 · The artwork the operator set on THIS STATION's spot (v36 spots.art_image, a data URL in the row).
  //
  // STATION-SCOPED. This query used to be `WHERE file_path = ? … LIMIT 1` with no station filter, so a
  // file used as a spot on two stations returned whichever row SQLite handed back — halloVeen could be
  // served Magical Forest's row, whose art_image was NULL, and the tile rendered blank while the
  // operator's uploaded image sat on the sibling row. That is both the blank tile AND a station-isolation
  // violation. ORDER BY is only a tiebreaker WITHIN one station (0 sorts before 1, so a row that HAS art
  // wins) — it must never be the thing that picks between stations.
  let url: string | null = null;
  try {
    const rows = stationId != null
      ? await query<{ art_image: string | null }>(
          "SELECT art_image FROM spots WHERE file_path = ? AND station_id = ? AND deleted_at IS NULL ORDER BY (art_image IS NULL) LIMIT 1",
          [filePath, stationId])
      : [];
    url = rows[0]?.art_image || null;
  } catch { /* no spots row / query failed — fall through to embedded */ }

  // 2 · The file's own embedded cover.
  if (!url) url = await getLocalArt(filePath);

  // 3 · Nothing. The caller renders its neutral treatment.
  _spotArtCache[ck] = url;
  return url;
}

/** True when this file is a spot ON THIS STATION, regardless of what class the caller was handed.
 *  Mirrors App.tsx resolveContentClass's second step, for the paths that carry no contentClass. */
async function isSpotFile(filePath: string | null | undefined, stationId: number | null | undefined): Promise<boolean> {
  if (!filePath || stationId == null) return false;
  if (spotArtKey(stationId, filePath) in _spotArtCache) return true;   // already resolved this session
  try {
    const rows = await query<{ n: number }>(
      "SELECT 1 AS n FROM spots WHERE file_path = ? AND station_id = ? AND deleted_at IS NULL LIMIT 1",
      [filePath, stationId]
    );
    return rows.length > 0;
  } catch { return false; }
}

/**
 * THE single entry point for on-air artwork. Routes to the spot chain or the music chain.
 *
 * A caller that knows the content class passes it. A caller that doesn't (the now-playing
 * pop-out) passes null and the file is checked against the spots table, so a spot can never
 * fall through to the music chain just because a relay dropped a field.
 */
export async function resolveArtwork(
  filePath: string | null | undefined,
  contentClass: string | null | undefined,
  title: string,
  artist: string,
  stationId: number | null | undefined,
): Promise<string | null> {
  if (isImagingClass(contentClass)) return getSpotArt(filePath, stationId);
  if (contentClass == null && await isSpotFile(filePath, stationId)) return getSpotArt(filePath, stationId);
  return (await getLocalArt(filePath)) || (await fetchMusicStoreArt(title, artist));
}

/** Drop cached spot artwork so a freshly-saved override shows up without a restart.
 *  Called by the Spots panel after a save. Station-scoped like the cache itself; omit the station to
 *  clear that file for EVERY station, and omit both to clear everything. */
export function clearSpotArtCache(filePath?: string | null, stationId?: number | null): void {
  if (filePath && stationId != null) { delete _spotArtCache[spotArtKey(stationId, filePath)]; return; }
  if (filePath) {
    // No station given — drop this file for every station rather than silently missing the right key.
    const suffix = `:${filePath}`;
    for (const k of Object.keys(_spotArtCache)) if (k.endsWith(suffix)) delete _spotArtCache[k];
    return;
  }
  for (const k of Object.keys(_spotArtCache)) delete _spotArtCache[k];
}
