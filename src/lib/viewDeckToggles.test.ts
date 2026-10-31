// View → Deck A / Deck B / Deck C / Mic Deck (dead-controls item 23): the toggles were saved and nothing read them. They
// now leave that deck out of the MAIN screen's board, and the screen names what it hid and whether it carries audio.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { viewHiddenSlots, slotsForViewKey } from "./boardSlots";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("View menu deck toggles", () => {
  it("each toggle hides its own deck, and only when switched off", () => {
    expect(viewHiddenSlots({ queue: true, deckA: true, deckB: true, deckC: true, mic: true })).toEqual([]);
    expect(viewHiddenSlots({ deckA: false, deckB: true })).toEqual(["A"]);
    expect(viewHiddenSlots({ deckB: false, deckC: false }).sort()).toEqual(["B", "C"]);
    expect(viewHiddenSlots(undefined)).toEqual([]);
  });
  it("Mic Deck hides every channel carrying the mic (a source patched to Mic, or a leftover mic strip)", () => {
    const configs = [{ slot: "D", type: "source", kind: "mic" }, { slot: "E", type: "source", kind: "cart" }, { slot: "S1", type: "mic", kind: "" }];
    expect(slotsForViewKey("mic", configs).sort()).toEqual(["D", "S1", "mic"]);
    expect(viewHiddenSlots({ mic: false }, configs)).not.toContain("E");
  });
  it("the main screen's board reads them, and says what it hid", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/hiddenSlots=\{viewHidden\}/);
    expect(app).toMatch(/viewHiddenSlots\(vp, deckConfigs \|\| \[\]\)/);
    expect(app).toMatch(/Hidden here \(View menu\):/);
    expect(app).toMatch(/● carrying audio/);
    const fs = read("src/components/FaderSection.tsx");
    expect(fs).toMatch(/const shown = raw\.filter\(s => !hide\.has\(s\)\)/);
  });
});
