// THE ONE CONSOLE FADER LAW (src/lib/faderLaw.ts; Jeff, 2026-10-11). Pinned: the law's points, the round trip, and
// that no saved level changes its gain when the law changes (stores hold GAIN; only where a fader is drawn moves).
import { describe, it, expect } from "vitest";
import { posToDb, posToGain, dbToPos, gainToPos, formatDb, FADER_LAW, UNITY_POS, MAX_GAIN } from "./faderLaw";

const dbOf = (g: number) => 20 * Math.log10(g);

describe("the console fader law", () => {
  it("hits Jeff's points exactly", () => {
    const want: [number, number][] = [[1, 10], [0.75, 0], [0.5, -10], [0.35, -20], [0.25, -30], [0.15, -40], [0.05, -60]];
    for (const [pos, db] of want) expect(posToDb(pos)).toBeCloseTo(db, 9);
    expect(posToGain(0)).toBe(0);                      // 0% = off
    expect(posToGain(UNITY_POS)).toBeCloseTo(1, 12);   // unity is marked at 75%
    expect(posToGain(1)).toBeCloseTo(MAX_GAIN, 12);    // +10 dB at the top
  });

  it("is monotonic over the whole travel — no dead band, no step back", () => {
    let prev = -Infinity;
    for (let i = 1; i <= 1000; i++) { const d = posToDb(i / 1000); expect(d).toBeGreaterThan(prev); prev = d; }
  });

  it("the bottom half is usable: halfway is −10 dB (the old channel law put −30 dB there)", () => {
    expect(posToDb(0.5)).toBe(-10);
    expect(posToDb(0.25)).toBe(-30);
  });

  it("round-trips position ↔ dB ↔ gain", () => {
    for (let i = 1; i <= 1000; i++) {
      const p = i / 1000;
      expect(dbToPos(posToDb(p))).toBeCloseTo(p, 9);
      expect(gainToPos(posToGain(p))).toBeCloseTo(p, 9);
    }
    for (const pt of FADER_LAW) expect(dbToPos(pt.db)).toBeCloseTo(pt.pos, 12);
  });

  it("MIGRATION: every saved gain on station 2 keeps its exact level — only the fader's drawn position moves", () => {
    // Station 2's saved board (2026-10-11), after B and C are set to 0 dB as ruled. Stores hold GAIN.
    const saved: Record<string, number> = {
      "B": 1, "C": 1, "D": 1, "E": 0.15270909928001813, "H": 0,
      "MONITOR": 0.4641, "station 2 MONITOR strip": 0.73,
      "AUX D": 0.82, "AUX E": 0.83, "AUX G": 0.74, "AUX F": 0.56, "AUX H": 1,
    };
    for (const [, g] of Object.entries(saved)) {
      const pos = gainToPos(g);                       // where the new law draws it
      const back = posToGain(pos);                    // what a fader at that position sends
      if (g === 0) expect(back).toBe(0);
      else expect(dbOf(back)).toBeCloseTo(dbOf(g), 9);   // the same level, to a billionth of a dB
    }
    // A few, as the table in the report shows them.
    expect(gainToPos(0.15270909928001813) * 100).toBeCloseTo(40.52, 2);  // E −16.3 dB → 40.5%
    expect(gainToPos(1) * 100).toBeCloseTo(75, 9);                       // 0 dB → 75%
    expect(gainToPos(0.4641) * 100).toBeCloseTo(58.3, 1);                // MONITOR −6.7 dB → 58.3%
  });

  it("reads like a console scale", () => {
    expect(formatDb(1)).toBe("0.0 dB");
    expect(formatDb(MAX_GAIN)).toBe("+10.0 dB");
    expect(formatDb(0.15270909928001813)).toBe("−16.3 dB");
    expect(formatDb(0)).toBe("off");
  });
});
