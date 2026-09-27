// ── DynCurve — the channel dynamics as a TRANSFER GRAPH (Slice 6, docs/dsp-channel-dynamics.md §2) ────────────────
//
// The spec's Wheatstone dynamics view: input dB (x) against output dB (y), the UNITY DIAGONAL in grey, each module's
// own curve faint (gate / compressor overlaid), and the RESULTING CURVE in orange — the whole chain as the engine
// runs it (dynMath.ts, pinned to rack.rs at 1e-9). Thresholds are drawn and draggable sideways; the gate's depth
// floor is drawn with the spec's 14 / 20 dB guidance marks. A live dot shows where the channel is on the curve now:
// its level (the pre-rack meter) and the engine's gain reduction (the meter bus's chDyn).
import React, { useRef, useState } from "react";
import type { GateModule, CompModule } from "./rackTypes";
import { compGrDb, gateGrDb, chainOutDb, COMP, GATE, GATE_DEPTH_GUIDE } from "./dynMath";

const W = 420, H = 320, PL = 40, PR = 10, PT = 10, PB = 28;
const LO = -70, HI = 10;
const x = (db: number) => PL + ((db - LO) / (HI - LO)) * (W - PL - PR);
const y = (db: number) => PT + ((HI - Math.max(LO, Math.min(HI, db))) / (HI - LO)) * (H - PT - PB);
const dbOf = (px: number) => LO + ((px - PL) / (W - PL - PR)) * (HI - LO);
const XS = Array.from({ length: 161 }, (_, i) => LO + (i * (HI - LO)) / 160);
const path = (f: (v: number) => number) => XS.map((v, i) => `${i ? "L" : "M"}${x(v).toFixed(1)},${y(f(v)).toFixed(1)}`).join("");

interface Props {
  gate: GateModule | null; gateIn: boolean;
  comp: CompModule | null; compIn: boolean;
  onGate: (g: GateModule) => void; onComp: (c: CompModule) => void;
  /** The live operating point: the channel's level (dBFS) and the engine's gate + comp GR (dB). null = no signal. */
  live: { level: number; gateGr: number; compGr: number } | null;
}

export default function DynCurve({ gate, gateIn, comp, compIn, onGate, onComp, live }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<null | "gate" | "comp">(null);
  const g = gate && gateIn ? gate : null, c = comp && compIn ? comp : null;
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const r = svgRef.current!.getBoundingClientRect();
    const v = Math.round(dbOf(((e.clientX - r.left) * W) / r.width));
    if (drag === "gate" && gate) onGate({ ...gate, threshold: Math.max(GATE.threshold[0], Math.min(GATE.threshold[1], v)) });
    if (drag === "comp" && comp) onComp({ ...comp, threshold: Math.max(COMP.threshold[0], Math.min(COMP.threshold[1], v)) });
  };
  const handle = (which: "gate" | "comp", t: number, on: boolean, colour: string) => (
    <g key={which} onPointerDown={e => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); setDrag(which); }}
       style={{ cursor: "ew-resize" }}>
      <rect x={x(t) - 22} y={PT} width={44} height={H - PT - PB} fill="transparent" />
      <line x1={x(t)} x2={x(t)} y1={PT} y2={H - PB} stroke={colour} strokeWidth={1.5} strokeDasharray={on ? "4 3" : "2 5"} opacity={on ? 0.9 : 0.45} />
      <text x={x(t) + 4} y={which === "gate" ? H - PB - 6 : PT + 12} fontSize={10} fontWeight={800} fill={colour}>
        {which === "gate" ? "GATE" : "COMP"} {t.toFixed(0)} dB{on ? "" : " · OUT"}
      </text>
    </g>
  );
  const liveOut = live ? (live.level - live.gateGr - live.compGr + (c ? c.makeup : 0)) : null;
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 520, height: "auto", display: "block", touchAction: "none",
         background: "var(--bg-primary)", border: "1px solid var(--border-primary)" }}
         onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
      {[-60, -40, -20, 0].map(d => (
        <g key={d}>
          <line x1={x(d)} x2={x(d)} y1={PT} y2={H - PB} stroke="var(--border-primary)" />
          <line x1={PL} x2={W - PR} y1={y(d)} y2={y(d)} stroke="var(--border-primary)" />
          <text x={x(d)} y={H - 10} fontSize={10} textAnchor="middle" fill="var(--text-tertiary)">{d}</text>
          <text x={PL - 5} y={y(d) + 4} fontSize={10} textAnchor="end" fill="var(--text-tertiary)">{d}</text>
        </g>
      ))}
      <text x={(PL + W - PR) / 2} y={H - 1} fontSize={9} textAnchor="middle" fill="var(--text-tertiary)">IN dB</text>
      {/* unity (grey) */}
      <path d={path(v => v)} stroke="var(--text-tertiary)" strokeWidth={1} fill="none" opacity={0.6} />
      {/* the gate's depth floor + the spec's 14 / 20 dB guidance */}
      {gate && GATE_DEPTH_GUIDE.map(dg => (
        <text key={dg} x={W - PR - 2} y={y(-dg) + 3} fontSize={8} textAnchor="end" fill="var(--text-tertiary)">−{dg} dB guide</text>
      ))}
      {/* each module's own curve, faint */}
      {gate && <path d={path(v => v - gateGrDb(v, gate.threshold, gate.ratio, gate.depth))} stroke="var(--slot-dynamics)" strokeWidth={1.2} fill="none" opacity={gateIn ? 0.55 : 0.25} strokeDasharray={gateIn ? undefined : "4 4"} />}
      {comp && <path d={path(v => v - compGrDb(v, comp.threshold, comp.ratio, comp.knee) + comp.makeup)} stroke="var(--slot-dynamics)" strokeWidth={1.2} fill="none" opacity={compIn ? 0.55 : 0.25} strokeDasharray={compIn ? undefined : "4 4"} />}
      {/* THE RESULTING CURVE — what runs (orange) */}
      <path d={path(v => chainOutDb(v, g, c))} stroke="var(--dyn-curve)" strokeWidth={3} fill="none" />
      {gate && handle("gate", gate.threshold, gateIn, "var(--slot-dynamics)")}
      {comp && handle("comp", comp.threshold, compIn, "var(--dyn-curve)")}
      {live && liveOut != null && live.level > LO && (
        <g>
          <circle cx={x(live.level)} cy={y(liveOut)} r={6} fill="var(--dyn-curve)" stroke="var(--bg-primary)" strokeWidth={2} />
          <text x={x(live.level) + 9} y={y(liveOut) - 6} fontSize={10} fontWeight={800} fill="var(--text-primary)">
            now {live.level.toFixed(0)} → {liveOut.toFixed(0)} dB
          </text>
        </g>
      )}
    </svg>
  );
}
