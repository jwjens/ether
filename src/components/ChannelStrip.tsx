// src/components/ChannelStrip.tsx
// Compact vertical channel strip for use when 4+ decks are visible.
// Mimics pro DAW/mixer channel strips — narrow, tall VU meter, essential controls only.

import { useState, useEffect, useRef } from "react";

interface ChannelStripProps {
  // Identity
  label: string;
  color: string;          // accent color for this channel
  type: "music" | "mic" | "guest" | "cart";

  // Playback state (music decks)
  title?: string;
  artist?: string;
  status?: "idle" | "playing" | "paused" | "stopped";
  remaining?: number;     // seconds
  duration?: number;      // seconds
  isOnAir?: boolean;

  // Level (0–1) — updated externally by engine
  level?: number;

  // Actions
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onVolume?: (v: number) => void;
  onDragStart?: (e: React.MouseEvent) => void;
}

export default function ChannelStrip({
  label, color, type,
  title, artist, status = "idle",
  remaining = 0, duration = 0, isOnAir = false,
  level = 0,
  onPlay, onPause, onStop, onVolume,
  onDragStart,
}: ChannelStripProps) {
  const [vol, setVol] = useState(1);
  const [peak, setPeak] = useState(0);
  const [peakTimer, setPeakTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [liveLevel, setLiveLevel] = useState(level);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const levelRef = useRef(0);
  const peakRef = useRef(0);

  const isPlaying = status === "playing";
  const isPaused  = status === "paused";
  const hasTrack  = !!title;

  // Animate VU bars
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const BAR_COUNT = 20;
    const bars = new Array(BAR_COUNT).fill(0);
    const bPeaks = new Array(BAR_COUNT).fill(0);
    const bPeakTimes = new Array(BAR_COUNT).fill(0);

    const draw = () => {
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Background
      ctx.fillStyle = "#0a0a0e";
      ctx.fillRect(0, 0, W, H);

      const lvl = levelRef.current;
      const barW = Math.max(1, W / BAR_COUNT - 1);

      for (let i = 0; i < BAR_COUNT; i++) {
        const target = isPlaying
          ? Math.max(0, lvl + (Math.random() - 0.55) * 0.25) * (i / BAR_COUNT < 0.7 ? 1 : 0.4)
          : 0;
        bars[i] += (target - bars[i]) * 0.35;
        const h = bars[i] * H;
        const x = i * (barW + 1);

        // Unlit track
        ctx.fillStyle = "#111116";
        ctx.fillRect(x, 0, barW, H);

        // Gradient fill — teal bottom → amber → red top
        if (h > 0) {
          const grad = ctx.createLinearGradient(x, H, x, 0);
          grad.addColorStop(0,    "#008878");
          grad.addColorStop(0.60, "#a07020");
          grad.addColorStop(0.80, "#a02020");
          grad.addColorStop(1,    "#a02020");
          ctx.fillStyle = grad;
          ctx.fillRect(x, H - h, barW, h);
        }

        // Peak dot
        if (bars[i] > bPeaks[i]) { bPeaks[i] = bars[i]; bPeakTimes[i] = Date.now(); }
        else if (Date.now() - bPeakTimes[i] > 1200) bPeaks[i] *= 0.97;
        if (bPeaks[i] > 0.05) {
          const ph = bPeaks[i] * H;
          ctx.fillStyle = bPeaks[i] > 0.80 ? "#e04040" : bPeaks[i] > 0.60 ? "#d09030" : "#00c8a8";
          ctx.fillRect(x, H - ph - 2, barW, 2);
        }
      }

      // Zone ticks at 60% and 80%
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      [0.40, 0.20].forEach(f => {
        const y = Math.floor(H * f);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      });

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [isPlaying]);

  // Sync external level into ref
  useEffect(() => { levelRef.current = level; }, [level]);

  const handleVol = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVol(v);
    onVolume?.(v);
  };

  const pct = duration > 0 ? Math.max(0, Math.min(1, (duration - remaining) / duration)) : 0;
  const timeStr = remaining > 0
    ? `-${Math.floor(remaining / 60)}:${String(Math.floor(remaining % 60)).padStart(2, "0")}`
    : "0:00";

  // Color for strip type
  const typeColor = type === "mic" ? "#ef4444"
    : type === "guest" ? "#a78bfa"
    : type === "cart"  ? "#fbbf24"
    : color;

  return (
    <div
      onMouseDown={onDragStart}
      style={{
        width: "100%", height: "100%",
        display: "flex", flexDirection: "column",
        background: "#0e0e12",
        borderRadius: 0,
        border: "none",
        boxShadow: "none",
        overflow: "hidden",
        userSelect: "none",
        transition: "border-color 0.2s, box-shadow 0.2s",
        cursor: onDragStart ? "grab" : "default",
      }}
    >
      {/* ── Top label bar ── */}
      <div style={{
        padding: "5px 6px 4px",
        borderBottom: "1px solid var(--border-primary)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 8, fontWeight: 800, letterSpacing: "0.1em",
          color: isOnAir ? typeColor : "var(--text-tertiary)",
          textTransform: "uppercase",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {label}
        </div>
        {isOnAir && (
          <div style={{
            fontSize: 7, fontWeight: 800, letterSpacing: "0.08em",
            color: "#fff", background: typeColor,
            padding: "1px 4px", borderRadius: 0,
          }}>ON AIR</div>
        )}
      </div>

      {/* ── Track info ── */}
      <div style={{
        padding: "4px 6px",
        flexShrink: 0,
        minHeight: 28,
        display: "flex", flexDirection: "column", justifyContent: "center",
      }}>
        {hasTrack ? (
          <>
            <div style={{
              fontSize: 9, fontWeight: 700, color: "var(--text-primary)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              lineHeight: 1.3,
            }}>{title}</div>
            <div style={{
              fontSize: 8, color: "var(--text-tertiary)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{artist}</div>
          </>
        ) : type === "mic" ? (
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", fontStyle: "italic" }}>Mic ready</div>
        ) : type === "guest" ? (
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", fontStyle: "italic" }}>No guest</div>
        ) : (
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", fontStyle: "italic" }}>No track</div>
        )}
      </div>

      {/* ── VU Meter — takes remaining space ── */}
      <div style={{ flex: 1, position: "relative", padding: "0 4px 4px", minHeight: 0, background: "#080808" }}>
        <canvas
          ref={canvasRef}
          width={120}
          height={200}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
        {/* Time remaining overlay */}
        {isPlaying && remaining > 0 && (
          <div style={{
            position: "absolute", bottom: 8, left: 0, right: 0,
            textAlign: "center",
            fontSize: 11, fontWeight: 800, fontFamily: "'DM Mono', monospace",
            color: remaining < 10 ? "#ef4444" : "rgba(255,255,255,0.8)",
            textShadow: "0 1px 4px rgba(0,0,0,0.8)",
            pointerEvents: "none",
          }}>
            {timeStr}
          </div>
        )}
      </div>

      {/* ── Progress bar ── */}
      {hasTrack && (
        <div style={{ height: 3, background: "var(--bg-tertiary)", flexShrink: 0, margin: "0 4px" }}>
          <div style={{
            height: "100%", width: `${pct * 100}%`,
            background: typeColor,
            borderRadius: 0, transition: "width 0.5s linear",
          }} />
        </div>
      )}

      {/* ── Volume fader ── */}
      <div style={{ padding: "4px 6px 2px", flexShrink: 0 }}>
        <input
          type="range" min={0} max={1} step={0.01} value={vol}
          onChange={handleVol}
          style={{ width: "100%", accentColor: typeColor, height: 12, cursor: "pointer" }}
        />
      </div>

      {/* ── Transport buttons ── */}
      <div style={{
        padding: "2px 4px 6px",
        display: "flex", gap: 3, flexShrink: 0,
      }}>
        {type === "music" && (
          <>
            <button
              onClick={isPlaying ? onPause : onPlay}
              style={{
                flex: 1, padding: "5px 0", borderRadius: 0, border: "none",
                background: isPlaying ? typeColor : "var(--bg-tertiary)",
                color: isPlaying ? "#000" : "var(--text-secondary)",
                fontSize: 10, fontWeight: 800, cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {isPlaying ? "❚❚" : isPaused ? "▶" : "▶"}
            </button>
            <button
              onClick={onStop}
              style={{
                width: 24, padding: "5px 0", borderRadius: 0, border: "none",
                background: "var(--bg-tertiary)",
                color: "var(--text-tertiary)",
                fontSize: 9, cursor: "pointer",
              }}
            >■</button>
          </>
        )}
        {(type === "mic" || type === "guest") && (
          <button style={{
            flex: 1, padding: "5px 0", borderRadius: 0, border: "none",
            background: isOnAir ? typeColor : "var(--bg-tertiary)",
            color: isOnAir ? "#fff" : "var(--text-tertiary)",
            fontSize: 8, fontWeight: 800, letterSpacing: "0.06em", cursor: "pointer",
          }}>
            {isOnAir ? "● LIVE" : "● LIVE"}
          </button>
        )}
      </div>
    </div>
  );
}
