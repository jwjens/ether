// INTERCHANGE (2026-10-04) — the OFFERING half of the matrix. "carts announcements jukebox sweepers link they all are
// just input sources and need to work interchangeably on all faders." Every one of those kinds must be selectable on
// every source fader, D/E/F and S1..S5. The MIXING half (each kind on each slot reaches the room and the programme)
// is native/src/audio.rs `mod interchange_matrix`.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SOURCE_SLOTS, SOURCE_KINDS, sourceKindOptions, canHostJukebox, isSweeperKind } from "./sourceKinds";

// The operator's list, by the value the board stores. "jingle" is the persisted key of the Sweeper entry.
const REQUIRED = ["cart", "announcement", "jukebox", "jingle", "link"] as const;

describe("source kinds × source slots — what the SOURCE dropdown offers", () => {
  it("the source faders are D, E, F and S1..S5", () => {
    expect([...SOURCE_SLOTS]).toEqual(["D", "E", "F", "S1", "S2", "S3", "S4", "S5"]);
  });

  it("every required kind exists in the list (and the Sweeper entry is a sweeper kind)", () => {
    for (const k of REQUIRED) expect(SOURCE_KINDS.some(s => s.kind === k), k).toBe(true);
    expect(isSweeperKind("jingle")).toBe(true);
  });

  for (const slot of SOURCE_SLOTS) {
    it(`${slot}: cart, announcement, jukebox, sweeper and link are all offered and enabled`, () => {
      const opts = sourceKindOptions(slot);
      const offered = Object.fromEntries(opts.map(o => [o.kind, o]));
      for (const k of REQUIRED) {
        expect(offered[k], `${k} missing on ${slot}`).toBeTruthy();
        expect({ slot, kind: k, disabled: offered[k].disabled, why: offered[k].why }).toEqual({ slot, kind: k, disabled: false, why: "" });
      }
      // Mic is a source too (an engine input since 2026-09-26) — same on every slot.
      expect(offered.mic.disabled).toBe(false);
    });
  }

  it("the offering is IDENTICAL on every source slot — no slot is special", () => {
    const shape = (slot: string) => sourceKindOptions(slot).map(o => `${o.kind}:${o.disabled}`).join(",");
    for (const slot of SOURCE_SLOTS) expect(shape(slot), slot).toBe(shape("D"));
  });

  it("the jukebox can host on every source slot and never on a rotation deck", () => {
    for (const slot of SOURCE_SLOTS) expect(canHostJukebox(slot), slot).toBe(true);
    for (const slot of ["A", "B", "C", "CART"]) expect(canHostJukebox(slot), slot).toBe(false);
  });
});

describe("source contract — the strip and the configurator read the one rule", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), "utf8");
  it("SourceChannelStrip builds its dropdown from sourceKindOptions, with no slot test of its own", () => {
    const src = read("../components/SourceChannelStrip.tsx");
    expect(src).toMatch(/sourceKindOptions\(config\.slot\)/);
    expect(src).not.toMatch(/canHostJukebox|D\/E\/F only/);
  });
  it("no renderer file keeps a D/E/F-only jukebox list", () => {
    expect(read("./sourceKinds.ts")).not.toMatch(/JUKEBOX_SLOTS\s*=\s*\[\s*"D",\s*"E",\s*"F"\s*\]/);
  });
});
