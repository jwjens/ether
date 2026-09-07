// src/hooks/useProcessorParams.ts
// THE ONE SOURCE for the program processor's controls, presets, bypasses and meters.
//
// WHY IT EXISTS: the rack now opens as a real pop-out (its own BrowserWindow, its own renderer), while
// the PROCESSOR row on Master Out — with the amber dot that says a stage is bypassed — stays in the
// main window. Two windows cannot share React state, so this hook exists to make sure they read the
// same things: the KV for the numbers, and THE ENGINE for what is actually happening.
//
// THE HONESTY RULE. Bypass is not a UI flag. The rack sends it as a live command; the engine echoes it
// back on the meter frame (proc_ride_bypass / proc_limiter_bypass); every window renders the ECHO. A
// pop-out engaging bypass therefore lights the banner in the main window too, and neither can claim a
// state the engine is not in. Local intent is used only before the first frame arrives (processing off,
// or no audio yet) — there is nothing observed to render then.
import { useCallback, useEffect, useState } from "react";
import { SHIPPED, ETHER_V1, paramsEqual, type ProcParams, type Preset } from "../components/ProcessorRack";

export type ProcMeters = {
  inLufs: number; outLufs: number; grDb: number; rideGainDb: number;
  inPeakDb: number; outPeakDb: number;
  rideBypass?: boolean; limiterBypass?: boolean;
  /** The ceiling the limiter is actually holding. Always negative when reported; absent or >= 0 means
   *  the engine did not send one (an older daemon), and no panel may substitute a number for it. */
  ceilingDbtp?: number;
} | null;

/** The four persisted NUMBERS (plus the target). Bypass is deliberately absent — never written. */
const PROC_KEYS: Record<keyof ProcParams, string> = {
  targetLufs:  "proc_target_lufs",
  ceilingDbtp: "proc_ceiling_dbtp",
  releaseMs:   "proc_release_ms",
  rideRate:    "proc_ride_rate",
  rideClamp:   "proc_ride_clamp",
};

export function useProcessorParams(stationId: number | null) {
  const [params, setParams]       = useState<ProcParams>({ ...SHIPPED });
  const [stored, setStored]       = useState<Partial<Record<keyof ProcParams, boolean>>>({});
  const [presets, setPresets]     = useState<Preset[]>([ETHER_V1]);
  const [activePreset, setActive] = useState<string | null>(ETHER_V1.name);
  const [meters, setMeters]       = useState<ProcMeters>(null);
  // Pre-confirmation intent only. Everything downstream prefers the engine's echo.
  const [intentRide, setIntentRide]       = useState(false);
  const [intentLimiter, setIntentLimiter] = useState(false);
  /** Last delivery failure, shown in the rack. Null when the last command was accepted. */
  const [sendError, setSendError] = useState<string | null>(null);

  // ── the numbers + presets, from station_config_kv ──────────────────────────
  useEffect(() => {
    if (stationId == null) return;          // never load against a guessed station
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).ether?.stationConfigKv?.list(stationId);
        const rows = ((r?.rows || []) as { key: string; value: string }[]);
        const get = (k: string) => rows.find(x => x.key === k)?.value;
        const next: ProcParams = { ...SHIPPED };
        const st: Partial<Record<keyof ProcParams, boolean>> = {};
        (Object.keys(PROC_KEYS) as (keyof ProcParams)[]).forEach(k => {
          const v = parseFloat(get(PROC_KEYS[k]) ?? "");
          if (!isNaN(v)) { next[k] = v; st[k] = true; }
        });
        let ps: Preset[] = [ETHER_V1];
        try {
          const raw = get("proc_presets");
          if (raw) ps = [ETHER_V1, ...(JSON.parse(raw) as Preset[]).filter(x => x && x.name && !x.builtIn)];
        } catch { /* a malformed preset blob must not cost the panel */ }
        if (!alive) return;
        setParams(next); setStored(st); setPresets(ps);
        setActive(get("proc_preset_active") || (ps.find(x => paramsEqual(x.params, next))?.name ?? ETHER_V1.name));
      } catch { /* leave the shipped chain showing — it IS what the engine is running */ }
    })();
    return () => { alive = false; };
  }, [stationId]);

  // ── meters (~15 Hz) — and with them, the observed bypass state ────────────
  useEffect(() => {
    if (stationId == null) return;
    const audio = (window as any).ether?.audio;
    if (!audio?.onProcMeters) return;
    let stale: any = null;
    const h = audio.onProcMeters((m: any) => {
      if (!m) return;
      setMeters({
        inLufs: m.inLufs, outLufs: m.outLufs, grDb: m.grDb, rideGainDb: m.rideGainDb ?? 0,
        inPeakDb: m.inPeakDb, outPeakDb: m.outPeakDb,
        rideBypass: m.rideBypass, limiterBypass: m.limiterBypass, ceilingDbtp: m.ceilingDbtp,
      });
      if (stale) clearTimeout(stale);
      // No frame for a second means no observed state — drop to "—" rather than hold a stale number.
      stale = setTimeout(() => setMeters(null), 1000);
    });
    return () => { try { audio.offProcMeters?.(h); } catch {} if (stale) clearTimeout(stale); };
  }, [stationId]);

  const rideBypass    = meters?.rideBypass    ?? intentRide;
  const limiterBypass = meters?.limiterBypass ?? intentLimiter;

  /** Deliver to the engine, and SAY WHETHER IT LANDED.
   *
   *  This was fire-and-forget inside a `catch {}`: the promise was never awaited and any failure was
   *  swallowed, so a command that never reached the audio thread looked exactly like one that did. The
   *  main process now answers { numbers, bypass } and a false on either surfaces in the rack. */
  const send = useCallback(async (prm: ProcParams, rb: boolean, lb: boolean) => {
    if (stationId == null) return;
    try {
      const r = await (window as any).ether?.audio?.setProcessorParams?.(stationId, {
        ceilingDbtp: prm.ceilingDbtp, releaseMs: prm.releaseMs,
        rideRate: prm.rideRate, rideClamp: prm.rideClamp,
        rideBypass: rb, limiterBypass: lb,
      });
      // Older daemons (the daemon does NOT reload on auto-update) answer with a bare boolean or
      // undefined. Only an explicit false is treated as a failure; an unknown shape stays quiet.
      if (r && typeof r === "object" && (r.numbers === false || r.bypass === false)) {
        setSendError(r.reason || (r.bypass === false && r.numbers !== false
          ? "the engine did not accept the bypass command"
          : "the engine did not accept the processor settings"));
      } else {
        setSendError(null);
      }
    } catch (e: any) {
      setSendError(String(e?.message || e));
    }
  }, [stationId]);

  const patch = useCallback((p: Partial<ProcParams>) => {
    if (stationId == null) return;
    setParams(prev => {
      const next = { ...prev, ...p };
      const kv = (window as any).ether?.stationConfigKv;
      (Object.keys(p) as (keyof ProcParams)[]).forEach(k => {
        try { kv?.upsertByKey(stationId, PROC_KEYS[k], String(next[k])); } catch {}
        setStored(s => ({ ...s, [k]: true }));
      });
      send(next, rideBypass, limiterBypass);
      return next;
    });
  }, [stationId, send, rideBypass, limiterBypass]);

  const selectPreset = useCallback((name: string) => {
    const pre = presets.find(x => x.name === name); if (!pre || stationId == null) return;
    setActive(name);
    try { (window as any).ether?.stationConfigKv?.upsertByKey(stationId, "proc_preset_active", name); } catch {}
    patch(pre.params);      // one action, every parameter — an A/B is one click each way
  }, [presets, stationId, patch]);

  const savePreset = useCallback((name: string) => {
    if (stationId == null) return;
    const rest = [...presets.filter(x => x.name !== name && !x.builtIn), { name, params: { ...params } }];
    setPresets([ETHER_V1, ...rest]);
    setActive(name);
    try {
      const kv = (window as any).ether?.stationConfigKv;
      kv?.upsertByKey(stationId, "proc_presets", JSON.stringify(rest));
      kv?.upsertByKey(stationId, "proc_preset_active", name);
    } catch {}
  }, [presets, params, stationId]);

  const setBypass = useCallback((which: "ride" | "limiter", on: boolean) => {
    const rb = which === "ride" ? on : rideBypass;
    const lb = which === "limiter" ? on : limiterBypass;
    if (which === "ride") setIntentRide(on); else setIntentLimiter(on);
    send(params, rb, lb);   // the engine's echo is what the UI will actually render
  }, [rideBypass, limiterBypass, params, send]);

  // THE PROJECTION. What the ride WOULD apply right now, derived from the observed input loudness and
  // the operator's own target and clamp. Shown greyed and labelled while the ride is bypassed, so the
  // useful information survives without any meter claiming to be an applied gain.
  // Not a field on the meter frame by design: a projection must not travel on the same wire as an
  // observation, or the next reader will mistake one for the other.
  const wouldRideDb = meters
    ? Math.max(-params.rideClamp, Math.min(params.rideClamp, params.targetLufs - meters.inLufs))
    : null;

  // A bypass the operator engaged that the ENGINE has not confirmed. The chip renders the echo, so
  // without this an unconfirmed click is silent — exactly the failure that hid the dead button.
  const bypassPending = (intentRide !== rideBypass) || (intentLimiter !== limiterBypass);

  return { params, stored, presets, activePreset, meters, rideBypass, limiterBypass, wouldRideDb,
           sendError, bypassPending, patch, selectPreset, savePreset, setBypass };
}
