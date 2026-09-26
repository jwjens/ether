// ── rackUi — the rack's one visual language, shared by the master and channel racks (Slice 4 → 5) ─────────
// Touch-sized: every control ≥ 44 px.
import React from "react";

export const LABEL: React.CSSProperties = { fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" };
export const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontVariantNumeric: "tabular-nums" };
export const TOUCH = 44;
export const BTN = (on = false, tone = "#8868D8"): React.CSSProperties => ({
  minHeight: TOUCH, minWidth: TOUCH, padding: "0 14px", fontSize: 12, fontWeight: 800, letterSpacing: "0.06em",
  cursor: "pointer", border: `1px solid ${on ? tone : "var(--border-primary)"}`,
  background: on ? `color-mix(in srgb, ${tone} 18%, transparent)` : "var(--bg-tertiary)", color: on ? tone : "var(--text-secondary)",
});

/** A range control sized for a finger. */
export function Knob({ label, value, unit, min, max, step, onChange, hint, vertical = false }: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  onChange: (v: number) => void; hint: string; vertical?: boolean;
}) {
  return (
    <div title={hint} style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: 10, minHeight: TOUCH }}>
      <span style={{ ...LABEL, width: vertical ? "auto" : 78, flexShrink: 0 }}>{label}</span>
      <input className="rack-range" type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={vertical ? { writingMode: "vertical-lr" as any, direction: "rtl", height: 160, width: TOUCH }
                        : { flex: 1, height: TOUCH }} />
      <span style={{ ...MONO, fontSize: 14, fontWeight: 800, minWidth: 70, textAlign: vertical ? "center" : "right", color: "#8868D8" }}>
        {value > 0 && unit === " dB" ? "+" : ""}{value}{unit}
      </span>
    </div>
  );
}
