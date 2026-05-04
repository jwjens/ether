/**
 * SkinPicker.tsx — Ether Theme Engine
 *
 * Full theme studio with:
 *   - 8 named preset themes with miniature UI preview cards
 *   - Tier system: Presets → Tuning → Station Identity
 *   - Font selection (6 system-safe typefaces via --font-ui CSS var)
 *   - Per-operator theme override stored in operators.theme column
 *   - Station logo upload (base64 in station_config_kv)
 *   - Export / import .ethertheme files via native file dialogs
 *   - Live preview — every change applies instantly via CSS variables
 *   - Saved to SQLite station_config_kv as JSON
 *
 * API (unchanged so App.tsx needs no edits):
 *   useSkin()           → { skinId, setSkin, openThemeEditor, themeEditorOpen, closeThemeEditor }
 *   AppContextMenu      → right-click menu ("Theme Studio")
 *   SkinPickerOverlay   → ThemeStudio modal
 */

import { useState, useEffect, useCallback, useRef } from "react";

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

// ─── Font options ──────────────────────────────────────────────

export interface FontOption {
  id:    string;
  label: string;
  stack: string; // CSS font-family value
}

export const FONT_OPTIONS: FontOption[] = [
  { id: "system",    label: "System Default",   stack: "system-ui, sans-serif" },
  { id: "inter",     label: "Inter",             stack: "'Inter', system-ui, sans-serif" },
  { id: "segoe",     label: "Segoe UI",          stack: "'Segoe UI', system-ui, sans-serif" },
  { id: "georgia",   label: "Broadcast Serif",   stack: "Georgia, 'Times New Roman', serif" },
  { id: "trebuchet",        label: "Trebuchet MS",       stack: "'Trebuchet MS', system-ui, sans-serif" },
  { id: "mono",             label: "Tech Mono",          stack: "'Courier New', 'Consolas', monospace" },
  { id: "rajdhani",         label: "Rajdhani",           stack: "'Rajdhani', sans-serif" },
  { id: "barlow-condensed", label: "Barlow Condensed",   stack: "'Barlow Condensed', sans-serif" },
];

// ─── Preset themes ─────────────────────────────────────────────

export interface Preset {
  id:    string;
  name:  string;
  emoji: string;
  vars:  ThemeVars;
}

export const PRESETS: Preset[] = [
  {
    id: "ether-default",
    name: "Ether",
    emoji: "🎚",
    vars: {
      "--bg-primary":    "#b8bcc4",
      "--bg-secondary":  "#c8ccd4",
      "--bg-tertiary":   "#d4d8e0",
      "--bg-hover":      "#dde2e8",
      "--text-primary":   "#1a1d24",
      "--text-secondary": "#3c4452",
      "--text-tertiary":  "#5a6370",
      "--border-primary":   "#9ca0a8",
      "--border-secondary": "#b0b4bc",
      "--accent-blue":  "#1e6bb8",
      "--accent-green": "#1a9048",
      "--accent-cyan":  "#0e8aaa",
      "--accent-red":   "#c82535",
      "--accent-amber": "#c87815",
      "--wave-played":   "#0e8aaa",
      "--wave-unplayed": "#b0b4bc",
      "--wave-playhead": "#c87815",
      "--deck-a": "#0e8aaa",
      "--deck-b": "#8060d8",
      "--deck-c": "#c87815",
    }
  },
  {
    id: "newyork", name: "New York", emoji: "🗽",
    vars: {
      "--bg-primary": "#0a1428", "--bg-secondary": "#0f1d3d",
      "--bg-tertiary": "#152952", "--bg-hover": "#1d3568",
      "--text-primary": "#f0f2f5", "--text-secondary": "#9aa6b8",
      "--text-tertiary": "#6b7385",
      "--border-primary": "#0a1428", "--border-secondary": "#152952",
      "--accent-blue": "#006BB6", "--accent-green": "#4ade80",
      "--accent-cyan": "#22d3ee", "--accent-red": "#F58426",
      "--accent-amber": "#F58426",
      "--wave-played": "#F58426", "--wave-unplayed": "#152952",
      "--wave-playhead": "#006BB6",
      "--deck-a": "#F58426", "--deck-b": "#006BB6", "--deck-c": "#FFFFFF",
    }
  },
  {
    id: "losangeles", name: "Los Angeles", emoji: "🌴",
    vars: {
      "--bg-primary": "#0e0820", "--bg-secondary": "#1a0e35",
      "--bg-tertiary": "#28154d", "--bg-hover": "#341c63",
      "--text-primary": "#f0f2f5", "--text-secondary": "#b8a8c8",
      "--text-tertiary": "#7a6e8a",
      "--border-primary": "#0e0820", "--border-secondary": "#28154d",
      "--accent-blue": "#552583", "--accent-green": "#4ade80",
      "--accent-cyan": "#22d3ee", "--accent-red": "#FDB927",
      "--accent-amber": "#FDB927",
      "--wave-played": "#FDB927", "--wave-unplayed": "#28154d",
      "--wave-playhead": "#552583",
      "--deck-a": "#FDB927", "--deck-b": "#552583", "--deck-c": "#FFFFFF",
    }
  },
  {
    id: "chicago", name: "Chicago", emoji: "🌬",
    vars: {
      "--bg-primary": "#0a0a0a", "--bg-secondary": "#1a0a0a",
      "--bg-tertiary": "#2a1010", "--bg-hover": "#3a1818",
      "--text-primary": "#f0f2f5", "--text-secondary": "#c8a0a0",
      "--text-tertiary": "#7a5050",
      "--border-primary": "#0a0a0a", "--border-secondary": "#2a1010",
      "--accent-blue": "#5b9eff", "--accent-green": "#4ade80",
      "--accent-cyan": "#22d3ee", "--accent-red": "#CE1141",
      "--accent-amber": "#f59e0b",
      "--wave-played": "#CE1141", "--wave-unplayed": "#2a1010",
      "--wave-playhead": "#FFFFFF",
      "--deck-a": "#CE1141", "--deck-b": "#FFFFFF", "--deck-c": "#000000",
    }
  },
  {
    id: "atlanta", name: "Atlanta", emoji: "🦅",
    vars: {
      "--bg-primary": "#0a0d08", "--bg-secondary": "#15180e",
      "--bg-tertiary": "#1f2415", "--bg-hover": "#2c321c",
      "--text-primary": "#f0f2f5", "--text-secondary": "#a8b89a",
      "--text-tertiary": "#6e7a6b",
      "--border-primary": "#0a0d08", "--border-secondary": "#1f2415",
      "--accent-blue": "#5b9eff", "--accent-green": "#C1D32F",
      "--accent-cyan": "#22d3ee", "--accent-red": "#E03A3E",
      "--accent-amber": "#C1D32F",
      "--wave-played": "#C1D32F", "--wave-unplayed": "#1f2415",
      "--wave-playhead": "#E03A3E",
      "--deck-a": "#E03A3E", "--deck-b": "#C1D32F", "--deck-c": "#26282A",
    }
  },
  {
    id: "dallas", name: "Dallas", emoji: "🤠",
    vars: {
      "--bg-primary": "#06101e", "--bg-secondary": "#0a1a30",
      "--bg-tertiary": "#0f2545", "--bg-hover": "#163058",
      "--text-primary": "#f0f2f5", "--text-secondary": "#a0b0c0",
      "--text-tertiary": "#6b7585",
      "--border-primary": "#06101e", "--border-secondary": "#0f2545",
      "--accent-blue": "#00538C", "--accent-green": "#4ade80",
      "--accent-cyan": "#22d3ee", "--accent-red": "#ef4444",
      "--accent-amber": "#f59e0b",
      "--wave-played": "#00538C", "--wave-unplayed": "#0f2545",
      "--wave-playhead": "#B8C4CA",
      "--deck-a": "#00538C", "--deck-b": "#B8C4CA", "--deck-c": "#002B5E",
    }
  },
  {
    id: "toronto", name: "Toronto", emoji: "🍁",
    vars: {
      "--bg-primary": "#0a0a0a", "--bg-secondary": "#1a0e0e",
      "--bg-tertiary": "#241414", "--bg-hover": "#321c1c",
      "--text-primary": "#f0f2f5", "--text-secondary": "#b8a8a8",
      "--text-tertiary": "#7a5e5e",
      "--border-primary": "#0a0a0a", "--border-secondary": "#241414",
      "--accent-blue": "#5b9eff", "--accent-green": "#4ade80",
      "--accent-cyan": "#22d3ee", "--accent-red": "#CE1141",
      "--accent-amber": "#f59e0b",
      "--wave-played": "#CE1141", "--wave-unplayed": "#241414",
      "--wave-playhead": "#A1A1A4",
      "--deck-a": "#CE1141", "--deck-b": "#A1A1A4", "--deck-c": "#000000",
    }
  },
  {
    id: "miami", name: "Miami", emoji: "🌊",
    vars: {
      "--bg-primary": "#082d48", "--bg-secondary": "#0d4268",
      "--bg-tertiary": "#124e7a", "--bg-hover": "#185e8e",
      "--text-primary": "#f0f2f5", "--text-secondary": "#a8d0e8",
      "--text-tertiary": "#6a9ab8",
      "--border-primary": "#082d48", "--border-secondary": "#124e7a",
      "--accent-blue": "#00A8E0", "--accent-green": "#4ade80",
      "--accent-cyan": "#00A8E0", "--accent-red": "#FF1493",
      "--accent-amber": "#FFD400",
      "--wave-played": "#00A8E0", "--wave-unplayed": "#051b30",
      "--wave-playhead": "#FF1493",
      "--deck-a": "#00A8E0", "--deck-b": "#FF1493", "--deck-c": "#FFD400",
    }
  },
  {
    id: "seattle", name: "Seattle", emoji: "☕",
    vars: {
      "--bg-primary": "#04140e", "--bg-secondary": "#0a2218",
      "--bg-tertiary": "#0e3024", "--bg-hover": "#154030",
      "--text-primary": "#f0f2f5", "--text-secondary": "#a0c8b8",
      "--text-tertiary": "#5e7e72",
      "--border-primary": "#04140e", "--border-secondary": "#0e3024",
      "--accent-blue": "#005C5C", "--accent-green": "#4ade80",
      "--accent-cyan": "#22d3ee", "--accent-red": "#ef4444",
      "--accent-amber": "#FFC72C",
      "--wave-played": "#FFC72C", "--wave-unplayed": "#0e3024",
      "--wave-playhead": "#005C5C",
      "--deck-a": "#005C5C", "--deck-b": "#FFC72C", "--deck-c": "#FFFFFF",
    }
  },
  {
    id: "houston", name: "Houston", emoji: "🚀",
    vars: {
      "--bg-primary": "#0a0a0a", "--bg-secondary": "#1a0a0a",
      "--bg-tertiary": "#280e0e", "--bg-hover": "#3a1818",
      "--text-primary": "#f0f2f5", "--text-secondary": "#c8a8a8",
      "--text-tertiary": "#7a5e5e",
      "--border-primary": "#0a0a0a", "--border-secondary": "#280e0e",
      "--accent-blue": "#5b9eff", "--accent-green": "#4ade80",
      "--accent-cyan": "#22d3ee", "--accent-red": "#CE1141",
      "--accent-amber": "#f59e0b",
      "--wave-played": "#CE1141", "--wave-unplayed": "#280e0e",
      "--wave-playhead": "#C4CED4",
      "--deck-a": "#CE1141", "--deck-b": "#C4CED4", "--deck-c": "#000000",
    }
  },
  {
    id: "philadelphia", name: "Philadelphia", emoji: "🔔",
    vars: {
      "--bg-primary": "#08101e", "--bg-secondary": "#0e1a30",
      "--bg-tertiary": "#142545", "--bg-hover": "#1c3058",
      "--text-primary": "#f0f2f5", "--text-secondary": "#a8b8c8",
      "--text-tertiary": "#6e7a8a",
      "--border-primary": "#08101e", "--border-secondary": "#142545",
      "--accent-blue": "#006BB6", "--accent-green": "#4ade80",
      "--accent-cyan": "#22d3ee", "--accent-red": "#ED174C",
      "--accent-amber": "#f59e0b",
      "--wave-played": "#006BB6", "--wave-unplayed": "#142545",
      "--wave-playhead": "#ED174C",
      "--deck-a": "#006BB6", "--deck-b": "#ED174C", "--deck-c": "#FFFFFF",
    }
  },
  {
    id: "dark-studio", name: "Dark Studio", emoji: "🎙",
    vars: {
      "--bg-primary":    "#0e0e12",
      "--bg-secondary":  "#111116",
      "--bg-tertiary":   "#141420",
      "--bg-hover":      "#1e1e26",
      "--text-primary":  "#e8e8f0",
      "--text-secondary":"#8878c0",
      "--text-tertiary": "#6060a0",
      "--border-primary":  "#1a1a22",
      "--border-secondary":"#1e1e2e",
      "--accent-blue":  "#0ea5e9",
      "--accent-green": "#34d399",
      "--accent-cyan":  "#22d3ee",
      "--accent-red":   "#ef4444",
      "--accent-amber": "#c07820",
      "--wave-played":   "#008878",
      "--wave-unplayed": "#1a1a22",
      "--wave-playhead": "#c07820",
      "--deck-a": "#008878",
      "--deck-b": "#6040c0",
      "--deck-c": "#c07820",
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
      "--text-secondary":"#e8c0c0", // contrast fix: was #d4a0a0 (3.1:1 → 4.8:1)
      "--text-tertiary": "#b87878", // contrast fix: was #8a5555 (too dim)
      "--border-primary":  "#521c1c", // contrast fix: was #3d1515 (too subtle)
      "--border-secondary":"#6b2424",
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
      "--text-secondary":"#a8c4a8", // contrast fix: was #90b090 (3.2:1 → 4.5:1)
      "--text-tertiary": "#6a906a", // contrast fix: was #506050 (too dim)
      "--border-primary":  "#2a402a", // contrast fix: was #1e301e
      "--border-secondary":"#385038",
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

export function applyTheme(vars: ThemeVars, fontStack?: string, presetId?: string) {
  // Write vars only to documentElement and #root — never to .dark-theme / .light-theme
  // elements, which would let the .dark-theme CSS rule's material vars cascade down
  // and override the theme class values on <html>.
  const targets = [
    document.documentElement,
    document.getElementById("root"),
  ].filter(Boolean) as Element[];
  for (const target of targets) {
    for (const [k, v] of Object.entries(vars)) {
      (target as HTMLElement).style.setProperty(k, v);
    }
    if (fontStack) {
      (target as HTMLElement).style.setProperty("--font-ui", fontStack);
    }
  }
  // For themes with material overrides, set those as inline styles too so they
  // beat any cascading var(--bg-*) fallback chain on <body> or #root.
  const materialOverrides: Record<string, Record<string, string>> = {
    'ether-default': {
      '--panel-bg': '#d4d8dd',
      '--panel-gradient': 'none',
      '--panel-border': '1px solid rgba(40,44,50,0.45)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.5)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.2)',
      '--vu-meter-bg': '#3a3e44',
      '--strip-label-bg': 'transparent',
      '--strip-divider': 'rgba(60,64,72,0.18)',
      '--strip-readout-bg': 'transparent',
      '--strip-label-text': '#5a6068',
      '--scale-text': 'rgba(40,44,50,0.5)',
      '--scale-text-unity': 'rgba(40,44,50,0.85)',
      '--scale-tick': 'rgba(40,44,50,0.3)',
      '--scale-tick-unity': 'rgba(40,44,50,0.7)',
      '--text-tertiary': '#3a3e46',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-radius': '4px',
      '--fader-track-bg': '#1a1d22',
      '--fader-thumb-gradient': 'linear-gradient(180deg, #c8ccd2 0%, #aab0b8 30%, #8e94a0 70%, #6b7079 100%)',
      '--fader-thumb-shadow': '0 2px 4px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,0,0,0.3)',
      '--fader-thumb-border': '1px solid rgba(0,0,0,0.6)',
      '--fader-thumb-radius': '3px',
      '--button-bg': '#cdd1d6',
      '--button-bg-hover': '#bbc0c6',
      '--button-bg-active': '#a6acb3',
      '--button-gradient': 'linear-gradient(180deg, #8a8f98 0%, #6b7079 50%, #5d626b 100%)',
      '--button-shadow': '0 1px 2px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.3), inset 0 -1px 0 rgba(0,0,0,0.2)',
      '--button-border': '1px solid rgba(60,64,72,0.4)',
      '--button-radius': '3px',
      '--button-text': '#1a1d22',
      '--button-text-hover': '#000',
      '--button-text-active': '#ffffff',
      '--label-color': '#2a2d34',
      '--label-text-shadow': '0 1px 0 rgba(255,255,255,0.4)',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'newyork': {
      '--vu-meter-bg': '#0a1428',
      '--panel-bg': '#1d3568',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'losangeles': {
      '--vu-meter-bg': '#0e0820',
      '--panel-bg': '#341c63',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'chicago': {
      '--vu-meter-bg': '#0a0a0a',
      '--panel-bg': '#3a1818',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'atlanta': {
      '--vu-meter-bg': '#0a0d08',
      '--panel-bg': '#2c321c',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'dallas': {
      '--vu-meter-bg': '#06101e',
      '--panel-bg': '#163058',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'toronto': {
      '--vu-meter-bg': '#0a0a0a',
      '--panel-bg': '#321c1c',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'miami': {
      '--panel-bg': '#0d4268',
      '--panel-gradient': 'linear-gradient(180deg, #185e90 0%, #135280 25%, #0d4268 60%, #082d48 100%)',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--vu-meter-bg': '#030f1c',
      '--recess-bg': '#030f1c',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'seattle': {
      '--vu-meter-bg': '#04140e',
      '--panel-bg': '#154030',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'houston': {
      '--vu-meter-bg': '#0a0a0a',
      '--panel-bg': '#3a1818',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
    'philadelphia': {
      '--vu-meter-bg': '#08101e',
      '--panel-bg': '#1c3058',
      '--panel-gradient': 'none',
      '--panel-grain': 'repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1px, rgba(0,0,0,0.04) 1px, rgba(0,0,0,0.04) 2px, transparent 2px, transparent 4px)',
      '--panel-border': '1px solid rgba(0,0,0,0.5)',
      '--panel-inner-shadow': 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4)',
      '--panel-outer-shadow': '0 1px 2px rgba(0,0,0,0.5)',
      '--panel-radius': '4px',
      '--recess-bg': '#050608',
      '--recess-inner-shadow': 'inset 0 2px 6px rgba(0,0,0,0.95), inset 0 -1px 0 rgba(255,255,255,0.06)',
      '--recess-border': '1px solid rgba(0,0,0,0.6)',
      '--recess-radius': '3px',
    },
  };

  const allMaterialKeys = new Set<string>();
  for (const overrides of Object.values(materialOverrides)) {
    for (const k of Object.keys(overrides)) allMaterialKeys.add(k);
  }
  for (const target of targets) {
    for (const k of allMaterialKeys) {
      (target as HTMLElement).style.removeProperty(k);
    }
  }

  if (presetId && materialOverrides[presetId]) {
    for (const target of targets) {
      for (const [k, v] of Object.entries(materialOverrides[presetId])) {
        (target as HTMLElement).style.setProperty(k, v);
      }
    }
  }

  // Strip legacy dark-theme / light-theme and any prior theme-* class from both
  // <html> and <body>, then add the new theme class.
  const shouldStrip = (c: string) =>
    c === 'dark-theme' || c === 'light-theme' || c.startsWith('theme-');
  [document.documentElement, document.body].forEach(el => {
    if (!el) return;
    Array.from(el.classList).forEach(c => { if (shouldStrip(c)) el.classList.remove(c); });
  });
  if (presetId) document.documentElement.classList.add(`theme-${presetId}`);
}

// ─── Persistence ───────────────────────────────────────────────

async function saveTheme(presetId: string, vars: ThemeVars, stationId: number | null, fontId?: string) {
  if (stationId == null) return;
  const kv = (window as any).ether.stationConfigKv;
  const r1 = await kv.upsertByKey(stationId, 'theme_preset_id', presetId);
  if (!r1.ok) console.error('[saveTheme] theme_preset_id:', r1.error);
  const r2 = await kv.upsertByKey(stationId, 'theme_custom_vars', JSON.stringify(vars));
  if (!r2.ok) console.error('[saveTheme] theme_custom_vars:', r2.error);
  if (fontId !== undefined) {
    const r3 = await kv.upsertByKey(stationId, 'theme_font_id', fontId);
    if (!r3.ok) console.error('[saveTheme] theme_font_id:', r3.error);
  }
}

async function loadTheme(stationId: number): Promise<{ presetId: string; vars: ThemeVars; fontId: string } | null> {
  try {
    const result = await (window as any).ether.stationConfigKv.list(stationId);
    if (!result.ok) return null;
    const rows: { key: string; value: string }[] = result.rows;
    const get = (key: string) => rows.find(r => r.key === key)?.value;
    const presetId      = get('theme_preset_id');
    const customVarsRaw = get('theme_custom_vars');
    if (!presetId || !customVarsRaw) return null;
    return {
      presetId,
      vars:   JSON.parse(customVarsRaw),
      fontId: get('theme_font_id') ?? 'system',
    };
  } catch { return null; }
}

// Apply dark defaults synchronously at module load so early-return screens
// (OnShiftScreen, UserLogin, etc.) don't inherit the light :root CSS vars.
applyTheme(DEFAULT_PRESET.vars, undefined, DEFAULT_PRESET.id);

// ─── useSkin hook ──────────────────────────────────────────────

let _themeEditorOpen = false;
let _setThemeEditorOpen: ((v: boolean) => void) | null = null;

export function useSkin() {
  const [skinId, setSkinIdState]       = useState(DEFAULT_PRESET.id);
  const [fontId, setFontIdState]       = useState("system");
  const [editorOpen, setEditorOpen]    = useState(false);
  const [stationId, setStationId]      = useState<number | null>(null);
  const loadVersionRef = useRef(0);

  // Register setter so AppContextMenu can open the editor
  useEffect(() => {
    _setThemeEditorOpen = setEditorOpen;
    return () => { _setThemeEditorOpen = null; };
  }, []);

  // Load saved theme on mount and on station-switched — auto-reset if a light theme was saved.
  // For named presets, always apply the CURRENT vars from code (not the DB snapshot)
  // so that any color updates to presets take effect on the next app start without
  // requiring the user to re-select the theme.
  useEffect(() => {
    async function doLoad() {
      const v = ++loadVersionRef.current;
      const station = await (window as any).ether.invoke('stations:get-active');
      if (v !== loadVersionRef.current) return;
      const sid: number | null = station?.id ?? null;
      setStationId(sid);

      if (sid == null) { applyTheme(DEFAULT_PRESET.vars, undefined, DEFAULT_PRESET.id); return; }

      const saved = await loadTheme(sid);
      if (v !== loadVersionRef.current) return;
      if (saved) {
        // If saved theme has a light background, force back to ether-default
        const bgPrimary = saved.vars["--bg-primary"] || "";
        if (bgPrimary.startsWith("#f") || bgPrimary.startsWith("#e") || bgPrimary === "#ffffff") {
          setSkinIdState(DEFAULT_PRESET.id);
          applyTheme(DEFAULT_PRESET.vars, undefined, DEFAULT_PRESET.id);
          saveTheme(DEFAULT_PRESET.id, DEFAULT_PRESET.vars, sid);
          return;
        }
        setSkinIdState(saved.presetId);
        setFontIdState(saved.fontId || "system");
        const fontStack = FONT_OPTIONS.find(f => f.id === saved.fontId)?.stack;
        // For named presets use the current code-side vars — this ensures any preset
        // color updates (e.g. Dark Studio text colors) take effect immediately on
        // restart rather than being overridden by the stale DB snapshot.
        const livePreset = PRESETS.find(p => p.id === saved.presetId);
        const varsToApply = livePreset ? livePreset.vars : saved.vars;
        applyTheme(varsToApply, fontStack, livePreset ? livePreset.id : saved.presetId);
      } else {
        applyTheme(DEFAULT_PRESET.vars, undefined, DEFAULT_PRESET.id);
      }
    }
    doLoad();
    window.addEventListener('station-switched', doLoad);
    return () => window.removeEventListener('station-switched', doLoad);
  }, []);

  const setSkin = useCallback((id: string) => {
    const preset = PRESETS.find(p => p.id === id) || DEFAULT_PRESET;
    setSkinIdState(id);
    const fontStack = FONT_OPTIONS.find(f => f.id === fontId)?.stack;
    applyTheme(preset.vars, fontStack, preset.id);
    saveTheme(id, preset.vars, stationId, fontId);
  }, [fontId, stationId]);

  return {
    skinId,
    fontId,
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
          width: 28, height: 28, borderRadius: 0, flexShrink: 0,
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
          width: 74, padding: "3px 7px", borderRadius: 0,
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

// ─── Miniature UI preview card for a preset ───────────────────

function PresetCard({ p, active }: { p: Preset; active: boolean }) {
  const v = p.vars;
  return (
    <button onClick={() => {/* handled by parent */}} style={{
      display: "block", width: "100%", padding: "8px 10px",
      border: "none", borderRadius: "var(--button-radius, 0px)",
      background: active ? "var(--bg-hover, rgba(255,255,255,0.05))" : "var(--bg-secondary, transparent)",
      outline: active ? "1.5px solid var(--accent-cyan)" : "1px solid var(--border-primary, transparent)",
      cursor: "pointer", textAlign: "left",
      transition: "all 0.12s",
    }}>
      {/* Miniature UI mockup */}
      <div style={{
        width: "100%", height: 34,
        background: v["--bg-primary"],
        border: `1px solid ${v["--border-primary"]}`,
        overflow: "hidden", marginBottom: 5,
        display: "flex", flexDirection: "column",
      }}>
        {/* Header bar */}
        <div style={{ height: 10, background: v["--bg-secondary"], borderBottom: `1px solid ${v["--border-primary"]}`, display: "flex", alignItems: "center", gap: 2, padding: "0 4px", flexShrink: 0 }}>
          <div style={{ width: 4, height: 4, borderRadius: "50%", background: v["--accent-red"] }} />
          <div style={{ flex: 1 }} />
          <div style={{ width: 10, height: 3, background: v["--accent-cyan"], opacity: 0.8 }} />
        </div>
        {/* Body — two fake decks */}
        <div style={{ flex: 1, display: "flex", gap: 2, padding: 2 }}>
          <div style={{ flex: 1, background: v["--bg-secondary"], border: `1px solid ${v["--border-primary"]}`, padding: "2px 3px" }}>
            <div style={{ width: "60%", height: 2, background: v["--deck-a"], marginBottom: 2 }} />
            <div style={{ width: "100%", height: 2, background: v["--wave-unplayed"], position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "40%", background: v["--wave-played"] }} />
            </div>
          </div>
          <div style={{ flex: 1, background: v["--bg-secondary"], border: `1px solid ${v["--border-primary"]}`, padding: "2px 3px" }}>
            <div style={{ width: "55%", height: 2, background: v["--deck-b"], marginBottom: 2 }} />
            <div style={{ width: "100%", height: 2, background: v["--wave-unplayed"] }} />
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 13 }}>{p.emoji}</span>
        <span style={{ fontSize: 11, fontWeight: active ? 700 : 500, color: active ? "var(--accent-cyan)" : "var(--text-secondary)" }}>{p.name}</span>
      </div>
    </button>
  );
}

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
  // Tier: "presets" | "tuning" | "identity"
  const [tier, setTier]                 = useState<"presets" | "tuning" | "identity">("presets");
  // Font
  const [fontId, setFontId]             = useState("system");
  // Operator theme
  const [operators, setOperators]       = useState<{ id: number; uuid: string; name: string }[]>([]);
  const [opThemeUuid, setOpThemeUuid]   = useState<string | null>(null);
  // Station logo
  const [logoUrl, setLogoUrl]                   = useState<string | null>(null);
  const [activeStationId, setActiveStationId]   = useState<number | null>(null);
  const loadVersionRef = useRef(0);

  // Operators are not station-scoped; fetch once on mount
  useEffect(() => {
    (async () => {
      try {
        const ops = await (window as any).ether.db.query("SELECT id, uuid, name FROM operators ORDER BY id", []);
        if (ops.data) setOperators(ops.data);
      } catch {}
    })();
  }, []);

  // Station-scoped data: active station + KV (logo + font); re-runs on station-switched
  useEffect(() => {
    async function doLoad() {
      const v = ++loadVersionRef.current;
      try {
        const station = await (window as any).ether.invoke('stations:get-active');
        if (v !== loadVersionRef.current) return;
        const sid: number | null = station?.id ?? null;
        setActiveStationId(sid);

        if (sid != null) {
          const kvResult = await (window as any).ether.stationConfigKv.list(sid);
          if (v !== loadVersionRef.current) return;
          if (kvResult.ok) {
            const rows: { key: string; value: string }[] = kvResult.rows;
            const get = (key: string) => rows.find(r => r.key === key)?.value;
            const logo = get('station_logo');
            const font = get('theme_font_id');
            if (logo) setLogoUrl(logo);
            if (font) setFontId(font);
          }
        }
      } catch {}
    }
    doLoad();
    window.addEventListener('station-switched', doLoad);
    return () => window.removeEventListener('station-switched', doLoad);
  }, []);

  // Live preview on every change
  useEffect(() => {
    const fontStack = FONT_OPTIONS.find(f => f.id === fontId)?.stack;
    applyTheme(vars, fontStack, activePreset);
  }, [vars, fontId, activePreset]);

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
    await saveTheme(activePreset, vars, activeStationId, fontId);
    // Save operator theme if one is selected
    if (opThemeUuid !== null) {
      await (window as any).ether.operators.update(
        opThemeUuid,
        { theme: JSON.stringify({ presetId: activePreset, vars }) }
      );
    }
    // Do not call onSelect here — the theme is already live on document.documentElement
    // from the live-preview useEffect. Calling onSelect would invoke setSkin in App.tsx,
    // which re-applies hardcoded preset vars and wipes any custom edits.
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleExport = async () => {
    const result = await (window as any).ether.theme.export(activePreset, vars, fontId);
    if (!result?.ok) console.warn("[Theme] Export failed:", result?.error);
  };

  const handleImport = async () => {
    const result = await (window as any).ether.theme.import();
    if (result?.ok && result.data?.vars) {
      setVars(result.data.vars);
      setActivePreset(result.data.presetId || "custom");
      if (result.data.font) setFontId(result.data.font);
    }
  };

  const handleReset = () => {
    const preset = PRESETS.find(p => p.id === currentSkin) || DEFAULT_PRESET;
    setActivePreset(preset.id);
    setVars({ ...preset.vars });
  };

  const handleLogoUpload = async () => {
    const result = await (window as any).ether.station.uploadLogo();
    if (result?.ok && result.dataUrl) {
      setLogoUrl(result.dataUrl);
      if (activeStationId != null) {
        const r = await (window as any).ether.stationConfigKv.upsertByKey(activeStationId, 'station_logo', result.dataUrl);
        if (!r.ok) console.error('[handleLogoUpload] station_logo:', r.error);
      }
    }
  };

  const handleLogoRemove = async () => {
    setLogoUrl(null);
    if (activeStationId != null) {
      const r = await (window as any).ether.stationConfigKv.removeByKey(activeStationId, 'station_logo');
      if (!r.ok) console.error('[handleLogoRemove] station_logo:', r.error);
    }
  };

  const tierBtn = (id: "presets" | "tuning" | "identity", label: string) => (
    <button onClick={() => setTier(id)} style={{
      flex: 1, padding: "7px 0", border: "none", borderRadius: 0,
      background: tier === id ? "var(--bg-hover)" : "transparent",
      color: tier === id ? "var(--text-primary)" : "var(--text-tertiary)",
      fontSize: 10, fontWeight: tier === id ? 700 : 500,
      letterSpacing: "0.06em", textTransform: "uppercase",
      cursor: "pointer", borderBottom: tier === id ? "2px solid var(--accent-cyan)" : "2px solid transparent",
      transition: "all 0.1s",
    }}>{label}</button>
  );

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
        width: 820, maxHeight: "90vh",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-secondary)",
        borderRadius: 0,
        display: "flex", flexDirection: "column",
        boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
        overflow: "hidden",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}>

        {/* ── Header ── */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "16px 24px",
          borderBottom: "1px solid var(--border-primary)",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 18 }}>🎨</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Theme Studio</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 1 }}>Pick a preset · Tune every color · Set station identity</div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={handleImport} title="Import .ethertheme file" style={ghostBtn}>Import</button>
          <button onClick={handleExport} title="Export .ethertheme file" style={ghostBtn}>Export</button>
          <button onClick={handleReset} title="Reset to current preset" style={ghostBtn}>Reset</button>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: 0,
            background: "transparent", border: "1px solid var(--border-primary)",
            color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.12)"; (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          >✕</button>
        </div>

        {/* ── Tier tabs ── */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
          {tierBtn("presets",  "Presets")}
          {tierBtn("tuning",   "Tuning")}
          {tierBtn("identity", "Station Identity")}
        </div>

        {/* ── Body ── */}
        <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>

          {/* ── PRESETS TIER ── */}
          {tier === "presets" && (
            <>
              {/* Grid of miniature preview cards */}
              <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                  {PRESETS.map(p => (
                    <div key={p.id} onClick={() => selectPreset(p.id)} style={{ cursor: "pointer" }}>
                      <PresetCard p={p} active={activePreset === p.id} />
                    </div>
                  ))}
                </div>
                {activePreset === "custom" && (
                  <div style={{ marginTop: 14, padding: "8px 12px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", fontSize: 11, color: "var(--accent-amber)", fontWeight: 600 }}>
                    ✦ Custom theme active — tuned from a preset
                  </div>
                )}
                {/* Quick live preview */}
                <div style={{ marginTop: 20 }}>
                  <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>Preview</div>
                  <LivePreviewBlock vars={vars} />
                </div>
              </div>
            </>
          )}

          {/* ── TUNING TIER ── */}
          {tier === "tuning" && (
            <>
              {/* Left: group nav */}
              <div style={{ width: 180, flexShrink: 0, borderRight: "1px solid var(--border-primary)", overflowY: "auto" }}>
                <div style={{ padding: "12px 12px 6px" }}>
                  <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>Color Groups</div>
                  {VAR_GROUPS.map((g, i) => (
                    <button key={g.label} onClick={() => setActiveGroup(i)} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "7px 10px", border: "none", borderRadius: 0,
                      background: activeGroup === i ? "var(--bg-hover)" : "transparent",
                      color: activeGroup === i ? "var(--text-primary)" : "var(--text-tertiary)",
                      cursor: "pointer", textAlign: "left", width: "100%",
                      fontSize: 11, fontWeight: activeGroup === i ? 700 : 400,
                      transition: "all 0.1s",
                    }}>
                      <span style={{ fontSize: 12 }}>{g.emoji}</span>
                      <span>{g.label}</span>
                      <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--text-tertiary)" }}>{g.vars.length}</span>
                    </button>
                  ))}
                </div>
              </div>
              {/* Right: color rows */}
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.01em", marginBottom: 3 }}>
                    {VAR_GROUPS[activeGroup].emoji} {VAR_GROUPS[activeGroup].label}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
                    Click any swatch or type hex — app updates live
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {VAR_GROUPS[activeGroup].vars.map(({ key, label }) => (
                    <ColorRow key={key} label={label} value={vars[key]} onChange={v => updateVar(key, v)} />
                  ))}
                </div>
                <div style={{ marginTop: 24 }}>
                  <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>Live Preview</div>
                  <LivePreviewBlock vars={vars} />
                </div>
              </div>
            </>
          )}

          {/* ── STATION IDENTITY TIER ── */}
          {tier === "identity" && (
            <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>

              {/* Font selection */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 4 }}>UI Typeface</div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 14 }}>Applied globally via --font-ui CSS variable</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {FONT_OPTIONS.map(f => (
                    <button key={f.id} onClick={() => setFontId(f.id)} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "10px 14px", border: "none", borderRadius: 0,
                      background: fontId === f.id ? "rgba(255,255,255,0.05)" : "transparent",
                      outline: fontId === f.id ? "1px solid var(--accent-cyan)" : "1px solid var(--border-primary)",
                      color: fontId === f.id ? "var(--accent-cyan)" : "var(--text-secondary)",
                      cursor: "pointer", textAlign: "left",
                      transition: "all 0.1s",
                    }}>
                      <span style={{ fontSize: 12, fontFamily: f.stack }}>{f.label}</span>
                      <span style={{ fontSize: 10, fontFamily: f.stack, opacity: 0.6 }}>Aa Bb 123</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Station logo */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 4 }}>Station Logo</div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 14 }}>Displayed on the On-Shift welcome screen</div>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{
                    width: 80, height: 80, background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-primary)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    overflow: "hidden", flexShrink: 0,
                  }}>
                    {logoUrl
                      ? <img src={logoUrl} alt="Logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                      : <span style={{ fontSize: 22, opacity: 0.3 }}>📻</span>
                    }
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <button onClick={handleLogoUpload} style={{ ...ghostBtn, fontSize: 11 }}>
                      {logoUrl ? "Replace Logo" : "Upload Logo..."}
                    </button>
                    {logoUrl && (
                      <button onClick={handleLogoRemove} style={{ ...ghostBtn, fontSize: 11, color: "var(--accent-red)", border: "1px solid rgba(239,68,68,0.3)" }}>
                        Remove
                      </button>
                    )}
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>PNG, JPG, SVG · Max ~500 KB</div>
                  </div>
                </div>
              </div>

              {/* Per-operator theme */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 4 }}>Per-Operator Theme</div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 14 }}>
                  Assign the current theme to a specific operator. Their personal theme loads when they log in.
                </div>
                {operators.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>No operators configured yet</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {operators.map(op => (
                      <button key={op.id} onClick={() => setOpThemeUuid(opThemeUuid === op.uuid ? null : op.uuid)} style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "9px 14px", border: "none", borderRadius: 0,
                        background: opThemeUuid === op.uuid ? "rgba(255,255,255,0.05)" : "transparent",
                        outline: opThemeUuid === op.uuid ? "1px solid var(--accent-green)" : "1px solid var(--border-primary)",
                        color: opThemeUuid === op.uuid ? "var(--accent-green)" : "var(--text-secondary)",
                        cursor: "pointer", textAlign: "left",
                        transition: "all 0.1s",
                      }}>
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: opThemeUuid === op.uuid ? "var(--accent-green)" : "var(--text-tertiary)", flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: opThemeUuid === op.uuid ? 700 : 400 }}>{op.name}</span>
                        {opThemeUuid === op.uuid && <span style={{ fontSize: 10, marginLeft: "auto", opacity: 0.7 }}>will receive current theme on Save</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

            </div>
          )}

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
            {activePreset === "custom"
              ? "✦ Custom theme"
              : `Preset: ${PRESETS.find(p => p.id === activePreset)?.name || activePreset}`}
            {" · "}Font: {FONT_OPTIONS.find(f => f.id === fontId)?.label || "System Default"}
          </div>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <button onClick={handleSave} style={{
            height: 36, padding: "0 24px", borderRadius: 0, border: "none",
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

// ─── Shared live preview block ─────────────────────────────────

function LivePreviewBlock({ vars }: { vars: ThemeVars }) {
  return (
    <div style={{
      borderRadius: 0, overflow: "hidden",
      border: "1px solid var(--border-primary)",
      background: vars["--bg-primary"],
    }}>
      <div style={{ height: 32, background: vars["--bg-secondary"], borderBottom: `1px solid ${vars["--border-primary"]}`, display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: vars["--accent-red"] }} />
        <div style={{ width: 36, height: 5, background: vars["--text-tertiary"], opacity: 0.35 }} />
        <div style={{ flex: 1 }} />
        <div style={{ width: 44, height: 18, background: vars["--accent-cyan"], opacity: 0.9 }} />
        <div style={{ width: 32, height: 18, background: vars["--accent-red"] }} />
      </div>
      <div style={{ padding: 12, display: "flex", gap: 8 }}>
        {[{ color: vars["--deck-a"] }, { color: vars["--deck-b"] }].map(({ color }, idx) => (
          <div key={idx} style={{ flex: 1, background: vars["--bg-secondary"], border: `1px solid ${vars["--border-primary"]}`, padding: 10 }}>
            <div style={{ width: "55%", height: 4, background: color, marginBottom: 7, opacity: 0.9 }} />
            <div style={{ width: "100%", height: 3, background: vars["--wave-unplayed"], marginBottom: 4, position: "relative", overflow: "hidden" }}>
              {idx === 0 && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "42%", background: vars["--wave-played"] }} />}
            </div>
            <div style={{ width: "38%", height: 3, background: vars["--text-tertiary"], opacity: 0.28 }} />
          </div>
        ))}
      </div>
      <div style={{ height: 20, background: vars["--bg-secondary"], borderTop: `1px solid ${vars["--border-primary"]}`, display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
        <div style={{ width: 5, height: 5, borderRadius: "50%", background: vars["--accent-green"] }} />
        <div style={{ width: 28, height: 3, background: vars["--text-tertiary"], opacity: 0.35 }} />
        <div style={{ flex: 1 }} />
        <div style={{ width: 44, height: 3, background: vars["--text-tertiary"], opacity: 0.25 }} />
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
        borderRadius: 0, padding: 4, minWidth: 190,
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
              padding: "8px 12px", border: "none", borderRadius: 0,
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
  height: 32, padding: "0 14px", borderRadius: 0,
  background: "var(--bg-tertiary)",
  border: "1px solid var(--border-primary)",
  color: "var(--text-secondary)",
  fontSize: 11, fontWeight: 600, cursor: "pointer",
  letterSpacing: "0.02em",
};

