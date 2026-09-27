// rta.ts — SLICE 8: the live RTA, the board side (docs/dsp-channel-rta.md §3).
//
// The engine publishes 31 ISO third-octave bands, pre-rack and post-rack, both pre-fader, in dBFS with a full-scale
// sine = 0 dB (native/src/rta.rs). This file turns a frame into what the rack views draw BEHIND their curves:
// a step outline across each band's exact edges, closed down to the floor, on the SAME frequency→x function the
// view already uses (the caller passes its own `x`, so the spectrum and the curve can never disagree about where a
// frequency is). Peak hold is the view's (ruling 3: off by default, a toggle) and lives here too.

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
  pushed: number; dropped: number; stationUuid?: string;
}

/** A band level (dBFS) → a y between `top` (0 dBFS) and `bottom` (−RTA_RANGE_DB and below). */
export function dbfsY(db: number, top: number, bottom: number): number {
  const t = Math.max(0, Math.min(1, -db / RTA_RANGE_DB));
  return top + t * (bottom - top);
}

/**
 * The filled spectrum as an SVG path: for each band a flat step from its lower to its upper edge at its level, closed
 * down to `bottom`. Bands wholly outside [fMin, fMax] are skipped; the edge bands are clipped to it.
 */
export function rtaPath(levels: number[], x: (f: number) => number, top: number, bottom: number, fMin: number, fMax: number): string {
  const pts: string[] = [];
  let first = true, lastX = 0;
  for (let b = 0; b < RTA_BANDS; b++) {
    let [lo, hi] = bandEdges(b);
    if (hi <= fMin || lo >= fMax) continue;
    lo = Math.max(lo, fMin); hi = Math.min(hi, fMax);
    const yy = dbfsY(levels[b] ?? RTA_FLOOR_DB, top, bottom).toFixed(1);
    const x0 = x(lo).toFixed(1), x1 = x(hi).toFixed(1);
    if (first) { pts.push(`M${x0},${bottom.toFixed(1)}`); first = false; }
    pts.push(`L${x0},${yy}`, `L${x1},${yy}`);
    lastX = x(hi);
  }
  if (first) return "";
  pts.push(`L${lastX.toFixed(1)},${bottom.toFixed(1)}Z`);
  return pts.join("");
}

/** The coarse region (bands narrower than 3 FFT bins): [x from, x to] for the hatch, or null. */
export function coarseSpan(coarseBelowHz: number, x: (f: number) => number, fMin: number): [number, number] | null {
  if (!(coarseBelowHz > fMin)) return null;
  const b = RTA_CENTRES.findIndex(c => c >= coarseBelowHz - 0.5);
  const edge = b > 0 ? bandEdges(b)[0] : fMin;
  return [x(fMin), x(edge)];
}

/** PEAK HOLD (ruling 3): each band's highest level, held `holdMs`, then it follows the display down. */
export interface Hold { v: number[]; t: number[] }
export function holdStep(prev: Hold | null, cur: number[], now: number, holdMs = 2000): Hold {
  const v = new Array(RTA_BANDS), t = new Array(RTA_BANDS);
  for (let b = 0; b < RTA_BANDS; b++) {
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
