// Real dBFS VU mapping. The engine now reports a true linear peak (0..1, where 1.0 =
// 0 dBFS) — these turn it into a readable, dB-scaled meter with meaningful color zones,
// instead of the old random "theater" bouncing.

const DB_FLOOR = -48;   // bottom of the meter scale
const DB_AMBER = -12;   // ≥ this → amber (approaching hot)
const DB_RED   = -3;    // ≥ this → red (near clip)

/** Linear peak (0..1) → dBFS (clamped floor for silence). */
export function vuDb(level: number): number {
  return level > 0.0001 ? 20 * Math.log10(Math.min(1, level)) : -120;
}

/** Bar fill height 0..1, dB-scaled over [DB_FLOOR, 0] so normal levels read high
 *  and quiet detail is visible (a linear bar buries everything below -20 dB). */
export function vuHeight(level: number): number {
  const db = vuDb(level);
  return Math.max(0, Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
}

/** Color by real dBFS zone: green (safe) → amber (hot) → red (near clip). */
export function vuColor(level: number, baseColor: string): string {
  const db = vuDb(level);
  if (db >= DB_RED)   return "var(--accent-red)";
  if (db >= DB_AMBER) return "var(--accent-amber)";
  return baseColor;
}

// ── Rate-independent VU ballistics ────────────────────────────────────────────────────────────
// Meter motion is defined by time constants in MILLISECONDS and keyed on elapsed wall-clock time,
// decoupled from BOTH the draw rate (~60fps RAF) and the level-feed rate (the daemon pushes ~10 Hz;
// it used to be ~30 Hz). A meter that smooths through these helpers glides identically whether the
// feed is 10 Hz, 30 Hz, or irregular — the bug we hit when the Item-10 migration cut the feed rate
// and the old per-frame-count factors suddenly meant a different feel.
//
// TUNING: these four constants are the SINGLE edit point for the meter feel — change them here and
// every meter follows. Starting values approximate the previous 60fps-tuned feel (the old per-frame
// lerps: attack k≈0.75 → ~12 ms, decay k≈0.06 → ~270 ms). Jeff tunes these visually on the build.
export const VU_ATTACK_TAU_MS     = 12;    // rise toward a louder level — smaller = snappier
export const VU_DECAY_TAU_MS      = 270;   // fall toward a quieter level — larger = slower / smoother
export const VU_PEAK_HOLD_MS      = 1400;  // peak marker holds this long before it begins to fall
export const VU_PEAK_FALL_PER_SEC = 0.72;  // peak marker fall speed after the hold (level units / second)

/** One exponential-smoothing step toward `target`, keyed on elapsed wall-clock ms (`dtMs`) since the
 *  last draw — NOT a fixed per-frame factor. Separate attack/decay taus give the classic VU ballistic
 *  (fast rise, slow fall). factor = 1 - exp(-dt/tau), so the feel is rate-independent. */
export function vuSmooth(current: number, target: number, dtMs: number): number {
  const tau = target > current ? VU_ATTACK_TAU_MS : VU_DECAY_TAU_MS;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
  return current + (target - current) * k;
}

/** Peak-hold marker update, rate-independent. Latches a new peak instantly, holds VU_PEAK_HOLD_MS,
 *  then falls at VU_PEAK_FALL_PER_SEC scaled by `dtMs` (same fall speed at any draw rate). Returns the
 *  new { peak, at } pair. */
export function vuPeak(peak: number, peakAtMs: number, level: number, nowMs: number, dtMs: number): { peak: number; at: number } {
  if (level > peak) return { peak: level, at: nowMs };
  if (nowMs - peakAtMs > VU_PEAK_HOLD_MS) return { peak: Math.max(0, peak - VU_PEAK_FALL_PER_SEC * Math.max(0, dtMs) / 1000), at: peakAtMs };
  return { peak, at: peakAtMs };
}
