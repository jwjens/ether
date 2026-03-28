import { useState, useEffect, useRef } from "react";

const BAR_COUNT = 32;
const PEAK_HOLD_MS = 1200;

interface Props {
  inputDeviceId?: string;
}

function DuckToggle() {
  const [duck, setDuck] = useState(true);
  useEffect(() => {
    (window as any).__etherDuck = duck;
  }, [duck]);
  return (
    <div style={{ padding: "0 14px 6px" }}>
      <button
        onClick={() => setDuck(d => !d)}
        style={{
          width: "100%", padding: "5px 10px", borderRadius: 8,
          background: duck ? "rgba(56,189,248,0.1)" : "var(--bg-tertiary)",
          border: `1px solid ${duck ? "rgba(56,189,248,0.3)" : "var(--border-primary)"}`,
          color: duck ? "var(--accent-cyan)" : "var(--text-tertiary)",
          fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          transition: "all 0.15s",
        }}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M11 5L6 9H2v6h4l5 4V5z"/>
          {duck ? <path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/> : <line x1="23" y1="1" x2="1" y2="23"/>}
        </svg>
        {duck ? "AUTO-DUCK ON" : "AUTO-DUCK OFF"}
      </button>
    </div>
  );
}

export default function MicDeck({ inputDeviceId }: Props) {
  const [micLive, setMicLive] = useState(false);
  const [showProcessing, setShowProcessing] = useState(false);
  const [level, setLevel] = useState(0);
  const [peakHold, setPeakHold] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animRef = useRef<number>(0);
  const peakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Canvas VU refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const peaksRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const peakTimesRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const targetLevelRef = useRef(0);
  const flatlinePhaseRef = useRef(0);
  const rafRef = useRef<number>(0);
  const micLiveRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => { micLiveRef.current = micLive; }, [micLive]);

  // Canvas draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      const now = Date.now();
      ctx.clearRect(0, 0, w, h);

      const barW = Math.max(2, Math.floor((w - BAR_COUNT + 1) / BAR_COUNT));
      const gap = 1;
      const totalW = BAR_COUNT * (barW + gap) - gap;
      const offsetX = Math.floor((w - totalW) / 2);

      if (!micLiveRef.current) {
        // Idle flatline — slow red sine, same as song deck standby
        flatlinePhaseRef.current += 0.018;
        const phase = flatlinePhaseRef.current;
        for (let i = 0; i < BAR_COUNT; i++) {
          const x = offsetX + i * (barW + gap);
          const wave = 0.04 * Math.sin(phase - i * 0.35) + 0.015 * Math.sin(phase * 1.7 - i * 0.6);
          const barH = Math.max(2, Math.floor((0.055 + wave) * h));
          const y = h / 2 - barH / 2;
          ctx.fillStyle = "#ef4444";
          ctx.globalAlpha = 0.45;
          ctx.beginPath();
          ctx.roundRect(x, y, barW, barH, 1);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        // Center dashed line
        ctx.strokeStyle = "#ef4444";
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(offsetX, h / 2);
        ctx.lineTo(offsetX + totalW, h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // Label
        ctx.fillStyle = "#ef4444";
        ctx.globalAlpha = 0.45;
        ctx.font = `700 9px 'Inter', sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("STANDBY", w / 2, h - 8);
        ctx.globalAlpha = 1;
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Live — animated bars rising from bottom, red gradient
      for (let i = 0; i < BAR_COUNT; i++) {
        const x = offsetX + i * (barW + gap);
        const target = targetLevelRef.current * (0.55 + Math.random() * 0.45);
        const current = levelsRef.current[i];
        const diff = target - current;
        levelsRef.current[i] += diff * (diff > 0 ? 0.35 : 0.12);
        const lv = levelsRef.current[i];
        const barH = Math.max(2, Math.floor(lv * h));

        // Peak hold
        if (lv > peaksRef.current[i]) {
          peaksRef.current[i] = lv;
          peakTimesRef.current[i] = now;
        } else if (now - peakTimesRef.current[i] > PEAK_HOLD_MS) {
          peaksRef.current[i] = Math.max(0, peaksRef.current[i] - 0.015);
        }

        // Red gradient — light at bottom, dark at top (mirrors green song deck)
        const barGrad = ctx.createLinearGradient(x, h, x, h - barH);
        barGrad.addColorStop(0, "#fca5a5"); // light red at bottom
        barGrad.addColorStop(0.5, "#ef4444"); // mid red
        barGrad.addColorStop(1, "#991b1b"); // dark red at top

        const radius = Math.min(2, barW / 2);
        ctx.fillStyle = barGrad;
        ctx.beginPath();
        ctx.roundRect(x, h - barH, barW, barH, [radius, radius, 0, 0]);
        ctx.fill();

        // Floating peak dot — dark red
        if (peaksRef.current[i] > 0.05) {
          const peakY = h - Math.floor(peaksRef.current[i] * h) - 2;
          ctx.fillStyle = "#7f1d1d";
          ctx.fillRect(x, peakY, barW, 2);
        }

        // Empty track behind bar
        if (barH < h) {
          ctx.fillStyle = "rgba(0,0,0,0.04)";
          ctx.beginPath();
          ctx.roundRect(x, 0, barW, h - barH, [radius, radius, 0, 0]);
          ctx.fill();
        }
      }

      // Subtle grid lines
      ctx.strokeStyle = "rgba(0,0,0,0.04)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = Math.floor(h * (i / 4));
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const dpr = devicePixelRatio || 1;
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.scale(dpr, dpr);
      }
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, []);

  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true,
        video: false,
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);
      analyserRef.current = analyser;
      setMicLive(true);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const norm = Math.min(1, avg / 100);
        targetLevelRef.current = norm > 0.05 ? 0.2 + norm * 0.8 : 0;
        setLevel(norm);
        if (norm > peakHold) {
          setPeakHold(norm);
          if (peakTimerRef.current) clearTimeout(peakTimerRef.current);
          peakTimerRef.current = setTimeout(() => setPeakHold(0), 1500);
        }
        animRef.current = requestAnimationFrame(tick);
      };
      animRef.current = requestAnimationFrame(tick);
    } catch (e) { console.error("Mic error:", e); }
  };

  const stopMic = () => {
    cancelAnimationFrame(animRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    targetLevelRef.current = 0;
    levelsRef.current = new Array(BAR_COUNT).fill(0);
    peaksRef.current = new Array(BAR_COUNT).fill(0);
    setMicLive(false);
    setLevel(0);
    setPeakHold(0);
  };

  useEffect(() => () => stopMic(), []);

  const accentBorder = micLive ? "rgba(239,68,68,0.3)" : "var(--border-primary)";

  // dBFS conversion for display
  const db = micLive && level > 0 ? Math.round(20 * Math.log10(level)) : null;
  const peakDb = peakHold > 0 ? Math.round(20 * Math.log10(Math.max(peakHold, 0.001))) : null;

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      background: "var(--bg-secondary)",
      borderRadius: 18,
      border: micLive ? "1px solid rgba(239,68,68,0.35)" : "1px solid var(--border-primary)",
      overflow: "hidden",
      height: "100%",
      transition: "border-color 0.3s ease, box-shadow 0.3s ease",
      boxShadow: micLive ? "0 0 0 1px rgba(239,68,68,0.15), 0 4px 24px rgba(239,68,68,0.12)" : "var(--shadow-sm)",
    }}>

      {/* Top accent stripe — thicker, more intentional */}
      <div style={{
        height: micLive ? 4 : 3, flexShrink: 0,
        background: micLive
          ? "linear-gradient(90deg, #ef4444, #f87171)"
          : "var(--border-primary)",
        boxShadow: micLive ? "0 0 16px rgba(239,68,68,0.5)" : "none",
        transition: "all 0.3s ease",
      }} />

      {/* Channel strip header */}
      <div style={{ padding: "12px 14px 8px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          {/* Mic icon — channel strip style */}
          <div style={{
            width: 26, height: 26, borderRadius: 7,
            background: micLive ? "rgba(239,68,68,0.12)" : "var(--bg-tertiary)",
            border: `1px solid ${micLive ? "rgba(239,68,68,0.3)" : "var(--border-primary)"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.2s",
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={micLive ? "#ef4444" : "var(--text-tertiary)"} strokeWidth="2" strokeLinecap="round">
              <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
              <path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: micLive ? "#ef4444" : "var(--text-tertiary)", textTransform: "uppercase" as const }}>
              {micLive ? "ON AIR" : "MIC"}
            </div>
          </div>
        </div>

        {/* Live indicator badge */}
        <div style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "3px 8px", borderRadius: 20,
          background: micLive ? "rgba(239,68,68,0.08)" : "var(--bg-tertiary)",
          border: `1px solid ${micLive ? "rgba(239,68,68,0.25)" : "var(--border-primary)"}`,
          transition: "all 0.2s",
        }}>
          <div style={{
            width: 5, height: 5, borderRadius: "50%",
            background: micLive ? "#ef4444" : "var(--text-tertiary)",
            boxShadow: micLive ? "0 0 6px #ef4444" : "none",
            animation: micLive ? "mic-blink 1.2s ease-in-out infinite" : "none",
          }} />
          <span style={{ fontSize: 8, fontWeight: 700, color: micLive ? "#ef4444" : "var(--text-tertiary)", letterSpacing: "0.1em" }}>
            {micLive ? "LIVE" : "READY"}
          </span>
        </div>
      </div>

      {/* Status text */}
      <div style={{ padding: "0 14px 10px", flexShrink: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: micLive ? 600 : 400,
          color: micLive ? "var(--text-primary)" : "var(--text-tertiary)",
          fontStyle: micLive ? "normal" : "italic",
          letterSpacing: "-0.02em",
          animation: micLive ? "track-load 0.3s ease both" : "none",
        }}>
          {micLive ? "Live Microphone" : "Your mic is ready"}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>
          {micLive ? "Broadcasting now" : "Click when you want to go live"}
        </div>
      </div>

      {/* dBFS meters — professional channel strip readout */}
      <div style={{ padding: "0 14px 8px", display: "flex", gap: 12, alignItems: "flex-end", flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 7, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.14em", textTransform: "uppercase" as const, marginBottom: 4 }}>INPUT</div>
          {/* Segmented level bar */}
          <div style={{ display: "flex", gap: 1.5, height: 8, alignItems: "flex-end" }}>
            {Array.from({ length: 20 }).map((_, i) => {
              const threshold = i / 20;
              const active = micLive && level > threshold;
              const color = i < 14 ? "var(--accent-green)" : i < 17 ? "var(--accent-amber)" : "#ef4444";
              return (
                <div key={i} style={{
                  flex: 1, height: active ? "100%" : "30%",
                  borderRadius: 1, background: active ? color : "var(--bg-tertiary)",
                  transition: "height 0.05s, background 0.05s",
                }} />
              );
            })}
          </div>
        </div>
        <div style={{ textAlign: "right" as const, flexShrink: 0 }}>
          <div style={{ fontSize: 7, color: "var(--text-tertiary)", letterSpacing: "0.1em", marginBottom: 4 }}>PEAK</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, fontWeight: 500, color: (peakDb !== null && peakDb > -3) ? "#ef4444" : "var(--text-secondary)", letterSpacing: "-0.02em" }}>
            {peakDb !== null ? `${peakDb} dB` : "—"}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ margin: "0 14px 8px", height: 2, background: "var(--bg-tertiary)", borderRadius: 1, overflow: "hidden", flexShrink: 0 }}>
        <div style={{ height: "100%", width: micLive ? Math.round(level * 100) + "%" : "0%", background: level > 0.85 ? "#ef4444" : "var(--accent-green)", borderRadius: 1, transition: "width 0.05s linear" }} />
      </div>

      {/* Canvas VU */}
      <div style={{ margin: "0 14px 8px", flex: 1, minHeight: 40, borderRadius: 10, overflow: "hidden", background: "var(--bg-tertiary)" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      </div>

      {/* Auto-duck toggle */}
      {/* Studio Sound */}
      <div style={{ padding: "0 14px 4px" }}>
        <button onClick={() => setShowProcessing((p: boolean) => !p)} style={{
          width: "100%", padding: "5px 10px", borderRadius: 8, border: "none",
          background: showProcessing ? "rgba(56,189,248,0.12)" : "var(--bg-tertiary)",
          color: showProcessing ? "var(--accent-cyan)" : "var(--text-tertiary)",
          fontSize: 9, fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em",
          outline: showProcessing ? "1px solid rgba(56,189,248,0.3)" : "1px solid var(--border-primary)",
          transition: "all 0.15s", marginBottom: 4,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
        }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          STUDIO SOUND {showProcessing ? "ON" : "OFF"}
        </button>
        {showProcessing && streamRef.current && (
          <div style={{ marginBottom: 6, padding: "8px 10px", borderRadius: 9, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
            <AudioProcessorPanel stream={streamRef.current} compact onLevel={(lv) => setLevel(lv)} />
          </div>
        )}
      </div>
      <DuckToggle />

      {/* Controls */}
      <div style={{ padding: "8px 14px 14px", borderTop: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", display: "flex", gap: 7, flexShrink: 0 }}>
        {/* Stop/cut button */}
        <button
          onClick={micLive ? stopMic : () => {}}
          disabled={!micLive}
          title="Cut mic"
          style={{
            width: 36, height: 36, borderRadius: 9,
            background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)",
            color: "var(--text-tertiary)", cursor: micLive ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: micLive ? 1 : 0.35, transition: "all 0.15s",
          }}
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor"><rect width="9" height="9" rx="1.5"/></svg>
        </button>

        {/* Main live button */}
        <button
          onClick={micLive ? stopMic : startMic}
          style={{
            flex: 1, height: 36, borderRadius: 9,
            background: micLive ? "linear-gradient(135deg, #ef4444, #dc2626)" : "rgba(239,68,68,0.1)",
            border: micLive ? "none" : "1px solid rgba(239,68,68,0.25)",
            color: micLive ? "#fff" : "#ef4444",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            fontFamily: "'Syne', sans-serif", fontSize: 11, fontWeight: 800, letterSpacing: "0.08em",
            boxShadow: micLive ? "0 2px 16px rgba(239,68,68,0.4)" : "none",
            transition: "all 0.2s ease",
            animation: micLive ? "mic-glow 1.8s ease-in-out infinite" : "none",
          }}
        >
          <div style={{
            width: 6, height: 6, borderRadius: "50%",
            background: micLive ? "rgba(255,255,255,0.9)" : "#ef4444",
            boxShadow: micLive ? "0 0 6px rgba(255,255,255,0.6)" : "none",
            animation: micLive ? "mic-blink 1.2s ease-in-out infinite" : "none",
          }} />
          {micLive ? "CUT" : "LIVE MIC"}
        </button>
      </div>

      <style>{`
        @keyframes mic-blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes mic-glow { 0%,100%{box-shadow:0 2px 16px rgba(239,68,68,0.4)} 50%{box-shadow:0 2px 28px rgba(239,68,68,0.65)} }
      `}</style>
    </div>
  );
}
