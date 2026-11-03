// FaderRouting — every fader's routing settings (Jeff, 2026-10-11: "faders are generic shells … three explicit per-fader
// settings (local output: main speakers or AUX; ducks music; ducked by others), on every fader, visible on the strip").
// TO STREAM (2026-10-16): a fourth — on the stream (ON, every fader's default) or heard only locally (OFF: the park through
// MAIN/AUX and MONITOR, never the stream).
//
// What it shows is what the engine is running: main reads it with the ONE applier's rule (board:routing →
// audiod/board-state.js readSavedBoard). A press SAVES the setting and sends it (board:set-routing); a send the engine
// cannot take yet is queued by main, never dropped. Every window refreshes on board:routing-changed.
//
// ONE DUCK BUTTON (Jeff, 2026-11-02: "each source fader has two duck buttons (DUCK ON/OFF under the source picker, and DUCK
// above EQ). Remove both, and add one DUCK button in the bottom row next to ON and PFL: ON | PFL | DUCK. Same behavior as
// today, one button. Only on faders that have duck today."). DuckButton is that button — the same setting both old
// buttons wrote (deck_configs.duck + the engine's setDuck), through this file's one-row writer — and ConsoleStrip puts it
// in its bottom row. What stays here is the Park mic fader's MAIN.
import { useCallback, useEffect, useState } from "react";
import { useMicInputs } from "../hooks/useMicInputs";

type Routing = { local: "aux" | "main"; duck: boolean; duckable: boolean; stream?: boolean };
const ENGINE_SLOTS = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];
const DECKS = ["A", "B", "C"];

/** Does this fader have DUCK? Every engine fader except automation's decks A, B, C — the faders that had it before. */
export function hasDuck(slot: string | null | undefined): boolean {
  const s = String(slot || "");
  return ENGINE_SLOTS.includes(s) && !DECKS.includes(s);
}

/** One fader's saved routing, re-read whenever any window changes a board's routing; `set` saves and sends one change. */
function useFaderRouting(stationId: number | null, stationUuid: string | null | undefined, slot: string, label: string) {
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
  return { r, set };
}

const btn = (on: boolean, color: string) => ({
  flex: 1, height: 20, fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", cursor: "pointer", borderRadius: 2,
  background: on ? `color-mix(in srgb, ${color} 24%, transparent)` : "var(--bg-tertiary, #232330)",
  border: `1px solid ${on ? color : "var(--border-primary, #333)"}`, color: on ? color : "var(--text-tertiary, #777)",
} as const);

export default function FaderRouting({ stationId, stationUuid, slot, label }: { stationId: number | null; stationUuid?: string | null; slot: string; label: string }) {
  const { r, set } = useFaderRouting(stationId, stationUuid, slot, label);
  // THE BUTTONS THE STRIP SHOWS HERE (Jeff, 2026-10-16 — display only, no routing change: "decks A, B, C show no buttons;
  // … a Park mic fader shows DUCK and MAIN (lit = also on air). Remove TO STREAM and MAIN/AUX from view."). DUCK is now in
  // the strip's bottom row (DuckButton). The fader's local output, DUCKED and every other setting stay exactly as saved and
  // applied — hidden, never changed. MAIN on a Park mic fader is its on-air setting (the engine's per-fader air switch).
  const mic = useMicInputs(stationId);
  const isParkMic = /^park:\d+$/.test(mic.patches[slot]?.device || "");
  if (stationId == null || !ENGINE_SLOTS.includes(slot) || !r) return null;
  if (DECKS.includes(slot) || !isParkMic) return null;
  return (
    <div style={{ display: "flex", gap: 3, padding: "6px 8px 0" }}>
      <button onClick={() => void set({ stream: !(r.stream !== false) })} style={btn(r.stream !== false, "#4ade80")} aria-pressed={r.stream !== false}
        title={`${label}: ${r.stream !== false ? "MAIN lit — the voice plays in the park and also goes on air" : "MAIN not lit — the voice plays in the park only, not on air"}. Click to change.`}>
        MAIN
      </button>
    </div>
  );
}

/** DUCK — in the strip's bottom row, next to ON and PFL, the same size. Lit = the music dips while this fader plays. */
export function DuckButton({ stationId, stationUuid, slot, label, narrow }: { stationId: number | null; stationUuid?: string | null; slot: string; label: string; narrow: boolean }) {
  const { r, set } = useFaderRouting(stationId, stationUuid, slot, label);
  if (stationId == null || !hasDuck(slot)) return null;
  const on = !!r?.duck;
  return (
    <button onClick={() => void set({ duck: !on })} disabled={!r} aria-pressed={on} data-strip-duck="1"
      title={`${label}: ${on ? "DUCK lit — the music dips while this fader plays" : "DUCK not lit — the music does not dip for this fader"}. Click to change.`}
      style={{
        flex: 1, height: narrow ? 32 : 38, minHeight: narrow ? 32 : 38, borderRadius: 3, cursor: r ? "pointer" : "default",
        background: on ? "color-mix(in srgb, #fbbf24 24%, transparent)" : "var(--bg-tertiary, #232330)",
        border: `1px solid ${on ? "#fbbf24" : "var(--border-primary, #333)"}`,
        display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.12s",
      }}>
      <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.12em", color: on ? "#fbbf24" : "var(--text-tertiary, #666)" }}>DUCK</span>
    </button>
  );
}
