// The source fader's name label is not said twice (Jeff, 2026-10-28): the SOURCE dropdown names the source, so the label
// under it no longer repeats "Sweeper", "Announcement", "Cart / SFX rack", "Mic" or the mic's device.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { labelRepeatsDropdown, SOURCE_KINDS } from "./sourceKinds";

describe("the source strip's name label", () => {
  it("is hidden for every source kind the dropdown names", () => {
    for (const k of SOURCE_KINDS) expect(labelRepeatsDropdown(k.kind, null), k.kind).toBe(true);
  });
  it("stays for the Link's sender (the dropdown does not name it) and for a fader with no source", () => {
    expect(labelRepeatsDropdown("link", "OVEVENTS")).toBe(false);
    expect(labelRepeatsDropdown("", null)).toBe(false);
  });
  it("SourceChannelStrip passes it; ConsoleStrip then draws no label row at all — no text and no empty space", () => {
    const strip = fs.readFileSync(path.join(__dirname, "..", "components", "SourceChannelStrip.tsx"), "utf8");
    const cs = fs.readFileSync(path.join(__dirname, "..", "components", "ConsoleStrip.tsx"), "utf8");
    expect(strip).toMatch(/labelTextHidden=\{labelRepeatsDropdown\(config\.kind,/);
    expect(cs).toMatch(/\{labelTextHidden \? \(deckId \? \(/);
    expect(cs).not.toMatch(/visibility: labelTextHidden/);
  });
});

describe("the play-progress bar on those faders (Jeff, 2026-10-28: back as a thin strip, without the duplicate name)", () => {
  it("a 4 px strip carries the progress fill, and no name", () => {
    const cs = fs.readFileSync(path.join(__dirname, "..", "components", "ConsoleStrip.tsx"), "utf8");
    const at = cs.indexOf('data-strip-progress="1"');
    expect(at).toBeGreaterThan(0);
    const block = cs.slice(at, cs.indexOf(") : null) : !hideLabel", at));
    expect(block).toMatch(/height: 4/);
    expect(block).toMatch(/ref=\{fillRef\}/);
    expect(block).not.toMatch(/\{label\}/);
  });
});
