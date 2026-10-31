// Items 1 and 2: fs:writeFile had no handler (Show+ DAW Export WAV / stems / Save session, Play Log CSV). It now writes
// — only into a folder the operator picked in a Save window this run. electron/user-write.js.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { writeUserFile } = require_("./user-write");
const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");

describe("writing a file the operator asked for", () => {
  const dir = mkdtempSync(join(tmpdir(), "ether-uw-"));
  const allowed = new Set([dir]);
  it("writes text and bytes (also a Uint8Array that crossed IPC as a plain object) inside the picked folder", () => {
    expect(writeUserFile(join(dir, "log.csv"), "a,b\n", { allowedDirs: allowed })).toMatchObject({ ok: true, bytes: 4 });
    expect(readFileSync(join(dir, "log.csv"), "utf8")).toBe("a,b\n");
    writeUserFile(join(dir, "mix.wav"), new Uint8Array([82, 73, 70, 70]), { allowedDirs: allowed });
    expect(readFileSync(join(dir, "mix.wav")).toString("ascii")).toBe("RIFF");
    writeUserFile(join(dir, "stem_Vox.wav"), { 0: 1, 1: 2 }, { allowedDirs: allowed });
    expect([...readFileSync(join(dir, "stem_Vox.wav"))]).toEqual([1, 2]);
  });
  it("refuses anywhere else, including ../ out of the folder", () => {
    expect(writeUserFile(join(tmpdir(), "evil.txt"), "x", { allowedDirs: allowed }).ok).toBe(false);
    expect(writeUserFile(join(dir, "..", "evil2.txt"), "x", { allowedDirs: allowed }).ok).toBe(false);
    expect(existsSync(join(tmpdir(), "evil2.txt"))).toBe(false);
    expect(writeUserFile("relative.txt", "x", { allowedDirs: allowed }).ok).toBe(false);
  });
  it("main has the handler; picking in a Save or folder window is what allows a folder", () => {
    const main = read("electron/main.js");
    expect(main).toMatch(/ipcMain\.handle\("fs:writeFile"/);
    expect(main).toMatch(/_userChosenDirs\.add\(path\.dirname\(path\.resolve\(result\.filePath\)\)\)/);
  });
  it("the DAW and the Play Log export say when nothing was written", () => {
    expect(read("src/components/StudioPro.tsx").match(/if \(!w\?\.ok\)/g)?.length).toBe(3);
    const hm = read("src/components/HealthMonitor.tsx");
    expect(hm).toMatch(/ether\.dialog\.saveFile\(\{ defaultPath: filename/);
    expect(hm).not.toMatch(/Play log export failed"\]/);
  });
});
