// GeqGraph — SLICE 8: the master GEQ's X32-look graph (docs/dsp-channel-rta.md): the SAME axis, grid and RTA bars as
// the channel EqCurve (scopeAxis + RtaGrid + RtaBars), the GEQ's response in yellow on top — computed from the
// engine's own filters (scopeAxis.geqResponseDb mirrors eq.rs set_peaking) — and a numbered marker at every fader's
// position (its band's frequency, its gain). The faders below it stay the controls.
import React from "react";
import type { RtaFrame } from "./rta";
import RtaBars, { RtaGrid } from "./RtaBars";
import { W, H, PL, PR, PT, PB, F0, F1, x, y, FREQS, CURVE_COLOR, GEQ_FREQS, geqResponseDb } from "./scopeAxis";

export default function GeqGraph({ bands, on, frame, held }: { bands: number[]; on: boolean; frame: RtaFrame | null; held: number[] | null }) {
  const curve = FREQS.map(f => (on ? geqResponseDb(bands, f) : 0));
  const d = curve.map((v, i) => `${i ? "L" : "M"}${x(FREQS[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", background: "var(--bg-primary)", border: "1px solid var(--border-primary)" }}
         aria-label="Master GEQ: live spectrum and the EQ curve">
      <RtaGrid x={x} y={y} left={PL} right={W - PR} top={PT} bottom={H - PB} />
      {frame?.fed
        ? <RtaBars frame={frame} held={held} x={x} top={PT} bottom={H - PB} fMin={F0} fMax={F1} labelX={W - 3} />
        : <text x={(PL + W - PR) / 2} y={H - PB - 10} fontSize={11} fontWeight={800} textAnchor="middle" fill="var(--text-tertiary)">SPECTRUM — NOT FED (nothing is playing)</text>}
      <path d={d} fill="none" stroke={CURVE_COLOR} strokeWidth={2.5} opacity={on ? 1 : 0.4} strokeDasharray={on ? undefined : "6 5"} />
      {GEQ_FREQS.map((f, i) => {
        const g = bands[i] ?? 0;
        const cx = x(f), cy = y(on ? geqResponseDb(bands, f) : 0);
        return (
          <g key={i} pointerEvents="none">
            <line x1={cx} x2={cx} y1={PT} y2={H - PB} stroke={CURVE_COLOR} strokeWidth={0.8} opacity={Math.abs(g) > 0.05 ? 0.35 : 0.12} />
            <circle cx={cx} cy={cy} r={8} fill={Math.abs(g) > 0.05 ? CURVE_COLOR : "var(--bg-primary)"} stroke={CURVE_COLOR} strokeWidth={1.5} />
            <text x={cx} y={cy + 3.5} fontSize={9} fontWeight={900} textAnchor="middle" fill={Math.abs(g) > 0.05 ? "var(--bg-primary)" : CURVE_COLOR}>{i + 1}</text>
          </g>
        );
      })}
    </svg>
  );
}
