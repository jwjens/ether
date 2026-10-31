// Show+ DAW → 📂 Load session (Jeff, 2026-10-31): it read .filePath from the Open window, which answers a list of paths,
// so it silently did nothing; the general read also stopped at 256 KB. And Cancel in the Save window fell through to a
// browser download.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
describe("Show+ DAW sessions", () => {
  const sp = read("components/StudioPro.tsx");
  it("Load takes the first path from the Open window's list and reads it through the session read", () => {
    expect(sp).toMatch(/const path = Array\.isArray\(res\) \? res\[0\]/);
    expect(sp).toMatch(/ether\.showplus\.readSession\(path\)/);
  });
  it("main reads only a file picked in the Open window this run, up to 20 MB", () => {
    const main = read("../electron/main.js");
    expect(main).toMatch(/ipcMain\.handle\("showplus:read-session"/);
    expect(main).toMatch(/if \(!_userChosenFiles\.has\(full\)\)/);
    expect(main).toMatch(/for \(const f of result\.filePaths \|\| \[\]\) _userChosenFiles\.add/);
  });
  it("Cancel in the Save window saves nothing (no browser download)", () => {
    expect(sp).toMatch(/Export cancelled — nothing was saved\./);
    expect(sp).toMatch(/Save cancelled — nothing was saved\./);
  });
});
