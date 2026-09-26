import { describe, it, expect } from "vitest";
import {
  scaleRange, loudFrac, targetFrac, fmtLufs, fmtLu, ceilingLabel, sinceLabel, incompleteLabel,
  rideFrac, limFrac, LIM_FULL_DB,
} from "./loudnessWire";

// Slice 3 — docs/dsp-loudness-meter.md §4. The panel's arithmetic, pinned.
describe("loudnessWire", () => {
  it("scales are centred on the branch's OWN target (ruling 5) with the Tech 3341 §2.7 spans", () => {
    expect(scaleRange(-14, 9)).toEqual({ lo: -32, hi: -5 });     // −18 … +9 LU around −14
    expect(scaleRange(-23, 9)).toEqual({ lo: -41, hi: -14 });    // = EBU +9 scale when the target is −23
    expect(scaleRange(-23, 18)).toEqual({ lo: -59, hi: -5 });    // = EBU +18 scale when the target is −23
    expect(loudFrac(-14, -14, 9)).toBeCloseTo(targetFrac(9), 9); // the target sits on the target line
    expect(loudFrac(-16, -16, 18)).toBeCloseTo(targetFrac(18), 9);
    expect(loudFrac(null, -14, 9)).toBe(0);
    expect(loudFrac(0, -14, 9)).toBe(1);
  });

  it("formats with a true minus and never shows -Infinity / NaN", () => {
    expect(fmtLufs(-23)).toBe("−23.0");
    expect(fmtLufs(null)).toBe("—");
    expect(fmtLufs(-Infinity)).toBe("—");
    expect(fmtLu(5.24)).toBe("5.2");
    expect(fmtLu(NaN)).toBe("—");
  });

  it("the ceiling label says what the limiter does (ruling 3, exact text)", () => {
    expect(ceilingLabel(-1.0, -2.214)).toBe("−1.0 dBTP set · limits at −2.2 dBTP");
  });

  it("since / 24 h window / incomplete", () => {
    expect(sinceLabel(0, true)).toBe("24 h window");
    expect(sinceLabel(new Date(2026, 8, 25, 14, 2, 11).getTime(), false)).toBe("since 14:02:11");
    expect(incompleteLabel(0)).toBeNull();
    expect(incompleteLabel(3.24)).toBe("incomplete: 3.2 s not measured");
  });

  it("ride is bipolar around 0; limiter runs 0 … LIM_FULL_DB down", () => {
    expect(rideFrac(0, 12)).toBe(0.5);
    expect(rideFrac(12, 12)).toBe(1);
    expect(rideFrac(-6, 12)).toBe(0.25);
    expect(rideFrac(40, 12)).toBe(1);
    expect(limFrac(0)).toBe(0);
    expect(limFrac(LIM_FULL_DB / 2)).toBe(0.5);
    expect(limFrac(99)).toBe(1);
  });
});
