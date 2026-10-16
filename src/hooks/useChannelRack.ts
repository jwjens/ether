// src/hooks/useChannelRack.ts — SLICE 5: one fader's channel rack (docs/dsp-channel-rack-eq.md §3, §4).
//
// ONE READER, ONE WRITER — the same path as the master rack: rack:get / rack:set with the rack name
// "ch:<slot>". rack:set delivers to THIS station's engine first and stores `rack_ch_<slot>` only if the engine
// accepted it; a refused rack is shown with its reason and the panel goes back to what is running.
//
// Also here: the EQ DOOR (openChannelRack — every fader strip's EQ button, and the on-air decks') and the
// door's LAMP (useChannelRackLamps — lit when that fader's stored rack has something IN). The lamp re-reads
// when any rack is written (the `ether.rack.rev` bump crosses windows) and every 15 s (a rack synced in from
// another install).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelRackDoc } from "../components/rack/rackTypes";
import { CHANNEL_SLOTS, channelRackActive, rackName, type ChannelSlot } from "../components/rack/channelRack";

export const RACK_VIEW_KEY = "ether.rack.view";
const REV_KEY = "ether.rack.rev";

function bumpRev(stationId: number) {
  try { localStorage.setItem(REV_KEY, `${stationId}:${Date.now()}`); } catch { /* not essential */ }
  lampListeners.forEach(fn => fn());   // same window (a storage event only reaches OTHER windows)
}

/** Open the rack window at a fader's channel rack (or re-select it if the window is already open). */
export function openChannelRack(slot: ChannelSlot) {
  try { localStorage.setItem(RACK_VIEW_KEY, rackName(slot)); } catch { /* opens on its last view */ }
  try { (window as any).ether?.invoke("window:popout", "processor"); } catch { /* not in electron */ }
}

export function useChannelRack(stationId: number | null, slot: ChannelSlot) {
  const [doc, setDoc] = useState<ChannelRackDoc | null>(null);
  const [source, setSource] = useState<"stored" | "empty" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applied = useRef<ChannelRackDoc | null>(null);
  const pending = useRef<ChannelRackDoc | null>(null);
  const timer = useRef<any>(null);

  useEffect(() => {
    if (stationId == null) return;            // never load against a guessed station
    let alive = true;
    setDoc(null); setError(null);
    (async () => {
      try {
        const r = await (window as any).ether?.audio?.getRack?.(stationId, rackName(slot));
        if (!alive) return;
        if (!r || r.ok !== true) { setError((r && r.reason) || "the channel rack could not be read"); return; }
        setDoc(r.doc); applied.current = r.doc; setSource(r.source);
      } catch (e: any) { if (alive) setError(String(e?.message || e)); }
    })();
    return () => { alive = false; };
  }, [stationId, slot]);

  const flush = useCallback(async () => {
    timer.current = null;
    const next = pending.current; pending.current = null;
    if (!next || stationId == null) return;
    const r = await (window as any).ether?.audio?.setRack?.(stationId, next, rackName(slot));
    if (r && r.ok === true) { applied.current = next; setError(null); setSource("stored"); bumpRev(stationId); }
    else { setError((r && r.reason) || "the engine did not accept the rack"); setDoc(applied.current); }
  }, [stationId, slot]);

  /** Edit. The panel follows the hand at once; the engine gets at most one rack per 120 ms and always the last
   *  (every change is a 20 ms crossfade in the engine, so a drag is smooth, not forty clicks). */
  const update = useCallback((next: ChannelRackDoc) => {
    setDoc(next);
    pending.current = next;
    if (!timer.current) timer.current = setTimeout(flush, 120);
  }, [flush]);

  return { doc, source, error, update };
}

// ── the lamps — ONE shared reader per station, however many strips show a lamp ─────────────────────────────
type Lamps = Partial<Record<ChannelSlot, boolean>>;
type Store = { lamps: Lamps; subs: Set<(l: Lamps) => void>; timer: any; reading: boolean };
const stores = new Map<number, Store>();
const lampListeners = new Set<() => void>();   // bumpRev → re-read every station on screen

async function refreshStation(stationId: number) {
  const st = stores.get(stationId);
  if (!st || st.reading) return;
  st.reading = true;
  const api = (window as any).ether?.audio;
  const out: Lamps = {};
  try {
    await Promise.all(CHANNEL_SLOTS.map(async s => {
      try {
        const r = await api?.getRack?.(stationId, rackName(s));
        if (r && r.ok === true) out[s] = channelRackActive(r.doc);
      } catch { /* unknown → no lamp claim */ }
    }));
  } finally { st.reading = false; }
  st.lamps = out;
  st.subs.forEach(fn => fn(out));
}
const refreshAll = () => { for (const id of stores.keys()) refreshStation(id); };
lampListeners.add(refreshAll);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e: StorageEvent) => { if (e.key === REV_KEY) refreshAll(); });
}

/** Each fader's EQ lamp for a station: true = its stored rack has something IN; absent = not known. */
export function useChannelRackLamps(stationId: number | null | undefined): Lamps {
  const [lamps, setLamps] = useState<Lamps>(() => (stationId != null ? stores.get(stationId)?.lamps ?? {} : {}));
  useEffect(() => {
    if (stationId == null) { setLamps({}); return; }
    let st = stores.get(stationId);
    if (!st) {
      st = { lamps: {}, subs: new Set(), timer: null, reading: false };
      stores.set(stationId, st);
      st.timer = setInterval(() => refreshStation(stationId), 15000);
      refreshStation(stationId);
    } else setLamps(st.lamps);
    st.subs.add(setLamps);
    return () => {
      const s2 = stores.get(stationId);
      if (!s2) return;
      s2.subs.delete(setLamps);
      if (s2.subs.size === 0) { clearInterval(s2.timer); stores.delete(stationId); }
    };
  }, [stationId]);
  return lamps;
}
