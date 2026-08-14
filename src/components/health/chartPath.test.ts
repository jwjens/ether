// The chart's geometry. Pure, so the arithmetic that decides what an operator sees can be checked
// without a DOM — and an off-by-one here draws a confidently wrong picture rather than crashing.
import { describe, it, expect } from "vitest";
import { buildChart, hourLabel, type ChartPoint } from "./chartPath";

const p = (value: number | null, at = 0): ChartPoint => ({ at, value });
const W = 100, H = 50;

describe("buildChart — the basics", () => {
  it("spreads points evenly across the width, oldest at x=0", () => {
    const g = buildChart([p(1), p(2), p(3)], W, H, 0);
    expect(g.points.map(c => c.x)).toEqual([0, 50, 100]);
  });

  it("puts a lone point in the middle rather than at NaN", () => {
    const g = buildChart([p(5)], W, H, 0);
    expect(g.points).toHaveLength(1);
    expect(g.points[0].x).toBe(50);
  });

  it("scales y against the max, with the peak at the top", () => {
    const g = buildChart([p(0), p(10)], W, H, 0);
    expect(g.max).toBe(10);
    expect(g.points[0].y).toBeCloseTo(H);   // zero sits on the floor
    expect(g.points[1].y).toBeCloseTo(0);   // the peak at the ceiling
  });

  it("never divides by zero on an all-zero series", () => {
    // A station that aired nothing would otherwise produce NaN coordinates and an INVISIBLE chart —
    // worse than an honest flat line, because nothing signals that anything is wrong.
    const g = buildChart([p(0), p(0), p(0)], W, H, 0);
    expect(g.max).toBe(1);
    for (const c of g.points) expect(Number.isFinite(c.y)).toBe(true);
    expect(g.empty).toBe(false);
  });

  it("closes the area down to the baseline so the fill sits under the line", () => {
    const g = buildChart([p(1), p(2)], W, H, 0);
    expect(g.segments).toHaveLength(1);
    expect(g.segments[0].area).toContain(`L${W.toFixed(2)},${H}`);
    expect(g.segments[0].area.endsWith("Z")).toBe(true);
  });
});

describe("buildChart — GAPS ARE NOT ZERO", () => {
  // The whole reason the geometry returns segments rather than one path. These stations are on air
  // 20-48% of hours, so gaps are the normal case; a line drawn across one asserts a runway that was
  // never measured.
  it("breaks the path at a null instead of bridging it", () => {
    const g = buildChart([p(1), p(2), p(null), p(3), p(4)], W, H, 0);
    expect(g.segments).toHaveLength(2);
    expect(g.points).toHaveLength(4);     // the null is not plotted
  });

  it("treats a leading or trailing null as no segment, not as a zero", () => {
    const g = buildChart([p(null), p(1), p(2), p(null)], W, H, 0);
    expect(g.segments).toHaveLength(1);
    expect(g.points).toHaveLength(2);
  });

  it("handles a series that is entirely gaps", () => {
    const g = buildChart([p(null), p(null)], W, H, 0);
    expect(g.empty).toBe(true);
    expect(g.segments).toHaveLength(0);
    expect(g.max).toBe(1);                 // still safe to divide by
  });

  it("keeps x positions tied to the INDEX, so a gap leaves a hole of the right width", () => {
    // If the gap collapsed, the remaining points would slide left and the chart would misdate every
    // reading after it.
    const g = buildChart([p(1), p(null), p(3)], W, H, 0);
    expect(g.points.map(c => c.x)).toEqual([0, 100]);
  });

  it("does not treat NaN or Infinity as a value", () => {
    const g = buildChart([p(1), p(NaN as any), p(Infinity as any), p(2)], W, H, 0);
    expect(g.points).toHaveLength(2);
    expect(g.segments).toHaveLength(2);
  });
});

describe("buildChart — junk input", () => {
  it("returns an empty geometry rather than throwing", () => {
    for (const bad of [[], null as any, undefined as any]) {
      const g = buildChart(bad, W, H);
      expect(g.empty).toBe(true);
      expect(g.max).toBe(1);
    }
  });

  it("survives malformed points", () => {
    const g = buildChart([null as any, {} as any, p(4)], W, H, 0);
    expect(g.points).toHaveLength(1);
  });
});

describe("hourLabel", () => {
  it("renders an hour, and never 'Invalid Date'", () => {
    expect(hourLabel(1786672800)).not.toContain("Invalid");
    expect(hourLabel(NaN)).toBe("");
  });
});
