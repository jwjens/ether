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

/**
 * Is this row the operator's? Anything non-NULL is owned by a human decision and is not Generate's
 * to remove. NULL (and the legacy empty string) mean machine-generated and disposable.
 *
 * Deliberately permissive about WHICH marker: v34 documents 'operator' (jock deck-load) and 'autofit'.
 * Both are decisions Generate did not make, so both survive.
 */
function isOperatorOwned(source) {
  return source != null && String(source).trim() !== '';
}

module.exports = { overlaps, filterToGaps, isOperatorOwned };
