// The gap-only fill rule decides which generated rows get thrown away on every Generate. Too greedy
// and Generate stops healing a day; too loose and a slot is double-booked and two songs claim the
// same minute. Neither is visible in the product until a DJ's day is already wrong.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { overlaps, filterToGaps, isOperatorOwned } = require_("./log-edit-core.js");

const row = (scheduled_at, duration_s) => ({ scheduled_at, duration_s });

describe("overlaps — half-open spans", () => {
  it("detects a plain overlap", () => {
    expect(overlaps(100, 60, 130, 60)).toBe(true);
    expect(overlaps(130, 60, 100, 60)).toBe(true);
  });

  it("treats touching edges as NOT overlapping — back-to-back songs are the normal case", () => {
    expect(overlaps(100, 60, 160, 60)).toBe(false);
    expect(overlaps(160, 60, 100, 60)).toBe(false);
  });

  it("detects full containment either way round", () => {
    expect(overlaps(100, 300, 150, 30)).toBe(true);
    expect(overlaps(150, 30, 100, 300)).toBe(true);
  });

  it("does not let a zero-duration row become invisible", () => {
    // A spot or talk break with no duration still occupies its instant. If this returned false, a
    // generated row would be laid straight on top of it.
    expect(overlaps(120, 0, 100, 60)).toBe(true);
    expect(overlaps(100, 60, 120, 0)).toBe(true);
    expect(overlaps(160, 0, 100, 60)).toBe(false);   // at the exclusive end — clear
    expect(overlaps(100, 0, 100, 0)).toBe(true);     // same instant
  });

  it("treats a missing duration as zero rather than NaN", () => {
    expect(overlaps(100, undefined, 100, undefined)).toBe(true);
    expect(overlaps(100, null, 500, null)).toBe(false);
  });
});

describe("filterToGaps", () => {
  it("keeps everything when nothing survived — the ordinary full regenerate", () => {
    const rows = [row(0, 60), row(60, 60)];
    const { fill, skipped } = filterToGaps(rows, []);
    expect(fill).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it("drops only the generated rows that would land on a survivor", () => {
    const rows = [row(0, 60), row(60, 60), row(120, 60), row(180, 60)];
    const kept = [row(70, 60)];                      // an operator row across the second slot
    const { fill, skipped } = filterToGaps(rows, kept);
    expect(fill.map(r => r.scheduled_at)).toEqual([0, 180]);   // 60 and 120 both touch 70..130
    expect(skipped).toHaveLength(2);
  });

  it("fills a gap left by a deleted row", () => {
    // The DJ deleted the 13:00 row; its span is free, so Generate refills exactly that hole.
    const rows = [row(0, 60), row(60, 60), row(120, 60)];
    const kept = [row(0, 60), row(120, 60)];
    const { fill } = filterToGaps(rows, kept);
    expect(fill.map(r => r.scheduled_at)).toEqual([60]);
  });

  it("never mutates its inputs", () => {
    const rows = [row(0, 60)], kept = [row(0, 60)];
    filterToGaps(rows, kept);
    expect(rows).toHaveLength(1);
    expect(kept).toHaveLength(1);
  });

  it("survives null/undefined without throwing", () => {
    expect(filterToGaps(null, null).fill).toEqual([]);
    expect(filterToGaps(undefined, undefined).fill).toEqual([]);
    expect(filterToGaps([row(0, 60)], undefined).fill).toHaveLength(1);
  });
});

describe("isOperatorOwned", () => {
  it("treats NULL as machine-generated and disposable", () => {
    expect(isOperatorOwned(null)).toBe(false);
    expect(isOperatorOwned(undefined)).toBe(false);
    expect(isOperatorOwned("")).toBe(false);
    expect(isOperatorOwned("   ")).toBe(false);      // legacy blank, not an owner
  });

  it("treats every non-empty marker as a human decision Generate must not undo", () => {
    // v34 documents 'operator' (jock deck-load) and 'autofit'. Both are decisions Generate did not
    // make, so both survive — being permissive here fails safe (a row is kept, never destroyed).
    expect(isOperatorOwned("operator")).toBe(true);
    expect(isOperatorOwned("autofit")).toBe(true);
    expect(isOperatorOwned("operator-edit")).toBe(true);
  });
});
