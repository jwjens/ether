import { useState, useEffect, useRef, useCallback } from "react";
import { execute, query, queryOne } from "../db/client";
import { convertFileSrc } from "@tauri-apps/api/core";

interface Song {
  id: number;
  title: string;
  artist_name: string | null;
  file_path: string;
  duration_ms: number;
  cue_in?: number;      // seconds
  cue_out?: number;     // seconds
  intro_end?: number;   // seconds
  outro_start?: number; // seconds
}

interface Props {
  song?: Song | null;
  onClose?: () => void;
  onSaved?: (song: Song) => void;
}

const HANDLE_W = 8;
const COLORS = {
  cueIn:     "#22d3ee",
  cueOut:    "#f87171",
  introEnd:  "#34d399",
  outroStart:"#fb923c",
};

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2,"0")}.${ms}`;
}

export default function TrackEditor({ song, onClose, onSaved }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number>(0);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [playStartTime, setPlayStartTime] = useState(0);
  const [playStartOffset, setPlayStartOffset] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState(1); // 1 = full, 4 = 4x zoom
  const [viewOffset, setViewOffset] = useState(0); // seconds from start visible at left

  // Cue points in seconds
  const [cueIn, setCueIn] = useState(0);
  const [cueOut, setCueOut] = useState(0);
  const [introEnd, setIntroEnd] = useState(0);
  const [outroStart, setOutroStart] = useState(0);

  const [dragging, setDragging] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [waveformData, setWaveformData] = useState<Float32Array | null>(null);

  const durRef = useRef(0);
  const cueInRef = useRef(0);
  const cueOutRef = useRef(0);
  const introEndRef = useRef(0);
  const outroStartRef = useRef(0);
  const zoomRef = useRef(1);
  const viewOffsetRef = useRef(0);
  const playheadRef = useRef(0);

  // Keep refs in sync
  useEffect(() => { durRef.current = duration; }, [duration]);
  useEffect(() => { cueInRef.current = cueIn; }, [cueIn]);
  useEffect(() => { cueOutRef.current = cueOut; }, [cueOut]);
  useEffect(() => { introEndRef.current = introEnd; }, [introEnd]);
  useEffect(() => { outroStartRef.current = outroStart; }, [outroStart]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { viewOffsetRef.current = viewOffset; }, [viewOffset]);
  useEffect(() => { playheadRef.current = playhead; }, [playhead]);

  // Load audio on song change
  useEffect(() => {
    if (!song?.file_path) return;
    setLoading(true);
    setLoadError("");
    setPlaying(false);
    setPlayhead(0);
    setZoom(1);
    setViewOffset(0);

    // Load existing cue points
    setCueIn(song.cue_in || 0);
    setCueOut(song.cue_out || 0);
    setIntroEnd(song.intro_end || 0);
    setOutroStart(song.outro_start || 0);

    const load = async () => {
      try {
        const url = convertFileSrc(song.file_path);
        const res = await fetch(url);
        const arrayBuf = await res.arrayBuffer();
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const buf = await ctx.decodeAudioData(arrayBuf);
        audioBufferRef.current = buf;
        const dur = buf.duration;
        setDuration(dur);
        durRef.current = dur;

        // Set defaults if no cue points saved
        if (!song.cue_out || song.cue_out === 0) setCueOut(dur);
        if (!song.outro_start || song.outro_start === 0) setOutroStart(dur * 0.9);

        // Build waveform peaks
        const ch = buf.getChannelData(0);
        const peaks = 800;
        const blockSize = Math.floor(ch.length / peaks);
        const data = new Float32Array(peaks);
        for (let i = 0; i < peaks; i++) {
          let max = 0;
          const start = i * blockSize;
          for (let j = 0; j < blockSize; j++) {
            const v = Math.abs(ch[start + j] || 0);
            if (v > max) max = v;
          }
          data[i] = max;
        }
        setWaveformData(data);
        setLoading(false);
      } catch (e) {
        setLoadError("Could not load audio: " + String(e));
        setLoading(false);
      }
    };
    load();

    return () => {
      sourceRef.current?.stop();
      audioCtxRef.current?.close();
    };
  }, [song?.id]);

  // Playhead animation
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const elapsed = ctx.currentTime - playStartTime;
      const pos = playStartOffset + elapsed;
      const dur = durRef.current;
      if (pos >= (cueOutRef.current || dur)) {
        setPlaying(false);
        setPlayhead(cueOutRef.current || dur);
        return;
      }
      setPlayhead(pos);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, playStartTime, playStartOffset]);

  const play = useCallback((fromSec?: number) => {
    const ctx = audioCtxRef.current;
    const buf = audioBufferRef.current;
    if (!ctx || !buf) return;
    sourceRef.current?.stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const offset = fromSec !== undefined ? fromSec : (cueInRef.current || 0);
    src.start(0, offset);
    src.onended = () => setPlaying(false);
    sourceRef.current = src;
    setPlayStartTime(ctx.currentTime);
    setPlayStartOffset(offset);
    setPlaying(true);
  }, []);

  const pause = useCallback(() => {
    sourceRef.current?.stop();
    setPlaying(false);
  }, []);

  const togglePlay = () => playing ? pause() : play(playheadRef.current);

  // Canvas drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveformData) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const dur = durRef.current;
    if (dur <= 0) return;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#0a0a14";
    ctx.fillRect(0, 0, w, h);

    // Visible window
    const visibleDur = dur / zoomRef.current;
    const viewStart = viewOffsetRef.current;
    const viewEnd = viewStart + visibleDur;

    const secToX = (sec: number) => ((sec - viewStart) / visibleDur) * w;
    const xToSec = (x: number) => viewStart + (x / w) * visibleDur;

    // Region fills
    const cI = secToX(cueInRef.current);
    const cO = secToX(cueOutRef.current || dur);
    const iE = secToX(introEndRef.current);
    const oS = secToX(outroStartRef.current || dur);

    // Dead zones (before cue in, after cue out) — dark
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    if (cI > 0) ctx.fillRect(0, 0, cI, h);
    if (cO < w) ctx.fillRect(cO, 0, w - cO, h);

    // Intro zone (cue in → intro end) — cyan tint
    if (introEndRef.current > cueInRef.current) {
      ctx.fillStyle = "rgba(34,211,238,0.06)";
      ctx.fillRect(Math.max(0, cI), 0, Math.max(0, iE - cI), h);
    }

    // Outro zone (outro start → cue out) — orange tint
    if (outroStartRef.current > 0 && outroStartRef.current < (cueOutRef.current || dur)) {
      ctx.fillStyle = "rgba(251,146,60,0.06)";
      ctx.fillRect(Math.max(0, oS), 0, Math.max(0, cO - oS), h);
    }

    // Waveform bars
    const peaks = waveformData.length;
    const barW = Math.max(1, w / peaks);
    const mid = h / 2;

    for (let i = 0; i < peaks; i++) {
      const sec = viewStart + (i / peaks) * visibleDur;
      const barSec = (i / peaks) * dur;
      const x = (i / peaks) * w;

      // Color by zone
      const inCue = barSec >= cueInRef.current && barSec <= (cueOutRef.current || dur);
      const inIntro = barSec >= cueInRef.current && barSec <= introEndRef.current;
      const inOutro = barSec >= outroStartRef.current && barSec <= (cueOutRef.current || dur);

      if (!inCue) {
        ctx.fillStyle = "rgba(100,116,139,0.25)";
      } else if (inIntro) {
        ctx.fillStyle = "#22d3ee";
        ctx.globalAlpha = 0.7;
      } else if (inOutro) {
        ctx.fillStyle = "#fb923c";
        ctx.globalAlpha = 0.8;
      } else {
        ctx.fillStyle = "#34d399";
        ctx.globalAlpha = 0.85;
      }

      const amp = waveformData[i] * mid * 0.85;
      ctx.fillRect(x, mid - amp, barW, amp * 2);
      ctx.globalAlpha = 1;
    }

    // Grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    const gridInterval = visibleDur > 60 ? 10 : visibleDur > 20 ? 5 : visibleDur > 5 ? 1 : 0.5;
    const firstGrid = Math.ceil(viewStart / gridInterval) * gridInterval;
    for (let t = firstGrid; t <= viewEnd; t += gridInterval) {
      const x = secToX(t);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }

    // Time labels
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "10px 'DM Mono', monospace";
    ctx.textAlign = "left";
    for (let t = firstGrid; t <= viewEnd; t += gridInterval) {
      const x = secToX(t);
      if (x > 20 && x < w - 20) ctx.fillText(fmt(t), x + 3, h - 6);
    }

    // Cue handles
    const drawHandle = (sec: number, color: string, label: string, top: boolean) => {
      const x = secToX(sec);
      if (x < -10 || x > w + 10) return;

      // Vertical line
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.setLineDash([]);

      // Handle tab
      const tabH = 18;
      const tabY = top ? 0 : h - tabH;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x - HANDLE_W / 2, tabY, HANDLE_W * 3, tabH, 3);
      ctx.fill();

      // Label
      ctx.fillStyle = "#000";
      ctx.font = "bold 8px 'Inter', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(label, x + 4, tabY + 12);
    };

    drawHandle(cueInRef.current, COLORS.cueIn, "IN", false);
    drawHandle(cueOutRef.current || dur, COLORS.cueOut, "OUT", false);
    drawHandle(introEndRef.current, COLORS.introEnd, "INTRO", true);
    drawHandle(outroStartRef.current || dur, COLORS.outroStart, "OUTRO", true);

    // Playhead
    const phX = secToX(playheadRef.current);
    if (phX >= 0 && phX <= w) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, h); ctx.stroke();
      ctx.globalAlpha = 1;
      // Triangle head
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(phX - 5, 0); ctx.lineTo(phX + 5, 0); ctx.lineTo(phX, 8);
      ctx.fill();
    }

  }, [waveformData, playing, playhead, cueIn, cueOut, introEnd, outroStart, zoom, viewOffset, duration]);

  // Resize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const dpr = devicePixelRatio || 1;
        const { width, height } = e.contentRect;
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

  // Mouse interaction
  const getHandleAt = (x: number, canvasW: number): string | null => {
    const dur = durRef.current;
    const visibleDur = dur / zoomRef.current;
    const secToX = (s: number) => ((s - viewOffsetRef.current) / visibleDur) * canvasW;
    const handles = [
      { name: "cueIn", sec: cueInRef.current },
      { name: "cueOut", sec: cueOutRef.current || dur },
      { name: "introEnd", sec: introEndRef.current },
      { name: "outroStart", sec: outroStartRef.current || dur },
    ];
    for (const h of handles) {
      if (Math.abs(x - secToX(h.sec)) < 10) return h.name;
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const handle = getHandleAt(x, rect.width);
    if (handle) {
      setDragging(handle);
    } else {
      // Click to seek
      const dur = durRef.current;
      const visibleDur = dur / zoomRef.current;
      const sec = viewOffsetRef.current + (x / rect.width) * visibleDur;
      const clamped = Math.max(0, Math.min(dur, sec));
      setPlayhead(clamped);
      if (playing) play(clamped);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dur = durRef.current;
    const visibleDur = dur / zoomRef.current;
    const sec = Math.max(0, Math.min(dur, viewOffsetRef.current + (x / rect.width) * visibleDur));
    if (dragging === "cueIn") setCueIn(Math.min(sec, cueOutRef.current - 0.5));
    if (dragging === "cueOut") setCueOut(Math.max(sec, cueInRef.current + 0.5));
    if (dragging === "introEnd") setIntroEnd(Math.min(sec, outroStartRef.current - 0.5));
    if (dragging === "outroStart") setOutroStart(Math.max(sec, introEndRef.current + 0.5));
  };

  const handleMouseUp = () => setDragging(null);

  // Zoom / scroll
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const dur = durRef.current;
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const newZoom = Math.max(1, Math.min(16, zoomRef.current * (e.deltaY < 0 ? 1.2 : 0.8)));
      setZoom(newZoom);
      const visibleDur = dur / newZoom;
      setViewOffset(v => Math.max(0, Math.min(dur - visibleDur, v)));
    } else {
      // Scroll
      const visibleDur = dur / zoomRef.current;
      const delta = (e.deltaX || e.deltaY) / 400 * visibleDur;
      setViewOffset(v => Math.max(0, Math.min(dur - visibleDur, v + delta)));
    }
  };

  const save = async () => {
    if (!song) return;
    try {
      await execute(
        "UPDATE songs SET cue_in=?, cue_out=?, intro_end=?, outro_start=? WHERE id=?",
        [cueIn, cueOut, introEnd, outroStart, song.id]
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved?.({ ...song, cue_in: cueIn, cue_out: cueOut, intro_end: introEnd, outro_start: outroStart });
    } catch (e) { console.error("Save cue points:", e); }
  };

  const reset = () => {
    if (!duration) return;
    setCueIn(0);
    setCueOut(duration);
    setIntroEnd(0);
    setOutroStart(duration * 0.9);
  };

  if (!song) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-tertiary)", fontSize: 14 }}>
      Select a track from the library to edit cue points
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0, background: "var(--bg-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>
            {song.title}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{song.artist_name || "Unknown Artist"} · {fmt(duration)}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {saved && <span style={{ fontSize: 11, color: "#34d399", fontWeight: 600 }}>✓ Saved</span>}
          <button onClick={reset} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>Reset</button>
          <button onClick={save} style={{ padding: "7px 16px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 2px 8px rgba(14,165,233,0.3)" }}>Save Cue Points</button>
          {onClose && <button onClick={onClose} style={{ padding: "7px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer" }}>✕</button>}
        </div>
      </div>

      {/* Cue point values row */}
      <div style={{ display: "flex", gap: 1, background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {[
          { label: "CUE IN", value: cueIn, set: setCueIn, color: COLORS.cueIn, desc: "Playback start" },
          { label: "INTRO END", value: introEnd, set: setIntroEnd, color: COLORS.introEnd, desc: "Music starts here" },
          { label: "OUTRO START", value: outroStart, set: setOutroStart, color: COLORS.outroStart, desc: "Begin fade" },
          { label: "CUE OUT", value: cueOut || duration, set: setCueOut, color: COLORS.cueOut, desc: "Playback end" },
        ].map(({ label, value, set, color, desc }) => (
          <div key={label} style={{ flex: 1, padding: "10px 16px", borderRight: "1px solid var(--border-primary)", cursor: "pointer" }}
            onClick={() => { setPlayhead(value); if (playing) play(value); }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", color, marginBottom: 4 }}>{label}</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 18, fontWeight: 300, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>{fmt(value)}</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>{desc}</div>
          </div>
        ))}

        {/* Playback time */}
        <div style={{ padding: "10px 16px", minWidth: 120 }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", color: "var(--text-tertiary)", marginBottom: 4 }}>POSITION</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 18, fontWeight: 300, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>{fmt(playhead)}</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>Click label to jump</div>
        </div>
      </div>

      {/* Waveform canvas */}
      <div style={{ flex: 1, position: "relative", background: "#0a0a14", overflow: "hidden", cursor: dragging ? "ew-resize" : "crosshair" }}>
        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
            Loading waveform...
          </div>
        )}
        {loadError && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
            {loadError}
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        />
      </div>

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {/* Play/pause */}
        <button onClick={togglePlay} style={{
          width: 44, height: 44, borderRadius: 12,
          background: playing ? "#34d399" : "var(--accent-blue)",
          border: "none", color: "#000", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: playing ? "0 0 16px rgba(52,211,153,0.4)" : "0 0 16px rgba(14,165,233,0.3)",
        }}>
          {playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="2" y="1" width="4" height="12" rx="1.5"/>
              <rect x="8" y="1" width="4" height="12" rx="1.5"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <polygon points="2,1 13,7 2,13"/>
            </svg>
          )}
        </button>

        {/* Play from cue in */}
        <button onClick={() => { setPlayhead(cueIn); play(cueIn); }} style={{ height: 36, padding: "0 12px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: `${COLORS.cueIn}22`, color: COLORS.cueIn, border: `1px solid ${COLORS.cueIn}44`, cursor: "pointer", letterSpacing: "0.06em" }}>
          ▶ FROM IN
        </button>

        {/* Play from intro end */}
        <button onClick={() => { setPlayhead(introEnd); play(introEnd); }} style={{ height: 36, padding: "0 12px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: `${COLORS.introEnd}22`, color: COLORS.introEnd, border: `1px solid ${COLORS.introEnd}44`, cursor: "pointer", letterSpacing: "0.06em" }}>
          ▶ FROM INTRO
        </button>

        {/* Play from outro */}
        <button onClick={() => { setPlayhead(outroStart); play(outroStart); }} style={{ height: 36, padding: "0 12px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: `${COLORS.outroStart}22`, color: COLORS.outroStart, border: `1px solid ${COLORS.outroStart}44`, cursor: "pointer", letterSpacing: "0.06em" }}>
          ▶ FROM OUTRO
        </button>

        <div style={{ flex: 1 }} />

        {/* Zoom */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", letterSpacing: "0.1em" }}>ZOOM</span>
          <button onClick={() => setZoom(z => Math.max(1, z / 1.5))} style={{ width: 28, height: 28, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "var(--text-secondary)", minWidth: 32, textAlign: "center" }}>{zoom.toFixed(1)}x</span>
          <button onClick={() => setZoom(z => Math.min(16, z * 1.5))} style={{ width: 28, height: 28, borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
          <button onClick={() => { setZoom(1); setViewOffset(0); }} style={{ height: 28, padding: "0 10px", borderRadius: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 10 }}>FIT</button>
        </div>

        <div style={{ fontSize: 10, color: "var(--text-tertiary)", letterSpacing: "0.04em" }}>
          Drag handles · Scroll to pan · Ctrl+scroll to zoom · Click to seek
        </div>
      </div>
    </div>
  );
}
