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
export function runwayValue(
  runway: { days?: number | null; capped?: boolean } | null | undefined,
  /** False when there is no health snapshot for this station YET. "Not measured" and "measured, and
   *  there is no active show" are different statements, and printing the second for the first is a
   *  claim the panel has not earned — it renders as a fault on a station that is perfectly fine. */
  measured = true,
): { value: string; sub: string } {
  if (!measured) return { value: "—", sub: "waiting for the first health check" };
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
/**
 * Rotation health → the card face. THE NUMBER OF MISMATCHES, per spec: green 0, yellow 1–2, red >2.
 *
 * A mismatch is one CLOCK whose music composition does not match the declared goals — not one
 * category — because that is what goalCheck() counts (library-health.js).
 */
export function goalsValue(goals: { declared?: number; mismatches?: any[] } | null | undefined):
  { value: string; sub: string; level: HealthLevel } {
  if (!goals || !goals.declared) {
    return { value: "None", sub: "no rotation goals set", level: "grey" };
  }
  const bad = Array.isArray(goals.mismatches) ? goals.mismatches.length : 0;
  if (bad === 0) return { value: "0", sub: `on target · ${goals.declared} categories declared`, level: "green" };
  return {
    value: String(bad),
    sub: `clock${bad === 1 ? "" : "s"} off the declared goals`,
    level: bad > 2 ? "red" : "yellow",
  };
}

/**
 * Queue depth → level: green ≥10, yellow 5–9, red <5.
 *
 * Deeper thresholds than the first cut used, and the reason is time rather than tidiness: at roughly
 * 3.5 minutes a track, ten items is about half an hour of cover and five is under twenty minutes —
 * which is how long an operator has to notice and act before it matters.
 */
export function queueLevel(len: number | null | undefined): HealthLevel {
  if (len == null) return "grey";   // the engine did not answer; that is not an empty queue
  if (len < 5) return "red";
  if (len < 10) return "yellow";
  return "green";
}

export interface CategoryGoal {
  categoryId: number;
  category: string;
  /** null when the PD has not declared one. NEVER 0 — see library-health.js goalCheck. */
  target: number | null;
  spins24h: number;
  actualSpinsPerHour: number;
}

export interface BarState {
  /** 0–100, clamped. */
  pct: number;
  level: HealthLevel;
  /** The right-hand figure, e.g. "4.2/4 spins/hr". */
  label: string;
  hasTarget: boolean;
  /** actual exceeds target — the bar is clamped, so this is how "over" stays visible. */
  over: boolean;
}

/**
 * One rotation bar.
 *
 * Thresholds are the spec's: green at or above target, yellow within 2 below, red more than 2 below.
 * So the scale measures UNDER-rotation — a category above its target is green. That is a defensible
 * PD reading (a goal is a floor), but it means a category running well over target also reads green,
 * which is why `over` exists and why the label always shows BOTH numbers. The colour answers "am I
 * short?"; the numbers let an operator see the whole truth.
 *
 * NO TARGET IS NOT A FAILURE, and not a zero either. Most categories on real stations have no
 * declared target (measured 2026-08-13: 1 of 10 on station 1, 1 of 2 on station 2, none on 3 or 4).
 * Dividing by a missing target would be an Infinity or a NaN; judging against one that does not
 * exist would be a claim nobody made. Such a bar renders grey and empty, with the actual stated.
 */
export function barState(g: CategoryGoal): BarState {
  const actual = Number.isFinite(g.actualSpinsPerHour) ? g.actualSpinsPerHour : 0;
  const target = g.target != null && g.target > 0 ? g.target : null;

  if (target == null) {
    return {
      pct: 0, level: "grey", hasTarget: false, over: false,
      label: `${actual} /hr · no target`,
    };
  }
  const ratio = actual / target;
  const level: HealthLevel = actual >= target ? "green"
                           : actual >= target - 2 ? "yellow"
                           : "red";
  return {
    pct: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    level,
    hasTarget: true,
    over: actual > target,
    label: `${actual}/${target} /hr`,
  };
}

/** True when not one category has a declared target — the "No rotation goals set" state. */
export function noGoalsDeclared(cats: CategoryGoal[] | null | undefined): boolean {
  return !cats || cats.length === 0 || cats.every(c => c.target == null || c.target <= 0);
}

// ── EVENT SEVERITY (Phase 3) ────────────────────────────────────────────────────────────────────
//
// The ledger records ~25 kinds and carries no severity of its own, so the timeline has to classify.
// Matched on the KIND, not on free text, because the kind is a stable contract and a message is not.
//
// The bias is deliberate: an event is ROUTINE unless it names something that went wrong. A timeline
// where most lines are amber is one nobody reads, which is how the wall of text got ignored in the
// first place.

/** Something failed, was lost, or fell back to an emergency path. */
const EVENT_RED = /(-failed$|^sync-misconfigured|-down$|floor|dead-air|not-saved|write-failed|error)/i;
/** Something is degraded or was bent to keep going — worth a look, not an alarm. */
const EVENT_YELLOW = /(missed|starved|relaxed|behind|skipped|stale|migrated|bypass|drift)/i;

/**
 * PERIODIC SENSES — recorded for the record, not for a timeline.
 *
 * These fire on a timer and carry a whole nested snapshot as their payload, so there is nothing to
 * put on a one-line row: eight consecutive "Library health" entries with blank detail is exactly the
 * wall of text the dashboard exists to replace. Measured on the dev ledger 2026-08-13:
 *
 *   library-health  1,906     queue-lint  1,519     ← ~85% of every event ever written
 *   logreader-missed  397     log-edit       15
 *
 * They are HIDDEN BY DEFAULT, never dropped — the timeline offers ALL, so nothing is concealed, it
 * is just not the first thing shown. A feed where 85% of the rows are heartbeats is one nobody reads,
 * and an unread panel is the same as no panel.
 */
export const ROUTINE_KINDS = new Set([
  "library-health",
  "queue-lint",
  "position-authority",
  "generate-timing",
]);

export function isRoutine(kind: string | null | undefined): boolean {
  return ROUTINE_KINDS.has(String(kind || ""));
}

export function eventLevel(kind: string | null | undefined): HealthLevel {
  const k = String(kind || "");
  if (!k) return "grey";
  if (EVENT_RED.test(k)) return "red";
  if (EVENT_YELLOW.test(k)) return "yellow";
  return "green";
}

/** A kind like `auto-extend-skipped-not-designated` → "Auto extend skipped not designated". */
export function eventTitle(kind: string | null | undefined): string {
  const k = String(kind || "").trim();
  if (!k) return "event";
  const s = k.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The one-line summary beside the timestamp.
 *
 * Prefers fields that say something specific — a station name, a reason, an error — over dumping the
 * whole payload. An event whose detail is only machine ids reads as noise on a timeline; the
 * expanded view still has everything.
 */
export function eventSummary(e: Record<string, any> | null | undefined): string {
  if (!e || typeof e !== "object") return "";
  const bits: string[] = [];

  // The periodic senses carry a nested snapshot rather than a message, so pull the one fact worth a
  // row: how many stations were measured and whether any of them is not green. Without this they
  // render as a title and nothing else, which is what made the list unreadable.
  if (e.kind === "library-health" && Array.isArray(e.stations)) {
    const n = e.stations.length;
    const bad = e.stations.filter((s: any) => s?.level === "red" || s?.level === "yellow");
    return bad.length
      ? `${n} stations · ${bad.map((s: any) => `${s.name || s.stationId} ${s.level}`).join(", ")}`
      : `${n} stations · all green`;
  }

  // Which station, by name if the event carries one and by id if not. Most daemon-side events carry
  // only stationId — logreader-missed is {stationId, count, driftSec} and nothing else, which is why
  // ten consecutive rows rendered with a title and a blank line.
  if (e.station) bits.push(String(e.station));
  else if (e.stationId != null) bits.push(`s${e.stationId}`);

  const detail = e.message || e.error || e.reason || e.text;
  if (detail) bits.push(String(detail));
  else {
    // Numbers that mean something on their own, in the order an operator would want them.
    if (e.count != null) bits.push(`${e.count} row${e.count === 1 ? "" : "s"}`);
    if (e.rows != null) bits.push(`${e.rows} rows`);
    if (e.keptRows != null) bits.push(`${e.keptRows} operator rows kept`);
    if (e.skippedGeneratedRows != null) bits.push(`${e.skippedGeneratedRows} skipped`);
    if (e.runwayDaysAfter != null) bits.push(`runway ${e.runwayDaysAfter}d`);
    if (e.driftSec != null) bits.push(`drift ${e.driftSec}s`);
    if (e.from != null || e.to != null) bits.push(`${e.from || "none"} → ${e.to || "none"}`);
    if (e.failures != null) bits.push(`${e.failures} failures`);
    if (e.action) bits.push(String(e.action));
    if (e.state) bits.push(String(e.state));
  }

  // LAST RESORT: a timeline row must never be blank. Whatever scalar fields remain get shown rather
  // than leaving the operator with a title and empty space — which is precisely how the first cut of
  // this list turned into a wall of identical-looking rows.
  if (!bits.length) {
    const skip = new Set(["t", "kind", "event", "uuid", "initiatedBy", "thisMachine",
                          "holder", "machineId", "stationUuid"]);
    for (const [k, v] of Object.entries(e)) {
      if (skip.has(k) || v == null || typeof v === "object") continue;
      bits.push(`${k} ${v}`);
      if (bits.length >= 3) break;
    }
  }
  return bits.join(" · ");
}

/** HH:MM:SS from the ledger's ISO stamp. Returns "" rather than "Invalid Date". */
export function eventTime(t: unknown): string {
  try {
    const d = new Date(String(t));
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ""; }
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
