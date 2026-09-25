// ── meterBallistics — THE ONE PLACE meter ballistics and meter constants live ───────────────────────
//
// Slice 2 (docs/dsp-meter-bus.md §2). The engine publishes RAW windows — sample peak and RMS since the
// previous read, LINEAR, 1.0 = 0 dBFS. Everything a meter does over time happens here, in the renderer:
// how fast a peak falls, how long a hold marker stays, how the average bar is integrated, how long OVER lights.
//
// Pure. No React, no DOM. Every step is driven by ELAPSED WALL TIME (dt), never by a per-frame factor, so a
// meter fed at 30 Hz and one fed at 1 Hz (the Health Monitor) arrive at the same value at the same moment.
// Pinned by src/components/meter/meterBallistics.test.ts.

/** Bottom of the meter scale, dBFS. Matches meterScale.ts dbToPercent's floor. */
export const METER_FLOOR_DB = -60;

/** PEAK RETURN: 20 dB in 1.7 s (≈ 11.8 dB/s), instant attack.
 *  Modelled on the IEC 60268-10 Type I peak programme meter return time.
 *  ⚠ UNVERIFIED AGAINST THE STANDARD TEXT — the value is from memory of the standard ("about 20 dB in
 *  ~1.5–1.7 s"). Named so it can be corrected in one place when someone checks. */
export const PEAK_FALL_DB_PER_S = 20 / 1.7;

/** PEAK HOLD: the hold marker stays at the highest peak this long, then falls at PEAK_FALL_DB_PER_S.
 *  Operator convention (Strata "peak dot riding over an average bar"), not a standard. */
export const PEAK_HOLD_MS = 2000;

/** AVERAGE BAR: plain RMS (a sine reads 3.01 dB under its peak — Jeff's ruling 2, the spec's "−18 RMS /
 *  −15 peak") smoothed by a one-pole on POWER with this time constant. VU-like integration.
 *  ⚠ UNVERIFIED AGAINST THE STANDARD TEXT — "≈ 300 ms" is from memory of IEC 60268-17 (VU). Not loudness:
 *  LUFS is metered separately. */
export const AVG_TAU_MS = 300;

/** OVER: lights when a window's sample peak reaches full scale, and stays lit this long. */
export const OVER_DB = 0;
export const OVER_HOLD_MS = 2000;

/** The alignment level marked on every meter (the spec's own test tone). */
export const ALIGN_DB = -18;

/** Zone boundaries for the bar colour: green below ALIGN_DB, amber to HOT_DB, red above. */
export const HOT_DB = -6;

/** A meter whose frames stop arriving for this long draws "not fed" rather than freezing on the last value. */
export const STALE_MS = 1000;

export function linToDb(x: number | null | undefined): number {
  const a = typeof x === "number" && Number.isFinite(x) ? Math.abs(x) : 0;
  if (a <= 0) return -Infinity;
  return 20 * Math.log10(a);
}

/** dB → 0..1 fraction of the meter height on the −60..0 scale. */
export function dbToFrac(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

export type Zone = "green" | "amber" | "red";
export function zoneOf(db: number): Zone {
  return db >= HOT_DB ? "red" : db >= ALIGN_DB ? "amber" : "green";
}

/** One meter channel's ballistic state. */
export interface MeterState {
  peakDb: number;     // the falling peak dot
  holdDb: number;     // the hold marker
  holdAt: number;     // wall ms the hold was last set
  avgPow: number;     // smoothed mean-square (linear power)
  overAt: number;     // wall ms OVER last lit (0 = never)
  at: number;         // wall ms of the last step
  avgAt: number;      // wall ms the average last integrated a window (its dt is window-to-window, not draw-to-draw)
}

export function initialMeter(now: number): MeterState {
  return { peakDb: -Infinity, holdDb: -Infinity, holdAt: 0, avgPow: 0, overAt: 0, at: now, avgAt: now };
}

/**
 * Advance one channel to `now`. `win` is a NEW engine window (sample peak + RMS, linear) or null when no new
 * window arrived since the last step — the ballistics still run on elapsed time either way.
 */
export function stepMeter(s: MeterState, win: { peak: number; rms: number } | null, now: number): MeterState {
  const dt = Math.max(0, now - s.at);
  const fall = PEAK_FALL_DB_PER_S * dt / 1000;
  let peakDb = s.peakDb - fall;
  let holdDb = s.holdDb, holdAt = s.holdAt;
  if (now - holdAt > PEAK_HOLD_MS) holdDb = holdDb - fall;
  let avgPow = s.avgPow, avgAt = s.avgAt;
  let overAt = s.overAt;
  if (win) {
    const inPk = linToDb(win.peak);
    if (inPk > peakDb) peakDb = inPk;                     // instant attack
    if (inPk >= holdDb) { holdDb = inPk; holdAt = now; }  // new hold
    if (inPk >= OVER_DB) overAt = now;
    // The window covers the time since the previous window, so the one-pole steps by THAT interval —
    // draws in between (no new data) neither decay nor advance it: no fresh data is not silence.
    const k = 1 - Math.exp(-Math.max(0, now - avgAt) / AVG_TAU_MS);
    avgPow = avgPow + (win.rms * win.rms - avgPow) * k;
    avgAt = now;
  }
  if (holdDb < peakDb) { holdDb = peakDb; }
  return { peakDb, holdDb, holdAt, avgPow, overAt, at: now, avgAt };
}

export function avgDbOf(s: MeterState): number { return s.avgPow > 0 ? 10 * Math.log10(s.avgPow) : -Infinity; }
export function overLit(s: MeterState, now: number): boolean { return s.overAt > 0 && now - s.overAt < OVER_HOLD_MS; }
