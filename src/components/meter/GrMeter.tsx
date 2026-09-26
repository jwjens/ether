// ── GrMeter — ride and limiter, separately, per branch (Slice 3, docs/dsp-loudness-meter.md §3) ──────────
//
// RIDE is the loudness ride's corrective gain: signed (a boost is +), drawn around a centre line across
// ±clamp — it is not a reduction, so it is never drawn as one. LIMITER is the deepest gain reduction the
// limiter applied in each ~30 Hz window (not the last sample of a buffer, which misses every transient it
// caught and released), with the shared ballistics' hold tick and a "max 10 s" readout, because a seam lasts
// about five seconds and nobody reads a moving needle while it happens.
//
// OFF (hatched, labelled) when the branch's processor is not running — never drawn as 0 dB of action. For
// LOCAL it names which processor fed the output: while an aux deck is live the device plays the ROOM chain.
import React, { useEffect, useRef } from "react";
import { latestMeters } from "./meterStore";
import { type GrBranch, rideFrac, limFrac, LIM_FULL_DB } from "./loudnessWire";
import { PEAK_HOLD_MS, STALE_MS } from "./meterBallistics";

interface Props {
  stationUuid: string | null | undefined;
  branch: "local" | "stream" | "aux";
  kind: "ride" | "lim";
  /** The ride's clamp (± dB) — the ride meter's full scale. */
  clampDb?: number;
}

const HATCH = "repeating-linear-gradient(45deg, rgba(255,255,255,0.07) 0 3px, transparent 3px 7px)";
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontVariantNumeric: "tabular-nums" };
const MINUS = "−";

export default function GrMeter({ stationUuid, branch, kind, clampDb = 12 }: Props) {
  const uuidRef = useRef(stationUuid); uuidRef.current = stationUuid;
  const clampRef = useRef(clampDb); clampRef.current = clampDb;
  const fillRef = useRef<HTMLDivElement | null>(null);
  const holdRef = useRef<HTMLDivElement | null>(null);
  const numRef = useRef<HTMLSpanElement | null>(null);
  const maxRef = useRef<HTMLSpanElement | null>(null);
  const offRef = useRef<HTMLDivElement | null>(null);
  const srcRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let lastE = -1;
    let hold = 0, holdAt = 0;
    const win: { t: number; v: number }[] = [];
    const draw = () => {
      const now = performance.now();
      const f = latestMeters(uuidRef.current);
      const g: GrBranch | undefined = f?.gr?.[branch];
      const fresh = !!f && now - f.at < STALE_MS && !!g;
      const on = fresh && g!.run;
      if (offRef.current) offRef.current.style.display = on ? "none" : "flex";
      if (srcRef.current) {
        const t = fresh && branch === "local" && g!.src === "room" ? "room chain" : "";
        if (srcRef.current.textContent !== t) srcRef.current.textContent = t;
      }
      const fill = fillRef.current;
      if (kind === "ride") {
        const v = on ? g!.ride : 0;
        const fr = rideFrac(v, clampRef.current);
        if (fill) {
          const lo = Math.min(fr, 0.5), hi = Math.max(fr, 0.5);
          fill.style.left = `${lo * 100}%`;
          fill.style.width = `${(hi - lo) * 100}%`;
        }
        if (numRef.current) {
          const t = on ? `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(1)}` : "—";
          if (numRef.current.textContent !== t) numRef.current.textContent = t;
        }
      } else {
        const v = on ? g!.lim : 0;
        // Each window's value is folded once (frames repeat between draws).
        if (on && f!.e !== lastE) {
          lastE = f!.e;
          if (v >= hold) { hold = v; holdAt = now; }
          win.push({ t: now, v });
        }
        while (win.length && now - win[0].t > 10_000) win.shift();
        if (now - holdAt > PEAK_HOLD_MS) hold = Math.max(v, hold - (now - holdAt - PEAK_HOLD_MS) * 0.01);
        if (fill) { fill.style.left = "0%"; fill.style.width = `${limFrac(v) * 100}%`; }
        if (holdRef.current) {
          holdRef.current.style.left = `${limFrac(hold) * 100}%`;
          holdRef.current.style.display = on && hold > 0.05 ? "block" : "none";
        }
        if (numRef.current) { const t = on ? v.toFixed(1) : "—"; if (numRef.current.textContent !== t) numRef.current.textContent = t; }
        if (maxRef.current) {
          const m = win.reduce((a, x) => Math.max(a, x.v), 0);
          const t = on ? `max 10 s ${m.toFixed(1)}` : "";
          if (maxRef.current.textContent !== t) maxRef.current.textContent = t;
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [branch, kind]);

  const title = kind === "ride"
    ? `Loudness ride — the corrective gain it is applying (± up to the clamp). A boost reads +, a cut ${MINUS}.`
    : `Limiter — the deepest gain reduction in each window (0 to ${LIM_FULL_DB} dB), with a 2 s hold tick and the maximum over the last 10 s.`;
  return (
    <div title={title} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
      <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", width: 44, flexShrink: 0 }}>
        {kind === "ride" ? "Ride" : "Limiter"}
      </span>
      <div style={{ position: "relative", flex: 1, height: 10, minWidth: 50, background: "var(--vu-meter-bg, #0a0a0f)", border: "1px solid var(--border-primary)" }}>
        {kind === "ride" && <div style={{ position: "absolute", top: -1, bottom: -1, left: "50%", width: 1, background: "var(--text-tertiary)" }} />}
        <div ref={fillRef} style={{ position: "absolute", top: 0, bottom: 0, left: kind === "ride" ? "50%" : 0, width: "0%",
                                    background: kind === "ride" ? "var(--accent-cyan, #22d3ee)" : "var(--accent-amber)" }} />
        {kind === "lim" && <div ref={holdRef} style={{ position: "absolute", top: -1, bottom: -1, width: 2, background: "#fff", display: "none" }} />}
        <div ref={offRef} style={{ position: "absolute", inset: 0, background: HATCH, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)" }}>OFF</span>
        </div>
      </div>
      <span style={{ ...MONO, fontSize: 11, fontWeight: 700, minWidth: 38, textAlign: "right" }}>
        <span ref={numRef}>—</span><span style={{ fontSize: 9, color: "var(--text-tertiary)", marginLeft: 2 }}>dB</span>
      </span>
      <span ref={maxRef} style={{ ...MONO, fontSize: 9, color: "var(--text-tertiary)", minWidth: kind === "lim" ? 62 : 0 }} />
      <span ref={srcRef} style={{ fontSize: 9, color: "var(--accent-amber)" }} />
    </div>
  );
}
