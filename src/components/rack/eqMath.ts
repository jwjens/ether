// ── eqMath — the channel EQ's coefficients, the TS port of the engine's (Slice 5, docs/dsp-channel-rack-eq.md §4, §5)
//
// THE DRAWN CURVE IS WHAT THE ENGINE RUNS. Every function here is a line-for-line port of native/src/rack.rs
// (rbj_peak / rbj_low_shelf / rbj_high_shelf / rbj_pass / butter4 / Biquad::mag_db / the channel clamps), and
// eqMath.test.ts pins them to the engine's own coefficients through eqCoeffs.fixture.json (which rack::ts_parity
// pins to Rust) at 1e-9 relative. The engine stores a channel's numbers as f32, so `clampChannelModule` rounds
// them the same way (Math.fround) — the curve is computed from the numbers the engine actually runs.
import type { ChannelModule, FilterModule, PeqModule, PeqBand, ChannelRackDoc } from "./rackTypes";

/** The engine's program rate (the curve is drawn at the rate the filters run at). */
export const FS = 44_100;
/** Ranges (rack.rs HPF_HZ / LPF_HZ / PEQ_HZ / PEQ_GAIN_DB / PEQ_WIDTH_OCT / NYQUIST_FRACTION). */
export const HPF_HZ = [16.1, 500] as const;
export const LPF_HZ = [1000, 20200] as const;
export const PEQ_HZ = [16.1, 20200] as const;
export const PEQ_GAIN_DB = 14;
export const PEQ_WIDTH_OCT = [0.2, 3.0] as const;
export const NYQUIST_FRACTION = 0.45;

export type Bq = { b0: number; b1: number; b2: number; a1: number; a2: number };

const norm = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Bq =>
  ({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });
const w0 = (f: number, fs: number) => 2 * Math.PI * Math.min(f, fs * NYQUIST_FRACTION) / fs;

/** Width in octaves → Q (RBJ): Q = √(2^BW) / (2^BW − 1). */
export function widthToQ(bwOct: number): number { const p = Math.pow(2, bwOct); return Math.sqrt(p) / (p - 1); }

export function rbjPeak(f: number, gainDb: number, bwOct: number, fs = FS): Bq {
  const a = Math.pow(10, gainDb / 40), w = w0(f, fs), al = Math.sin(w) / (2 * widthToQ(bwOct)), c = Math.cos(w);
  return norm(1 + al * a, -2 * c, 1 - al * a, 1 + al / a, -2 * c, 1 - al / a);
}
export function rbjLowShelf(f: number, gainDb: number, bwOct: number, fs = FS): Bq {
  const a = Math.pow(10, gainDb / 40), w = w0(f, fs), c = Math.cos(w), al = Math.sin(w) / (2 * widthToQ(bwOct));
  const t = 2 * Math.sqrt(a) * al;
  return norm(a * ((a + 1) - (a - 1) * c + t), 2 * a * ((a - 1) - (a + 1) * c), a * ((a + 1) - (a - 1) * c - t),
              (a + 1) + (a - 1) * c + t, -2 * ((a - 1) + (a + 1) * c), (a + 1) + (a - 1) * c - t);
}
export function rbjHighShelf(f: number, gainDb: number, bwOct: number, fs = FS): Bq {
  const a = Math.pow(10, gainDb / 40), w = w0(f, fs), c = Math.cos(w), al = Math.sin(w) / (2 * widthToQ(bwOct));
  const t = 2 * Math.sqrt(a) * al;
  return norm(a * ((a + 1) + (a - 1) * c + t), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - t),
              (a + 1) - (a - 1) * c + t, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - t);
}
export function rbjPass(f: number, q: number, fs: number, high: boolean): Bq {
  const w = w0(f, fs), c = Math.cos(w), al = Math.sin(w) / (2 * q);
  return high ? norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al)
              : norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
}
/** 4th-order Butterworth: two sections, Q = 1/(2 cos π/8) and 1/(2 cos 3π/8). */
export function butter4(f: number, fs: number, high: boolean): [Bq, Bq] {
  const q1 = 1 / (2 * Math.cos(Math.PI / 8)), q2 = 1 / (2 * Math.cos(3 * Math.PI / 8));
  return [rbjPass(f, q1, fs, high), rbjPass(f, q2, fs, high)];
}
/** |H(e^{jω})| in dB at `f`. */
export function magDb(b: Bq, f: number, fs = FS): number {
  const w = 2 * Math.PI * f / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b.b0 + b.b1 * c1 + b.b2 * c2, ni = -(b.b1 * s1 + b.b2 * s2);
  const dr = 1 + b.a1 * c1 + b.a2 * c2, di = -(b.a1 * s1 + b.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

// ── the engine's clamps (rack.rs clamp_channel_module), in f32 like the engine stores them ─────────────
const f32 = Math.fround;
const fin = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function clampBand(b: PeqBand, i: number): PeqBand {
  return {
    freq: f32(clamp(f32(fin(b.freq, 1000)), f32(PEQ_HZ[0]), f32(PEQ_HZ[1]))),
    gain: f32(clamp(f32(fin(b.gain, 0)), -PEQ_GAIN_DB, PEQ_GAIN_DB)),
    width: f32(clamp(f32(fin(b.width, 1)), f32(PEQ_WIDTH_OCT[0]), f32(PEQ_WIDTH_OCT[1]))),
    shelf: !!b.shelf && (i === 0 || i === 3),
  };
}
export function clampChannelModule(m: ChannelModule): ChannelModule {
  if (m.type === "filters") return {
    type: "filters",
    hpf: { in: !!m.hpf.in, freq: f32(clamp(f32(fin(m.hpf.freq, 100)), f32(HPF_HZ[0]), f32(HPF_HZ[1]))) },
    lpf: { in: !!m.lpf.in, freq: f32(clamp(f32(fin(m.lpf.freq, 10000)), f32(LPF_HZ[0]), f32(LPF_HZ[1]))) },
  };
  return { type: "peq", bands: m.bands.map((b, i) => clampBand(b, i)) as PeqModule["bands"] };
}

/** One PEQ band's biquad, or null for a 0 dB band (the engine skips it — an exact identity). */
export function bandBiquad(b: PeqBand, i: number, fs = FS): Bq | null {
  const c = clampBand(b, i);
  if (Math.abs(c.gain) < 1e-6) return null;
  if (c.shelf && i === 0) return rbjLowShelf(c.freq, c.gain, c.width, fs);
  if (c.shelf && i === 3) return rbjHighShelf(c.freq, c.gain, c.width, fs);
  return rbjPeak(c.freq, c.gain, c.width, fs);
}
export function filterBiquads(m: FilterModule, which: "hpf" | "lpf", fs = FS): Bq[] {
  const c = clampChannelModule(m) as FilterModule;
  return c[which].in ? butter4(c[which].freq, fs, which === "hpf") : [];
}

/** Every biquad the engine runs for this rack (slot order; OUT slots and 0 dB bands skipped) — ChannelRack::plan. */
export function planChannel(doc: ChannelRackDoc, fs = FS): Bq[] {
  const out: Bq[] = [];
  for (const s of doc.sections.ch) {
    if (!s.in || !s.module) continue;
    if (s.module.type === "filters") out.push(...filterBiquads(s.module, "hpf", fs), ...filterBiquads(s.module, "lpf", fs));
    else s.module.bands.forEach((b, i) => { const q = bandBiquad(b, i, fs); if (q) out.push(q); });
  }
  return out.slice(0, 8);
}
export const sumDb = (bqs: Bq[], f: number, fs = FS) => bqs.reduce((a, b) => a + magDb(b, f, fs), 0);
