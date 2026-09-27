import { describe, it, expect } from "vitest";
import { bandEdges, dbfsY, rtaPath, holdStep, coarseSpan, geqX, RTA_BANDS, RTA_FLOOR_DB } from "./rta";

describe("the RTA drawing (slice 8)", () => {
  it("band edges are the engine's: exact base-2 third octaves around 1 kHz", () => {
    const [lo, hi] = bandEdges(17);
    expect(lo).toBeCloseTo(1000 * Math.pow(2, -1 / 6), 6);
    expect(hi).toBeCloseTo(1000 * Math.pow(2, 1 / 6), 6);
    // adjacent bands share an edge: nothing is counted twice or dropped
    expect(bandEdges(16)[1]).toBeCloseTo(bandEdges(17)[0], 9);
  });

  it("dBFS maps 0 to the top and −90 (or lower) to the bottom", () => {
    expect(dbfsY(0, 10, 100)).toBe(10);
    expect(dbfsY(-45, 10, 100)).toBe(55);
    expect(dbfsY(-120, 10, 100)).toBe(100);
  });

  it("the step outline puts each band's level across its own edges, on the caller's x", () => {
    const x = (f: number) => Math.log10(f);                     // any monotonic axis: the view's own
    const lv = new Array(RTA_BANDS).fill(RTA_FLOOR_DB); lv[17] = -18;
    const p = rtaPath(lv, x, 0, 90, 20, 20000);
    const [lo, hi] = bandEdges(17);
    expect(p).toContain(`L${x(lo).toFixed(1)},18.0L${x(hi).toFixed(1)},18.0`);
    expect(p.startsWith("M")).toBe(true);
    expect(p.endsWith("Z")).toBe(true);
  });

  it("peak hold keeps a band's highest level for 2 s, then follows it down", () => {
    let h = holdStep(null, new Array(RTA_BANDS).fill(-20), 0);
    h = holdStep(h, new Array(RTA_BANDS).fill(-40), 1000);
    expect(h.v[0]).toBe(-20);
    h = holdStep(h, new Array(RTA_BANDS).fill(-40), 2500);
    expect(h.v[0]).toBe(-40);
  });

  it("the coarse hatch covers the bands below the engine's limit", () => {
    const x = (f: number) => f;
    const s = coarseSpan(160, x, 20)!;
    expect(s[0]).toBe(20);
    expect(s[1]).toBeCloseTo(bandEdges(9)[0], 6);   // up to the lower edge of the 160 Hz band
    expect(coarseSpan(0, x, 20)).toBeNull();
  });

  it("the master GEQ axis puts each fader over its own octave", () => {
    const x = geqX(1000);
    [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].forEach((f, i) => expect(x(f)).toBeCloseTo(100 * i + 50, 6));
  });
});
