// ── HealthCard — one quick-scan tile ────────────────────────────────────────────────────────────
//
// Health Monitor redesign. A big number, a label, a colour, and optionally a click.
//
// WHY IT LOOKED LIKE TEXT (4.4.206, Jeff's report): the card was filled `--bg-secondary` — the SAME
// colour as the panel behind it — so there was no card boundary to see. A 1px border and a 3px edge
// on an identical fill reads as a rule between paragraphs, not as a card. Everything on it was also
// 9–11px, the same micro-typography as the wall of text it was meant to replace.
//
// So: raised fill (`--bg-elevated`) against the panel's `--bg-secondary`, a 30px number, real
// padding, and a tinted status wash. Still flat (--r-0) and still muted — the brand rule is flat and
// dense, not small and grey.
import { memo } from "react";
import { levelColor, type HealthLevel } from "./healthUtils";

export interface HealthCardProps {
  title: string;
  value: string;
  sub?: string;
  status: HealthLevel;
  onClick?: () => void;
  hint?: string;
  /** Wall-display mode: bigger number, taller card. A figure sized for a docked panel at arm's
   *  length is not legible from across a studio, which is the whole point of a wall display. */
  wall?: boolean;
}

function HealthCardImpl({ title, value, sub, status, onClick, hint, wall }: HealthCardProps) {
  const color = levelColor(status);
  const clickable = typeof onClick === "function";
  // A very low-alpha wash of the status colour, so a red card is legible as red across the room
  // without becoming a solid alarm block. Grey gets none — "not measured" should not tint anything.
  const wash = status === "grey" ? "transparent" : `color-mix(in srgb, ${color} 7%, transparent)`;

  return (
    <div
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick!(); } } : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={hint}
      style={{
        borderRadius: "var(--r-0, 0px)",
        // RAISED against the dashboard's sunk --bg-primary region. --bg-secondary per spec; the
        // container behind it is darker, so the card edge is visible without elevation tricks.
        background: `linear-gradient(0deg, ${wash}, ${wash}), var(--bg-secondary)`,
        border: "1px solid var(--border-primary)",
        borderLeft: `3px solid ${color}`,
        padding: wall ? "var(--s-6, 16px) var(--s-5, 12px)" : "var(--s-5, 12px) var(--s-5, 12px) var(--s-4, 8px)",
        display: "flex", flexDirection: "column", gap: "var(--s-1, 2px)", minWidth: 0,
        minHeight: wall ? 128 : 96,
        cursor: clickable ? "pointer" : "default",
      }}>

      {/* Label row */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2, 4px)", minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: "var(--r-full, 999px)", background: color, flexShrink: 0 }} />
        <span style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 700, letterSpacing: "0.14em",
                       textTransform: "uppercase", color: "var(--text-tertiary)",
                       whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </span>
      </div>

      {/* THE NUMBER, at --t-metric — the scale step added for exactly this. The five sizes that
          existed topped out at 20px "panel titles only", so a headline figure had nowhere to sit and
          the panel kept reading as text however it was arranged. */}
      <div style={{ fontSize: wall ? 44 : "var(--t-metric, 30px)", fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.02em",
                    color, marginTop: "var(--s-1, 2px)",
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>

      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.4, marginTop: "auto",
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const,
                      overflow: "hidden" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export const HealthCard = memo(HealthCardImpl);
export default HealthCard;
