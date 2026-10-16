// FaderRouting — every fader's three routing settings, on the strip (Jeff, 2026-10-11: "faders are generic shells …
// three explicit per-fader settings (local output: main speakers or AUX; ducks music; ducked by others), on every
// fader, visible on the strip"). TO STREAM (2026-10-16): a fourth — on the stream (ON, every fader's default) or heard
// only locally (OFF: the park through MAIN/AUX and MONITOR, never the stream).
//
// What it shows is what the engine is running: main reads it with the ONE applier's rule (board:routing →
// audiod/board-state.js readSavedBoard). A press SAVES the setting and sends it (board:set-routing); a send the engine
// cannot take yet is queued by main, never dropped. Every window refreshes on board:routing-changed.
import { useCallback, useEffect, useState } from "react";
import { useMicInputs } from "../hooks/useMicInputs";

type Routing = { local: "aux" | "main"; duck: boolean; duckable: boolean; stream?: boolean };
const ENGINE_SLOTS = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];
const DECKS = ["A", "B", "C"];

export default function FaderRouting({ stationId, stationUuid, slot, label }: { stationId: number | null; stationUuid?: string | null; slot: string; label: string }) {
  const [r, setR] = useState<Routing | null>(null);
  const ether = (window as any).ether;
  const load = useCallback(async () => {
    if (stationId == null) return;
    try { const all = await ether?.invoke?.("board:routing", stationId); setR(all && all[slot] ? all[slot] : null); }
    catch (e) { console.warn(`[routing] ${label} not read:`, e); }
  }, [stationId, slot, label, ether]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Matched by the station's UUID — a station frame never carries this machine's integer id across a boundary.
    const h = ether?.on?.("board:routing-changed", (m: any) => { if (!m || !m.stationUuid || m.stationUuid === stationUuid) void load(); });
    return () => { try { if (h) ether?.off?.("board:routing-changed", h); } catch { /* window closing */ } };
  }, [ether, stationUuid, load]);

  const set = async (patch: Partial<Routing>) => {
    if (stationId == null || !r) return;
    setR({ ...r, ...patch });
    try {
      const res = await ether?.invoke?.("board:set-routing", stationId, slot, patch);
      if (!res || res.ok !== true) { console.warn(`[routing] ${label} not saved:`, res && res.reason); void load(); }
    } catch (e) { console.warn(`[routing] ${label} not sent:`, e); void load(); }
  };

  // THE BUTTONS THE STRIP SHOWS (Jeff, 2026-10-16 — display only, no routing change: "decks A, B, C show no buttons;
  // other faders show only DUCK; a Park mic fader shows DUCK and MAIN (lit = also on air). Remove TO STREAM and MAIN/AUX
  // from view."). The fader's local output, DUCKED and every other setting stay exactly as saved and applied — hidden,
  // never changed. MAIN on a Park mic fader is its on-air setting (the engine's per-fader air switch, saved as before).
  const mic = useMicInputs(stationId);
  const isParkMic = /^park:\d+$/.test(mic.patches[slot]?.device || "");
  if (stationId == null || !ENGINE_SLOTS.includes(slot) || !r) return null;
  if (DECKS.includes(slot)) return null;
  const btn = (on: boolean, color: string) => ({
    flex: 1, height: 20, fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", cursor: "pointer", borderRadius: 2,
    background: on ? `color-mix(in srgb, ${color} 24%, transparent)` : "var(--bg-tertiary, #232330)",
    border: `1px solid ${on ? color : "var(--border-primary, #333)"}`, color: on ? color : "var(--text-tertiary, #777)",
  } as const);
  return (
    <div style={{ display: "flex", gap: 3, padding: "6px 8px 0" }}>
      <button onClick={() => void set({ duck: !r.duck })} style={btn(r.duck, "#fbbf24")} aria-pressed={r.duck}
        title={`${label}: ${r.duck ? "DUCK lit — the music dips while this fader plays" : "DUCK not lit — the music does not dip for this fader"}. Click to change.`}>DUCK</button>
      {isParkMic && (
        <button onClick={() => void set({ stream: !(r.stream !== false) })} style={btn(r.stream !== false, "#4ade80")} aria-pressed={r.stream !== false}
          title={`${label}: ${r.stream !== false ? "MAIN lit — the voice plays in the park and also goes on air" : "MAIN not lit — the voice plays in the park only, not on air"}. Click to change.`}>
          MAIN
        </button>
      )}
    </div>
  );
}
