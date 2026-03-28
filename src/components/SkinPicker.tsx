/**
 * SkinPicker.tsx — Ether Theme Engine (revamped)
 *
 * Replaces the old 8-swatch right-click overlay with a full theme studio:
 *   - 8 named preset themes (Dark Studio, Bright Venue, Midnight, High Contrast,
 *     Crimson Air, Forest, Ocean Deep, Warm Broadcast)
 *   - Per-element color wheels organized into groups
 *   - Live preview — every change applies instantly via CSS variables
 *   - Saved to SQLite station_config_kv as JSON
 *   - Export / import JSON
 *
 * API (unchanged from old SkinPicker so App.tsx needs minimal edits):
 *   useSkin()           → { skinId, setSkin, openThemeEditor, themeEditorOpen, closeThemeEditor }
 *   AppContextMenu      → right-click menu (now says "Theme Studio" instead of "Change Skin")
 *   SkinPickerOverlay   → replaced by ThemeStudio modal (triggered same way)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { execute, query } from "../db/client";

// ─── CSS variable map ──────────────────────────────────────────

export interface ThemeVars {
  // Backgrounds
  "--bg-primary":    string;
  "--bg-secondary":  string;
  "--bg-tertiary":   string;
  "--bg-hover":      string;
  // Text
  "--text-primary":   string;
  "--text-secondary": string;
  "--text-tertiary":  string;
  // Borders
  "--border-primary":   string;
  "--border-secondary": string;
  // Accents
  "--accent-blue":  string;
  "--accent-green": string;
  "--accent-cyan":  string;
  "--accent-red":   string;
  "--accent-amber": string;
  // Waveform
  "--wave-played":   string;
  "--wave-unplayed": string;
  "--wave-playhead": string;
  // Decks
  "--deck-a": string;
  "--deck-b": string;
  "--deck-c": string;
}

// ─── Preset themes ─────────────────────────────────────────────

export interface Preset {
  id:    string;
  name:  string;
  emoji: string;
  vars:  ThemeVars;
}

export const PRESETS: Preset[] = [
  {
    id: "dark-studio", name: "Dark Studio", emoji: "🎙",
    vars: {
      "--bg-primary":    "#0f0f13",
      "--bg-secondary":  "#18181f",
      "--bg-tertiary":   "#212128",
      "--bg-hover":      "#2a2a35",
      "--text-primary":  "#f4f4f5",
      "--text-secondary":"#a1a1aa",
      "--text-tertiary": "#52525b",
      "--border-primary":  "#27272a",
      "--border-secondary":"#3f3f46",
      "--accent-blue":  "#0ea5e9",
      "--accent-green": "#34d399",
      "--accent-cyan":  "#22d3ee",
      "--accent-red":   "#ef4444",
      "--accent-amber": "#f59e0b",
      "--wave-played":   "#22d3ee",
      "--wave-unplayed": "#27272a",
      "--wave-playhead": "#ffffff",
      "--deck-a": "#0ea5e9",
      "--deck-b": "#34d399",
      "--deck-c": "#a78bfa",
    }
  },
  {
    id: "bright-venue", name: "Bright Venue", emoji: "🎪",
    vars: {
      "--bg-primary":    "#f8f8fc",
      "--bg-secondary":  "#ffffff",
      "--bg-tertiary":   "#f0f0f7",
      "--bg-hover":      "#e8e8f2",
      "--text-primary":  "#18181b",
      "--text-secondary":"#3f3f46",
      "--text-tertiary": "#a1a1aa",
      "--border-primary":  "#e4e4e7",
      "--border-secondary":"#d4d4d8",
      "--accent-blue":  "#2563eb",
      "--accent-green": "#16a34a",
      "--accent-cyan":  "#0891b2",
      "--accent-red":   "#dc2626",
      "--accent-amber": "#d97706",
      "--wave-played":   "#2563eb",
      "--wave-unplayed": "#e4e4e7",
      "--wave-playhead": "#18181b",
      "--deck-a": "#2563eb",
      "--deck-b": "#16a34a",
      "--deck-c": "#7c3aed",
    }
  },
  {
    id: "midnight", name: "Midnight", emoji: "🌙",
    vars: {
      "--bg-primary":    "#07071a",
      "--bg-secondary":  "#0d0d2b",
      "--bg-tertiary":   "#12123a",
      "--bg-hover":      "#1a1a4a",
      "--text-primary":  "#e2e2ff",
      "--text-secondary":"#9090c0",
      "--text-tertiary": "#50507a",
      "--border-primary":  "#1e1e50",
      "--border-secondary":"#2a2a60",
      "--accent-blue":  "#818cf8",
      "--accent-green": "#34d399",
      "--accent-cyan":  "#67e8f9",
      "--accent-red":   "#f87171",
      "--accent-amber": "#fbbf24",
      "--wave-played":   "#818cf8",
      "--wave-unplayed": "#1e1e50",
      "--wave-playhead": "#e2e2ff",
      "--deck-a": "#818cf8",
      "--deck-b": "#34d399",
      "--deck-c": "#f472b6",
    }
  },
  {
    id: "high-contrast", name: "High Contrast", emoji: "⚡",
    vars: {
      "--bg-primary":    "#000000",
      "--bg-secondary":  "#0a0a0a",
      "--bg-tertiary":   "#141414",
      "--bg-hover":      "#1e1e1e",
      "--text-primary":  "#ffffff",
      "--text-secondary":"#cccccc",
      "--text-tertiary": "#888888",
      "--border-primary":  "#333333",
      "--border-secondary":"#444444",
      "--accent-blue":  "#00aaff",
      "--accent-green": "#00ff88",
      "--accent-cyan":  "#00ffee",
      "--accent-red":   "#ff3333",
      "--accent-amber": "#ffcc00",
      "--wave-played":   "#00ffee",
      "--wave-unplayed": "#222222",
      "--wave-playhead": "#ffffff",
      "--deck-a": "#00aaff",
      "--deck-b": "#00ff88",
      "--deck-c": "#ff00cc",
    }
  },
  {
    id: "crimson-air", name: "Crimson Air", emoji: "🔴",
    vars: {
      "--bg-primary":    "#130608",
      "--bg-secondary":  "#1c090c",
      "--bg-tertiary":   "#260d10",
      "--bg-hover":      "#321115",
      "--text-primary":  "#fce4e4",
      "--text-secondary":"#d4a0a0",
      "--text-tertiary": "#8a5555",
      "--border-primary":  "#3d1515",
      "--border-secondary":"#521c1c",
      "--accent-blue":  "#f87171",
      "--accent-green": "#34d399",
      "--accent-cyan":  "#fca5a5",
      "--accent-red":   "#ef4444",
      "--accent-amber": "#fbbf24",
      "--wave-played":   "#ef4444",
      "--wave-unplayed": "#3d1515",
      "--wave-playhead": "#fce4e4",
      "--deck-a": "#ef4444",
      "--deck-b": "#34d399",
      "--deck-c": "#fb923c",
    }
  },
  {
    id: "forest", name: "Forest", emoji: "🌲",
    vars: {
      "--bg-primary":    "#080f09",
      "--bg-secondary":  "#0d160e",
      "--bg-tertiary":   "#121e13",
      "--bg-hover":      "#182618",
      "--text-primary":  "#e4f0e4",
      "--text-secondary":"#90b090",
      "--text-tertiary": "#506050",
      "--border-primary":  "#1e301e",
      "--border-secondary":"#2a402a",
      "--accent-blue":  "#4ade80",
      "--accent-green": "#22c55e",
      "--accent-cyan":  "#86efac",
      "--accent-red":   "#f87171",
      "--accent-amber": "#fbbf24",
      "--wave-played":   "#22c55e",
      "--wave-unplayed": "#1e301e",
      "--wave-playhead": "#e4f0e4",
      "--deck-a": "#4ade80",
      "--deck-b": "#22c55e",
      "--deck-c": "#a3e635",
    }
  },
  {
    id: "ocean-deep", name: "Ocean Deep", emoji: "🌊",
    vars: {
      "--bg-primary":    "#040d14",
      "--bg-secondary":  "#071520",
      "--bg-tertiary":   "#0c1e2e",
      "--bg-hover":      "#12283e",
      "--text-primary":  "#e0f2fe",
      "--text-secondary":"#7db8d8",
      "--text-tertiary": "#3d6880",
      "--border-primary":  "#0e2438",
      "--border-secondary":"#163348",
      "--accent-blue":  "#38bdf8",
      "--accent-green": "#34d399",
      "--accent-cyan":  "#67e8f9",
      "--accent-red":   "#f87171",
      "--accent-amber": "#fbbf24",
      "--wave-played":   "#38bdf8",
      "--wave-unplayed": "#0e2438",
      "--wave-playhead": "#e0f2fe",
      "--deck-a": "#38bdf8",
      "--deck-b": "#34d399",
      "--deck-c": "#818cf8",
    }
  },
  {
    id: "warm-broadcast", name: "Warm Broadcast", emoji: "📻",
    vars: {
      "--bg-primary":    "#12100a",
      "--bg-secondary":  "#1c180e",
      "--bg-tertiary":   "#252014",
      "--bg-hover":      "#2e281a",
      "--text-primary":  "#fef3c7",
      "--text-secondary":"#d4b896",
      "--text-tertiary": "#8a7050",
      "--border-primary":  "#3a3020",
      "--border-secondary":"#4a3e28",
      "--accent-blue":  "#fbbf24",
      "--accent-green": "#34d399",
      "--accent-cyan":  "#fde68a",
      "--accent-red":   "#f87171",
      "--accent-amber": "#f59e0b",
      "--wave-played":   "#f59e0b",
      "--wave-unplayed": "#3a3020",
      "--wave-playhead": "#fef3c7",
      "--deck-a": "#fbbf24",
      "--deck-b": "#34d399",
      "--deck-c": "#fb923c",
    }
  },
];

const DEFAULT_PRESET = PRESETS[0];

// ─── Variable injection ────────────────────────────────────────

function applyTheme(vars: ThemeVars) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
}

// ─── Persistence ───────────────────────────────────────────────

async function saveTheme(presetId: string, vars: ThemeVars) {
  try {
    await execute("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('theme_preset_id',?)", [presetId]);
    await execute("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('theme_custom_vars',?)", [JSON.stringify(vars)]);
  } catch {}
}

async function loadTheme(): Promise<{ presetId: string; vars: ThemeVars } | null> {
  try {
    const [pidRow, varsRow] = await Promise.all([
      query<{ value: string }>("SELECT value FROM station_config_kv WHERE key='theme_preset_id'"),
      query<{ value: string }>("SELECT value FROM station_config_kv WHERE key='theme_custom_vars'"),
    ]);
    if (!pidRow.length || !varsRow.length) return null;
    return { presetId: pidRow[0].value, vars: JSON.parse(varsRow[0].value) };
  } catch { return null; }
}

// ─── useSkin hook ──────────────────────────────────────────────

let _themeEditorOpen = false;
let _setThemeEditorOpen: ((v: boolean) => void) | null = null;

export function useSkin() {
  const [skinId, setSkinIdState]       = useState(DEFAULT_PRESET.id);
  const [editorOpen, setEditorOpen]    = useState(false);

  // Register setter so AppContextMenu can open the editor
  useEffect(() => {
    _setThemeEditorOpen = setEditorOpen;
    return () => { _setThemeEditorOpen = null; };
  }, []);

  // Load saved theme on mount
  useEffect(() => {
    loadTheme().then(saved => {
      if (saved) {
        setSkinIdState(saved.presetId);
        applyTheme(saved.vars);
      } else {
        applyTheme(DEFAULT_PRESET.vars);
      }
    });
  }, []);

  const setSkin = useCallback((id: string) => {
    const preset = PRESETS.find(p => p.id === id) || DEFAULT_PRESET;
    setSkinIdState(id);
    applyTheme(preset.vars);
    saveTheme(id, preset.vars);
  }, []);

  return {
    skinId,
    setSkin,
    themeEditorOpen: editorOpen,
    openThemeEditor: () => setEditorOpen(true),
    closeThemeEditor: () => setEditorOpen(false),
  };
}

// ─── Variable groups for the editor UI ────────────────────────

interface VarGroup {
  label:    string;
  emoji:    string;
  vars:     { key: keyof ThemeVars; label: string }[];
}

const VAR_GROUPS: VarGroup[] = [
  {
    label: "Backgrounds", emoji: "🎨",
    vars: [
      { key: "--bg-primary",   label: "Primary (main surface)" },
      { key: "--bg-secondary", label: "Secondary (panels, cards)" },
      { key: "--bg-tertiary",  label: "Tertiary (inputs, controls)" },
      { key: "--bg-hover",     label: "Hover state" },
    ]
  },
  {
    label: "Text", emoji: "✏️",
    vars: [
      { key: "--text-primary",   label: "Primary (headings)" },
      { key: "--text-secondary", label: "Secondary (body)" },
      { key: "--text-tertiary",  label: "Tertiary (muted/labels)" },
    ]
  },
  {
    label: "Borders", emoji: "▭",
    vars: [
      { key: "--border-primary",   label: "Primary borders" },
      { key: "--border-secondary", label: "Secondary borders" },
    ]
  },
  {
    label: "Accents", emoji: "⚡",
    vars: [
      { key: "--accent-blue",  label: "Blue (primary action)" },
      { key: "--accent-green", label: "Green (success / on-air)" },
      { key: "--accent-cyan",  label: "Cyan (highlight / links)" },
      { key: "--accent-red",   label: "Red (danger / live)" },
      { key: "--accent-amber", label: "Amber (warning)" },
    ]
  },
  {
    label: "Waveform", emoji: "〰️",
    vars: [
      { key: "--wave-played",   label: "Played region" },
      { key: "--wave-unplayed", label: "Unplayed region" },
      { key: "--wave-playhead", label: "Playhead line" },
    ]
  },
  {
    label: "Decks", emoji: "🎚",
    vars: [
      { key: "--deck-a", label: "Deck A color" },
      { key: "--deck-b", label: "Deck B color" },
      { key: "--deck-c", label: "Deck C color" },
    ]
  },
];

// ─── Color swatch row ─────────────────────────────────────────

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border-primary)" }}>
      {/* Color swatch — clicking opens the native color wheel */}
      <div
        onClick={() => inputRef.current?.click()}
        style={{
          width: 28, height: 28, borderRadius: 7, flexShrink: 0,
          background: value,
          border: "2px solid var(--border-secondary)",
          cursor: "pointer",
          boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
          transition: "transform 0.1s",
        }}
        onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "scale(0.9)"; }}
        onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
      />
      <input
        ref={inputRef}
        type="color"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }}
      />
      <span style={{ flex: 1, fontSize: 11, color: "var(--text-secondary)" }}>{label}</span>
      {/* Hex input */}
      <input
        type="text"
        value={value}
        onChange={e => {
          const v = e.target.value;
          if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange(v.length === 7 ? v : value);
        }}
        style={{
          width: 74, padding: "3px 7px", borderRadius: 6,
          background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
          color: "var(--text-primary)", fontSize: 11,
          fontFamily: "'DM Mono', monospace", outline: "none",
          letterSpacing: "0.04em",
        }}
      />
    </div>
  );
}

// ─── Theme Studio modal ────────────────────────────────────────

export function SkinPickerOverlay({
  currentSkin, onSelect, onClose,
}: {
  currentSkin: string;
  x?: number; y?: number;   // kept for API compat, ignored — now full modal
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [activePreset, setActivePreset] = useState<string>(currentSkin);
  const [vars, setVars]                 = useState<ThemeVars>(() => {
    return (PRESETS.find(p => p.id === currentSkin) || DEFAULT_PRESET).vars;
  });
  const [activeGroup, setActiveGroup]   = useState(0);
  const [saved, setSaved]               = useState(false);

  // Live preview on every change
  useEffect(() => { applyTheme(vars); }, [vars]);

  const selectPreset = (id: string) => {
    const preset = PRESETS.find(p => p.id === id)!;
    setActivePreset(id);
    setVars({ ...preset.vars });
  };

  const updateVar = (key: keyof ThemeVars, value: string) => {
    setVars(prev => ({ ...prev, [key]: value }));
    setActivePreset("custom");
  };

  const handleSave = async () => {
    await saveTheme(activePreset, vars);
    onSelect(activePreset);
    setSaved(true);
    setTimeout(() => { window.location.reload(); }, 900);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify({ presetId: activePreset, vars }, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `ether-theme-${activePreset}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const data = JSON.parse(e.target?.result as string);
          if (data.vars) { setVars(data.vars); setActivePreset(data.presetId || "custom"); }
        } catch {}
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const handleReset = () => {
    const preset = PRESETS.find(p => p.id === currentSkin) || DEFAULT_PRESET;
    setActivePreset(preset.id);
    setVars({ ...preset.vars });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.65)",
      backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: 780, maxHeight: "88vh",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-secondary)",
        borderRadius: 20,
        display: "flex", flexDirection: "column",
        boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
        overflow: "hidden",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}>

        {/* ── Header ── */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "18px 24px",
          borderBottom: "1px solid var(--border-primary)",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 20 }}>🎨</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Theme Studio</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 1 }}>Pick a preset or customize every color — changes preview live</div>
          </div>
          <div style={{ flex: 1 }} />
          {/* Action buttons */}
          <button onClick={handleImport} title="Import theme JSON" style={ghostBtn}>Import</button>
          <button onClick={handleExport} title="Export theme JSON" style={ghostBtn}>Export</button>
          <button onClick={handleReset} title="Reset to current preset" style={ghostBtn}>Reset</button>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: 8,
            background: "transparent", border: "1px solid var(--border-primary)",
            color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.12)"; (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          >✕</button>
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>

          {/* LEFT: presets + group nav */}
          <div style={{
            width: 220, flexShrink: 0,
            borderRight: "1px solid var(--border-primary)",
            display: "flex", flexDirection: "column",
            overflowY: "auto",
          }}>
            {/* Presets */}
            <div style={{ padding: "14px 14px 8px" }}>
              <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>Presets</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {PRESETS.map(p => (
                  <button key={p.id} onClick={() => selectPreset(p.id)} style={{
                    display: "flex", alignItems: "center", gap: 9,
                    padding: "8px 10px", borderRadius: 9, border: "none",
                    background: activePreset === p.id ? "var(--accent-cyan)" + "22" : "transparent",
                    outline: activePreset === p.id ? `1.5px solid var(--accent-cyan)` : "1px solid transparent",
                    color: activePreset === p.id ? "var(--accent-cyan)" : "var(--text-secondary)",
                    cursor: "pointer", textAlign: "left", width: "100%",
                    transition: "all 0.12s",
                  }}>
                    {/* Palette preview dots */}
                    <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                      {[p.vars["--bg-primary"], p.vars["--accent-cyan"], p.vars["--accent-blue"]].map((c, i) => (
                        <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: c, border: "1px solid rgba(255,255,255,0.1)" }} />
                      ))}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: activePreset === p.id ? 700 : 500 }}>{p.emoji} {p.name}</span>
                  </button>
                ))}
                {activePreset === "custom" && (
                  <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--accent-amber)", fontWeight: 700, letterSpacing: "0.06em" }}>✦ Custom</div>
                )}
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: "var(--border-primary)", margin: "4px 14px" }} />

            {/* Group navigation */}
            <div style={{ padding: "8px 14px 14px" }}>
              <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>Customize</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {VAR_GROUPS.map((g, i) => (
                  <button key={g.label} onClick={() => setActiveGroup(i)} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 10px", borderRadius: 8, border: "none",
                    background: activeGroup === i ? "var(--bg-hover)" : "transparent",
                    color: activeGroup === i ? "var(--text-primary)" : "var(--text-tertiary)",
                    cursor: "pointer", textAlign: "left", width: "100%",
                    fontSize: 11, fontWeight: activeGroup === i ? 700 : 400,
                    transition: "all 0.1s",
                  }}>
                    <span style={{ fontSize: 13 }}>{g.emoji}</span>
                    {g.label}
                    <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--text-tertiary)" }}>{g.vars.length}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT: color rows for active group */}
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.01em", marginBottom: 3 }}>
                {VAR_GROUPS[activeGroup].emoji} {VAR_GROUPS[activeGroup].label}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                Click any color swatch or type a hex value — the app updates live.
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column" }}>
              {VAR_GROUPS[activeGroup].vars.map(({ key, label }) => (
                <ColorRow
                  key={key}
                  label={label}
                  value={vars[key]}
                  onChange={v => updateVar(key, v)}
                />
              ))}
            </div>

            {/* Mini live preview strip */}
            <div style={{ marginTop: 28 }}>
              <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>Live Preview</div>
              <div style={{
                borderRadius: 12, overflow: "hidden",
                border: "1px solid var(--border-primary)",
                background: vars["--bg-primary"],
              }}>
                {/* Fake header */}
                <div style={{ height: 36, background: vars["--bg-secondary"], borderBottom: `1px solid ${vars["--border-primary"]}`, display: "flex", alignItems: "center", gap: 8, padding: "0 14px" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: vars["--accent-red"] }} />
                  <div style={{ width: 40, height: 6, borderRadius: 3, background: vars["--text-tertiary"], opacity: 0.4 }} />
                  <div style={{ flex: 1 }} />
                  <div style={{ width: 48, height: 20, borderRadius: 6, background: vars["--accent-cyan"], opacity: 0.9 }} />
                  <div style={{ width: 36, height: 20, borderRadius: 6, background: vars["--accent-red"] }} />
                </div>
                {/* Fake body */}
                <div style={{ padding: 14, display: "flex", gap: 10 }}>
                  {/* Fake deck */}
                  <div style={{ flex: 1, background: vars["--bg-secondary"], borderRadius: 10, border: `1px solid ${vars["--border-primary"]}`, padding: 12 }}>
                    <div style={{ width: 60, height: 5, borderRadius: 2, background: vars["--deck-a"], marginBottom: 8, opacity: 0.9 }} />
                    <div style={{ width: "100%", height: 4, borderRadius: 2, background: vars["--wave-unplayed"], marginBottom: 4, position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "45%", background: vars["--wave-played"], borderRadius: 2 }} />
                      <div style={{ position: "absolute", left: "45%", top: "-2px", bottom: "-2px", width: 2, background: vars["--wave-playhead"] }} />
                    </div>
                    <div style={{ width: 40, height: 4, borderRadius: 2, background: vars["--text-tertiary"], opacity: 0.3 }} />
                  </div>
                  {/* Fake deck B */}
                  <div style={{ flex: 1, background: vars["--bg-secondary"], borderRadius: 10, border: `1px solid ${vars["--border-primary"]}`, padding: 12 }}>
                    <div style={{ width: 60, height: 5, borderRadius: 2, background: vars["--deck-b"], marginBottom: 8, opacity: 0.9 }} />
                    <div style={{ width: "100%", height: 4, borderRadius: 2, background: vars["--wave-unplayed"], marginBottom: 4 }} />
                    <div style={{ width: 40, height: 4, borderRadius: 2, background: vars["--text-tertiary"], opacity: 0.3 }} />
                  </div>
                </div>
                {/* Fake footer */}
                <div style={{ height: 22, background: vars["--bg-secondary"], borderTop: `1px solid ${vars["--border-primary"]}`, display: "flex", alignItems: "center", gap: 8, padding: "0 14px" }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: vars["--accent-green"] }} />
                  <div style={{ width: 30, height: 4, borderRadius: 2, background: vars["--text-tertiary"], opacity: 0.4 }} />
                  <div style={{ flex: 1 }} />
                  <div style={{ width: 50, height: 4, borderRadius: 2, background: vars["--text-tertiary"], opacity: 0.3 }} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 24px",
          borderTop: "1px solid var(--border-primary)",
          background: "var(--bg-tertiary)",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", flex: 1 }}>
            {activePreset === "custom" ? "✦ Custom theme — save to apply permanently" : `Preset: ${PRESETS.find(p => p.id === activePreset)?.name || activePreset}`}
          </div>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={handleSave} style={{
            height: 36, padding: "0 24px", borderRadius: 9, border: "none",
            background: saved ? "var(--accent-green)" : "var(--accent-blue)",
            color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer",
            letterSpacing: "0.03em",
            boxShadow: saved ? "0 0 20px rgba(52,211,153,0.4)" : "0 2px 12px rgba(14,165,233,0.3)",
            transition: "all 0.2s",
          }}>
            {saved ? "✓ Saved!" : "Save & Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Right-click context menu ──────────────────────────────────

export function AppContextMenu({ x, y, onClose, onChangeSkin, onResetLayout }: {
  x: number; y: number;
  onClose: () => void;
  onChangeSkin: () => void;
  onResetLayout: () => void;
}) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9998 }} />
      <div style={{
        position: "fixed", left: x, top: y, zIndex: 9999,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-secondary)",
        borderRadius: 10, padding: 4, minWidth: 190,
        boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        fontFamily: "'Inter', sans-serif",
      }}>
        {[
          {
            label: "🎨 Theme Studio...",
            sub:   "Customize colors & presets",
            onClick: () => { onChangeSkin(); onClose(); },
          },
          null, // separator
          {
            label: "↺ Reset Layout",
            sub:   "Restore default widget layout",
            onClick: () => { onResetLayout(); onClose(); },
          },
        ].map((item, i) =>
          item === null ? (
            <div key={i} style={{ height: 1, background: "var(--border-primary)", margin: "3px 6px" }} />
          ) : (
            <button key={i} onClick={item.onClick} style={{
              display: "flex", flexDirection: "column", width: "100%",
              padding: "8px 12px", border: "none", borderRadius: 7,
              background: "transparent", cursor: "pointer", textAlign: "left",
              transition: "background 0.1s",
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600 }}>{item.label}</span>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>{item.sub}</span>
            </button>
          )
        )}
      </div>
    </>
  );
}

// ─── Shared button style ───────────────────────────────────────

const ghostBtn: React.CSSProperties = {
  height: 32, padding: "0 14px", borderRadius: 8,
  background: "var(--bg-tertiary)",
  border: "1px solid var(--border-primary)",
  color: "var(--text-secondary)",
  fontSize: 11, fontWeight: 600, cursor: "pointer",
  letterSpacing: "0.02em",
};

