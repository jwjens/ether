// BOARD FADER STRIPS (Jeff, 2026-11-02): "1. DUCK: each source fader has two duck buttons (DUCK ON/OFF under the source
// picker, and DUCK above EQ). Remove both, and add one DUCK button in the bottom row next to ON and PFL: ON | PFL | DUCK.
// Same behavior as today, one button. Only on faders that have duck today. 2. EQ: remove the EQ button from every fader
// strip. In the EQ window, add a selector at the top listing every deck and fader on the board, so the user picks the
// channel there and adjusts it. Any EQ settings already saved stay exactly as they are."
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { hasDuck } from "./FaderRouting";
import { boardChannels, CHANNEL_SLOTS, rackName } from "./rack/channelRack";

const src = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("DUCK: one button, in the bottom row, on the faders that had it", () => {
  it("every engine fader except decks A, B, C has DUCK (exactly the faders the old DUCK showed on)", () => {
    for (const s of ["D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"]) expect(hasDuck(s), s).toBe(true);
    for (const s of ["A", "B", "C", "", "GUEST", null, undefined]) expect(hasDuck(s as any), String(s)).toBe(false);
  });

  it("the strip's bottom row is ON | PFL | DUCK, in that order", () => {
    const strip = src("ConsoleStrip.tsx");
    const row = strip.slice(strip.indexOf("data-strip-buttons"));
    const on = row.indexOf('{pendingShow ? "PENDING" : "ON"}'), pfl = row.indexOf(">PFL</span>"), duck = row.indexOf("<DuckButton");
    expect(on).toBeGreaterThan(0);
    expect(pfl).toBeGreaterThan(on);
    expect(duck).toBeGreaterThan(pfl);
  });

  it("the two old duck buttons are gone: no DUCK ON/OFF under the source picker, no DUCK in the routing row", () => {
    expect(src("SourceChannelStrip.tsx")).not.toMatch(/"DUCK ON"|"DUCK OFF"|onDuckChange/);
    const routing = src("FaderRouting.tsx");
    const defaultExport = routing.slice(routing.indexOf("export default function FaderRouting"), routing.indexOf("export function DuckButton"));
    expect(defaultExport).not.toMatch(/>DUCK</);
    expect(src("FaderSection.tsx")).not.toMatch(/onSetSourceDuck|onDuckChange/);
  });

  it("same behavior: the one button saves and sends the same setting both old buttons did (board:set-routing duck)", () => {
    const routing = src("FaderRouting.tsx");
    const duckBtn = routing.slice(routing.indexOf("export function DuckButton"));
    expect(duckBtn).toMatch(/set\(\{ duck: !on \}\)/);
    expect(routing).toMatch(/invoke\?\.\("board:set-routing", stationId, slot, patch\)/);
  });
});

describe("EQ: no button on the strips; the EQ window picks the channel", () => {
  it("no fader strip has an EQ button any more", () => {
    expect(src("ConsoleStrip.tsx")).not.toMatch(/openChannelRack|useChannelRackLamps|>EQ</);
    expect(src("SourceChannelStrip.tsx")).not.toMatch(/openChannelRack/);
  });

  it("the selector lists every deck and fader on the board, in board order — decks always, other faders when on the board", () => {
    const rows = [
      { slot: "A", enabled: 1 }, { slot: "B", enabled: 1 }, { slot: "C", enabled: 1 },
      { slot: "D", enabled: 1 }, { slot: "E", enabled: 0 }, { slot: "F", enabled: 1 }, { slot: "S2", enabled: 1 }, { slot: "CART", enabled: 0 },
    ];
    expect(boardChannels(rows)).toEqual(["A", "B", "C", "D", "F", "S2"]);
    expect(boardChannels([])).toEqual(["A", "B", "C"]);
    expect(boardChannels([{ slot: "s1", enabled: true }])).toEqual(["A", "B", "C", "S1"]);
  });

  it("the EQ window shows that selector at its top and still opens each channel's own saved rack (rack name unchanged)", () => {
    const rack = src("rack/Rack.tsx");
    expect(rack).toMatch(/boardChannels\(rows\)/);
    expect(rack).toMatch(/>Channel</);
    expect(rack).not.toMatch(/CHANNEL_SLOTS\.map/);
    // saved EQ: every channel's rack is still read and written as "ch:<slot>" (rack_ch_<slot>) — nothing renamed or moved
    for (const s of CHANNEL_SLOTS) expect(rackName(s)).toBe(`ch:${s}`);
  });
});
