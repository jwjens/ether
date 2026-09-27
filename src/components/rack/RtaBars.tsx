// RtaBars — SLICE 8: the live spectrum as the OLD MASTER RACK DREW IT, at the fine resolution (docs/dsp-channel-rta.md).
//
// Jeff's ruling (2026-09-26, with the old MasterEQRack on screen): level-coloured bars with a glow and peak-hold
// markers — green / yellow / red by level, per band — never one flat colour; pre-rack faint, post-rack in full colour;
// the curve on top; the same component for the master and the channel.
//
//   · one bar per fine point (241, 24 per octave — the meter thread's wave), spanning the geometric midpoints to its
//     neighbours, on the CALLER'S own x (the curve's, or the GEQ's octave axis);
//   · the range follows the RUNNING PEAK like the old analyser (autoTop: the loudest recent point, 60 dB below it), and
//     the colour is set by HEIGHT in that range (LEVEL_STOPS): every bar is green at its base and only the loudest reach
//     yellow, amber and red — the old rack's colouring, per bar. The scale label says what the top really is in dBFS;
//   · POST-rack: full colour + a soft glow (the old bars' box-shadow); PRE-rack: the same colours, faint, no glow;
//   · PEAK HOLD: a thin white marker per point at its held level (the old rack's white peak line);
//   · the coarse region (below the engine's limit) is hatched; the whole layer takes no pointer events.
import React, { useId, useRef } from "react";
import { LEVEL_STOPS, BARS_RANGE_DB, autoTop, barY, fineEdges, fineFreq, coarseSpan, type RtaFrame } from "./rta";

interface Props {
  frame: RtaFrame;
  /** Held post-rack peaks per fine point (PEAK HOLD on), or null. */
  held: number[] | null;
  x: (f: number) => number;
  top: number;
  bottom: number;
  fMin: number;
  fMax: number;
  /** Draw the hatch over the coarse lows (the channel curve does; the GEQ strip is too short to need it). */
  hatch?: boolean;
  /** Draw the scale labels (top and bottom, dBFS) at this x, right-aligned — omit where the SVG is stretched. */
  labelX?: number;
}

export default function RtaBars({ frame, held, x, top, bottom, fMin, fMax, hatch = true, labelX }: Props) {
  const id = useId().replace(/:/g, "");
  const n = frame.fineN || frame.finePost?.length || 0;
  const lo = frame.fineLoHz || 20, hi = frame.fineHiHz || 20000;
  const bars: { x0: number; w: number; pre: number; post: number; hold: number | null }[] = [];
  for (let k = 0; k < n; k++) {
    const f = fineFreq(k, n, lo, hi);
    if (f < fMin || f > fMax) continue;
    const [e0, e1] = fineEdges(k, n);
    const x0 = x(Math.max(e0, fMin)), x1 = x(Math.min(e1, fMax));
    bars.push({ x0, w: Math.max(0.5, x1 - x0), pre: frame.finePre?.[k] ?? -120, post: frame.finePost?.[k] ?? -120, hold: held ? held[k] ?? null : null });
  }
  // THE RANGE follows the running peak (the old normaliser): the loudest bar, pre or post, sets it.
  let loudest = -120;
  for (const b of bars) { if (b.post > loudest) loudest = b.post; if (b.pre > loudest) loudest = b.pre; }
  const scale = useRef<{ ref: number | null; t: number }>({ ref: null, t: 0 });
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  const at = autoTop(scale.current.ref, loudest, scale.current.t ? (now - scale.current.t) / 1000 : 0);
  scale.current = { ref: at.ref, t: now };
  const topDb = at.topDb;
  const Y = (db: number) => barY(db, topDb, top, bottom);
  // a hair of gap between bars when there is room for one (the old rack's separated bars), none when they are dense
  const gap = (w: number) => (w > 3 ? 0.8 : w > 1.6 ? 0.35 : 0);
  const coarse = hatch ? coarseSpan(frame.coarseBelowHz, x, fMin) : null;
  return (
    <g pointerEvents="none">
      <defs>
        <linearGradient id={`${id}-lvl`} gradientUnits="userSpaceOnUse" x1={0} y1={top} x2={0} y2={bottom}>
          {LEVEL_STOPS.map(s => <stop key={s.at} offset={1 - s.at} stopColor={s.color} />)}
        </linearGradient>
        <filter id={`${id}-glow`} x="-5%" y="-10%" width="110%" height="120%">
          <feGaussianBlur stdDeviation={2.2} result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <pattern id={`${id}-hatch`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={6} stroke="var(--text-tertiary)" strokeWidth={1} opacity={0.35} />
        </pattern>
      </defs>
      {/* PRE-rack — faint */}
      <g fill={`url(#${id}-lvl)`} opacity={0.2}>
        {bars.map((b, i) => { const y = Y(b.pre); return <rect key={i} x={b.x0 + gap(b.w) / 2} y={y} width={b.w - gap(b.w)} height={Math.max(0, bottom - y)} />; })}
      </g>
      {/* POST-rack — full colour, glowing */}
      <g fill={`url(#${id}-lvl)`} filter={`url(#${id}-glow)`} opacity={0.95}>
        {bars.map((b, i) => { const y = Y(b.post); return <rect key={i} x={b.x0 + gap(b.w) / 2} y={y} width={b.w - gap(b.w)} height={Math.max(0, bottom - y)} />; })}
      </g>
      {/* PEAK HOLD — the white markers */}
      {held && (
        <g stroke="#ffffff" strokeWidth={1.5} opacity={0.85}>
          {bars.map((b, i) => b.hold == null || b.hold <= topDb - BARS_RANGE_DB ? null
            : <line key={i} x1={b.x0 + gap(b.w) / 2} x2={b.x0 + b.w - gap(b.w) / 2} y1={Y(b.hold)} y2={Y(b.hold)} />)}
        </g>
      )}
      {coarse && <rect x={coarse[0]} y={top} width={coarse[1] - coarse[0]} height={bottom - top} fill={`url(#${id}-hatch)`} />}
      {labelX != null && (
        <>
          <text x={labelX} y={top + 10} fontSize={9} textAnchor="end" fill="var(--text-tertiary)">{topDb} dBFS</text>
          <text x={labelX} y={bottom - 3} fontSize={9} textAnchor="end" fill="var(--text-tertiary)">{topDb - BARS_RANGE_DB}</text>
        </>
      )}
    </g>
  );
}
