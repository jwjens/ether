import { describe, it, expect } from "vitest";
import { findDuplicates, songKey, normaliseTitle, fmtLen } from "./importDuplicates";
import { createRequire } from "node:module";
const core = createRequire(import.meta.url)("../../audiod/scheduler-core.js");

const lib = (id: number, title: string, ms: number) => ({ id, title, artist: null, duration_ms: ms, category_id: 1, file_path: `C:/lib/${id}.mp3` });
const cand = (path: string, title: string, ms: number | null) => ({ path, title, artist: null, durationMs: ms });

describe("import duplicate guard", () => {
  it("same title and same length to the second is a duplicate of the library song", () => {
    const r = findDuplicates([cand("a.mp3", "Thriller (2008 Remaster)", 357_600)], [lib(7, "Thriller", 357_900)]);
    expect(r[0]).toEqual({ kind: "library", song: expect.objectContaining({ id: 7 }) });
  });
  it("same title, different length is a new song", () => {
    const r = findDuplicates([cand("will.mp3", "A Nightmare On My Street", 298_700)], [lib(1, "A Nightmare On My Street", 235_500)]);
    expect(r[0]).toBe(null);
  });
  it("only songs already in the library count — a repeat inside the folder is not a duplicate", () => {
    const r = findDuplicates([cand("x/1.mp3", "Ghost", 224_100), cand("y/1.mp3", "Ghost", 224_000)], []);
    expect(r).toEqual([null, null]);
  });
  it("a song renamed in the library is found by the same file name and the same length", () => {
    const renamed = { id: 9, title: "Monster Mash", artist: null, duration_ms: 201_120, category_id: 1, file_path: "C:/lib/Bobby Boris Pickett - Monster Mash HQ.mp3" };
    expect(findDuplicates([cand("D:\\dl\\bobby boris pickett - monster mash hq.mp3", "Bobby Boris Pickett - Monster Mash HQ", 201_000)], [renamed])[0])
      .toEqual({ kind: "library", song: expect.objectContaining({ id: 9 }) });
    // same file name, different length: a different song
    expect(findDuplicates([cand("D:/dl/Bobby Boris Pickett - Monster Mash HQ.mp3", "x", 150_000)], [renamed])[0]).toBe(null);
  });
  it("no length or no title is never called a duplicate", () => {
    expect(findDuplicates([cand("a.mp3", "Thriller", null)], [lib(7, "Thriller", 357_900)])[0]).toBe(null);
    expect(songKey("", 1000)).toBe(null);
  });
  it("normalises titles exactly as the scheduler does", () => {
    for (const t of ["Spooky, Scary Skeletons", "Men In Black - From \"Men In Black\" Soundtrack", "Monster Mash [Live] (2010)", "\"The Munsters\" Theme"])
      expect(normaliseTitle(t)).toBe(core.normaliseTitle(t));
  });
  it("shows lengths as m:ss", () => { expect(fmtLen(235_500)).toBe("3:56"); expect(fmtLen(null)).toBe("—"); });
});
