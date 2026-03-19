import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  deckId: "A" | "B" | "C" | string;
  isPlaying: boolean;
  remaining?: number;
  duration?: number;
  pos?: number;
  isInIntro?: boolean;
  isEnding?: boolean;
  isCritical?: boolean;
  introEnd?: number;
}

export default function VUMeter({ deckId, isPlaying, remaining = 0, duration = 0, pos = 0, isInIntro, isEnding, isCritical, introEnd = 0 }: Props) {
  const fillRef = useRef<HTMLDivElement>(null);
  const levelRef = useRef(0);
  const targetRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const diff = targetRef.current - levelRef.current;
      levelRef.current += diff * (diff > 0 ? 0.25 : 0.08);
      if (fillRef.current) {
        fillRef.current.style.height = Math.round(levelRef.current * 100) + "%";
      }
      requestAnimationFrame(tick);
    };
    const id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (!isPlaying) { targetRef.current = 0; return; }
    const poll = async () => {
      try {
        const lvl = await invoke<{a: number, b: number}>("get_levels");
        const raw = deckId === "A" ? lvl.a : lvl.b;
        targetRef.current = raw > 0 ? 0.25 + Math.random() * 0.65 : 0;
      } catch {
        targetRef.current = isPlaying ? 0.3 + Math.random() * 0.6 : 0;
      }
    };
    const id = setInterval(poll, 80);
    return () => { clearInterval(id); targetRef.current = 0; };
  }, [isPlaying, deckId]);

  const showCountdown = isPlaying && (isInIntro || isEnding);
  const countdownNum = isInIntro ? Math.ceil(Math.max(0, introEnd - pos)) : Math.ceil(Math.max(0, remaining));
  const countdownColor = isInIntro ? "#38bdf8" : isCritical ? "#f87171" : "#fb923c";
  const countdownLabel = isInIntro ? "🎙 INTRO" : "⚠ OUTRO";

  return (
    <div style={{ width: "100%", height: "100%", flex: 1, position: "relative", overflow: "hidden", borderRadius: 8 }}>
      {/* Green fill from bottom */}
      <div ref={fillRef} style={{
        position: "absolute", bottom: 0, left: 0, right: 0,
        height: "0%",
        background: "linear-gradient(to top, #22c55e 0%, #4ade80 50%, #86efac 100%)",
        borderRadius: 8,
      }} />
      {/* Gradient overlay at top for readability */}
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(to bottom, rgba(248,250,252,0.85) 0%, rgba(248,250,252,0.4) 40%, transparent 70%)",
        borderRadius: 8,
      }} />
      {/* Countdown overlay */}
      {showCountdown && (
        <div style={{
          position: "absolute", inset: 0,
          background: isInIntro
            ? "linear-gradient(135deg, rgba(14,28,54,0.88) 0%, rgba(7,15,35,0.82) 100%)"
            : "linear-gradient(135deg, rgba(54,14,14,0.88) 0%, rgba(35,7,7,0.82) 100%)",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          borderRadius: 8,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.2em", color: countdownColor, marginBottom: 6, opacity: 0.9 }}>
            {countdownLabel}
          </div>
          <div style={{
            fontFamily: "'Courier New', monospace",
            fontSize: 80, fontWeight: 900,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1, color: countdownColor,
            textShadow: `0 0 40px ${countdownColor}99, 0 0 80px ${countdownColor}44`,
            animation: isCritical ? "none" : "none",
            opacity: isCritical ? (Math.floor(Date.now() / 250) % 2 === 0 ? 1 : 0.4) : 1,
          }}>
            {countdownNum}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 6 }}>
            {isInIntro ? "seconds of intro" : "seconds remaining"}
          </div>
        </div>
      )}
    </div>
  );
}
