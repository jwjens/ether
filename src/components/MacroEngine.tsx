// MacroEngine.tsx — Broadcast automation macros.
//
// A macro is a named sequence of actions (commands) that execute in order
// with optional delays between steps. Macros can be triggered by:
//   - Manual button press (in the Macros panel or cart wall)
//   - Hotkey (global keyboard shortcut)
//   - Clock event (fires at a specific time, checked every second)
//
// Actions map to the existing command dispatch system in App.tsx
// plus direct IPC calls for audio transport, streaming, etc.

import { useState, useEffect, useCallback, useRef } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation, getActiveStationIdSync } from "../hooks/useActiveStation";
import { getEngine } from "../audio/engine-registry";

// ── Types ─────────────────────────────────────────────────────

export interface MacroAction {
  type: "command" | "audio" | "wait" | "log";
  value: string;          // command string, IPC command, ms delay, or log message
  args?: any;             // optional args for IPC commands
}

export interface Macro {
  id: number;
  name: string;
  description: string | null;
  trigger_type: "manual" | "hotkey" | "clock";
  trigger_value: string | null;   // hotkey code or cron-like "HH:MM" for clock
  actions: MacroAction[];
  hotkey: string | null;
  is_active: number;
  color: string;
}

// ── Available actions for the builder ─────────────────────────

export const MACRO_ACTIONS: { category: string; actions: { label: string; type: MacroAction["type"]; value: string; args?: any }[] }[] = [
  {
    category: "Transport",
    actions: [
      { label: "Play Deck A",          type: "audio", value: "play",    args: { deck: "A" } },
      { label: "Play Deck B",          type: "audio", value: "play",    args: { deck: "B" } },
      { label: "Play Deck C",          type: "audio", value: "play",    args: { deck: "C" } },
      { label: "Stop Deck A",          type: "audio", value: "stop",    args: { deck: "A" } },
      { label: "Stop Deck B",          type: "audio", value: "stop",    args: { deck: "B" } },
      { label: "Stop Deck C",          type: "audio", value: "stop",    args: { deck: "C" } },
      { label: "Stop All Decks",       type: "command", value: "stop_all" },
      { label: "Crossfade A→B",        type: "command", value: "crossfade_ab" },
      { label: "Skip to Next",         type: "command", value: "skip" },
    ],
  },
  {
    category: "Automation",
    actions: [
      { label: "Enable Auto-Advance",  type: "command", value: "automation_on" },
      { label: "Disable Auto-Advance", type: "command", value: "automation_off" },
      { label: "Start Stream",         type: "command", value: "stream_start" },
      { label: "Stop Stream",          type: "command", value: "stream_stop" },
    ],
  },
  {
    category: "Timing",
    actions: [
      { label: "Wait 1 second",   type: "wait", value: "1000" },
      { label: "Wait 3 seconds",  type: "wait", value: "3000" },
      { label: "Wait 5 seconds",  type: "wait", value: "5000" },
      { label: "Wait 10 seconds", type: "wait", value: "10000" },
    ],
  },
  {
    category: "Logging",
    actions: [
      { label: "Log message",     type: "log", value: "Macro fired" },
    ],
  },
];

// ── Macro Executor ────────────────────────────────────────────

const ether = (window as any).ether;

export async function executeMacro(macro: Macro, dispatch?: (cmd: string) => void) {
  const engine = getEngine(getActiveStationIdSync());
  console.log(`[MACRO] ▶ ${macro.name} (${macro.actions.length} actions)`);
  for (const action of macro.actions) {
    switch (action.type) {
      case "command":
        if (dispatch) dispatch(action.value);
        else if (action.value === "stop_all") {
          await ether?.invoke?.("audio:stop", { deck: "A" });
          await ether?.invoke?.("audio:stop", { deck: "B" });
          await ether?.invoke?.("audio:stop", { deck: "C" });
        } else if (action.value === "crossfade_ab") {
          engine.crossfade("A", "B");
        } else if (action.value === "skip") {
          engine.getDeck("A")?.stop();
        } else if (action.value === "automation_on") {
          engine.autoAdvance = true;
        } else if (action.value === "automation_off") {
          engine.autoAdvance = false;
        } else if (action.value === "stream_start") {
          await ether?.invoke?.("stream_start_if_configured");
        } else if (action.value === "stream_stop") {
          await ether?.invoke?.("stream_stop");
        }
        break;
      case "audio":
        if (action.args?.deck) {
          await ether?.invoke?.(`audio:${action.value}`, action.args);
        }
        break;
      case "wait":
        await new Promise(r => setTimeout(r, parseInt(action.value) || 1000));
        break;
      case "log":
        console.log(`[MACRO] 📝 ${action.value}`);
        break;
    }
  }
  console.log(`[MACRO] ✓ ${macro.name} complete`);
}

// ── Clock Trigger Watcher ─────────────────────────────────────
// Hook that loads clock macros once (and on ether:macros-changed), then
// checks every second in pure JS — no DB hit on each tick.

export function useMacroClock(stationId: number, dispatch?: (cmd: string) => void) {
  const clockMacrosRef = useRef<Macro[]>([]);

  useEffect(() => {
    let lastFiredMinute = -1;

    const loadClockMacros = async () => {
      const rows = await queryScoped<any>(
        "SELECT * FROM macros WHERE trigger_type = 'clock' AND is_active = 1",
        [], stationId
      );
      clockMacrosRef.current = (rows || []).map((r: any) => ({ ...r, actions: JSON.parse(r.actions || "[]") }));
    };

    const check = () => {
      const now = new Date();
      const currentMinute = now.getHours() * 60 + now.getMinutes();
      if (currentMinute === lastFiredMinute) return;
      for (const m of clockMacrosRef.current) {
        if (!m.trigger_value) continue;
        const [hStr, mStr] = m.trigger_value.split(":");
        const targetMinute = (parseInt(hStr) || 0) * 60 + (parseInt(mStr) || 0);
        if (currentMinute === targetMinute) {
          lastFiredMinute = currentMinute;
          executeMacro(m, dispatch).catch(e => console.error("[MACRO] clock trigger error:", e));
        }
      }
    };

    loadClockMacros();
    window.addEventListener("ether:macros-changed", loadClockMacros);
    const interval = setInterval(check, 1000);
    return () => {
      window.removeEventListener("ether:macros-changed", loadClockMacros);
      clearInterval(interval);
    };
  }, [stationId, dispatch]);
}

// ── Hotkey Listener ───────────────────────────────────────────

export function useMacroHotkeys(dispatch?: (cmd: string) => void) {
  const macrosRef = useRef<Macro[]>([]);

  useEffect(() => {
    const loadMacros = async () => {
      const rows = await queryScoped<any>("SELECT * FROM macros WHERE hotkey IS NOT NULL AND is_active = 1", [], getActiveStationIdSync());
      macrosRef.current = (rows || []).map((r: any) => ({ ...r, actions: JSON.parse(r.actions || "[]") }));
    };
    loadMacros();
    window.addEventListener("ether:macros-changed", loadMacros);
    return () => window.removeEventListener("ether:macros-changed", loadMacros);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT") return;
      const macro = macrosRef.current.find(m => m.hotkey === e.code);
      if (macro) {
        e.preventDefault();
        executeMacro(macro, dispatch).catch(console.error);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);
}

// ── Macros Panel UI ───────────────────────────────────────────

export default function MacrosPanel() {
  const { stationId, isReady } = useActiveStation();
  const [macros, setMacros] = useState<Macro[]>([]);
  const [editing, setEditing] = useState<Macro | null>(null);
  const [running, setRunning] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!isReady) return;
    const rows = await queryScoped<any>("SELECT * FROM macros ORDER BY name", [], stationId);
    setMacros((rows || []).map((r: any) => ({ ...r, actions: JSON.parse(r.actions || "[]") })));
  }, [isReady, stationId]);
  useEffect(() => { load(); }, [load]);

  const run = async (m: Macro) => {
    setRunning(m.id);
    await executeMacro(m);
    setRunning(null);
  };

  const save = async (m: Macro) => {
    const actionsJson = JSON.stringify(m.actions);
    if (m.id) {
      await (window as any).ether.macros.updateById(m.id, { name: m.name, description: m.description, trigger_type: m.trigger_type, trigger_value: m.trigger_value, actions: actionsJson, hotkey: m.hotkey, is_active: m.is_active, color: m.color });
    } else {
      await (window as any).ether.macros.create({ station_id: stationId, name: m.name, description: m.description || null, trigger_type: m.trigger_type, trigger_value: m.trigger_value || null, actions: actionsJson, hotkey: m.hotkey || null, is_active: 1, color: m.color });
    }
    setEditing(null); load();
    window.dispatchEvent(new CustomEvent("ether:macros-changed"));
  };

  const deleteMacro = async (id: number) => {
    if (!confirm("Delete this macro?")) return;
    await (window as any).ether.macros.deleteById(id);
    load();
    window.dispatchEvent(new CustomEvent("ether:macros-changed"));
  };

  const newMacro = (): Macro => ({
    id: 0, name: "", description: null, trigger_type: "manual", trigger_value: null,
    actions: [], hotkey: null, is_active: 1, color: "var(--accent-blue)",
  });

  const inputStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", width: "100%" };
  const btnStyle: React.CSSProperties = { padding: "5px 12px", borderRadius: 0, fontSize: 10, fontWeight: 700, cursor: "pointer", border: "none", letterSpacing: "0.04em" };

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Macros</h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 0" }}>Compound automation actions — chain commands with delays, trigger by hotkey or clock</p>
        </div>
        <button onClick={() => setEditing(newMacro())} style={{ ...btnStyle, background: "var(--accent-blue)", color: "#fff", padding: "8px 16px", fontSize: 12 }}>+ New Macro</button>
      </div>

      {/* Macro list */}
      {macros.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 24px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No macros yet</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Create your first macro to automate transport, streaming, and timing sequences</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
          {macros.map(m => (
            <div key={m.id} style={{
              background: "var(--bg-secondary)", border: `1px solid ${running === m.id ? m.color : "var(--border-primary)"}`,
              padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8,
              boxShadow: running === m.id ? `0 0 12px ${m.color}40` : "none",
              transition: "all 0.2s",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 6, height: 6, background: m.is_active ? m.color : "#333", flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", flex: 1 }}>{m.name}</span>
                {m.hotkey && <span style={{ fontSize: 8, fontWeight: 700, padding: "2px 6px", background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)" }}>{m.hotkey}</span>}
              </div>
              {m.description && <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{m.description}</div>}
              <div style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
                {m.actions.length} action{m.actions.length !== 1 ? "s" : ""} · {m.trigger_type === "clock" ? `⏰ ${m.trigger_value}` : m.trigger_type === "hotkey" ? `⌨ ${m.hotkey}` : "Manual"}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                <button onClick={() => run(m)} disabled={running === m.id} style={{ ...btnStyle, flex: 1, background: m.color, color: "#000", opacity: running === m.id ? 0.6 : 1 }}>
                  {running === m.id ? "Running..." : "▶ Run"}
                </button>
                <button onClick={() => setEditing({ ...m })} style={{ ...btnStyle, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>Edit</button>
                <button onClick={() => deleteMacro(m.id)} style={{ ...btnStyle, background: "rgba(239,68,68,0.1)", color: "var(--accent-red)", border: "1px solid rgba(239,68,68,0.2)" }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editing && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setEditing(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 20, width: 520, maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 16 }}>{editing.id ? "Edit Macro" : "New Macro"}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="Macro name" style={inputStyle} />
              <input value={editing.description || ""} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder="Description (optional)" style={inputStyle} />
              <div style={{ display: "flex", gap: 8 }}>
                <select value={editing.trigger_type} onChange={e => setEditing({ ...editing, trigger_type: e.target.value as any })} style={{ ...inputStyle, flex: 1, colorScheme: "dark" }}>
                  <option value="manual">Manual (button/API)</option>
                  <option value="hotkey">Hotkey</option>
                  <option value="clock">Clock (time-based)</option>
                </select>
                {editing.trigger_type === "hotkey" && (
                  <input value={editing.hotkey || ""} onChange={e => setEditing({ ...editing, hotkey: e.target.value })}
                    placeholder="Key code (e.g. F9)" style={{ ...inputStyle, flex: 1 }}
                    onKeyDown={e => { e.preventDefault(); setEditing({ ...editing, hotkey: e.code }); }} />
                )}
                {editing.trigger_type === "clock" && (
                  <input type="time" value={editing.trigger_value || ""} onChange={e => setEditing({ ...editing, trigger_value: e.target.value })} style={{ ...inputStyle, flex: 1, colorScheme: "dark" }} />
                )}
              </div>

              {/* Actions list */}
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", marginTop: 8 }}>ACTIONS ({editing.actions.length})</div>
              {editing.actions.map((a, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
                  <span style={{ fontSize: 9, color: "var(--text-tertiary)", width: 16, textAlign: "center" }}>{i + 1}</span>
                  <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 5px", background: a.type === "wait" ? "rgba(251,191,36,0.15)" : a.type === "log" ? "rgb(from var(--accent-blue) r g b / 0.15)" : "rgba(52,211,153,0.15)", color: a.type === "wait" ? "var(--accent-amber)" : a.type === "log" ? "var(--accent-blue)" : "var(--accent-green)" }}>
                    {a.type.toUpperCase()}
                  </span>
                  <span style={{ flex: 1, fontSize: 11, color: "var(--text-primary)" }}>
                    {a.type === "wait" ? `Wait ${parseInt(a.value) / 1000}s` : a.type === "audio" ? `${a.value} Deck ${a.args?.deck}` : a.value}
                  </span>
                  <button onClick={() => { const next = [...editing.actions]; next.splice(i, 1); setEditing({ ...editing, actions: next }); }}
                    style={{ fontSize: 9, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>✕</button>
                </div>
              ))}

              {/* Add action */}
              <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", marginTop: 4 }}>ADD ACTION</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {MACRO_ACTIONS.map(cat => (
                  cat.actions.map(a => (
                    <button key={`${cat.category}-${a.label}`}
                      onClick={() => setEditing({ ...editing, actions: [...editing.actions, { type: a.type, value: a.value, args: a.args }] })}
                      style={{ padding: "3px 8px", borderRadius: 0, fontSize: 9, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>
                      {a.label}
                    </button>
                  ))
                ))}
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button onClick={() => save(editing)} disabled={!editing.name.trim()} style={{ ...btnStyle, flex: 1, background: "var(--accent-blue)", color: "#fff", fontSize: 12, padding: "8px", opacity: editing.name.trim() ? 1 : 0.4 }}>
                  {editing.id ? "Save Changes" : "Create Macro"}
                </button>
                <button onClick={() => setEditing(null)} style={{ ...btnStyle, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", fontSize: 12, padding: "8px" }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
