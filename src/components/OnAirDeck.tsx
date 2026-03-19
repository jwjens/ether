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
}

function fmt(sec: number): string {
  if (sec <= 0) return "0:00";
  return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
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

  const isPlaying = status === "playing";
  const introEnd = dur * 0.08;
  const isInIntro = pos < introEnd && isPlaying && dur > 0 && introEnd > 3;
  const isEnding = remaining < 15 && remaining > 0 && isPlaying;
  const isCritical = remaining < 5 && remaining > 0 && isPlaying;

  useEffect(() => {
    if (isCritical) {
      const id = setInterval(() => setBlink(b => !b), 250);
      return () => clearInterval(id);
    }
    setBlink(false);
  }, [isCritical]);

  let accent = "#22d3ee";
  let statusLabel = "IDLE";
  let statusDot = "#404055";
  let topBar = "var(--border-primary)";
  let bgCard = "var(--bg-secondary)";

  if (isPlaying) {
    if (isCritical) {
      accent = "#f87171"; statusLabel = "ENDING"; statusDot = "#f87171"; topBar = "#f87171";
      bgCard = blink ? "rgba(248,113,113,0.06)" : "rgba(248,113,113,0.02)";
    } else if (isEnding) {
      accent = "#fb923c"; statusLabel = "OUTRO"; statusDot = "#fb923c"; topBar = "#fb923c";
      bgCard = "rgba(251,146,60,0.03)";
    } else {
      accent = "#34d399"; statusLabel = "PLAYING"; statusDot = "#34d399"; topBar = "#34d399";
      bgCard = "rgba(52,211,153,0.03)";
    }
  } else if (status === "paused") {
    accent = "#fbbf24"; statusLabel = "PAUSED"; statusDot = "#fbbf24"; topBar = "#fbbf24";
  } else if (status === "loading") {
    accent = "#38bdf8"; statusLabel = "LOADING"; statusDot = "#38bdf8"; topBar = "#38bdf8";
  } else if (title) {
    statusLabel = "STANDBY";
  }

  const deckColor = deckId === "A" ? "#38bdf8" : deckId === "B" ? "#34d399" : "#a78bfa";
  const deckBg = deckId === "A" ? "rgba(56,189,248,0.15)" : deckId === "B" ? "rgba(52,211,153,0.15)" : "rgba(167,139,250,0.15)";
  const deckBorder = deckId === "A" ? "rgba(56,189,248,0.3)" : deckId === "B" ? "rgba(52,211,153,0.3)" : "rgba(167,139,250,0.3)";

  return (
    <div style={{
      background: bgCard, borderRadius: 16, border: "1px solid var(--border-secondary)",
      overflow: "hidden", transition: "background 0.4s ease",
      display: "flex", flexDirection: "column", height: "100%",
      boxShadow: isPlaying ? `0 0 0 1px ${accent}30, 0 4px 24px ${accent}15` : "var(--shadow-md)",
    }}>
      {/* Top color bar */}
      <div style={{ height: 3, background: topBar, transition: "background 0.3s ease",
        boxShadow: isPlaying ? `0 0 12px ${accent}80` : "none" }} />
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 14px 6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: deckBg, border: `1px solid ${deckBorder}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 800, color: deckColor }}>{deckId}</div>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {deckId === "A" ? "ON AIR" : "STANDBY"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: 3, background: statusDot,
            boxShadow: isPlaying ? `0 0 6px ${statusDot}` : "none" }} />
          <span style={{ fontSize: 10, fontWeight: 700, color: statusDot, letterSpacing: "0.1em", textTransform: "uppercase" }}>{statusLabel}</span>
        </div>
      </div>

      {/* Track info */}
      <div style={{ padding: "0 14px 8px" }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "-0.02em" , position: "relative"}}>
          {title || <span style={{ color: "var(--text-tertiary)", fontWeight: 400, fontSize: 13 }}>No track loaded</span>}
        </div>
        {artist && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artist}</div>}
      </div>

      {/* DEBUG - remove after fix */}
      <div style={{ padding: "2px 14px", fontSize: 10, color: "red", fontFamily: "monospace" }}>
        dur={dur.toFixed(1)} pos={pos.toFixed(1)} rem={remaining.toFixed(1)} intro={isInIntro?'YES':'no'} ending={isEnding?'YES':'no'}
      </div>
      {/* Timers */}
      {dur > 0 && (
        <div style={{ padding: "0 14px 4px", display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 8, fontWeight: 500, color: "var(--text-tertiary)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 2 }}>REMAINING</div>
            <div style={{ fontFamily: "'Courier New', monospace", fontSize: 36, fontWeight: 400,
              fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", lineHeight: 1, color: accent }}>
              {fmt(remaining)}
            </div>
          </div>
          <div style={{ textAlign: "right" as any, paddingBottom: 4 }}>
            <div style={{ fontSize: 8, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 2 }}>ELAPSED</div>
            <div style={{ fontFamily: "'Courier New', monospace", fontSize: 13,
              fontVariantNumeric: "tabular-nums", color: "var(--text-tertiary)" }}>{fmtMs(pos)}</div>
          </div>
        </div>
      )}

      {/* Progress bar */}
      {dur > 0 && (
        <div style={{ margin: "0 14px 8px", position: "relative", height: 4,
          background: "var(--bg-tertiary)", borderRadius: 2 }}>
          <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: pct + "%",
            background: accent, borderRadius: 2, transition: "width 0.15s linear",
            boxShadow: isPlaying ? `0 0 8px ${accent}80` : "none" }} />
        </div>
      )}


      {/* Intro/Outro overlay with countdown */}
      {isPlaying && dur > 0 && (isInIntro || isEnding) && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 10,
          background: isInIntro
            ? "linear-gradient(135deg, rgba(30,30,50,0.92) 0%, rgba(10,10,30,0.88) 100%)"
            : "linear-gradient(135deg, rgba(50,20,20,0.92) 0%, rgba(30,10,10,0.88) 100%)",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          borderRadius: 16,
          animation: "overlay-pulse 1s ease-in-out infinite",
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase",
            color: isInIntro ? "#38bdf8" : "#f87171",
            marginBottom: 8, opacity: 0.9,
          }}>
            {isInIntro ? "🎙 TALK OVER — INTRO" : "⚠ OUTRO — BACK ANNOUNCE"}
          </div>
          <div style={{
            fontFamily: "'Courier New', monospace",
            fontSize: 96, fontWeight: 900,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
            color: isInIntro ? "#38bdf8" : (isCritical ? "#f87171" : "#fb923c"),
            textShadow: isInIntro
              ? "0 0 40px rgba(56,189,248,0.8), 0 0 80px rgba(56,189,248,0.4)"
              : "0 0 40px rgba(248,113,113,0.8), 0 0 80px rgba(248,113,113,0.4)",
            animation: isCritical ? "countdown-blink 0.5s ease-in-out infinite" : "none",
          }}>
            {isInIntro ? Math.ceil(introEnd - pos) : Math.ceil(remaining)}
          </div>
          <div style={{
            fontSize: 12, fontWeight: 500, letterSpacing: "0.1em",
            color: "rgba(255,255,255,0.5)", marginTop: 8,
          }}>
            {isInIntro ? "seconds of intro remaining" : "seconds remaining"}
          </div>
        </div>
      )}


      {/* VU Meter */}
      <div style={{ margin: "0 14px 8px", flex: 1, minHeight: 60, display: "flex", flexDirection: "column" }}>
        <VUMeter 
          deckId={deckId} 
          isPlaying={status === "playing"}
          remaining={remaining}
          duration={dur}
          pos={pos}
          isInIntro={isInIntro}
          isEnding={isEnding}
          isCritical={isCritical}
          introEnd={introEnd}
        />
      </div>
      {/* Controls */}
      <div style={{ display: "flex", gap: 8, padding: "8px 14px 12px",
        borderTop: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
        <button onClick={onStop} style={{ padding: "8px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700,
          background: "var(--bg-active)", color: "var(--text-tertiary)",
          border: "1px solid var(--border-secondary)", cursor: "pointer", letterSpacing: "0.06em" }}>■ STOP</button>
        <button onClick={status === "playing" ? onPause : status === "paused" ? onResume : onPlay}
          style={{ flex: 1, padding: "8px", borderRadius: 8, fontSize: 12, fontWeight: 700,
            border: "none", cursor: "pointer", letterSpacing: "0.06em",
            background: status === "playing" ? "#fbbf24" : deckColor, color: "#000" }}>
          {status === "playing" ? "⏸ PAUSE" : status === "paused" ? "▶ RESUME" : "▶ PLAY"}
        </button>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
          <span style={{ fontSize: 8, color: "var(--text-tertiary)", fontWeight: 500 }}>VOL</span>
          <input type="range" min="0" max="100" value={Math.round(vol * 100)}
            onChange={e => onVolume(parseInt(e.target.value) / 100)}
            style={{ width: 56, accentColor: accent, cursor: "pointer" }} />
          <span style={{ fontSize: 8, color: "var(--text-tertiary)" }}>{Math.round(vol * 100)}%</span>
        </div>
      </div>
    </div>
  );
}


