// rta.ts — SLICE 8: the live RTA, the board side (docs/dsp-channel-rta.md §3).
//
// The engine publishes, pre-rack and post-rack (both pre-fader, dBFS with a full-scale sine = 0 dB — native/src/rta.rs),
// a 241-point FINE wave (24 per octave) and 31 ISO third-octave bands. The views draw the fine wave as the old master
// rack's level-coloured bars (RtaBars.tsx): this file holds the geometry (point frequencies, bar edges), the level
// colours, the running-peak range (autoTop — the old analyser's normaliser), peak hold, the coarse hatch and the GEQ's
// octave axis. Every drawing uses the CALLER'S own x, so a spectrum and its curve never disagree about a frequency.

export const RTA_BANDS = 31;
/** Nominal ISO centres (labels). Edges come from the exact base-2 series, exactly as the engine's bands. */
export const RTA_CENTRES = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250,
  1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
export const bandCentre = (b: number) => 1000 * Math.pow(2, (b - 17) / 3);
export const bandEdges = (b: number): [number, number] => { const c = bandCentre(b); return [c * Math.pow(2, -1 / 6), c * Math.pow(2, 1 / 6)]; };

/** The dBFS range drawn: 0 at the top, this at the bottom. */
export const RTA_RANGE_DB = 90;
export const RTA_FLOOR_DB = -120;

export interface RtaFrame {
  v: number; seq: number; target: string; fed: boolean;
  centres: number[]; coarseBelowHz: number; pre: number[]; post: number[];
  /** The fine wave the views draw: `fineN` points, fineLoHz × (fineHiHz/fineLoHz)^(k/(fineN−1)) — 24 per octave. */
  fineN: number; fineLoHz: number; fineHiHz: number; finePre: number[]; finePost: number[];
  pushed: number; dropped: number; stationUuid?: string;
}

// ── THE FINE BARS (Jeff's ruling 2026-09-26: bring back the old master rack's level-coloured bars, glow and peak-hold
//    markers — at the fine resolution, never one flat colour) ─────────────────────────────────────────────────────
export const FINE_N = 241;
/** Fine point k's frequency — the engine's formula (native/src/rta.rs fine_freq). */
export const fineFreq = (k: number, n = FINE_N, lo = 20, hi = 20000) => lo * Math.pow(hi / lo, k / (n - 1));
/** Each point's bar spans the geometric midpoints to its neighbours. */
export function fineEdges(k: number, n = FINE_N): [number, number] {
  const f = fineFreq(k, n);
  const lo = k > 0 ? Math.sqrt(fineFreq(k - 1, n) * f) : f / Math.pow(1000, 0.5 / (n - 1));
  const hi = k < n - 1 ? Math.sqrt(fineFreq(k + 1, n) * f) : f * Math.pow(1000, 0.5 / (n - 1));
  return [lo, hi];
}
/**
 * THE LEVEL COLOURS — the old MasterEQRack's (git 7089096~1). Its bars were 0…1 of a range normalised to a RUNNING PEAK
 * (the loudest recent bin), coloured cyan → green (> 0.5) → amber (> 0.75) → red (> 0.9). The fine bars do the same:
 * the view's top follows the running peak (autoTop), and the colour is set by HEIGHT within that range, so every bar is
 * green at its base and only the loudest reach yellow, amber and red. Stops as a fraction of the height (1 = top).
 */
export const LEVEL_STOPS: { at: number; color: string }[] = [
  { at: 1.0, color: "#ef4444" },   // red — the top
  { at: 0.9, color: "#ef4444" },
  { at: 0.8, color: "#f59e0b" },   // amber
  { at: 0.68, color: "#facc15" },  // yellow
  { at: 0.5, color: "#22c55e" },   // green
  { at: 0.0, color: "#15803d" },   // deep green at the floor
];
/** The fine bars' range under their top (the old rack's 60 dB). */
export const BARS_RANGE_DB = 60;
/**
 * The view's top, following the running peak like the old analyser's normaliser: instant up, releasing `releaseDbS`
 * dB/s, never below the current loudest point; the top sits `headDb` above it, in 3 dB steps so the scale does not
 * shimmer. Returns the new reference and the top (dBFS).
 */
export function autoTop(prevRef: number | null, loudest: number, dtS: number, releaseDbS = 2, headDb = 6): { ref: number; topDb: number } {
  const ref = prevRef == null || loudest > prevRef ? loudest : Math.max(loudest, prevRef - releaseDbS * Math.max(0, dtS));
  return { ref, topDb: Math.min(0, Math.ceil((ref + headDb) / 3) * 3) };
}
/** A level → a y, for a view whose top is `topDb` and whose range is BARS_RANGE_DB. */
export const barY = (db: number, topDb: number, top: number, bottom: number) =>
  top + Math.max(0, Math.min(1, (topDb - db) / BARS_RANGE_DB)) * (bottom - top);

/** A band level (dBFS) → a y between `top` (0 dBFS) and `bottom` (−RTA_RANGE_DB and below). */
export function dbfsY(db: number, top: number, bottom: number): number {
  const t = Math.max(0, Math.min(1, -db / RTA_RANGE_DB));
  return top + t * (bottom - top);
}

/** The coarse region (bands narrower than 3 FFT bins): [x from, x to] for the hatch, or null. */
export function coarseSpan(coarseBelowHz: number, x: (f: number) => number, fMin: number): [number, number] | null {
  if (!(coarseBelowHz > fMin)) return null;
  const b = RTA_CENTRES.findIndex(c => c >= coarseBelowHz - 0.5);
  const edge = b > 0 ? bandEdges(b)[0] : fMin;
  return [x(fMin), x(edge)];
}

/** PEAK HOLD — the old rack's white markers: each point's highest level, held `holdMs`, then it follows the display. */
export interface Hold { v: number[]; t: number[] }
export function holdStep(prev: Hold | null, cur: number[], now: number, holdMs = 2000): Hold {
  const n = cur.length;
  const v = new Array(n), t = new Array(n);
  for (let b = 0; b < n; b++) {
    const c = cur[b] ?? RTA_FLOOR_DB;
    if (!prev || c >= prev.v[b] || now - prev.t[b] > holdMs) { v[b] = c; t[b] = now; }
    else { v[b] = prev.v[b]; t[b] = prev.t[b]; }
  }
  return { v, t };
}

/** The master GEQ view's axis: its ten faders sit evenly at octave centres 31.25 Hz … 16 kHz, so a log axis with a
 *  half-octave margin each side puts every fader over its own frequency. `w` = the row's width. */
export const geqX = (w: number) => (f: number) => (w * (Math.log2(f / 31.25) + 0.5)) / 10;
export const GEQ_F_MIN = 31.25 / Math.SQRT2;
export const GEQ_F_MAX = 16000 * Math.SQRT2;
