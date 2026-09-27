// RtaBars — SLICE 8: the live spectrum in the Behringer X32 RTA look (docs/dsp-channel-rta.md, Jeff's reference 2026-09-27).
//
//   · ~120 DISCRETE bars, one per 1/12 octave from 20 Hz to 20 kHz (the meter thread's fine wave grouped — groupBars),
//     each with a small gap, on the caller's own x;
//   · colour by level, the X32 mapping: blue (low) → teal → green → yellow → RED only at the very top (LEVEL_STOPS),
//     set by height in the range so every bar is blue at its base;
//   · PRE-rack: the same colours, dimmed; POST-rack: full (drawn over it — where the rack cuts, the dimmed pre shows
//     above the post bar);
//   · PEAK HOLD: a thin white marker per bar (toggle as before);
//   · the range follows the running peak (autoTop, 60 dB), with the RTA's own dBFS scale on the right.
// RtaGrid is the X32 grid both graphs draw under it: frequency lines 20/40/60/80/100/200/…/20k labelled along the
// bottom, EQ dB lines −15…+15 labelled on the left. The same two components serve the channel curve and the master GEQ.
import React, { useId, useRef } from "react";
import { LEVEL_STOPS, BARS_RANGE_DB, autoTop, barY, groupBars, coarseSpan, type RtaFrame } from "./rta";
import { FREQ_GRID, DB_GRID, fmtGridF } from "./scopeAxis";

interface Props {
  frame: RtaFrame;
  /** Held post-rack peaks per FINE point (PEAK HOLD on), or null. */
  held: number[] | null;
  x: (f: number) => number;
  top: number;
  bottom: number;
  fMin: number;
  fMax: number;
  /** Hatch the coarse lows (bands narrower than 3 FFT bins). */
  hatch?: boolean;
  /** Draw the RTA's dBFS scale here (right-aligned), or omit. */
  labelX?: number;
}

export default function RtaBars({ frame, held, x, top, bottom, fMin, fMax, hatch = true, labelX }: Props) {
  const id = useId().replace(/:/g, "");
  const n = frame.fineN || frame.finePost?.length || 0;
  const lo = frame.fineLoHz || 20, hi = frame.fineHiHz || 20000;
  const post = groupBars(frame.finePost || [], n, lo, hi);
  const pre = groupBars(frame.finePre || [], n, lo, hi);
  const hold = held ? groupBars(held, n, lo, hi) : null;
  // THE RANGE follows the running peak (the loudest bar, pre or post).
  let loudest = -120;
  for (let i = 0; i < post.length; i++) loudest = Math.max(loudest, post[i].level, pre[i].level);
  const scale = useRef<{ ref: number | null; t: number }>({ ref: null, t: 0 });
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  const at = autoTop(scale.current.ref, loudest, scale.current.t ? (now - scale.current.t) / 1000 : 0);
  scale.current = { ref: at.ref, t: now };
  const topDb = at.topDb;
  const Y = (db: number) => barY(db, topDb, top, bottom);
  const geo = post.map(b => {
    const x0 = x(Math.max(b.lo, fMin)), x1 = x(Math.min(b.hi, fMax));
    const w = x1 - x0;
    const gap = Math.min(1.6, w * 0.25);                       // the X32's small gap between bars
    return { x: x0 + gap / 2, w: Math.max(0.4, w - gap), inside: b.hi > fMin && b.lo < fMax };
  });
  const coarse = hatch ? coarseSpan(frame.coarseBelowHz, x, fMin) : null;
  const labels = [0, 12, 24, 36, 48, 60].map(d => topDb - d);
  return (
    <g pointerEvents="none">
      <defs>
        <linearGradient id={`${id}-lvl`} gradientUnits="userSpaceOnUse" x1={0} y1={top} x2={0} y2={bottom}>
          {LEVEL_STOPS.map(s => <stop key={s.at} offset={1 - s.at} stopColor={s.color} />)}
        </linearGradient>
        <pattern id={`${id}-hatch`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={6} stroke="var(--text-tertiary)" strokeWidth={1} opacity={0.3} />
        </pattern>
      </defs>
      {/* PRE-rack — the same colours, dimmed */}
      <g fill={`url(#${id}-lvl)`} opacity={0.32}>
        {pre.map((b, i) => { if (!geo[i].inside) return null; const yy = Y(b.level); return <rect key={i} x={geo[i].x} y={yy} width={geo[i].w} height={Math.max(0, bottom - yy)} />; })}
      </g>
      {/* POST-rack — full */}
      <g fill={`url(#${id}-lvl)`}>
        {post.map((b, i) => { if (!geo[i].inside) return null; const yy = Y(b.level); return <rect key={i} x={geo[i].x} y={yy} width={geo[i].w} height={Math.max(0, bottom - yy)} />; })}
      </g>
      {/* PEAK HOLD — a thin marker per bar */}
      {hold && (
        <g stroke="#ffffff" strokeWidth={1.2} opacity={0.9}>
          {hold.map((b, i) => (!geo[i].inside || b.level <= topDb - BARS_RANGE_DB) ? null
            : <line key={i} x1={geo[i].x} x2={geo[i].x + geo[i].w} y1={Y(b.level)} y2={Y(b.level)} />)}
        </g>
      )}
      {coarse && <rect x={coarse[0]} y={top} width={coarse[1] - coarse[0]} height={bottom - top} fill={`url(#${id}-hatch)`} />}
      {labelX != null && labels.map((d, i) => (
        <text key={i} x={labelX} y={i === 0 ? top + 9 : i === labels.length - 1 ? bottom - 2 : Y(d) + 3} fontSize={9} textAnchor="end" fill="var(--text-tertiary)">
          {i === 0 ? `${d} dBFS` : d}
        </text>
      ))}
    </g>
  );
}

/** The X32 grid under the bars: frequency lines labelled along the bottom, EQ dB lines (−15…+15) on the left. */
export function RtaGrid({ x, y, left, right, top, bottom }: { x: (f: number) => number; y: (db: number) => number; left: number; right: number; top: number; bottom: number }) {
  return (
    <g pointerEvents="none">
      {FREQ_GRID.map(f => <line key={f} x1={x(f)} x2={x(f)} y1={top} y2={bottom} stroke="var(--scope-grid)" strokeWidth={f === 100 || f === 1000 || f === 10000 ? 1.2 : 0.8} />)}
      {FREQ_GRID.map(f => <text key={`t${f}`} x={x(f)} y={bottom + 14} fontSize={10} fontWeight={700} textAnchor="middle" fill="var(--text-secondary)">{fmtGridF(f)}</text>)}
      {DB_GRID.map(d => (
        <g key={d}>
          <line x1={left} x2={right} y1={y(d)} y2={y(d)} stroke="var(--scope-grid)" strokeWidth={d === 0 ? 1.4 : 0.8} />
          <text x={left - 5} y={y(d) + 3.5} fontSize={10} fontWeight={700} textAnchor="end" fill="var(--text-secondary)">{d === 0 ? "0dB" : d > 0 ? `+${d}` : `${d}`}</text>
        </g>
      ))}
    </g>
  );
}
