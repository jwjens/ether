// ── dynMath — the channel dynamics' static curves and ranges, the TS port of the engine's (Slice 6) ──────────────
//
// docs/dsp-channel-dynamics.md §2. The transfer graph is drawn from these; they are line-for-line ports of
// native/src/rack.rs comp_gr_db / gate_gr_db, pinned to the engine through dynCurve.fixture.json (which
// rack::ts_dyn_parity pins to Rust) at 1e-9 (dynMath.test.ts). The ranges are the engine's clamps (rack.rs).
import type { GateModule, CompModule } from "./rackTypes";

export const COMP = {
  threshold: [-40, 10], ratio: [1, 20], attack: [0.1, 330], release: [50, 3000], makeup: [0, 24], knee: [0, 12],
} as const;
export const GATE = {
  threshold: [-80, 0], ratio: [1, 5], depth: [0, 40], attack: [0.1, 50], hold: [0, 500], release: [50, 3000], hysteresis: [0, 10],
} as const;
/** The spec's depth guidance: 14 dB is enough, 20 dB tops (drawn on the graph). */
export const GATE_DEPTH_GUIDE = [14, 20] as const;

/** The compressor's gain reduction (dB, ≥ 0) at input level `x` — Giannoulis–Massberg–Reiss soft knee. */
export function compGrDb(x: number, t: number, r: number, w: number): number {
  const d = x - t;
  const y = (w > 0 && 2 * Math.abs(d) <= w) ? x + (1 / r - 1) * (d + w / 2) ** 2 / (2 * w)
          : (2 * d > w) ? t + d / r
          : x;
  return x - y;
}
/** The expander's gain reduction below threshold: (t − x)(r − 1) dB, capped at depth. */
export function gateGrDb(x: number, t: number, r: number, depth: number): number {
  return x >= t ? 0 : Math.min((t - x) * (r - 1), depth);
}

const f32 = Math.fround;
const fin = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const c = (v: unknown, d: number, r: readonly [number, number]) => f32(Math.max(f32(r[0]), Math.min(f32(r[1]), f32(fin(v, d)))));
/** The engine's clamps (rack.rs clamp_channel_module), in f32 as the engine stores them. */
export function clampGate(g: GateModule): GateModule {
  return { type: "gate", threshold: c(g.threshold, -45, GATE.threshold), ratio: c(g.ratio, 4, GATE.ratio), depth: c(g.depth, 15, GATE.depth),
           attack: c(g.attack, 1, GATE.attack), hold: c(g.hold, 100, GATE.hold), release: c(g.release, 150, GATE.release),
           hysteresis: c(g.hysteresis, 3, GATE.hysteresis) };
}
export function clampComp(p: CompModule): CompModule {
  return { type: "comp", threshold: c(p.threshold, -20, COMP.threshold), ratio: c(p.ratio, 3, COMP.ratio), attack: c(p.attack, 10, COMP.attack),
           release: c(p.release, 150, COMP.release), makeup: c(p.makeup, 0, COMP.makeup), knee: c(p.knee, 6, COMP.knee) };
}

/** The whole chain's static curve (gate, then — through a flat EQ — the compressor, then makeup): output dB at
 *  input `x`. Either may be absent or OUT. What the transfer graph's orange line draws. */
export function chainOutDb(x: number, gate: GateModule | null, comp: CompModule | null): number {
  let y = x;
  if (gate) y -= gateGrDb(y, gate.threshold, gate.ratio, gate.depth);
  if (comp) y = y - compGrDb(y, comp.threshold, comp.ratio, comp.knee) + comp.makeup;
  return y;
}
