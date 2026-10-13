// THE ONE CONSOLE FADER LAW (src/lib/faderLaw.ts; Jeff, 2026-10-11). Pinned: the law's points, the round trip, and
// that no saved level changes its gain when the law changes (stores hold GAIN; only where a fader is drawn moves).
import { describe, it, expect } from "vitest";
import { posToDb, posToGain, dbToPos, gainToPos, formatDb, FADER_LAW, UNITY_POS, MAX_GAIN, faderMarks, unityPos, topGain, DEFAULT_TOP_DB,
  stepGain, parseDbInput, lawProblem, setFaderLaw, faderLaw, FADER_LAW_START, setFaderFeel, faderFeel, FADER_FEEL_START } from "./faderLaw";

const dbOf = (g: number) => 20 * Math.log10(g);

describe("the console fader law", () => {
  it("hits Jeff's points exactly (option A, 2026-10-13)", () => {
    const want: [number, number][] = [[1, 10], [0.75, 0], [0.5, -10], [0.25, -20], [0.175, -30], [0.10, -40], [0.03, -60]];
    for (const [pos, db] of want) expect(posToDb(pos)).toBeCloseTo(db, 9);
    expect(posToGain(0)).toBe(0);                      // 0% = off
    expect(posToGain(UNITY_POS)).toBeCloseTo(1, 12);   // unity is marked at 75%
    expect(posToGain(1)).toBeCloseTo(MAX_GAIN, 12);    // +10 dB at the top
  });

  it("is monotonic over the whole travel — no dead band, no step back", () => {
    let prev = -Infinity;
    for (let i = 1; i <= 1000; i++) { const d = posToDb(i / 1000); expect(d).toBeGreaterThan(prev); prev = d; }
  });

  it("−20…+10 is 75 % of the travel, every dB 2.5 % wide (option A: Jeff could not set −5 dB)", () => {
    expect(posToDb(0.5)).toBe(-10);
    expect(posToDb(0.25)).toBe(-20);
    for (let d = -20; d <= 9; d += 0.5) expect(dbToPos(d + 1) - dbToPos(d)).toBeCloseTo(0.025, 12);
    expect(dbToPos(-5)).toBeCloseTo(0.625, 12);
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
    expect(gainToPos(0.15270909928001813) * 100).toBeCloseTo(34.19, 2);  // E −16.3 dB → 34.2% (option A; 40.5% before)
    expect(gainToPos(1) * 100).toBeCloseTo(75, 9);                       // 0 dB → 75%
    expect(gainToPos(0.4641) * 100).toBeCloseTo(58.3, 1);                // MONITOR −6.7 dB → 58.3%
  });

  it("MASTER and MONITOR top out at unity: the same curve, slid so 0 dB is the top (Jeff, 2026-10-11)", () => {
    expect(DEFAULT_TOP_DB).toEqual({ channel: 10, aux: 10, master: 0, monitor: 0 });
    expect(posToDb(1, 0)).toBeCloseTo(0, 12);       // top = unity
    expect(posToDb(0.75, 0)).toBeCloseTo(-10, 12);  // the same curve, 10 dB lower
    expect(posToDb(0.5, 0)).toBeCloseTo(-20, 12);
    expect(posToGain(0, 0)).toBe(0);                // off at the bottom
    expect(topGain(0)).toBeCloseTo(1, 12);
    expect(unityPos(0)).toBeCloseTo(1, 12);
    expect(faderMarks(0)[0]).toEqual({ label: "0", pos: 1, unity: true });
    // a top off the 10 dB grid still marks unity where it falls
    expect(faderMarks(6).some(m => m.unity && Math.abs(posToDb(m.pos, 6)) < 1e-9)).toBe(true);
    // round trip at any top
    for (const top of [0, 3, 6, 10]) for (let i = 1; i <= 200; i++) { const p = i / 200; expect(gainToPos(posToGain(p, top), top)).toBeCloseTo(p, 9); }
  });

  it("MIGRATION with group tops: every saved station-2 level keeps its gain; only where it is drawn moves", () => {
    const monitorGroup: Record<string, number> = { "master MONITOR": 0.4641, "station 2 MONITOR strip": 0.73 };
    for (const g of Object.values(monitorGroup)) expect(20 * Math.log10(posToGain(gainToPos(g, 0), 0))).toBeCloseTo(20 * Math.log10(g), 9);
    expect(gainToPos(0.4641, 0) * 100).toBeCloseTo(83.3, 1);   // −6.7 dB on a 0 dB-top fader
    expect(gainToPos(0.73, 0) * 100).toBeCloseTo(93.2, 1);     // −2.7 dB
    expect(gainToPos(1, 0)).toBeCloseTo(1, 12);                // a MASTER at 0 dB sits at the top
  });

  it("reads like a console scale", () => {
    expect(formatDb(1)).toBe("0.0 dB");
    expect(formatDb(MAX_GAIN)).toBe("+10.0 dB");
    expect(formatDb(0.15270909928001813)).toBe("−16.3 dB");
    expect(formatDb(0)).toBe("off");
  });
});

describe("fader handling (Jeff, 2026-10-13)", () => {
  const db = (g: number) => 20 * Math.log10(g);
  it("steps land on the step grid, stop at the group's top, go off below the travel and come back from off", () => {
    expect(db(stepGain(Math.pow(10, -5.3 / 20), -1, 0.5))).toBeCloseTo(-5.5, 9);
    expect(db(stepGain(Math.pow(10, -5.3 / 20), 1, 0.5))).toBeCloseTo(-5.0, 9);
    expect(db(stepGain(Math.pow(10, -5 / 20), 1, 0.5))).toBeCloseTo(-4.5, 9);
    expect(db(stepGain(Math.pow(10, -5 / 20), -1, 0.1))).toBeCloseTo(-5.1, 9);
    expect(db(stepGain(Math.pow(10, -0.2 / 20), 1, 0.5, 0))).toBeCloseTo(0, 9);      // MASTER/MONITOR top
    expect(db(stepGain(1, 1, 0.5, 0))).toBeCloseTo(0, 9);
    expect(stepGain(Math.pow(10, -89.8 / 20), -1, 0.5)).toBe(0);                    // below the travel → off
    expect(stepGain(0, -1, 0.5)).toBe(0);
    expect(stepGain(0, 1, 0.5)).toBeGreaterThan(0);                                  // off → the lowest step
  });
  it("reads a typed level", () => {
    expect(parseDbInput("-5")).toBe(-5);
    expect(parseDbInput("\u22125")).toBe(-5);
    expect(parseDbInput(" -5 dB ")).toBe(-5);
    expect(parseDbInput("+3.5")).toBe(3.5);
    expect(parseDbInput("off")).toBe(-Infinity);
    expect(parseDbInput("loud")).toBeNull();
  });
  it("a law must rise and end at 100 % = +10 dB; the saved law is what every fader draws with", () => {
    expect(lawProblem(FADER_LAW_START)).toBeNull();
    expect(lawProblem([{ pos: 0.5, db: 0 }, { pos: 0.4, db: 5 }, { pos: 1, db: 10 }])).not.toBeNull();
    expect(lawProblem([{ pos: 0.5, db: 0 }, { pos: 1, db: 6 }])).not.toBeNull();
    expect(setFaderLaw([{ pos: 0.5, db: 0 }, { pos: 1, db: 10 }])).toBe(true);
    expect(posToDb(0.75)).toBeCloseTo(5, 9);
    expect(setFaderLaw([{ pos: 0.5, db: 0 }])).toBe(false);                         // refused: the saved law stays
    expect(faderLaw()).toHaveLength(2);
    setFaderLaw(FADER_LAW_START);
    expect(posToDb(0.75)).toBeCloseTo(0, 9);
  });
  it("the feel takes only sane values", () => {
    setFaderFeel({ fine: 4, wheelDb: null, arrowDb: 99 });
    expect(faderFeel()).toEqual({ ...FADER_FEEL_START, fine: 4 });
    setFaderFeel(FADER_FEEL_START);
  });
});
