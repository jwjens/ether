// src/hooks/useMasterRack.ts — SLICE 4: the station's master rack, its presets, Arm → Take.
// docs/dsp-rack-framework.md §1, §4.
//
// ONE READER, ONE WRITER. The rack is read with rack:get (the stored `rack_master`, or the rack seeded from the
// legacy keys — main and the daemon share audiod/rack-seed.js) and written with rack:set, which delivers it to
// THIS station's engine first and stores it (plus the legacy write-back) only if the engine accepted it. A
// refused rack is shown with its reason and the panel goes back to what is running — never a panel claiming a
// chain that is not on air.
//
// PRESETS are whole racks (never the processing on/off switches — Jeff's slice 4 ruling 2), stored as
// `rack_presets` / `rack_preset_active`. Arm stages a preset and shows what would change; Take applies it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MasterRackDoc, RackPreset } from "../components/rack/rackTypes";
import { BUILT_IN_PRESETS, DEFAULT_PRESET, convertLegacyPresets, racksEqual } from "../components/rack/rackModel";

/** Tell other windows (Master Out's EQ dot) that a station's rack changed. Per-viewer only. */
function bumpRev(stationId: number) {
  try { localStorage.setItem("ether.rack.rev", `${stationId}:${Date.now()}`); } catch { /* not essential */ }
}

/**
 * THE ONE PLACE A PRESET IS APPLIED. `protect` is slice 7's live-channel rule — "channels that are ON are
 * protected until OFF". The master rack has no ON channels, so in slice 4 Take applies immediately and this
 * branch is empty; slice 7 fills it without changing the preset bar.
 */
export async function applyPreset(stationId: number, doc: MasterRackDoc, opts: { protect: boolean }): Promise<{ ok: boolean; reason?: string }> {
  if (opts.protect) { /* slice 7 — reserved */ }
  const r = await (window as any).ether?.audio?.setRack?.(stationId, doc);
  return r && r.ok === true ? { ok: true } : { ok: false, reason: (r && r.reason) || "the rack could not be applied" };
}

export function useMasterRack(stationId: number | null) {
  const [doc, setDoc] = useState<MasterRackDoc | null>(null);
  const [source, setSource] = useState<"rack_master" | "seed" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userPresets, setUserPresets] = useState<RackPreset[]>([]);
  const [activeName, setActiveName] = useState<string>(DEFAULT_PRESET);
  const [armed, setArmed] = useState<RackPreset | null>(null);
  const applied = useRef<MasterRackDoc | null>(null);   // what the engine last accepted
  const pending = useRef<MasterRackDoc | null>(null);
  const timer = useRef<any>(null);

  // ── load: the rack, and the presets ────────────────────────────────────────
  useEffect(() => {
    if (stationId == null) return;             // never load against a guessed station
    let alive = true;
    setDoc(null); setArmed(null); setError(null);
    (async () => {
      const api = (window as any).ether;
      try {
        const r = await api?.audio?.getRack?.(stationId);
        if (!alive) return;
        if (!r || r.ok !== true) { setError((r && r.reason) || "the rack could not be read"); return; }
        setDoc(r.doc); applied.current = r.doc; setSource(r.source);
        const kv = await api?.stationConfigKv?.list(stationId);
        const rows = ((kv?.rows || []) as { key: string; value: string }[]);
        const get = (k: string) => rows.find(x => x.key === k)?.value;
        let ups: RackPreset[] = [];
        try {
          const raw = get("rack_presets");
          ups = raw ? (JSON.parse(raw) as RackPreset[]).filter(p => p && p.name && p.doc && !p.builtIn)
                    : convertLegacyPresets(get("proc_presets"));
        } catch { ups = []; }
        if (!alive) return;
        setUserPresets(ups);
        const all = [...BUILT_IN_PRESETS, ...ups];
        const stored = get("rack_preset_active");
        setActiveName(stored && all.some(p => p.name === stored) ? stored
          : (all.find(p => racksEqual(p.doc, r.doc))?.name ?? DEFAULT_PRESET));
      } catch (e: any) { if (alive) setError(String(e?.message || e)); }
    })();
    return () => { alive = false; };
  }, [stationId]);

  /** Send a rack to the engine; on refusal, show why and go back to what is running. */
  const flush = useCallback(async () => {
    timer.current = null;
    const next = pending.current; pending.current = null;
    if (!next || stationId == null) return;
    const r = await (window as any).ether?.audio?.setRack?.(stationId, next);
    if (r && r.ok === true) { applied.current = next; setError(null); setSource("rack_master"); bumpRev(stationId); }
    else { setError((r && r.reason) || "the engine did not accept the rack"); setDoc(applied.current); }
  }, [stationId]);

  /** Edit the rack. The panel follows the hand immediately; the engine gets at most one rack per 120 ms and
   *  the last one always (a slider drag is not forty writes). */
  const update = useCallback((next: MasterRackDoc) => {
    setDoc(next);
    pending.current = next;
    if (!timer.current) timer.current = setTimeout(flush, 120);
  }, [flush]);

  const presets = [...BUILT_IN_PRESETS, ...userPresets];
  const active = presets.find(p => p.name === activeName) || null;
  const modified = !!doc && !!active && !racksEqual(active.doc, doc);

  const arm = useCallback((name: string) => {
    const p = [...BUILT_IN_PRESETS, ...userPresets].find(x => x.name === name) || null;
    setArmed(p);
  }, [userPresets]);
  const disarm = useCallback(() => setArmed(null), []);
  const take = useCallback(async () => {
    if (!armed || stationId == null) return;
    const r = await applyPreset(stationId, armed.doc, { protect: false });
    if (!r.ok) { setError(r.reason || "the preset was not applied"); return; }
    applied.current = armed.doc; setDoc(armed.doc); setError(null); setSource("rack_master"); bumpRev(stationId);
    setActiveName(armed.name);
    try { (window as any).ether?.stationConfigKv?.upsertByKey(stationId, "rack_preset_active", armed.name); } catch {}
    setArmed(null);
  }, [armed, stationId]);

  const persistPresets = (list: RackPreset[]) => {
    if (stationId == null) return;
    try { (window as any).ether?.stationConfigKv?.upsertByKey(stationId, "rack_presets", JSON.stringify(list)); } catch {}
  };
  /** Save As — a new user preset (a built-in's name cannot be taken). */
  const saveAs = useCallback((name: string): string | null => {
    if (!doc || stationId == null) return "nothing to save";
    const n = name.trim();
    if (!n) return "name it first";
    if (BUILT_IN_PRESETS.some(p => p.name === n)) return "that is a built-in preset — pick another name";
    const list = [...userPresets.filter(p => p.name !== n), { name: n, doc }];
    setUserPresets(list); persistPresets(list);
    setActiveName(n);
    try { (window as any).ether?.stationConfigKv?.upsertByKey(stationId, "rack_preset_active", n); } catch {}
    return null;
  }, [doc, stationId, userPresets]);
  /** Save — overwrite the active user preset (built-ins are read-only). */
  const save = useCallback((): string | null => {
    if (!active || active.builtIn) return "a built-in preset cannot be overwritten — use Save As";
    return saveAs(active.name);
  }, [active, saveAs]);

  return { doc, source, error, update, presets, activeName, modified, armed, arm, disarm, take, save, saveAs };
}
