// MasterOutput.tsx — Permanent master output panel + live station console
// Fixed right column in the deck area. Always visible.
// Dark steel: #0e0e12 bg, #1e1e28 borders, zero border-radius.

import { useEffect, useRef, useState, useCallback } from "react";
import { query } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { matchesStation } from "../lib/levelsScope";
import MasterEQRack from "./MasterEQRack";
import { useAudioHealth, HealthDot, HealthStyles, HealthModeBanner, rateLabel, peakLabel, LEVEL_COLOR } from "../audio/health";
import { EQ_DEFAULT } from "./GraphicEQ";
import StationMonitorMixer from "./StationMonitorMixer";
import AuxMonitorSlots from "./AuxMonitorSlots";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { vuSmooth, vuPeak } from "../lib/vuMeter";

// ── Constants ────────────────────────────────────────────────
// Fallback values only — resolved via CSS custom properties at runtime
const TEAL = "#00c8a8";
const AMB  = "#c07820";
const RED  = "#c02828";

function readThemeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    TEAL: s.getPropertyValue("--accent-teal").trim()  || TEAL,
    AMB:  s.getPropertyValue("--accent-amber").trim() || AMB,
    RED:  s.getPropertyValue("--accent-red").trim()   || RED,
  };
}
// ── Console event bus ────────────────────────────────────────
// Call from anywhere in the app to push a line to the console.
export type ConsoleEventType = "system" | "audio" | "rotation" | "error" | "clock" | "info";

export function consoleLog(type: ConsoleEventType, msg: string) {
  window.dispatchEvent(new CustomEvent("ether:console", { detail: { type, msg, ts: Date.now() } }));
}

const TYPE_COLOR: Record<ConsoleEventType, string> = {
  system:   "#208080",
  audio:    "#20a060",
  rotation: "#a07020",
  error:    "#a02020",
  clock:    "#208080",
  info:     "#606070",
};

// ── LimiterGR — the gain-reduction readout, beside the meter it explains ─────────────────────────
//
// This is the one number that says the limiter is working. It existed, then moved into the Health
// Monitor's Audio Processing panel on 2026-08-26 — for a good reason, recorded there: the
// `audio:proc-meters` frame arrives at ~15Hz and the handler builds a NEW OBJECT every frame, so a
// subscription at a panel ROOT repainted the whole tree at meter rate. The receipt was a boot trace
// driven to 211,951 identical lines and a 341 MB log. But moving it also buried it: an operator
// should not have to open a panel to see whether the programme is being limited.
//
// So it comes back HERE, next to the master VU, under the rule that fixed it: a LEAF component with
// its OWN subscription, writing to the DOM through a ref. Nothing above it re-renders — this file's
// own MasterVU already works exactly this way, and HealthMeters.tsx states the rule one layer up
// ("THE LEVELS CHANNEL NEVER TOUCHES REACT STATE"). No setState per frame, at all.
//
// Station-scoped like every other meter, and it goes to "—" when frames stop rather than freezing on
// the last value: a stuck number reading "−4.2 dB" on a dead feed is worse than no number.
function LimiterGR() {
  const grRef   = useRef<HTMLSpanElement>(null);
  const barRef  = useRef<HTMLDivElement>(null);
  const { stationUuid } = useActiveStation();
  const uuidRef = useRef(stationUuid);
  uuidRef.current = stationUuid;

  useEffect(() => {
    const audio = (window as any).ether?.audio;
    if (!audio?.onProcMeters) return;
    let stale: ReturnType<typeof setTimeout> | null = null;
    const paint = (gr: number | null) => {
      const el = grRef.current, bar = barRef.current;
      if (!el || !bar) return;
      if (gr == null) { el.textContent = "—"; el.style.color = "var(--text-tertiary)"; bar.style.width = "0%"; return; }
      const g = Math.abs(gr);
      // Idle is a real state and says so, rather than showing a confident "0.0".
      el.textContent = g > 0.1 ? `−${g.toFixed(1)} dB` : "idle";
      el.style.color = g > 0.1 ? "var(--accent-amber, #c07820)" : "var(--text-tertiary)";
      // 6 dB of reduction fills the bar — the same scale the Health Monitor's limiter meter uses.
      bar.style.width = `${Math.min(100, (g / 6) * 100)}%`;
    };
    const h = audio.onProcMeters((m: any) => {
      if (!m) return;
      if (uuidRef.current && m.stationUuid != null && m.stationUuid !== uuidRef.current) return;
      paint(typeof m.grDb === "number" ? m.grDb : 0);
      if (stale) clearTimeout(stale);
      stale = setTimeout(() => paint(null), 1500);   // frames stopped → say so, never freeze
    });
    return () => { try { audio.offProcMeters?.(h); } catch { /* ignore */ } if (stale) clearTimeout(stale); };
  }, []);

  return (
    <div title="Limiter gain reduction — how hard the −1 dBTP limiter is working on the programme bus"
         style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 6px 3px" }}>
      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)" }}>LIM</span>
      <div style={{ flex: 1, height: 3, background: "var(--bg-primary)", border: "1px solid var(--border-primary)", overflow: "hidden" }}>
        <div ref={barRef} style={{ height: "100%", width: "0%", background: "var(--accent-amber, #c07820)", transition: "width 90ms linear" }} />
      </div>
      <span ref={grRef} style={{
        fontSize: 9, fontWeight: 700, minWidth: 46, textAlign: "right",
        fontFamily: "'DM Mono', monospace", fontVariantNumeric: "tabular-nums",
        color: "var(--text-tertiary)",
      }}>—</span>
    </div>
  );
}

// ── MasterVU — two-bar L/R canvas meter ──────────────────────
// Subscribes directly to audio:levels IPC — no prop needed.
/** `fill` — stretch to the container instead of the fixed 110px.
 *
 *  The expanded panel stacks the meter among other sections, so a fixed height is right there. The
 *  COLLAPSED rail is the opposite case: the operator gave up the whole panel to keep the level in
 *  view, and a 110px meter in a full-height strip left most of the rail empty with a small meter at
 *  the top — the collapse bought nothing. */
function MasterVU({ fill = false }: { fill?: boolean }) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const levelL     = useRef(0);
  const levelR     = useRef(0);
  const peakL      = useRef(0); const peakLAt = useRef(0);
  const peakR      = useRef(0); const peakRAt = useRef(0);
  const phaseL     = useRef(0);
  const phaseR     = useRef(Math.PI * 0.37);
  const rafRef     = useRef(0);
  const masterRef  = useRef(0);
  const lastFrameMs = useRef(0);   // wall-clock of the previous RAF tick → delta-time ballistics

  // Station scope — master VU shows the active station's master only (ref → switch needs no re-subscribe).
  const { stationUuid } = useActiveStation();
  const myUuidRef = useRef(stationUuid);
  myUuidRef.current = stationUuid;

  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.audio?.onLevels) return;
    const h = ether.audio.onLevels((lvl: { master?: number; a?: number; b?: number; c?: number; stationUuid?: string }) => {
      if (!matchesStation(lvl, myUuidRef.current)) return; // station scope
      masterRef.current = lvl.master ?? Math.max(lvl.a || 0, lvl.b || 0, lvl.c || 0);
    });
    return () => ether.audio.offLevels(h);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.floor(width  * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width  = width  + "px";
        canvas.style.height = height + "px";
      }
    });
    ro.observe(canvas);

    // Cache theme colors — refreshed every 2s so theme switches are reflected
    let cachedBg   = "#080810";
    let cachedTxt2 = "#606070";
    let cachedVu = {
      teal:     "#00c8a8",
      amb:      "#c07820",
      red:      "#c02828",
      peakClip: "#e04040",
      peakWarn: "#d09030",
      peakNorm: "#00d8b0",
      tick:     "rgba(255,255,255,0.04)",
    };
    let colorCacheTs = 0;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return; }
      const w = canvas.width;
      const h = canvas.height;
      const now = Date.now();
      // Elapsed wall-clock since the last RAF tick — drives all ballistics so the meter feel is
      // independent of draw rate AND of the (10 Hz) level feed. Clamp the first frame / a backgrounded
      // tab so a huge dt can't snap the bar.
      const dt = Math.min(now - (lastFrameMs.current || now), 100);
      lastFrameMs.current = now;

      // Refresh theme colors at most every 2 seconds
      if (now - colorCacheTs > 2000) {
        const cs = getComputedStyle(document.documentElement);
        cachedBg   = cs.getPropertyValue("--vu-bg-master").trim()    || "#080810";
        cachedTxt2 = cs.getPropertyValue("--text-secondary").trim()  || "#606070";
        cachedVu = {
          teal:     cs.getPropertyValue("--accent-teal").trim()   || "#00c8a8",
          amb:      cs.getPropertyValue("--accent-amber").trim()  || "#c07820",
          red:      cs.getPropertyValue("--accent-red").trim()    || "#c02828",
          peakClip: cs.getPropertyValue("--vu-peak-clip").trim()  || "#e04040",
          peakWarn: cs.getPropertyValue("--vu-peak-warn").trim()  || "#d09030",
          peakNorm: cs.getPropertyValue("--vu-peak-normal").trim()|| "#00d8b0",
          tick:     cs.getPropertyValue("--vu-tick").trim()       || "rgba(255,255,255,0.04)",
        };
        colorCacheTs = now;
      }

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = cachedBg;
      ctx.fillRect(0, 0, w, h);

      const m = masterRef.current;

      phaseL.current += 0.045;
      phaseR.current += 0.038;
      const wobble = 0.04;
      const targetL = Math.max(0, Math.min(1, m + wobble * Math.sin(phaseL.current)));
      const targetR = Math.max(0, Math.min(1, m + wobble * Math.sin(phaseR.current)));
      // Delta-time attack/decay (taus in lib/vuMeter) — rate-independent, replaces the old fixed
      // per-frame lerp factors that assumed a steady 60fps/30Hz and turned jumpy at the 10 Hz feed.
      levelL.current = vuSmooth(levelL.current, targetL, dt);
      levelR.current = vuSmooth(levelR.current, targetR, dt);

      const drawBar = (
        x: number, barW: number,
        lv: number,
        peakRef: React.MutableRefObject<number>,
        peakAtRef: React.MutableRefObject<number>
      ) => {
        const barH = Math.floor(lv * h);
        const fillY = h - barH;

        ctx.fillStyle = cachedBg;
        ctx.fillRect(x, 0, barW, h);

        if (barH > 0) {
          const grad = ctx.createLinearGradient(x, h, x, fillY);
          if (lv <= 0.60) {
            grad.addColorStop(0, cachedVu.teal); grad.addColorStop(1, "#006058");
          } else if (lv <= 0.80) {
            grad.addColorStop(0, cachedVu.teal); grad.addColorStop(0.7, cachedVu.amb); grad.addColorStop(1, "#905010");
          } else {
            grad.addColorStop(0, cachedVu.teal); grad.addColorStop(0.5, cachedVu.amb); grad.addColorStop(0.8, cachedVu.red); grad.addColorStop(1, "#901818");
          }
          ctx.fillStyle = grad;
          ctx.fillRect(x, fillY, barW, barH);
        }

        const pk = vuPeak(peakRef.current, peakAtRef.current, lv, now, dt);
        peakRef.current   = pk.peak;
        peakAtRef.current = pk.at;
        if (peakRef.current > 0.05) {
          const py = Math.max(1, h - Math.floor(peakRef.current * h) - 1);
          ctx.fillStyle = peakRef.current > 0.80 ? cachedVu.peakClip : peakRef.current > 0.60 ? cachedVu.peakWarn : cachedVu.peakNorm;
          ctx.fillRect(x, py, barW, 1);
        }
      };

      const gap   = 3;
      const barW  = Math.floor((w - gap) / 2);
      drawBar(0,         barW, levelL.current, peakL, peakLAt);
      drawBar(barW + gap, barW, levelR.current, peakR, peakRAt);

      ctx.strokeStyle = cachedVu.tick;
      ctx.lineWidth = 1;
      [0.40, 0.20].forEach(f => {
        const y = Math.floor(h * f);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      });

      ctx.fillStyle = cachedTxt2;
      ctx.font = `700 8px system-ui`;
      ctx.textAlign = "center";
      ctx.fillText("L", barW / 2, h - 2);
      ctx.fillText("R", barW + gap + barW / 2, h - 2);

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, []);

  return (
    <div style={{
      width: "100%",
      // Fill the rail when collapsed; keep the fixed block in the stacked panel.
      height: fill ? "100%" : 110,
      flex: fill ? 1 : undefined,
      minHeight: 0,
      flexShrink: 0,
      background: "var(--recess-bg, var(--vu-bg-master))", boxShadow: "var(--recess-inner-shadow, none)",
      border: "var(--recess-border, none)", borderRadius: "var(--recess-radius, 0px)",
    }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}

// ── Fader ────────────────────────────────────────────────────
function Fader({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const updateFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onChange(ratio);
  }, [onChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    updateFromClientX(e.clientX);
    const onMove = (ev: PointerEvent) => updateFromClientX(ev.clientX);
    const onUp = () => {
      setDragging(false);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }, [updateFromClientX]);

  return (
    <div style={{ padding: "7px 14px", borderBottom: "1px solid var(--border-primary)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase" as const }}>{label}</span>
        <span style={{ fontSize: 13, fontFamily: "'DM Mono', monospace", color: "var(--accent-teal)" }}>{Math.round(value * 100)}</span>
      </div>

      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        style={{
          position: "relative",
          width: "100%", height: 12,
          cursor: dragging ? "grabbing" : "pointer",
          display: "flex", alignItems: "center",
          userSelect: "none",
        }}
      >
        {/* Track — 3px tall horizontal bar */}
        <div style={{
          position: "absolute", left: 0, right: 0, top: "50%",
          transform: "translateY(-50%)",
          height: 3,
          background: "var(--fader-track-bg, rgba(255,255,255,0.08))",
        }} />
        {/* Fill — teal from 0 to thumb */}
        <div style={{
          position: "absolute", left: 0, top: "50%",
          transform: "translateY(-50%)",
          height: 3,
          width: `${value * 100}%`,
          background: "var(--accent-teal)",
          pointerEvents: "none",
        }} />
        {/* Thumb — 12×12 */}
        <div style={{
          position: "absolute",
          left: `${value * 100}%`,
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 12, height: 12,
          borderRadius: "var(--fader-thumb-radius, 50%)",
          background: "var(--accent-teal)",
          backgroundImage: "var(--fader-thumb-gradient, none)",
          border: "var(--fader-thumb-border, 1px solid var(--strip-thumb-border))",
          boxShadow: "var(--fader-thumb-shadow, none)",
          pointerEvents: "none",
        }} />
      </div>
    </div>
  );
}

// ── StatusRow ────────────────────────────────────────────────
function StatusRow({ dot, label, value }: { dot?: string; label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 14px" }}>
      {dot && <div style={{ width: 5, height: 5, borderRadius: "50%", background: dot, flexShrink: 0 }} />}
      <span style={{ fontSize: 12.5, color: "var(--text-secondary)", flex: 1, letterSpacing: "0.03em", textTransform: "uppercase" as const }}>{label}</span>
      <span style={{ fontSize: 13, color: "var(--text-primary)", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{value}</span>
    </div>
  );
}

// ── Console line type ────────────────────────────────────────
interface ConsoleLine {
  id: number;
  ts: number;
  type: ConsoleEventType;
  msg: string;
}

let _lineId = 0;

// ── LiveConsole ──────────────────────────────────────────────
function LiveConsole({ masterLevel }: { masterLevel: number }) {
  const [lines, setLines]   = useState<ConsoleLine[]>([]);
  const [filter, setFilter] = useState<"all" | "error" | "rotation" | "audio">("all");
  const [engineOk, setEngineOk] = useState(true);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const scrollRef   = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const lastLevelLog = useRef(0);
  const masterRef    = useRef(masterLevel);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { masterRef.current = masterLevel; }, [masterLevel]);

  // ── Subscribe to console events ──────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const { type, msg, ts } = (e as CustomEvent).detail as { type: ConsoleEventType; msg: string; ts: number };
      setLines(prev => {
        const next = [...prev, { id: _lineId++, ts, type, msg }];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    };
    window.addEventListener("ether:console", handler);
    return () => window.removeEventListener("ether:console", handler);
  }, []);

  // ── 30-second master output level log ────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const lv = masterRef.current;
      if (lv < 0.01) return; // silent — don't spam
      const db = (ml: number) => ml < 0.001 ? "-inf" : (20 * Math.log10(ml)).toFixed(1);
      consoleLog("info", `[MASTER] Output level: ${db(lv)} dB`);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Silence watchdog — flag engine after 5s silence ──────────
  useEffect(() => {
    if (masterLevel > 0.03) {
      setEngineOk(true);
      if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    } else {
      if (!silenceTimer.current) {
        silenceTimer.current = setTimeout(() => {
          setEngineOk(false);
          silenceTimer.current = null;
        }, 5000);
      }
    }
    return () => {};
  }, [masterLevel]);

  // ── Auto-scroll to bottom (unless user scrolled up) ──────────
  useEffect(() => {
    if (userScrolled.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    userScrolled.current = !atBottom;
  };

  // ── Filtered lines ────────────────────────────────────────────
  const visible = filter === "all" ? lines
    : filter === "error"    ? lines.filter(l => l.type === "error")
    : filter === "rotation" ? lines.filter(l => l.type === "rotation")
    : lines.filter(l => l.type === "audio");

  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
  };

  const FILTERS: Array<{ id: "all" | "error" | "rotation" | "audio"; label: string }> = [
    { id: "all",      label: "ALL" },
    { id: "error",    label: "ERRORS" },
    { id: "rotation", label: "ROTATION" },
    { id: "audio",    label: "AUDIO" },
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      {/* Console header */}
      <div style={{ padding: "6px 10px 5px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 5, height: 5, borderRadius: "50%", background: engineOk ? "var(--status-live)" : "var(--status-error)", flexShrink: 0, animation: engineOk ? "none" : "con-blink 1s step-start infinite" }} />
        <span style={{ fontSize: 11, fontWeight: 400, letterSpacing: "0.02em", color: "var(--text-secondary)", opacity: 0.5, flex: 1 }}>Console</span>
        <button
          onClick={() => { setLines([]); userScrolled.current = false; }}
          style={{ fontSize: 11, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          title="Clear console"
        >CLR</button>
      </div>

      {/* Filter buttons */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {FILTERS.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            flex: 1, padding: "3px 0", fontSize: 11, fontWeight: 700,
            letterSpacing: "0.06em", background: "none", border: "none",
            borderRight: f.id !== "audio" ? "1px solid var(--border-primary)" : "none",
            color: filter === f.id ? "var(--accent-teal)" : "var(--text-secondary)",
            cursor: "pointer",
            borderBottom: filter === f.id ? "1px solid var(--accent-teal)" : "none",
            marginBottom: filter === f.id ? -1 : 0,
          }}>{f.label}</button>
        ))}
      </div>

      {/* Scrolling terminal */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1, overflowY: "auto", background: "var(--bg-primary)",
          padding: "4px 0",
          fontSize: 13, fontFamily: "var(--font-mono, 'DM Mono', 'Courier New', monospace)",
          lineHeight: 1.5,
          // thin scrollbar
          scrollbarWidth: "thin" as const,
          scrollbarColor: "var(--border-primary) transparent",
        }}
      >
        {visible.length === 0 ? (
          <div style={{ padding: "8px 10px", color: "var(--text-tertiary)", opacity: 0.4, fontSize: 12, fontStyle: "italic" }}>Waiting for events…</div>
        ) : visible.map(line => (
          <div key={line.id} style={{
            display: "flex", gap: 4,
            padding: "1px 10px",
            borderBottom: "none",
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
          }}>
            <span style={{ color: "var(--text-tertiary)", opacity: 0.5, flexShrink: 0, fontSize: 12 }}>{fmtTime(line.ts)}</span>
            <span style={{ color: TYPE_COLOR[line.type], overflow: "hidden", textOverflow: "ellipsis" }}>{line.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <style>{`
        @keyframes con-blink {
          0%,100%{opacity:1;} 50%{opacity:0.2;}
        }
      `}</style>
    </div>
  );
}

// ── MasterOutput ─────────────────────────────────────────────
// ── Expanded-mode helpers ─────────────────────────────────────

function fmtSec(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** SVG stroke-dasharray arc, starts at 12 o'clock */
function ArcProgress({ pct, size = 52, stroke = 3, color = TEAL, label }: {
  pct: number; size?: number; stroke?: number; color?: string; label?: string;
}) {
  const r = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(1, pct)));
  const c = size / 2;
  return (
    <svg width={size} height={size} style={{ display: "block", transform: "rotate(-90deg)" }}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--bg-tertiary)" strokeWidth={stroke} />
      <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="butt" style={{ transition: "stroke-dashoffset 0.8s ease" }}
      />
      {label && (
        <text x={c} y={c + 1} textAnchor="middle" dominantBaseline="middle"
          style={{ fontSize: 13, fill: "var(--text-tertiary)", fontFamily: "'DM Mono',monospace", transform: "rotate(90deg)", transformOrigin: `${c}px ${c}px` }}>
          {label}
        </text>
      )}
    </svg>
  );
}

// ── MasterOutput ─────────────────────────────────────────────
export default function MasterOutput({ expanded, collapsed = false, onToggleCollapsed }: { expanded?: boolean; collapsed?: boolean; onToggleCollapsed?: () => void }) {
  const engine = useAudioEngine();
  const { stationId, stationUuid, isReady } = useActiveStation();
  const [masterLevel, setMasterLevel] = useState(0);
  const [masterVol,  setMasterVol]  = useState(1.0);
  const [monitorVol, setMonitorVol] = useState(() => {
    try { return parseFloat(localStorage.getItem('ether_monitor_vol') ?? '0.8'); } catch { return 0.8; }
  });
  const [stationInfoOpen, setStationInfoOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_station_info_collapsed") !== "1"; } catch { return true; }
  });
  const [nowPlayingOpen, setNowPlayingOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_now_playing_collapsed") !== "1"; } catch { return true; }
  });
  const [nextUpRightOpen, setNextUpRightOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_next_up_right_collapsed") !== "1"; } catch { return true; }
  });
  const [showProgressOpen, setShowProgressOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_show_progress_collapsed") !== "1"; } catch { return true; }
  });
  const [healthOpen, setHealthOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_health_mini_collapsed") !== "1"; } catch { return true; }
  });
  const healthSnap = useAudioHealth();   // MINI Health Monitor feed (shared with the full page)
  const [nextBreak,  setNextBreak]  = useState("—");
  const [onAir,      setOnAir]      = useState(false);
  const [uptime,     setUptime]     = useState("0:00");
  const sessionStart = useRef<number>(0);

  // Subscribe to audio:levels directly — keeps masterLevel out of App.tsx state
  // so the library table doesn't re-render at 30Hz.
  // Station scope — render the active station's master only (ref so a switch needs no re-subscribe).
  const masterUuidRef = useRef(stationUuid);
  masterUuidRef.current = stationUuid;
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.audio?.onLevels) return;
    const h = ether.audio.onLevels((lvl: { master?: number; a?: number; b?: number; c?: number; stationUuid?: string }) => {
      if (!matchesStation(lvl, masterUuidRef.current)) return; // station scope
      setMasterLevel(lvl.master ?? Math.max(lvl.a || 0, lvl.b || 0, lvl.c || 0));
    });
    return () => ether.audio.offLevels(h);
  }, []);

  // ── Expanded-mode state ───────────────────────────────────────
  const [activeDeck,  setActiveDeck]  = useState<{ title: string; artist: string; positionSec: number; durationSec: number } | null>(null);
  const [queueItems,  setQueueItems]  = useState<{ title: string; artist: string; durationSec?: number }[]>([]);
  const [currentShow, setCurrentShow] = useState<{ name: string; startH: number; endH: number } | null>(null);
  const [nowSec,      setNowSec]      = useState(() => { const n = new Date(); return n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds(); });

  useEffect(() => {
    if (!expanded) return;
    const pull = () => {
      const decks = (["A", "B", "C"] as const).map(id => engine.getDeck(id)?.getState?.());
      const playing = decks.find(d => d?.status === "playing") ?? decks.find(d => d?.status === "paused") ?? null;
      setActiveDeck(playing && playing.title ? { title: playing.title, artist: playing.artist || "", positionSec: playing.positionSec ?? 0, durationSec: playing.durationSec ?? 0 } : null);
      setQueueItems((engine.getQueue() as any[]).slice(0, 3).map(q => ({ title: q.title || "", artist: q.artist || "", durationSec: q.durationSec })));
    };
    pull();
    const unsub = engine.on(() => pull());
    const tick = setInterval(() => { pull(); setNowSec(s => s + 10); }, 10_000);
    return () => { unsub(); clearInterval(tick); };
  }, [expanded, engine]);

  useEffect(() => {
    if (!expanded) return;
    const load = async () => {
      try {
        const h = new Date().getHours();
        const rows = await queryScoped<{ name: string; start_hour: number; end_hour: number }>(
          "SELECT name, start_hour, end_hour FROM shows WHERE is_active=1 AND deleted_at IS NULL AND start_hour <= ? ORDER BY start_hour DESC LIMIT 1", [h], stationId
        );
        if (rows.length > 0) setCurrentShow({ name: rows[0].name, startH: rows[0].start_hour, endH: rows[0].end_hour });
        else setCurrentShow(null);
      } catch { setCurrentShow(null); }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [expanded]);

  // ── Master EQ ────────────────────────────────────────────────
  const [eqOpen,  setEqOpen]  = useState(false);
  const [eqBands, setEqBands] = useState<number[]>(EQ_DEFAULT);
  const eqActive = eqBands.some(g => Math.abs(g) > 0.05);

  useEffect(() => {
    query<{ value: string }>("SELECT value FROM station_config_kv WHERE key='eq_master'", [])
      .then(rows => { if (rows[0]?.value) { try { setEqBands(JSON.parse(rows[0].value)); } catch {} } })
      .catch(() => {});
  }, []);

  const handleMasterEqChange = useCallback((bands: number[]) => {
    setEqBands(bands);
    (window as any).ether.stationConfigKv.upsertByKey(stationId, 'eq_master', JSON.stringify(bands));
    try { const w = window as any; if (w.ether?.audio?.setEq) w.ether.audio.setEq("master", bands); } catch {}
  }, [stationId]);

  // Session uptime
  useEffect(() => {
    const stored = sessionStorage.getItem("ether_session_start");
    if (stored) {
      sessionStart.current = parseInt(stored, 10);
    } else {
      sessionStart.current = Date.now();
      sessionStorage.setItem("ether_session_start", String(sessionStart.current));
    }
    const id = setInterval(() => {
      const sec = Math.floor((Date.now() - sessionStart.current) / 1000);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      setUptime(h > 0
        ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
        : `${m}:${String(s).padStart(2,"0")}`);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // On-air detection from master level
  useEffect(() => {
    setOnAir(masterLevel > 0.03);
  }, [masterLevel]);

  // MASTER OUT = the broadcast. Rides the program bus in Rust, pre-meter, so listeners hear it and the
  // master VU shows what went out. __etherMasterVol is GONE: it was a workaround for the missing gain
  // stage that only applied master at the instant somebody dragged a DECK fader, which is why the
  // master fader appeared to do nothing. docs/master-monitor-faders-dead-2026-08-06.md
  const applyMaster = useCallback((v: number) => {
    setMasterVol(v);
    try { engine?.setMasterVolume?.(v); } catch { /* engine absent */ }
  }, [engine]);

  useEffect(() => {
    try { localStorage.setItem('ether_monitor_vol', String(monitorVol)); } catch {}
  }, [monitorVol]);

  // ── MONITOR = the ONE master room level ───────────────────────────────────────────────────────
  // It scales the FINISHED monitor mix and calls nothing on any individual channel.
  //
  // 4.4.154 got this wrong: it called audio.setMonitorVolume(stationId, v) — which is the PER-STATION
  // strip level owned by StationMonitorMixer. Pulling Halloween's strip down and then raising MONITOR
  // wrote Halloween's own level back up, because both controls were writing the same variable. A
  // channel pulled down must STAY down. Now it drives a separate global gain in Rust
  // (MASTER_MONITOR_VOL), multiplied with each station's strip level in the device branch only.
  // docs/master-monitor-faders-dead-2026-08-06.md §7
  const applyMonitor = useCallback((v: number) => {
    setMonitorVol(v);
    try { (window as any).ether?.audio?.setMasterMonitorVolume?.(v); } catch { /* engine absent */ }
  }, []);

  // Re-apply the remembered room level once audio is up, so it survives a restart. Global, so it does
  // not depend on which station is active and cannot disturb anyone's strip.
  const monitorPrimed = useRef(false);
  useEffect(() => {
    if (!isReady || monitorPrimed.current) return;
    monitorPrimed.current = true;
    if (monitorVol !== 1) applyMonitor(monitorVol);
  }, [isReady, monitorVol, applyMonitor]);
  useEffect(() => {
    try { localStorage.setItem("ether_station_info_collapsed", stationInfoOpen ? "0" : "1"); } catch {}
  }, [stationInfoOpen]);
  useEffect(() => {
    try { localStorage.setItem("ether_now_playing_collapsed", nowPlayingOpen ? "0" : "1"); } catch {}
  }, [nowPlayingOpen]);
  useEffect(() => {
    try { localStorage.setItem("ether_next_up_right_collapsed", nextUpRightOpen ? "0" : "1"); } catch {}
  }, [nextUpRightOpen]);
  useEffect(() => {
    try { localStorage.setItem("ether_show_progress_collapsed", showProgressOpen ? "0" : "1"); } catch {}
  }, [showProgressOpen]);
  useEffect(() => {
    try { localStorage.setItem("ether_health_mini_collapsed", healthOpen ? "0" : "1"); } catch {}
  }, [healthOpen]);

  // Query next show boundary
  useEffect(() => {
    const load = async () => {
      try {
        const hour = new Date().getHours();
        const shows = await queryScoped<{ name: string; start_hour: number }>(
          "SELECT name, start_hour FROM shows WHERE is_active=1 AND deleted_at IS NULL AND start_hour > ? ORDER BY start_hour LIMIT 1",
          [hour], stationId
        );
        if (shows.length > 0) {
          const h = shows[0].start_hour;
          const suffix = h >= 12 ? "PM" : "AM";
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          setNextBreak(`${h12}:00 ${suffix}`);
        } else {
          setNextBreak("—");
        }
      } catch { setNextBreak("—"); }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // Limiter simulation: 0 to -6dB reduction above 85%
  const limitDb = masterLevel > 0.85
    ? -((masterLevel - 0.85) / 0.15 * 6).toFixed(1)
    : "0.0";

  // Expanded-mode computed values
  const playPct = activeDeck && activeDeck.durationSec > 0
    ? Math.max(0, Math.min(1, activeDeck.positionSec / activeDeck.durationSec)) : 0;
  const timeRemaining = activeDeck && activeDeck.durationSec > 0
    ? activeDeck.durationSec - activeDeck.positionSec : null;
  const showPct = currentShow ? (() => {
    const endH = currentShow.endH === 0 ? 24 : currentShow.endH <= currentShow.startH ? currentShow.endH + 24 : currentShow.endH;
    const total = (endH - currentShow.startH) * 3600;
    const elapsed = nowSec - currentShow.startH * 3600;
    return Math.max(0, Math.min(1, elapsed / total));
  })() : 0;

  // ── Collapsed mode: thin 36px strip with VU + on-air dot + expand chevron ──
  if (collapsed) {
    return (
      <div style={{
        width: 36, flexShrink: 0, display: "flex", flexDirection: "column",
        background: "var(--bg-secondary)", borderLeft: "1px solid var(--border-primary)",
        color: "var(--text-primary)", overflow: "hidden", userSelect: "none",
      }}>
        <button
          onClick={onToggleCollapsed}
          title="Expand master output panel"
          style={{ height: 28, background: "var(--bg-tertiary)", border: "none", borderBottom: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        {/* THE METER IS THE POINT OF THE COLLAPSED RAIL. It fills the whole height — that is what a
            collapsed panel is for: the operator gave up the panel and kept the level. LimiterGR is
            deliberately NOT here: at 36px wide its label, bar and readout squeezed the VU to a
            sliver, which is the opposite of collapsing for a bigger meter. It lives in the expanded
            panel beside the meter it explains. */}
        <div style={{ flex: 1, minHeight: 0, padding: "6px 5px", display: "flex", alignItems: "stretch" }}>
          <MasterVU fill />
        </div>
        <div style={{ padding: "6px 4px", borderTop: "1px solid var(--border-primary)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div title={onAir ? "ON AIR" : "STANDBY"} style={{ width: 8, height: 8, borderRadius: "50%", background: onAir ? "var(--status-live)" : "var(--status-offline)", boxShadow: onAir ? "0 0 6px var(--status-live)" : "none" }} />
          <div style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", writingMode: "vertical-rl" as const, transform: "rotate(180deg)", letterSpacing: "0.08em" }}>{uptime}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      width: expanded ? undefined : 280,
      flex: expanded ? 1 : undefined,
      minWidth: expanded ? 280 : undefined,
      flexShrink: 0, display: "flex", flexDirection: "column",
      background: "var(--bg-secondary)", borderLeft: "1px solid var(--border-primary)",
      fontSize: 14, color: "var(--text-primary)", overflow: "hidden",
      userSelect: "none",
    }}>
      {/* Header — full-width strip with a prominent collapse chevron on the left.
          The chevron button is intentionally large (32×30) and contrast-bg so it is
          obvious how to close the panel after expanding it. */}
      <div style={{ display: "flex", alignItems: "stretch", flexShrink: 0, borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", height: 30 }}>
        {onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            title="Collapse master output panel"
            style={{
              width: 32, background: "transparent", border: "none",
              borderRight: "1px solid var(--border-primary)",
              color: "var(--text-secondary)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: 0, transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={e => { const el = e.currentTarget as HTMLButtonElement; el.style.background = "var(--master-collapse-bg)"; el.style.color = "var(--master-collapse-text)"; }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLButtonElement; el.style.background = "transparent"; el.style.color = "var(--text-secondary)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        )}
        <div style={{ flex: 1, padding: "0 12px", display: "flex", alignItems: "center", justifyContent: "space-between", minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" as const }}>
            Master Out
          </span>
          <button
            title="Pop out to separate window"
            onClick={() => (window as any).ether?.invoke("window:popout", "master")}
            style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "1px 4px", display: "flex", alignItems: "center", transition: "color 0.12s", borderRadius: 0 }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = "var(--master-popout-text)"}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = "var(--text-tertiary)"}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Body — scrollable so all content (faders, EQ, status, expanded sections, console)
          remains reachable on short screens. The header above stays pinned at the top. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column" }}>

      {/* VU meters */}
      <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: "var(--text-secondary)", letterSpacing: "0.02em", marginBottom: 6, opacity: 0.5 }}>Output level</div>
        <MasterVU />
        <LimiterGR />
      </div>

      {/* Faders */}
      <Fader label="Master" value={masterVol} onChange={applyMaster} />
      <Fader label="Monitor" value={monitorVol} onChange={applyMonitor} />

      {/* Limiter */}
      <div style={{ padding: "6px 14px", borderBottom: "1px solid var(--border-primary)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 400, letterSpacing: "0.02em", color: "var(--text-secondary)", opacity: 0.5 }}>Limiter</span>
        <span style={{
          fontSize: 13, fontFamily: "'DM Mono', monospace",
          color: masterLevel > 0.85 ? "var(--accent-amber)" : "var(--accent-teal)",
        }}>{limitDb} dB</span>
      </div>

      {/* Master EQ toggle */}
      <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <div style={{
            width: 7, height: 7, borderRadius: "50%",
            background: eqActive ? "var(--accent-amber)" : "var(--border-primary)",
            boxShadow: eqActive ? "0 0 6px var(--accent-amber)" : "none",
            transition: "all 0.2s",
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase" as const }}>Master EQ</span>
        </div>
        <button
          onClick={() => setEqOpen(o => !o)}
          title="Open the live 10-band master EQ"
          style={{
            fontSize: 13, fontWeight: 800, letterSpacing: "0.1em",
            padding: "4px 14px", borderRadius: 4,
            background: eqOpen ? "rgb(from var(--accent-cyan) r g b / 0.2)" : "rgb(from var(--accent-cyan) r g b / 0.1)",
            border: "1px solid rgb(from var(--accent-cyan) r g b / 0.45)",
            color: "var(--accent-cyan)",
            cursor: "pointer", transition: "all 0.15s",
          }}
        >{eqOpen ? "CLOSE" : "OPEN"}</button>
      </div>

      {eqOpen && (
        <MasterEQRack
          bands={eqBands}
          onChange={handleMasterEqChange}
          onClose={() => setEqOpen(false)}
        />
      )}

      {/* Station status — collapsible */}
      <div style={{ flexShrink: 0 }}>
        <div
          onClick={() => setStationInfoOpen(o => !o)}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", cursor: "pointer", flexShrink: 0, background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", userSelect: "none" as const }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            style={{ color: "var(--text-secondary)", transform: stationInfoOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" as const }}>Station</span>
        </div>
        {stationInfoOpen && (
          <>
            <StatusRow dot={onAir ? "var(--status-live)" : "var(--status-offline)"} label="On Air" value={onAir ? "LIVE" : "STBY"} />
            <StatusRow dot="var(--status-offline)" label="Stream" value="—" />
            <StatusRow label="Uptime" value={uptime} />
            <StatusRow label="Next Break" value={nextBreak} />
          </>
        )}
      </div>

      {/* Per-station monitor mixer — each station's local speaker level (broadcasts unaffected) */}
      <StationMonitorMixer />
      {/* Aux decks D–F: one slot each, in the same monitors area (Jeff, 2026-08-18). */}
      <AuxMonitorSlots />

      {/* ── Expanded sections — only when cart wall is hidden ── */}
      {expanded && (
        <>
          {/* NOW PLAYING */}
          <div style={{ flexShrink: 0 }}>
            <div
              onClick={() => setNowPlayingOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", cursor: "pointer", flexShrink: 0, background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", userSelect: "none" as const }}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                style={{ color: "var(--text-secondary)", transform: nowPlayingOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" as const }}>Now playing</span>
            </div>
            {nowPlayingOpen && (
              <div style={{ padding: "8px 14px" }}>
                {activeDeck ? (
                  <>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, letterSpacing: "-0.01em", marginBottom: 2 }}>
                      {activeDeck.title}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, marginBottom: 7 }}>
                      {activeDeck.artist || "—"}
                    </div>
                    {/* Progress bar */}
                    <div style={{ height: 3, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden", marginBottom: 4 }}>
                      <div style={{ height: "100%", width: `${playPct * 100}%`, background: "var(--accent-teal)", transition: "width 1s linear" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "'DM Mono',monospace" }}>{fmtSec(activeDeck.positionSec)}</span>
                      <span style={{ fontSize: 12, color: timeRemaining !== null && timeRemaining < 30 ? "var(--accent-amber)" : "var(--text-tertiary)", fontFamily: "'DM Mono',monospace" }}>
                        -{fmtSec(timeRemaining ?? 0)}
                      </span>
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: "var(--text-tertiary)", fontStyle: "italic" }}>No track playing</div>
                )}
              </div>
            )}
          </div>

          {/* NEXT UP */}
          <div style={{ flexShrink: 0 }}>
            <div
              onClick={() => setNextUpRightOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", cursor: "pointer", flexShrink: 0, background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", userSelect: "none" as const }}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                style={{ color: "var(--text-secondary)", transform: nextUpRightOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" as const }}>Next up</span>
            </div>
            {nextUpRightOpen && (
              <div style={{ padding: "8px 14px" }}>
                {queueItems.length > 0 ? queueItems.map((item, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "3px 0", borderBottom: i < queueItems.length - 1 ? "1px solid var(--border-primary)" : "none" }}>
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "'DM Mono',monospace", flexShrink: 0, minWidth: 10 }}>{i + 1}</span>
                    <span style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1, fontWeight: 500 }}>{item.title}</span>
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "'DM Mono',monospace", flexShrink: 0 }}>{item.durationSec ? fmtSec(item.durationSec) : "—"}</span>
                  </div>
                )) : (
                  <div style={{ fontSize: 13, color: "var(--text-tertiary)", fontStyle: "italic" }}>Queue empty</div>
                )}
              </div>
            )}
          </div>

          {/* SHOW ARC */}
          <div style={{ flexShrink: 0 }}>
            <div
              onClick={() => setShowProgressOpen(o => !o)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", cursor: "pointer", flexShrink: 0, background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)", userSelect: "none" as const }}
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
                style={{ color: "var(--text-secondary)", transform: showProgressOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-secondary)", textTransform: "uppercase" as const }}>Show progress</span>
            </div>
            {showProgressOpen && (
              <div style={{ padding: "8px 14px" }}>
                {currentShow ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <ArcProgress pct={showPct} size={50} stroke={4} color="var(--accent-teal)" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, marginBottom: 2 }}>
                        {currentShow.name}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "'DM Mono',monospace" }}>
                        {Math.round(showPct * 100)}% elapsed
                      </div>
                      <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                        Ends {currentShow.endH === 0 ? "12 AM" : currentShow.endH < 12 ? `${currentShow.endH} AM` : currentShow.endH === 12 ? "12 PM" : `${currentShow.endH - 12} PM`}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: "var(--text-tertiary)", fontStyle: "italic" }}>No active show</div>
                )}
              </div>
            )}
          </div>

          {/* HEALTH MONITOR (mini) — live per-station health, directly under Show Progress */}
          <div style={{ flexShrink: 0 }}>
            <HealthStyles />
            <div onClick={() => setHealthOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", cursor: "pointer" }}>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ transform: healthOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s", color: "var(--text-tertiary)" }}>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-secondary)" }}>Health Monitor</span>
            </div>
            {healthOpen && (
              <div style={{ padding: "4px 12px 8px" }}>
                <HealthModeBanner mode={healthSnap?.mode} compact />
                {(healthSnap?.stations || []).length === 0 && (
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>waiting for health feed…</div>
                )}
                {(healthSnap?.stations || []).map(s => (
                  <div key={s.uuid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12 }}>
                    <HealthDot level={s.level} />
                    <span style={{ minWidth: 90, color: "var(--text-primary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name || `Station ${s.stationId}`}</span>
                    <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{rateLabel(s.framesPerSec)} {peakLabel(s.peak)}</span>
                    {s.level !== "GREEN" && s.reason && (
                      <span style={{ marginLeft: "auto", color: LEVEL_COLOR[s.level], fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 130 }}>{s.reason}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Live console — fills all remaining space */}
      <LiveConsole masterLevel={masterLevel} />
      </div>{/* /scrollable body */}
    </div>
  );
}
