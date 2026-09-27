// ── EqCurve — the channel EQ, drawn from the engine's own coefficients (Slice 5, docs/dsp-channel-rack-eq.md §4) ──
//
// SVG, 20 Hz – 20 kHz (log) × ±15 dB. THE SOLID CURVE IS WHAT THE ENGINE RUNS: planChannel() — the same
// biquads, in the same f32-stored numbers, as ChannelRack::plan (eqMath.ts, pinned to Rust at 1e-9). What is
// set but OUT is drawn DASHED (it would run if you pressed IN) — never as if it were on air.
//
//   · each PEQ band has its own colour (--band-1 … --band-4) and a draggable node: horizontal = frequency,
//     vertical = gain; the mouse wheel — or a trackpad pinch (it arrives as ctrl+wheel) or a two-finger pinch on
//     a touch screen — sets the width. Nodes are 44 px targets.
//   · HPF and LPF: an opaque shaded region when IN, an outline when OUT; the corner is draggable sideways.
//   · SLICE 8 — the LIVE RTA behind it all (docs/dsp-channel-rta.md §3): the channel's spectrum BEFORE its rack
//     (faint) and AFTER it (brighter), both pre-fader, 31 third-octave bands on THIS curve's own x (the same
//     function, never a copy), on their own dBFS scale (0 at the top, −90 at the bottom, labelled on the right).
//     Bands narrower than 3 FFT bins are hatched COARSE; a channel sending nothing says NOT FED. The curve stays on
//     top and the spectrum takes no pointer events.
//   · numbers beside every node: frequency, gain, width in octaves.
import React, { useId, useMemo, useRef, useState } from "react";
import type { FilterModule, PeqModule, ChannelRackDoc } from "./rackTypes";
import {
  planChannel, sumDb, bandBiquad, filterBiquads, clampChannelModule, HPF_HZ, LPF_HZ, PEQ_HZ, PEQ_GAIN_DB, PEQ_WIDTH_OCT,
} from "./eqMath";
import { rtaPath, coarseSpan, RTA_RANGE_DB, type RtaFrame } from "./rta";

const W = 800, H = 280, PL = 40, PR = 12, PT = 12, PB = 26;
const F0 = 20, F1 = 20000, DB = 15;
const x = (f: number) => PL + (Math.log10(f / F0) / Math.log10(F1 / F0)) * (W - PL - PR);
const fOf = (px: number) => F0 * Math.pow(F1 / F0, Math.max(0, Math.min(1, (px - PL) / (W - PL - PR))));
const y = (db: number) => PT + ((DB - Math.max(-DB, Math.min(DB, db))) / (2 * DB)) * (H - PT - PB);
const dbOf = (py: number) => DB - ((py - PT) / (H - PT - PB)) * 2 * DB;
const FREQS = Array.from({ length: 240 }, (_, i) => F0 * Math.pow(F1 / F0, i / 239));
const BAND_COLOR = ["var(--band-1)", "var(--band-2)", "var(--band-3)", "var(--band-4)"];
const fmtF = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : `${Math.round(f)}`);
const fmtG = (g: number) => `${g > 0 ? "+" : g < 0 ? "−" : ""}${Math.abs(g).toFixed(1)}`;
const path = (dbs: number[]) => dbs.map((d, i) => `${i ? "L" : "M"}${x(FREQS[i]).toFixed(1)},${y(d).toFixed(1)}`).join("");
const round = (v: number, step: number) => Math.round(v / step) * step;

interface Props {
  doc: ChannelRackDoc;
  filters: { id: string; in: boolean; module: FilterModule } | null;
  peq: { id: string; in: boolean; module: PeqModule } | null;
  onFilters: (m: FilterModule) => void;
  onPeq: (m: PeqModule) => void;
  selected: number | null;
  onSelect: (band: number | null) => void;
  /** SLICE 8 — the live RTA for this channel (null = not listening), and the held peaks when PEAK HOLD is on. */
  rta?: { frame: RtaFrame | null; held: { pre: number[]; post: number[] } | null } | null;
}

export default function EqCurve({ doc, filters, peq, onFilters, onPeq, selected, onSelect, rta = null }: Props) {
  const hatchId = `rta-coarse-${useId().replace(/:/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<null | { kind: "band"; i: number } | { kind: "hpf" | "lpf" }>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; w: number } | null>(null);

  const running = useMemo(() => { const b = planChannel(doc); return FREQS.map(f => sumDb(b, f)); }, [doc]);
  // what is SET, as if everything were IN (drawn dashed where it differs from what runs)
  const asSet = useMemo(() => {
    const all: ChannelRackDoc = { v: 1, sections: { ch: doc.sections.ch.map(s => ({ ...s, in: true })) } };
    const b = planChannel(all); return FREQS.map(f => sumDb(b, f));
  }, [doc]);
  const differs = asSet.some((d, i) => Math.abs(d - running[i]) > 0.01);

  const toSvg = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { px: ((e.clientX - r.left) * W) / r.width, py: ((e.clientY - r.top) * H) / r.height };
  };
  const setBand = (i: number, patch: Partial<PeqModule["bands"][number]>) => {
    if (!peq) return;
    const bands = peq.module.bands.map((b, k) => (k === i ? { ...b, ...patch } : b)) as PeqModule["bands"];
    onPeq(clampChannelModule({ ...peq.module, bands }) as PeqModule);
  };
  const setWidth = (i: number, w: number) => setBand(i, { width: round(Math.max(PEQ_WIDTH_OCT[0], Math.min(PEQ_WIDTH_OCT[1], w)), 0.05) });

  const onMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // a two-finger pinch on a touch screen sets the selected band's width
    if (pointers.current.size === 2 && selected != null && peq) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (!pinch.current) pinch.current = { d, w: peq.module.bands[selected].width };
      else setWidth(selected, pinch.current.w * (pinch.current.d / Math.max(1, d)));
      return;
    }
    if (!drag) return;
    const { px, py } = toSvg(e);
    const f = fOf(px);
    if (drag.kind === "band") setBand(drag.i, { freq: round(f, f < 100 ? 1 : f < 1000 ? 5 : 50), gain: round(dbOf(py), 0.5) });
    else if (filters) {
      const [lo, hi] = drag.kind === "hpf" ? HPF_HZ : LPF_HZ;
      const v = Math.max(lo, Math.min(hi, round(f, f < 100 ? 1 : f < 1000 ? 5 : 50)));
      onFilters(clampChannelModule({ ...filters.module, [drag.kind]: { ...filters.module[drag.kind], freq: v } }) as FilterModule);
    }
  };
  const start = (d: NonNullable<typeof drag>) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (d.kind === "band") onSelect(d.i);
    setDrag(d);
  };
  const end = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDrag(null);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (selected == null || !peq) return;
    const w = peq.module.bands[selected].width;
    setWidth(selected, w * Math.pow(1.1, e.deltaY > 0 ? 1 : -1));   // ctrl+wheel = a trackpad pinch, same meaning
  };

  const grid = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const fShade = (which: "hpf" | "lpf") => {
    if (!filters) return null;
    const st = filters.module[which];
    const on = filters.in && st.in;
    const fx = x(st.freq);
    const [x0, x1] = which === "hpf" ? [PL, fx] : [fx, W - PR];
    const curve = FREQS.map(f => sumDb(filterBiquads({ ...filters.module, [which]: { ...st, in: true } } as FilterModule, which), f));
    return (
      <g key={which}>
        <rect x={x0} y={PT} width={Math.max(0, x1 - x0)} height={H - PT - PB}
              fill={on ? "var(--slot-filter)" : "none"} fillOpacity={on ? 0.22 : 0}
              stroke="var(--slot-filter)" strokeOpacity={on ? 0 : 0.6} strokeDasharray={on ? undefined : "4 4"} />
        <path d={path(curve)} fill="none" stroke="var(--slot-filter)" strokeWidth={1.5} strokeDasharray={on ? undefined : "5 4"} opacity={0.9} />
        {/* the corner: a 44 px target, sideways only */}
        <g onPointerDown={start({ kind: which })} style={{ cursor: "ew-resize" }}>
          <rect x={fx - 22} y={PT} width={44} height={H - PT - PB} fill="transparent" />
          <line x1={fx} x2={fx} y1={PT} y2={H - PB} stroke="var(--slot-filter)" strokeWidth={2} strokeDasharray={on ? undefined : "4 4"} />
          <text x={fx + (which === "hpf" ? 4 : -4)} y={PT + 12} fontSize={11} fontWeight={800} fill="var(--slot-filter)"
                textAnchor={which === "hpf" ? "start" : "end"}>{which.toUpperCase()} {fmtF(st.freq)} Hz{on ? "" : " · OUT"}</text>
        </g>
      </g>
    );
  };

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", touchAction: "none", userSelect: "none",
         background: "var(--bg-primary)", border: "1px solid var(--border-primary)" }}
         onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} onWheel={onWheel}
         onPointerDown={e => {
           // a second finger (a pinch on the selected band) must not deselect it; a lone tap on the background does
           pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
           if (pointers.current.size === 1) onSelect(null);
         }}>
      {grid.map(f => <line key={f} x1={x(f)} x2={x(f)} y1={PT} y2={H - PB} stroke="var(--border-primary)" strokeWidth={1} />)}
      {grid.map(f => <text key={`t${f}`} x={x(f)} y={H - 8} fontSize={10} textAnchor="middle" fill="var(--text-tertiary)">{fmtF(f)}</text>)}
      {[-12, -6, 0, 6, 12].map(d => (
        <g key={d}>
          <line x1={PL} x2={W - PR} y1={y(d)} y2={y(d)} stroke="var(--border-primary)" strokeWidth={d === 0 ? 1.5 : 1} />
          <text x={PL - 6} y={y(d) + 4} fontSize={10} textAnchor="end" fill="var(--text-tertiary)">{d > 0 ? `+${d}` : d}</text>
        </g>
      ))}
      {/* SLICE 8 — the live spectrum, under everything that can be touched */}
      {rta?.frame && (
        <g pointerEvents="none">
          <defs>
            <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--text-tertiary)" strokeWidth={1} opacity={0.35} />
            </pattern>
          </defs>
          {rta.frame.fed ? (
            <>
              <path d={rtaPath(rta.frame.pre, x, PT, H - PB, F0, F1)} fill="var(--rta-pre)" stroke="none" />
              <path d={rtaPath(rta.frame.post, x, PT, H - PB, F0, F1)} fill="var(--rta-post)" stroke="none" />
              {rta.held && <path d={rtaPath(rta.held.post, x, PT, H - PB, F0, F1)} fill="none" stroke="var(--rta-post-line)" strokeWidth={1} strokeDasharray="3 3" />}
              {(() => { const c = coarseSpan(rta.frame.coarseBelowHz, x, F0); return c ? <rect x={c[0]} y={PT} width={c[1] - c[0]} height={H - PT - PB} fill={`url(#${hatchId})`} /> : null; })()}
            </>
          ) : (
            <text x={(PL + W - PR) / 2} y={H - PB - 10} fontSize={11} fontWeight={800} textAnchor="middle" fill="var(--text-tertiary)">SPECTRUM — NOT FED (nothing is playing on this channel)</text>
          )}
          <text x={W - PR - 4} y={PT + 10} fontSize={9} textAnchor="end" fill="var(--text-tertiary)">0 dBFS</text>
          <text x={W - PR - 4} y={H - PB - 3} fontSize={9} textAnchor="end" fill="var(--text-tertiary)">−{RTA_RANGE_DB}</text>
        </g>
      )}
      {fShade("hpf")}
      {fShade("lpf")}
      {/* each band's own contribution, in its colour */}
      {peq && peq.module.bands.map((b, i) => {
        const bq = bandBiquad(b, i);
        if (!bq) return null;
        return <path key={`b${i}`} d={path(FREQS.map(f => sumDb([bq], f)))} fill="none" stroke={BAND_COLOR[i]} strokeWidth={1.2} opacity={0.55}
                     strokeDasharray={peq.in ? undefined : "5 4"} />;
      })}
      {differs && <path d={path(asSet)} fill="none" stroke="var(--text-tertiary)" strokeWidth={1.5} strokeDasharray="6 5" />}
      <path d={path(running)} fill="none" stroke="var(--slot-eq)" strokeWidth={3} />
      {/* the band nodes */}
      {peq && peq.module.bands.map((b, i) => {
        const cx = x(b.freq), cy = y(b.gain), sel = selected === i;
        const left = cx > W - 140;
        return (
          <g key={`n${i}`} onPointerDown={start({ kind: "band", i })} style={{ cursor: "grab" }}>
            <circle cx={cx} cy={cy} r={22} fill="transparent" />
            <circle cx={cx} cy={cy} r={sel ? 10 : 8} fill={BAND_COLOR[i]} fillOpacity={peq.in ? 1 : 0.35}
                    stroke={sel ? "var(--text-primary)" : "var(--bg-primary)"} strokeWidth={2} />
            <text x={cx} y={cy + 4} fontSize={10} fontWeight={900} textAnchor="middle" fill="var(--bg-primary)">{i + 1}</text>
            <text x={cx + (left ? -16 : 16)} y={cy - 6} fontSize={11} fontWeight={800} fill={BAND_COLOR[i]} textAnchor={left ? "end" : "start"}>
              {fmtF(b.freq)} Hz {fmtG(b.gain)} dB
            </text>
            <text x={cx + (left ? -16 : 16)} y={cy + 8} fontSize={10} fill="var(--text-tertiary)" textAnchor={left ? "end" : "start"}>
              {b.shelf && (i === 0 || i === 3) ? (i === 0 ? "low shelf" : "high shelf") : "bell"} · {b.width.toFixed(2)} oct
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The ranges, for the editor's numeric fields (re-exported so the editor needs one import). */
export const RANGES = { PEQ_HZ, PEQ_GAIN_DB, PEQ_WIDTH_OCT, HPF_HZ, LPF_HZ };
