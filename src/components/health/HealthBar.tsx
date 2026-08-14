// ── HealthBar — one rotation goal, as a bar ─────────────────────────────────────────────────────
//
// Health Monitor redesign. Category · bar · "X/Y /hr".
//
// The 4.4.206 version was an 8px hairline with 10px text, which read as a row of labels with a line
// in it. A bar has to be substantial enough to judge at a glance from across a studio: 14px track,
// the category at 12px, the figures at 12px mono, and a target tick so "where am I supposed to be"
// is visible on the bar itself rather than only in the numbers.
//
// Rules live in healthUtils.barState() so the colours are testable without rendering.
import { memo } from "react";
import { barState, levelColor, type CategoryGoal } from "./healthUtils";

function HealthBarImpl({ goal }: { goal: CategoryGoal }) {
  const b = barState(goal);
  const color = levelColor(b.level);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4, 8px)",
                  padding: "var(--s-2, 4px) 0" }}
         title={b.hasTarget
           ? `${goal.category}: ${goal.actualSpinsPerHour} spins/hr over the last 24h against a target of ${goal.target}. ${goal.spins24h} spins counted.`
           : `${goal.category}: ${goal.actualSpinsPerHour} spins/hr over the last 24h. No target declared, so there is nothing to measure against.`}>

      <span style={{ width: 140, flexShrink: 0, fontSize: 12, fontWeight: 600,
                     color: "var(--text-secondary)",
                     overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {goal.category}
      </span>

      {/* Track sunk into the page (--bg-primary is darker than the card), so the fill reads as
          filled rather than as a coloured underline. */}
      <span style={{ flex: 1, minWidth: 60, height: 14, background: "var(--bg-primary)",
                     border: "1px solid var(--border-primary)", position: "relative",
                     overflow: "hidden", borderRadius: "var(--r-0, 0px)" }}>
        <span style={{ display: "block", height: "100%", width: `${b.pct}%`, background: color,
                       opacity: 0.9, transition: "width 240ms ease" }} />

        {/* THE TARGET TICK — where 100% sits. Without it the bar shows a proportion with no visible
            reference, and "am I short?" has to be read out of the numbers instead of seen. Only
            drawn when a target exists; there is nothing to mark otherwise. */}
        {b.hasTarget && (
          <span style={{ position: "absolute", top: 0, right: 0, height: "100%", width: 2,
                         background: "var(--text-tertiary)", opacity: 0.55 }} />
        )}

        {/* OVER TARGET. The fill is clamped at 100%, so without this a category running 4.6x its
            target would look identical to one sitting exactly on it. */}
        {b.over && (
          <span style={{ position: "absolute", top: 0, right: 0, height: "100%", width: 8,
                         background: `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)` }} />
        )}
      </span>

      <span style={{ width: 104, flexShrink: 0, textAlign: "right" as const, fontSize: 12,
                     fontWeight: 700, fontFamily: "'DM Mono', monospace",
                     fontVariantNumeric: "tabular-nums",
                     color: b.hasTarget ? color : "var(--text-tertiary)", whiteSpace: "nowrap" }}>
        {b.label}
      </span>
    </div>
  );
}

export const HealthBar = memo(HealthBarImpl);
export default HealthBar;
