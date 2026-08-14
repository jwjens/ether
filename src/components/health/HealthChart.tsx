// ── HealthChart — runway over time ──────────────────────────────────────────────────────────────
//
// Health Monitor v2, the chart. Hand-rolled SVG: one <path> for the fill, one for the line, no
// dependency. docs/schedule-manager-v2-design-2026-08-10.md §0.3 records the renderer bundle at
// 2.49 MB "and warned about on every build"; recharts would add ~110 KB gzipped of d3 for this.
//
// WHY RUNWAY AND NOT SPINS: runway is a LEVEL — days of log remaining — so it moves gradually and is
// defined at every moment, which is what makes the reference dashboard's chart a curve. Spins per
// hour is a RATE, and these stations are on air 20–48% of hours, so an hourly spins chart over 7
// days is 87–134 zero buckets out of 168: a comb, not a curve. See the design doc §0.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { buildChart, hourLabel, type ChartPoint } from "./chartPath";
import { HealthSection } from "./HealthSection";
import { levelColor, toLevel } from "./healthUtils";

const W = 600, H = 90, PAD = 4;
const POLL_MS = 60_000;

interface RunwayPoint { at: number; days: number | null; level: string | null; sampled: boolean; }

function HealthChartImpl({ stationId, days = 7 }: { stationId?: number | null; days?: number }) {
  const [series, setSeries] = useState<RunwayPoint[]>([]);
  const [samples, setSamples] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await (window as any).ether?.invoke?.("health:runway-history", stationId ?? null, days);
      if (r && r.ok) { setSeries(Array.isArray(r.series) ? r.series : []); setSamples(r.samples || 0); setErr(null); }
      else setErr((r && r.error) || "could not read runway history");
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [stationId, days]);

  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);

  const pts: ChartPoint[] = useMemo(
    () => series.map(s => ({ at: s.at, value: s.days })), [series]);
  const geo = useMemo(() => buildChart(pts, W, H, PAD), [pts]);

  // The most recent real reading — the chart's headline, and the one the Runway card also shows.
  const latest = useMemo(() => {
    for (let i = series.length - 1; i >= 0; i--) if (series[i].days != null) return series[i];
    return null;
  }, [series]);
  const color = levelColor(toLevel(latest?.level));
  const hovered = hover != null ? geo.points[hover] : null;

  // How much of the window actually has data. Stated rather than implied: a chart drawn from six
  // hours of samples on a seven-day axis would otherwise look like six days of flat nothing.
  const coverageH = samples;
  const windowH = series.length || days * 24;

  return (
    <HealthSection
      title={`Runway · last ${days} days`}
      right={
        <span style={{ display: "flex", alignItems: "baseline", gap: "var(--s-3, 6px)" }}>
          {coverageH > 0 && coverageH < windowH * 0.5 && (
            <span style={{ fontSize: "var(--t-micro, 9px)", color: "var(--text-tertiary)" }}>
              {coverageH}h recorded of {windowH}h
            </span>
          )}
          <span style={{ fontSize: "var(--t-body, 12px)", fontWeight: 800, fontFamily: "'DM Mono', monospace", color }}>
            {latest?.days != null ? `${latest.days}d` : "—"}
          </span>
        </span>
      }>

      {err && <div style={{ fontSize: 11, color: "var(--accent-red)" }}>{err}</div>}

      {!err && geo.empty ? (
        // NOT an error, and it says why plus when it resolves. Runway was never stored before this
        // build, so there is genuinely nothing to show yet — the series starts now.
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
          Runway history starts from this build — it has never been recorded before, and it cannot be
          reconstructed, because past runway depended on schedules that have since been rewritten.
          A sample is taken every half hour, so the trend fills in from here and is complete after {days} days.
        </div>
      ) : !err && (
        <div style={{ position: "relative" }}
             onMouseLeave={() => setHover(null)}
             onMouseMove={(e) => {
               const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
               const frac = (e.clientX - box.left) / Math.max(1, box.width);
               const i = Math.round(frac * (geo.points.length - 1));
               setHover(Number.isFinite(i) ? Math.max(0, Math.min(geo.points.length - 1, i)) : null);
             }}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
               style={{ width: "100%", height: 90, display: "block" }}>
            <defs>
              <linearGradient id="runwayFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.30" />
                <stop offset="100%" stopColor={color} stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* The 1-day line — the level at which runway goes red. A trend chart without the
                threshold on it makes the operator do the comparison in their head. */}
            {geo.max > 1 && (
              <line x1="0" x2={W} y1={PAD + (H - PAD) * (1 - 1 / geo.max)} y2={PAD + (H - PAD) * (1 - 1 / geo.max)}
                    stroke="var(--accent-red)" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3 3"
                    vectorEffect="non-scaling-stroke" />
            )}

            {/* One pair of paths per unbroken run. A gap is NOT bridged — see chartPath.ts. */}
            {geo.segments.map((s, i) => (
              <g key={i}>
                <path d={s.area} fill="url(#runwayFill)" />
                <path d={s.line} fill="none" stroke={color} strokeWidth="1.5"
                      strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </g>
            ))}

            {hovered && (
              <line x1={hovered.x} x2={hovered.x} y1="0" y2={H} stroke="var(--text-tertiary)"
                    strokeOpacity="0.5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            )}
          </svg>

          {/* Axis: just the ends and the hovered reading. A dense time axis on a 90px chart is
              clutter, and the window is already named in the section title. */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline",
                        marginTop: "var(--s-2, 4px)", fontSize: "var(--t-micro, 9px)",
                        color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
            <span>{series.length ? hourLabel(series[0].at) : ""}</span>
            {hovered ? (
              <span style={{ color: "var(--text-secondary)" }}>
                {hourLabel(hovered.p.at)} · {hovered.p.value}d
              </span>
            ) : <span>{geo.max > 1 ? `peak ${Math.round(geo.max * 10) / 10}d · 1d floor dashed` : ""}</span>}
            <span>now</span>
          </div>
        </div>
      )}
    </HealthSection>
  );
}

export const HealthChart = memo(HealthChartImpl);
export default HealthChart;
