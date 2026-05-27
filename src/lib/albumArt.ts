// Local-first album artwork. Embedded cover art from the audio file is the PRIMARY
// source (read in the main process via music-metadata); iTunes/online lookups are the
// fallback handled by each caller. Results are cached per filePath for the session so a
// replayed track or multiple components asking for the same file don't re-cross IPC.
const _localArtCache: Record<string, string | null> = {};

/** Embedded cover art for a local file as a data: URL, or null if the file has none
 *  (or isn't a local path). Callers fall back to iTunes when this returns null. */
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
