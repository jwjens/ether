import { describe, it, expect } from "vitest";
import { bandEdges, dbfsY, holdStep, coarseSpan, geqX, fineFreq, fineEdges, autoTop, barY, LEVEL_STOPS, FINE_N, RTA_BANDS } from "./rta";

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

  it("the fine points are the engine's: 241, 24 per octave, 20 Hz–20 kHz, bars edge to edge", () => {
    expect(FINE_N).toBe(241);
    expect(fineFreq(0)).toBeCloseTo(20, 9);
    expect(fineFreq(240)).toBeCloseTo(20000, 6);
    expect(fineFreq(1) / fineFreq(0)).toBeCloseTo(Math.pow(1000, 1 / 240), 12);   // 240 steps over 9.97 octaves ≈ 24.1 per octave
    for (let k = 1; k < FINE_N; k++) expect(fineEdges(k)[0] / fineEdges(k - 1)[1]).toBeCloseTo(1, 12);   // no gaps, no overlaps
  });

  it("the level colours run green at the base to red at the top — never one colour", () => {
    const at = LEVEL_STOPS.map(s => s.at);
    expect([...at].sort((a, b) => b - a)).toEqual(at);
    expect(new Set(LEVEL_STOPS.map(s => s.color)).size).toBeGreaterThanOrEqual(4);
    expect(LEVEL_STOPS[0].color).toBe("#ef4444");
  });

  it("the range follows the running peak like the old analyser: instant up, 2 dB/s down, 3 dB steps", () => {
    let t = autoTop(null, -30, 0);
    expect(t.topDb).toBe(-24);                         // −30 + 6 head → −24
    t = autoTop(t.ref, -20, 0.05);
    expect(t.ref).toBe(-20);                            // instant up
    t = autoTop(t.ref, -40, 1);
    expect(t.ref).toBe(-22);                            // released 2 dB in 1 s, not below the loudest
    expect(autoTop(null, 3, 0).topDb).toBe(0);          // never above 0 dBFS
    expect(barY(-24, -24, 0, 100)).toBe(0);
    expect(barY(-84, -24, 0, 100)).toBe(100);
  });

  it("peak hold keeps each point's highest level for 2 s, then follows it down", () => {
    let h = holdStep(null, new Array(FINE_N).fill(-20), 0);
    h = holdStep(h, new Array(FINE_N).fill(-40), 1000);
    expect(h.v[0]).toBe(-20);
    h = holdStep(h, new Array(FINE_N).fill(-40), 2500);
    expect(h.v.length).toBe(FINE_N);
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
