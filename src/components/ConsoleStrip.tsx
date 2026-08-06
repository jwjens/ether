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
import { vuHeight, vuColor as vuZoneColor } from "../lib/vuMeter";
import { matchesStation } from "../lib/levelsScope";
import { useActiveStation } from "../hooks/useActiveStation";

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
  /** Rotation role for the color strip: playing rides a progress fill, next pulses, third is solid. */
  role?: "playing" | "next" | "third";
  /** JINGLES overlay v1: 'ARMED' (white) or 'FIRING' (yellow) when a jingle bridges this deck's seam. */
  jingle?: string | null;
  /** Overlay class ('JIN' | 'SWP') so the indicator names what's armed/firing (v2). */
  jingleClass?: string | null;
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
  label, color, volume, level = 0, isPlaying, isOn, onVolumeChange, onToggleOn, onPfl, compact, deckId, hideLabel, role = "third", jingle = null, jingleClass = null,
}: Props) {
  const engine = useAudioEngine();
  const midi = useMidiState();
  // Station scope — this strip's VU renders only its own station's levels frames (ref → no re-subscribe).
  const { stationUuid } = useActiveStation();
  const myUuidRef = useRef(stationUuid);
  myUuidRef.current = stationUuid;
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
    let smoothed = 0; // smoothed bar HEIGHT (0..1): fast attack, slow release (VU ballistic)
    const h = ether.audio.onLevels((lvl: { a?: number; b?: number; c?: number; cart?: number; master?: number; stationUuid?: string }) => {
      if (!matchesStation(lvl, myUuidRef.current)) return; // station scope
      const id = deckId.toUpperCase();
      let raw = id === "A" ? (lvl.a ?? 0)
              : id === "B" ? (lvl.b ?? 0)
              : id === "C" ? (lvl.c ?? 0)
              : id === "CART" ? (lvl.cart ?? 0)   // jingle overlay bus (native slot 6, level_cart)
              : (lvl.master ?? 0);
      if (id === "MIC") raw = isOnRef.current ? (lvl.master ?? 0) * 0.6 : 0;
      // Meters are taps: the CART/jingle overlay has no steady "playing" status like a rotation deck
      // (jingles fire briefly over master), so its VU always reflects the live tap. Other strips keep
      // the existing isPlaying gate unchanged.
      if (id !== "CART") raw = isPlayingRef.current ? raw : 0;
      const targetH = vuHeight(Math.min(1, raw));   // dB-scaled target height
      // Snap up to peaks (track the music), ease down — kills the flickery top edge.
      smoothed += (targetH - smoothed) * (targetH > smoothed ? 0.5 : 0.12);
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const mask = vuFillRef.current;
        const peak = vuPeakRef.current;
        if (!mask) return;
        // Mask uncovers the gradient from the bottom up to the (smoothed) level.
        mask.style.height = `${(1 - smoothed) * 100}%`;
        if (peak) {
          // Edge line colored by the zone it sits in (height thresholds = the dB marks).
          const col = smoothed >= 0.9375 ? "var(--accent-red)" : smoothed >= 0.75 ? "var(--accent-amber)" : colorRef.current;
          peak.style.bottom     = `${smoothed * 100}%`;
          peak.style.background = col;
          peak.style.boxShadow  = `0 0 5px ${col}`;
          peak.style.display    = isOnRef.current && smoothed > 0.02 ? "block" : "none";
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
  const vuH = vuHeight(isOn ? level : level * 0.05);
  const vuColor = vuZoneColor(level, color);

  // JINGLES indicator moved OUT of the fader strip (4.4.63): the jingle's NAME + time now lives as a third
  // line under the playing song's duration in the Up Next deck row (UpNext.tsx). The `jingle`/`jingleClass`
  // props are retained (ignored) so callers don't break; nothing is rendered here.
  void jingle; void jingleClass;

  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      backgroundColor: "var(--panel-bg, #0e0e13)",
      borderRight: "var(--panel-border, 1px solid rgba(255,255,255,0.05))",
      userSelect: "none", overflow: "hidden", position: "relative",
    }}>

      {/* ── Channel label ── */}
      {!hideLabel ? (
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
            color: isOn && isPlaying ? "#fff" : (isOn ? color : "var(--strip-label-text, #8a8a98)"),
            textShadow: isOn && isPlaying ? "0 1px 3px rgba(0,0,0,0.6)" : "none",
            transition: "color 0.2s",
          }}>{label}</span>
        </div>
      ) : deckId ? (
        // Label hidden (deck identity now lives in the Up Next deck rows) — but keep a slim
        // color-coded accent so operators still know which fader is A/B/C, with the play
        // progress riding across it.
        <div style={{
          width: "100%", height: 16, position: "relative", overflow: "hidden",
          background: isOn && isPlaying ? `${color}33` : `${color}1a`,
          borderBottom: `2px solid ${color}`,
          transition: "background 0.3s",
        }}>
          {/* Role-driven full-strip fill: next pulses, third is solid. The playing deck gets
              no overlay (role === "playing") so its progress fill below shows through. */}
          {role === "next" && (
            <div className="deck-bar-pulse" style={{
              position: "absolute", inset: 0, background: color, zIndex: 0, pointerEvents: "none",
            }} />
          )}
          {role === "third" && (
            <div style={{
              position: "absolute", inset: 0, background: color, opacity: 0.9, zIndex: 0, pointerEvents: "none",
            }} />
          )}
          {/* Playing deck: progress fill rides left→right (imperative, see effect above) */}
          <div ref={fillRef} style={{
            position: "absolute", top: 0, left: 0, bottom: 0,
            background: color, opacity: 0.85, zIndex: 1, pointerEvents: "none",
          }} />
        </div>
      ) : null}

      {/* ── Main area: fader column + VU meter ── */}
      <div ref={faderAreaRef} style={{
        flex: 1, width: "100%", display: "flex", gap: 14, justifyContent: "center",
        padding: "10px 8px 8px",
        minHeight: 180, overflow: "hidden",
        position: "relative",
      }}>

        {/* ── Fader column: rail + knob cap ── */}
        <div style={{
          width: 54, flexShrink: 0, height: "100%", position: "relative", zIndex: 1,
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

          {/* Rail — flat thin track */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            top: KNOB_H / 2, bottom: KNOB_H / 2,
            width: 4,
            background: "rgba(255,255,255,0.09)",
          }} />

          {/* Active fill — colored segment from bottom to knob */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            bottom: KNOB_H / 2,
            height: Math.max(0, (faderH - KNOB_H) - knobY),
            width: 4,
            background: isOn ? color : "#6a6a78",
            // OFF must read as OFF, not as BROKEN. At 0.06 the rail vanished and the whole strip looked
            // disabled/faulty rather than switched off — that is what an operator reported on 4.4.145.
            // A channel that is off on a real board still shows its fader and an unlit meter; only the
            // ON lamp goes dark. These values keep the control legible and obviously present.
            opacity: isOn ? 0.7 : 0.3,
            transition: dragging ? "none" : "height 0.08s ease-out",
          }} />

          {/* dB scale removed — clean rail, no per-tick labels (the meter reads the level) */}

          {/* ── Fader knob cap — flat handle (motorized-board friendly) ── */}
          <div style={{
            position: "absolute",
            left: "50%", transform: "translateX(-50%)",
            top: knobY,
            width: KNOB_W, height: KNOB_H,
            cursor: "grab",
            zIndex: 5,
            transition: dragging ? "none" : "top 0.08s ease-out",
            background: isOn ? "#e6e6ec" : "#9a9aa8",   // off = a present, grabbable cap, not a dead slab
            border: dragging ? `2px solid ${color}` : `1px solid ${isOn ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.5)"}`,
            opacity: isOn ? 1 : 0.88,
            borderRadius: 2,
            boxShadow: dragging ? `0 0 0 3px ${color}40` : "none",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {/* Center grip line */}
            <div style={{ width: KNOB_W - 18, height: 2, background: "rgba(0,0,0,0.28)", borderRadius: 1 }} />
          </div>

        </div>{/* end fader column */}

        {/* ── Mono VU meter — slim, solid RGB (red top · blue · green), only lit on signal ── */}
        <div style={{
          width: 32, flexShrink: 0, height: "100%",
          background: "var(--vu-meter-bg, #0a0a0f)",
          position: "relative", overflow: "hidden", zIndex: 1,
        }}>
          {/* Solid 3-zone column — green (safe) → orange (hot) → red (clip). Hard stops, no blend. */}
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(to top, var(--accent-green) 0%, var(--accent-green) 66%, var(--accent-amber) 66%, var(--accent-amber) 88%, var(--accent-red) 88%, var(--accent-red) 100%)",
            opacity: isOn ? 1 : 0.16,   // unlit, but the meter is still visibly THERE (was 0.04 = gone)

          }} />
          {/* Mask — covers the UNLIT portion above the level. ref-updated at 30Hz when deckId set. */}
          <div ref={deckId ? vuFillRef : undefined} style={{
            position: "absolute", top: 0, left: 0, right: 0,
            height: deckId ? "100%" : `${(1 - vuH) * 100}%`,
            background: "#0a0a0f",
          }} />
          {/* Leading-edge line at the level */}
          <div ref={deckId ? vuPeakRef : undefined} style={{
            position: "absolute", bottom: deckId ? "0%" : `${vuH * 100}%`, left: 0, right: 0,
            height: 2, background: "#fff",
            display: deckId ? "none" : (isOn && level > 0.02 ? "block" : "none"),
          }} />
        </div>

      </div>{/* end main area */}

      {/* ── ON / PFL — flat ── */}
      <div style={{
        display: "flex", flexDirection: "row", alignItems: "stretch",
        gap: 8, padding: "10px 8px 12px",
        borderTop: "1px solid var(--strip-divider, #303040)",
      }}>

        {/* ON — lit means THE BUTTON IS PRESSED, i.e. this channel is on. Board convention, same as a
            Wheatstone: the lamp reports the switch, NOT whether audio happens to be sounding through it.
            It used to brighten only while isPlaying, which made a channel whose audio is brief and
            intermittent (JINGLES) sit dark almost always, unreadable as on-or-off. Whether audio is
            actually flowing is told by the label fill, the progress bar and the meter — not by this lamp. */}
        <button onClick={() => { playClick(); onToggleOn(); }} style={{
          flex: 1, height: 38, borderRadius: 3,
          background: isOn ? "#2563eb" : "var(--bg-tertiary, #232330)",
          border: `1px solid ${isOn ? "#3b82f6" : "var(--border-primary, #333)"}`,
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.12s",
        }}>
          {/* Console convention: lit = channel on, unlit = channel off. The word stays fully legible when
              off so the control reads as a switch at rest, never as a disabled button. */}
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.12em", color: isOn ? "#fff" : "#9a9aa8" }}>ON</span>
        </button>

        {/* PFL — solid amber when active, flat */}
        <button onClick={() => { playClick(); setPflActive(!pflActive); onPfl?.(); }} style={{
          flex: 1, height: 38, borderRadius: 3,
          background: pflActive ? "#b8860b" : "var(--bg-tertiary, #232330)",
          border: `1px solid ${pflActive ? "#d4a017" : "var(--border-primary, #333)"}`,
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.12s",
        }}>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.12em", color: pflActive ? "#fff" : "var(--text-tertiary, #666)" }}>PFL</span>
        </button>

      </div>
    </div>
  );
}
