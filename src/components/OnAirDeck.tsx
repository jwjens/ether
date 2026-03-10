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

  // Cue point zones (approximated - would use real cue points if saved)
  const introEnd = dur * 0.08; // first 8% is intro
  const outroStart = dur * 0.92; // last 8% is outro
  const isInIntro = pos < introEnd && status === "playing";
  const isInOutro = pos > outroStart && status === "playing";
  const isEnding = remaining < 15 && remaining > 0 && status === "playing";
  const isCritical = remaining < 5 && remaining > 0 && status === "playing";

  // Blink effect when ending
  useEffect(() => {
    if (isCritical) {
      const id = setInterval(() => setBlink(b => !b), 300);
      return () => clearInterval(id);
    }
    setBlink(false);
  }, [isCritical]);

  // Background color logic
  let bgColor = "#18181b"; // idle - dark
  let textColor = "#71717a"; // idle - gray
  let timerColor = "#71717a";
  let barColor = "#3f3f46";

  if (status === "playing") {
    if (isInIntro) {
      // INTRO - bright blue (talk time!)
      bgColor = "#1e3a5f";
      textColor = "#60a5fa";
      timerColor = "#93c5fd";
      barColor = "#3b82f6";
    } else if (isCritical) {
      // CRITICAL - flashing red
      bgColor = blink ? "#7f1d1d" : "#450a0a";
      textColor = "#fca5a5";
      timerColor = blink ? "#ffffff" : "#fca5a5";
      barColor = "#ef4444";
    } else if (isEnding) {
      // ENDING - solid red
      bgColor = "#450a0a";
      textColor = "#fca5a5";
      timerColor = "#f87171";
      barColor = "#ef4444";
    } else if (isInOutro) {
      // OUTRO - amber/yellow
      bgColor = "#451a03";
      textColor = "#fcd34d";
      timerColor = "#fbbf24";
      barColor = "#f59e0b";
    } else {
      // PLAYING - green
      bgColor = "#052e16";
      textColor = "#86efac";
      timerColor = "#4ade80";
      barColor = "#22c55e";
    }
  } else if (status === "paused") {
    bgColor = "#1c1917";
    textColor = "#fbbf24";
    timerColor = "#fbbf24";
  }

  return (
    <div className="rounded-lg overflow-hidden transition-colors duration-300" style={{ backgroundColor: bgColor }}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5" style={{ backgroundColor: "rgba(0,0,0,0.3)" }}>
        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: textColor }}>{label}</span>
        <span className="text-[10px] uppercase font-bold" style={{ color: textColor }}>
          {status === "playing" ? (isInIntro ? "INTRO - TALK!" : isInOutro ? "OUTRO" : isEnding ? "ENDING" : "PLAYING") : status === "paused" ? "PAUSED" : status === "loading" ? "LOADING" : "IDLE"}
        </span>
      </div>

      {/* Main content */}
      <div className="px-3 py-2">
        {/* Title + Artist */}
        <div className="text-base font-bold truncate" style={{ color: status === "playing" ? "#ffffff" : "#a1a1aa" }}>{title || "No track loaded"}</div>
        {artist && <div className="text-xs truncate mb-2" style={{ color: textColor }}>{artist}</div>}

        {/* Big countdown timer */}
        {dur > 0 && (
          <div className="flex items-end justify-between mb-2">
            <div>
              <div className="text-[10px] uppercase" style={{ color: textColor }}>{isInIntro ? "Intro Left" : "Remaining"}</div>
              <div className="text-3xl font-mono font-black leading-none" style={{ color: timerColor }}>
                {isInIntro ? fmtCountdown(introEnd - pos) : fmtCountdown(remaining)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase" style={{ color: textColor }}>Elapsed</div>
              <div className="text-lg font-mono" style={{ color: textColor }}>{fmtElapsed(pos)}</div>
            </div>
          </div>
        )}

        {/* Progress bar with zones */}
        {dur > 0 && (
          <div className="relative h-3 rounded-full overflow-hidden mb-1" style={{ backgroundColor: "rgba(0,0,0,0.3)" }}>
            {/* Intro zone marker */}
            <div className="absolute top-0 h-full opacity-30" style={{ left: 0, width: (introEnd / dur * 100) + "%", backgroundColor: "#3b82f6" }}></div>
            {/* Outro zone marker */}
            <div className="absolute top-0 h-full opacity-30" style={{ left: (outroStart / dur * 100) + "%", width: ((dur - outroStart) / dur * 100) + "%", backgroundColor: "#f59e0b" }}></div>
            {/* Playhead */}
            <div className="absolute top-0 h-full rounded-full transition-all" style={{ width: pct + "%", backgroundColor: barColor }}></div>
          </div>
        )}

        {/* Time markers */}
        {dur > 0 && (
          <div className="flex justify-between text-[9px] font-mono" style={{ color: textColor }}>
            <span>{fmtCountdown(0)}</span>
            <span>Intro {fmtCountdown(introEnd)}</span>
            <span>Outro {fmtCountdown(dur - outroStart)}</span>
            <span>{fmtCountdown(dur)}</span>
          </div>
        )}
      </div>
    </div>
  );
}