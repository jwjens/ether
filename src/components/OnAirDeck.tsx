import VUMeter from "./VUMeter";
import { useState, useEffect } from "react";
import { DeckState } from "../audio/engine-rodio";

interface Props {
  deck: DeckState | null;
  label: string;
  deckId: "A" | "B" | "C";
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onVolume: (v: number) => void;
  onDragStart?: (e: React.MouseEvent) => void;
}

function fmt(sec: number): string {
  if (sec <= 0) return "0:00";
  return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
}

function fmtMs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + ms;
}

export default function OnAirDeck({ deck, label, deckId, onPlay, onPause, onResume, onStop, onVolume, onDragStart }: Props) {
  const [blink, setBlink] = useState(false);

  const status = deck?.status || "idle";
  const title = deck?.title || "";
  const artist = deck?.artist || "";
  const pos = deck?.positionSec || 0;
  const dur = deck?.durationSec || 0;
  const vol = deck?.volume ?? 1;
  const remaining = Math.max(0, dur - pos);
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;

  const isPlaying = status === "playing";
  const isPaused = status === "paused";
  const isIdle = !title;
  const introEnd = dur * 0.08;
  const isInIntro = pos < introEnd && isPlaying && dur > 0 && introEnd > 3;
  const isEnding = remaining < 15 && remaining > 0 && isPlaying;
  const isCritical = remaining < 5 && remaining > 0 && isPlaying;
  const showOverlay = isPlaying && dur > 0 && (isInIntro || isEnding);

  useEffect(() => {
    if (isCritical) {
      const id = setInterval(() => setBlink(b => !b), 250);
      return () => clearInterval(id);
    }
    setBlink(false);
  }, [isCritical]);

  // State-driven colors
  let accent = "#94a3b8";
  let statusLabel = "IDLE";
  let statusColor = "var(--text-tertiary)";
  let topBarColor = "var(--border-primary)";
  let cardBg = "var(--bg-secondary)";
  let cardShadow = "var(--shadow-sm)";
  let cardBorder = "var(--border-primary)";

  if (isPlaying) {
    if (isCritical) {
      accent = "#f87171"; statusLabel = "ENDING"; statusColor = "#f87171";
      topBarColor = "#f87171";
      cardBg = blink ? "rgba(248,113,113,0.04)" : "var(--bg-secondary)";
      cardShadow = "0 0 0 1px rgba(248,113,113,0.2), 0 8px 32px rgba(248,113,113,0.12)";
      cardBorder = "rgba(248,113,113,0.25)";
    } else if (isEnding) {
      accent = "#fb923c"; statusLabel = "OUTRO"; statusColor = "#fb923c";
      topBarColor = "#fb923c";
      cardShadow = "0 0 0 1px rgba(251,146,60,0.15), 0 8px 32px rgba(251,146,60,0.1)";
      cardBorder = "rgba(251,146,60,0.2)";
    } else {
      accent = "#34d399"; statusLabel = "ON AIR"; statusColor = "#34d399";
      topBarColor = "#34d399";
      cardShadow = "0 0 0 1px rgba(52,211,153,0.15), 0 8px 32px rgba(52,211,153,0.1)";
      cardBorder = "rgba(52,211,153,0.2)";
    }
  } else if (isPaused) {
    accent = "#fbbf24"; statusLabel = "PAUSED"; statusColor = "#fbbf24";
    topBarColor = "#fbbf24";
  } else if (title) {
    accent = "#64748b"; statusLabel = "READY"; statusColor = "#64748b";
  }

  // Deck identity colors
  const deckHue = deckId === "A" ? "#38bdf8" : deckId === "B" ? "#34d399" : "#a78bfa";
  const deckHueBg = deckId === "A" ? "rgba(56,189,248,0.1)" : deckId === "B" ? "rgba(52,211,153,0.1)" : "rgba(167,139,250,0.1)";
  const deckHueBorder = deckId === "A" ? "rgba(56,189,248,0.25)" : deckId === "B" ? "rgba(52,211,153,0.25)" : "rgba(167,139,250,0.25)";

  const playBtnBg = isPlaying ? "#fbbf24" : isPaused ? "#34d399" : deckHue;
  const playBtnLabel = isPlaying ? "PAUSE" : isPaused ? "RESUME" : "PLAY";

  return (
    <div style={{
      background: cardBg,
      borderRadius: 18,
      border: `1px solid ${cardBorder}`,
      boxShadow: cardShadow,
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      transition: "background 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>

      {/* ── Top accent bar ── */}
      <div style={{
        height: 3,
        background: topBarColor,
        transition: "background 0.3s ease",
        boxShadow: isPlaying ? `0 0 16px ${topBarColor}60` : "none",
        flexShrink: 0,
      }} />

      {/* ── Header row ── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 16px 6px",
        flexShrink: 0,
      }}>
        {/* Deck badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {onDragStart && (
            <div
              onMouseDown={onDragStart}
              title="Drag to reorder"
              style={{ cursor: "grab", padding: "2px 3px", borderRadius: 4, color: "var(--text-tertiary)", display: "flex", alignItems: "center", flexShrink: 0, opacity: 0.5 }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "0.5"; }}
            >
              <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
                <circle cx="3" cy="2" r="1.2"/><circle cx="7" cy="2" r="1.2"/>
                <circle cx="3" cy="6" r="1.2"/><circle cx="7" cy="6" r="1.2"/>
                <circle cx="3" cy="10" r="1.2"/><circle cx="7" cy="10" r="1.2"/>
              </svg>
            </div>
          )}
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: deckHueBg,
            border: `1px solid ${deckHueBorder}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Syne', sans-serif",
            fontSize: 12, fontWeight: 800,
            color: deckHue,
            letterSpacing: "0em",
            flexShrink: 0,
          }}>{deckId}</div>
          <span style={{
            fontSize: 9, fontWeight: 700,
            color: "var(--text-tertiary)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}>
            {isPlaying ? "ON AIR" : isPaused ? "PAUSED" : deckId === "A" ? "PRIMARY" : deckId === "B" ? "STANDBY" : "NEXT UP"}
          </span>
        </div>

        {/* Status pill */}
        <div style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "3px 10px",
          borderRadius: 20,
          background: isPlaying ? `${accent}14` : "var(--bg-tertiary)",
          border: `1px solid ${isPlaying ? accent + "30" : "var(--border-primary)"}`,
        }}>
          <div style={{
            width: 5, height: 5, borderRadius: "50%",
            background: statusColor,
            boxShadow: isPlaying ? `0 0 6px ${statusColor}` : "none",
          }} />
          <span style={{
            fontSize: 9, fontWeight: 700,
            color: statusColor,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}>{statusLabel}</span>
        </div>
      </div>

      {/* ── Track info ── */}
      <div style={{ padding: "2px 16px 10px", flexShrink: 0 }}>
        <div style={{
          fontSize: isPlaying ? 16 : 14,
          color: isIdle ? "var(--text-tertiary)" : "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          letterSpacing: "-0.025em",
          lineHeight: 1.3,
          transition: "font-size 0.2s ease",
          fontStyle: isIdle ? "italic" : "normal",
          fontWeight: isIdle ? 400 : 600,
        }}>
          {title || "No track loaded"}
        </div>
        <div style={{
          fontSize: 11,
          color: isPlaying ? "var(--text-secondary)" : "var(--text-tertiary)",
          marginTop: 3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          letterSpacing: "0.005em",
          minHeight: 15,
        }}>
          {artist || ""}
        </div>
      </div>

      {/* ── Timers ── */}
      <div style={{
        padding: "0 16px 8px",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        flexShrink: 0,
      }}>
        {/* Remaining — hero number */}
        <div>
          <div style={{
            fontSize: 8, fontWeight: 600,
            color: "var(--text-tertiary)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            marginBottom: 3,
          }}>REMAINING</div>
          <div style={{
            fontFamily: "'DM Mono', 'SF Mono', monospace",
            fontSize: dur > 0 ? 40 : 28,
            fontWeight: 300,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.04em",
            lineHeight: 1,
            color: dur > 0 ? accent : "var(--text-tertiary)",
            transition: "color 0.3s ease",
          }}>
            {dur > 0 ? fmt(remaining) : "—:——"}
          </div>
        </div>

        {/* Elapsed — secondary */}
        <div style={{ textAlign: "right" as const, paddingBottom: 4 }}>
          <div style={{
            fontSize: 8,
            color: "var(--text-tertiary)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            marginBottom: 3,
          }}>ELAPSED</div>
          <div style={{
            fontFamily: "'DM Mono', 'SF Mono', monospace",
            fontSize: 13,
            fontWeight: 400,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.02em",
            color: dur > 0 ? "var(--text-secondary)" : "var(--text-tertiary)",
          }}>
            {dur > 0 ? fmtMs(pos) : "——:——.—"}
          </div>
        </div>
      </div>

      {/* ── Progress bar ── */}
      <div style={{
        margin: "0 16px 10px",
        height: 3,
        background: "var(--bg-tertiary)",
        borderRadius: 2,
        overflow: "hidden",
        flexShrink: 0,
      }}>
        <div style={{
          height: "100%",
          width: dur > 0 ? pct + "%" : "0%",
          background: accent,
          borderRadius: 2,
          transition: "width 0.15s linear, background 0.3s ease",
          boxShadow: isPlaying ? `0 0 6px ${accent}` : "none",
        }} />
      </div>

      {/* ── VU Meter with countdown overlay ── */}
      <div style={{
        margin: "0 16px 10px",
        flex: 1,
        minHeight: 44,
        position: "relative",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--bg-tertiary)",
      }}>
        <VUMeter
          deckId={deckId}
          isPlaying={isPlaying}
          remaining={remaining}
          duration={dur}
          pos={pos}
          isInIntro={isInIntro}
          isEnding={isEnding}
          isCritical={isCritical}
          introEnd={introEnd}
          hasTrack={!!title}
        />

        {/* Countdown overlay — only covers VU area */}
        {showOverlay && (
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10,
            background: "var(--bg-secondary)",
            opacity: 0.92,
            backdropFilter: "blur(2px)",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: 2,
          }}>
            <div style={{
              fontSize: 8, fontWeight: 700, letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: isInIntro ? "var(--accent-blue)" : isCritical ? "var(--accent-red)" : "var(--accent-orange)",
              opacity: 0.8,
            }}>
              {isInIntro ? "🎙 INTRO" : "⚠ OUTRO"}
            </div>
            <div style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 88, fontWeight: 500,
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
              letterSpacing: "-0.05em",
              color: isInIntro ? "var(--accent-blue)" : isCritical ? "var(--accent-red)" : "var(--accent-orange)",
              opacity: isCritical && blink ? 0.4 : 1,
              transition: "opacity 0.1s",
            }}>
              {isInIntro ? Math.ceil(introEnd - pos) : Math.ceil(remaining)}
            </div>
            <div style={{
              fontSize: 8, fontWeight: 500, letterSpacing: "0.1em",
              color: "var(--text-tertiary)",
            }}>
              {isInIntro ? "seconds of intro" : "seconds remaining"}
            </div>
          </div>
        )}
      </div>

      {/* ── Controls ── */}
      <div style={{
        padding: "10px 16px 14px",
        borderTop: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
      }}>
        {/* STOP */}
        <button
          onClick={onStop}
          style={{
            width: 36, height: 36,
            borderRadius: 10,
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-secondary)",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 10,
            flexShrink: 0,
            transition: "all 0.15s ease",
          }}
          title="Stop"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <rect x="0" y="0" width="10" height="10" rx="1.5"/>
          </svg>
        </button>

        {/* PLAY / PAUSE / RESUME */}
        <button
          onClick={isPlaying ? onPause : isPaused ? onResume : onPlay}
          style={{
            flex: 1,
            height: 36,
            borderRadius: 10,
            background: playBtnBg,
            border: "none",
            color: "#000",
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            gap: 6,
            fontSize: 11, fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            transition: "all 0.15s ease",
            boxShadow: `0 2px 8px ${playBtnBg}50`,
          }}
        >
          {isPlaying ? (
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
              <rect x="0" y="0" width="3.5" height="12" rx="1"/>
              <rect x="6.5" y="0" width="3.5" height="12" rx="1"/>
            </svg>
          ) : (
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
              <polygon points="0,0 10,6 0,12"/>
            </svg>
          )}
          {playBtnLabel}
        </button>


      </div>
    </div>
  );
}
