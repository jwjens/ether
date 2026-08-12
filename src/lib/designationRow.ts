// ── designationRow — what the Designated generator row and its button say (2026-08-12) ──────────
//
// Extracted from HealthMonitor so these rules can be tested without a DOM, the same way kvFlag.ts
// was extracted after the auto-generate toggle shipped broken twice. The rules are small and the
// consequences of getting them wrong are not: 4.4.193 shipped a REFRESH NOW button that read
// successfully, changed nothing on screen, and offered no reason — Jeff's report was that the button
// appears broken.
//
// THE RULE THAT MATTERS: a machine with auto-generate OFF can never take the designation
// (electron/generation-designation.js decide() → action 'observe'). That is correct behaviour, not a
// fault. But correct behaviour that looks identical to a dead control is a defect in the product,
// because the operator cannot tell them apart.
//
// UNREADABLE IS NOT OFF. `null` means we could not read the stored flag, and treating it as OFF
// would disable the one control that could tell the operator what is actually stored.

export type AutoOn = boolean | null;

/** The tick's own view of a station, as returned by `designation:status` / `designation:refresh`. */
export interface DesignationStatus {
  state?: "mine" | "other" | "none" | "bypassed";
  level?: "green" | "yellow" | "red" | "grey";
  text?: string;
  holder?: string | null;
  holderName?: string | null;
  lastGenerated?: number | null;
  /** The stored auto-generate flag AS THE TICK READ IT when it made the decision. */
  autoOn?: boolean;
  /** The decider's own words — why it designated, stamped, observed, or skipped. */
  reason?: string;
  writeError?: string | null;
}

export const BLOCKED_NOTE = "Auto-gen off – cannot designate";

/**
 * Which auto-generate reading to trust.
 *
 * The live toggle map wins whenever it has a definite answer, because it updates the instant the
 * operator flips AUTO ON. The tick's copy is only as fresh as the last tick, so trusting it first
 * would leave the button disabled at exactly the moment the operator needs it — immediately after
 * switching auto-generation on, which is the one time they will click REFRESH NOW.
 */
export function effectiveAutoOn(live: AutoOn | undefined, d?: DesignationStatus | null): AutoOn {
  if (typeof live === "boolean") return live;
  if (d && typeof d.autoOn === "boolean") return d.autoOn;
  return null;
}

/**
 * The confirmation shown after a successful REFRESH NOW.
 *
 * WHY THIS EXISTS: the only feedback a click produced was the "Designation read …" stamp resetting to
 * 0 — and that stamp ALSO resets every 30 seconds on the background poll, so it carried no
 * information about the click at all. The operator could not distinguish "my click worked" from
 * "the poll happened to fire". A banner is the click's own evidence.
 */
export interface RefreshBanner {
  tone: "success" | "neutral";
  text: string;
}

export function refreshBanner(d: DesignationStatus | null | undefined): RefreshBanner {
  const state = d && d.state ? d.state : "none";
  if (state === "mine") return { tone: "success", text: "Designation refreshed – this machine is designated" };
  if (state === "other") {
    const who = (d && (d.holderName || d.holder)) || "another machine";
    return { tone: "success", text: `Designation refreshed – ${who} is designated` };
  }
  if (state === "bypassed") return { tone: "neutral", text: "Designation refreshed – designation is bypassed on this station" };
  return { tone: "neutral", text: "Designation refreshed – no machine is designated" };
}

export interface DesignationView {
  /** The value shown on the "Designated generator" row. */
  value: string;
  /** HealthRow status token. */
  status: "ok" | "warn" | "error";
  /** True when this machine cannot designate, so the button is disabled and says why. */
  blocked: boolean;
  buttonLabel: string;
  buttonTitle: string;
  buttonDisabled: boolean;
  /** The explanatory line under the row — never a bare "None". */
  sub: string;
  /** Shown beside the button when blocked; null otherwise. */
  note: string | null;
}

export function designationView(
  d: DesignationStatus | null | undefined,
  autoOn: AutoOn | undefined,
  busy: boolean,
): DesignationView {
  const state = d && d.state ? d.state : "none";
  const level = d && d.level ? d.level : "grey";
  const status = level === "red" ? "error" : level === "yellow" ? "warn" : "ok";

  const value =
    state === "mine" ? "This machine"
    : state === "other" ? ((d && d.holderName) || "Another machine")
    : state === "bypassed" ? "Bypassed"
    : "None";

  const eff = effectiveAutoOn(autoOn, d);
  // Only a DEFINITE off blocks. See the header: unreadable is not off.
  const blocked = eff === false;

  const fallback = "none — no machine has auto-generated this station yet";
  const sub =
    state === "none" && blocked
      ? "Auto-generate is off for this station on this machine, so it will not take the designation. " +
        "Nothing is wrong — turn AUTO ON for this station to designate this machine."
      : (d && d.text) || fallback;

  const buttonTitle = blocked
    ? "Auto-gen off – cannot designate. A machine with auto-generate off never takes the designation, " +
      "so there is nothing to check in. Turn AUTO ON for this station first."
    : busy
      ? "Re-reading the designation record…"
      : "Re-read the designation record and check in now. Refreshes ownership state; it does not force a full sync cycle.";

  return {
    value,
    status,
    blocked,
    // "REFRESHING…" spells out what is happening. The old label was a bare "…", which at the speed
    // of a local IPC round trip is a flicker rather than a loading state.
    buttonLabel: busy ? "REFRESHING…" : "REFRESH NOW",
    buttonTitle,
    buttonDisabled: busy || blocked,
    sub,
    note: blocked ? BLOCKED_NOTE : null,
  };
}
