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
