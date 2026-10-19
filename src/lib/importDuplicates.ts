// src/lib/importDuplicates.ts — THE IMPORT DUPLICATE GUARD (Jeff, 2026-10-19: "i need a duplicate identifier when i
// download songs like windows does to replace or skip duplicates … i have a large folder with some repeating songs and i
// only want the new ones").
//
// A file is a duplicate when the library already has a song with the same title
// AND the same length to the second — Jeff's identity rule from the same morning: "just because the song has the same
// name look at the length they are not the same song". The title is normalised the way the scheduler normalises it
// (audiod/scheduler-core.js normaliseTitle): case, punctuation and a trailing "(Remaster)" / "- From …" do not count.
// A song renamed in the library is still found: the same FILE NAME and the same length is the same song too.
//
// Pure: no I/O. The Import dialog reads the tags and the library, and asks this.

export interface ImportCandidate { path: string; title: string; artist: string | null; durationMs: number | null }
export interface LibrarySong { id: number; title: string; artist: string | null; duration_ms: number | null; category_id: number | null; file_path: string | null }
export type DuplicateOf = { kind: "library"; song: LibrarySong };

/** Same normalisation as audiod/scheduler-core.js normaliseTitle — keep the two identical. */
export function normaliseTitle(t: string | null | undefined): string | null {
  if (!t) return null;
  let s = String(t).toLowerCase();
  s = s.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/g, "");
  s = s.replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/g, "");
  s = s.replace(/\s+[-–—]\s+(from|feat\.?|ft\.?)\b.*$/i, "");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

/** The identity key: normalised title + length to the second. No title or no length = no key (never called a duplicate). */
export function songKey(title: string | null | undefined, durationMs: number | null | undefined): string | null {
  const t = normaliseTitle(title);
  const ms = Number(durationMs);
  if (!t || !(ms > 0)) return null;
  return `${t}|${Math.round(ms / 1000)}`;
}

/**
 * For each candidate, in order: the library song it duplicates, or null (new). Only songs ALREADY IN THE LIBRARY count
 * (Jeff, 2026-10-19: "no not repeats in the folder songs i already have").
 */
export function findDuplicates(candidates: ImportCandidate[], library: LibrarySong[]): (DuplicateOf | null)[] {
  const byTitle = new Map<string, LibrarySong>(), byFile = new Map<string, LibrarySong>();
  for (const s of library) {
    const k = songKey(s.title, s.duration_ms); if (k && !byTitle.has(k)) byTitle.set(k, s);
    const f = fileKey(s.file_path, s.duration_ms); if (f && !byFile.has(f)) byFile.set(f, s);
  }
  return candidates.map(c => {
    const k = songKey(c.title, c.durationMs), f = fileKey(c.path, c.durationMs);
    const hit = (k ? byTitle.get(k) : undefined) ?? (f ? byFile.get(f) : undefined);
    return hit ? { kind: "library", song: hit } : null;
  });
}

/** The file name (no folder, no case) + length to the second. */
export function fileKey(p: string | null | undefined, durationMs: number | null | undefined): string | null {
  const b = p ? String(p).split(/[\\/]/).pop()?.toLowerCase() : null;
  const ms = Number(durationMs);
  if (!b || !(ms > 0)) return null;
  return `${b}|${Math.round(ms / 1000)}`;
}

export const fmtLen = (ms: number | null | undefined): string => {
  const s = Math.round(Number(ms) / 1000);
  if (!(s > 0)) return "—";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
