// fix 13 (docs/help-audit-2026-09-27.md): SweepersPanel imported InlineNameEditor (whose own header says it serves
// "the Jingles panel item rows") but never rendered it, so a sweeper could not be renamed in the push-up. Each cut in
// a pool now carries it, saving through the Library's own rename path (songs.updateById → songsUpdate, which mirrors
// the title onto library_asset — the row this list reads).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.join(__dirname, "..", "components", "SweepersPanel.tsx"), "utf8");
const rows = src.slice(src.indexOf("{inThis.map(x => ("), src.indexOf("Add a cut"));

describe("a sweeper can be renamed in the push-up (audit 13)", () => {
  it("each pool cut row renders InlineNameEditor, read-only when the panel is", () => {
    expect(rows).toMatch(/<InlineNameEditor/);
    expect(rows).toMatch(/readOnly=\{ro\}/);
  });
  it("the save goes through songs.updateById with the cut's id and reloads", () => {
    expect(rows).toMatch(/songs\??\.updateById\(x\.id, \{ title: next \}\)/);
    expect(rows).toMatch(/reload\(\)/);
  });
  it("the Library writer mirrors a title change onto library_asset", () => {
    const h = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "sync", "handlers", "songs.js"), "utf8");
    expect(h).toMatch(/mirrorAsset\(db, TABLE, updatedRow/);
  });
});
