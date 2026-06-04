// src/components/StudioEditor.tsx
//
// Ether Studio — 3-Track DAW Editor
//
// Track 1 (OUT): Outgoing song — loaded from Deck A
// Track 2 (VT):  Voice track — record live or load from file
// Track 3 (IN):  Incoming song — loaded from Deck B
//
// Features:
//   • Waveform display per track (Web Audio API + Canvas)
//   • Drag to reposition tracks on timeline
//   • Trim handles (drag left/right edges)
//   • Playback — hear the full mix before air
//   • Record voice directly into track 2
//   • Crossfade controls per track boundary
//   • Export the finished mix as a WAV file

import { useCallback, useEffect, useRef, useState } from "react";
const convertFileSrc = (p: string) => `file:///${p.replace(/\\/g, "/")}`;
const save = (opts?: any) => (window as any).ether.dialog.saveFile(opts);
const writeFile = (p: string, data: any) => (window as any).ether.fs.writeFile(p, data);

// ── Types ──────────────────────────────────────────────────────

interface TrackData {
  id: "out" | "vt" | "in";
  label: string;
  color: string;
  filePath: string | null;
  buffer: AudioBuffer | null;
  peaks: Float32Array | null;
  offsetMs: number;    // position on timeline
  trimStartMs: number; // trim from start
  trimEndMs: number;   // trim from end (0 = no trim)
  gainDb: number;
  muted: boolean;
}

type DragMode = "move" | "trim-start" | "trim-end" | null;

interface DragState {
  trackId: "out" | "vt" | "in";
  mode: DragMode;
  startX: number;
  startOffsetMs: number;
  startTrimMs: number;
}

// ── Constants ──────────────────────────────────────────────────

const TRACK_H = 72;
const RULER_H = 24;
const LABEL_W = 56;
const HANDLE_W = 8;
const PIXELS_PER_SEC = 80; // zoom level: px per second

const COLORS = {
  out: { main: "rgba(251,191,36,0.8)",   dim: "rgba(251,191,36,0.15)", border: "rgba(251,191,36,0.5)"  },
  vt:  { main: "rgba(139,92,246,0.8)",   dim: "rgba(139,92,246,0.15)", border: "rgba(139,92,246,0.5)"  },
  in:  { main: "rgba(52,211,153,0.8)",   dim: "rgba(52,211,153,0.15)", border: "rgba(52,211,153,0.5)"  },
};

// ── Helpers ────────────────────────────────────────────────────

function msToX(ms: number): number { return (ms / 1000) * PIXELS_PER_SEC; }
function xToMs(x: number): number  { return (x / PIXELS_PER_SEC) * 1000; }
function fmtMs(ms: number): string {
  const s = Math.abs(ms) / 1000;
  return `${Math.floor(s / 60)}:${(Math.floor(s % 60)).toString().padStart(2, "0")}`;
}
function dbToLinear(db: number): number { return Math.pow(10, db / 20); }

// ── Waveform drawing ───────────────────────────────────────────

function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  color: string,
  widthPx: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = devicePixelRatio || 1;
  canvas.width  = widthPx * dpr;
  canvas.height = TRACK_H * dpr;
  canvas.style.width  = widthPx + "px";
  canvas.style.height = TRACK_H + "px";
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, widthPx, TRACK_H);

  const mid = TRACK_H / 2;
  const step = peaks.length / widthPx;

  ctx.fillStyle = color;
  for (let x = 0; x < widthPx; x++) {
    const idx = Math.floor(x * step);
    const amp = Math.min(1, peaks[idx] || 0);
    const h   = Math.max(2, amp * (TRACK_H - 8));
    ctx.fillRect(x, mid - h / 2, 1, h);
  }
}

// ── Extract peaks from AudioBuffer ────────────────────────────

function extractPeaks(buffer: AudioBuffer, resolution = 2000): Float32Array {
  const data    = buffer.getChannelData(0);
  const step    = Math.floor(data.length / resolution);
  const peaks   = new Float32Array(resolution);
  for (let i = 0; i < resolution; i++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const v = Math.abs(data[i * step + j] || 0);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

// ── Encode AudioBuffer to WAV ──────────────────────────────────

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numCh    = buffer.numberOfChannels;
  const sr       = buffer.sampleRate;
  const samples  = buffer.length;
  const bitsPerSample = 16;
  const byteRate = (sr * numCh * bitsPerSample) / 8;
  const blockAlign = (numCh * bitsPerSample) / 8;
  const dataSize = samples * numCh * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const write = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  write(0,  "RIFF");
  view.setUint32(4,  36 + dataSize,     true);
  write(8,  "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16,               true);
  view.setUint16(20, 1,                true);
  view.setUint16(22, numCh,            true);
  view.setUint32(24, sr,               true);
  view.setUint32(28, byteRate,         true);
  view.setUint16(32, blockAlign,       true);
  view.setUint16(34, bitsPerSample,    true);
  write(36, "data");
  view.setUint32(40, dataSize,         true);

  let offset = 44;
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }
  return ab;
}



// ── Shared button style ────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  padding: "5px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
  display: "flex", alignItems: "center", gap: 4,
};

// ── StudioEditor ───────────────────────────────────────────────

interface Props {
  deckAPath?: string | null;
  deckATitle?: string;
  deckBPath?: string | null;
  deckBTitle?: string;
}

export default function StudioEditor({ deckAPath, deckATitle, deckBPath, deckBTitle }: Props) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const playbackRef = useRef<{ nodes: AudioBufferSourceNode[]; start: number } | null>(null);

  const [tracks, setTracks] = useState<TrackData[]>([
    { id: "out", label: "OUT",  color: "out", filePath: null, buffer: null, peaks: null, offsetMs: 0,    trimStartMs: 0, trimEndMs: 0, gainDb: 0, muted: false },
    { id: "vt",  label: "VT",   color: "vt",  filePath: null, buffer: null, peaks: null, offsetMs: 5000, trimStartMs: 0, trimEndMs: 0, gainDb: 0, muted: false },
    { id: "in",  label: "IN",   color: "in",  filePath: null, buffer: null, peaks: null, offsetMs: 0,    trimStartMs: 0, trimEndMs: 0, gainDb: 0, muted: false },
  ]);

  const [playing, setPlaying]         = useState(false);
  const [recording, setRecording]     = useState(false);
  const [playheadMs, setPlayheadMs]   = useState(0);
  const [dragState, setDragState]     = useState<DragState | null>(null);
  const [zoom, setZoom]               = useState(1);
  const [status, setStatus]           = useState("Load tracks from decks or drag audio files");
  const [exporting, setExporting]     = useState(false);
  const [micStream, setMicStream]     = useState<MediaStream | null>(null);

  const timelineRef   = useRef<HTMLDivElement>(null);
  const canvasRefs    = useRef<Record<string, HTMLCanvasElement | null>>({});
  const playheadTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const pps = PIXELS_PER_SEC * zoom; // pixels per second at current zoom

  // ── Audio context init ────────────────────────────────────────

  const getCtx = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext({ sampleRate: 44100 });
    }
    return audioCtxRef.current;
  };

  // ── Load audio file into a track ─────────────────────────────

  const loadTrack = useCallback(async (trackId: "out" | "vt" | "in", filePath: string, title?: string) => {
    setStatus(`Loading ${title || filePath.split(/[\\/]/).pop()}...`);
    try {
      const ctx   = getCtx();
      const url   = filePath.startsWith("http") ? filePath : convertFileSrc(filePath);
      const resp  = await fetch(url);
      const ab    = await resp.arrayBuffer();
      const buffer = await ctx.decodeAudioData(ab);
      const peaks  = extractPeaks(buffer);

      // For OUT track: incoming goes after it by default
      setTracks(prev => prev.map(t => {
        if (t.id !== trackId) return t;
        const updated = { ...t, filePath, buffer, peaks, trimEndMs: 0, trimStartMs: 0 };
        return updated;
      }));

      // Auto-position IN track after OUT
      if (trackId === "out") {
        setTracks(prev => {
          const out = prev.find(t => t.id === "out");
          const durMs = out?.buffer ? out.buffer.duration * 1000 : 0;
          return prev.map(t => t.id === "in" ? { ...t, offsetMs: durMs } : t);
        });
      }

      setStatus(`✓ Loaded: ${title || filePath.split(/[\\/]/).pop()}`);
    } catch (e) {
      setStatus(`✗ Failed to load: ${e}`);
    }
  }, []);

  // ── Auto-load from deck props ─────────────────────────────────

  useEffect(() => {
    if (deckAPath) loadTrack("out", deckAPath, deckATitle);
  }, [deckAPath]);

  useEffect(() => {
    if (deckBPath) {
      loadTrack("in", deckBPath, deckBTitle);
    }
  }, [deckBPath]);

  // ── Draw waveforms ────────────────────────────────────────────

  useEffect(() => {
    tracks.forEach(t => {
      const canvas = canvasRefs.current[t.id];
      if (!canvas || !t.peaks || !t.buffer) return;
      const durMs  = t.buffer.duration * 1000 - t.trimStartMs - t.trimEndMs;
      const widthPx = Math.max(10, (durMs / 1000) * pps);
      const c = COLORS[t.id as keyof typeof COLORS];
      drawWaveform(canvas, t.peaks, c.main, widthPx);
    });
  }, [tracks, pps]);

  // ── Playback ──────────────────────────────────────────────────

  const startPlayback = async () => {
    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();

    stopPlayback();

    const startTime = ctx.currentTime;
    const originMs  = playheadMs;
    const nodes: AudioBufferSourceNode[] = [];

    tracks.forEach(t => {
      if (!t.buffer || t.muted) return;

      const gainNode = ctx.createGain();
      gainNode.gain.value = dbToLinear(t.gainDb);
      gainNode.connect(ctx.destination);

      const source = ctx.createBufferSource();
      source.buffer = t.buffer;

      // Crossfade at start (5ms)
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(dbToLinear(t.gainDb), startTime + 0.005);

      source.connect(gainNode);

      const trackStartMs  = t.offsetMs + t.trimStartMs;
      const trackEndMs    = t.offsetMs + t.buffer.duration * 1000 - t.trimEndMs;
      const overlapMs     = originMs - trackStartMs;

      if (trackEndMs <= originMs) return; // already passed

      const whenSec   = startTime + Math.max(0, (trackStartMs - originMs) / 1000);
      const offsetSec = Math.max(0, overlapMs / 1000) + t.trimStartMs / 1000;
      const durSec    = (trackEndMs - Math.max(originMs, trackStartMs)) / 1000;

      source.start(whenSec, offsetSec, durSec);
      nodes.push(source);
    });

    playbackRef.current = { nodes, start: startTime - originMs / 1000 };
    setPlaying(true);

    // Playhead ticker
    playheadTimer.current = setInterval(() => {
      if (!playbackRef.current) return;
      const elapsed = (ctx.currentTime - playbackRef.current.start) * 1000;
      setPlayheadMs(Math.max(0, elapsed));
    }, 50);
  };

  const stopPlayback = () => {
    if (playheadTimer.current) { clearInterval(playheadTimer.current); playheadTimer.current = null; }
    playbackRef.current?.nodes.forEach(n => { try { n.stop(); } catch {} });
    playbackRef.current = null;
    setPlaying(false);
  };

  const togglePlay = () => { playing ? stopPlayback() : startPlayback(); };

  // ── Recording ─────────────────────────────────────────────────

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicStream(stream);
      recordedChunksRef.current = [];

      const ctx = getCtx();
      if (ctx.state === "suspended") await ctx.resume();

      // Play OUT track as guide
      startPlayback();

      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mr.ondataavailable = e => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        const blob  = new Blob(recordedChunksRef.current, { type: "audio/webm" });
        const ab    = await blob.arrayBuffer();
        const buffer = await ctx.decodeAudioData(ab);
        const peaks  = extractPeaks(buffer);

        // Find OUT track outro position for default VT offset
        const outTrack = tracks.find(t => t.id === "out");
        const defaultOffset = outTrack?.buffer
          ? Math.max(0, outTrack.buffer.duration * 1000 - 15000 - (outTrack.trimEndMs || 0))
          : 5000;

        setTracks(prev => prev.map(t => t.id === "vt"
          ? { ...t, buffer, peaks, filePath: "recorded", offsetMs: defaultOffset, trimStartMs: 0, trimEndMs: 0 }
          : t
        ));
        setStatus("✓ Voice track recorded — drag to position");
        stream.getTracks().forEach(tr => tr.stop());
        setMicStream(null);
      };

      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      setStatus("● Recording — speak now...");
    } catch (e) {
      setStatus(`✗ Mic error: ${e}`);
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    stopPlayback();
    setRecording(false);
  };

  // ── Drag to move / trim ───────────────────────────────────────

  const handleMouseDown = (
    e: React.MouseEvent,
    trackId: "out" | "vt" | "in",
    mode: DragMode,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const t = tracks.find(tr => tr.id === trackId)!;
    setDragState({
      trackId, mode,
      startX: e.clientX,
      startOffsetMs: t.offsetMs,
      startTrimMs: mode === "trim-start" ? t.trimStartMs : t.trimEndMs,
    });
  };

  useEffect(() => {
    if (!dragState) return;
    const onMove = (e: MouseEvent) => {
      const dx    = e.clientX - dragState.startX;
      const dMs   = xToMs(dx / zoom);
      setTracks(prev => prev.map(t => {
        if (t.id !== dragState.trackId) return t;
        if (dragState.mode === "move") {
          return { ...t, offsetMs: Math.max(0, dragState.startOffsetMs + dMs) };
        }
        if (dragState.mode === "trim-start") {
          const dur = t.buffer ? t.buffer.duration * 1000 : 0;
          return { ...t, trimStartMs: Math.max(0, Math.min(dur - t.trimEndMs - 500, dragState.startTrimMs + dMs)) };
        }
        if (dragState.mode === "trim-end") {
          const dur = t.buffer ? t.buffer.duration * 1000 : 0;
          return { ...t, trimEndMs: Math.max(0, Math.min(dur - t.trimStartMs - 500, dragState.startTrimMs - dMs)) };
        }
        return t;
      }));
    };
    const onUp = () => setDragState(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragState, zoom]);

  // ── Timeline click → set playhead ────────────────────────────

  const handleTimelineClick = (e: React.MouseEvent) => {
    if (dragState) return;
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x  = e.clientX - rect.left - LABEL_W;
    const ms = Math.max(0, xToMs(x / zoom));
    setPlayheadMs(ms);
    if (playing) startPlayback();
  };

  // ── Drag-drop audio files onto tracks ────────────────────────

  const handleDrop = (e: React.DragEvent, trackId: "out" | "vt" | "in") => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const path = (file as any).path || URL.createObjectURL(file);
    loadTrack(trackId, path, file.name);
  };

  // ── Export WAV ────────────────────────────────────────────────

  const exportMix = async () => {
    const loaded = tracks.filter(t => t.buffer);
    if (loaded.length === 0) { setStatus("Nothing to export"); return; }
    setExporting(true);
    setStatus("Rendering mix...");
    try {
      // Calculate total duration
      const totalMs = Math.max(...tracks.map(t =>
        t.buffer ? t.offsetMs + t.buffer.duration * 1000 - t.trimEndMs : 0
      ));
      const sr       = 44100;
      const totalSec = totalMs / 1000;
      const ctx      = new OfflineAudioContext(2, Math.ceil(sr * totalSec), sr);

      tracks.forEach(t => {
        if (!t.buffer || t.muted) return;
        const gain = ctx.createGain();
        gain.gain.value = dbToLinear(t.gainDb);

        // Crossfade in
        const startSec = (t.offsetMs + t.trimStartMs) / 1000;
        gain.gain.setValueAtTime(0, startSec);
        gain.gain.linearRampToValueAtTime(dbToLinear(t.gainDb), startSec + 0.05);

        gain.connect(ctx.destination);
        const src = ctx.createBufferSource();
        src.buffer = t.buffer;
        src.connect(gain);
        src.start(startSec, t.trimStartMs / 1000,
          (t.buffer.duration - t.trimStartMs / 1000 - t.trimEndMs / 1000));
      });

      const rendered = await ctx.startRendering();
      const wavBytes = encodeWav(rendered);

      const outPath = await save({
        title: "Export Mix as WAV",
        defaultPath: "ether_mix.wav",
        filters: [{ name: "WAV Audio", extensions: ["wav"] }],
      });

      if (outPath) {
        await writeFile(outPath, new Uint8Array(wavBytes));
        setStatus(`✓ Exported: ${outPath.split(/[\\/]/).pop()}`);
      } else {
        setStatus("Export cancelled");
      }
    } catch (e) {
      setStatus(`✗ Export failed: ${e}`);
    }
    setExporting(false);
  };

  // ── Timeline total width ──────────────────────────────────────

  const totalMs = Math.max(30000, ...tracks.map(t =>
    t.buffer ? t.offsetMs + t.buffer.duration * 1000 + 5000 : 30000
  ));
  const totalPx = (totalMs / 1000) * pps + LABEL_W + 40;

  // ── Render ────────────────────────────────────────────────────

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      height: "100%", background: "var(--bg-primary)",
      fontFamily: "'Inter', system-ui, sans-serif",
      overflow: "hidden",
    }}>
      {/* ── Header ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 20px", borderBottom: "1px solid var(--border-primary)",
        flexShrink: 0,
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)", letterSpacing: "-0.03em" }}>
            Studio Editor
          </h2>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-tertiary)" }}>
            3-track mix · drag to position · record voice · export WAV
          </p>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {/* Status */}
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {status}
          </span>

          {/* Zoom */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => setZoom(z => Math.max(0.25, z - 0.25))}
              style={btnStyle}>−</button>
            <span style={{ fontSize: 10, color: "var(--text-tertiary)", minWidth: 36, textAlign: "center" as const }}>
              {Math.round(zoom * 100)}%
            </span>
            <button onClick={() => setZoom(z => Math.min(4, z + 0.25))}
              style={btnStyle}>+</button>
          </div>

          <div style={{ width: 1, height: 20, background: "var(--border-primary)" }} />

          {/* Transport */}
          <button onClick={() => { stopPlayback(); setPlayheadMs(0); }}
            style={btnStyle} title="Return to start">⏮</button>

          <button onClick={togglePlay}
            style={{
              ...btnStyle,
              background: playing ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.07)",
              color: playing ? "#34d399" : "var(--text-primary)",
              border: `1px solid ${playing ? "rgba(52,211,153,0.4)" : "var(--border-primary)"}`,
              minWidth: 64,
            }}>
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>

          {/* Record */}
          <button
            onClick={recording ? stopRecording : startRecording}
            style={{
              ...btnStyle,
              background: recording ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.04)",
              color: recording ? "#ef4444" : "var(--text-secondary)",
              border: `1px solid ${recording ? "rgba(239,68,68,0.4)" : "var(--border-primary)"}`,
              animation: recording ? "rec-blink 1s ease-in-out infinite" : "none",
            }}>
            {recording ? "⏹ Stop Rec" : "● Record VT"}
          </button>

          <div style={{ width: 1, height: 20, background: "var(--border-primary)" }} />

          {/* Export */}
          <button onClick={exportMix} disabled={exporting}
            style={{
              ...btnStyle,
              background: "rgba(96,64,192,0.1)",
              color: "#7dd3fc",
              border: "1px solid rgba(96,64,192,0.25)",
              opacity: exporting ? 0.5 : 1,
            }}>
            {exporting ? "Rendering..." : "⬇ Export WAV"}
          </button>
        </div>
      </div>

      {/* ── Timeline ── */}
      <div style={{ flex: 1, overflow: "auto", position: "relative" as const }}>
        <div
          ref={timelineRef}
          onClick={handleTimelineClick}
          style={{
            position: "relative" as const,
            minWidth: totalPx,
            minHeight: RULER_H + tracks.length * (TRACK_H + 4) + 32,
            background: "var(--bg-primary)",
            cursor: "crosshair",
          }}
        >
          {/* ── Ruler ── */}
          <div style={{
            position: "sticky" as const, top: 0, zIndex: 10,
            height: RULER_H, display: "flex", alignItems: "flex-end",
            background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)",
            paddingLeft: LABEL_W,
          }}>
            {Array.from({ length: Math.ceil(totalMs / 1000) + 1 }, (_, i) => {
              const isPrimary = i % 5 === 0;
              return (
                <div key={i} style={{
                  position: "absolute" as const,
                  left: LABEL_W + i * pps,
                  bottom: 0,
                  display: "flex", flexDirection: "column" as const, alignItems: "center",
                }}>
                  <div style={{ height: isPrimary ? 10 : 5, width: 1, background: isPrimary ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)" }} />
                  {isPrimary && (
                    <span style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", fontFamily: "monospace", marginTop: 1 }}>
                      {fmtMs(i * 1000)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Tracks ── */}
          {tracks.map((t, ti) => {
            const c       = COLORS[t.id as keyof typeof COLORS];
            const durMs   = t.buffer ? t.buffer.duration * 1000 - t.trimStartMs - t.trimEndMs : 0;
            const widthPx = Math.max(10, (durMs / 1000) * pps);
            const leftPx  = LABEL_W + ((t.offsetMs + t.trimStartMs) / 1000) * pps;

            return (
              <div key={t.id} style={{
                position: "absolute" as const,
                top: RULER_H + ti * (TRACK_H + 4),
                left: 0, right: 0,
                height: TRACK_H,
              }}>
                {/* Track label */}
                <div style={{
                  position: "absolute" as const, left: 0, top: 0,
                  width: LABEL_W, height: TRACK_H,
                  display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center",
                  borderRight: `1px solid var(--border-primary)`,
                  background: "var(--bg-secondary)",
                  zIndex: 5, gap: 3,
                }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: t.buffer ? c.main : "rgba(255,255,255,0.15)",
                  }} />
                  <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: t.buffer ? c.main : "rgba(255,255,255,0.3)" }}>
                    {t.label}
                  </span>
                  <button
                    onMouseDown={e => e.stopPropagation()}
                    onClick={e => { e.stopPropagation(); setTracks(p => p.map(tr => tr.id === t.id ? { ...tr, muted: !tr.muted } : tr)); }}
                    style={{
                      fontSize: 7, padding: "1px 4px", borderRadius: 0, border: "none",
                      background: t.muted ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.06)",
                      color: t.muted ? "#ef4444" : "rgba(255,255,255,0.3)",
                      cursor: "pointer", fontWeight: 700,
                    }}
                  >
                    {t.muted ? "MUTE" : "M"}
                  </button>
                </div>

                {/* Drop zone when empty */}
                {!t.buffer && (
                  <div
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.stopPropagation(); handleDrop(e, t.id); }}
                    style={{
                      position: "absolute" as const, left: LABEL_W, top: 0, right: 0, height: TRACK_H,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      border: `1px dashed ${c.border}`,
                      borderRadius: 0, margin: "0 8px",
                      background: c.dim,
                      opacity: 0.5,
                    }}
                  >
                    <span style={{ fontSize: 10, color: c.main, fontWeight: 600 }}>
                      {t.id === "vt" ? "● Record or drop audio" : "Drop audio or load from deck"}
                    </span>
                  </div>
                )}

                {/* Track block */}
                {t.buffer && (
                  <div
                    onMouseDown={e => handleMouseDown(e, t.id, "move")}
                    style={{
                      position: "absolute" as const,
                      left: leftPx, top: 4,
                      width: widthPx, height: TRACK_H - 8,
                      borderRadius: 0,
                      border: `1px solid ${c.border}`,
                      background: c.dim,
                      cursor: dragState?.trackId === t.id ? "grabbing" : "grab",
                      overflow: "hidden",
                      zIndex: 2,
                    }}
                  >
                    {/* Waveform canvas */}
                    <canvas
                      ref={el => { canvasRefs.current[t.id] = el; }}
                      style={{ position: "absolute" as const, inset: 0, pointerEvents: "none" }}
                    />

                    {/* Track title overlay */}
                    <div style={{
                      position: "absolute" as const, top: 3, left: 6,
                      fontSize: 8, fontWeight: 700, color: c.main,
                      pointerEvents: "none", whiteSpace: "nowrap" as const,
                      overflow: "hidden", maxWidth: "80%",
                      letterSpacing: "0.04em",
                    }}>
                      {t.id === "out" ? deckATitle || "Outgoing" :
                       t.id === "in"  ? deckBTitle || "Incoming" :
                       "Voice Track"}
                    </div>

                    {/* Duration badge */}
                    <div style={{
                      position: "absolute" as const, bottom: 3, right: 6,
                      fontSize: 7, color: "rgba(255,255,255,0.4)",
                      fontFamily: "monospace", pointerEvents: "none",
                    }}>
                      {fmtMs(durMs)}
                    </div>

                    {/* Gain knob — drag up/down to adjust */}
                    <div
                      style={{
                        position: "absolute" as const, top: 3, right: 6,
                        fontSize: 7, color: t.gainDb === 0 ? "rgba(255,255,255,0.25)" : c.main,
                        fontFamily: "monospace", cursor: "ns-resize",
                      }}
                      title="Drag up/down to adjust gain"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const startY = e.clientY;
                        const startDb = t.gainDb;
                        const onMove = (ev: MouseEvent) => {
                          const dDb = (startY - ev.clientY) * 0.1;
                          setTracks(prev => prev.map(tr => tr.id === t.id
                            ? { ...tr, gainDb: Math.max(-18, Math.min(6, startDb + dDb)) }
                            : tr
                          ));
                        };
                        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                        window.addEventListener("mousemove", onMove);
                        window.addEventListener("mouseup", onUp);
                      }}
                    >
                      {t.gainDb === 0 ? "0dB" : `${t.gainDb > 0 ? "+" : ""}${t.gainDb.toFixed(1)}dB`}
                    </div>

                    {/* Trim handle — start */}
                    <div
                      onMouseDown={e => { e.stopPropagation(); handleMouseDown(e, t.id, "trim-start"); }}
                      style={{
                        position: "absolute" as const, left: 0, top: 0, bottom: 0,
                        width: HANDLE_W, cursor: "ew-resize",
                        background: `linear-gradient(to right, ${c.main}, transparent)`,
                        opacity: 0.8, zIndex: 3,
                      }}
                    />
                    {/* Trim handle — end */}
                    <div
                      onMouseDown={e => { e.stopPropagation(); handleMouseDown(e, t.id, "trim-end"); }}
                      style={{
                        position: "absolute" as const, right: 0, top: 0, bottom: 0,
                        width: HANDLE_W, cursor: "ew-resize",
                        background: `linear-gradient(to left, ${c.main}, transparent)`,
                        opacity: 0.8, zIndex: 3,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* ── Playhead ── */}
          <div style={{
            position: "absolute" as const,
            left: LABEL_W + (playheadMs / 1000) * pps,
            top: 0, bottom: 0, width: 2,
            background: "rgba(239,68,68,0.9)",
            boxShadow: "0 0 8px rgba(239,68,68,0.6)",
            pointerEvents: "none", zIndex: 20,
            transition: playing ? "none" : "left 0.05s",
          }}>
            <div style={{
              position: "absolute" as const, top: 0,
              left: -4, width: 10, height: 10,
              background: "#ef4444",
              clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)",
              transform: "rotate(180deg)",
            }} />
            <div style={{
              position: "absolute" as const, top: 12,
              left: 4, fontSize: 8,
              color: "#ef4444", fontFamily: "monospace",
              whiteSpace: "nowrap" as const,
              background: "var(--bg-primary)",
              padding: "1px 3px", borderRadius: 0,
            }}>
              {fmtMs(playheadMs)}
            </div>
          </div>
        </div>
      </div>

      {/* ── Bottom info bar ── */}
      <div style={{
        flexShrink: 0, padding: "6px 20px",
        borderTop: "1px solid var(--border-primary)",
        display: "flex", alignItems: "center", gap: 20,
        background: "var(--bg-secondary)", fontSize: 10,
        color: "var(--text-tertiary)",
      }}>
        {tracks.map(t => t.buffer && (
          <span key={t.id}>
            <span style={{ color: COLORS[t.id as keyof typeof COLORS].main, fontWeight: 700 }}>{t.label}</span>
            {" "}{fmtMs(t.buffer.duration * 1000 - t.trimStartMs - t.trimEndMs)}
            {(t.trimStartMs > 0 || t.trimEndMs > 0) && (
              <span style={{ opacity: 0.5 }}> (trimmed)</span>
            )}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>
          Total: {fmtMs(Math.max(0, ...tracks.map(t => t.buffer ? t.offsetMs + t.buffer.duration * 1000 - t.trimEndMs : 0)))}
        </span>
      </div>

      <style>{`
        @keyframes rec-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}


