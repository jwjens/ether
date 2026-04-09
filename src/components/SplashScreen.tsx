import { useEffect, useState } from "react";

interface Props {
  onDone: () => void;
}

const STEPS = [
  { label: "Loading database...", duration: 700 },
  { label: "Starting audio engine...", duration: 700 },
  { label: "Ready.", duration: 400 },
];

export default function SplashScreen({ onDone }: Props) {
  const [stepIdx, setStepIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    let elapsed = 0;
    const total = STEPS.reduce((s, st) => s + st.duration, 0);
    const tick = 30;

    const interval = setInterval(() => {
      elapsed += tick;
      setProgress(Math.min(100, (elapsed / total) * 100));

      let cum = 0;
      for (let i = 0; i < STEPS.length; i++) {
        cum += STEPS[i].duration;
        if (elapsed <= cum) { setStepIdx(i); break; }
      }

      if (elapsed >= total) {
        clearInterval(interval);
        setTimeout(() => {
          setFadeOut(true);
          setTimeout(onDone, 500);
        }, 200);
      }
    }, tick);

    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "#080810",
      display: "flex", flexDirection: "column" as any,
      alignItems: "center", justifyContent: "center",
      opacity: fadeOut ? 0 : 1,
      transition: "opacity 0.5s ease",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>

      {/* Radial glow */}
      <div style={{
        position: "absolute", width: 600, height: 600, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(34,211,238,0.07) 0%, transparent 70%)",
        pointerEvents: "none",
        animation: "splash-pulse 3s ease-in-out infinite",
      }} />

      {/* Logo mark */}
      <div style={{ position: "relative", marginBottom: 32 }}>
        {/* Gradient circle icon */}
        <div style={{
          width: 80, height: 80, borderRadius: 0,
          background: "linear-gradient(135deg, #22d3ee 0%, #a78bfa 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 0 40px rgba(34,211,238,0.35), 0 0 80px rgba(167,139,250,0.2)",
          marginBottom: 24,
          animation: "splash-logo 0.6s cubic-bezier(0.34,1.56,0.64,1) both",
        }}>
          {/* Sine wave cut-out */}
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
            <path
              d="M4 22 C9 12 14 12 19 22 C24 32 29 32 34 22 C39 12 40 12 40 22"
              stroke="#080810" strokeWidth="3.5" strokeLinecap="round"
            />
          </svg>
        </div>

        {/* Wordmark */}
        <div style={{ textAlign: "center" as any, animation: "splash-words 0.6s 0.15s ease both" }}>
          <div style={{
            fontFamily: "'Syne', sans-serif",
            fontSize: 36, fontWeight: 800,
            letterSpacing: "-0.02em",
            background: "linear-gradient(135deg, #f0f0f8 0%, rgba(240,240,248,0.7) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            marginBottom: 4,
          }}>ETHER TECHNOLOGIES</div>
        </div>
      </div>

      {/* Built by Deniro */}
      <div style={{
        position: "absolute", bottom: 18,
        fontSize: 9, color: "rgba(255,255,255,0.1)",
        letterSpacing: "0.12em", fontFamily: "'DM Mono', monospace",
      }}>BUILT BY DENIRO</div>

      {/* Progress area */}
      <div style={{ width: 280, animation: "splash-words 0.6s 0.3s ease both" }}>
        {/* Bar track */}
        <div style={{
          height: 2, background: "rgba(255,255,255,0.06)",
          borderRadius: 0, overflow: "hidden", marginBottom: 12,
        }}>
          <div style={{
            height: "100%",
            width: progress + "%",
            background: "linear-gradient(90deg, #22d3ee, #a78bfa)",
            borderRadius: 0,
            transition: "width 0.1s linear",
            boxShadow: "0 0 8px rgba(34,211,238,0.5)",
          }} />
        </div>

        {/* Step label */}
        <div style={{
          fontSize: 11, color: "rgba(255,255,255,0.35)",
          letterSpacing: "0.06em", textAlign: "center" as any,
          fontFamily: "'DM Mono', monospace",
          minHeight: 16,
        }}>
          {STEPS[stepIdx]?.label}
        </div>
      </div>

      <style>{`
        @keyframes splash-pulse {
          0%,100%{opacity:0.6;transform:scale(1);}
          50%{opacity:1;transform:scale(1.08);}
        }
        @keyframes splash-logo {
          from{opacity:0;transform:scale(0.7);}
          to{opacity:1;transform:scale(1);}
        }
        @keyframes splash-words {
          from{opacity:0;transform:translateY(12px);}
          to{opacity:1;transform:translateY(0);}
        }
      `}</style>
    </div>
  );
}
