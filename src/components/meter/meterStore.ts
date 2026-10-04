// ── meterStore — the meter-bus frames, held OUTSIDE React ────────────────────────────────────────────
//
// Slice 2 (docs/dsp-meter-bus.md §1.4, §3). The daemon sends a ~30 Hz raw window per SUBSCRIBED station:
//   { v, e, n, ch: [[pkL, pkR, rmsL, rmsR] × 12], bus: [[…] × 6], live, stationUuid }
// One IPC listener per window keeps the newest frame per station here; meters read it from their own
// requestAnimationFrame loop. Nothing re-renders React at meter rate (the lesson in MasterOutput.tsx's
// LimiterGR note: a meter-rate subscription at a panel root repainted the whole tree).
import { useEffect } from "react";
import type { LoudBranch, GrBranch, CeilBranch, LoudBranchName } from "./loudnessWire";

export interface MeterFrameMsg {
  v: number; e: number; n: number;
  ch: number[][]; bus: number[][]; live: number;
  stationUuid?: string | null;
  /** SLICE 3 — per-branch loudness (the engine's meter thread), ride/limiter per window, the ceiling as set
   *  and as it acts, the limiter's detection margin (dB) and the loudness frame's sequence. Absent from an
   *  engine that predates slice 3. docs/dsp-loudness-meter.md §4.1. */
  ld?: Record<LoudBranchName, LoudBranch>;
  gr?: Record<LoudBranchName, GrBranch>;
  ceil?: Record<LoudBranchName, CeilBranch>;
  margin?: number;
  ldSeq?: number;
  /** SLICE 5 — each channel AFTER its rack (equal to `ch` when a rack runs nothing); `ch` stays pre-rack.
   *  Absent from an engine that predates slice 5. docs/dsp-channel-rack-eq.md §2. */
  chPost?: number[][];
  /** SLICE 6 — each channel's dynamics this window: [gate GR dB, comp GR dB, fraction of the window the gate was open]. */
  chDyn?: number[][];
  /** PFL — the engine's echo: bit n set = slot n's PFL is on in the block the callback ran; and the dim (dB). */
  pfl?: number;
  pflDimDb?: number;
  /** PFL OUTPUT DEVICE — same_as_main | opening | open | not_found | failed. */
  cueState?: string;
  /** AUX OUTPUT (2026-10-04) — none | opening | open | not_found | failed; the device chosen ("" = none); and bit n
   *  set = slot n reaches the room only through the aux. Absent from an engine that predates them. See auxFault.ts. */
  auxState?: string;
  auxDevice?: string;
  auxRouted?: number;
}
export interface HeldFrame extends MeterFrameMsg { at: number }

/** Channel tap indices (the engine's slot order). */
export const CH_INDEX: Record<string, number> = {
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, CART: 6, S1: 7, S2: 8, S3: 9, S4: 10, S5: 11,
};
/** Bus tap indices (rt.rs BUS_*). */
export const BUS = { PGM: 0, LOCAL: 1, STREAM: 2, MONITOR: 3, ROOM: 4, AUX: 5 } as const;
export type BusName = keyof typeof BUS;

const frames = new Map<string, HeldFrame>();
let installed = false;

function install() {
  if (installed) return;
  const audio = (window as any).ether?.audio;
  if (!audio?.onMeters) return;
  installed = true;
  audio.onMeters((f: MeterFrameMsg) => {
    if (!f || !f.stationUuid) return;
    frames.set(f.stationUuid, { ...f, at: performance.now() });
  });
}

/** The newest meter frame for a station, or null if none has arrived. */
export function latestMeters(stationUuid: string | null | undefined): HeldFrame | null {
  install();
  if (!stationUuid) return null;
  return frames.get(stationUuid) ?? null;
}

/** Ask the engine for these stations' meters while the calling component is mounted. The daemon lets a
 *  subscription lapse after 5 s, so it is renewed every 2 s; unmounting simply stops renewing. */
export function useMeterSubscription(stationIds: (number | null | undefined)[]) {
  const key = stationIds.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b).join(",");
  useEffect(() => {
    install();
    const ids = key ? key.split(",").map(Number) : [];
    const audio = (window as any).ether?.audio;
    if (!ids.length || !audio?.subscribeMeters) return;
    const renew = () => { try { audio.subscribeMeters(ids); } catch { /* engine not up yet */ } };
    renew();
    const t = setInterval(renew, 2000);
    return () => clearInterval(t);
  }, [key]);
}
