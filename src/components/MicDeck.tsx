import { useState, useEffect, useRef, useCallback } from "react";
import VUMeter from "./VUMeter";
import GraphicEQ, { EQ_DEFAULT, EQ_FREQS } from "./GraphicEQ";
import { query, execute } from "../db/client";

// Inline stub — replace with full ProcessingPanel integration when ready
function AudioProcessorPanel({ stream, compact, onLevel }: { stream: MediaStream; compact?: boolean; onLevel?: (level: number) => void }) {
  return (
    <div style={{ fontSize: 10, color: "var(--text-tertiary)", padding: "2px 0" }}>
      Studio Sound active
    </div>
  );
}

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
          width: "100%", padding: "5px 10px", borderRadius: 0,
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
  const streamRef    = useRef<MediaStream | null>(null);
  const analyserRef  = useRef<AnalyserNode | null>(null);
  const audioCtxRef  = useRef<AudioContext | null>(null);
  const eqFiltersRef = useRef<BiquadFilterNode[]>([]);
  const gainNodeRef  = useRef<GainNode | null>(null);
  const animRef      = useRef<number>(0);

  // ── EQ state ─────────────────────────────────────────────────
  const [eqOpen,  setEqOpen]  = useState(false);
  const [eqBands, setEqBands] = useState<number[]>(EQ_DEFAULT);
  const eqActive = eqBands.some(g => Math.abs(g) > 0.05);

  // Load EQ from DB
  useEffect(() => {
    query<{ value: string }>("SELECT value FROM station_config_kv WHERE key='eq_deck_mic'", [])
      .then(rows => { if (rows[0]?.value) { try { setEqBands(JSON.parse(rows[0].value)); } catch {} } })
      .catch(() => {});
  }, []);

  // Apply EQ gains to Web Audio filter nodes whenever bands change
  useEffect(() => {
    eqFiltersRef.current.forEach((f, i) => {
      if (f) f.gain.setTargetAtTime(eqBands[i] ?? 0, f.context.currentTime, 0.01);
    });
  }, [eqBands]);

  const handleEqChange = useCallback((bands: number[]) => {
    setEqBands(bands);
    execute("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('eq_deck_mic',?)",
      [JSON.stringify(bands)]).catch(() => {});
    // Also send to native engine for actual broadcast path
    try { const w = window as any; if (w.ether?.audio?.setEq) w.ether.audio.setEq("mic", bands); } catch {}
  }, []);

  // ── Build Web Audio EQ filter chain ──────────────────────────
  const buildEqChain = (ctx: AudioContext): BiquadFilterNode[] => {
    const filters: BiquadFilterNode[] = EQ_FREQS.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.frequency.value = freq;
      f.gain.value      = eqBands[i] ?? 0;
      f.Q.value         = 1.4;
      // lowest band = lowshelf, highest = highshelf, rest = peaking
      f.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
      return f;
    });
    // Chain: filters[0] → filters[1] → ... → filters[9]
    for (let i = 0; i < filters.length - 1; i++) {
      filters[i].connect(filters[i + 1]);
    }
    return filters;
  };

  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: inputDeviceId ? { deviceId: { exact: inputDeviceId } } : true,
        video: false,
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source  = ctx.createMediaStreamSource(stream);
      const filters = buildEqChain(ctx);
      eqFiltersRef.current = filters;

      const gainNode = ctx.createGain();
      gainNode.gain.value = gainNodeRef.current?.gain.value ?? 1;
      gainNodeRef.current = gainNode;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.55;

      // source → EQ chain → gainNode → analyser → destination
      source.connect(filters[0]);
      filters[filters.length - 1].connect(gainNode);
      gainNode.connect(analyser);
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      setMicLive(true);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const norm = Math.min(1, avg / 100);
        setLevel(norm > 0.05 ? 0.2 + norm * 0.8 : 0);
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
    eqFiltersRef.current = [];
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setMicLive(false);
    setLevel(0);
  };

  // Listen for volume changes dispatched from the ConsoleStrip fader
  useEffect(() => {
    const handler = (e: Event) => {
      const { volume } = (e as CustomEvent).detail as { slot: string; volume: number };
      if (gainNodeRef.current) gainNodeRef.current.gain.value = volume;
    };
    window.addEventListener("ether:mic-volume", handler);
    return () => window.removeEventListener("ether:mic-volume", handler);
  }, []);

  useEffect(() => () => stopMic(), []);

  const accentBorder = micLive ? "rgba(239,68,68,0.3)" : "var(--border-primary)";

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      background: "var(--bg-secondary)",
      borderRadius: 0,
      border: "none",
      overflow: "hidden",
      height: "100%",
      transition: "box-shadow 0.3s ease",
      boxShadow: micLive ? "0 0 12px rgba(239,68,68,0.18)" : "none",
    }}>

      {/* Top accent stripe */}
      <div style={{
        height: micLive ? 3 : 2, flexShrink: 0,
        background: micLive
          ? "linear-gradient(90deg, #ef4444, #f87171)"
          : "#883040",
        boxShadow: micLive ? "0 0 12px rgba(239,68,68,0.45)" : "none",
        transition: "all 0.3s ease",
      }} />

      {/* Channel strip header */}
      <div style={{ padding: "12px 14px 8px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flex: 1 }}>
          {/* Mic icon — channel strip style */}
          <div style={{
            width: 26, height: 26, borderRadius: 0,
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

        {/* EQ toggle button */}
        <button
          onClick={() => setEqOpen(o => !o)}
          title="Mono EQ"
          style={{
            width: 28, height: 28, borderRadius: 0, flexShrink: 0,
            background: eqOpen ? "rgba(96,64,192,0.18)" : "var(--bg-tertiary)",
            border: `1px solid ${eqOpen ? "#6040c0" : "var(--border-primary)"}`,
            color: eqOpen ? "#8060e0" : "var(--text-tertiary)",
            cursor: "pointer", display: "flex", alignItems: "center",
            justifyContent: "center", flexDirection: "column" as const, gap: 1,
            transition: "all 0.15s", position: "relative" as const,
          }}
        >
          <span style={{ fontSize: 7, fontWeight: 800, letterSpacing: "0.04em" }}>EQ</span>
          {eqActive && (
            <div style={{
              position: "absolute", top: 2, right: 2,
              width: 3, height: 3, borderRadius: "50%",
              background: "#c07820", boxShadow: "0 0 3px #c07820",
            }} />
          )}
        </button>

        {/* Pop-out button */}
        <button
          title="Pop out to separate window"
          onClick={() => (window as any).ether?.invoke("window:popout", "mic")}
          style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "2px 3px", display: "flex", alignItems: "center", transition: "color 0.12s", borderRadius: 0, flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = "#6080c0"}
          onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = "var(--text-tertiary)"}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </button>

        {/* Live indicator badge */}
        <div style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: micLive ? "6px 14px" : "3px 8px", borderRadius: 0,
          background: micLive ? "#cc2020" : "var(--bg-tertiary)",
          border: `1px solid ${micLive ? "#cc2020" : "var(--border-primary)"}`,
          boxShadow: micLive ? "0 0 12px rgba(204,32,32,0.5)" : "none",
          transition: "all 0.2s",
        }}>
          <div style={{
            width: micLive ? 7 : 5, height: micLive ? 7 : 5, borderRadius: "50%",
            background: micLive ? "#fff" : "var(--text-tertiary)",
            boxShadow: micLive ? "0 0 6px rgba(255,255,255,0.8)" : "none",
            animation: micLive ? "mic-blink 1.2s ease-in-out infinite" : "none",
            flexShrink: 0,
          }} />
          <span style={{ fontSize: micLive ? 11 : 8, fontWeight: 700, color: micLive ? "#fff" : "var(--text-tertiary)", letterSpacing: "0.12em" }}>
            {micLive ? "MIC ON AIR" : "READY"}
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

      {/* VU Meter */}
      <div style={{ height: 80, flexShrink: 0, margin: "0 14px 8px", overflow: "hidden" }}>
        <VUMeter deckId="mic" isPlaying={micLive} hasTrack={micLive} externalLevel={level} />
      </div>

      {/* Auto-duck toggle */}
      {/* Studio Sound */}
      <div style={{ padding: "0 14px 4px" }}>
        <button onClick={() => setShowProcessing((p: boolean) => !p)} style={{
          width: "100%", padding: "5px 10px", borderRadius: 0, border: "none",
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
          <div style={{ marginBottom: 6, padding: "8px 10px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
            <AudioProcessorPanel stream={streamRef.current} compact onLevel={(lv) => setLevel(lv)} />
          </div>
        )}
      </div>
      <DuckToggle />

      {/* EQ panel — slides up */}
      <div style={{
        maxHeight: eqOpen ? 130 : 0,
        overflow: "hidden",
        transition: "max-height 0.25s cubic-bezier(0.4,0,0.2,1)",
        flexShrink: 0,
      }}>
        <GraphicEQ bands={eqBands} onChange={handleEqChange} label="MONO EQ" />
      </div>

      {/* Controls */}
      <div style={{ padding: "8px 14px 14px", borderTop: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", display: "flex", gap: 7, flexShrink: 0 }}>
        {/* Stop/cut button */}
        <button
          onClick={micLive ? stopMic : () => {}}
          disabled={!micLive}
          title="Cut mic"
          style={{
            width: 40, height: 44, borderRadius: 0,
            background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)",
            color: "var(--text-tertiary)", cursor: micLive ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: micLive ? 1 : 0.35, transition: "all 0.15s",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 9 9" fill="currentColor"><rect width="9" height="9" rx="1.5"/></svg>
        </button>

        {/* Main live button */}
        <button
          onClick={micLive ? stopMic : startMic}
          style={{
            flex: 1, height: 44, borderRadius: 0,
            background: micLive ? "linear-gradient(135deg, #ef4444, #dc2626)" : "rgba(239,68,68,0.1)",
            border: micLive ? "none" : "1px solid rgba(239,68,68,0.25)",
            color: micLive ? "#fff" : "#ef4444",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 800, letterSpacing: "0.12em",
            boxShadow: micLive ? "0 2px 16px rgba(239,68,68,0.4)" : "none",
            transition: "all 0.2s ease",
            animation: micLive ? "mic-glow 1.8s ease-in-out infinite" : "none",
            whiteSpace: "nowrap",
          }}
        >
          <div style={{
            width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
            background: micLive ? "rgba(255,255,255,0.9)" : "#ef4444",
            boxShadow: micLive ? "0 0 6px rgba(255,255,255,0.6)" : "none",
            animation: micLive ? "mic-blink 1.2s ease-in-out infinite" : "none",
          }} />
          {micLive ? "CUT MIC" : "LIVE MIC"}
        </button>
      </div>

      <style>{`
        @keyframes mic-blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes mic-glow { 0%,100%{box-shadow:0 2px 16px rgba(239,68,68,0.4)} 50%{box-shadow:0 2px 28px rgba(239,68,68,0.65)} }
      `}</style>
    </div>
  );
}
