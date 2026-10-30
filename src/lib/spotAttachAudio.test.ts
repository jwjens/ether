// Imported traffic spots can have their audio attached so they air (Jeff, 2026-10-30). Import Traffic CSV makes spots
// with no file; Generate places only spots with a file; the Spots list shows the file from the spot's library asset.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const { assetChangedBy } = require_("../../electron/sync/handlers/spots.js");

describe("attach audio to a spot", () => {
  it("an edit of the audio, title or length re-mirrors the library asset; other edits do not", () => {
    expect(assetChangedBy(["file_path", "length_sec"])).toBe(true);
    expect(assetChangedBy(["title"])).toBe(true);
    expect(assetChangedBy(["advertiser", "start_date"])).toBe(false);
  });
  it("spotsUpdate mirrors the asset when that is so", () => {
    expect(read("electron/sync/handlers/spots.js")).toMatch(/if \(assetChangedBy\(patchFields\)\) mirrorAsset\(db, TABLE, saved\);/);
  });
  it("the Edit Spot panel offers Attach / Replace audio, copying the file into the library and saving file + length", () => {
    const src = read("src/components/Spots.tsx");
    const editor = src.slice(src.indexOf("{/* Edit panel */}"), src.indexOf("{/* Spot list */}"));
    expect(editor).toMatch(/Attach audio…/);
    expect(src).toMatch(/const attachAudio = async[\s\S]{0,900}importIntoAudioLibrary\(fp\)[\s\S]{0,400}spots\.updateById\(editing\.id, \{ file_path: lib/);
  });
  it("a spot with no audio is marked WON'T AIR, like Generate treats it", () => {
    expect(read("src/components/Spots.tsx")).toMatch(/\(!s\.is_active \|\| s\.spot_category_id == null \|\| !s\.file_path\) &&/);
  });
});
