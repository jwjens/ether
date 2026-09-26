// ── LoudnessPanel — one branch's BS.1770 loudness (Slice 3, docs/dsp-loudness-meter.md §4.3) ───────────────
//
// M / S / I / LRA / TP-max as numbers first, with M and S also drawn as bars on a loudness scale CENTRED ON
// THIS BRANCH'S OWN TARGET (Jeff's ruling 5) with the target line across both. Reset restarts I, LRA and
// TP-max for this branch (the engine's meter thread does it; the audio thread is not involved).
//
// The numbers are the engine's measurement of what this branch actually sent (LOCAL = the device feed before
// the monitor knobs, STREAM = exactly what the encoder gets). Nothing here is estimated.
//
// It reads frames from the meter store every animation frame and writes the DOM through refs — no React
// re-render at meter rate. One component, keyed by branch, no page state: slice 4 moves it into the rack.
import React, { useEffect, useRef, useState } from "react";
import { latestMeters, useMeterSubscription, BUS } from "./meterStore";
import {
  type LoudBranch, type LoudScale, loudFrac, targetFrac, fmtLufs, fmtLu, sinceLabel, incompleteLabel,
} from "./loudnessWire";
import { loudnessLevel, METER_COLOR, METER_WORD } from "../health/meterScale";
import { STALE_MS } from "./meterBallistics";

interface Props {
  stationId: number | null | undefined;
  stationUuid: string | null | undefined;
  branch: "local" | "stream";
  /** The branch's target, LUFS — the scale is centred on it and the line drawn at it. */
  target: number;
  label: string;
}

const HATCH = "repeating-linear-gradient(45deg, rgba(255,255,255,0.07) 0 3px, transparent 3px 7px)";
const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontVariantNumeric: "tabular-nums" };
const LABEL: React.CSSProperties = { fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" };

export default function LoudnessPanel({ stationId, stationUuid, branch, target, label }: Props) {
  useMeterSubscription([stationId]);
  const [scale, setScale] = useState<LoudScale>(() => {
    try { return localStorage.getItem("ether.loudScale") === "18" ? 18 : 9; } catch { return 9; }
  });
  const pickScale = (s: LoudScale) => { setScale(s); try { localStorage.setItem("ether.loudScale", String(s)); } catch { /* per-viewer only */ } };
  const [resetting, setResetting] = useState(false);
  const [resetErr, setResetErr] = useState<string | null>(null);

  const uuidRef = useRef(stationUuid); uuidRef.current = stationUuid;
  const targetRef = useRef(target); targetRef.current = target;
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const txt = useRef<Record<string, HTMLSpanElement | null>>({});
  const bar = useRef<Record<"m" | "s", HTMLDivElement | null>>({ m: null, s: null });
  const word = useRef<Record<"m" | "s", HTMLSpanElement | null>>({ m: null, s: null });
  const deadRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const set = (k: string, v: string) => { const el = txt.current[k]; if (el && el.textContent !== v) el.textContent = v; };
    const draw = () => {
      const f = latestMeters(uuidRef.current);
      const b: LoudBranch | undefined = f?.ld?.[branch];
      const fresh = !!f && performance.now() - f.at < STALE_MS && !!b;
      const fed = fresh && !!b && b.fed;
      if (deadRef.current) deadRef.current.style.display = fed ? "none" : "flex";
      set("m", fed ? fmtLufs(b!.m) : "—");
      set("s", fed ? fmtLufs(b!.s) : "—");
      set("i", fresh ? fmtLufs(b!.i) : "—");
      set("lra", fresh ? fmtLu(b!.lra) : "—");
      set("tp", fresh ? fmtLufs(b!.tpMax) : "—");
      set("since", fresh ? sinceLabel(b!.since, b!.capped) : "");
      const notes: string[] = [];
      if (fresh) {
        const inc = incompleteLabel(b!.dropSec);
        if (inc) notes.push(inc);
        if (branch === "stream" && f && !((f.live >> BUS.STREAM) & 1)) notes.push("encoder not connected — metering what would be sent");
      } else notes.push("no meter data from the engine");
      if (noteRef.current) { const t = notes.join(" · "); if (noteRef.current.textContent !== t) noteRef.current.textContent = t; }
      for (const k of ["m", "s"] as const) {
        const el = bar.current[k];
        const v = fed ? b![k] : null;
        const lvl = loudnessLevel(v, targetRef.current);
        if (el) {
          el.style.width = `${loudFrac(v, targetRef.current, scaleRef.current) * 100}%`;
          el.style.background = METER_COLOR[lvl];
        }
        const w = word.current[k];
        if (w) { const t = v == null ? "" : METER_WORD[lvl]; if (w.textContent !== t) w.textContent = t; }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [branch]);

  const reset = async () => {
    setResetErr(null);
    const api = (window as any).ether?.audio;
    if (!api?.resetLoudness || stationId == null) { setResetErr("reset is not available on this engine"); return; }
    setResetting(true);
    try {
      const ok = await api.resetLoudness(stationId, branch);
      if (!ok) setResetErr("the engine did not accept the reset — fully close and reopen Ether if it has just updated");
    } catch (e: any) { setResetErr(String(e?.message || e)); }
    finally { setResetting(false); }
  };

  const tf = targetFrac(scale) * 100;
  // Render helpers, not components: a component defined inside render would remount every render.
  const bar_ = (k: "m" | "s", name: string, title: string) => (
    <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }} title={title}>
      <span style={{ ...LABEL, width: 14 }}>{name}</span>
      <div style={{ position: "relative", flex: 1, height: 12, background: "var(--vu-meter-bg, #0a0a0f)", border: "1px solid var(--border-primary)" }}>
        <div ref={el => { bar.current[k] = el; }} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "0%" }} />
        <div style={{ position: "absolute", top: -2, bottom: -2, left: `${tf}%`, width: 2, background: "#8868D8" }} title={`target ${fmtLufs(target)} LUFS`} />
      </div>
      <span ref={el => { txt.current[k] = el; }} style={{ ...MONO, fontSize: 12, fontWeight: 700, minWidth: 48, textAlign: "right" }}>—</span>
      <span ref={el => { word.current[k] = el; }} style={{ fontSize: 10, color: "var(--text-tertiary)", minWidth: 28 }} />
    </div>
  );
  const num_ = (k: string, name: string, unit: string, title: string) => (
    <div key={k} title={title} style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <span style={LABEL}>{name}</span>
      <span style={{ ...MONO, fontSize: 15, fontWeight: 800 }}>
        <span ref={el => { txt.current[k] = el; }}>—</span>
        <span style={{ fontSize: 10, fontWeight: 500, color: "var(--text-tertiary)", marginLeft: 3 }}>{unit}</span>
      </span>
    </div>
  );

  return (
    <div data-loudness={branch} style={{ position: "relative", display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...LABEL, fontWeight: 800, color: "var(--text-secondary)" }}>{label}</span>
        <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>target {fmtLufs(target)} LUFS</span>
        <div style={{ flex: 1 }} />
        {([9, 18] as LoudScale[]).map(s => (
          <button key={s} onClick={() => pickScale(s)}
            title={s === 9 ? "Scale −18 … +9 LU around this branch's target" : "Scale −36 … +18 LU around this branch's target"}
            style={{ padding: "1px 6px", fontSize: 10, fontWeight: 700, cursor: "pointer",
                     border: `1px solid ${scale === s ? "#8868D8" : "var(--border-primary)"}`,
                     background: scale === s ? "rgba(136,104,216,0.15)" : "transparent",
                     color: scale === s ? "#8868D8" : "var(--text-tertiary)" }}>+{s}</button>
        ))}
      </div>
      {bar_("m", "M", "Momentary loudness — the last 400 ms of what this output sent")}
      {bar_("s", "S", "Short-term loudness — the last 3 s of what this output sent")}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 2 }}>
        {num_("i", "Integrated", "LUFS", "Integrated loudness since the last reset (BS.1770 gated: −70 LUFS absolute, −10 LU relative)")}
        {num_("lra", "LRA", "LU", "Loudness range since the last reset (EBU Tech 3342)")}
        {num_("tp", "True peak max", "dBTP", "The highest true peak (4× oversampled) since the last reset")}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span ref={el => { txt.current.since = el; }} style={{ fontSize: 10, color: "var(--text-tertiary)" }} />
        <div style={{ flex: 1 }} />
        <button onClick={reset} disabled={resetting}
          title="Start integrated loudness, LRA and true-peak max again for this output"
          style={{ padding: "2px 10px", fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", cursor: resetting ? "default" : "pointer",
                   border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}>
          {resetting ? "RESETTING…" : "RESET"}
        </button>
      </div>
      <div ref={noteRef} style={{ fontSize: 10, color: "var(--accent-amber)", minHeight: 0 }} />
      {resetErr && <div style={{ fontSize: 10, color: "var(--accent-red)" }}>⚠ {resetErr}</div>}
      {/* NOT FED — hatched over the M/S bars when this output is sending nothing to measure */}
      <div ref={deadRef} title="Not fed — no audio is reaching this output's meter"
        style={{ position: "absolute", left: 0, right: 0, top: 20, height: 40, background: HATCH, display: "none",
                 alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)" }}>NOT FED</span>
      </div>
    </div>
  );
}
