// HFader — the one horizontal fader (MASTER, MONITOR, the station strips under Station Monitors, the AUX rows). Handled
// by useFaderControl (no jump on grab, Shift fine, wheel, arrows) with the dB readout from FaderValue (double-click to
// type). Drawn on THE ONE CONSOLE LAW at its group's top (src/lib/faderLaw.ts). Replaces the browser's <input type=range>,
// which jumped to wherever the track was clicked (Jeff, 2026-10-13).
import { useRef, type ReactNode } from "react";
import { gainToPos, faderMarks } from "../lib/faderLaw";
import { useFaderControl } from "../lib/useFaderControl";
import FaderValue from "./FaderValue";

export default function HFader({ gain, topDb, onChange, color = "var(--accent-teal)", label, layout = "inline", dim, disabled, title, labelWidth = 52, valueStyle }: {
  gain: number; topDb: number; onChange: (g: number) => void; color?: string;
  label?: ReactNode; layout?: "inline" | "stacked"; dim?: boolean; disabled?: boolean; title?: string; labelWidth?: number;
  valueStyle?: React.CSSProperties;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const c = useFaderControl({ gain, topDb, onChange, axis: "x", trackRef, disabled });
  const pos = gainToPos(gain, topDb);
  const track = (
    <div
      ref={trackRef}
      onPointerDown={c.onPointerDown}
      onKeyDown={c.onKeyDown}
      tabIndex={c.tabIndex}
      role="slider"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pos * 100)}
      title={title}
      style={{ position: "relative", flex: 1, width: layout === "stacked" ? "100%" : undefined, height: 14, cursor: disabled ? "default" : c.dragging ? "grabbing" : "grab",
        userSelect: "none", touchAction: "none", outline: "none", opacity: dim ? 0.45 : 1 }}
    >
      <div style={{ position: "absolute", left: 0, right: 0, top: "50%", transform: "translateY(-50%)", height: 3, background: "var(--fader-track-bg, rgba(255,255,255,0.08))" }} />
      <div style={{ position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)", height: 3, width: `${pos * 100}%`, background: color, pointerEvents: "none" }} />
      {faderMarks(topDb).map(m => (
        <div key={m.label + m.pos} style={{ position: "absolute", left: `${m.pos * 100}%`, top: m.unity ? -1 : 2, bottom: m.unity ? -1 : 2,
          borderLeft: `1px solid ${m.unity ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.22)"}`, pointerEvents: "none" }} title={`${m.label} dB`} />
      ))}
      <div style={{ position: "absolute", left: `${pos * 100}%`, top: "50%", transform: "translate(-50%, -50%)", width: 12, height: 12,
        borderRadius: "var(--fader-thumb-radius, 50%)", background: color, backgroundImage: "var(--fader-thumb-gradient, none)",
        border: "var(--fader-thumb-border, 1px solid var(--strip-thumb-border))", boxShadow: c.active ? "0 0 0 2px #8868D8" : "var(--fader-thumb-shadow, none)",
        pointerEvents: "none" }} />
    </div>
  );
  const value = <FaderValue gain={gain} topDb={topDb} onChange={onChange} active={c.active} disabled={disabled} style={valueStyle} />;
  if (layout === "stacked") {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          {label}{value}
        </div>
        {track}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {label != null && <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", width: labelWidth, flexShrink: 0 }}>{label}</span>}
      {track}
      <span style={{ width: 62, textAlign: "right", flexShrink: 0 }}>{value}</span>
    </div>
  );
}
