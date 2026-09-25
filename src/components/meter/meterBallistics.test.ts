import { describe, it, expect } from "vitest";
import {
  initialMeter, stepMeter, avgDbOf, overLit, linToDb, dbToFrac, zoneOf,
  PEAK_FALL_DB_PER_S, PEAK_HOLD_MS, AVG_TAU_MS, OVER_HOLD_MS, ALIGN_DB,
} from "./meterBallistics";

// Slice 2 — docs/dsp-meter-bus.md §2/§4: the ballistics are pinned here, not by eye.
const SINE_M18_RMS = Math.pow(10, -18 / 20);            // −18 dBFS RMS
const SINE_M18_PEAK = SINE_M18_RMS * Math.SQRT2;        // −14.99 dBFS peak

describe("meterBallistics", () => {
  it("reads a −18 dBFS RMS sine as −18 average / −15 peak (plain RMS, ruling 2)", () => {
    let s = initialMeter(0);
    for (let t = 33; t <= 5000; t += 33) s = stepMeter(s, { peak: SINE_M18_PEAK, rms: SINE_M18_RMS }, t);
    expect(avgDbOf(s)).toBeCloseTo(-18, 2);
    expect(s.peakDb).toBeCloseTo(-14.99, 2);
  });

  it("peak: instant attack, then returns at PEAK_FALL_DB_PER_S (20 dB in 1.7 s)", () => {
    let s = initialMeter(0);
    s = stepMeter(s, { peak: 1.0, rms: 0.5 }, 0);
    expect(s.peakDb).toBeCloseTo(0, 6);
    s = stepMeter(s, null, 1700);
    expect(s.peakDb).toBeCloseTo(-20, 6);
    expect(PEAK_FALL_DB_PER_S).toBeCloseTo(20 / 1.7, 9);
  });

  it("hold marker stays PEAK_HOLD_MS, then falls at the peak rate", () => {
    let s = initialMeter(0);
    s = stepMeter(s, { peak: 0.5, rms: 0.1 }, 0);
    const held = s.holdDb;
    s = stepMeter(s, null, PEAK_HOLD_MS - 10);
    expect(s.holdDb).toBe(held);
    s = stepMeter(s, null, PEAK_HOLD_MS + 1000);
    expect(s.holdDb).toBeLessThan(held);
  });

  it("average: one-pole on power with AVG_TAU_MS — 63 % of a step at one time constant", () => {
    let s = initialMeter(0);
    s = stepMeter(s, { peak: 1, rms: 1 }, AVG_TAU_MS);
    expect(s.avgPow).toBeCloseTo(1 - Math.exp(-1), 6);
  });

  it("is RATE-INDEPENDENT: the same input at 30 Hz and at 1 Hz reaches the same average at the same wall time", () => {
    const win = { peak: 0.5, rms: 0.25 };
    let fast = initialMeter(0), slow = initialMeter(0);
    for (let t = 1000 / 30; t <= 3000 + 1e-9; t += 1000 / 30) fast = stepMeter(fast, win, t);
    for (let t = 1000; t <= 3000; t += 1000) slow = stepMeter(slow, win, t);
    expect(avgDbOf(fast)).toBeCloseTo(avgDbOf(slow), 3);
  });

  it("draws with no new window do not decay the average (no fresh data is not silence)", () => {
    let s = initialMeter(0);
    s = stepMeter(s, { peak: 0.5, rms: 0.25 }, 5000);
    const a = s.avgPow;
    for (let t = 5016; t < 5100; t += 16) s = stepMeter(s, null, t);
    expect(s.avgPow).toBe(a);
  });

  it("OVER lights at full scale and holds OVER_HOLD_MS", () => {
    let s = initialMeter(0);
    s = stepMeter(s, { peak: 1.0, rms: 0.7 }, 100);
    expect(overLit(s, 100 + OVER_HOLD_MS - 1)).toBe(true);
    expect(overLit(s, 100 + OVER_HOLD_MS + 1)).toBe(false);
    let t = initialMeter(0);
    t = stepMeter(t, { peak: 0.99, rms: 0.7 }, 100);
    expect(overLit(t, 101)).toBe(false);
  });

  it("scale and zones: −60..0 dBFS, green below −18, amber to −6, red above", () => {
    expect(dbToFrac(-60)).toBe(0);
    expect(dbToFrac(0)).toBe(1);
    expect(dbToFrac(-30)).toBeCloseTo(0.5, 9);
    expect(zoneOf(-20)).toBe("green");
    expect(zoneOf(ALIGN_DB)).toBe("amber");
    expect(zoneOf(-6)).toBe("red");
    expect(linToDb(0)).toBe(-Infinity);
  });
});
