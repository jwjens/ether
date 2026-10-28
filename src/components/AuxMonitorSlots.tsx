// AuxMonitorSlots — the local listening path for every aux deck. Jeff's design, 2026-08-18;
// rebuilt 2026-09-02 from three fixed slots to one row per deck.
//
// WHAT CHANGED AND WHY. It used to be THREE slots, each a dropdown that picked one of D/E/F. Decks
// are dynamic — added and removed at any time, and stations already run up to nine — so every deck
// past F was unmonitorable: there was no slot to put it in and no dropdown entry to pick it. The
// slot was an artefact of a three-deck world, not a thing an operator wants. So there are no slots
// now: every aux deck gets a row, rows appear when a deck is added and vanish when it is removed,
// and the row IS the monitor.
//
// THE INVARIANT, UNCHANGED AND RE-AUDITED AT THE MIXER (native/src/audio.rs, the per-deck mix):
//
//     mix_l[f] += lv;                      // AIR — every slot, unchanged. `lv` is fader x cut.
//     if !is_aux { core_l[f] += lv; ... }   // ROOM base — aux decks excluded
//     let mon = if is_aux { aux_gain[i] } else { 0.0 };   // the MONITOR level: ROOM only
//
// `mon` never enters mix_* . The monitor level cannot put a deck on air and cannot take it off:
// air is the board's channel switch and fader, full stop. What this panel decides is whether, and
// how loudly, an aux deck is heard IN THE ROOM.
//
//     ROW = ROOM.   BOARD = AIR.   Two gates, two destinations.
//
// The engine already stores monitor gain PER DECK INDEX (bus.aux_monitor_gain[idx], audio.rs:1726),
// so one row per deck is what the engine was always shaped for — this is the UI catching up.
//
// LEVELS PERSIST PER DECK ID, never per row position. The old format was a positional array under
// aux_monitor_levels, so removing a deck shifted every level below it onto the wrong deck. It is a
// map now, keyed by slot id, and the old array is migrated through the old slots array (which said
// which deck each position held) so nobody's levels move on upgrade.
//
// ── WHERE THE NUMBERS AND THE AUDIO COME FROM (all real, none synthesised) ───────────────────────
//   • the ROOM feed  ← native aux monitor bus: the mixer builds the room from the non-aux slots plus
//                      Σ(aux deck x its monitor level), POST-FADER and POST-CUT
//                      (native/src/audio.rs; design: docs/aux-monitor-bus-design-2026-08-18.md)
//   • MONITOR level  → audio_set_aux_monitor(stationId, deck, gain); 0 = silent in the room
//   • VU             ← decks[].peak on the existing `audio:levels` broadcast
//   • position       ← decks[].frames_played / 44100 (the sample clock, not a wall-clock guess)
//   • title/status   ← ether.audio.getState(stationId), polled
//   • which decks    ← deck_configs for the active station, polled so add/remove needs no restart
//
// STILL NOT BUILT, deliberately: a per-deck OUTPUT DEVICE. Rust runs one output stream per station,
// so a deck cannot be sent to a different device than the station's own. The room is one room, and
// the single OUTPUT selector at the top is the whole aux path's device.

import HFader from "./HFader";
import { posToGain, gainToPos, formatDb, faderMarks, MAX_GAIN } from "../lib/faderLaw";
import { useFaderTop } from "../lib/useFaderTop";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { matchesStation } from "../lib/levelsScope";
import { sourceKindMeta, isSweeperKind, compareSlots } from "./DeckConfigurator";
import { boardName } from "../lib/boardName";
import PatchBayPointer from "./PatchBayPointer";

const MAIN_DECKS = ["A", "B", "C"];        // the main faders — they have their own strips and monitoring
const KEY = "aux_monitor_slots";            // legacy positional slot->deck map; read once, to migrate
const LVL_KEY = "aux_monitor_levels";
const DEV_KEY = "aux_monitor_device";
const DEFAULT_LEVEL = 0.8;
const PROGRAM_RATE = 44100;   // DeckTel.frames_played is in PROGRAM_RATE frames (native/src/audio.rs)

interface DeckTel { id: string; source_present: boolean; active: boolean; paused: boolean; volume: number; peak?: number; frames_played?: number; }
interface AuxDeck { slot: string; letter: string; source: string; kind: string; }

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
  const auxTop = useFaderTop("aux");   // the AUX-row group's top (Preferences)
  const { stationId, stationUuid } = useActiveStation();
  const [auxDecks, setAuxDecks] = useState<AuxDeck[]>([]);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDevice] = useState<string>("");   // "" = none = the aux bus is silent
  const [tel, setTel] = useState<Record<string, DeckTel>>({});
  const [info, setInfo] = useState<Record<string, any>>({});
  const uuidRef = useRef(stationUuid);
  uuidRef.current = stationUuid;

  /** The ROOM level for one aux deck. 0 = silent on the local speakers. Never air. */
  const applyGain = useCallback(async (deck: string, gain: number) => {
    if (stationId == null) return;
    // A CHANGE only. Never swallowed: main queues a send the engine could not take and applies it on connect
    // (electron/board-sync.js); a failure that still reaches here is said.
    try { const r = await (window as any).ether.audio.setAuxMonitor(stationId, deck, gain); if (r === false) console.warn(`[aux-monitor] ${deck} room level ${gain} not taken by the engine yet — queued by main`); }
    catch (e) { console.warn(`[aux-monitor] ${deck} room level ${gain} not sent:`, e); }
  }, [stationId]);

  // ── WHICH DECKS. Derived live from deck_configs: every enabled deck that is not a main fader.
  // Polled rather than event-driven so adding or removing a deck needs no restart and no new IPC
  // channel; this is a monitor panel, not the playout path, so a 2s beat is the right cost.
  useEffect(() => {
    if (stationId == null) { setAuxDecks([]); return; }
    let stop = false;
    const pull = async () => {
      try {
        const r: any = await (window as any).ether.deckConfigs.list(stationId);
        const rows: any[] = (r && r.rows) || [];
        // FADERS ARE GENERIC (2026-10-11): a fader has a row here when ITS local output is AUX — not by its letter.
        let routing: Record<string, { local?: string }> = {};
        try { routing = (await (window as any).ether?.invoke?.("board:routing", stationId)) || {}; } catch { routing = {}; }
        const onAux = (slot: string) => routing[slot] ? routing[slot].local === "aux" : !MAIN_DECKS.includes(slot);
        // ONE NAME PER FADER — each row is named by its board letter, from this board's own order (src/lib/boardName.ts).
        const order = [...rows].filter(c => c && c.slot).sort(compareSlots).map(c => String(c.slot));
        const next: AuxDeck[] = rows
          // EVERY AUX DECK GETS A ROW. One row per deck, whatever is dialled into it — including
          // nothing. A row that disappears when a source is selected is not "treated the same"; it
          // is the panel changing shape under the operator (Jeff, 2026-09-03).
          .filter(c => c && c.slot && c.enabled !== 0 && c.enabled !== false && onAux(String(c.slot)))
          .map(c => {
            const slot = String(c.slot);
            // The name the operator gave it wins; otherwise what is patched in; otherwise the type.
            const kindLabel = c.kind ? (sourceKindMeta(c.kind)?.label || String(c.kind)) : "";
            return { slot, letter: boardName(slot, order), kind: String(c.kind || ""),
                     source: String(c.label || kindLabel || c.type || "unpatched") };
          })
          .sort((a, b) => a.letter.localeCompare(b.letter));
        if (!stop) setAuxDecks(next);
      } catch { /* deck configs unreadable — the panel shows its empty state */ }
    };
    void pull();
    const t = setInterval(pull, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [stationId]);

  // SLICE 7 — a Take writes the room levels (aux_monitor_levels) and has already set them in the engine; the panel
  // re-reads the store so it shows what is running (docs/dsp-show-presets.md).
  const [showTick, setShowTick] = useState(0);
  useEffect(() => {
    const show = (window as any).ether?.show;
    const h = show?.onApplied?.((m: any) => { if (!m?.stationUuid || m.stationUuid === uuidRef.current) setShowTick(t => t + 1); });
    return () => { if (h) show.offApplied?.(h); };
  }, []);

  // ── Levels + output device: load, migrate, and assert downward ───────────────────────────────
  useEffect(() => {
    if (stationId == null) return;
    let stop = false;
    (async () => {
      try {
        const r: any = await (window as any).ether.stationConfigKv.list(stationId);
        const rows = (r && r.rows) || [];
        const rawLvl = rows.find((x: any) => x.key === LVL_KEY)?.value;
        let map: Record<string, number> = {};
        try {
          const parsed = rawLvl ? JSON.parse(rawLvl) : null;
          if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
            // Current format — a map keyed by deck slot id.
            for (const [k, v] of Object.entries(parsed)) {
              const n = parseFloat(String(v));
              if (Number.isFinite(n)) map[k] = Math.max(0, Math.min(MAX_GAIN, n));
            }
          } else if (Array.isArray(parsed)) {
            // LEGACY positional array. The old slots array says which deck held each position, so the
            // migration is exact: nobody's level moves. A deck that was in NO slot was silent in the
            // room, and stays silent (0) rather than being switched on by an upgrade.
            const rawSlots = rows.find((x: any) => x.key === KEY)?.value;
            const oldSlots: string[] = rawSlots ? (JSON.parse(rawSlots) || []) : [];
            oldSlots.forEach((deck: string, i: number) => {
              if (!deck) return;
              const n = parseFloat(String(parsed[i]));
              map[deck] = Number.isFinite(n) ? Math.max(0, Math.min(MAX_GAIN, n)) : DEFAULT_LEVEL;
            });
          }
        } catch { map = {}; }
        if (stop) return;
        setLevels(map);

        const dev = String(rows.find((x: any) => x.key === DEV_KEY)?.value ?? "");
        setDevice(dev);
        // No push here: the saved device is the engine's from its start (audiod/board-state.js). The panel only READS it.
        try {
          const list = await (window as any).ether.audio.listOutputDevices();
          if (!stop && Array.isArray(list)) setDevices(list);
        } catch { /* device list unavailable */ }
      } catch { /* config unreadable — defaults stand */ }
    })();
    return () => { stop = true; };
  }, [stationId, showTick]);

  // NO ASSERT ON MOUNT (2026-10-11, docs/board-state-on-connect-diagnosis-2026-10-11.md). This panel used to send every
  // saved row once per mount and drop a failure; when the app started on its in-process fallback those sends never
  // reached the daemon, and every Source fader was silent in the room. The engine now restores the saved rows itself
  // (audiod/board-state.js), and this panel sends CHANGES only.


  const setLevel = useCallback((slot: string, v: number) => {
    setLevels(prev => {
      const next = { ...prev, [slot]: v };
      void applyGain(slot, v);
      if (stationId != null) {
        // Keyed by deck id, so adding, removing or reordering decks never moves another deck's level.
        try { (window as any).ether.stationConfigKv.upsertByKey(stationId, LVL_KEY, JSON.stringify(next)); }
        catch { /* non-fatal */ }
      }
      return next;
    });
  }, [stationId, applyGain]);

  // ── VU + position: the existing levels broadcast, station-scoped like every other strip ─────────
  const auxSlots = useMemo(() => auxDecks.map(d => d.slot), [auxDecks]);
  const auxSlotsRef = useRef(auxSlots);
  auxSlotsRef.current = auxSlots;
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.audio?.onLevels) return;
    const h = ether.audio.onLevels((lvl: any) => {
      // The WHOLE frame, not lvl.stationUuid — matchesStation reads `.stationUuid` off its first
      // argument, so passing the string makes it undefined, which returns true for every frame and
      // silently disables station scoping (this panel would meter another station's audio).
      if (!matchesStation(lvl, uuidRef.current)) return;
      const decks: DeckTel[] = Array.isArray(lvl?.decks) ? lvl.decks : [];
      if (!decks.length) return;
      const want = auxSlotsRef.current;
      const next: Record<string, DeckTel> = {};
      for (const d of decks) if (want.includes(d.id)) next[d.id] = d;
      setTel(next);
    });
    return () => ether.audio.offLevels?.(h);
  }, []);

  // ── What is loaded on each aux deck. Polled: this is a monitor panel, not the playout path. ─────
  const watched = auxSlots.join(",");
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
      } catch { /* engine not up — the row shows its idle state */ }
    };
    void pull();
    const t = setInterval(pull, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [stationId, watched]);

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-primary)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" }}>
          Aux Monitors
        </span>
        <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
          {auxDecks.length ? `${auxDecks.length} deck${auxDecks.length === 1 ? "" : "s"}` : "no aux decks"}
        </span>
      </div>

      {/* OUTPUT — where the aux bus is heard, for the WHOLE aux path. Same grammar as each station
          monitor's OUTPUT picker. Nothing selected = the engine opens no aux stream at all =
          silence. A device is never chosen for the operator; on a broadcast machine the "default"
          could be anything. */}
      {/* The AUX device is patched in the Patch Bay (Jeff's Outputs answer 3: "AUX moves into Outputs"). The aux rows and
          their levels below are unchanged. */}
      <div style={{ marginBottom: 8 }}><PatchBayPointer stationId={stationId} row="aux" label="Output" /></div>
      {!device && auxDecks.length > 0 && (
        <div style={{ fontSize: 10, color: "#a06030", marginBottom: 8, lineHeight: 1.5 }}>
          No output selected — the aux decks are silent everywhere. Pick the speakers or headphones you
          monitor on.
        </div>
      )}

      {auxDecks.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.5, padding: "2px 0 6px" }}>
          This station has no aux decks. Add one in DECKS and it appears here — a row per deck, no
          restart.
        </div>
      ) : (
        // Many decks must fit: rows are compact and the list scrolls inside the sidebar.
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 320, overflowY: "auto", overflowX: "hidden" }}>
          {auxDecks.map(d => {
            const t = tel[d.slot];
            const nfo = info[d.slot];
            const playing = nfo?.status === "playing";
            const peak = Math.max(0, Math.min(1, t?.peak ?? 0));
            const lvl = levels[d.slot] ?? 0;

            return (
              <div key={d.slot} style={{
                border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", padding: "5px 7px",
              }}>
                {/* Line 1 — who this is, what state it is in, how far through. */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "0.06em" }}>
                    {d.letter}
                  </span>
                  <span style={{
                    fontSize: 10, color: "var(--text-tertiary)", flex: 1, minWidth: 0,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>· {d.source}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 900, letterSpacing: "0.1em", padding: "1px 4px",
                    color: playing ? "#4ade80" : "var(--text-tertiary)",
                    border: `1px solid ${playing ? "#4ade8055" : "var(--border-primary)"}`,
                  }}>{playing ? "PLAYING" : (nfo?.status || "idle").toUpperCase()}</span>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
                    {fmtPos(t?.frames_played ?? 0)}
                  </span>
                </div>

                {/* Line 2 — what is on it. */}
                <div style={{
                  fontSize: 11, color: "var(--text-primary)", marginTop: 3,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {nfo?.title || <span style={{ color: "var(--text-tertiary)" }}>nothing loaded</span>}
                  {nfo?.artist ? <span style={{ color: "var(--text-tertiary)" }}> — {nfo.artist}</span> : null}
                </div>

                {/* VU — decks[].peak, the same post-fader number the A/B/C meters use. */}
                <div style={{ height: 5, background: "var(--bg-primary)", border: "1px solid var(--border-primary)", marginTop: 4, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${Math.round(peak * 100)}%`,
                    background: peak > 0.89 ? "#ef4444" : peak > 0.7 ? "#fbbf24" : "#4ade80",
                    transition: "width 80ms linear",
                  }} />
                </div>

                {/* Line 3 — MONITOR level: the ROOM, not air. */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 9, color: "#8868D8", letterSpacing: "0.08em", width: 52, fontWeight: 700 }}>MONITOR</span>
                  {/* THE ONE CONSOLE LAW (src/lib/faderLaw.ts), handled like every fader (useFaderControl, 2026-10-13). */}
                  <div style={{ flex: 1 }}>
                    <HFader gain={lvl} topDb={auxTop} onChange={g => setLevel(d.slot, g)} color="#8868D8"
                      valueStyle={{ fontSize: 10, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 }}>
        One row per aux deck. A deck is heard in the room <strong>only</strong> through its row, at
        that row's MONITOR level, on the OUTPUT device chosen above — 0 is silent. The board's channel
        and fader decide what airs; they never affect this, and this never affects air.
      </div>
    </div>
  );
}
