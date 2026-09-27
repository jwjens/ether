// fix 25 (docs/help-audit-2026-09-27.md): the Wild meter picker showed the engine slot ids S1–S5, which are internal
// (Jeff's ruling, one name per fader — src/lib/boardName.ts). It now names a channel by its board letter, the same
// name the strip, the rack and the Health Monitor use. (Mic Inputs, fix 26: micInputsLabels.test.ts.)
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { boardName } from "./boardName";
import { wildChoices } from "./boardLabels";

const ENGINE_ID = /\bS\d\b/;
const name = (s: string) => boardName(s);

describe("the Wild meter picker names channels by board letter (audit 25)", () => {
  it("no choice shows S1–S5; S1 is G on the default board; the stored keys are unchanged", () => {
    const ch = wildChoices(name);
    for (const w of ch) expect(w.label, w.key).not.toMatch(ENGINE_ID);
    expect(ch.find(w => w.key === "ch:S1")!.label).toMatch(/^G /);
    expect(ch.find(w => w.key === "ch:A")!.label).toMatch(/^Deck A /);
    expect(ch.map(w => w.key)).toContain("ch:S5");
  });
  it("the picker builds its list with the station's board names", () => {
    const mm = fs.readFileSync(path.join(__dirname, "..", "components", "meter", "MasterMeters.tsx"), "utf8");
    expect(mm).toMatch(/wildChoices\(useBoardName\(\)/);
    expect(mm).not.toMatch(/Object\.keys\(CH_INDEX\)\.map/);
  });
});
