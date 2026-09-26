import { describe, it, expect } from "vitest";
import fixture from "./eqCoeffs.fixture.json";
import {
  rbjPeak, rbjLowShelf, rbjHighShelf, butter4, magDb, sumDb, clampChannelModule, planChannel, bandBiquad, type Bq,
} from "./eqMath";
import type { ChannelRackDoc } from "./rackTypes";

// Slice 5 — docs/dsp-channel-rack-eq.md §5 "TS curve = engine". eqCoeffs.fixture.json is the engine's own
// coefficients (native/src/rack.rs, pinned there by rack::ts_parity); the port must match them to 1e-9.
type Case = { kind: string; f: number; g: number; w: number; fs: number; bq: number[][]; magDb: { at: number[]; db: number[] } };
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe("eqMath — the TS port is the engine's coefficients", () => {
  const cases = (fixture as { cases: Case[] }).cases;

  it("50 parameter sets, every coefficient within 1e-9 relative of the engine's", () => {
    expect(cases.length).toBe(50);
    let worst = 0, n = 0;
    for (const c of cases) {
      const ts: Bq[] = c.kind === "peak" ? [rbjPeak(c.f, c.g, c.w, c.fs)]
        : c.kind === "low_shelf" ? [rbjLowShelf(c.f, c.g, c.w, c.fs)]
        : c.kind === "high_shelf" ? [rbjHighShelf(c.f, c.g, c.w, c.fs)]
        : butter4(c.f, c.fs, c.kind === "hpf");
      expect(ts.length).toBe(c.bq.length);
      ts.forEach((b, i) => [b.b0, b.b1, b.b2, b.a1, b.a2].forEach((v, k) => { worst = Math.max(worst, rel(v, c.bq[i][k])); n++; }));
      // and the drawn magnitude at four frequencies
      c.magDb.at.forEach((f, k) => expect(Math.abs(sumDb(ts, f, c.fs) - c.magDb.db[k])).toBeLessThan(1e-9));
    }
    console.log(`[ts-parity] ${cases.length} cases, ${n} coefficients: worst relative ${worst.toExponential(1)} (bar 1e-9)`);
    expect(worst).toBeLessThan(1e-9);
  });

  it("the computed receipts: HPF 100 Hz −3.010 / −24.100 / −48.165; PEQ 1 kHz +6 → 6.000 / 0.033 / 0.022", () => {
    const h = butter4(100, 44100, true);
    expect(sumDb(h, 100)).toBeCloseTo(-3.010, 3);
    expect(sumDb(h, 50)).toBeCloseTo(-24.100, 3);
    expect(sumDb(h, 25)).toBeCloseTo(-48.165, 3);
    const p = rbjPeak(1000, 6, 1);
    expect(magDb(p, 1000)).toBeCloseTo(6, 9);
    expect(magDb(p, 100)).toBeCloseTo(0.0328, 3);
    expect(magDb(p, 10000)).toBeCloseTo(0.0224, 3);
  });

  it("the engine's clamps, in f32 like the engine stores them", () => {
    const f = clampChannelModule({ type: "filters", hpf: { in: true, freq: 5 }, lpf: { in: true, freq: 99999 } });
    expect(f).toEqual({ type: "filters", hpf: { in: true, freq: Math.fround(16.1) }, lpf: { in: true, freq: 20200 } });
    const q = clampChannelModule({ type: "peq", bands: [
      { freq: 100, gain: 40, width: 9, shelf: true }, { freq: 1000, gain: -40, width: 0.01, shelf: true },
      { freq: NaN, gain: NaN, width: NaN }, { freq: 8000, gain: 1.1, width: 1, shelf: true }] });
    if (q.type !== "peq") throw new Error("type");
    expect(q.bands[0]).toEqual({ freq: 100, gain: 14, width: 3, shelf: true });
    expect(q.bands[1]).toEqual({ freq: 1000, gain: -14, width: Math.fround(0.2), shelf: false });   // shelf only on bands 1 and 4
    expect(q.bands[2]).toEqual({ freq: 1000, gain: 0, width: 1, shelf: false });                  // non-finite → the engine's defaults
    expect(q.bands[3].gain).toBe(Math.fround(1.1));
  });

  it("the plan runs only what is IN; a 0 dB band is skipped (an exact identity)", () => {
    const doc: ChannelRackDoc = { v: 1, sections: { ch: [
      { id: "f", in: true, module: { type: "filters", hpf: { in: true, freq: 80 }, lpf: { in: false, freq: 12000 } } },
      { id: "q", in: true, module: { type: "peq", bands: [
        { freq: 100, gain: 0, width: 1 }, { freq: 1000, gain: 3, width: 1 }, { freq: 3000, gain: 0, width: 1 }, { freq: 8000, gain: 0, width: 1 }] } }] } };
    expect(planChannel(doc).length).toBe(3);   // HPF (2 sections) + band 2
    expect(planChannel({ ...doc, sections: { ch: doc.sections.ch.map(s => ({ ...s, in: false })) } }).length).toBe(0);
    expect(bandBiquad({ freq: 100, gain: 0, width: 1 }, 0)).toBeNull();
  });
});
