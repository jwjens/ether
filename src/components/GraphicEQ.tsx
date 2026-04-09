// src/components/GraphicEQ.tsx
// 10-band graphic EQ panel — used per-deck and for master output.
// Purely presentational: caller owns band state and persistence.

import { useRef } from "react";

export const EQ_FREQS  = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_LABELS = ["31", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
export const EQ_DEFAULT: number[] = Array(10).fill(0);

const TRACK_H = 68;   // px — vertical slider range
const MAX_DB  = 12;

interface Props {
  bands:    number[];                       // 10 gain values [-12..+12]
  onChange: (bands: number[]) => void;
  label?:   string;                         // "EQ" | "MONO EQ" | "MASTER EQ"
}

export default function GraphicEQ({ bands, onChange, label = "EQ" }: Props) {
  const isActive = bands.some(g => Math.abs(g) > 0.05);

  // ── Drag handler ─────────────────────────────────────────────
  const dragBand = (idx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const startY    = e.clientY;
    const startGain = bands[idx] ?? 0;

    const onMove = (me: MouseEvent) => {
      const dy   = startY - me.clientY;              // up = positive = boost
      const gain = Math.max(-MAX_DB, Math.min(MAX_DB,
        startGain + (dy / TRACK_H) * MAX_DB * 2
      ));
      const next = [...bands];
      next[idx] = Math.round(gain * 10) / 10;        // 0.1 dB resolution
      onChange(next);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  };

  // Double-click a band to reset it to 0
  const resetBand = (idx: number) => {
    const next = [...bands];
    next[idx] = 0;
    onChange(next);
  };

  const flat = () => onChange(Array(10).fill(0));

  return (
    <div style={{
      padding: "6px 12px 8px",
      background: "#0a0a0a",
      borderTop: "1px solid #1e1e28",
    }}>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{
            width: 5, height: 5, borderRadius: "50%",
            background: isActive ? "#c07820" : "#303040",
            boxShadow: isActive ? "0 0 4px #c07820" : "none",
            transition: "all 0.2s",
          }} />
          <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: "0.14em", color: "#404058", textTransform: "uppercase" as const }}>
            {label}
          </span>
        </div>
        <button
          onClick={flat}
          style={{
            fontSize: 7, fontWeight: 700, letterSpacing: "0.1em",
            padding: "2px 7px", background: "none",
            border: "1px solid #202030", color: "#404058",
            cursor: "pointer", borderRadius: 0,
            transition: "all 0.12s",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#808090"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "#404058"; }}
        >FLAT</button>
      </div>

      {/* ── Band sliders ── */}
      <div style={{ display: "flex", gap: 2 }}>
        {EQ_FREQS.map((_, idx) => {
          const gain = bands[idx] ?? 0;
          const pct  = (gain + MAX_DB) / (MAX_DB * 2);        // 0=bottom, 1=top
          const handleTop = Math.round((1 - pct) * TRACK_H);   // px from top of track
          const isBoost = gain >  0.05;
          const isCut   = gain < -0.05;

          const handleColor = isBoost ? "#00c8a8" : isCut ? "#e09030" : "#404058";
          const fillTop    = isBoost ? handleTop   : TRACK_H / 2;
          const fillHeight = isBoost
            ? Math.max(0, TRACK_H / 2 - handleTop)
            : Math.max(0, handleTop  - TRACK_H / 2);

          return (
            <div
              key={idx}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}
            >
              {/* dB value label */}
              <div style={{
                height: 11,
                fontSize: 7,
                color: "#808090",
                fontFamily: "'DM Mono', monospace",
                textAlign: "center",
                lineHeight: "11px",
                whiteSpace: "nowrap",
              }}>
                {Math.abs(gain) >= 0.05
                  ? (gain > 0 ? "+" : "") + gain.toFixed(1)
                  : ""}
              </div>

              {/* Slider track */}
              <div
                onMouseDown={e => dragBand(idx, e)}
                onDoubleClick={() => resetBand(idx)}
                title={`${EQ_LABELS[idx]}Hz: ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB\nDouble-click to reset`}
                style={{
                  width: "100%",
                  height: TRACK_H,
                  background: "#111116",
                  position: "relative",
                  cursor: "ns-resize",
                  userSelect: "none" as const,
                  flexShrink: 0,
                }}
              >
                {/* 0 dB center reference line */}
                <div style={{
                  position: "absolute",
                  top: TRACK_H / 2,
                  left: 0, right: 0,
                  height: 1,
                  background: "#2a2a38",
                  pointerEvents: "none",
                }} />

                {/* Gain fill (boost = above center, cut = below center) */}
                {(isBoost || isCut) && (
                  <div style={{
                    position: "absolute",
                    left: 0, right: 0,
                    top:    fillTop,
                    height: fillHeight,
                    background: isBoost ? "#008878" : "#c07820",
                    opacity: 0.65,
                    pointerEvents: "none",
                  }} />
                )}

                {/* Handle line */}
                <div style={{
                  position: "absolute",
                  left: 0, right: 0,
                  top: handleTop - 1,
                  height: 2,
                  background: handleColor,
                  pointerEvents: "none",
                }} />
              </div>

              {/* Frequency label */}
              <div style={{
                fontSize: 7,
                color: "#404058",
                textAlign: "center",
                marginTop: 2,
                lineHeight: "10px",
              }}>
                {EQ_LABELS[idx]}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
