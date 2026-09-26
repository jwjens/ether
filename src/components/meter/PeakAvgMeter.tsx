// ── PeakAvgMeter — THE one meter (Slice 2, docs/dsp-meter-bus.md §3) ──────────────────────────────────
//
// An average bar (solid, zone-coloured) with a white peak dot riding above it, a hold tick, an OVER cap and
// the −18 alignment mark. Ballistics come from meterBallistics.ts only.
//
// It reads its own source every animation frame and writes the DOM through refs, so a meter moving at
// 30 Hz never re-renders React. Sources:
//   • { stationUuid, ch }   — a channel's PRE-FADER tap (ruling 1: it moves while the channel is OFF)
//   • { stationUuid, ch, post: true } — SLICE 5: the same channel AFTER its rack (still pre-fader). An engine
//                             that predates the channel EQ sends no chPost: drawn NOT FED, never as silence.
//   • { stationUuid, bus }  — a bus tap (post-fader: PGM / LOCAL / STREAM / MONITOR / ROOM / AUX)
//   • { external }          — a level the renderer already has (a patched mic's Web Audio level, which is
//                             already pre-fader). It is ONE number, so the bar and the dot both draw it.
//
// "Not fed" is never drawn as silence: no frame for STALE_MS, or a bus the engine reports as absent this
// window (LOCAL/ROOM/AUX), is hatched and labelled. A meter that reads zero on a live source is used as
// evidence, and this codebase has paid for that before (ConsoleStrip.tsx, 2026-08-18).
import React, { useEffect, useRef } from "react";
import {
  initialMeter, stepMeter, avgDbOf, overLit, dbToFrac, zoneOf, ALIGN_DB, STALE_MS, type MeterState,
} from "./meterBallistics";
import { latestMeters } from "./meterStore";

export type MeterSource =
  | { stationUuid: string | null | undefined; ch: number; post?: boolean; bus?: undefined; external?: undefined }
  | { stationUuid: string | null | undefined; bus: number; ch?: undefined; external?: undefined }
  | { external: number; stationUuid?: undefined; ch?: undefined; bus?: undefined };

interface Props {
  source: MeterSource;
  stereo?: boolean;
  size?: "strip" | "master" | "compact";
  orientation?: "v" | "h";
  label?: string;
  /** Tooltip for the whole meter (what it is metering, pre/post). */
  title?: string;
}

const ZONE_COLOR = { green: "var(--accent-green)", amber: "var(--accent-amber)", red: "var(--accent-red)" } as const;
const HATCH = "repeating-linear-gradient(45deg, rgba(255,255,255,0.07) 0 3px, transparent 3px 7px)";

export default function PeakAvgMeter({ source, stereo = true, size = "strip", orientation = "v", label, title }: Props) {
  const srcRef = useRef(source);
  srcRef.current = source;
  const lanes = stereo ? 2 : 1;
  const avgRefs  = useRef<(HTMLDivElement | null)[]>([]);
  const peakRefs = useRef<(HTMLDivElement | null)[]>([]);
  const holdRefs = useRef<(HTMLDivElement | null)[]>([]);
  const overRef  = useRef<HTMLDivElement | null>(null);
  const deadRef  = useRef<HTMLDivElement | null>(null);
  const vertical = orientation === "v";

  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    let states: MeterState[] = Array.from({ length: lanes }, () => initialMeter(t0));
    let lastAt = -1;           // the frame (or external sample) last folded in
    let lastExtAt = 0;
    const pos = (el: HTMLElement | null | undefined, frac: number, show: boolean) => {
      if (!el) return;
      el.style.display = show ? "block" : "none";
      if (vertical) el.style.bottom = `${frac * 100}%`; else el.style.left = `${frac * 100}%`;
    };
    const draw = () => {
      const now = performance.now();
      const s = srcRef.current;
      let fed = false;
      let wins: ({ peak: number; rms: number } | null)[] = states.map(() => null);
      if (s.external !== undefined) {
        fed = true;
        if (now - lastExtAt >= 33) {       // sample the external level at the engine's window rate
          lastExtAt = now;
          const v = Math.max(0, s.external || 0);
          wins = states.map(() => ({ peak: v, rms: v }));
        }
      } else {
        const f = latestMeters(s.stationUuid);
        const tap = f ? (s.ch !== undefined ? ("post" in s && s.post ? f.chPost?.[s.ch] : f.ch?.[s.ch]) : f.bus?.[s.bus!]) : undefined;
        const busLive = s.bus === undefined || !f ? true : ((f.live >> s.bus) & 1) === 1;
        fed = !!f && !!tap && now - f.at < STALE_MS && busLive;
        if (fed && f!.at !== lastAt) {
          lastAt = f!.at;
          const [pl, pr, rl, rr] = tap!;
          wins = lanes === 2
            ? [{ peak: pl, rms: rl }, { peak: pr, rms: rr }]
            : [{ peak: Math.max(pl, pr), rms: Math.sqrt((rl * rl + rr * rr) / 2) }];
        }
      }
      if (!fed) {
        // Not fed: reset, so the meter does not resume from a stale value when the feed returns.
        states = states.map(() => initialMeter(now));
      } else {
        states = states.map((st, i) => stepMeter(st, wins[i], now));
      }
      if (deadRef.current) deadRef.current.style.display = fed ? "none" : "flex";
      let over = false;
      states.forEach((st, i) => {
        const avgDb = avgDbOf(st);
        const a = avgRefs.current[i];
        if (a) {
          const f = fed ? dbToFrac(avgDb) : 0;
          if (vertical) a.style.height = `${f * 100}%`; else a.style.width = `${f * 100}%`;
          a.style.background = ZONE_COLOR[zoneOf(avgDb)];
        }
        pos(peakRefs.current[i], dbToFrac(st.peakDb), fed && Number.isFinite(st.peakDb) && dbToFrac(st.peakDb) > 0);
        pos(holdRefs.current[i], dbToFrac(st.holdDb), fed && Number.isFinite(st.holdDb) && dbToFrac(st.holdDb) > 0);
        if (overLit(st, now)) over = true;
      });
      if (overRef.current) overRef.current.style.opacity = fed && over ? "1" : "0.12";
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [lanes, vertical]);

  const compact = size === "compact";
  const overSize = compact ? 3 : 5;
  const alignFrac = dbToFrac(ALIGN_DB);
  const lane = (i: number) => (
    <div key={i} style={{
      position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden",
      background: "var(--vu-meter-bg, #0a0a0f)",
    }}>
      <div ref={el => { avgRefs.current[i] = el; }} style={vertical
        ? { position: "absolute", left: 0, right: 0, bottom: 0, height: "0%" }
        : { position: "absolute", top: 0, bottom: 0, left: 0, width: "0%" }} />
      <div ref={el => { holdRefs.current[i] = el; }} style={vertical
        ? { position: "absolute", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.55)", display: "none" }
        : { position: "absolute", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.55)", display: "none" }} />
      <div ref={el => { peakRefs.current[i] = el; }} style={vertical
        ? { position: "absolute", left: "15%", right: "15%", height: compact ? 2 : 3, borderRadius: 1, background: "#fff", display: "none" }
        : { position: "absolute", top: "15%", bottom: "15%", width: compact ? 2 : 3, borderRadius: 1, background: "#fff", display: "none" }} />
    </div>
  );

  return (
    <div title={title} data-meter={label} style={{
      position: "relative", display: "flex", flexDirection: vertical ? "column" : "row",
      width: "100%", height: "100%", minWidth: 0, minHeight: 0, gap: 1,
    }}>
      {/* OVER cap — red when a window reached full scale within the last OVER_HOLD_MS */}
      <div ref={overRef} title="OVER — the signal reached 0 dBFS (full scale)" style={{
        flex: `0 0 ${overSize}px`, background: "var(--accent-red)", opacity: 0.12, borderRadius: 1,
        order: vertical ? 0 : 2,
      }} />
      <div style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: vertical ? "row" : "column", gap: 1 }}>
        {Array.from({ length: lanes }, (_, i) => lane(i))}
        {/* −18 dBFS alignment mark */}
        <div style={vertical
          ? { position: "absolute", left: 0, right: 0, bottom: `${alignFrac * 100}%`, height: 1, background: "rgba(136,104,216,0.8)", pointerEvents: "none" }
          : { position: "absolute", top: 0, bottom: 0, left: `${alignFrac * 100}%`, width: 1, background: "rgba(136,104,216,0.8)", pointerEvents: "none" }} />
        {/* NOT FED — hatched, never drawn as silence */}
        <div ref={deadRef} title="Not fed — no meter data is arriving for this source" style={{
          position: "absolute", inset: 0, background: HATCH, display: "flex",
          alignItems: "center", justifyContent: "center", pointerEvents: "none",
        }}>
          {!compact && (
            <span style={{
              fontSize: 7, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary, #666)",
              writingMode: vertical ? "vertical-rl" : undefined, transform: vertical ? "rotate(180deg)" : undefined,
            }}>NOT FED</span>
          )}
        </div>
      </div>
      {label && size === "master" && (
        <div style={{ flex: "0 0 auto", order: 3, fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", color: "#8868D8", textAlign: "center" }}>{label}</div>
      )}
    </div>
  );
}
