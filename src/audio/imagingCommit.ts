// imagingCommit — the ONE shared "render a region of a decoded reel and commit it to the library" engine,
// worn by BOTH imaging surfaces: the Reel Splitter push-up (batch) and the StudioPro DAW chop-and-send
// (single). Never copied — one engine, two surfaces (CLAUDE.md imaging architecture). Built ONLY on the
// VERIFIED rails (docs/reel-splitter-verification-and-plan-2026-07-15.md):
//   render+write: sliceRegion (wavEdit) → encodeWav → ether.ffmpeg.writeAudio (media:writeAudio, WORKS)
//   import:       shipped normal pipeline — songs.create({file_path,…}) + songs.updateById({content_class, jingle_category_id})
// NOT used: ether.fs.writeFile (dead stub, no handler); content-hash/songs_v2 (not shipped — file_path identity).
import { encodeWav, sliceRegion } from "./wavEdit";
import { query } from "../db/client";

const ether = () => (window as any).ether;

// SWP = a sweeper · MUS = a plain Library item (no overlay tag).
//
// v52 (2026-08-27): "JIN" is gone. This file is the LIVE WRITER behind the Reel Splitter and the
// StudioPro chop-and-send, so leaving the old value here would have re-seeded retired data into a
// freshly-migrated library — the migration correct on the day it ran and wrong again by the next
// import. That is why this lands in the same commit as v52 rather than a later sweep.
export type ImagingClass = "SWP" | "MUS";

/** Filesystem-safe reel/name slug (mirrors the Reel Splitter's original). */
export const imagingSlug = (s: string) =>
  (s || "reel").replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "reel";

/** Render one [start,end) region of a decoded buffer to a persistent WAV under the imaging folder and
 *  return its path + duration. Render+write leg only — no songs row is created here (used by the DECK
 *  send, which needs a real file on disk but not necessarily a library row). */
export async function renderRegionToDisk(
  buffer: AudioBuffer, startSec: number, endSec: number, reelSlug: string, name: string,
): Promise<{ filePath: string; durationMs: number }> {
  const appDir = await ether().system.getAppDataDir();
  const folder = `${appDir}/imaging/${imagingSlug(reelSlug)}`;
  const safe = (name || reelSlug).replace(/[^\w.-]+/g, "_") || "clip";
  const filePath = `${folder}/${safe}.wav`;
  const wav = new Uint8Array(encodeWav(sliceRegion(buffer, startSec, endSec)));
  const res = await ether().ffmpeg.writeAudio(wav, filePath);
  if (!res?.ok) throw new Error(`write failed for "${name}"`);
  return { filePath, durationMs: Math.round((endSec - startSec) * 1000) };
}

/** Render + import one region as a Library item, tagging it as a JIN/SWP overlay in a pool when the class
 *  is JIN/SWP (MUS = plain library song, no tag). Returns the new song id + file path. The shipped normal
 *  pipeline (songs.create + updateById) — no side doors. */
export async function commitRegionToLibrary(
  buffer: AudioBuffer, startSec: number, endSec: number,
  opts: { name: string; cls: ImagingClass; poolId: number | null; reelSlug: string },
): Promise<{ songId: number | null; filePath: string; durationMs: number }> {
  const { filePath, durationMs } = await renderRegionToDisk(buffer, startSec, endSec, opts.reelSlug, opts.name);
  const created = await ether().songs.create({ title: opts.name, file_path: filePath, duration_ms: durationMs });
  let songId: number | null = created?.row?.id ?? null;
  if (!songId) {
    // create didn't echo the id — resolve it by the file_path we just wrote (matches ReelSplitter).
    // `id`, not `rowid`: songs is a VIEW over songs_all (live rows only) and views have no rowid.
    try { const rows = await query<{ id: number }>("SELECT id FROM songs WHERE file_path = ?", [filePath]); songId = rows?.[0]?.id ?? null; } catch { /* leave null */ }
  }
  // Only ever writes SWP. There is one imaging class now, so there is one value to write.
  if (songId && opts.cls === "SWP") {
    await ether().songs.updateById(songId, { content_class: "SWP", jingle_category_id: opts.poolId ?? null });
  }
  return { songId, filePath, durationMs };
}
