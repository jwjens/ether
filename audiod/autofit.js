// ── AUTO-FITTER (§2.7) — deterministic look-ahead, NO LLM ─────────────────────────────────────────────
// Makes a SEAM land on a hard anchor so the top-of-hour cut has nothing left to chop.
//
// WHY, measured on 2026-07-30 at the 13:00 hard cut:
//   s1 Lovely Day                       13.5s on air when the cut fired
//   s2 Defying Gravity                  30.2s
//   s3 Come December                    78.5s
//   s4 What the World Needs Now Is Love 118.0s — 93s of a 211s song, chopped mid-vocal
// And on s4 the seam fell with 118s to the anchor while the pool held 115/123/124 — songs that fit the
// hole almost exactly. The content was fine; only the arithmetic against the clock was missing.
//
// THIS MODULE IS PURE. No DB, no engine, no clock of its own — every input is passed in, so the same
// inputs always give the same fit. That is what makes it benchable (audiod/smoke-autofit.js) and what
// lets it ship OBSERVATION-ONLY: the caller logs the decision and writes nothing.
//
// v1 SCOPE (approved 2026-07-30): SINGLE SWAP ONLY. A window no single swap can close is a logged
// no-fit; the hard cut backstops it. Two-row swaps are deferred to v2, to be decided on observation data
// about how often single-swap falls short.
//
// Design of record: docs/design-auto-fitter-2026-07-30.md
"use strict";

const FIT_TOLERANCE_SEC = 5;    // a seam within ±5s of the anchor counts as fitted
const LOOKAHEAD_SEC = 900;      // 15 minutes — enough rows to work with, near-term enough to be visible

const dur = (r) => (r && Number.isFinite(r.durationMs) ? r.durationMs / 1000 : 0);
const isMusic = (r) => !!r && r.contentClass !== "SPOT" && r.contentClass !== "JIN" && r.contentClass !== "SWP";

/** Rows that fall inside the window, and where the run arrives. Rows are consumed until the projected
 *  arrival reaches the anchor — those are the ones the fitter is allowed to adjust. */
function windowRows(seamTs, anchorTs, pending) {
  const rows = [];
  let t = seamTs;
  for (const r of pending) {
    if (t >= anchorTs) break;
    rows.push(r);
    t += dur(r);
  }
  return { rows, arrivalTs: t };
}

/**
 * Compute the fit for one window. PURE — returns a decision, changes nothing.
 *
 * @param seamTs     epoch seconds of the next seam
 * @param anchorTs   epoch seconds of the next hard anchor (top of hour, or a spot anchor)
 * @param pending    pending rows in play order (loggen item shape)
 * @param candidates ELIGIBLE replacement songs, already separation-filtered by the caller
 * @param opts       { toleranceSec, lookaheadSec }
 * @returns { mode, gapSec, arrivalTs, action, reason }
 *          mode: "out-of-window" | "no-rows" | "fitted" | "swap" | "insert" | "no-fit"
 */
function computeFit(seamTs, anchorTs, pending, candidates, opts = {}) {
  const tol = Number.isFinite(opts.toleranceSec) ? opts.toleranceSec : FIT_TOLERANCE_SEC;
  const look = Number.isFinite(opts.lookaheadSec) ? opts.lookaheadSec : LOOKAHEAD_SEC;
  const none = (mode, reason, extra) => ({ mode, gapSec: 0, arrivalTs: seamTs, action: null, reason, ...extra });

  if (!Number.isFinite(seamTs) || !Number.isFinite(anchorTs)) return none("out-of-window", "no anchor");
  if (anchorTs <= seamTs) return none("out-of-window", "anchor already passed");
  if ((anchorTs - seamTs) > look) return none("out-of-window", `anchor beyond ${look}s look-ahead`);
  if (!Array.isArray(pending) || pending.length === 0) return none("no-rows", "nothing pending");

  const { rows, arrivalTs } = windowRows(seamTs, anchorTs, pending);
  if (rows.length === 0) return none("no-rows", "no row starts before the anchor");

  const gapSec = arrivalTs - anchorTs;            // >0 overshoot (runs past), <0 undershoot (arrive early)
  const base = { gapSec, arrivalTs };
  if (Math.abs(gapSec) <= tol) return { mode: "fitted", ...base, action: null, reason: "already within tolerance" };

  const pool = (candidates || []).filter(c => c && dur(c) > 0);

  if (gapSec > 0) {
    // ── OVERSHOOT → swap one row for a shorter same-category song ──────────────────────────────────
    // Walk from the LAST row backwards: changing the latest row disturbs the least of what the operator
    // has already seen in Up Next. SPOT/JIN/SWP rows are never candidates for replacement.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!isMusic(row)) continue;
      const need = dur(row) - gapSec;             // the duration that would close the window exactly
      if (need <= 0) continue;                     // this row alone cannot absorb the overshoot
      const pick = bestBySize(pool, need, row);
      if (!pick) continue;
      const newGap = gapSec - (dur(row) - dur(pick));
      if (Math.abs(newGap) > tol) continue;        // does not actually fit — keep looking
      return {
        mode: "swap", ...base,
        action: { type: "swap", index: i, from: row, to: pick, newGapSec: newGap, newArrivalTs: anchorTs + newGap },
        reason: `overshoot +${Math.round(gapSec)}s`,
      };
    }
    return { mode: "no-fit", ...base, action: null,
      reason: `overshoot +${Math.round(gapSec)}s — no single swap fits (${pool.length} eligible)` };
  }

  // ── UNDERSHOOT → insert ONE short fill from the clock's current category ─────────────────────────
  // Prefer a fill that leaves a small OVERSHOOT over one that leaves a hole: an early seam is absorbed
  // by the segue overlap, and silence is never the answer.
  const need = -gapSec;
  const pick = bestBySize(pool, need, null, /* preferLonger */ true);
  if (pick) {
    const newGap = gapSec + dur(pick);
    if (Math.abs(newGap) <= tol) {
      return {
        mode: "insert", ...base,
        action: { type: "insert", index: rows.length, fill: pick, newGapSec: newGap, newArrivalTs: anchorTs + newGap },
        reason: `undershoot ${Math.round(gapSec)}s`,
      };
    }
  }
  return { mode: "no-fit", ...base, action: null,
    reason: `undershoot ${Math.round(gapSec)}s — no fill within tolerance (${pool.length} eligible)` };
}

/** Closest duration to `need`. Ties break toward the LONGER candidate when preferLonger (undershoot: a
 *  small overshoot beats a hole). `exclude` keeps a row from being swapped for itself. */
function bestBySize(pool, need, exclude, preferLonger) {
  let best = null, bestD = Infinity;
  for (const c of pool) {
    if (exclude && c.filePath && exclude.filePath && c.filePath === exclude.filePath) continue;
    const d = Math.abs(dur(c) - need);
    if (d < bestD - 1e-9) { best = c; bestD = d; }
    else if (Math.abs(d - bestD) <= 1e-9 && preferLonger && best && dur(c) > dur(best)) best = c;
  }
  return best;
}

/** The DECISION line — what the fitter did, or would have done. Observation-only callers log this and
 *  write nothing, so the wording says "would" until authoring is approved. */
function describeFit(fit, anchorTs, observationOnly) {
  const hhmm = (t) => new Date(t * 1000).toLocaleTimeString([], { hour12: false });
  const would = observationOnly ? "would have " : "";
  const secs = (s) => `${s >= 0 ? "+" : ""}${Math.round(s)}s`;
  if (!fit) return null;
  switch (fit.mode) {
    case "swap":
      return `autofit: window ${hhmm(anchorTs)} ${fit.reason} — ${would}swapped ` +
why(fit.action.from, fit.action.to) + `; arrival ${hhmm(fit.action.newArrivalTs)} (${secs(fit.action.newGapSec)})`;
    case "insert":
      return `autofit: window ${hhmm(anchorTs)} ${fit.reason} — ${would}inserted ` +
        `"${fit.action.fill.title || "(untitled)"}" (${Math.round(dur(fit.action.fill))}s); ` +
        `arrival ${hhmm(fit.action.newArrivalTs)} (${secs(fit.action.newGapSec)})`;
    case "no-fit":
      return `autofit: window ${hhmm(anchorTs)} ${fit.reason}; hard cut will trim`;
    default:
      return null;   // fitted / out-of-window / no-rows are not worth a line
  }
}
function why(from, to) {
  return `"${from.title || "(untitled)"}" (${Math.round(dur(from))}s) → "${to.title || "(untitled)"}" (${Math.round(dur(to))}s)`;
}

module.exports = { computeFit, describeFit, windowRows, FIT_TOLERANCE_SEC, LOOKAHEAD_SEC };
