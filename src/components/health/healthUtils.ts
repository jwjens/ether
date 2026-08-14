// ── healthUtils — status → colour, and the words that go with it ────────────────────────────────
//
// Health Monitor redesign, Phase 1. Pure: no React, no IPC, so the mapping that decides whether an
// operator sees GREEN or RED is testable without rendering anything.
//
// The levels are the ones the back end already emits ('green' | 'yellow' | 'red' | 'grey') — see
// electron/runway.js:96 and electron/library-health.js:330. Nothing new is invented here; this maps
// them to tokens and to plain words.

export type HealthLevel = "green" | "yellow" | "red" | "grey";

/** The spec's palette, as tokens with literal fallbacks so a missing var never renders invisible. */
export const LEVEL_COLOR: Record<HealthLevel, string> = {
  green:  "var(--accent-green, #34d399)",
  yellow: "var(--accent-amber, #fbbf24)",
  red:    "var(--accent-red, #ef4444)",
  // GREY IS NOT A FAILURE. It means "nothing is meant to air / nothing measured yet" — a station
  // with no active show returns grey deliberately (runway.js:58). Colouring it red would alarm on a
  // normal state, and an alarm that is usually wrong is one people learn to ignore.
  grey:   "var(--text-tertiary, #6b7280)",
};

/** Anything unknown reads GREY, never green. Never claim health you have not measured. */
export function toLevel(v: unknown): HealthLevel {
  return v === "green" || v === "yellow" || v === "red" ? v : "grey";
}

export function levelColor(v: unknown): string {
  return LEVEL_COLOR[toLevel(v)];
}

/**
 * Runway → the big number on the card.
 *
 * `days` is null only when the level is grey (runway.js:48), so null is "not applicable", not zero —
 * and 0 days is a genuine, urgent value. They must not render the same.
 */
export function runwayValue(runway: { days?: number | null; capped?: boolean } | null | undefined):
  { value: string; sub: string } {
  if (!runway || runway.days == null) return { value: "—", sub: "no active show" };
  const d = runway.days;
  if (runway.capped) return { value: `${d}d+`, sub: "log runs past the horizon" };
  if (d < 1) {
    const h = Math.max(0, Math.round(d * 24));
    return { value: `${h}h`, sub: h <= 1 ? "runs out within the hour" : "runs out today" };
  }
  return { value: `${d}d`, sub: "until the first gap" };
}

/**
 * Rotation goals → a headline.
 *
 * `goals` is electron/library-health.js goalCheck(): { declared, totalCats, mismatches[] }.
 * `mismatches` is per CLOCK, not per category, so the count is clocks-with-a-problem.
 */
export function goalsValue(goals: { declared?: number; mismatches?: any[] } | null | undefined):
  { value: string; sub: string; level: HealthLevel } {
  if (!goals || !goals.declared) {
    return { value: "None", sub: "no rotation goals set", level: "grey" };
  }
  const bad = Array.isArray(goals.mismatches) ? goals.mismatches.length : 0;
  if (bad === 0) return { value: "On target", sub: `${goals.declared} categories declared`, level: "green" };
  return {
    value: `${bad} off`,
    sub: `${bad} clock${bad === 1 ? "" : "s"} do not match the declared goals`,
    // Amber, not red: an off-target clock is a programming choice to review, not dead air.
    level: "yellow",
  };
}

/** Queue depth → level. Thresholds mirror the runway idea: it is about time to react, not tidiness. */
export function queueLevel(len: number | null | undefined): HealthLevel {
  if (len == null) return "grey";
  if (len === 0) return "red";      // nothing queued behind what is on air
  if (len <= 2) return "yellow";
  return "green";
}

/** Designation → the card face. Mirrors generation-designation.js status(), which the row already uses. */
export function designationValue(
  // holder/holderName are nullable on the wire — generation-designation.js sets them to null when
  // there is no record. Accepting null here rather than at the call site keeps the caller honest.
  d: { state?: string; holderName?: string | null; holder?: string | null; level?: string } | null | undefined):
  { value: string; sub: string; level: HealthLevel } {
  const state = d && d.state ? d.state : "none";
  if (state === "mine")     return { value: "This machine", sub: "builds this station's log", level: toLevel(d?.level) };
  if (state === "other")    return { value: (d?.holderName || d?.holder || "Another machine"),
                                     sub: "this machine will not auto-generate", level: toLevel(d?.level) };
  if (state === "bypassed") return { value: "Bypassed", sub: "every switched-on machine generates", level: "yellow" };
  return { value: "None", sub: "no machine has claimed this station", level: "grey" };
}
