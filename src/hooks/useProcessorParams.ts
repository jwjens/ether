// src/hooks/useProcessorParams.ts
// THE ONE SOURCE for the program processor — now for BOTH branches.
//
// THE SPLIT (2026-09-07). The monitor and the stream are two different problems: one is a room with
// speakers in it, the other is an encoder feeding strangers' phones. They used to be literally the same
// samples — one processor instance, one buffer, two taps. Now each branch has its own instance, its own
// ride state, its own limiter state, its own parameters and its own meters.
//
// LINKED IS THE DEFAULT, AND IT IS BIT-IDENTICAL. While `proc_split` is off, the daemon hands the stream
// branch exactly the local numbers, and two instances with identical parameters produce identical output
// (asserted on the sample bits by C7). A station that never opens this panel hears what it always heard.
//
// THE HONESTY RULES THIS HOOK KEEPS:
//   · Bypass is not a UI flag. The rack sends it; the ENGINE echoes it back per branch on the meter
//     frame; every window renders the echo. Local intent is used only before the first frame arrives.
//   · Meters are per branch. One set of numbers for two processors would be a meter that lies — with the
//     split on they ride to different targets and reduce by different amounts at the same instant.
//   · An unstored value renders as the shipped value, greyed. Never a blank, never a component default
//     pretending to be a setting.
import { useCallback, useEffect, useState } from "react";
import { SHIPPED, ETHER_V1, paramsEqual, type ProcParams, type Preset } from "../components/ProcessorRack";

export type Branch = "local" | "stream";

export type BranchMeters = {
  inLufs: number; outLufs: number; grDb: number; rideGainDb: number;
  inPeakDb: number; outPeakDb: number;
  rideBypass?: boolean; limiterBypass?: boolean;
  ceilingDbtp?: number;
} | null;

/** The KV keys per branch. Bypass is deliberately absent from both — it is never written anywhere. */
const KEYS: Record<Branch, Record<keyof ProcParams, string>> = {
  local: {
    targetLufs:  "proc_target_lufs",
    ceilingDbtp: "proc_ceiling_dbtp",
    releaseMs:   "proc_release_ms",
    rideRate:    "proc_ride_rate",
    rideClamp:   "proc_ride_clamp",
  },
  stream: {
    targetLufs:  "proc_stream_target_lufs",
    ceilingDbtp: "proc_stream_ceiling_dbtp",
    releaseMs:   "proc_stream_release_ms",
    rideRate:    "proc_stream_ride_rate",
    rideClamp:   "proc_stream_ride_clamp",
  },
};
const SPLIT_KEY = "proc_split";

type Stored = Partial<Record<keyof ProcParams, boolean>>;
const PKEYS = ["targetLufs", "ceilingDbtp", "releaseMs", "rideRate", "rideClamp"] as const;

export function useProcessorParams(stationId: number | null) {
  const [split, setSplitState] = useState(false);
  const [params, setParams] = useState<Record<Branch, ProcParams>>({ local: { ...SHIPPED }, stream: { ...SHIPPED } });
  const [stored, setStored] = useState<Record<Branch, Stored>>({ local: {}, stream: {} });
  const [presets, setPresets]     = useState<Preset[]>([ETHER_V1]);
  const [activePreset, setActive] = useState<string | null>(ETHER_V1.name);
  const [meters, setMeters] = useState<Record<Branch, BranchMeters>>({ local: null, stream: null });
  const [intent, setIntent] = useState<Record<Branch, { ride: boolean; limiter: boolean }>>({
    local: { ride: false, limiter: false }, stream: { ride: false, limiter: false },
  });
  const [sendError, setSendError] = useState<string | null>(null);

  // ── the numbers, the split flag and the presets, from station_config_kv ────
  useEffect(() => {
    if (stationId == null) return;          // never load against a guessed station
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).ether?.stationConfigKv?.list(stationId);
        const rows = ((r?.rows || []) as { key: string; value: string }[]);
        const get = (k: string) => rows.find(x => x.key === k)?.value;

        const nextP: Record<Branch, ProcParams> = { local: { ...SHIPPED }, stream: { ...SHIPPED } };
        const nextS: Record<Branch, Stored> = { local: {}, stream: {} };
        (["local", "stream"] as Branch[]).forEach(b => {
          PKEYS.forEach(k => {
            const v = parseFloat(get(KEYS[b][k]) ?? "");
            if (!isNaN(v)) { nextP[b][k] = v; nextS[b][k] = true; }
          });
        });
        const sp = get(SPLIT_KEY) === "1" || get(SPLIT_KEY) === "true";
        // LINKED: the stream branch shows the monitor's values, because that is what the engine is
        // running. Showing separately-stored stream numbers while the daemon mirrors the local ones
        // would be a panel claiming a chain that is not on air.
        if (!sp) { nextP.stream = { ...nextP.local }; nextS.stream = { ...nextS.local }; }

        let ps: Preset[] = [ETHER_V1];
        try {
          const raw = get("proc_presets");
          if (raw) ps = [ETHER_V1, ...(JSON.parse(raw) as Preset[]).filter(x => x && x.name && !x.builtIn)];
        } catch { /* a malformed preset blob must not cost the panel */ }

        if (!alive) return;
        setSplitState(sp); setParams(nextP); setStored(nextS); setPresets(ps);
        setActive(get("proc_preset_active") || (ps.find(x => paramsEqual(x.params, nextP.local))?.name ?? ETHER_V1.name));
      } catch { /* leave the shipped chain showing — it IS what the engine is running */ }
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

  /** Deliver one branch to the engine, and say whether it landed. */
  const send = useCallback(async (branch: Branch, prm: ProcParams, rb: boolean, lb: boolean) => {
    if (stationId == null) return;
    try {
      const r = await (window as any).ether?.audio?.setProcessorParams?.(stationId, {
        branch: branch === "stream" ? 1 : 0,
        targetLufs: prm.targetLufs, ceilingDbtp: prm.ceilingDbtp, releaseMs: prm.releaseMs,
        rideRate: prm.rideRate, rideClamp: prm.rideClamp,
        rideBypass: rb, limiterBypass: lb,
      });
      if (r && typeof r === "object" && (r.numbers === false || r.bypass === false)) {
        setSendError(r.reason || "the engine did not accept that");
      } else setSendError(null);
    } catch (e: any) { setSendError(String(e?.message || e)); }
  }, [stationId]);

  /** Edit one branch. While LINKED, an edit is written to the monitor keys and applied to both — the
   *  daemon mirrors, so writing stream keys as well would leave a second copy nobody reads. */
  const patch = useCallback((branch: Branch, p: Partial<ProcParams>) => {
    if (stationId == null) return;
    setParams(prev => {
      const target: Branch = split ? branch : "local";
      const nextBranch = { ...prev[target], ...p };
      const next = split
        ? { ...prev, [target]: nextBranch }
        : { local: nextBranch, stream: { ...nextBranch } };
      const kv = (window as any).ether?.stationConfigKv;
      (Object.keys(p) as (keyof ProcParams)[]).forEach(k => {
        try { kv?.upsertByKey(stationId, KEYS[target][k], String(nextBranch[k])); } catch {}
      });
      setStored(st => {
        const marked = { ...st[target] };
        (Object.keys(p) as (keyof ProcParams)[]).forEach(k => { marked[k] = true; });
        return split ? { ...st, [target]: marked } : { local: marked, stream: { ...marked } };
      });
      send(target, nextBranch, bypass[target].ride, bypass[target].limiter);
      if (!split) send("stream", nextBranch, bypass.stream.ride, bypass.stream.limiter);
      return next as Record<Branch, ProcParams>;
    });
  }, [stationId, send, split, bypass.local.ride, bypass.local.limiter, bypass.stream.ride, bypass.stream.limiter]);

  /** Split or re-link the two branches. Re-linking hands the monitor's numbers back to the stream. */
  const setSplit = useCallback((on: boolean) => {
    if (stationId == null) return;
    setSplitState(on);
    try { (window as any).ether?.stationConfigKv?.upsertByKey(stationId, SPLIT_KEY, on ? "1" : "0"); } catch {}
    if (on) {
      // Seed the stream branch from what it is ALREADY running, so splitting changes nothing by itself.
      const seed = params.local;
      const kv = (window as any).ether?.stationConfigKv;
      PKEYS.forEach(k => { try { kv?.upsertByKey(stationId, KEYS.stream[k], String(seed[k])); } catch {} });
      setParams(p => ({ ...p, stream: { ...seed } }));
      setStored(s => ({ ...s, stream: { ...s.local } }));
      send("stream", seed, bypass.stream.ride, bypass.stream.limiter);
    } else {
      setParams(p => ({ ...p, stream: { ...p.local } }));
      setStored(s => ({ ...s, stream: { ...s.local } }));
      send("stream", params.local, bypass.stream.ride, bypass.stream.limiter);
    }
  }, [stationId, params.local, send, bypass.stream.ride, bypass.stream.limiter]);

  const selectPreset = useCallback((branch: Branch, name: string) => {
    const pre = presets.find(x => x.name === name); if (!pre || stationId == null) return;
    setActive(name);
    try { (window as any).ether?.stationConfigKv?.upsertByKey(stationId, "proc_preset_active", name); } catch {}
    patch(branch, pre.params);
  }, [presets, stationId, patch]);

  const savePreset = useCallback((branch: Branch, name: string) => {
    if (stationId == null) return;
    const rest = [...presets.filter(x => x.name !== name && !x.builtIn), { name, params: { ...params[branch] } }];
    setPresets([ETHER_V1, ...rest]); setActive(name);
    try {
      const kv = (window as any).ether?.stationConfigKv;
      kv?.upsertByKey(stationId, "proc_presets", JSON.stringify(rest));
      kv?.upsertByKey(stationId, "proc_preset_active", name);
    } catch {}
  }, [presets, params, stationId]);

  /** Bypass is per branch and per stage — you can hear the monitor unprocessed while the stream stays
   *  protected, which is the point of having two of them. Session only, never stored. */
  const setBypass = useCallback((branch: Branch, which: "ride" | "limiter", on: boolean) => {
    const cur = bypass[branch];
    const rb = which === "ride" ? on : cur.ride;
    const lb = which === "limiter" ? on : cur.limiter;
    setIntent(i => ({ ...i, [branch]: { ride: rb, limiter: lb } }));
    send(branch, params[branch], rb, lb);
  }, [bypass, params, send]);

  // The projection: what each branch's ride WOULD apply, from its own observed input and its own target
  // and clamp. Greyed and labelled in the panel — never in the place the applied gain goes.
  const wouldRide = (b: Branch) => meters[b]
    ? Math.max(-params[b].rideClamp, Math.min(params[b].rideClamp, params[b].targetLufs - meters[b]!.inLufs))
    : null;

  const pending = (b: Branch) =>
    intent[b].ride !== bypass[b].ride || intent[b].limiter !== bypass[b].limiter;

  return {
    split, setSplit, params, stored, presets, activePreset, meters, bypass, sendError,
    wouldRideDb: { local: wouldRide("local"), stream: wouldRide("stream") },
    bypassPending: pending("local") || pending("stream"),
    /** True when the running daemon predates the split and sends no stream branch at all. */
    streamBranchUnreported: meters.local != null && meters.stream == null,
    patch, selectPreset, savePreset, setBypass,
  };
}
