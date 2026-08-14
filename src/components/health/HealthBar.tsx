// ── HealthBar — one rotation goal, as a bar ─────────────────────────────────────────────────────
//
// Health Monitor redesign, Phase 2. Category name · bar · "X/Y /hr".
//
// The rules live in healthUtils.barState() so the colours are testable without rendering. memo'd for
// the same reason as HealthCard: this sits in a panel that re-renders on deck ticks, and a list of
// bars repainting several times a second is worse than the wall of text it replaces.
import { memo } from "react";
import { barState, levelColor, type CategoryGoal } from "./healthUtils";

function HealthBarImpl({ goal }: { goal: CategoryGoal }) {
  const b = barState(goal);
  const color = levelColor(b.level);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3, 6px)", padding: "3px 0" }}
         title={b.hasTarget
           ? `${goal.category}: ${goal.actualSpinsPerHour} spins/hr over the last 24h against a target of ${goal.target}. ${goal.spins24h} spins counted.`
           : `${goal.category}: ${goal.actualSpinsPerHour} spins/hr over the last 24h. No target declared, so there is nothing to measure against.`}>
      <span style={{ width: 132, flexShrink: 0, fontSize: 11, color: "var(--text-secondary)",
                     overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {goal.category}
      </span>

      {/* The track. Fixed height, no radius — flat, like the rest of the app. */}
      <span style={{ flex: 1, minWidth: 40, height: 8, background: "var(--bg-tertiary)",
                     border: "1px solid var(--border-primary)", position: "relative", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${b.pct}%`, background: color,
                       transition: "width 240ms ease" }} />
        {/* OVER TARGET. The fill is clamped at 100%, so without this a category running 4.6x its
            target would look identical to one sitting exactly on it. A hatched cap is enough to say
            "there is more than fits here" without inventing a second scale. */}
        {b.over && (
          <span style={{ position: "absolute", top: 0, right: 0, height: "100%", width: 6,
                         background: `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)` }} />
        )}
      </span>

      <span style={{ width: 92, flexShrink: 0, textAlign: "right" as const, fontSize: 10,
                     fontFamily: "'DM Mono', monospace",
                     color: b.hasTarget ? color : "var(--text-tertiary)", whiteSpace: "nowrap" }}>
        {b.label}
      </span>
    </div>
  );
}

export const HealthBar = memo(HealthBarImpl);
export default HealthBar;
