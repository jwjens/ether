// Item 41: the Cue Editor shows [I] [N] [O] [U] on its cue-point strip but only Space worked. Item 26: Up Next's empty
// text named a GEN LOG button that doesn't exist.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const te = fs.readFileSync(path.join(__dirname, "..", "components", "TrackEditor.tsx"), "utf8");
describe("cue editor keys", () => {
  it("I / N / O / U jump to Cue In / Intro End / Outro Start / Cue Out, like clicking the point", () => {
    expect(te).toMatch(/markersRef\.current = \{ KeyI: cueIn, KeyN: introEnd, KeyO: outroStart, KeyU: cueOut \|\| duration \}/);
    expect(te).toMatch(/const mark = markersRef\.current\[e\.code\]/);
  });
  it("Up Next's empty text names only things that exist", () => {
    expect(fs.readFileSync(path.join(__dirname, "..", "components", "UpNext.tsx"), "utf8")).not.toMatch(/GEN LOG/);
  });
});
