// Meter arithmetic. A meter that maps its scale wrongly is confidently wrong rather than broken —
// it shows a plausible bar for the wrong level — so the mapping is tested on its own.
import { describe, it, expect } from "vitest";
import {
  ampToDbfs, dbToPercent, peakLevel, loudnessLevel, peakHold, fmtDb, METER_WORD,
} from "./meterScale";

describe("ampToDbfs — linear amplitude is NOT a level", () => {
  it("converts amplitude to dBFS", () => {
    expect(ampToDbfs(1)).toBeCloseTo(0, 5);
    expect(ampToDbfs(0.5)).toBeCloseTo(-6.02, 1);
    expect(ampToDbfs(0.1)).toBeCloseTo(-20, 1);
  });

  it("floors silence at -70 instead of -Infinity", () => {
    expect(ampToDbfs(0)).toBe(-70);
    expect(ampToDbfs(-1)).toBe(-70);
    expect(ampToDbfs(null)).toBe(-70);
    expect(ampToDbfs(NaN)).toBe(-70);
  });
});

describe("dbToPercent — a dB scale, not a linear one", () => {
  it("puts the floor at 0% and full scale at 100%", () => {
    expect(dbToPercent(-60)).toBe(0);
    expect(dbToPercent(-70)).toBe(0);
    expect(dbToPercent(0)).toBe(100);
    expect(dbToPercent(6)).toBe(100);      // clamped, never over-fills
  });

  it("puts the midpoint at -30 dB, NOT at half amplitude", () => {
    // The whole point: filling linearly from amplitude puts everything above ~0.5 in the top half
    // and makes quiet content invisible. -6 dBFS is 0.5 amplitude but must read as 90%, not 50%.
    expect(dbToPercent(-30)).toBeCloseTo(50, 1);
    expect(dbToPercent(-6)).toBeCloseTo(90, 1);
  });

  it("never returns NaN or a negative width", () => {
    for (const v of [NaN, Infinity, -Infinity, null, undefined]) {
      const p = dbToPercent(v as any);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });
});

describe("peakLevel — monotonic, because for PEAK louder really is worse", () => {
  it("escalates toward the ceiling", () => {
    expect(peakLevel(-55)).toBe("quiet");
    expect(peakLevel(-20)).toBe("good");
    expect(peakLevel(-4)).toBe("hot");
    expect(peakLevel(-0.5)).toBe("clip");
    expect(peakLevel(0)).toBe("clip");
  });

  it("treats -1 dBTP as the ceiling — the level the limiter holds", () => {
    expect(peakLevel(-1.01)).toBe("hot");
    expect(peakLevel(-1)).toBe("clip");
  });

  it("is 'quiet', not 'good', with no signal", () => {
    expect(peakLevel(null)).toBe("quiet");
    expect(peakLevel(NaN)).toBe("quiet");
  });
});

describe("loudnessLevel — a BAND, because too quiet is also a fault", () => {
  const T = -14;

  it("is good ON the target, in BOTH directions", () => {
    // The spec's green->yellow->red ramp would mark -20 LUFS as the safest possible reading. It is
    // 6 LU under target: just as wrong as 6 over, and a monotonic ramp trains an operator to push
    // level until amber appears.
    expect(loudnessLevel(-14, T)).toBe("good");
    expect(loudnessLevel(-13.2, T)).toBe("good");
    expect(loudnessLevel(-14.9, T)).toBe("good");
  });

  it("flags drift either side, and marks a big miss in either direction", () => {
    expect(loudnessLevel(-11.5, T)).toBe("hot");    // 2.5 over
    expect(loudnessLevel(-16.5, T)).toBe("hot");    // 2.5 under
    expect(loudnessLevel(-8, T)).toBe("clip");      // 6 over
    expect(loudnessLevel(-20, T)).toBe("clip");     // 6 UNDER — equally wrong
  });

  it("reads silence as quiet rather than as maximally off-target", () => {
    expect(loudnessLevel(-70, T)).toBe("quiet");
    expect(loudnessLevel(null, T)).toBe("quiet");
  });

  it("follows the target when it changes — -23 LUFS is EBU R128", () => {
    expect(loudnessLevel(-23, -23)).toBe("good");
    expect(loudnessLevel(-14, -23)).toBe("clip");
  });
});

describe("peakHold — rides, holds, then falls", () => {
  it("jumps straight to a new peak", () => {
    const a = peakHold(null, -20, 0);
    expect(a.db).toBe(-20);
    const b = peakHold(a, -6, 100);
    expect(b.db).toBe(-6);
    expect(b.heldSince).toBe(100);
  });

  it("HOLDS for the hold window rather than tracking the bar down", () => {
    const a = peakHold(null, -6, 0);
    expect(peakHold(a, -40, 500).db).toBe(-6);
    expect(peakHold(a, -40, 1199).db).toBe(-6);
  });

  it("falls after the hold, at the stated rate — 20 dB/s", () => {
    const a = peakHold(null, -6, 0);
    const after = peakHold(a, -40, 1200 + 500);       // 0.5s of fall = 10 dB
    expect(after.db).toBeCloseTo(-16, 1);
  });

  it("settles onto the signal rather than falling through it", () => {
    const a = peakHold(null, -6, 0);
    const far = peakHold(a, -30, 1200 + 5000);        // would fall 100 dB
    expect(far.db).toBe(-30);
  });
});

describe("fmtDb", () => {
  it("shows one decimal", () => {
    expect(fmtDb(-14.23)).toBe("-14.2");
    expect(fmtDb(0)).toBe("0.0");
  });

  it("shows an em dash rather than 'NaN' or '-Infinity'", () => {
    expect(fmtDb(null)).toBe("—");
    expect(fmtDb(NaN)).toBe("—");
    expect(fmtDb(-Infinity)).toBe("—");
    expect(fmtDb(-70)).toBe("—");
  });
});

describe("METER_WORD — status is not carried by colour alone", () => {
  it("gives every level a word, for red/green colour deficiency", () => {
    for (const k of ["quiet", "good", "hot", "clip"] as const) {
      expect(METER_WORD[k]).toBeTruthy();
    }
    expect(METER_WORD.clip).toBe("over");
  });
});
