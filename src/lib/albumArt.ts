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
 *  `resolveArtwork` is the only thing that should be calling it. */
export async function fetchMusicStoreArt(title: string, artist: string): Promise<string | null> {
  const key = `${title}::${artist}`;
  if (_musicArtCache[key] !== undefined) return _musicArtCache[key] || null;
  try {
    const q = encodeURIComponent(`${title} ${artist}`.replace(/\(feat\..*?\)/gi, "").replace(/\s*[-–]\s*remaster.*/gi, "").trim());
    const r = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`);
    const d = await r.json();
    const url = d?.results?.[0]?.artworkUrl100?.replace("100x100bb", "60x60bb") ?? null;
    _musicArtCache[key] = url || "";
    return url;
  } catch { _musicArtCache[key] = ""; return null; }
}

/** Artwork for a spot / imaging item: the operator's override, else the file's embedded cover,
 *  else nothing. There is deliberately NO music-store fallback in this function. */
export async function getSpotArt(filePath: string | null | undefined): Promise<string | null> {
  if (!filePath) return null;
  if (filePath in _spotArtCache) return _spotArtCache[filePath];

  // 1 · The artwork the operator set on this spot (v36 spots.art_image, a data URL in the row).
  let url: string | null = null;
  try {
    const rows = await query<{ art_image: string | null }>(
      "SELECT art_image FROM spots WHERE file_path = ? AND deleted_at IS NULL LIMIT 1", [filePath]
    );
    url = rows[0]?.art_image || null;
  } catch { /* no spots row / query failed — fall through to embedded */ }

  // 2 · The file's own embedded cover.
  if (!url) url = await getLocalArt(filePath);

  // 3 · Nothing. The caller renders its neutral treatment.
  _spotArtCache[filePath] = url;
  return url;
}

/** True when this file is a spot by storage, regardless of what class the caller was handed.
 *  Mirrors App.tsx resolveContentClass's second step, for the paths that carry no contentClass. */
async function isSpotFile(filePath: string | null | undefined): Promise<boolean> {
  if (!filePath) return false;
  if (filePath in _spotArtCache) return true;   // already resolved as a spot this session
  try {
    const rows = await query<{ n: number }>(
      "SELECT 1 AS n FROM spots WHERE file_path = ? AND deleted_at IS NULL LIMIT 1", [filePath]
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
): Promise<string | null> {
  if (isImagingClass(contentClass)) return getSpotArt(filePath);
  if (contentClass == null && await isSpotFile(filePath)) return getSpotArt(filePath);
  return (await getLocalArt(filePath)) || (await fetchMusicStoreArt(title, artist));
}

/** Drop cached spot artwork so a freshly-saved override shows up without a restart.
 *  Called by the Spots panel after a save. */
export function clearSpotArtCache(filePath?: string | null): void {
  if (filePath) delete _spotArtCache[filePath];
  else for (const k of Object.keys(_spotArtCache)) delete _spotArtCache[k];
}
