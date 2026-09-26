// src/hooks/useMicInputs.ts — THE MIC AS AN ENGINE INPUT, renderer side (docs/dsp-mic-in-engine.md §3, §4).
//
// ONE READER, ONE WRITER. The patches (which input device feeds which source channel, on THIS machine) are read
// with mic:get and written with mic:set — engine first, stored machine-local only if the engine took it. The
// live state (running / not_found / lost / digital_silence…, the ring fill, the drift, the counters) is the
// ENGINE's, read with mic:state. One shared poller per station, however many strips and panels show it.
import { useCallback, useEffect, useState } from "react";

export type MicPatch = { device: string; channel: number; gainDb: number };
export type MicState = {
  slot: string; device: string; channel: number; gainDb: number;
  state: "off" | "opening" | "not_found" | "bad_channel" | "unsupported" | "open_failed" | "running" | "digital_silence" | "lost" | string;
  reason: string; rate: number; channels: number; losses: number; reopens: number;
  fillMs: number; targetMs: number; driftPpm: number; primed: boolean;
  underruns: number; starvedMs: number; overruns: number; staleFlushes: number; deviceErrors: number; zeroSec: number;
};
export type InputDevice = { name: string; channels: number; rate: number; format: string; isDefault: boolean };

const REV_KEY = "ether.mic.rev";
export const MIC_SLOTS = ["D", "E", "F", "S1", "S2", "S3", "S4", "S5"] as const;
export const MIC_GAIN_DB: [number, number] = [-10, 40];

// ── the store ────────────────────────────────────────────────────────────────────────────────────────────
type Snap = { patches: Record<string, MicPatch>; states: Record<string, MicState>; loaded: boolean };
type Store = { snap: Snap; subs: Set<(s: Snap) => void>; timer: any; tick: number };
const stores = new Map<number, Store>();

async function refresh(stationId: number, patches: boolean) {
  const st = stores.get(stationId);
  if (!st) return;
  const api = (window as any).ether?.audio;
  let next = st.snap;
  try {
    if (patches) {
      const r = await api?.getMicInputs?.(stationId);
      if (r && r.ok) next = { ...next, patches: r.patches || {}, loaded: true };
    }
    const s = await api?.micState?.(stationId);
    const states: Record<string, MicState> = {};
    for (const m of (s?.mics || [])) states[m.slot] = m;
    next = { ...next, states };
  } catch { /* keep the last snapshot; the panel says what it last knew */ }
  st.snap = next;
  st.subs.forEach(fn => fn(next));
}
function bump(stationId: number) {
  try { localStorage.setItem(REV_KEY, `${stationId}:${Date.now()}`); } catch { /* not essential */ }
  refresh(stationId, true);
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== REV_KEY) return;
    for (const id of stores.keys()) refresh(id, true);
  });
}

/** The station's mic patches and the engine's live mic state. Polled once a second while anything shows it. */
export function useMicInputs(stationId: number | null | undefined) {
  const empty: Snap = { patches: {}, states: {}, loaded: false };
  const [snap, setSnap] = useState<Snap>(() => (stationId != null ? stores.get(stationId)?.snap ?? empty : empty));
  useEffect(() => {
    if (stationId == null) { setSnap(empty); return; }
    let st = stores.get(stationId);
    if (!st) {
      st = { snap: empty, subs: new Set(), timer: null, tick: 0 };
      stores.set(stationId, st);
      const s0 = st;
      s0.timer = setInterval(() => { s0.tick++; refresh(stationId, s0.tick % 15 === 0); }, 1000);
      refresh(stationId, true);
    } else setSnap(st.snap);
    st.subs.add(setSnap);
    return () => {
      const s2 = stores.get(stationId);
      if (!s2) return;
      s2.subs.delete(setSnap);
      if (s2.subs.size === 0) { clearInterval(s2.timer); stores.delete(stationId); }
    };
  }, [stationId]);

  /** Patch / re-patch / unpatch (device ""). Engine first; the answer says whether it took. */
  const setPatch = useCallback(async (slot: string, patch: MicPatch | null): Promise<{ ok: boolean; reason?: string }> => {
    if (stationId == null) return { ok: false, reason: "no station" };
    const r = await (window as any).ether?.audio?.setMicInput?.(stationId, slot, patch || { device: "" });
    bump(stationId);
    return r && r.ok === true ? { ok: true } : { ok: false, reason: (r && r.reason) || "the engine did not take the patch" };
  }, [stationId]);

  return { ...snap, setPatch };
}

/** The input devices THIS machine's engine can open (the daemon's list — not the browser's). */
export function useInputDevices() {
  const [devices, setDevices] = useState<InputDevice[] | null>(null);
  const reload = useCallback(async () => {
    try { const d = await (window as any).ether?.audio?.listInputDevices?.(); setDevices(Array.isArray(d) ? d : []); }
    catch { setDevices([]); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { devices, reload };
}

// ── the door ─────────────────────────────────────────────────────────────────────────────────────────────
const OPEN_KEY = "ether.openPrefs";
/** Open Preferences → Audio (where mic inputs are patched). Works from the main window and from a pop-out. */
export function openMicPreferences() {
  try { localStorage.setItem(OPEN_KEY, `audio:${Date.now()}`); } catch { /* the same-window event still fires */ }
  try { window.dispatchEvent(new CustomEvent("ether:open-preferences", { detail: { category: "audio" } })); } catch { /* not in a browser */ }
}
export const OPEN_PREFS_KEY = OPEN_KEY;

// ── words for a state (the strip, the panel and the Health Monitor say the same thing) ─────────────────
export function micStateWords(s: MicState | undefined, patched: boolean): { text: string; tone: "ok" | "warn" | "bad" | "off" } {
  if (!patched) return { text: "no input patched", tone: "off" };
  if (!s) return { text: "waiting for the engine", tone: "warn" };
  switch (s.state) {
    case "running": return s.primed ? { text: "live", tone: "ok" } : { text: "starting", tone: "warn" };
    case "opening": return { text: "opening", tone: "warn" };
    case "not_found": return { text: "device not connected", tone: "bad" };
    case "lost": return { text: "device lost — retrying", tone: "bad" };
    case "digital_silence": return { text: "pure digital silence — Windows mic privacy?", tone: "bad" };
    case "bad_channel": return { text: "that input is not on this device", tone: "bad" };
    case "unsupported": case "open_failed": return { text: "could not open", tone: "bad" };
    default: return { text: s.state, tone: "warn" };
  }
}
