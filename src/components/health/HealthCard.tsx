// ── HealthCard — one quick-scan tile ────────────────────────────────────────────────────────────
//
// Health Monitor redesign, Phase 1. A big number, a label, a colour, and optionally a click.
//
// memo'd because the dashboard sits inside the Health Monitor, which re-renders on deck ticks. The
// spec asks for that in Phase 4; it costs one wrapper to do it now, and a card that repaints 4× a
// second while an operator is reading it is the thing being replaced.
import { memo } from "react";
import { levelColor, type HealthLevel } from "./healthUtils";

export interface HealthCardProps {
  /** The small label above the value. */
  title: string;
  /** The big number or short status word. */
  value: string;
  /** The line underneath — say what the number MEANS, not what it is called again. */
  sub?: string;
  status: HealthLevel;
  onClick?: () => void;
  /** Shown on hover; also the accessible name of the action when clickable. */
  hint?: string;
}

function HealthCardImpl({ title, value, sub, status, onClick, hint }: HealthCardProps) {
  const color = levelColor(status);
  const clickable = typeof onClick === "function";
  return (
    <div
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick!(); } } : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={hint}
      style={{
        // Flat, per the spec's token table — this app is already flat (1,032 borderRadius:0 uses).
        borderRadius: 0,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-primary)",
        // The status colour as a left edge rather than a full fill: four saturated blocks in a row
        // would read as an alarm panel even when everything is green.
        borderLeft: `3px solid ${color}`,
        padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 2, minWidth: 0,
        cursor: clickable ? "pointer" : "default",
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
                       color: "var(--text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.15, color,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.35,
                      overflow: "hidden", textOverflow: "ellipsis" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export const HealthCard = memo(HealthCardImpl);
export default HealthCard;
