// ── chartPath — the geometry behind the area chart ──────────────────────────────────────────────
//
// Pure. No React, no SVG element, no dependency. An area chart of 24 points is one path command and
// some arithmetic; pulling in recharts (and d3-scale/shape/array with it) would add ~100 KB gzipped
// to a renderer bundle that docs/schedule-manager-v2-design-2026-08-10.md §0.3 already records at
// 2.49 MB and warned about on every build.
//
// Separated from the component so the maths — which is where an off-by-one silently draws a
// misleading picture — can be tested.

export interface ChartPoint {
  at: number;
  /** The plotted value. null = nothing to plot at this instant, which is NOT zero. */
  value: number | null;
}

export interface ChartSegment { line: string; area: string; }

export interface ChartGeometry {
  /** One entry per unbroken run of data. A gap in the series BREAKS the path rather than being
   *  bridged — see buildChart. */
  segments: ChartSegment[];
  /** Highest value — the y-axis top. Never below 1, so a flat-zero series draws a floor instead of
   *  dividing by zero. */
  max: number;
  /** Coordinates of the plotted points, for dots and hit targets. */
  points: { x: number; y: number; p: ChartPoint }[];
  /** True when nothing at all could be plotted. */
  empty: boolean;
}

/**
 * Build the path geometry for an area chart.
 *
 * A NULL VALUE BREAKS THE LINE. It does not become zero and the path is not drawn across it. This is
 * the whole reason the geometry is a list of segments rather than one path: a gap means "no
 * observation here" — the app was not running, or the station had no active show — and a line drawn
 * straight across it would assert a runway that was never measured. On this data that matters: the
 * stations are on air 20–48% of hours, so gaps are the normal case, not the exception.
 *
 * @param data   left-to-right, oldest first
 * @param w / h  the viewBox, in the units the caller renders at
 * @param pad    top padding so a peak is not flush against the edge
 */
export function buildChart(data: ChartPoint[], w: number, h: number, pad = 2): ChartGeometry {
  const pts = Array.isArray(data) ? data : [];
  if (pts.length === 0) return { segments: [], max: 1, points: [], empty: true };

  const values = pts.map(p => p?.value).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (values.length === 0) return { segments: [], max: 1, points: [], empty: true };

  // max never below 1: a series that is entirely zero would otherwise divide by zero and render as
  // NaN — an invisible chart rather than an honest flat line along the floor.
  const max = Math.max(1, ...values);
  const usableH = Math.max(1, h - pad);
  const stepX = pts.length > 1 ? w / (pts.length - 1) : 0;

  const coords: { x: number; y: number; p: ChartPoint }[] = [];
  const segments: ChartSegment[] = [];
  let run: { x: number; y: number }[] = [];

  const flush = () => {
    if (run.length === 0) return;
    // A lone point has no line to draw, but it still deserves a dot — handled by `points`.
    const line = run.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");
    const area = `${line} L${run[run.length - 1].x.toFixed(2)},${h} L${run[0].x.toFixed(2)},${h} Z`;
    segments.push({ line, area });
    run = [];
  };

  pts.forEach((p, i) => {
    const v = p?.value;
    if (typeof v !== "number" || !Number.isFinite(v)) { flush(); return; }   // gap → break the path
    const x = pts.length > 1 ? i * stepX : w / 2;
    const y = pad + (usableH - (v / max) * usableH);
    run.push({ x, y });
    coords.push({ x, y, p });
  });
  flush();

  return { segments, max, points: coords, empty: coords.length === 0 };
}

/**
 * "8 PM" — hour labels for the axis, in the operator's own locale.
 *
 * The isNaN guard is load-bearing and a try/catch does NOT replace it: toLocaleTimeString on an
 * invalid Date does not throw, it cheerfully returns the string "Invalid Date", which would then be
 * rendered onto the axis.
 */
export function hourLabel(at: number): string {
  if (!Number.isFinite(at)) return "";
  try {
    const d = new Date(at * 1000);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "numeric" });
  } catch { return ""; }
}
