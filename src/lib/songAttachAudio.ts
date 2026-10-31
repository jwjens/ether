// src/lib/songAttachAudio.ts — Library → right-click → Attach audio… (dead-controls item 39).
//
// "Import from Spotify" and "NexGen / ENCO" create songs from a list — title, artist, length — with NO audio, and the
// way to give them audio later was removed (Change File Location, 2026-10-27, Jeff: the catalogue folder is changed only
// in Preferences). Such a song can never air. This is the Spots fix (aa1b19d, Edit Spot → Attach audio…) for songs:
// offered ONLY on a song that has no audio at all — it gives a song its first file, it never moves or repoints a song
// that has one (that is the removed Change File Location, and stays removed). The file is copied into the catalogue
// like every import (importIntoAudioLibrary), its real length probed, and the song updated through songs.updateById.

export interface AudioLess { file_path?: string | null; file_key?: string | null }

/** No local file and no cloud file: nothing to play, anywhere. (A song with a cloud file_key and no local path is not
 *  "no audio" — its file comes down from the cloud.) */
export function songHasNoAudio(s: AudioLess | null | undefined): boolean {
  return !!s && !String(s.file_path || "").trim() && !String(s.file_key || "").trim();
}

export const NO_AUDIO_HINT = "No audio — this song can't air. Right-click → Attach audio… to give it its file.";

export interface AttachDeps {
  pick: () => Promise<string | null>;                          // the Open window; null = cancelled
  importIntoLibrary: (p: string) => Promise<string | null>;     // copy-on-import; null = refused (it said why)
  probeSec: (p: string) => Promise<number | null>;              // real length in seconds; null = unknown
  update: (id: number, patch: Record<string, unknown>) => Promise<any>;
}

/** → { ok, message } — what the Library says afterwards. Writes nothing unless a file was picked AND copied in. */
export async function attachAudioToSong(song: { id: number; title?: string | null } & AudioLess, deps: AttachDeps): Promise<{ ok: boolean; message: string; patch?: Record<string, unknown> }> {
  if (!songHasNoAudio(song)) return { ok: false, message: `"${song.title || "This song"}" already has audio.` };
  const picked = await deps.pick();
  if (!picked) return { ok: false, message: "" };
  const lib = await deps.importIntoLibrary(picked);
  if (!lib) return { ok: false, message: "That file was not added to the catalogue, so nothing changed." };
  const sec = await deps.probeSec(lib);
  const patch: Record<string, unknown> = { file_path: lib, ...(sec != null && sec > 0 ? { duration_ms: Math.round(sec * 1000) } : {}) };
  const r = await deps.update(song.id, patch);
  if (r && r.ok === false) return { ok: false, message: `Couldn't attach the audio: ${r.error || "not saved"}` };
  return { ok: true, message: `Audio attached to "${song.title || "the song"}".`, patch };
}

/** The Open window answers a path or a list of paths (src/components/ShowPlus session load, 21e729b). */
export function firstPicked(v: unknown): string | null {
  if (Array.isArray(v)) return (v[0] as string) || null;
  if (v && typeof v === "object" && Array.isArray((v as any).filePaths)) return (v as any).filePaths[0] || null;
  return typeof v === "string" && v ? v : null;
}
