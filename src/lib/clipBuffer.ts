// src/lib/clipBuffer.ts — Show+ ⏮ CLIP, the last 30 seconds as a WebM file (dead-controls item 5).
// The recorder's first chunk is the file's header and is kept apart (ShowPlus useClipBuffer); the window holds media
// chunks only, and a saved clip is always header + window.

export interface Chunk<T = ArrayBuffer> { data: T; ts: number }

/** The media chunks still inside the last `seconds` at `now`. */
export function pruneClipWindow<T>(chunks: Chunk<T>[], now: number, seconds: number): Chunk<T>[] {
  const cutoff = now - seconds * 1000;
  return chunks.filter(c => c.ts >= cutoff);
}

/** The parts of a saved clip, in order: the header first, then the window's chunks. */
export function clipParts<T>(header: T, chunks: Chunk<T>[]): T[] {
  return [header, ...chunks.map(c => c.data)];
}
