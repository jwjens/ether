// Patch Bay step 2 (inputs): the window has the inputs grid, Preferences no longer picks the device, and the grid sends
// the board's own Link patch. The agreement rules themselves: src/lib/inputPatch.test.ts.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("Patch Bay inputs (step 2)", () => {
  it("each station in the Patch Bay window shows its inputs grid", () => {
    expect(read("PatchBay.tsx")).toMatch(/<PatchBayInputs stationId=\{s\.id\} \/>/);
  });
  it("the grid writes only through the board's writers: mic:set, link:set-input, deck_configs update-by-slot", () => {
    const g = read("PatchBayInputs.tsx");
    expect(g).toMatch(/mic\.setPatch\(st\.slot, st\.patch\)/);
    expect(g).toMatch(/link\.setInput\(/);
    expect(g).toMatch(/deckConfigs\?\.updateBySlot\?\.\(stationId, st\.slot, \{ kind: st\.kind \}\)/);
    expect(g).not.toMatch(/saveDeckConfigs|writeBoard/);   // never a whole-board save (RC5)
  });
  it("the grid's Link patch is the same one the board's dropdown sends", () => {
    const fields = /slot: [^,]+, jitterMs: cur\?\.jitterMs \?\? d\.jitterMs, port: cur\?\.port \?\? d\.port,\s+autoCut: cur\?\.autoCut \?\? link\.cfg\.autoCutDefault\.autoCut, autoCutSec: cur\?\.autoCutSec \?\? link\.cfg\.autoCutDefault\.autoCutSec/;
    expect(read("PatchBayInputs.tsx")).toMatch(fields);
    expect(read("SourceChannelStrip.tsx")).toMatch(fields);
  });
  it("Preferences → Mic Inputs no longer picks the device or input number; it points to the Patch Bay", () => {
    const m = read("MicInputsSettings.tsx");
    expect(m).not.toMatch(/<select/);
    expect(m).toMatch(/"window:popout", "multioutput"/);
  });
});
