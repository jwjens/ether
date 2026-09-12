// imagingCommit — the ONE shared "render a region of a decoded reel and commit it to the library" engine,
// worn by BOTH imaging surfaces: the Reel Splitter push-up (batch) and the StudioPro DAW chop-and-send
// (single). Never copied — one engine, two surfaces (CLAUDE.md imaging architecture). Built ONLY on the
// VERIFIED rails (docs/reel-splitter-verification-and-plan-2026-07-15.md):
//   render+write: sliceRegion (wavEdit) → encodeWav → ether.ffmpeg.writeAudio (media:writeAudio, WORKS)
//   import:       shipped normal pipeline — songs.create({file_path,…}) + songs.updateById({content_class, jingle_category_id})
// NOT used: ether.fs.writeFile (dead stub, no handler); content-hash/songs_v2 (not shipped — file_path identity).
import { encodeWav, sliceRegion } from "./wavEdit";
import { query } from "../db/client";
import { audioLibraryDir } from "../lib/fileLocation";

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
  // THE CATALOGUE, FLAT — was <profile>/imaging/<reel-slug>/<name>.wav.
  //
  // The reel slug moves from the FOLDER into the FILENAME, which is what Jeff ruled and is also the
  // only thing that works: the resolver, the R2 backup and [N-23a] all key on BASENAME, so a nested
  // layout is invisible to every one of them. Carrying the slug in the name ALSO keeps what the
  // folder was really providing — two reels with a cut called "sting" no longer collide, which in a
  // flat namespace they otherwise would.
  const dir = await audioLibraryDir();
  if (!dir) throw new Error("The audio catalogue could not be found, so this cut was not written.");
  const safe = (name || reelSlug).replace(/[^\w.-]+/g, "_") || "clip";
  const filePath = `${dir}/${imagingSlug(reelSlug)}__${safe}.wav`;
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
  opts: { name: string; cls: ImagingClass; poolId: number | null; reelSlug: string; stationId: number },
): Promise<{ songId: number | null; assetUuid: string | null; filePath: string; durationMs: number }> {
  const { filePath, durationMs } = await renderRegionToDisk(buffer, startSec, endSec, opts.reelSlug, opts.name);

  // ── WHAT ACTUALLY MAKES A CUT A SWEEPER, AND WHY NONE OF IT WAS HAPPENING ──────────────────────
  //
  // Jeff, on OV, 4.6.29: "I pick a file, assign it to the Halloween pool, and nothing appears. No
  // error, no new sweeper."
  //
  // Nothing failed. Every call succeeded and wrote to places the READERS have moved on from:
  //
  //   1. NO library_asset ROW. SweepersPanel.tsx:113 lists sweepers with
  //        FROM library_asset la JOIN songs s ON s.uuid = la.uuid WHERE la.type = 'SWEEPER'
  //      and songsCreate (songs.js:50) does not create one. v50 backfilled library_asset at migration
  //      time; nothing has maintained it since, except announcements.js:84 which mirrors its own.
  //      So the cut was invisible to the manage screen — literally "nothing appears".
  //
  //   2. THE POOL WRITE WENT TO A DEAD COLUMN. v55 moved membership to sweeper_pool_member and its
  //      header says plainly "nothing writes it after this migration" — yet this function kept
  //      writing songs.jingle_category_id. sweeper-pool.js:56 picks MEMBER_SQL whenever the join
  //      table exists, so the pool assignment reached no reader at all.
  //
  //   3. NEITHER IPC RESULT WAS CHECKED. songs:create (songs.js:404) and songs:update-by-id (:424)
  //      return { ok:false, error } and never throw, so a real failure would have been invisible too.
  //
  // Three independent things had to be true for a sweeper to appear and two of them were false.
  // Jeff: "A write nobody reads is exactly how this stayed invisible."
  //
  // THE library_asset WRITE IS HERE ONLY UNTIL SLICE 1. Jeff's ruling, 2026-09-12: "make the
  // library_asset row structural in slice 1, not something each import path remembers. That's the
  // same class as the copy-on-import doors — nine remembered and two didn't." It belongs in
  // songsCreate, where every song row is born, and slice 1 moves it there. Until then this is one
  // import path remembering, which is the shape being retired — recorded so it is retired, not kept.
  // docs/assignment-model-slices-2026-09-12.md

  const created = await ether().songs.create({ title: opts.name, file_path: filePath, duration_ms: durationMs });
  if (created && created.ok === false) {
    throw new Error(`"${opts.name}" was written to disk but the Library row was not created — ${created.error}`);
  }
  let songId: number | null = created?.row?.id ?? null;
  let assetUuid: string | null = created?.row?.uuid ?? null;
  if (!songId || !assetUuid) {
    // create didn't echo the row — resolve by the file_path we just wrote. The UUID matters as much
    // as the id: it is the asset identity v50 preserved, and what sweeper_pool_member keys on.
    try {
      const rows = await query<{ id: number; uuid: string }>("SELECT id, uuid FROM songs WHERE file_path = ?", [filePath]);
      songId = songId ?? rows?.[0]?.id ?? null;
      assetUuid = assetUuid ?? rows?.[0]?.uuid ?? null;
    } catch { /* reported below */ }
  }
  if (!songId || !assetUuid) {
    throw new Error(`"${opts.name}" was written to ${filePath} but no Library row could be found for it afterwards.`);
  }

  // THE ASSET ROW — the thing every reader actually looks for. type comes from shared/asset-types.json
  // (SONG · SPOT · PROMO · SWEEPER · ANNOUNCEMENT · VOICE_TRACK · BED · SFX); the uuid is the SONG's,
  // because v50 deliberately reused it as the asset uuid so the two can never drift apart.
  const asset = await ether().libraryAsset.create({
    uuid: assetUuid,
    type: opts.cls === "SWP" ? "SWEEPER" : "SONG",
    title: opts.name,
    file_path: filePath,
    duration_ms: durationMs,
  });
  if (asset && asset.ok === false) {
    throw new Error(`"${opts.name}" is in the Library but was not registered as an asset — ${asset.error}. It will not appear under Sweepers until it is.`);
  }

  if (opts.cls === "SWP") {
    const tagged = await ether().songs.updateById(songId, { content_class: "SWP" });
    if (tagged && tagged.ok === false) {
      throw new Error(`"${opts.name}" is in the Library but could not be marked a sweeper — ${tagged.error}. The audio is at ${filePath}.`);
    }

    // MEMBERSHIP, not a column. One cut belongs to many pools — adding it to halloVeen's Halloween
    // must not take it out of Christmas in Jully's Summer Christmas, which is the defect v55 exists
    // to have fixed. songs.jingle_category_id is deliberately NOT written: it has no readers left,
    // and after this it has no writers either, so it can be dropped in slice 3 with the cart columns.
    if (opts.poolId != null) {
      const member = await ether().sweeperPoolMember.create({
        pool_id: opts.poolId, asset_uuid: assetUuid, station_id: opts.stationId,
      });
      if (member && member.ok === false) {
        throw new Error(`"${opts.name}" is a sweeper in the Library but was not added to the pool — ${member.error}. You can assign it from the Sweepers manage screen.`);
      }
    }
  }
  return { songId, assetUuid, filePath, durationMs };
}
