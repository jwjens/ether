// ConsoleStrip.tsx — Wheatstone-style broadcast console channel strip.
//
// Fader: tall narrow rail (min 180px), wide flat horizontal cap (landscape).
// Scale: +6 (reference), 0, −10, −20, −40, −60, ∞ dB on the right of the rail.
// 0 dB has a wider tick + a bright notch on the rail surface for tactile reference.
// VU meter: full height, right side, same color coding as before.

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useMidiState } from "./MidiEngine";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { playClick } from "../lib/uiSound";

interface Props {
  label: string;
  color: string;
  volume: number;
  level?: number;
  isPlaying: boolean;
  isOn: boolean;
  onVolumeChange: (v: number) => void;
  onToggleOn: () => void;
  onPfl?: () => void;
  compact?: boolean;
  /** When provided the strip subscribes to audio:levels IPC directly
   *  and updates the VU bar without triggering React state. */
  deckId?: string;
  /** Hide the channel label row — used when an external bar (ThreeSlotBar) shows it instead. */
  hideLabel?: boolean;
}

// Fader cap: wide flat horizontal bar, like a real broadcast console cap
const KNOB_H = 80;  // height of the cap
const KNOB_W = 46;  // width of the cap

// Fader uses a dB-linear taper: position maps linearly to dB (0 dB at top, −60 dB at bottom).
// This matches real broadcast console scaling and keeps scale labels evenly distributed.
const DB_FLOOR = 60; // fader bottom = −60 dB; below this snaps volume to 0

const DB_MARKS: { label: string; db: number; isUnity?: boolean }[] = [
  { label: "0",   db: 0,         isUnity: true },
  { label: "−10", db: -10 },
  { label: "−20", db: -20 },
  { label: "−40", db: -40 },
  { label: "−60", db: -60 },
  { label: "∞",   db: -Infinity },
];

export default function ConsoleStrip({
  label, color, volume, level = 0, isPlaying, isOn, onVolumeChange, onToggleOn, onPfl, compact, deckId, hideLabel,
}: Props) {
  const engine = useAudioEngine();
  const midi = useMidiState();
  const [dragging, setDragging] = useState(false);
  // Local drag value: the knob follows the pointer instantly off this, instead of waiting
  // for the audio-engine state to round-trip back into `volume` (which ticks, so the knob
  // would skip between positions). Null when not dragging → fall back to the real volume.
  const [dragVol, setDragVol] = useState<number | null>(null);
  const [pflActive, setPflActive] = useState(false);
  // trackRef: the invisible full-area mouse capture overlay
  const trackRef = useRef<HTMLDivElement>(null);
  // faderAreaRef: the flex container we measure for faderH
  const faderAreaRef = useRef<HTMLDivElement>(null);
  // VU DOM refs for direct update when deckId is provided
  const vuFillRef   = useRef<HTMLDivElement>(null);
  const vuPeakRef   = useRef<HTMLDivElement>(null);
  const isOnRef     = useRef(isOn);
  const isPlayingRef = useRef(isPlaying);
  const colorRef    = useRef(color);
  const fillRef      = useRef<HTMLDivElement>(null);
  const fillTrackRef = useRef<string>("");
  const [faderH, setFaderH] = useState(220);

  // Measure actual rendered height so knob position math stays accurate
  useEffect(() => {
    const el = faderAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setFaderH(Math.floor(e.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sync prop refs so the onLevels handler always sees current values
  useEffect(() => { isOnRef.current = isOn; },       [isOn]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { colorRef.current = color; },     [color]);

  // Progress fill — imperative DOM, no React state, same pattern as VU
  useEffect(() => {
    if (fillRef.current) fillRef.current.style.width = "0%";
  }, []);

  useEffect(() => {
    if (!deckId) return;
    const unsub = engine.on(() => {
      const da = engine.getDeck(deckId.toUpperCase() as "A" | "B" | "C")?.getState?.();
      if (!da) return;
      const trackKey = `~${Math.round(da.durationSec ?? 0)}`;
      const fill = fillRef.current;
      if (!fill) return;
      if (da.status === "playing" && da.durationSec > 0 && trackKey !== fillTrackRef.current) {
        fillTrackRef.current = trackKey;
        const startPct  = da.durationSec > 0 ? (da.positionSec / da.durationSec) * 100 : 0;
        const remaining = Math.max(0, (da.durationSec ?? 0) - (da.positionSec ?? 0));
        fill.style.transition = "none";
        fill.style.width = `${startPct}%`;
        void fill.offsetWidth;
        fill.style.transition = `width ${remaining}s linear`;
        fill.style.width = "100%";
      }
      if (da.status !== "playing") {
        fill.style.transition = "none";
        const pct = da.durationSec > 0 ? (da.positionSec / da.durationSec) * 100 : 0;
        fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        fillTrackRef.current = "";
      }
    });
    return () => unsub();
  }, [deckId, engine]);

  // Direct DOM VU update when deckId is provided — bypasses React state
  // so the parent (App.tsx) doesn't re-render the library table on each tick.
  useEffect(() => {
    if (!deckId) return;
    const ether = (window as any).ether;
    if (!ether?.audio?.onLevels) return;
    let rafId = 0;
    let pendingH = 0;
    const h = ether.audio.onLevels((lvl: { a?: number; b?: number; c?: number; master?: number }) => {
      const id = deckId.toUpperCase();
      let raw = id === "A" ? (lvl.a ?? 0)
              : id === "B" ? (lvl.b ?? 0)
              : id === "C" ? (lvl.c ?? 0)
              : (lvl.master ?? 0);
      if (id === "MIC") raw = isOnRef.current ? (lvl.master ?? 0) * 0.6 : 0;
      raw = isPlayingRef.current ? raw : raw * 0.05;
      pendingH = Math.min(1, raw);
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const fill = vuFillRef.current;
        const peak = vuPeakRef.current;
        if (!fill) return;
        const vuH = pendingH;
        const c = colorRef.current;
        const vuColor = vuH > 0.85 ? "var(--accent-red)" : vuH > 0.6 ? "var(--accent-amber)" : c;
        fill.style.height  = `${vuH * 100}%`;
        fill.style.opacity = isOnRef.current ? "0.9" : "0.04";
        if (peak) {
          peak.style.bottom     = `${vuH * 100}%`;
          peak.style.background = vuColor;
          peak.style.boxShadow  = `0 0 6px ${vuColor}`;
          peak.style.display    = isOnRef.current && vuH > 0.02 ? "block" : "none";
        }
      });
    });
    return () => { ether.audio.offLevels(h); cancelAnimationFrame(rafId); };
  }, [deckId]);

  // MIDI hardware fader sync
  const midiKey = `deck_${label.toLowerCase().replace(/[^a-z]/g, "")}_volume`;
  const midiVolume = midi.faderPositions[midiKey];
  useEffect(() => {
    if (midiVolume !== undefined && Math.abs(midiVolume - volume) > 0.02) {
      onVolumeChange(midiVolume);
    }
  }, [midiVolume]);

  // Top offset of the knob cap — dB-linear taper so scale marks are evenly spaced.
  // 0 dB → knobY=0 (top); −60 dB → knobY=faderH−KNOB_H (bottom).
  const effVol = dragVol ?? volume; // pointer-driven while dragging, real volume otherwise
  const volDb = effVol > 0.001 ? 20 * Math.log10(effVol) : -DB_FLOOR;
  const knobY = (Math.max(-DB_FLOOR, Math.min(0, volDb)) / -DB_FLOOR) * (faderH - KNOB_H);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
    const track = trackRef.current;
    if (!track) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const posToVol = (clientY: number, rect: DOMRect) => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      if (ratio >= 0.999) return 0;
      const db = -ratio * DB_FLOOR;
      return Math.pow(10, db / 20);
    };
    const onMove = (ev: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const v = posToVol(ev.clientY, rect);
      setDragVol(v);          // knob follows the pointer instantly
      onVolumeChange(v);      // engine gets the value too
    };
    const onUp = () => {
      setDragging(false);
      setDragVol(null);       // hand the knob back to the real volume
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    const rect = track.getBoundingClientRect();
    const v0 = posToVol(e.clientY, rect);
    setDragVol(v0);
    onVolumeChange(v0);
  }, [onVolumeChange]);

  const db = effVol > 0.001 ? (20 * Math.log10(effVol)).toFixed(0) : "−∞";
  const vuH = Math.min(1, level * (isOn ? 1 : 0.05));
  const vuColor = level > 0.85 ? "var(--accent-red)" : level > 0.6 ? "var(--accent-amber)" : color;

  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      backgroundColor: "var(--panel-bg, #1a1a20)",
      backgroundImage: "var(--panel-gradient, none)",
      borderRight: "var(--panel-border, 1px solid #252530)",
      boxShadow: "var(--panel-outer-shadow, none)",
      userSelect: "none", overflow: "hidden",
    }}>

      {/* ── Channel label — hidden when ThreeSlotBar provides it externally ── */}
      {!hideLabel && (
        <div style={{
          width: "100%", padding: "8px 0",
          background: isOn && isPlaying ? `${color}28` : "var(--strip-label-bg, transparent)",
          borderBottom: "1px solid var(--strip-divider, #303040)",
          textAlign: "center",
          fontSize: 11, fontWeight: 800, letterSpacing: "0.14em",
          position: "relative", overflow: "hidden",
          transition: "background 0.3s",
        }}>
          {deckId && (
            <div ref={fillRef} style={{
              position: "absolute", top: 0, left: 0, bottom: 0,
              background: color,
              zIndex: 0, pointerEvents: "none",
            }} />
          )}
          <span style={{
            position: "relative", zIndex: 1,
            color: isOn && isPlaying ? "#fff" : (isOn ? color : "var(--strip-label-text, #555)"),
            textShadow: isOn && isPlaying ? "0 1px 3px rgba(0,0,0,0.6)" : "none",
            transition: "color 0.2s",
          }}>{label}</span>
        </div>
      )}

      {/* ── Main area: fader column + VU meter ── */}
      <div ref={faderAreaRef} style={{
        flex: 1, width: "100%", display: "flex", gap: 0,
        padding: "10px 8px 8px",
        minHeight: 180, overflow: "hidden",
        position: "relative",
      }}>

        {/* ── Fader column: rail, scale, and knob cap ── */}
        <div style={{
          width: 72, flexShrink: 0, height: "100%", position: "relative", zIndex: 1,
        }}>

          {/* Mouse / touch capture — covers full column, sits above all visuals */}
          <div
            ref={trackRef}
            onPointerDown={handlePointerDown}
            style={{
              position: "absolute", inset: 0,
              cursor: dragging ? "grabbing" : "ns-resize",
              zIndex: 10,
            }}
          />

          {/* Rail groove — narrow recessed channel */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            top: KNOB_H / 2, bottom: KNOB_H / 2,
            width: 8,
            background: "#07070e",
            border: "1px solid #252535",
            boxShadow: "inset 0 2px 8px rgba(0,0,0,0.9), inset 0 0 3px rgba(0,0,0,0.5)",
          }} />

          {/* Active fill — colored segment from bottom to knob */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            bottom: KNOB_H / 2,
            height: Math.max(0, (faderH - KNOB_H) - knobY),
            width: 6,
            background: isOn ? color : "#444",
            opacity: isOn ? 0.42 : 0.07,
            transition: dragging ? "none" : "height 0.08s ease-out",
          }} />

          {/* +6 dB reference label at top — not a reachable fader position,
              shown as a headroom marker matching real broadcast console scales */}
          <div style={{
            position: "absolute",
            top: 0, right: 2,
            fontSize: 7, lineHeight: 1,
            fontFamily: "'DM Mono', ui-monospace, monospace",
            color: "var(--scale-text, rgba(255,255,255,0.14))",
            pointerEvents: "none", zIndex: 1,
          }}>+6</div>

          {/* dB scale: tick marks + labels on the right side of the rail */}
          {DB_MARKS.map(({ label: lbl, db, isUnity }) => {
            // y is the pixel offset from top of the fader column where this dB mark falls
            const y = isFinite(db)
              ? (Math.max(-DB_FLOOR, Math.min(0, db)) / -DB_FLOOR) * (faderH - KNOB_H) + KNOB_H / 2
              : (faderH - KNOB_H) + KNOB_H / 2; // ∞ sits at very bottom
            return (
              <React.Fragment key={lbl}>

                {/* Tick line — extends right from the rail edge */}
                <div style={{
                  position: "absolute",
                  // left edge starts just outside the rail right edge (50% + half-rail = 50%+4px)
                  left: "calc(50% + 5px)",
                  top: y,
                  width: isUnity ? 16 : 9,
                  height: 1,
                  background: isUnity
                    ? "var(--scale-tick-unity, rgba(255,255,255,0.50))"
                    : "var(--scale-tick, rgba(255,255,255,0.14))",
                  pointerEvents: "none", zIndex: 1,
                }} />

                {/* 0 dB notch highlight on the rail surface — tactile reference point */}
                {isUnity && (
                  <div style={{
                    position: "absolute",
                    left: "50%", transform: "translateX(-50%)",
                    top: y - 1, height: 3, width: 10,
                    background: "var(--scale-tick-unity, rgba(255,255,255,0.22))",
                    boxShadow: "0 0 5px rgba(255,255,255,0.10)",
                    pointerEvents: "none", zIndex: 2,
                  }} />
                )}

                {/* Label text */}
                <div style={{
                  position: "absolute",
                  top: y - 4, right: 2,
                  fontSize: 7, lineHeight: 1,
                  fontFamily: "'DM Mono', ui-monospace, monospace",
                  color: isUnity
                    ? "var(--scale-text-unity, rgba(255,255,255,0.55))"
                    : "var(--scale-text, rgba(255,255,255,0.24))",
                  pointerEvents: "none", zIndex: 1,
                }}>
                  {lbl}
                </div>

              </React.Fragment>
            );
          })}

          {/* ── Fader knob cap — wide flat horizontal bar ── */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            top: knobY,
            width: KNOB_W, height: KNOB_H,
            cursor: "grab",
            zIndex: 5,
            transition: dragging ? "none" : "top 0.08s ease-out",
            // Brushed-aluminum fader cap — light gray so it pops against dark rail
            background: dragging
              ? `linear-gradient(180deg, #e0e0e8 0%, #c8c8d0 20%, #b8b8c0 50%, #c8c8d0 80%, #e0e0e8 100%)`
              : "linear-gradient(180deg, #d4d4dc 0%, #bdbdc6 20%, #aaaaB2 50%, #bdbdc6 80%, #d4d4dc 100%)",
            border: `1px solid ${dragging ? color : "#9090a0"}`,
            borderRadius: 2,
            boxShadow: dragging
              ? `0 0 14px ${color}55, 0 4px 14px rgba(0,0,0,0.85)`
              : "0 3px 10px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.16), inset 0 -1px 0 rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {/* Center grip marker — dark stripe on light cap */}
            <div style={{
              width: KNOB_W - 16, height: 2,
              background: dragging
                ? `linear-gradient(90deg, transparent, ${color}, transparent)`
                : "linear-gradient(90deg, transparent, rgba(0,0,0,0.45), transparent)",
              borderRadius: 1,
            }} />
          </div>

        </div>{/* end fader column */}

        {/* ── Mono VU meter — full height, right side ── */}
        <div style={{
          flex: 1, minWidth: 16, height: "100%",
          background: "var(--vu-meter-bg, #0a0a0f)",
          border: "1px solid var(--strip-divider, #303040)",
          boxShadow: "inset 0 2px 6px rgba(0,0,0,0.4)",
          position: "relative", overflow: "hidden", zIndex: 1,
        }}>
          {/* Meter fill — ref-updated at 30Hz when deckId is set, JSX-driven otherwise */}
          <div ref={deckId ? vuFillRef : undefined} style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            height: deckId ? "0%" : `${vuH * 100}%`,
            background: `linear-gradient(to top, ${color} 0%, ${color} 50%, var(--accent-amber) 75%, var(--accent-red) 92%)`,
            opacity: deckId ? (isOn ? 0.9 : 0.04) : (isOn ? 0.9 : 0.04),
            transition: "height 0.06s linear",
          }} />
          {/* Peak hold line — always rendered; display toggled via ref when deckId is set */}
          <div ref={deckId ? vuPeakRef : undefined} style={{
            position: "absolute", bottom: deckId ? "0%" : `${vuH * 100}%`, left: 0, right: 0,
            height: 2, background: deckId ? color : vuColor,
            boxShadow: deckId ? `0 0 6px ${color}` : `0 0 6px ${vuColor}`,
            display: deckId ? "none" : (isOn && level > 0.02 ? "block" : "none"),
          }} />
          {/* dB reference marks on meter */}
          {[0, -6, -12, -24, -48].map(dbVal => {
            const ratio = dbVal === 0 ? 1 : Math.pow(10, dbVal / 20);
            return (
              <div key={dbVal} style={{
                position: "absolute", bottom: `${ratio * 100}%`, left: 0, right: 0,
                height: 1, background: "rgba(255,255,255,0.06)",
              }} />
            );
          })}
        </div>

      </div>{/* end main area */}

      {/* ── dB readout ── */}
      <div style={{
        width: "100%", textAlign: "center", padding: "4px 0",
        fontSize: 9, fontFamily: "'DM Mono', monospace",
        color: "#666", borderTop: "1px solid var(--strip-divider, #303040)",
        background: "var(--strip-readout-bg, transparent)",
      }}>
        {db} dB
      </div>

      {/* ── ON / PFL — horizontal, full-width illuminated buttons ── */}
      <div style={{
        display: "flex", flexDirection: "row", alignItems: "stretch",
        gap: 8, padding: "10px 8px 12px",
        background: "var(--strip-readout-bg, transparent)", borderTop: "1px solid var(--strip-divider, #303040)",
      }}>

        {/* ON / OFF — blue glow when active */}
        <button onClick={() => { playClick(); onToggleOn(); }} style={{
          flex: 1, height: 38, borderRadius: 4,
          background: isOn
            ? `linear-gradient(180deg, ${isPlaying ? "#5090ff" : "#3060aa"}, ${isPlaying ? "#2060cc" : "#1a3060"})`
            : "linear-gradient(180deg, #333, #1a1a1a)",
          border: `2px solid ${isOn ? (isPlaying ? "#4080ee" : "#2a5090") : "#333"}`,
          boxShadow: isOn
            ? `0 0 ${isPlaying ? 16 : 8}px ${isPlaying ? "#3070dd60" : "#20409030"}, inset 0 1px 2px rgba(255,255,255,0.15)`
            : "inset 0 2px 4px rgba(0,0,0,0.5)",
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.15s",
        }}>
          <span style={{
            fontSize: 13, fontWeight: 800, letterSpacing: "0.12em",
            color: isOn ? "#fff" : "#666",
            textShadow: isOn ? "0 0 4px rgba(255,255,255,0.5)" : "none",
          }}>ON</span>
        </button>

        {/* PFL / CUE — amber glow when active */}
        <button onClick={() => { playClick(); setPflActive(!pflActive); onPfl?.(); }} style={{
          flex: 1, height: 38, borderRadius: 4,
          background: pflActive
            ? "linear-gradient(180deg, #ddaa30, #886610)"
            : "linear-gradient(180deg, #333, #1a1a1a)",
          border: `2px solid ${pflActive ? "#aa8820" : "#333"}`,
          boxShadow: pflActive
            ? "0 0 12px rgba(221,170,48,0.4), inset 0 1px 2px rgba(255,255,255,0.15)"
            : "inset 0 2px 4px rgba(0,0,0,0.5)",
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.15s",
        }}>
          <span style={{
            fontSize: 13, fontWeight: 800, letterSpacing: "0.12em",
            color: pflActive ? "#fff" : "#666",
            textShadow: pflActive ? "0 0 4px rgba(255,255,255,0.5)" : "none",
          }}>PFL</span>
        </button>

      </div>
    </div>
  );
}
