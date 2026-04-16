// ConsoleStrip.tsx — Wheatstone L-Series style console channel strip.
//
// Physical fader feel: the knob has a concave finger groove (darker center
// with raised edges) so it looks like you can grip it. Three wide center
// lines for tactile reference. The whole knob is taller vertically.
//
// Bottom section: two round illuminated pot buttons like a real console —
// ON/OFF (top, blue glow when active) and PFL/CUE (bottom, amber glow).
//
// Layout:
//   ┌──────────────────┐
//   │     DECK A       │  ← label header
//   ├─────────┬────────┤
//   │         │        │
//   │  FADER  │  METER │  ← both fill full height
//   │  TRACK  │ (mono) │
//   │         │        │
//   │  ▄████▄ │  ████  │  ← concave knob + VU bar
//   │  █ ── █ │  ████  │
//   │  ▀████▀ │  ████  │
//   │         │        │
//   ├─────────┴────────┤
//   │     -8 dB        │
//   ├──────────────────┤
//   │   (●) ON         │  ← round illuminated button, blue glow
//   │   (●) PFL        │  ← round illuminated button, amber glow
//   └──────────────────┘

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useMidiState } from "./MidiEngine";

interface Props {
  label: string;
  color: string;
  volume: number;
  level: number;
  isPlaying: boolean;
  isOn: boolean;
  onVolumeChange: (v: number) => void;
  onToggleOn: () => void;
  onPfl?: () => void;
  compact?: boolean;
}

const KNOB_H = 48;
const KNOB_W = 52;

export default function ConsoleStrip({
  label, color, volume, level, isPlaying, isOn, onVolumeChange, onToggleOn, onPfl, compact,
}: Props) {
  const midi = useMidiState();
  const [dragging, setDragging] = useState(false);
  const [pflActive, setPflActive] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const faderAreaRef = useRef<HTMLDivElement>(null);
  const [faderH, setFaderH] = useState(400);

  // Measure actual height
  useEffect(() => {
    const el = faderAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setFaderH(Math.floor(e.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // MIDI sync
  const midiKey = `deck_${label.toLowerCase().replace(/[^a-z]/g, "")}_volume`;
  const midiVolume = midi.faderPositions[midiKey];
  useEffect(() => {
    if (midiVolume !== undefined && Math.abs(midiVolume - volume) > 0.02) {
      onVolumeChange(midiVolume);
    }
  }, [midiVolume]);

  const knobY = (1 - volume) * (faderH - KNOB_H);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const track = trackRef.current;
    if (!track) return;
    const onMove = (ev: MouseEvent) => {
      const rect = track.getBoundingClientRect();
      onVolumeChange(1 - Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)));
    };
    const onUp = () => { setDragging(false); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    const rect = track.getBoundingClientRect();
    onVolumeChange(1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)));
  }, [onVolumeChange]);

  const db = volume > 0.001 ? (20 * Math.log10(volume)).toFixed(0) : "-∞";
  const vuH = Math.min(1, level * (isOn ? 1 : 0.05));
  const vuColor = level > 0.85 ? "var(--accent-red)" : level > 0.6 ? "var(--accent-amber)" : color;

  return (
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      background: "#1a1a20", borderRight: "1px solid #252530",
      userSelect: "none", overflow: "hidden",
    }}>

      {/* ── Channel label ── */}
      <div style={{
        width: "100%", padding: "8px 0",
        background: isOn && isPlaying ? color : "#252530",
        borderBottom: "1px solid #303040",
        textAlign: "center",
        fontSize: 11, fontWeight: 800, letterSpacing: "0.14em",
        color: isOn && isPlaying ? "#000" : (isOn ? color : "#555"),
        transition: "all 0.2s",
      }}>
        {label}
      </div>

      {/* ── Main area: fader + VU ── */}
      <div ref={faderAreaRef} style={{
        flex: 1, width: "100%", display: "flex", gap: 0,
        padding: "12px 12px 8px",
        minHeight: 0, overflow: "hidden",
      }}>

        {/* ── Fader track ── */}
        <div
          ref={trackRef}
          onMouseDown={handleMouseDown}
          style={{
            flex: 1, height: "100%", position: "relative",
            cursor: dragging ? "grabbing" : "pointer",
            display: "flex", justifyContent: "center",
          }}
        >
          {/* Rail groove — recessed look */}
          <div style={{
            position: "absolute", left: "50%", transform: "translateX(-50%)",
            top: KNOB_H / 2, bottom: KNOB_H / 2,
            width: 6, background: "#0a0a0f",
            border: "1px solid #333",
            boxShadow: "inset 0 2px 4px rgba(0,0,0,0.6)",
          }} />

          {/* dB tick marks */}
          {[0, -6, -12, -24, -48].map(dbVal => {
            const ratio = dbVal === 0 ? 1 : Math.pow(10, dbVal / 20);
            const y = (1 - ratio) * (faderH - KNOB_H) + KNOB_H / 2;
            return (
              <React.Fragment key={dbVal}>
                <div style={{ position: "absolute", left: 4, top: y, width: 10, height: 1, background: "rgba(255,255,255,0.08)" }} />
                <div style={{ position: "absolute", right: "55%", top: y - 5, fontSize: 7, color: "rgba(255,255,255,0.15)", fontFamily: "'DM Mono', monospace", textAlign: "right", width: 20 }}>{dbVal}</div>
              </React.Fragment>
            );
          })}

          {/* Active fill below knob */}
          <div style={{
            position: "absolute", left: "50%", transform: "translateX(-50%)",
            bottom: KNOB_H / 2, height: Math.max(0, volume * (faderH - KNOB_H)),
            width: 4, background: isOn ? color : "#444",
            opacity: isOn ? 0.5 : 0.1,
            transition: dragging ? "none" : "height 0.08s ease-out",
          }} />

          {/* ── Fader knob — concave finger groove design ── */}
          <div style={{
            position: "absolute", left: "50%", transform: "translateX(-50%)",
            top: knobY, width: KNOB_W, height: KNOB_H,
            cursor: "grab",
            transition: dragging ? "none" : "top 0.08s ease-out",
            zIndex: 2,
            // Outer shell — raised edges
            background: "linear-gradient(180deg, #555 0%, #3a3a3a 15%, #222 50%, #3a3a3a 85%, #555 100%)",
            border: `1px solid ${dragging ? color : "#555"}`,
            borderRadius: 3,
            boxShadow: dragging
              ? `0 0 10px ${color}50, 0 2px 8px rgba(0,0,0,0.6)`
              : "0 2px 6px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            overflow: "hidden",
          }}>
            {/* Concave finger groove — darker recessed center */}
            <div style={{
              width: KNOB_W - 8, height: KNOB_H - 12,
              background: "linear-gradient(180deg, #1a1a1a 0%, #111 40%, #0a0a0a 50%, #111 60%, #1a1a1a 100%)",
              borderRadius: 2,
              border: "1px solid #333",
              boxShadow: "inset 0 3px 6px rgba(0,0,0,0.7), inset 0 -3px 6px rgba(0,0,0,0.4)",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: 3,
            }}>
              {/* Three wide grip lines */}
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: KNOB_W - 20,
                  height: 2,
                  background: i === 1
                    ? "rgba(255,255,255,0.25)"  // center line brighter
                    : "rgba(255,255,255,0.12)",
                  borderRadius: 1,
                }} />
              ))}
            </div>
          </div>
        </div>

        {/* ── Mono VU meter — full height, right side ── */}
        <div style={{
          flex: 1, minWidth: 20, height: "100%",
          background: "#0a0a0f",
          border: "1px solid #303040",
          boxShadow: "inset 0 2px 6px rgba(0,0,0,0.5)",
          position: "relative", overflow: "hidden",
        }}>
          {/* Meter fill */}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            height: `${vuH * 100}%`,
            background: `linear-gradient(to top, ${color} 0%, ${color} 50%, var(--accent-amber) 75%, var(--accent-red) 92%)`,
            opacity: isOn ? 0.9 : 0.04,
            transition: "height 0.06s linear",
          }} />
          {/* Peak hold line */}
          {isOn && level > 0.02 && (
            <div style={{
              position: "absolute", bottom: `${vuH * 100}%`, left: 0, right: 0,
              height: 2, background: vuColor,
              boxShadow: `0 0 6px ${vuColor}`,
            }} />
          )}
          {/* dB reference marks */}
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
      </div>

      {/* ── dB readout ── */}
      <div style={{
        width: "100%", textAlign: "center", padding: "4px 0",
        fontSize: 9, fontFamily: "'DM Mono', monospace",
        color: "#666", borderTop: "1px solid #303040",
        background: "#141418",
      }}>
        {db} dB
      </div>

      {/* ── Pot buttons — round illuminated, Wheatstone L-Series style ── */}
      <div style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: 8, padding: "10px 0 12px",
        background: "#141418", borderTop: "1px solid #303040",
      }}>
        {/* ON / OFF — round pot button with blue glow */}
        <button onClick={onToggleOn} style={{
          width: 36, height: 36, borderRadius: "50%",
          background: isOn
            ? `radial-gradient(circle at 40% 35%, ${isPlaying ? "#5090ff" : "#3060aa"}, ${isPlaying ? "#2060cc" : "#1a3060"})`
            : "radial-gradient(circle at 40% 35%, #333, #1a1a1a)",
          border: `2px solid ${isOn ? (isPlaying ? "#4080ee" : "#2a5090") : "#333"}`,
          boxShadow: isOn
            ? `0 0 ${isPlaying ? 16 : 8}px ${isPlaying ? "#3070dd60" : "#20409030"}, inset 0 1px 2px rgba(255,255,255,0.15)`
            : "inset 0 2px 4px rgba(0,0,0,0.5)",
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.15s",
        }}>
          <span style={{
            fontSize: 7, fontWeight: 800, letterSpacing: "0.1em",
            color: isOn ? "#fff" : "#555",
            textShadow: isOn ? "0 0 4px rgba(255,255,255,0.5)" : "none",
          }}>ON</span>
        </button>

        {/* PFL / CUE — round pot button with amber glow */}
        <button onClick={() => { setPflActive(!pflActive); onPfl?.(); }} style={{
          width: 36, height: 36, borderRadius: "50%",
          background: pflActive
            ? "radial-gradient(circle at 40% 35%, #ddaa30, #886610)"
            : "radial-gradient(circle at 40% 35%, #333, #1a1a1a)",
          border: `2px solid ${pflActive ? "#aa8820" : "#333"}`,
          boxShadow: pflActive
            ? "0 0 12px rgba(221,170,48,0.4), inset 0 1px 2px rgba(255,255,255,0.15)"
            : "inset 0 2px 4px rgba(0,0,0,0.5)",
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.15s",
        }}>
          <span style={{
            fontSize: 6, fontWeight: 800, letterSpacing: "0.1em",
            color: pflActive ? "#fff" : "#555",
            textShadow: pflActive ? "0 0 4px rgba(255,255,255,0.5)" : "none",
          }}>PFL</span>
        </button>
      </div>
    </div>
  );
}
