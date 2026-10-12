// FaderRouting — every fader's three routing settings, on the strip (Jeff, 2026-10-11: "faders are generic shells …
// three explicit per-fader settings (local output: main speakers or AUX; ducks music; ducked by others), on every
// fader, visible on the strip").
//
// What it shows is what the engine is running: main reads it with the ONE applier's rule (board:routing →
// audiod/board-state.js readSavedBoard). A press SAVES the setting and sends it (board:set-routing); a send the engine
// cannot take yet is queued by main, never dropped. Every window refreshes on board:routing-changed.
import { useCallback, useEffect, useState } from "react";

type Routing = { local: "aux" | "main"; duck: boolean; duckable: boolean };
const ENGINE_SLOTS = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];

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

  if (stationId == null || !ENGINE_SLOTS.includes(slot) || !r) return null;
  const btn = (on: boolean, color: string) => ({
    flex: 1, height: 20, fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", cursor: "pointer", borderRadius: 2,
    background: on ? `color-mix(in srgb, ${color} 24%, transparent)` : "var(--bg-tertiary, #232330)",
    border: `1px solid ${on ? color : "var(--border-primary, #333)"}`, color: on ? color : "var(--text-tertiary, #777)",
  } as const);
  return (
    <div style={{ display: "flex", gap: 3, padding: "6px 8px 0" }}>
      <button onClick={() => void set({ local: r.local === "aux" ? "main" : "aux" })} style={btn(true, r.local === "aux" ? "#8868D8" : "#4ade80")}
        title={`${label} is heard locally on the ${r.local === "aux" ? "AUX output (through its row in Master Out → AUX monitors)" : "main speakers"}. Click to switch. Air is not affected.`}>
        {r.local === "aux" ? "AUX" : "MAIN"}
      </button>
      <button onClick={() => void set({ duck: !r.duck })} style={btn(r.duck, "#fbbf24")}
        title={`${label} ${r.duck ? "DUCKS the music while it plays" : "does not duck the music"}. Click to change.`}>DUCKS</button>
      <button onClick={() => void set({ duckable: !r.duckable })} style={btn(r.duckable, "#38bdf8")}
        title={`${label} ${r.duckable ? "is DUCKED when another fader ducks the music" : "is never ducked"}. Click to change.`}>DUCKED</button>
    </div>
  );
}
