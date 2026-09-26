// ── loudnessWire — the slice 3 meter-bus keys, and the arithmetic the loudness panel draws with ──────────
//
// docs/dsp-loudness-meter.md §4. The engine's meter thread measures each branch's OUTPUT (BS.1770: momentary,
// short-term, gated integrated, LRA, true peak) and the callback reports ride and limiter per branch; both ride
// the slice 2 `audio:meters` frame as `ld`, `gr`, `ceil`, `margin`, `ldSeq`.
//
// Pure. No React, no DOM. The key lists below are checked against the engine's json! by
// audiod/smoke-meter-contract.js RULE 8, so a key the panel reads can never be one the engine stopped sending.

export type LoudBranchName = "local" | "stream" | "aux";

/** One branch's loudness. LUFS / LU / dBTP; null = no reading (below the gate, not yet measured, not fed). */
export interface LoudBranch {
  m: number | null; s: number | null; i: number | null; lra: number | null;
  tp: [number | null, number | null]; tpMax: number | null;
  fed: boolean; full: boolean; since: number; epoch: number;
  dropSec: number; measuredSec: number; capped: boolean;
}
/** One branch's dynamics over the read window. `ride` is signed (a boost is +); `lim` is the window's
 *  deepest limiter gain reduction (≥ 0); `run` = the processor ran; `src` = which one fed the branch. */
export interface GrBranch { ride: number; lim: number; run: boolean; src: "clean" | "own" | "room" }
/** The ceiling as the operator set it and as the limiter acts on it (set − detection margin). */
export interface CeilBranch { set: number; eff: number }

export const LOUD_KEYS: (keyof LoudBranch)[] = ["m", "s", "i", "lra", "tp", "tpMax", "fed", "full", "since", "epoch", "dropSec", "measuredSec", "capped"];
export const GR_KEYS: (keyof GrBranch)[] = ["ride", "lim", "run", "src"];
export const CEIL_KEYS: (keyof CeilBranch)[] = ["set", "eff"];

/** Loudness bar scales (Tech 3341 §2.7 ranges): "+9" spans −18…+9 LU, "+18" spans −36…+18 LU. Jeff's ruling 5:
 *  centred on EACH BRANCH'S OWN TARGET and labelled with it — EBU Mode fixes 0 LU at −23 LUFS, which would put
 *  a −14 target on the top edge of the +9 scale. */
export type LoudScale = 9 | 18;
export function scaleRange(target: number, scale: LoudScale): { lo: number; hi: number } {
  return scale === 9 ? { lo: target - 18, hi: target + 9 } : { lo: target - 36, hi: target + 18 };
}
/** LUFS → 0..1 along the scale (0 for no reading). */
export function loudFrac(lufs: number | null | undefined, target: number, scale: LoudScale): number {
  if (typeof lufs !== "number" || !Number.isFinite(lufs)) return 0;
  const { lo, hi } = scaleRange(target, scale);
  return Math.max(0, Math.min(1, (lufs - lo) / (hi - lo)));
}
/** Where the target line sits on the scale. */
export function targetFrac(scale: LoudScale): number { return scale === 9 ? 18 / 27 : 36 / 54; }

const MINUS = "−";
const signed = (v: number, d = 1) => (v < 0 ? MINUS : "") + Math.abs(v).toFixed(d);

/** "−23.0" — one decimal, a true minus, and "—" for no reading. */
export function fmtLufs(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? signed(v) : "—";
}
/** "5.2" for LRA / dB readings, "—" for none. */
export function fmtLu(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) : "—";
}

/** Jeff's ruling 3 — the label says what the limiter does: "−1.0 dBTP set · limits at −2.2 dBTP". */
export function ceilingLabel(set: number, eff: number): string {
  return `${signed(set)} dBTP set · limits at ${signed(eff)} dBTP`;
}

/** "since 14:02:11" — or, once the 24 h history cap is reached (ruling 1), "24 h window". */
export function sinceLabel(sinceMs: number, capped: boolean): string {
  if (capped) return "24 h window";
  if (!sinceMs) return "";
  const d = new Date(sinceMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `since ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Audio the meter never saw (its ring was full). Never silent: the integrated value is incomplete. */
export function incompleteLabel(dropSec: number): string | null {
  return dropSec > 0 ? `incomplete: ${dropSec.toFixed(1)} s not measured` : null;
}

/** RIDE is a signed corrective gain drawn around 0 across ±clamp: 0..1 with 0.5 = no correction. */
export function rideFrac(rideDb: number, clampDb: number): number {
  const c = Math.max(1, clampDb);
  return Math.max(0, Math.min(1, 0.5 + rideDb / (2 * c)));
}
/** LIMITER gain reduction drawn 0 … LIM_FULL_DB down. */
export const LIM_FULL_DB = 12;
export function limFrac(grDb: number): number { return Math.max(0, Math.min(1, grDb / LIM_FULL_DB)); }
