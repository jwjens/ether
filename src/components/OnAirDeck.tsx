import { useState, useEffect } from "react";
import { DeckState } from "../audio/engine";

interface Props {
  deck: DeckState | null;
  label: string;
}

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + ms;
}

export default function OnAirDeck({ deck, label }: Props) {
  const [blink, setBlink] = useState(false);

  const status = deck?.status || "idle";
  const title = deck?.title || "";
  const artist = deck?.artist || "";
  const pos = deck?.positionSec || 0;
  const dur = deck?.durationSec || 0;
  const remaining = dur - pos;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;

  const introEnd = dur * 0.08;
  const outroStart = dur * 0.92;
  const isInIntro = pos < introEnd && status === "playing";
  const isInOutro = pos > outroStart && status === "playing";
  const isEnding = remaining < 15 && remaining > 0 && status === "playing";
  const isCritical = remaining < 5 && remaining > 0 && status === "playing";

  useEffect(() => {
    if (isCritical) {
      const id = setInterval(() => setBlink(b => !b), 300);
      return () => clearInterval(id);
    }
    setBlink(false);
  }, [isCritical]);

  // Theme-aware color system
  let accentColor = "var(--accent-blue)";
  let bgTint = "var(--bg-secondary)";
  let statusLabel = "IDLE";
  let statusColor = "var(--text-tertiary)";

  if (status === "playing") {
    if (isInIntro) {
      accentColor = "var(--accent-blue)";
      bgTint = "rgba(37, 99, 235, 0.06)";
      statusLabel = "INTRO — TALK";
      statusColor = "var(--accent-blue)";
    } else if (isCritical) {
      accentColor = "var(--accent-red)";
      bgTint = blink ? "rgba(220, 38, 38, 0.12)" : "rgba(220, 38, 38, 0.06)";
      statusLabel = "ENDING";
      statusColor = "var(--accent-red)";
    } else if (isEnding) {
      accentColor = "var(--accent-red)";
      bgTint = "rgba(220, 38, 38, 0.04)";
      statusLabel = "ENDING";
      statusColor = "var(--accent-red)";
    } else if (isInOutro) {
      accentColor = "var(--accent-amber)";
      bgTint = "rgba(217, 119, 6, 0.04)";
      statusLabel = "OUTRO";
      statusColor = "var(--accent-amber)";
    } else {
      accentColor = "var(--accent-green)";
      bgTint = "rgba(22, 163, 74, 0.04)";
      statusLabel = "PLAYING";
      statusColor = "var(--accent-green)";
    }
  } else if (status === "paused") {
    statusLabel = "PAUSED";
    statusColor = "var(--accent-amber)";
  } else if (status === "loading") {
    statusLabel = "LOADING";
    statusColor = "var(--accent-blue)";
  }

  return (
    <div style={{
      background: bgTint,
      borderRadius: "var(--radius)",
      border: "1px solid var(--border-primary)",
      boxShadow: "var(--shadow-sm)",
      overflow: "hidden",
      transition: "background 0.3s ease",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 16px",
        borderBottom: "1px solid var(--border-primary)",
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: accentColor }}>{label}</span>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.04em", color: statusColor }}>{statusLabel}</span>
      </div>

      {/* Content */}
      <div style={{ padding: "12px 16px" }}>
        {/* Title */}
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, letterSpacing: "-0.02em" }}>
          {title || "No track loaded"}
        </div>
        {artist && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{artist}</div>}

        {/* Timer */}
        {dur > 0 && (
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", margin: "12px 0 8px" }}>
            <div>
              <div style={{ fontSize: 9, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--text-tertiary)", marginBottom: 2 }}>
                {isInIntro ? "Intro Left" : "Remaining"}
              </div>
              <div style={{ fontSize: 40, fontWeight: 500, fontFamily: "'DM Mono', monospace", fontVariantNumeric: "tabular-nums", lineHeight: 1, color: accentColor, letterSpacing: "-0.02em" }}>
                {isInIntro ? fmtCountdown(introEnd - pos) : fmtCountdown(remaining)}
              </div>
            </div>
            <div style={{ textAlign: "right" as const }}>
              <div style={{ fontSize: 9, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--text-tertiary)", marginBottom: 2 }}>Elapsed</div>
              <div style={{ fontSize: 18, fontWeight: 400, fontFamily: "'DM Mono', monospace", fontVariantNumeric: "tabular-nums", color: "var(--text-secondary)" }}>{fmtElapsed(pos)}</div>
            </div>
          </div>
        )}

        {/* Progress bar */}
        {dur > 0 && (
          <div style={{ position: "relative", height: 6, background: "var(--bg-tertiary)", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: pct + "%", background: accentColor, borderRadius: 3, transition: "width 0.2s linear" }}></div>
          </div>
        )}
      </div>
    </div>
  );
}
