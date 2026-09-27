import { describe, it, expect } from "vitest";
import fixture from "./dynCurve.fixture.json";
import { compGrDb, gateGrDb, clampComp, clampGate, chainOutDb } from "./dynMath";

// Slice 6 — docs/dsp-channel-dynamics.md §2 "TS curve = engine". dynCurve.fixture.json is the engine's own static
// curves (native/src/rack.rs, pinned there by rack::ts_dyn_parity); the port must match them to 1e-9.
type Case = { kind: "comp" | "gate"; t: number; r: number; w?: number; depth?: number; x: number[]; gr: number[] };

describe("dynMath — the transfer graph is the engine's curves", () => {
  it("50 parameter sets × 9 input levels within 1e-9 dB of the engine", () => {
    const cases = (fixture as { cases: Case[] }).cases;
    expect(cases.length).toBe(50);
    let worst = 0;
    for (const c of cases) c.x.forEach((x, i) => {
      const v = c.kind === "comp" ? compGrDb(x, c.t, c.r, c.w!) : gateGrDb(x, c.t, c.r, c.depth!);
      worst = Math.max(worst, Math.abs(v - c.gr[i]));
    });
    console.log(`[ts-dyn-parity] ${cases.length} cases × 9 levels: worst |Δ| ${worst.toExponential(1)} dB (bar 1e-9)`);
    expect(worst).toBeLessThan(1e-9);
  });

  it("the spec's case: −10 dB over 4:1 at −20 dB (knee 6) → 7.5 dB of GR; the gate floor at the set depth", () => {
    expect(compGrDb(-10, -20, 4, 6)).toBeCloseTo(7.5, 12);
    expect(gateGrDb(-60, -45, 5, 15)).toBe(15);
    expect(chainOutDb(-60, { type: "gate", threshold: -45, ratio: 5, depth: 15, attack: 1, hold: 100, release: 150, hysteresis: 3 }, null)).toBe(-75);
  });

  it("the engine's clamps: makeup 0–24 (ruling 4), knee 0–12, gate ratio 1–5, hold 0–500", () => {
    const k = clampComp({ type: "comp", threshold: -99, ratio: 50, attack: 0, release: 9999, makeup: 36, knee: 40 });
    expect([k.threshold, k.ratio, k.release, k.makeup, k.knee]).toEqual([-40, 20, 3000, 24, 12]);
    expect(k.attack).toBe(Math.fround(0.1));
    const g = clampGate({ type: "gate", threshold: 5, ratio: 9, depth: 80, attack: 99, hold: 900, release: 1, hysteresis: 20 });
    expect([g.threshold, g.ratio, g.depth, g.attack, g.hold, g.release, g.hysteresis]).toEqual([0, 5, 40, 50, 500, 50, 10]);
  });
});
