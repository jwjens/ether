'use strict';
// electron/log-edit-core.js — the gap-only fill rule, as pure functions.
//
// Manual Log Editing (Fix 2), design doc §3 Layer 3. Extracted rather than inlined in _commitDayRows
// because this rule decides WHICH GENERATED ROWS ARE THROWN AWAY, and a rule that silently discards
// too much (or too little) is invisible in the product until a DJ's day is wrong. It gets tests.
//
// The contract, in one line: a generated row may be inserted only if its time span does not overlap
// any surviving row.

/** Half-open overlap: [aStart, aEnd) vs [bStart, bEnd). Touching edges do NOT overlap. */
function overlaps(aStart, aDur, bStart, bDur) {
  const aEnd = aStart + (aDur || 0);
  const bEnd = bStart + (bDur || 0);
  // A zero-duration row still occupies its instant, or a spot with no duration would be
  // invisible to this rule and get double-booked.
  if (aEnd === aStart && bEnd === bStart) return aStart === bStart;
  if (aEnd === aStart) return aStart >= bStart && aStart < bEnd;
  if (bEnd === bStart) return bStart >= aStart && bStart < aEnd;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Drop every generated row that would land on top of a surviving (operator-owned) row.
 *
 * @param {Array} rows  freshly generated rows: { scheduled_at, duration_s }
 * @param {Array} kept  rows that survived the delete: { scheduled_at, duration_s }
 * @returns {{ fill: Array, skipped: Array }}
 */
function filterToGaps(rows, kept) {
  const list = Array.isArray(kept) ? kept : [];
  if (!list.length) return { fill: Array.isArray(rows) ? rows.slice() : [], skipped: [] };
  const fill = [], skipped = [];
  for (const r of (rows || [])) {
    const clash = list.some(k => overlaps(r.scheduled_at, r.duration_s, k.scheduled_at, k.duration_s));
    (clash ? skipped : fill).push(r);
  }
  return { fill, skipped };
}

// ── OWNERSHIP — an ALLOWLIST, after the 4.4.196 regression ──────────────────────────────────────
//
// This was "anything non-NULL is the operator's", justified as failing safe. IT DID NOT FAIL SAFE.
//
// `main.js:7208` stamps `source='auto'` on every row the unattended extender writes, as PROVENANCE —
// its own comment says the mark means "THIS machine generated these rows automatically". Reading any
// non-empty value as human-owned made every auto-extend row permanent: Generate could not delete or
// replace it, and gap-fill skipped anything overlapping it. The future log froze.
//
// Measured on the dev box 2026-08-13, three weeks after two songs were deleted: 729 future rows from
// 28 soft-deleted songs that Generate was unable to clear, and 438 plays recorded after their own
// delete timestamps.
//
// The design doc's Layer 1 table lists exactly two states — NULL (machine, "delete and replace
// freely") and 'operator' ("a human placed, moved or kept this"). So: allowlist, not denylist. A new
// provenance marker added later is machine-owned by default, which is the safe direction — the cost
// of a wrong "keep" is a log nobody can regenerate.
const OPERATOR_SOURCES = new Set(['operator']);

function isOperatorOwned(source) {
  return OPERATOR_SOURCES.has(String(source ?? '').trim().toLowerCase());
}

/**
 * The SAME rule as a SQL predicate, for the window delete in _commitDayRows.
 *
 * It lives here beside isOperatorOwned because the two DID drift, and the drift is the whole bug:
 * the delete used raw `source IS NULL` while isOperatorOwned said something different and was never
 * called by anything but its own test. One definition, both callers.
 */
const NOT_OPERATOR_OWNED_SQL =
  `(source IS NULL OR TRIM(LOWER(source)) NOT IN (${[...OPERATOR_SOURCES].map(s => `'${s}'`).join(', ')}))`;

module.exports = { overlaps, filterToGaps, isOperatorOwned, OPERATOR_SOURCES, NOT_OPERATOR_OWNED_SQL };
