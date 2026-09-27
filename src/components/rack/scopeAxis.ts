// scopeAxis.ts — the ONE axis both spectrum graphs draw on (the channel EqCurve and the master GEQ graph), so a
// frequency or a dB lands in the same place in both, and the RTA bars, the grid and the curve share one x and one y.
// The look is the Behringer X32 RTA (Jeff's reference, docs/dsp-channel-rta.md): a visible grid — dB lines −15…+15
// for the EQ, the RTA's own dBFS scale on the right, frequency lines at 20/40/60/80/100/200/…/20k labelled along the
// bottom — the EQ curve in yellow on top, numbered band markers.

export const W = 800, H = 280, PL = 40, PR = 44, PT = 22, PB = 22;
export const F0 = 20, F1 = 20000, DB = 15;
export const x = (f: number) => PL + (Math.log10(f / F0) / Math.log10(F1 / F0)) * (W - PL - PR);
export const fOf = (px: number) => F0 * Math.pow(F1 / F0, Math.max(0, Math.min(1, (px - PL) / (W - PL - PR))));
export const y = (db: number) => PT + ((DB - Math.max(-DB, Math.min(DB, db))) / (2 * DB)) * (H - PT - PB);
export const dbOf = (py: number) => DB - ((py - PT) / (H - PT - PB)) * 2 * DB;
/** The curve's sample points, 240 log-spaced. */
export const FREQS = Array.from({ length: 240 }, (_, i) => F0 * Math.pow(F1 / F0, i / 239));

/** The X32 grid: vertical lines (and labels) at these frequencies; horizontal EQ lines every 5 dB. */
export const FREQ_GRID = [20, 40, 60, 80, 100, 200, 400, 600, 800, 1000, 2000, 4000, 6000, 8000, 10000, 20000];
export const DB_GRID = [15, 10, 5, 0, -5, -10, -15];
export const fmtGridF = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

/** The EQ curve's colour — the X32's yellow, contrasting with the blue → green → yellow → red bars. */
export const CURVE_COLOR = "var(--eq-curve)";

// ── The master GEQ's response, from the engine's own filters (native/src/eq.rs set_peaking: RBJ peaking, Q = 1,
//    f32 coefficients at 44.1 kHz; a band under 0.05 dB is the identity) ─────────────────────────────────────────
export const GEQ_FREQS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const f32 = Math.fround;
export function geqBiquad(f0: number, gainDb: number, fs = 44100, q = 1): [number, number, number, number, number] {
  if (Math.abs(gainDb) < 0.05) return [1, 0, 0, 0, 0];
  const a = f32(Math.pow(10, gainDb / 40));
  const w0 = f32((2 * Math.PI * f0) / fs);
  const cw = f32(Math.cos(w0));
  const alpha = f32(Math.sin(w0) / (2 * q));
  const a0 = f32(1 + alpha / a);
  return [f32(f32(1 + alpha * a) / a0), f32(f32(-2 * cw) / a0), f32(f32(1 - alpha * a) / a0), f32(f32(-2 * cw) / a0), f32(f32(1 - alpha / a) / a0)];
}
export function biquadDb([b0, b1, b2, a1, a2]: [number, number, number, number, number], f: number, fs = 44100): number {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = b1 * s1 + b2 * s2;
  const dr = 1 + a1 * c1 + a2 * c2, di = a1 * s1 + a2 * s2;
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
/** The GEQ's total response at f (dB): the ten bands in series, as the engine runs them. */
export function geqResponseDb(bands: number[], f: number): number {
  let d = 0;
  for (let i = 0; i < 10; i++) d += biquadDb(geqBiquad(GEQ_FREQS[i], bands[i] ?? 0), f);
  return d;
}
