// Library → Attach audio… (dead-controls item 39): Spotify / NexGen imports make songs with no audio; such a song is
// marked NO AUDIO and can be given its file. Never offered on a song that has audio (Change File Location stays removed).
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { songHasNoAudio, attachAudioToSong, firstPicked } from "./songAttachAudio";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
const deps = (over: Partial<Parameters<typeof attachAudioToSong>[1]> = {}) => ({
  pick: vi.fn(async () => "C:/Downloads/song.mp3"),
  importIntoLibrary: vi.fn(async () => "D:/Catalogue/song.mp3"),
  probeSec: vi.fn(async () => 201.4),
  update: vi.fn(async () => ({ ok: true })),
  ...over,
});

describe("songs with no audio", () => {
  it("no local file and no cloud file = no audio; a cloud-only song is not", () => {
    expect(songHasNoAudio({ file_path: null, file_key: null })).toBe(true);
    expect(songHasNoAudio({ file_path: "", file_key: "  " })).toBe(true);
    expect(songHasNoAudio({ file_path: null, file_key: "song.mp3" })).toBe(false);
    expect(songHasNoAudio({ file_path: "D:/x.mp3" })).toBe(false);
  });
  it("Attach audio copies the file into the catalogue, stores THAT path and the real length", async () => {
    const d = deps();
    const r = await attachAudioToSong({ id: 7, title: "Imported", file_path: null }, d);
    expect(r.ok).toBe(true);
    expect(d.update).toHaveBeenCalledWith(7, { file_path: "D:/Catalogue/song.mp3", duration_ms: 201400 });
  });
  it("cancel, or a refused copy, writes nothing", async () => {
    const d1 = deps({ pick: vi.fn(async () => null) });
    expect((await attachAudioToSong({ id: 1, file_path: null }, d1)).ok).toBe(false);
    expect(d1.update).not.toHaveBeenCalled();
    const d2 = deps({ importIntoLibrary: vi.fn(async () => null) });
    expect((await attachAudioToSong({ id: 1, file_path: null }, d2)).ok).toBe(false);
    expect(d2.update).not.toHaveBeenCalled();
  });
  it("a song that has audio is never repointed", async () => {
    const d = deps();
    expect((await attachAudioToSong({ id: 1, file_path: "D:/a.mp3" }, d)).ok).toBe(false);
    expect(d.pick).not.toHaveBeenCalled();
  });
  it("reads the Open window's list of paths", () => {
    expect(firstPicked(["a.mp3"])).toBe("a.mp3");
    expect(firstPicked(null)).toBeNull();
  });
  it("the Library offers it only on a song with no audio, and tags those songs NO AUDIO", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/songHasNoAudio\(ctxMenu\.song as any\) \? \[\{ label: "Attach audio…"/);
    expect(app).toMatch(/>NO AUDIO<\/span>/);
    expect(read("src/components/NexGenImport.tsx")).toMatch(/Attach audio…/);
    expect(read("src/components/SpotifyImport.tsx")).toMatch(/Attach audio…/);
  });
});
