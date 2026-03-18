import VUMeter from "./VUMeter";
import { useState, useEffect } from "react";
import { DeckState } from "../audio/engine";

interface Props {
  deck: DeckState | null;
  label: string;
  deckId: "A" | "B";
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onVolume: (v: number) => void;
}

function fmt(sec: number): string {
  if (sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + String(s).padStart(2, "0");
}

function fmtMs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return String(m).padStart(2,"0") + ":" + String(s).padStart(2,"0") + "." + ms;
}

export default function OnAirDeck({ deck, label, deckId, onPlay, onPause, onResume, onStop, onVolume }: Props) {
  const [blink, setBlink] = useState(false);

  const status = deck?.status || "idle";
  const title = deck?.title || "";
  const artist = deck?.artist || "";
  const pos = deck?.positionSec || 0;
  const dur = deck?.durationSec || 0;
  const vol = deck?.volume ?? 1;
  const remaining = Math.max(0, dur - pos);
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;

  const introEnd = dur * 0.08;
  const outroStart = dur * 0.90;
  const isPlaying = status === "playing";
  const isInIntro = pos < introEnd && isPlaying && dur > 0;
  const isInOutro = pos > outroStart && isPlaying && dur > 0;
  const isEnding = remaining < 15 && remaining > 0 && isPlaying;
  const isCritical = remaining < 5 && remaining > 0 && isPlaying;

  useEffect(() => {
    if (isCritical) {
      const id = setInterval(() => setBlink(b => !b), 250);
      return () => clearInterval(id);
    }
    setBlink(false);
  }, [isCritical]);

  let accent = "#22d3ee"; // cyan default
  let statusLabel = "IDLE";
  let statusDot = "#404055";
  let topBar = "var(--border-primary)";
  let bgCard = "var(--bg-secondary)";

  if (isPlaying) {
    if (isCritical) {
      accent = "#f87171";
      statusLabel = "ENDING";
      statusDot = "#f87171";
      topBar = "#f87171";
      bgCard = blink ? "rgba(248,113,113,0.06)" : "rgba(248,113,113,0.02)";
    } else if (isEnding) {
      accent = "#fb923c";
      statusLabel = "OUTRO";
      statusDot = "#fb923c";
      topBar = "#fb923c";
      bgCard = "rgba(251,146,60,0.03)";
    } else if (isInOutro) {
      accent = "#fbbf24";
      statusLabel = "OUTRO";
      statusDot = "#fbbf24";
      topBar = "#fbbf24";
      bgCard = "rgba(251,191,36,0.03)";
    } else if (isInIntro) {
      accent = "#38bdf8";
      statusLabel = "INTRO";
      statusDot = "#38bdf8";
      topBar = "#38bdf8";
      bgCard = "rgba(56,189,248,0.03)";
    } else {
      accent = "#34d399";
      statusLabel = "PLAYING";
      statusDot = "#34d399";
      topBar = "#34d399";
      bgCard = "rgba(52,211,153,0.03)";
    }
  } else if (status === "paused") {
    accent = "#fbbf24";
    statusLabel = "PAUSED";
    statusDot = "#fbbf24";
    topBar = "#fbbf24";
  } else if (status === "loading") {
    accent = "#38bdf8";
    statusLabel = "LOADING";
    statusDot = "#38bdf8";
    topBar = "#38bdf8";
  }

  const isA = deckId === "A";

  return (
    <div style={{
      background: bgCard,
      borderRadius: 16,
      border: "1px solid var(--border-secondary)",
      overflow: "hidden",
      transition: "background 0.4s ease",
      boxShadow: isPlaying
        ? `0 0 0 1px ${accent}30, 0 4px 24px ${accent}15, var(--shadow-md)`
        : "var(--shadow-md)",
    }}>
      {/* Top color bar */}
      <div style={{
        height: 3,
        background: topBar,
        transition: "background 0.3s ease",
        boxShadow: isPlaying ? `0 0 12px ${accent}80` : "none",
      }} />

      {/* Header row */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px 8px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: isA ? "rgba(56,189,248,0.15)" : "rgba(52,211,153,0.15)",
            border: `1px solid ${isA ? "rgba(56,189,248,0.3)" : "rgba(52,211,153,0.3)"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 800, color: isA ? "#38bdf8" : "#34d399",
            letterSpacing: "-0.02em",
          }}>{deckId}</div>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {isA ? "ON AIR" : "STANDBY"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{
            width: 6, height: 6, borderRadius: 3,
            background: statusDot,
            boxShadow: isPlaying ? `0 0 6px ${statusDot}` : "none",
            transition: "all 0.3s",
          }} />
          <span style={{ fontSize: 10, fontWeight: 700, color: statusDot, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Track info */}
      <div style={{ padding: "0 16px 10px" }}>
        <div style={{
          fontSize: 16, fontWeight: 600, color: "var(--text-primary)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          letterSpacing: "-0.02em", lineHeight: 1.3,
        }}>
          {title || <span style={{ color: "var(--text-tertiary)", fontWeight: 400, fontSize: 14 }}>No track loaded</span>}
        </div>
        {artist && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {artist}
          </div>
        )}
      </div>

      {/* Timer section */}
      {dur > 0 ? (
        <div style={{ padding: "0 16px 10px" }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 500, color: "var(--text-tertiary)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 2 }}>
                {isInIntro ? "INTRO LEFT" : "REMAINING"}
              </div>
              <div style={{
                fontFamily: "'Courier New', monospace",
                fontSize: 44, fontWeight: 400,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.02em", lineHeight: 1,
                color: accent,
                transition: "color 0.3s ease",
              }}>
                {fmt(isInIntro ? introEnd - pos : remaining)}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, fontWeight: 500, color: "var(--text-tertiary)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 2 }}>ELAPSED</div>
              <div style={{
                fontFamily: "'Courier New', monospace",
                fontSize: 16, fontWeight: 400,
                fontVariantNumeric: "tabular-nums",
                color: "var(--text-tertiary)",
                letterSpacing: "0.02em",
              }}>
                {fmtMs(pos)}
              </div>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ position: "relative", height: 4, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
            <div style={{
              position: "absolute", top: 0, left: 0, height: "100%",
              width: pct + "%",
              background: accent,
              borderRadius: 2,
              transition: "width 0.15s linear",
              boxShadow: isPlaying ? `0 0 8px ${accent}80` : "none",
            }} />
          </div>
        </div>
      ) : (
        <div style={{ height: 8 }} />
      )}

      {/* VU Meter */}
      <div style={{ padding: "0 16px 12px" }}>
        <VUMeter deckId={deckId} isPlaying={isPlaying} />
      </div>

      {/* Controls */}
      <div style={{
        display: "flex", gap: 8, padding: "10px 14px 14px",
        borderTop: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)",
      }}>
        <button onClick={onStop} style={{
          padding: "8px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700,
          background: "var(--bg-active)", color: "var(--text-tertiary)",
          border: "1px solid var(--border-secondary)", cursor: "pointer",
          letterSpacing: "0.06em",
        }}>■ STOP</button>
        <button
          onClick={status === "playing" ? onPause : status === "paused" ? onResume : onPlay}
          style={{
            flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, fontWeight: 700,
            border: "none", cursor: "pointer", letterSpacing: "0.06em",
            background: status === "playing" ? "#fbbf24" : isA ? "#38bdf8" : "#34d399",
            color: "#000",
            boxShadow: `0 2px 12px ${status === "playing" ? "#fbbf2440" : isA ? "#38bdf840" : "#34d39940"}`,
          }}>
          {status === "playing" ? "⏸ PAUSE" : status === "paused" ? "▶ RESUME" : "▶ PLAY"}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, color: "var(--text-tertiary)", fontWeight: 500 }}>VOL</span>
          <input type="range" min="0" max="100" value={Math.round(vol * 100)}
            onChange={e => onVolume(parseInt(e.target.value) / 100)}
            style={{ width: 64, accentColor: accent, cursor: "pointer" }} />
        </div>
      </div>
    </div>
  );
}
