// Announcements: SECONDS on before-closing lines, and PLAYS IN A ROW (2026-10-04, Jeff).
//
// "at a set time" lines have fired to the second since 2026-08-26; "before closing" lines could only say whole
// minutes, so the top-of-hour announcement could not be moved off the legal ID by a few seconds. And a line can
// now say how many times it plays back to back (×3, ×5).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { offsetDueTime, repeatStartsMs, clampPlayCount, REPEAT_GAP_MS } = require_("./announce-time.js");

describe("offsetDueTime — closing time + minutes + seconds", () => {
  it("whole minutes still resolve exactly as before", () => {
    expect(offsetDueTime("18:00", -30, 0)).toBe("17:30:00");
    expect(offsetDueTime("23:50", 25, 0)).toBe("00:15:00");   // past midnight wraps
    expect(offsetDueTime("22:00", 0, 0)).toBe("22:00:00");
  });
  it("seconds AFTER: closing 01:00, +0 min +25 s → 01:00:25", () => {
    expect(offsetDueTime("01:00", 0, 25)).toBe("01:00:25");
  });
  it("seconds go with the minutes' sign: -30 min 15 s is 30:15 BEFORE close", () => {
    expect(offsetDueTime("18:00", -30, 15)).toBe("17:29:45");
  });
  it("a missing seconds value is :00 (every row written before this change)", () => {
    expect(offsetDueTime("18:00", -30, undefined)).toBe("17:30:00");
    expect(offsetDueTime("18:00", -30, null)).toBe("17:30:00");
  });
  it("no closing time → no fire (null), as before", () => {
    expect(offsetDueTime(null, -30, 10)).toBe(null);
    expect(offsetDueTime("", 0, 0)).toBe(null);
  });
  it("seconds before midnight wrap backwards", () => {
    expect(offsetDueTime("00:00", 0, -5)).toBe("23:59:55");
  });
});

describe("clampPlayCount", () => {
  it("defaults to 1 and stays within 1..20", () => {
    expect(clampPlayCount(undefined)).toBe(1);
    expect(clampPlayCount(null)).toBe(1);
    expect(clampPlayCount(0)).toBe(1);
    expect(clampPlayCount(3)).toBe(3);
    expect(clampPlayCount("5")).toBe(5);
    expect(clampPlayCount(99)).toBe(20);
    expect(clampPlayCount(2.7)).toBe(2);
  });
});

describe("repeatStartsMs — when each repeat starts, relative to the first play", () => {
  it("×1 → no repeats", () => {
    expect(repeatStartsMs(12.5, 1)).toEqual([]);
  });
  it("×3 of a 12.5 s file → two more, each after the previous ends plus the gap", () => {
    const d = 12500 + REPEAT_GAP_MS;
    expect(repeatStartsMs(12.5, 3)).toEqual([d, 2 * d]);
  });
  it("unknown length → no repeats (never guess a time and talk over the previous play)", () => {
    expect(repeatStartsMs(null, 3)).toEqual([]);
    expect(repeatStartsMs(0, 3)).toEqual([]);
    expect(repeatStartsMs(NaN, 3)).toEqual([]);
  });
});
