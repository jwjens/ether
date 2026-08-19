// AuxMonitorSlots — three fixed AUX slots in the Station Monitors area, each able to monitor one of
// the aux decks (D/E/F). Jeff's design, 2026-08-18.
//
// WHAT A SLOT IS — THE LISTENING PATH. Decks D/E/F are excluded from the station's local speaker
// output entirely; a slot is the ONLY way they are heard in the room, at that slot's own level. Pick
// "(none)" and that deck is silent here, whatever the board is doing. Jeff's ruling, 2026-08-18:
//
//     SLOT = ROOM.   BOARD = AIR.   Two gates, two destinations.
//
// Air is untouched by this panel: channel ON + fader up puts a deck on the programme bus and the
// stream, exactly as before (docs/jukebox-board-gate-2026-08-18.md). Cutting a channel silences it on
// air and does NOT silence it here — that is a true PFL, and it is what makes the two gates
// independent rather than one gate wearing two labels.
//
// WHY D/E/F ONLY: station automation enumerates ["A","B","C"] and never touches D/E/F
// (audiod/engine.js), so those are the aux decks — the jukebox, a guest feed, anything patched in.
// A/B/C already have their own strips on the board, and their local monitoring is unchanged.
//
// ── WHERE THE NUMBERS AND THE AUDIO COME FROM (all real, none synthesised) ───────────────────────
//   • the ROOM feed  ← native aux monitor bus: the mixer builds the room from the non-aux slots plus
//                      Σ(aux deck x its slot level), taken PRE-CUT and PRE-FADER
//                      (native/src/audio.rs; design: docs/aux-monitor-bus-design-2026-08-18.md)
//   • MONITOR level  → audio_set_aux_monitor(stationId, deck, gain); 0 = silent in the room
//   • VU             ← decks[].peak on the existing `audio:levels` broadcast
//   • position       ← decks[].frames_played / 44100 (the sample clock, not a wall-clock guess)
//   • title/status   ← ether.audio.getState(stationId), polled
//
// STILL NOT BUILT, deliberately: a per-slot OUTPUT DEVICE. Rust runs one output stream per station,
// so a slot cannot send its deck to a different device than the station's own. The room is one room.

import { useState, useEffect, useRef, useCallback } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { matchesStation } from "../lib/levelsScope";

const AUX_DECKS = ["D", "E", "F"] as const;
const SLOT_COUNT = 3;
const KEY = "aux_monitor_slots";
const LVL_KEY = "aux_monitor_levels";
const DEV_KEY = "aux_monitor_device";
const DEFAULT_LEVEL = 0.8;
const PROGRAM_RATE = 44100;   // DeckTel.frames_played is in PROGRAM_RATE frames (native/src/audio.rs)

interface DeckTel { id: string; source_present: boolean; active: boolean; paused: boolean; volume: number; peak?: number; frames_played?: number; }

const fmtPos = (frames: number) => {
  const s = Math.max(0, Math.floor(frames / PROGRAM_RATE));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const selectStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", fontSize: 12, padding: "3px 6px", borderRadius: 0,
  cursor: "pointer", outline: "none",
};

export default function AuxMonitorSlots() {
  const { stationId, stationUuid } = useActiveStation();
  const [slots, setSlots] = useState<string[]>(["", "", ""]);
  const [levels, setLevels] = useState<number[]>([DEFAULT_LEVEL, DEFAULT_LEVEL, DEFAULT_LEVEL]);
  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState<string>("");   // "" = none = the aux bus is silent
  const [tel, setTel] = useState<Record<string, DeckTel>>({});
  const [info, setInfo] = useState<Record<string, any>>({});
  const uuidRef = useRef(stationUuid);
  uuidRef.current = stationUuid;

  // ── Selections: load, and persist per station ──────────────────────────────────────────────────
  useEffect(() => {
    if (stationId == null) return;
    let stop = false;
    (async () => {
      try {
        const r: any = await (window as any).ether.stationConfigKv.list(stationId);
        const raw = ((r && r.rows) || []).find((x: any) => x.key === KEY)?.value;
        const parsed = raw ? JSON.parse(raw) : [];
        const next = Array.from({ length: SLOT_COUNT }, (_, i) =>
          (AUX_DECKS as readonly string[]).includes(parsed?.[i]) ? parsed[i] : "");
        const rawLvl = ((r && r.rows) || []).find((x: any) => x.key === LVL_KEY)?.value;
        let lv: number[] = [];
        try { const pl = rawLvl ? JSON.parse(rawLvl) : []; lv = Array.from({ length: SLOT_COUNT }, (_, i) => {
          const v = parseFloat(pl?.[i]); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : DEFAULT_LEVEL; }); }
        catch { lv = [DEFAULT_LEVEL, DEFAULT_LEVEL, DEFAULT_LEVEL]; }
        if (stop) return;
        setSlots(next); setLevels(lv);
        // ASSERT DOWNWARD. The engine boots with every aux gain at 0 and the panel states the
        // operator's saved position rather than assuming it — the same rule the channel cut follows.
        // Every aux deck is addressed, so a deck NOT in a slot is explicitly silenced in the room.
        for (const d of AUX_DECKS) {
          const idx = next.indexOf(d);
          void applyGain(d, idx >= 0 ? lv[idx] : 0);
        }
        // The OUTPUT DEVICE, asserted downward the same way. The engine opens no aux stream until it
        // is told which device, so an empty saved value means silence — deliberately.
        const dev = String(((r && r.rows) || []).find((x: any) => x.key === DEV_KEY)?.value ?? "");
        setDevice(dev);
        try { await (window as any).ether.audio.setAuxDevice(stationId, dev); } catch { /* engine not up */ }
        try {
          const list = await (window as any).ether.audio.listOutputDevices();
          if (!stop && Array.isArray(list)) setDevices(list);
        } catch { /* device list unavailable */ }
      } catch { if (!stop) setSlots(["", "", ""]); }
    })();
    return () => { stop = true; };
  }, [stationId]);

  /** The ROOM level for one aux deck. 0 = not selected = silent on the local speakers. Never air. */
  const applyGain = useCallback(async (deck: string, gain: number) => {
    if (stationId == null) return;
    try { await (window as any).ether.audio.setAuxMonitor(stationId, deck, gain); }
    catch { /* engine not up yet — the level is persisted and asserted on the next mount */ }
  }, [stationId]);

  const choose = useCallback((idx: number, deck: string) => {
    setSlots(prev => {
      const next = [...prev];
      const was = next[idx];
      next[idx] = deck;
      // Silence the deck this slot was holding, unless another slot still holds it.
      if (was && was !== deck && !next.includes(was)) void applyGain(was, 0);
      if (deck) void applyGain(deck, levels[idx]);
      if (stationId != null) {
        try { (window as any).ether.stationConfigKv.upsertByKey(stationId, KEY, JSON.stringify(next)); }
        catch { /* non-fatal — the choice still applies for this session */ }
      }
      return next;
    });
  }, [stationId, levels, applyGain]);

  const chooseDevice = useCallback((dev: string) => {
    setDevice(dev);
    if (stationId == null) return;
    // "" closes the aux stream in the engine — no device, no sound. Persisted so it survives a
    // restart rather than silently reopening on something the operator never picked.
    try { (window as any).ether.audio.setAuxDevice(stationId, dev); } catch { /* engine not up */ }
    try { (window as any).ether.stationConfigKv.upsertByKey(stationId, DEV_KEY, dev); } catch { /* non-fatal */ }
  }, [stationId]);

  const setLevel = useCallback((idx: number, v: number) => {
    setLevels(prev => {
      const next = [...prev];
      next[idx] = v;
      const deck = slots[idx];
      if (deck) void applyGain(deck, v);
      if (stationId != null) {
        try { (window as any).ether.stationConfigKv.upsertByKey(stationId, LVL_KEY, JSON.stringify(next)); }
        catch { /* non-fatal */ }
      }
      return next;
    });
  }, [stationId, slots, applyGain]);

  // ── VU + position: the existing levels broadcast, station-scoped like every other strip ─────────
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.audio?.onLevels) return;
    const h = ether.audio.onLevels((lvl: any) => {
      // The WHOLE frame, not lvl.stationUuid — matchesStation reads `.stationUuid` off its first
      // argument, so passing the string makes it undefined, which returns true for every frame and
      // silently disables station scoping (this strip would meter another station's audio).
      if (!matchesStation(lvl, uuidRef.current)) return;
      const decks: DeckTel[] = Array.isArray(lvl?.decks) ? lvl.decks : [];
      if (!decks.length) return;
      const next: Record<string, DeckTel> = {};
      for (const d of decks) if ((AUX_DECKS as readonly string[]).includes(d.id)) next[d.id] = d;
      setTel(next);
    });
    return () => ether.audio.offLevels?.(h);
  }, []);

  // ── What is loaded on each aux deck. Polled: this is a monitor panel, not the playout path. ─────
  const watched = slots.filter(Boolean).join(",");
  useEffect(() => {
    if (stationId == null || !watched) { setInfo({}); return; }
    let stop = false;
    const pull = async () => {
      try {
        const st: any = await (window as any).ether.audio.getState(stationId);
        if (stop || !st) return;
        const next: Record<string, any> = {};
        for (const d of watched.split(",")) next[d] = st[`deck${d}`] || null;
        setInfo(next);
      } catch { /* engine not up — the slot shows its idle state */ }
    };
    void pull();
    const t = setInterval(pull, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [stationId, watched]);

  const taken = slots.filter(Boolean);

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-primary)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" }}>
          Aux Monitors
        </span>
        <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>decks D–F</span>
      </div>

      {/* OUTPUT — where the aux bus is heard. Same grammar as each station monitor's OUTPUT picker.
          Nothing selected = the engine opens no aux stream at all = silence. A device is never
          chosen for the operator; on a broadcast machine the "default" could be anything. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 9, color: "var(--text-tertiary)", letterSpacing: "0.08em", width: 44 }}>OUTPUT</span>
        <select value={device} onChange={e => chooseDevice(e.target.value)} style={{ ...selectStyle, flex: 1 }}>
          <option value="">(none — aux silent)</option>
          {devices.map(d => <option key={d} value={d}>{d}</option>)}
          {device && !devices.includes(device) && <option value={device}>{device} (not connected)</option>}
        </select>
      </div>
      {!device && (
        <div style={{ fontSize: 10, color: "#a06030", marginBottom: 8, lineHeight: 1.5 }}>
          No output selected — the aux decks are silent everywhere. Pick the speakers or headphones you
          monitor on.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {Array.from({ length: SLOT_COUNT }, (_, i) => {
          const deck = slots[i];
          const t = deck ? tel[deck] : null;
          const nfo = deck ? info[deck] : null;
          const playing = nfo?.status === "playing";
          const peak = Math.max(0, Math.min(1, t?.peak ?? 0));

          return (
            <div key={i} style={{
              border: "1px solid var(--border-primary)",
              background: deck ? "var(--bg-secondary)" : "transparent",
              padding: "6px 8px", opacity: deck ? 1 : 0.55,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: "var(--text-tertiary)", width: 34, letterSpacing: "0.08em" }}>
                  AUX {i + 1}
                </span>
                <select
                  value={deck}
                  onChange={e => choose(i, e.target.value)}
                  style={{ ...selectStyle, width: 110 }}
                >
                  <option value="">(none)</option>
                  {AUX_DECKS.map(d => (
                    // A deck already watched in another slot is still selectable — two slots on one
                    // deck is harmless (both just observe), and silently hiding it would be worse.
                    <option key={d} value={d}>Deck {d}{taken.filter(x => x === d).length > 1 && deck !== d ? " (in use)" : ""}</option>
                  ))}
                </select>

                {deck ? (
                  <>
                    <span style={{
                      fontSize: 9, fontWeight: 900, letterSpacing: "0.1em", padding: "1px 5px",
                      color: playing ? "#4ade80" : "var(--text-tertiary)",
                      border: `1px solid ${playing ? "#4ade8055" : "var(--border-primary)"}`,
                    }}>{playing ? "PLAYING" : (nfo?.status || "idle").toUpperCase()}</span>
                    <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
                      {fmtPos(t?.frames_played ?? 0)}
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>empty</span>
                )}
              </div>

              {deck && (
                <>
                  <div style={{
                    fontSize: 11.5, color: "var(--text-primary)", marginTop: 5,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {nfo?.title || <span style={{ color: "var(--text-tertiary)" }}>nothing loaded</span>}
                    {nfo?.artist ? <span style={{ color: "var(--text-tertiary)" }}> — {nfo.artist}</span> : null}
                  </div>

                  {/* VU — decks[].peak, the same post-fader number the A/B/C meters use. */}
                  <div style={{ height: 6, background: "var(--bg-primary)", border: "1px solid var(--border-primary)", marginTop: 5, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${Math.round(peak * 100)}%`,
                      background: peak > 0.89 ? "#ef4444" : peak > 0.7 ? "#fbbf24" : "#4ade80",
                      transition: "width 80ms linear",
                    }} />
                  </div>

                  {/* MONITOR level — the ROOM, not air. This slot is the only path by which this deck
                      reaches the local speakers; the board's channel and fader decide the stream. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <span style={{ fontSize: 9, color: "#8868D8", letterSpacing: "0.08em", width: 62, fontWeight: 700 }}>MONITOR</span>
                    <input
                      type="range" min={0} max={1} step={0.01}
                      value={levels[i]}
                      onChange={e => setLevel(i, parseFloat(e.target.value))}
                      style={{ flex: 1, accentColor: "#8868D8" }}
                    />
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)", width: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {Math.round(levels[i] * 100)}
                    </span>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Honest about the half that is not built, where an operator will look for it. */}
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 }}>
        A slot is the listening path: decks D–F are heard <strong>only</strong> through a slot, at that
        slot's level, on the OUTPUT device chosen above. Nothing selected = silent. The board's channel
        and fader decide what airs — they never affect this, and this never affects air.
      </div>
    </div>
  );
}
