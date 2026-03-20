import React from "react";
import { useState, useEffect, useRef } from "react";

const BAR_COUNT = 32;
const PEAK_HOLD_MS = 1200;

interface Props {
  inputDeviceId?: string;
  onDragStart?: (e: React.MouseEvent) => void;
}

export default function MicDeck({ inputDeviceId, onDragStart }: Props) {
  const [micLive, setMicLive] = useState(false);
  const [level, setLevel] = useState(0);
  const [peakHold, setPeakHold] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
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
    targetLevelRef.current = 0;
    levelsRef.current = new Array(BAR_COUNT).fill(0);
    peaksRef.current = new Array(BAR_COUNT).fill(0);
    setMicLive(false);
    setLevel(0);
    setPeakHold(0);
  };

  useEffect(() => () => stopMic(), []);

  const accentBorder = micLive ? "rgba(239,68,68,0.3)" : "var(--border-primary)";

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      background: "var(--bg-secondary)",
      borderRadius: 18,
      border: `1px solid ${accentBorder}`,
      overflow: "hidden",
      height: "100%",
      transition: "border-color 0.3s ease",
      boxShadow: micLive ? "0 0 20px rgba(239,68,68,0.15)" : "none",
    }}>
      {/* Top accent bar */}
      <div style={{
        height: 3, flexShrink: 0,
        background: micLive ? "#ef4444" : "rgba(100,116,139,0.2)",
        boxShadow: micLive ? "0 0 12px rgba(239,68,68,0.6)" : "none",
        transition: "all 0.3s ease",
      }} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px 6px", flexShrink: 0 }}>
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
            background: micLive ? "rgba(239,68,68,0.15)" : "var(--bg-tertiary)",
            border: `1px solid ${micLive ? "rgba(239,68,68,0.4)" : "var(--border-primary)"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, flexShrink: 0, transition: "all 0.3s ease",
          }}>🎙</div>
          <span style={{ fontSize: 9, fontWeight: 700, color: micLive ? "#ef4444" : "var(--text-tertiary)", letterSpacing: "0.14em", textTransform: "uppercase" as const }}>
            {micLive ? "ON AIR" : "MIC"}
          </span>
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20,
          background: micLive ? "rgba(239,68,68,0.1)" : "var(--bg-tertiary)",
          border: `1px solid ${micLive ? "rgba(239,68,68,0.3)" : "var(--border-primary)"}`,
        }}>
          <div style={{
            width: 5, height: 5, borderRadius: "50%",
            background: micLive ? "#ef4444" : "var(--text-tertiary)",
            boxShadow: micLive ? "0 0 6px #ef4444" : "none",
            animation: micLive ? "mic-blink 1.2s ease-in-out infinite" : "none",
          }} />
          <span style={{ fontSize: 9, fontWeight: 700, color: micLive ? "#ef4444" : "var(--text-tertiary)", letterSpacing: "0.12em", textTransform: "uppercase" as const }}>
            {micLive ? "LIVE" : "READY"}
          </span>
        </div>
      </div>

      {/* Label */}
      <div style={{ padding: "2px 16px 10px", flexShrink: 0 }}>
        <div style={{ fontSize: 14, fontWeight: micLive ? 600 : 400, color: micLive ? "var(--text-primary)" : "var(--text-tertiary)", fontStyle: micLive ? "normal" : "italic", letterSpacing: "-0.025em", lineHeight: 1.3 }}>
          {micLive ? "Live Microphone" : "No mic active"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 3, minHeight: 15 }}>
          {micLive ? "Input monitoring" : "Click to go live"}
        </div>
      </div>

      {/* Level display */}
      <div style={{ padding: "0 16px 8px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 8, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.14em", textTransform: "uppercase" as const, marginBottom: 3 }}>LEVEL</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 40, fontWeight: 300, letterSpacing: "-0.04em", lineHeight: 1, color: micLive ? (level > 0.85 ? "#ef4444" : "#ef4444") : "var(--text-tertiary)", transition: "color 0.1s" }}>
            {micLive ? Math.round(level * 100) + "%" : "—"}
          </div>
        </div>
        <div style={{ textAlign: "right" as const, paddingBottom: 4 }}>
          <div style={{ fontSize: 8, color: "var(--text-tertiary)", letterSpacing: "0.14em", textTransform: "uppercase" as const, marginBottom: 3 }}>PEAK</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 400, color: peakHold > 0.85 ? "#ef4444" : "var(--text-secondary)" }}>
            {micLive ? Math.round(peakHold * 100) + "%" : "——"}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ margin: "0 16px 10px", height: 3, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden", flexShrink: 0 }}>
        <div style={{ height: "100%", width: micLive ? Math.round(level * 100) + "%" : "0%", background: "#ef4444", borderRadius: 2, transition: "width 0.05s linear", boxShadow: micLive ? "0 0 6px #ef4444" : "none" }} />
      </div>

      {/* Canvas VU meter */}
      <div style={{ margin: "0 16px 10px", flex: 1, minHeight: 44, position: "relative", borderRadius: 10, overflow: "hidden", background: "var(--bg-tertiary)" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", borderRadius: 8 }} />
      </div>

      {/* Controls */}
      <div style={{ padding: "10px 16px 14px", borderTop: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <button onClick={micLive ? stopMic : () => {}} style={{ width: 36, height: 36, borderRadius: 10, background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)", color: "var(--text-tertiary)", cursor: micLive ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, flexShrink: 0, opacity: micLive ? 1 : 0.4 }} title="Cut mic">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="0" width="10" height="10" rx="1.5"/></svg>
        </button>
        <button onClick={micLive ? stopMic : startMic} style={{
          flex: 1, height: 36, borderRadius: 10,
          background: micLive ? "#ef4444" : "rgba(239,68,68,0.12)",
          border: micLive ? "none" : "1px solid rgba(239,68,68,0.3)",
          color: micLive ? "#fff" : "#ef4444",
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          fontFamily: "'Syne', sans-serif", fontSize: 11, fontWeight: 800, letterSpacing: "0.06em",
          whiteSpace: "nowrap" as const,
          boxShadow: micLive ? "0 0 20px rgba(239,68,68,0.4)" : "none",
          transition: "all 0.2s ease",
          animation: micLive ? "mic-glow 1.8s ease-in-out infinite" : "none",
          overflow: "hidden",
        }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: micLive ? "rgba(255,255,255,0.8)" : "#ef4444", boxShadow: micLive ? "0 0 6px rgba(255,255,255,0.6)" : "none", animation: micLive ? "mic-blink 1.2s ease-in-out infinite" : "none" }} />
          {micLive ? "CUT" : "LIVE MIC"}
        </button>
      </div>

      <style>{`
        @keyframes mic-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes mic-glow { 0%,100%{box-shadow:0 0 20px rgba(239,68,68,0.4)} 50%{box-shadow:0 0 32px rgba(239,68,68,0.7)} }
      `}</style>
    </div>
  );
}
