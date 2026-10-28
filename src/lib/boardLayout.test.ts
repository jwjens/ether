// The board's fader bank (Jeff, 2026-10-28): minimum strip width, sideways scrolling with Master Out pinned, the overview,
// and the narrow strip layout.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { STRIP_MIN_PX, NARROW_BELOW_PX, isNarrowStrip, visibleStrips, scrollToShow, overflows, type StripBox } from "./boardLayout";
import { SOURCE_KINDS } from "./sourceKinds";

const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "components", f), "utf8");
const row = (n: number, w = 120): StripBox[] => Array.from({ length: n }, (_, i) => ({ key: `S${i}`, left: i * w, width: w }));

describe("strip widths", () => {
  it("the minimum holds the fader column, the meter and their padding (54 + 14 + 32 + 16)", () => {
    expect(STRIP_MIN_PX).toBeGreaterThanOrEqual(54 + 14 + 32 + 16);
  });
  it("narrow is below NARROW_BELOW_PX and never 0 (not yet measured)", () => {
    expect(isNarrowStrip(0)).toBe(false);
    expect(isNarrowStrip(STRIP_MIN_PX)).toBe(true);
    expect(isNarrowStrip(NARROW_BELOW_PX)).toBe(false);
  });
  it("every strip wrapper on the board has the minimum and grows above it (never squeezed to 0)", () => {
    const fs = read("FaderSection.tsx");
    expect(fs).toMatch(/const STRIP_BOX: React\.CSSProperties = \{ flex: `1 0 \$\{STRIP_MIN_PX\}px`, minWidth: STRIP_MIN_PX \}/);
    expect(fs).not.toMatch(/key=\{slot\} style=\{\{ flex: 1, (display: "flex", )?minWidth: 0 \}\}/);
    expect((fs.match(/data-board-strip=\{slot\}/g) || []).length).toBeGreaterThanOrEqual(8);
  });
});

describe("the bank scrolls sideways; Master Out is pinned outside it", () => {
  it("the bank scrolls on x and holds the strips and +; MasterOutput comes after the bank closes", () => {
    const fs = read("FaderSection.tsx");
    const bank = fs.indexOf('data-board-bank="1"');
    const end = fs.indexOf("{/* end of the bank */}");
    const master = fs.indexOf("<MasterOutput");
    expect(bank).toBeGreaterThan(0);
    expect(fs.slice(bank, bank + 300)).toMatch(/overflowX: "auto"/);
    expect(end).toBeGreaterThan(bank);
    expect(master).toBeGreaterThan(end);
    expect(fs.slice(bank, end)).toMatch(/aria-label="Add a source channel"/);
  });
});

describe("the overview", () => {
  it("shows only when the strips overflow", () => {
    expect(overflows(1000, 1000)).toBe(false);
    expect(overflows(1200, 1000)).toBe(true);
  });
  it("highlights the strips at least half in view", () => {
    expect(visibleStrips(row(10), 0, 600)).toEqual(["S0", "S1", "S2", "S3", "S4"]);
    // S2 (240–360) and S7 (840–960) are each exactly half in view (60 of 120 px): both count.
    expect(visibleStrips(row(10), 300, 600)).toEqual(["S2", "S3", "S4", "S5", "S6", "S7"]);
    expect(visibleStrips(row(10), 301, 600)).toEqual(["S3", "S4", "S5", "S6", "S7"]);
  });
  it("a click scrolls just enough to show the strip, and not at all if it is already in view", () => {
    expect(scrollToShow(row(10), "S8", 0, 600)).toBe(9 * 120 - 600);
    expect(scrollToShow(row(10), "S1", 600, 600)).toBe(120);
    expect(scrollToShow(row(10), "S2", 0, 600)).toBe(0);
  });
});

describe("narrow strips", () => {
  it("the dB number leaves the cap and shows while the fader moves; ON and PFL stack", () => {
    const cs = read("ConsoleStrip.tsx");
    expect(cs).toMatch(/\{!narrow && <FaderValue/);
    expect(cs).toMatch(/\{narrow && \(fc\.active \|\| typingOpen\) && \(/);
    expect(cs).toMatch(/flexDirection: narrow \? "column" : "row"/);
  });
  it("the source dropdown shows each source's short name, the full name on hover", () => {
    for (const k of SOURCE_KINDS) { expect(k.short.length, k.kind).toBeGreaterThan(0); expect(k.short.length, k.kind).toBeLessThanOrEqual(9); }
    const sc = read("SourceChannelStrip.tsx");
    expect(sc).toMatch(/\{narrow \? o\.short : o\.label\}/);
    expect(sc).toMatch(/title=\{`Source: \$\{fullSourceName\}`\}/);
  });
});
