import { describe, it, expect } from "vitest";
import { bandEdges, dbfsY, holdStep, coarseSpan, geqX, fineFreq, fineEdges, autoTop, barY, groupBars, LEVEL_STOPS, FINE_N } from "./rta";
import { geqResponseDb, x as axisX, FREQ_GRID, DB_GRID } from "./scopeAxis";

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

  it("the X32 colours: blue at the base → green → yellow, RED only at the very top", () => {
    const at = LEVEL_STOPS.map(s => s.at);
    expect([...at].sort((a, b) => b - a)).toEqual(at);
    expect(LEVEL_STOPS[LEVEL_STOPS.length - 1]).toEqual({ at: 0, color: "#1d4ed8" });          // blue at the floor
    const reds = LEVEL_STOPS.filter(s => s.color === "#ef4444");
    expect(Math.min(...reds.map(s => s.at))).toBeGreaterThanOrEqual(0.94);                      // red only at the top
    expect(LEVEL_STOPS.some(s => s.color === "#22c55e") && LEVEL_STOPS.some(s => s.color === "#facc15")).toBe(true);
  });

  it("the X32 bars: 1/12 octave, ~120 across 20 Hz–20 kHz, edge to edge, each the loudest fine point inside it", () => {
    const fine = Array.from({ length: FINE_N }, (_, k) => -60 + (k % 7));
    const bars = groupBars(fine);
    expect(bars.length).toBe(120);
    expect(bars[0].lo).toBe(20);
    expect(bars[bars.length - 1].hi).toBeCloseTo(20000, 6);
    for (let i = 1; i < bars.length; i++) expect(bars[i].lo / bars[i - 1].hi).toBeCloseTo(1, 12);
    // every fine point lands in exactly one bar, and a bar shows its loudest
    const b = bars[60];
    const inside = fine.filter((_, k) => fineFreq(k) >= b.lo - 1e-9 && fineFreq(k) < b.hi - 1e-9);
    expect(inside.length).toBeGreaterThanOrEqual(1);
    expect(b.level).toBe(Math.max(...inside));
  });

  it("the master GEQ curve is the engine's filters: +6 at 1 kHz reads +6.00 there, flat reads 0", () => {
    const bands = [0, 0, 0, 0, 0, 6, 0, 0, 0, 0];
    expect(geqResponseDb(bands, 1000)).toBeCloseTo(6, 2);
    expect(geqResponseDb(bands, 250)).toBeLessThan(1);
    expect(geqResponseDb(new Array(10).fill(0), 1000)).toBe(0);
  });

  it("the X32 grid: the frequency lines and dB lines, on the one shared axis", () => {
    expect(FREQ_GRID).toEqual([20, 40, 60, 80, 100, 200, 400, 600, 800, 1000, 2000, 4000, 6000, 8000, 10000, 20000]);
    expect(DB_GRID).toEqual([15, 10, 5, 0, -5, -10, -15]);
    expect(axisX(20)).toBeLessThan(axisX(20000));
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
