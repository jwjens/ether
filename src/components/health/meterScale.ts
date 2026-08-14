// ── meterScale — the arithmetic behind the meters ───────────────────────────────────────────────
//
// Pure. No React, no DOM. A meter that maps its scale wrongly is confidently wrong rather than
// broken, so the mapping is testable on its own.
//
// TWO DIFFERENT MEASUREMENTS, TWO DIFFERENT SCALES, and conflating them is the main hazard here.
// Verified against the real emitters on 2026-08-13:
//
//   audio:levels        { a, b, c, master, stationUuid }   LINEAR amplitude 0..1, ~90 frames/sec
//   audio:proc-meters   { inLufs, outLufs, target, rideGainDb, grDb, inPeakDb, outPeakDb }
//                                                          LUFS + dBFS, ~15 Hz, ONLY while a
//                                                          processing toggle is on
//
// The design brief asked for "Deck A/B/C … −14.2 LUFS". THAT DATA DOES NOT EXIST: per-deck levels
// are linear amplitude and carry no loudness measurement, while LUFS is program-bus only and has no
// per-deck breakdown. Decks are therefore metered in dBFS, and loudness is metered separately.

/** Linear amplitude (0..1) → dBFS. Silence floors at -70, matching the daemon's own dbfs(). */
export function ampToDbfs(amp: number | null | undefined): number {
  const a = typeof amp === "number" && Number.isFinite(amp) ? amp : 0;
  if (a <= 0) return -70;
  return Math.max(-70, 20 * Math.log10(a));
}

/**
 * dB → bar fill percentage, on a dB scale rather than a linear one.
 *
 * Filling linearly from amplitude is the classic meter mistake: hearing is logarithmic, so anything
 * above ~0.5 amplitude sits in the top half and everything quiet is invisible. -60 dB is the floor.
 */
export function dbToPercent(db: number | null | undefined, floorDb = -60): number {
  if (typeof db !== "number" || !Number.isFinite(db)) return 0;
  if (db <= floorDb) return 0;
  if (db >= 0) return 100;
  return Math.round(((db - floorDb) / (0 - floorDb)) * 1000) / 10;
}

export type MeterLevel = "quiet" | "good" | "hot" | "clip";

/**
 * PEAK colour — monotonic, and here that is CORRECT. This scale answers "am I about to clip?", and
 * on that question louder genuinely is worse: 0 dBFS is the ceiling.
 *
 * (The same ramp applied to LOUDNESS would be wrong — see loudnessLevel. Too quiet is also a fault
 * when you are aiming at a target, and a monotonic ramp trains an operator to push level until they
 * see amber.)
 */
export function peakLevel(db: number | null | undefined): MeterLevel {
  if (typeof db !== "number" || !Number.isFinite(db)) return "quiet";
  if (db >= -1) return "clip";      // -1 dBTP is the delivery ceiling the limiter holds
  if (db >= -6) return "hot";
  if (db <= -50) return "quiet";
  return "good";
}

/**
 * LOUDNESS colour — a BAND around the target, not a ramp.
 *
 * Broadcast loudness is a target to sit on (-14 LUFS here, streaming practice; EBU R128 is -23), so
 * being 6 LU under is as much a fault as being 6 LU over. Distance from target is what matters.
 */
export function loudnessLevel(lufs: number | null | undefined, target: number): MeterLevel {
  if (typeof lufs !== "number" || !Number.isFinite(lufs) || lufs <= -69) return "quiet";
  const delta = Math.abs(lufs - target);
  if (delta <= 1) return "good";     // within 1 LU — on target
  if (delta <= 3) return "hot";      // drifting
  return "clip";                     // well off target, either direction
}

export const METER_COLOR: Record<MeterLevel, string> = {
  quiet: "var(--text-tertiary)",
  good:  "var(--accent-green)",
  hot:   "var(--accent-amber)",
  clip:  "var(--accent-red)",
};

/** A short word beside the bar, so status is not carried by colour alone (red/green deficiency is
 *  the common one, and these are the same two colours the whole panel leans on). */
export const METER_WORD: Record<MeterLevel, string> = {
  quiet: "quiet", good: "ok", hot: "hot", clip: "over",
};

/**
 * Peak-hold: the marker rides the peak, holds, then falls.
 *
 * Without a defined hold and fall the marker either sticks forever (useless) or tracks the bar
 * (pointless). 1200 ms hold then 20 dB/s is conventional PPM behaviour.
 */
export interface PeakHoldState { db: number; heldSince: number; }

export function peakHold(prev: PeakHoldState | null, db: number, now: number,
                        holdMs = 1200, fallDbPerSec = 20): PeakHoldState {
  if (!prev || db >= prev.db) return { db, heldSince: now };
  const held = now - prev.heldSince;
  if (held < holdMs) return prev;
  const fallen = prev.db - (fallDbPerSec * (held - holdMs)) / 1000;
  return fallen <= db ? { db, heldSince: now } : { db: fallen, heldSince: prev.heldSince };
}

/** "-14.2" — one decimal, and an em dash rather than "-Infinity" or "NaN" for no signal. */
export function fmtDb(db: number | null | undefined, floor = -69): string {
  if (typeof db !== "number" || !Number.isFinite(db) || db <= floor) return "—";
  return db.toFixed(1);
}
