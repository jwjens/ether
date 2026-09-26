// src/hooks/useProcessorParams.ts
// THE PROCESSOR'S LIVE STATE — for BOTH branches: its meters and its OBSERVED bypass.
//
// SLICE 4 (docs/dsp-rack-framework.md). The processor's NUMBERS and PRESETS moved into the master rack: they
// are read and written ONLY through useMasterRack (rack:get / rack:set), so there is one writer. This hook
// used to write the proc_* keys and send the numbers itself; those writers are gone — a second path would
// have fought the rack (the daemon re-applies the stored rack every poll). What stays here is what is not a
// setting:
//   · the per-branch meters (the `procmeters` event),
//   · the LIVE-ONLY bypass test tool (Jeff's 2026-09-07 ruling: never persisted), sent on its own
//     bypass-only route so a bypass click can never carry stale numbers into the engine,
//   · the split flag, for the Master Out row's summary.
//
// THE HONESTY RULES THIS HOOK KEEPS:
//   · Bypass is not a UI flag. The rack sends it; the ENGINE echoes it back per branch on the meter frame;
//     every window renders the echo. Local intent is used only before the first frame arrives.
//   · Meters are per branch — with the split on the two branches ride and reduce differently.
import { useCallback, useEffect, useState } from "react";

export type Branch = "local" | "stream";

export type BranchMeters = {
  inLufs: number; outLufs: number; grDb: number; rideGainDb: number;
  inPeakDb: number; outPeakDb: number;
  rideBypass?: boolean; limiterBypass?: boolean;
  ceilingDbtp?: number;
} | null;

export function useProcessorParams(stationId: number | null) {
  const [split, setSplitState] = useState(false);
  const [meters, setMeters] = useState<Record<Branch, BranchMeters>>({ local: null, stream: null });
  const [intent, setIntent] = useState<Record<Branch, { ride: boolean; limiter: boolean }>>({
    local: { ride: false, limiter: false }, stream: { ride: false, limiter: false },
  });
  const [sendError, setSendError] = useState<string | null>(null);

  // The split flag, for the Master Out summary (the rack keeps proc_split written back).
  useEffect(() => {
    if (stationId == null) return;
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).ether?.stationConfigKv?.list(stationId);
        const v = ((r?.rows || []) as { key: string; value: string }[]).find(x => x.key === "proc_split")?.value;
        if (alive) setSplitState(v === "1" || v === "true");
      } catch { /* the linked default is what the engine runs with nothing stored */ }
    })();
    return () => { alive = false; };
  }, [stationId]);

  // ── meters (~15 Hz), per branch, with the observed bypass state ────────────
  useEffect(() => {
    if (stationId == null) return;
    const audio = (window as any).ether?.audio;
    if (!audio?.onProcMeters) return;
    let stale: any = null;
    const h = audio.onProcMeters((m: any) => {
      if (!m) return;
      const s = m.stream || {};
      setMeters({
        local: {
          inLufs: m.inLufs, outLufs: m.outLufs, grDb: m.grDb, rideGainDb: m.rideGainDb ?? 0,
          inPeakDb: m.inPeakDb, outPeakDb: m.outPeakDb,
          rideBypass: m.rideBypass, limiterBypass: m.limiterBypass, ceilingDbtp: m.ceilingDbtp,
        },
        // Absent on an older daemon (it does not reload on auto-update), which is why this is null
        // rather than a fabricated copy of the local numbers.
        stream: m.stream ? {
          inLufs: s.inLufs, outLufs: s.outLufs, grDb: s.grDb, rideGainDb: s.rideGainDb ?? 0,
          inPeakDb: s.inPeakDb, outPeakDb: s.outPeakDb,
          rideBypass: s.rideBypass, limiterBypass: s.limiterBypass, ceilingDbtp: s.ceilingDbtp,
        } : null,
      });
      if (stale) clearTimeout(stale);
      stale = setTimeout(() => setMeters({ local: null, stream: null }), 1000);
    });
    return () => { try { audio.offProcMeters?.(h); } catch {} if (stale) clearTimeout(stale); };
  }, [stationId]);

  const bypassOf = (b: Branch) => ({
    ride:    meters[b]?.rideBypass    ?? intent[b].ride,
    limiter: meters[b]?.limiterBypass ?? intent[b].limiter,
  });
  const bypass: Record<Branch, { ride: boolean; limiter: boolean }> = {
    local: bypassOf("local"), stream: bypassOf("stream"),
  };

  /** Bypass is per branch and per stage — a TEST TOOL, live only, never stored. Sent on the bypass-only route:
   *  it carries no numbers, so it cannot overwrite what the rack is running. */
  const setBypass = useCallback(async (branch: Branch, which: "ride" | "limiter", on: boolean) => {
    if (stationId == null) return;
    const cur = bypass[branch];
    const rb = which === "ride" ? on : cur.ride;
    const lb = which === "limiter" ? on : cur.limiter;
    setIntent(i => ({ ...i, [branch]: { ride: rb, limiter: lb } }));
    try {
      const r = await (window as any).ether?.audio?.setProcessorBypass?.(stationId, { branch: branch === "stream" ? 1 : 0, rideBypass: rb, limiterBypass: lb });
      if (r === false || (r && typeof r === "object" && r.ok === false)) setSendError((r && r.reason) || "the engine did not accept the bypass");
      else setSendError(null);
    } catch (e: any) { setSendError(String(e?.message || e)); }
  }, [stationId, bypass]);

  const pending = (b: Branch) =>
    intent[b].ride !== bypass[b].ride || intent[b].limiter !== bypass[b].limiter;

  return {
    split, meters, bypass, sendError, setBypass,
    bypassPending: pending("local") || pending("stream"),
    /** True when the running daemon predates the split and sends no stream branch at all. */
    streamBranchUnreported: meters.local != null && meters.stream == null,
  };
}
