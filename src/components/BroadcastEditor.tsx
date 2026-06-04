// src/components/BroadcastEditor.tsx
//
// Ether Broadcast Production Editor
//
// The one-stop production room. Load up to 3 tracks, cut and
// arrange clips, EQ, pan, normalize, fade — then export a
// broadcast-ready WAV or MP3. No imaging director required.
//
// Tracks:
//   Track 1 — Instrumental / bed
//   Track 2 — Mastered song / source
//   Track 3 — Voice / mic / production
//
// Operations:
//   • Cut/split clip at playhead (C key or button)
//   • Trim clip edges (drag handles)
//   • Delete clip (Delete key or × button)
//   • 3-band EQ per track (lowshelf, mid peak, highshelf)
//   • Pan per track (L ←→ R knob)
//   • Normalize to -1 dBFS per track
//   • Fade in / fade out per clip (drag fade handles)
//   • Export WAV (OfflineAudioContext render)
//   • Export MP3 (requires: npm install lamejs)

import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
const readFile = (p: string) => (window as any).ether.fs.readFile(p);
const writeFile = (p: string, data: any) => (window as any).ether.fs.writeFile(p, data);
const openDialog = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const save = (opts?: any) => (window as any).ether.dialog.saveFile(opts);
const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);
import TrackEditor from "./TrackEditor";

// Open Cue Editor as a free-floating native OS window


// ── Types ──────────────────────────────────────────────────────

interface Clip {
  id: string;
  trackId: string;
  // Position on the timeline
  timelineStartMs: number;
  // Which part of the source file to use
  sourceStartMs: number;
  sourceDurationMs: number;
  // Fades
  fadeInMs: number;
  fadeOutMs: number;
}

interface Track {
  id: string;
  label: string;
  color: string;
  accentColor: string;
  // Audio data
  filePath: string | null;
  fileName: string;
  buffer: AudioBuffer | null;
  peaks: Float32Array | null;
  durationMs: number;
  // Mix controls
  gainDb: number;
  pan: number;        // -1 (L) to +1 (R)
  muted: boolean;
  solo: boolean;
  // EQ
  eqLowDb: number;   // lowshelf @ 200Hz
  eqMidDb: number;   // peaking  @ 2500Hz
  eqHighDb: number;  // highshelf @ 8000Hz
  eqEnabled: boolean;
  // Normalize
  peakDb: number | null;
}

type EditMode = "select" | "cut";

// ── Constants ──────────────────────────────────────────────────

const TRACK_H      = 90;
const RULER_H      = 28;
const CONTROLS_W   = 220;
const BASE_PPS     = 60;   // pixels per second at zoom=1
const FADE_HANDLE  = 12;   // px width of fade handles

const TRACK_DEFAULTS: Omit<Track, "id" | "label" | "color" | "accentColor">[] = [
  { filePath: null, fileName: "", buffer: null, peaks: null, durationMs: 0,
    gainDb: 0, pan: 0, muted: false, solo: false,
    eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, eqEnabled: false, peakDb: null },
  { filePath: null, fileName: "", buffer: null, peaks: null, durationMs: 0,
    gainDb: 0, pan: 0, muted: false, solo: false,
    eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, eqEnabled: false, peakDb: null },
  { filePath: null, fileName: "", buffer: null, peaks: null, durationMs: 0,
    gainDb: 0, pan: 0, muted: false, solo: false,
    eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, eqEnabled: false, peakDb: null },
];

const TRACK_META = [
  { id: "t1", label: "BED",   color: "rgba(251,191,36,0.15)",  accentColor: "#fbbf24" },
  { id: "t2", label: "SONG",  color: "rgba(52,211,153,0.15)",  accentColor: "#34d399" },
  { id: "t3", label: "VOICE", color: "rgba(139,92,246,0.15)",  accentColor: "#8b5cf6" },
];

// ── Helpers ────────────────────────────────────────────────────

let clipSeq = 0;
const newClipId = () => `clip_${++clipSeq}`;

function msToX(ms: number, pps: number) { return (ms / 1000) * pps; }
function xToMs(px: number, pps: number) { return (px / pps) * 1000; }

function fmtMs(ms: number) {
  const s = Math.abs(ms) / 1000;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const tenth = Math.floor((s % 1) * 10);
  return `${m}:${String(sec).padStart(2,"0")}.${tenth}`;
}

function dbToLinear(db: number) { return Math.pow(10, db / 20); }

function extractPeaks(buffer: AudioBuffer, resolution = 3000): Float32Array {
  const ch   = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / resolution));
  const out  = new Float32Array(resolution);
  for (let i = 0; i < resolution; i++) {
    let max = 0;
    const end = Math.min(ch.length, (i + 1) * step);
    for (let j = i * step; j < end; j++) {
      const v = Math.abs(ch[j]);
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

function measurePeakDb(buffer: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

// ── WAV encoder ────────────────────────────────────────────────

function encodeWav(buffer: AudioBuffer): Uint8Array {
  const numCh   = buffer.numberOfChannels;
  const sr      = buffer.sampleRate;
  const samples = buffer.length;
  const bps     = 16;
  const dataSize = samples * numCh * 2;
  const ab   = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + dataSize, true);
  w(8, "WAVE"); w(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true); view.setUint16(34, bps, true);
  w(36, "data"); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return new Uint8Array(ab);
}

// ── Waveform canvas draw ───────────────────────────────────────

function drawWaveformCanvas(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  widthPx: number,
  heightPx: number,
  accentColor: string,
  clipStartRatio = 0,
  clipEndRatio = 1,
) {
  const dpr = Math.min(devicePixelRatio || 1, 3); // cap at 3x for perf
  canvas.width  = Math.ceil(widthPx * dpr);
  canvas.height = Math.ceil(heightPx * dpr);
  canvas.style.width  = widthPx + "px";
  canvas.style.height = heightPx + "px";

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const mid   = heightPx / 2;
  const totalSamples   = peaks.length;
  const startSample    = Math.floor(clipStartRatio * totalSamples);
  const endSample      = Math.ceil(clipEndRatio * totalSamples);
  const visibleSamples = endSample - startSample;

  // Smooth interpolated waveform — sample at sub-pixel resolution
  // Draw filled mirrored path (top half + bottom half) for clean Audition-style look
  const topPath    = new Path2D();
  const bottomPath = new Path2D();

  const sampleAt = (x: number): number => {
    // Linear interpolation between adjacent peaks for smooth curve
    const fIdx = startSample + (x / widthPx) * visibleSamples;
    const i0   = Math.floor(fIdx);
    const i1   = Math.min(totalSamples - 1, i0 + 1);
    const t    = fIdx - i0;
    const v0   = peaks[i0] || 0;
    const v1   = peaks[i1] || 0;
    return v0 + (v1 - v0) * t;
  };

  // Build smooth path with enough points for anti-aliased curves
  const steps = Math.min(widthPx * 2, 2000); // max 2000 points
  const stepPx = widthPx / steps;

  topPath.moveTo(0, mid);
  bottomPath.moveTo(0, mid);

  for (let i = 0; i <= steps; i++) {
    const x   = i * stepPx;
    const amp = Math.min(1, sampleAt(x));
    const h   = Math.max(1, amp * (mid - 4));
    topPath.lineTo(x, mid - h);
    bottomPath.lineTo(x, mid + h);
  }

  topPath.lineTo(widthPx, mid);
  bottomPath.lineTo(widthPx, mid);

  // Fill with gradient — brighter at peaks, slightly transparent at zero crossings
  const grad = ctx.createLinearGradient(0, 0, 0, heightPx);
  grad.addColorStop(0,   accentColor + "cc");
  grad.addColorStop(0.4, accentColor + "ff");
  grad.addColorStop(0.5, accentColor + "ff");
  grad.addColorStop(0.6, accentColor + "ff");
  grad.addColorStop(1,   accentColor + "cc");

  ctx.fillStyle = grad;
  ctx.fill(topPath);
  ctx.fill(bottomPath);

  // Bright center line
  ctx.strokeStyle = accentColor + "55";
  ctx.lineWidth   = 0.5;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(widthPx, mid);
  ctx.stroke();
}

// ── BroadcastEditor ────────────────────────────────────────────

interface Props {
  initialAPath?: string | null;
  initialATitle?: string;
  initialBPath?: string | null;
  initialBTitle?: string;
  sourceSongId?: number | null;
  onBouncePlace?: (mixPath: string, songId: number) => void;
  onOpenCueEditor?: (filePath: string) => void;
}

export default function BroadcastEditor({
  initialAPath, initialATitle, initialBPath, initialBTitle,
  sourceSongId, onBouncePlace, onOpenCueEditor,
}: Props) {
  const { stationId } = useActiveStation();
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playStartRef = useRef<{ ctxTime: number; originMs: number } | null>(null);
  const sourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const recordChunksRef   = useRef<Blob[]>([]);
  const analyserRef       = useRef<AnalyserNode | null>(null);
  const liveCanvasRef     = useRef<HTMLCanvasElement | null>(null);
  const liveRafRef        = useRef<number | null>(null);
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const timelineRef    = useRef<HTMLDivElement>(null);
  const scrollRef      = useRef<HTMLDivElement>(null);
  const zoomRef        = useRef(1);          // live zoom value during gesture
  const zoomCommitRef  = useRef<ReturnType<typeof setTimeout> | null>(null); // debounce timer

  const [tracks, setTracks] = useState<Track[]>(
    TRACK_META.map((m, i) => ({ ...m, ...TRACK_DEFAULTS[i] }))
  );
  const [clips, setClips]       = useState<Clip[]>([]);
  // ── Undo / Redo history ───────────────────────────────────────
  const historyRef    = useRef<Clip[][]>([[]]);
  const historyIdxRef = useRef(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Call this before ANY destructive clips edit (cut, delete, move commit)
  const pushHistory = useCallback((currentClips: Clip[]) => {
    // Truncate any redo history ahead of current position
    historyRef.current = historyRef.current.slice(0, historyIdxRef.current + 1);
    historyRef.current.push(currentClips.map(c => ({ ...c })));
    historyIdxRef.current = historyRef.current.length - 1;
    setCanUndo(historyIdxRef.current > 0);
    setCanRedo(false);
  }, []);

  const undo = useCallback(() => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    const prev = historyRef.current[historyIdxRef.current];
    setClips(prev.map(c => ({ ...c })));
    setCanUndo(historyIdxRef.current > 0);
    setCanRedo(true);
    setStatus("Undo");
  }, []);

  const redo = useCallback(() => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    const next = historyRef.current[historyIdxRef.current];
    setClips(next.map(c => ({ ...c })));
    setCanUndo(true);
    setCanRedo(historyIdxRef.current < historyRef.current.length - 1);
    setStatus("Redo");
  }, []);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [cursorMs, setCursorMs]     = useState<number | null>(null);
  const [cursorY, setCursorY]       = useState(0); // mouse Y relative to timeline
  const [cursorOnTimeline, setCursorOnTimeline] = useState(false);
  const [playing, setPlaying]   = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordTargetId, setRecordTargetId] = useState<string>("t3"); // which track to record into
  const [zoom, setZoom]         = useState(1);
  const [mode, setMode]         = useState<EditMode>("select");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [status, setStatus]     = useState("Load audio files to get started");
  const [exporting, setExporting] = useState(false);
  const [snapEnabled, setSnapEnabled]   = useState(true);
  const [rippleEnabled, setRippleEnabled] = useState(false);
  const [snapIndicatorMs, setSnapIndicatorMs] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; clipId: string; trackId: string;
  } | null>(null);
  const [trackContextMenu, setTrackContextMenu] = useState<{
    x: number; y: number; trackId: string;
  } | null>(null);

  const pps = BASE_PPS * zoom;

  // ── Snap helper ───────────────────────────────────────────────
  const SNAP_THRESHOLD_PX = 8;  // px distance to snap
  const GRID_MS = 1000;

  const snapToNearest = useCallback((ms: number, excludeClipId?: string): number => {
    if (!snapEnabled) return ms;
    const threshMs = (SNAP_THRESHOLD_PX / (BASE_PPS * zoom)) * 1000;
    const candidates: number[] = [];
    // 1-second grid
    candidates.push(Math.round(ms / GRID_MS) * GRID_MS);
    // All clip edges
    clips.forEach(c => {
      if (c.id === excludeClipId) return;
      candidates.push(c.timelineStartMs);
      candidates.push(c.timelineStartMs + c.sourceDurationMs);
    });
    // Playhead
    candidates.push(playheadMs);
    // Nearest within threshold
    let best = ms;
    let bestDist = threshMs;
    for (const c of candidates) {
      const d = Math.abs(c - ms);
      if (d < bestDist) { best = c; bestDist = d; }
    }
    setSnapIndicatorMs(best !== ms ? best : null);
    return best;
  }, [snapEnabled, clips, playheadMs, zoom]);

  const getCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext({ sampleRate: 44100 });
    }
    return audioCtxRef.current;
  };

  // ── Load file ────────────────────────────────────────────────

  const loadFile = useCallback(async (trackId: string, filePath: string, title?: string) => {
    setStatus(`Loading ${title || filePath.split(/[\\/]/).pop()}...`);
    try {
      const ctx   = getCtx();
      const bytes = await readFile(filePath);
      const ab    = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const buffer = await ctx.decodeAudioData(ab);
      const peaks  = extractPeaks(buffer);
      const durMs  = buffer.duration * 1000;
      const peak   = measurePeakDb(buffer);
      const fname  = title || filePath.split(/[\\/]/).pop() || filePath;

      setTracks(prev => prev.map(t => t.id === trackId
        ? { ...t, filePath, fileName: fname, buffer, peaks, durationMs: durMs, peakDb: peak }
        : t
      ));

      // Create a default clip spanning the full file
      const newClip: Clip = {
        id: newClipId(),
        trackId,
        timelineStartMs: 0,
        sourceStartMs: 0,
        sourceDurationMs: durMs,
        fadeInMs: 0,
        fadeOutMs: 0,
      };
      setClips(prev => [...prev.filter(c => c.trackId !== trackId), newClip]);
      setStatus(`✓ ${fname}`);
    } catch (e) {
      setStatus(`✗ Load failed: ${e}`);
    }
  }, []);

  // ── Initial deck props ────────────────────────────────────────

  useEffect(() => { if (initialAPath) loadFile("t1", initialAPath, initialATitle); }, [initialAPath]);
  useEffect(() => { if (initialBPath) loadFile("t2", initialBPath, initialBTitle); }, [initialBPath]);

  // ── Redraw waveforms when zoom/clips/tracks change ────────────

  useEffect(() => {
    clips.forEach(clip => {
      const canvas = canvasRefs.current[clip.id];
      if (!canvas) return;
      const track = tracks.find(t => t.id === clip.trackId);
      if (!track?.peaks || !track.buffer) return;
      const widthPx = Math.max(2, msToX(clip.sourceDurationMs, pps));
      const startRatio = clip.sourceStartMs / track.durationMs;
      const endRatio   = (clip.sourceStartMs + clip.sourceDurationMs) / track.durationMs;
      drawWaveformCanvas(canvas, track.peaks, widthPx, TRACK_H - 16, track.accentColor, startRatio, endRatio);
    });
  }, [clips, tracks, pps]);

  // ── Open file dialog ──────────────────────────────────────────

  const browseFile = async (trackId: string) => {
    try {
      const result = await openDialog({
        multiple: false,
        filters: [{ name: "Audio", extensions: ["mp3","wav","flac","m4a","aac","ogg","wma"] }],
      });
      if (result && typeof result === "string") {
        await loadFile(trackId, result);
      }
    } catch (e) {
      setStatus(`✗ ${e}`);
    }
  };

  // ── Normalize ────────────────────────────────────────────────

  const normalize = (trackId: string) => {
    const track = tracks.find(t => t.id === trackId);
    if (!track?.peakDb || !isFinite(track.peakDb)) return;
    const targetDb = -1.0;
    const gainNeeded = targetDb - track.peakDb;
    setTracks(prev => prev.map(t => t.id === trackId
      ? { ...t, gainDb: Math.max(-18, Math.min(12, gainNeeded)) }
      : t
    ));
    setStatus(`Normalized ${track.fileName}: ${gainNeeded > 0 ? "+" : ""}${gainNeeded.toFixed(1)} dB`);
  };

  // ── Cut clip at playhead ──────────────────────────────────────

  // cutAtMs accepts an explicit position so it works synchronously on click
  // cutAtPlayhead() is the keyboard shortcut version that uses current playheadMs
  const cutAtMs = useCallback((atMs: number) => {
    setClips(prev => {
      const newClips: Clip[] = [];
      let didCut = false;
      for (const clip of prev) {
        const clipEnd = clip.timelineStartMs + clip.sourceDurationMs;
        if (atMs > clip.timelineStartMs + 10 && atMs < clipEnd - 10) {
          const leftDur  = atMs - clip.timelineStartMs;
          const rightDur = clipEnd - atMs;
          newClips.push({ ...clip, id: newClipId(), sourceDurationMs: leftDur, fadeOutMs: 0 });
          newClips.push({
            ...clip, id: newClipId(),
            timelineStartMs: atMs,
            sourceStartMs: clip.sourceStartMs + leftDur,
            sourceDurationMs: rightDur, fadeInMs: 0,
          });
          didCut = true;
        } else {
          newClips.push(clip);
        }
      }
      if (didCut) {
        pushHistory(prev);
        setStatus(`✂ Cut at ${fmtMs(atMs)}`);
      } else {
        setStatus(`No clip at ${fmtMs(atMs)}`);
      }
      return newClips;
    });
  }, [pushHistory]);

  const cutAtPlayhead = useCallback(() => {
    cutAtMs(playheadMs);
  }, [playheadMs, cutAtMs]);

  // ── Delete clip (with optional ripple) ───────────────────────

  const deleteClip = useCallback((clipId: string) => {
    setClips(prev => {
      pushHistory(prev);
      const target = prev.find(c => c.id === clipId);
      if (!target) return prev;

      if (rippleEnabled) {
        // Ripple: close the gap by shifting all clips on same track that come after
        const gapMs = target.sourceDurationMs;
        const gapStart = target.timelineStartMs;
        return prev
          .filter(c => c.id !== clipId)
          .map(c => {
            if (c.trackId === target.trackId && c.timelineStartMs >= gapStart) {
              return { ...c, timelineStartMs: Math.max(0, c.timelineStartMs - gapMs) };
            }
            return c;
          });
      }
      return prev.filter(c => c.id !== clipId);
    });
    if (selectedClipId === clipId) setSelectedClipId(null);
    setStatus(rippleEnabled ? "Clip deleted — gap closed (ripple)" : "Clip deleted — Ctrl+Z to undo");
  }, [selectedClipId, pushHistory, rippleEnabled]);

  // ── Join / merge two adjacent clips ──────────────────────────
  // Merges selectedClip with the next clip on the same track

  const joinClips = useCallback(() => {
    if (!selectedClipId) { setStatus("Select a clip to join with the next one"); return; }
    setClips(prev => {
      const clip = prev.find(c => c.id === selectedClipId);
      if (!clip) return prev;
      // Find the next clip on the same track (closest start after this one ends)
      const clipEnd = clip.timelineStartMs + clip.sourceDurationMs;
      const next = prev
        .filter(c => c.trackId === clip.trackId && c.id !== clip.id && c.timelineStartMs >= clipEnd - 50)
        .sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0];

      if (!next) { setStatus("No adjacent clip found to join"); return prev; }

      pushHistory(prev);

      // Merged clip: spans from clip start to next end
      const merged: Clip = {
        ...clip,
        id: newClipId(),
        sourceDurationMs: clip.sourceDurationMs + (next.timelineStartMs - clipEnd) + next.sourceDurationMs,
        fadeOutMs: next.fadeOutMs,
      };

      setStatus(`Joined clips — ${fmtMs(merged.sourceDurationMs)} total`);
      return [...prev.filter(c => c.id !== clip.id && c.id !== next.id), merged];
    });
  }, [selectedClipId, pushHistory]);

  // ── Keyboard shortcuts ────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Undo / Redo
      if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey) || (e.key === "y" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); redo(); return; }
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        if (cursorMs !== null) cutAtMs(cursorMs);
        else cutAtPlayhead();
      }
      if (e.key === "j" || e.key === "J") { e.preventDefault(); joinClips(); }
      if (e.key === "s" || e.key === "S") { e.preventDefault(); setSnapEnabled(v => !v); }
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedClipId) {
        e.preventDefault(); deleteClip(selectedClipId);
      }
      if (e.key === "Escape") { setSelectedClipId(null); setMode("select"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cutAtMs, cutAtPlayhead, deleteClip, selectedClipId, undo, redo, cursorMs, joinClips, snapEnabled]);

  // ── Clip drag (move) ──────────────────────────────────────────

  const clipDragRef = useRef<{
    clipId: string; startX: number; startMs: number;
    mode: "move" | "trim-start" | "trim-end" | "fade-in" | "fade-out";
  } | null>(null);

  const startClipDrag = (
    e: React.MouseEvent,
    clipId: string,
    dragMode: "move" | "trim-start" | "trim-end" | "fade-in" | "fade-out"
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const clip = clips.find(c => c.id === clipId)!;
    // Snapshot history BEFORE the drag starts
    pushHistory(clips);
    clipDragRef.current = {
      clipId, startX: e.clientX,
      startMs: dragMode === "trim-start" ? clip.sourceStartMs
              : dragMode === "trim-end"   ? clip.sourceDurationMs
              : dragMode === "fade-in"    ? clip.fadeInMs
              : dragMode === "fade-out"   ? clip.fadeOutMs
              : clip.timelineStartMs,
      mode: dragMode,
    };
    setSelectedClipId(clipId);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!clipDragRef.current) return;
      const { clipId, startX, startMs, mode: dm } = clipDragRef.current;
      const dx  = e.clientX - startX;
      const dMs = xToMs(dx / zoom, BASE_PPS);

      setClips(prev => prev.map(c => {
        if (c.id !== clipId) return c;
        if (dm === "move") {
          const raw = Math.max(0, startMs + dMs);
          const snapped = snapToNearest(raw, clipId);
          return { ...c, timelineStartMs: snapped };
        }
        if (dm === "trim-start") {
          const maxTrim = c.sourceDurationMs - 100;
          const newStart = Math.max(0, Math.min(maxTrim, startMs + dMs));
          const diff = newStart - c.sourceStartMs;
          return { ...c, sourceStartMs: newStart, sourceDurationMs: c.sourceDurationMs - diff,
                         timelineStartMs: c.timelineStartMs + diff };
        }
        if (dm === "trim-end") {
          const track = tracks.find(t => t.id === c.trackId);
          const maxDur = (track?.durationMs || 999999) - c.sourceStartMs;
          const raw = Math.max(100, Math.min(maxDur, startMs + dMs));
          const snapped = snapToNearest(c.timelineStartMs + raw, clipId) - c.timelineStartMs;
          return { ...c, sourceDurationMs: Math.max(100, snapped) };
        }
        if (dm === "fade-in") {
          return { ...c, fadeInMs: Math.max(0, Math.min(c.sourceDurationMs / 2, startMs + dMs)) };
        }
        if (dm === "fade-out") {
          return { ...c, fadeOutMs: Math.max(0, Math.min(c.sourceDurationMs / 2, startMs - dMs)) };
        }
        return c;
      }));
    };
    const onUp = () => {
      clipDragRef.current = null;
      setSnapIndicatorMs(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [zoom, tracks, snapToNearest]);

  // ── Scroll-aware position helper ─────────────────────────────

  const getTimelineMs = (clientX: number): number => {
    const scroll = scrollRef.current?.scrollLeft ?? 0;
    const rect   = scrollRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const x = clientX - rect.left + scroll;
    return Math.max(0, xToMs(x / zoom, BASE_PPS));
  };

  const getTimelineY = (clientY: number): number => {
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const rect = scrollRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return clientY - rect.top + scrollTop;
  };

  // ── Timeline click → set playhead / cut ──────────────────────

  const onTimelineClick = (e: React.MouseEvent) => {
    if (clipDragRef.current) return;
    if (mode === "cut" && cursorMs !== null) {
      // Use cursorMs — it's exactly where the dotted line is showing
      setPlayheadMs(cursorMs);
      cutAtMs(cursorMs);
      return;
    }
    const ms = getTimelineMs(e.clientX);
    setPlayheadMs(ms);
  };

  // ── Precision cursor ──────────────────────────────────────────

  const onTimelineMouseMove = (e: React.MouseEvent) => {
    const ms = getTimelineMs(e.clientX);
    const y  = getTimelineY(e.clientY);
    setCursorMs(ms);
    setCursorY(y);
    setCursorOnTimeline(true);
  };

  const onTimelineMouseLeave = () => {
    setCursorOnTimeline(false);
    setCursorMs(null);
  };

  // ── Ctrl+scroll zoom — smooth CSS transform during gesture ──

  const onTimelineWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();

    const scroll = scrollRef.current;
    const timeline = timelineRef.current;
    if (!scroll || !timeline) return;

    const rect      = scroll.getBoundingClientRect();
    const scrollLeft = scroll.scrollLeft;

    // Cursor position in timeline ms — anchor point
    const cursorXInTimeline = e.clientX - rect.left + scrollLeft;
    const anchorMs = (cursorXInTimeline / (BASE_PPS * zoomRef.current)) * 1000;

    // Update zoom ref immediately — no React state, no re-render
    const factor   = e.deltaY < 0 ? 1.12 : 0.89;
    const newZoom  = Math.max(0.1, Math.min(12, zoomRef.current * factor));
    zoomRef.current = newZoom;

    // Apply via CSS transform instantly — silky smooth
    const scale = newZoom / zoom; // scale relative to last committed zoom
    timeline.style.transformOrigin = `${cursorXInTimeline}px 0`;
    timeline.style.transform = `scaleX(${scale})`;

    // Scroll to keep anchor under cursor
    const newCursorX = (anchorMs / 1000) * BASE_PPS * newZoom;
    scroll.scrollLeft = newCursorX - (e.clientX - rect.left);

    // Debounce: commit zoom to React state 120ms after last wheel tick
    // This triggers a proper re-render + waveform redraw
    if (zoomCommitRef.current) clearTimeout(zoomCommitRef.current);
    zoomCommitRef.current = setTimeout(() => {
      timeline.style.transform = "";
      timeline.style.transformOrigin = "";
      setZoom(zoomRef.current);
    }, 120);
  }, [zoom]);

  // ── Drop audio onto track ─────────────────────────────────────

  const onTrackDrop = async (e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const path = (file as any).path;
    if (path) await loadFile(trackId, path, file.name);
  };

  // ── Playback ─────────────────────────────────────────────────

  const stopPlayback = useCallback(() => {
    sourceNodesRef.current.forEach(n => { try { n.stop(); } catch {} });
    sourceNodesRef.current = [];
    if (playTimerRef.current) { clearInterval(playTimerRef.current); playTimerRef.current = null; }
    playStartRef.current = null;
    setPlaying(false);
  }, []);

  const startPlayback = useCallback(async () => {
    stopPlayback();
    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();

    const originMs = playheadMs;
    const ctxStart = ctx.currentTime + 0.05;

    const hasSolo = tracks.some(t => t.solo);

    tracks.forEach(track => {
      if (!track.buffer) return;
      if (track.muted) return;
      if (hasSolo && !track.solo) return;

      const trackClips = clips.filter(c => c.trackId === track.id);

      trackClips.forEach(clip => {
        const clipEndMs = clip.timelineStartMs + clip.sourceDurationMs;
        if (clipEndMs <= originMs) return;

        const gain    = ctx.createGain();
        gain.gain.value = dbToLinear(track.gainDb);

        const pan = ctx.createStereoPanner();
        pan.pan.value = track.pan;

        let lastNode: AudioNode = gain;

        if (track.eqEnabled) {
          const low  = ctx.createBiquadFilter();
          low.type = "lowshelf"; low.frequency.value = 200;
          low.gain.value = track.eqLowDb;

          const mid  = ctx.createBiquadFilter();
          mid.type = "peaking"; mid.frequency.value = 2500;
          mid.Q.value = 1.5; mid.gain.value = track.eqMidDb;

          const high = ctx.createBiquadFilter();
          high.type = "highshelf"; high.frequency.value = 8000;
          high.gain.value = track.eqHighDb;

          gain.connect(low); low.connect(mid); mid.connect(high);
          high.connect(pan); lastNode = pan;
        } else {
          gain.connect(pan); lastNode = pan;
        }
        pan.connect(ctx.destination);

        const src = ctx.createBufferSource();
        src.buffer = track.buffer;
        src.connect(gain);

        const clipStartOnTimeline = clip.timelineStartMs;
        const overlapMs = originMs - clipStartOnTimeline;
        const whenSec = ctxStart + Math.max(0, (clipStartOnTimeline - originMs) / 1000);
        const srcOffsetSec = (clip.sourceStartMs + Math.max(0, overlapMs)) / 1000;
        const durSec = (clipEndMs - Math.max(originMs, clipStartOnTimeline)) / 1000;

        // Fade in
        if (clip.fadeInMs > 0 && overlapMs <= 0) {
          gain.gain.setValueAtTime(0, whenSec);
          gain.gain.linearRampToValueAtTime(dbToLinear(track.gainDb), whenSec + clip.fadeInMs / 1000);
        }

        // Fade out
        if (clip.fadeOutMs > 0) {
          const fadeOutStart = whenSec + durSec - clip.fadeOutMs / 1000;
          gain.gain.setValueAtTime(dbToLinear(track.gainDb), fadeOutStart);
          gain.gain.linearRampToValueAtTime(0, whenSec + durSec);
        }

        src.start(whenSec, srcOffsetSec, durSec);
        sourceNodesRef.current.push(src);
      });
    });

    playStartRef.current = { ctxTime: ctxStart, originMs };
    setPlaying(true);

    playTimerRef.current = setInterval(() => {
      if (!playStartRef.current) return;
      const ctx2 = audioCtxRef.current;
      if (!ctx2) return;
      const elapsed = (ctx2.currentTime - playStartRef.current.ctxTime) * 1000 + playStartRef.current.originMs;
      setPlayheadMs(Math.max(0, elapsed));
    }, 40);
  }, [clips, tracks, playheadMs, stopPlayback]);

  const togglePlay = useCallback(() => {
    playing ? stopPlayback() : startPlayback();
  }, [playing, stopPlayback, startPlayback]);

  // ── Record into track 3 ───────────────────────────────────────

  // ── Live waveform draw loop ───────────────────────────────────

  const startLiveWaveform = (analyser: AnalyserNode, accentColor: string) => {
    const canvas = liveCanvasRef.current;
    if (!canvas) return;
    const bufLen = analyser.frequencyBinCount;
    const dataArr = new Float32Array(bufLen);

    const draw = () => {
      liveRafRef.current = requestAnimationFrame(draw);
      analyser.getFloatTimeDomainData(dataArr);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      const dpr = devicePixelRatio || 1;
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
        ctx.scale(dpr, dpr);
      }

      ctx.clearRect(0, 0, w, h);

      // Filled waveform path
      ctx.beginPath();
      const mid = h / 2;
      const step = bufLen / w;

      ctx.moveTo(0, mid);
      for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        const v   = dataArr[idx] || 0;
        ctx.lineTo(x, mid - v * (mid - 4));
      }
      ctx.lineTo(w, mid);
      for (let x = w; x >= 0; x--) {
        const idx = Math.floor(x * step);
        const v   = dataArr[idx] || 0;
        ctx.lineTo(x, mid + v * (mid - 4));
      }
      ctx.closePath();
      ctx.fillStyle = accentColor + "99";
      ctx.fill();

      // Center line
      ctx.strokeStyle = accentColor + "33";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
    };

    draw();
  };

  const stopLiveWaveform = () => {
    if (liveRafRef.current) {
      cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = null;
    }
    // Clear canvas
    const canvas = liveCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    analyserRef.current = null;
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      recordChunksRef.current = [];
      const targetId    = recordTargetId;
      const targetTrack = tracks.find(t => t.id === targetId);

      // Wire up analyser for live waveform
      const audioCtx = getCtx();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const source   = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyserRef.current = analyser;
      startLiveWaveform(analyser, targetTrack?.accentColor || "#a78bfa");

      const mr = new MediaRecorder(stream);
      mr.ondataavailable = e => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stopLiveWaveform();
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recordChunksRef.current, { type: "audio/webm" });
        const ab   = await blob.arrayBuffer();
        const ctx  = getCtx();
        const buf  = await ctx.decodeAudioData(ab);
        const peaks = extractPeaks(buf);
        const durMs = buf.duration * 1000;
        const peak  = measurePeakDb(buf);
        const label = targetTrack?.label || "Track";
        setTracks(prev => prev.map(t => t.id === targetId
          ? { ...t, buffer: buf, peaks, durationMs: durMs, peakDb: peak, fileName: `${label} Recording`, filePath: "recorded" }
          : t
        ));
        const newClip: Clip = {
          id: newClipId(), trackId: targetId,
          timelineStartMs: playheadMs,
          sourceStartMs: 0, sourceDurationMs: durMs,
          fadeInMs: 0, fadeOutMs: 0,
        };
        setClips(prev => [...prev.filter(c => c.trackId !== targetId), newClip]);
        setStatus(`✓ Recorded into ${label} track`);
        setRecording(false);
      };
      mr.start(100); // emit chunks every 100ms
      mediaRecorderRef.current = mr;
      setRecording(true);
      setStatus(`● Recording into ${targetTrack?.label || "track"}...`);
      await startPlayback();
    } catch (e) {
      setStatus(`✗ Mic error: ${e}`);
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    stopPlayback();
  };

  // ── Export WAV ────────────────────────────────────────────────

  const exportWav = async () => {
    const hasContent = tracks.some(t => t.buffer);
    if (!hasContent) { setStatus("Nothing to export"); return; }
    setExporting(true);
    setStatus("Rendering WAV...");

    try {
      const sr = 44100;
      const endMs = Math.max(...clips.map(c => c.timelineStartMs + c.sourceDurationMs), 1000);
      const ctx  = new OfflineAudioContext(2, Math.ceil(sr * endMs / 1000), sr);
      const hasSolo = tracks.some(t => t.solo);

      tracks.forEach(track => {
        if (!track.buffer || track.muted) return;
        if (hasSolo && !track.solo) return;

        const gain = ctx.createGain();
        gain.gain.value = dbToLinear(track.gainDb);
        const pan  = ctx.createStereoPanner();
        pan.pan.value = track.pan;

        if (track.eqEnabled) {
          const low = ctx.createBiquadFilter();
          low.type = "lowshelf"; low.frequency.value = 200; low.gain.value = track.eqLowDb;
          const mid = ctx.createBiquadFilter();
          mid.type = "peaking"; mid.frequency.value = 2500; mid.Q.value = 1.5; mid.gain.value = track.eqMidDb;
          const high = ctx.createBiquadFilter();
          high.type = "highshelf"; high.frequency.value = 8000; high.gain.value = track.eqHighDb;
          gain.connect(low); low.connect(mid); mid.connect(high); high.connect(pan);
        } else {
          gain.connect(pan);
        }
        pan.connect(ctx.destination);

        clips.filter(c => c.trackId === track.id).forEach(clip => {
          const src = ctx.createBufferSource();
          src.buffer = track.buffer!;
          src.connect(gain);
          const startSec = clip.timelineStartMs / 1000;
          const durSec   = clip.sourceDurationMs / 1000;
          const offSec   = clip.sourceStartMs / 1000;
          if (clip.fadeInMs > 0) {
            gain.gain.setValueAtTime(0, startSec);
            gain.gain.linearRampToValueAtTime(dbToLinear(track.gainDb), startSec + clip.fadeInMs / 1000);
          }
          if (clip.fadeOutMs > 0) {
            gain.gain.setValueAtTime(dbToLinear(track.gainDb), startSec + durSec - clip.fadeOutMs / 1000);
            gain.gain.linearRampToValueAtTime(0, startSec + durSec);
          }
          src.start(startSec, offSec, durSec);
        });
      });

      const rendered = await ctx.startRendering();
      const wavBytes = encodeWav(rendered);

      const outPath = await save({
        title: "Export Mix as WAV",
        defaultPath: "ether_production.wav",
        filters: [{ name: "WAV Audio", extensions: ["wav"] }],
      });

      if (outPath) {
        await writeFile(outPath, wavBytes);
        setStatus(`✓ Exported: ${outPath.split(/[\\/]/).pop()}`);
      } else {
        setStatus("Export cancelled");
      }
    } catch (e) {
      setStatus(`✗ Export failed: ${e}`);
    }
    setExporting(false);
  };

  // ── Export MP3 ────────────────────────────────────────────────

  const exportMp3 = async () => {
    const hasContent = tracks.some(t => t.buffer);
    if (!hasContent) { setStatus("Nothing to export"); return; }

    // Check if lamejs is available
    try {
      await import("lamejs");
    } catch {
      setStatus("MP3 export needs lamejs — run: npm install lamejs");
      return;
    }

    setExporting(true);
    setStatus("Rendering MP3...");

    try {
      // First render to WAV buffer using the same offline render
      const sr = 44100;
      const endMs = Math.max(...clips.map(c => c.timelineStartMs + c.sourceDurationMs), 1000);
      const offCtx = new OfflineAudioContext(2, Math.ceil(sr * endMs / 1000), sr);
      const hasSolo = tracks.some(t => t.solo);

      tracks.forEach(track => {
        if (!track.buffer || track.muted) return;
        if (hasSolo && !track.solo) return;
        const gain = offCtx.createGain();
        gain.gain.value = dbToLinear(track.gainDb);
        const pan = offCtx.createStereoPanner();
        pan.pan.value = track.pan;
        if (track.eqEnabled) {
          const low = offCtx.createBiquadFilter();
          low.type = "lowshelf"; low.frequency.value = 200; low.gain.value = track.eqLowDb;
          const mid = offCtx.createBiquadFilter();
          mid.type = "peaking"; mid.frequency.value = 2500; mid.Q.value = 1.5; mid.gain.value = track.eqMidDb;
          const high = offCtx.createBiquadFilter();
          high.type = "highshelf"; high.frequency.value = 8000; high.gain.value = track.eqHighDb;
          gain.connect(low); low.connect(mid); mid.connect(high); high.connect(pan);
        } else { gain.connect(pan); }
        pan.connect(offCtx.destination);
        clips.filter(c => c.trackId === track.id).forEach(clip => {
          const src = offCtx.createBufferSource();
          src.buffer = track.buffer!;
          src.connect(gain);
          src.start(clip.timelineStartMs / 1000, clip.sourceStartMs / 1000, clip.sourceDurationMs / 1000);
        });
      });

      const rendered = await offCtx.startRendering();

      // Encode to MP3 using lamejs
      const { Mp3Encoder } = await import("lamejs");
      const encoder = new (Mp3Encoder as any)(2, rendered.sampleRate, 192);
      const left  = rendered.getChannelData(0);
      const right = rendered.getChannelData(1);
      const BLOCK = 1152;
      const mp3Chunks: Uint8Array[] = [];

      // Convert float32 to int16
      const toInt16 = (f32: Float32Array) => {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]));
          out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return out;
      };

      const leftI16  = toInt16(left);
      const rightI16 = toInt16(right);

      for (let i = 0; i < leftI16.length; i += BLOCK) {
        const chunk = encoder.encodeBuffer(
          leftI16.subarray(i, i + BLOCK),
          rightI16.subarray(i, i + BLOCK)
        );
        if (chunk.length > 0) mp3Chunks.push(new Uint8Array(chunk));
      }
      const tail = encoder.flush();
      if (tail.length > 0) mp3Chunks.push(new Uint8Array(tail));

      const totalLen = mp3Chunks.reduce((s, c) => s + c.length, 0);
      const mp3Data  = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of mp3Chunks) { mp3Data.set(chunk, offset); offset += chunk.length; }

      const outPath = await save({
        title: "Export Mix as MP3",
        defaultPath: "ether_production.mp3",
        filters: [{ name: "MP3 Audio", extensions: ["mp3"] }],
      });

      if (outPath) {
        await writeFile(outPath, mp3Data);
        setStatus(`✓ MP3 exported: ${outPath.split(/[\\/]/).pop()}`);
      } else {
        setStatus("Export cancelled");
      }
    } catch (e) {
      setStatus(`✗ MP3 export failed: ${e}`);
    }
    setExporting(false);
  };

  // ── Bounce & Place ────────────────────────────────────────────
  // Renders the full mix, writes it to the library as an intro version,
  // updates the DB, then calls back so the caller can close the editor.

  const bounceAndPlace = async () => {
    if (!tracks.some(t => t.buffer)) { setStatus("Nothing to bounce"); return; }
    setExporting(true);
    setStatus("Bouncing mix...");
    try {
      const sr    = 44100;
      const endMs = Math.max(...clips.map(c => c.timelineStartMs + c.sourceDurationMs), 1000);
      const ctx   = new OfflineAudioContext(2, Math.ceil(sr * endMs / 1000), sr);
      const hasSolo = tracks.some(t => t.solo);

      tracks.forEach(track => {
        if (!track.buffer || track.muted) return;
        if (hasSolo && !track.solo) return;
        const gain = ctx.createGain();
        gain.gain.value = dbToLinear(track.gainDb);
        const pan = ctx.createStereoPanner();
        pan.pan.value = track.pan;
        if (track.eqEnabled) {
          const low  = ctx.createBiquadFilter();
          low.type = "lowshelf"; low.frequency.value = 200; low.gain.value = track.eqLowDb;
          const mid  = ctx.createBiquadFilter();
          mid.type = "peaking"; mid.frequency.value = 2500; mid.Q.value = 1.5; mid.gain.value = track.eqMidDb;
          const high = ctx.createBiquadFilter();
          high.type = "highshelf"; high.frequency.value = 8000; high.gain.value = track.eqHighDb;
          gain.connect(low); low.connect(mid); mid.connect(high); high.connect(pan);
        } else { gain.connect(pan); }
        pan.connect(ctx.destination);
        clips.filter(c => c.trackId === track.id).forEach(clip => {
          const src = ctx.createBufferSource();
          src.buffer = track.buffer!;
          src.connect(gain);
          src.start(clip.timelineStartMs / 1000, clip.sourceStartMs / 1000, clip.sourceDurationMs / 1000);
        });
      });

      const rendered = await ctx.startRendering();
      const wavBytes = encodeWav(rendered);

      // Auto-save next to original file
      const originalPath = tracks.find(t => t.id === "t1")?.filePath || "";
      const dir  = originalPath.replace(/[\\/][^\\/]+$/, "");
      const name = (tracks.find(t => t.id === "t1")?.fileName || "mix")
        .replace(/\.[^.]+$/, "");
      const outPath = `${dir}/ether_intro_${name}_${Date.now()}.wav`;

      await writeFile(outPath, wavBytes);

      // Update DB — flag the original song as having an intro version
      if (sourceSongId) {
        await (window as any).ether.songs.updateById(sourceSongId, { intro_version_path: outPath, has_intro: 1 });
      }

      setStatus(`✓ Bounced & placed — ${name}_intro.wav`);
      onBouncePlace?.(outPath, sourceSongId ?? -1);
    } catch (e) {
      setStatus(`✗ Bounce failed: ${e}`);
    }
    setExporting(false);
  };

  // ── Send clip to Voice Tracker break library ──────────────────

  const sendToVoiceTracker = async (clipId: string) => {
    const clip  = clips.find(c => c.id === clipId);
    if (!clip) return;
    const track = tracks.find(t => t.id === clip.trackId);
    if (!track?.buffer) { setStatus("No audio in that clip"); return; }

    setStatus("Rendering clip for Voice Tracker...");
    try {
      const sr  = 44100;
      const dur = clip.sourceDurationMs / 1000;
      const ctx = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);

      const gain = ctx.createGain();
      gain.gain.value = dbToLinear(track.gainDb);
      const pan = ctx.createStereoPanner();
      pan.pan.value = track.pan;
      gain.connect(pan); pan.connect(ctx.destination);

      const src = ctx.createBufferSource();
      src.buffer = track.buffer;
      src.connect(gain);
      src.start(0, clip.sourceStartMs / 1000, dur);

      const rendered  = await ctx.startRendering();
      const wavBytes  = encodeWav(rendered);

      // Save to temp folder next to source file
      const basePath  = track.filePath?.replace(/[\\/][^\\/]+$/, "") || ".";
      const clipName  = `${track.fileName.replace(/\.[^.]+$/, "")}_clip_${Date.now()}.wav`;
      const outPath   = `${basePath}/${clipName}`;

      await writeFile(outPath, wavBytes);

      // Insert into voice_tracks table so Voice Tracker picks it up immediately
      await (window as any).ether.voiceTracks.create({
        station_id: stationId, title: clipName.replace(".wav", ""), file_path: outPath,
        duration_ms: clip.sourceDurationMs, recorded_by: "Production Editor",
        recorded_at: Math.floor(Date.now() / 1000),
      });

      setStatus(`✓ Sent to Voice Tracker — "${clipName.replace(".wav","")}" ready to assign`);
      setContextMenu(null);
    } catch (e) {
      setStatus(`✗ Failed: ${e}`);
    }
  };

  // ── Send clip to a Live Assist deck ───────────────────────────

  const sendToDeck = async (clipId: string, deck: "A" | "B" | "C") => {
    const clip  = clips.find(c => c.id === clipId);
    if (!clip) return;
    const track = tracks.find(t => t.id === clip.trackId);
    if (!track?.buffer) { setStatus("No audio in that clip"); return; }

    setStatus(`Rendering for Deck ${deck}...`);
    try {
      const sr  = 44100;
      const dur = clip.sourceDurationMs / 1000;
      const ctx = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);

      const gain = ctx.createGain();
      gain.gain.value = dbToLinear(track.gainDb);
      const pan = ctx.createStereoPanner();
      pan.pan.value = track.pan;
      gain.connect(pan); pan.connect(ctx.destination);

      const src = ctx.createBufferSource();
      src.buffer = track.buffer;
      src.connect(gain);
      src.start(0, clip.sourceStartMs / 1000, dur);

      const rendered = await ctx.startRendering();
      const wavBytes = encodeWav(rendered);

      const basePath = track.filePath?.replace(/[\\/][^\\/]+$/, "") || ".";
      const clipName = `ether_deck${deck}_${Date.now()}.wav`;
      const outPath  = `${basePath}/${clipName}`;

      await writeFile(outPath, wavBytes);

      await invoke("audio_load", {
        deck,
        filePath: outPath,
        title: track.fileName.replace(/\.[^.]+$/, "") || `Deck ${deck} clip`,
        artist: "",
        gainDb: null,
      });

      setStatus(`✓ Loaded into Deck ${deck} — ready in Live Assist`);
      setContextMenu(null);
    } catch (e) {
      setStatus(`✗ Failed: ${e}`);
    }
  };

  // ── Timeline dimensions ───────────────────────────────────────

  const totalMs = Math.max(30000, ...clips.map(c => c.timelineStartMs + c.sourceDurationMs + 5000));
  const totalPx = msToX(totalMs, pps) + 60;

  // ── Render ────────────────────────────────────────────────────

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: "var(--bg-primary)", userSelect: clipDragRef.current ? "none" : "auto",
    }}>

      {/* ── Toolbar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
        padding: "8px 16px", borderBottom: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            Production Editor
          </div>
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", letterSpacing: "0.04em" }}>
            C = cut · J = join · S = snap · Space = play · Del = delete · Ctrl+Z = undo
          </div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          {/* Status */}
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {status}
          </span>

          <Sep />

          {/* Mode */}
          {(["select","cut"] as EditMode[]).map(m => (
            <Btn key={m} active={mode === m} onClick={() => setMode(m)}
              color={m === "cut" ? "#ef4444" : "#7dd3fc"}>
              {m === "select" ? "↖ Select" : "✂ Cut"}
            </Btn>
          ))}

          <Sep />

          {/* Undo / Redo */}
          <Btn onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)"
            style={{ opacity: canUndo ? 1 : 0.3 }}>
            ↩ Undo
          </Btn>
          <Btn onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"
            style={{ opacity: canRedo ? 1 : 0.3 }}>
            ↪ Redo
          </Btn>

          <Sep />

          {/* Zoom */}
          <Btn onClick={() => { const z = Math.max(0.25, zoom - 0.25); zoomRef.current = z; setZoom(z); }}>−</Btn>
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", minWidth: 38, textAlign: "center" as const, fontFamily: "monospace" }}>
            {Math.round(zoom * 100)}%
          </span>
          <Btn onClick={() => { const z = Math.min(8, zoom + 0.25); zoomRef.current = z; setZoom(z); }}>+</Btn>

          <Sep />

          {/* Snap / Ripple / Join */}
          <Btn active={snapEnabled} color="#fbbf24"
            onClick={() => setSnapEnabled(v => !v)}
            title="Snap to grid and clip edges (S)">
            ⊞ Snap
          </Btn>
          <Btn active={rippleEnabled} color="#f87171"
            onClick={() => setRippleEnabled(v => !v)}
            title="Ripple delete — close gap when deleting">
            ⟿ Ripple
          </Btn>
          <Btn onClick={joinClips} disabled={!selectedClipId}
            title="Join selected clip with next clip (J)"
            style={{ opacity: selectedClipId ? 1 : 0.35 }}>
            ⊔ Join
          </Btn>

          <Sep />

          {/* Transport */}
          <Btn onClick={() => { stopPlayback(); setPlayheadMs(0); }}>⏮</Btn>
          <Btn active={playing} color="#34d399"
            onClick={togglePlay} style={{ minWidth: 72 }}>
            {playing ? "⏸ Pause" : "▶ Play"}
          </Btn>
          <Btn active={recording} color="#ef4444"
            onClick={recording ? stopRecording : startRecording}
            style={{ minWidth: 80, animation: recording ? "rec-pulse 1s ease-in-out infinite" : "none" }}>
            {recording ? "⏹ Stop" : "● Record"}
          </Btn>

          <Sep />

          {/* Export */}
          <Btn color="#7dd3fc" onClick={exportWav} disabled={exporting}
            style={{ opacity: exporting ? 0.5 : 1 }}>
            {exporting ? "Rendering..." : "⬇ WAV"}
          </Btn>
          <Btn color="#7dd3fc" onClick={exportMp3} disabled={exporting}
            style={{ opacity: exporting ? 0.5 : 1 }}>
            ⬇ MP3
          </Btn>
          {(sourceSongId || tracks.some(t => t.buffer)) && (
            <Btn color="#34d399" onClick={bounceAndPlace} disabled={exporting}
              style={{
                opacity: exporting ? 0.5 : 1,
                background: "rgba(52,211,153,0.12)",
                border: "1px solid rgba(52,211,153,0.4)",
                fontWeight: 700,
              }}
              title="Render mix and save back to library — song plays with intro from now on">
              {exporting ? "Bouncing..." : "⚡ Bounce & Place"}
            </Btn>
          )}
        </div>
      </div>

      {/* ── Main area: controls + timeline ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ── Left: Track controls ── */}
        <div style={{
          width: CONTROLS_W, flexShrink: 0,
          borderRight: "1px solid var(--border-primary)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-secondary)",
        }}>
          {/* Ruler spacer */}
          <div style={{ height: RULER_H, borderBottom: "1px solid var(--border-primary)" }} />

          {tracks.map(track => {
            const isActiveTrack = recordTargetId === track.id;
            return (
            <div
              key={track.id}
              onClick={() => {
                setSelectedTrackId(track.id);
                setRecordTargetId(track.id);
              }}
              onContextMenu={e => {
                e.preventDefault();
                setTrackContextMenu({ x: e.clientX, y: e.clientY, trackId: track.id });
              }}
              style={{
                height: TRACK_H, flexShrink: 0,
                borderBottom: "1px solid rgba(255,255,255,0.05)",
                borderLeft: `3px solid ${isActiveTrack ? track.accentColor : "transparent"}`,
                padding: "6px 8px 6px 6px", display: "flex", flexDirection: "column", gap: 4,
                background: isActiveTrack ? `${track.accentColor}10` : "transparent",
                cursor: "pointer",
                transition: "background 0.15s, border-color 0.15s",
              }}>
              {/* Track header row */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {/* Record arm indicator */}
                <div style={{
                  width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                  background: isActiveTrack ? (recording ? "#ef4444" : track.accentColor) : "rgba(255,255,255,0.15)",
                  boxShadow: isActiveTrack && recording ? "0 0 6px #ef4444" : "none",
                  animation: isActiveTrack && recording ? "rec-pulse 1s ease-in-out infinite" : "none",
                }} />
                <span style={{ fontSize: 9, fontWeight: 800, color: track.buffer ? track.accentColor : "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>
                  {track.label}
                </span>
                <span style={{ fontSize: 9, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                  {track.fileName || "empty"}
                </span>
                <button onClick={() => browseFile(track.id)} style={miniBtn}>
                  {track.buffer ? "⟳" : "+"}
                </button>
              </div>

              {/* Controls row */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {/* Mute / Solo */}
                <button onClick={() => setTracks(p => p.map(t => t.id === track.id ? { ...t, muted: !t.muted } : t))}
                  style={{ ...miniBtn, background: track.muted ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.05)", color: track.muted ? "#ef4444" : "rgba(255,255,255,0.4)" }}>
                  M
                </button>
                <button onClick={() => setTracks(p => p.map(t => t.id === track.id ? { ...t, solo: !t.solo } : t))}
                  style={{ ...miniBtn, background: track.solo ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.05)", color: track.solo ? "#fbbf24" : "rgba(255,255,255,0.4)" }}>
                  S
                </button>

                {/* Gain */}
                <span style={{ fontSize: 8, color: "var(--text-tertiary)" }}>Gain</span>
                <input type="range" min={-18} max={12} step={0.5}
                  value={track.gainDb}
                  onChange={e => setTracks(p => p.map(t => t.id === track.id ? { ...t, gainDb: +e.target.value } : t))}
                  style={{ flex: 1, height: 3, accentColor: track.accentColor }} />
                <span style={{ fontSize: 8, fontFamily: "monospace", color: "rgba(255,255,255,0.3)", minWidth: 28, textAlign: "right" as const }}>
                  {track.gainDb > 0 ? "+" : ""}{track.gainDb.toFixed(1)}
                </span>

                {/* Normalize */}
                <button onClick={() => normalize(track.id)} style={miniBtn} title="Normalize to -1 dBFS">N</button>
              </div>

              {/* Pan + EQ row */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 8, color: "var(--text-tertiary)" }}>Pan</span>
                <input type="range" min={-1} max={1} step={0.05}
                  value={track.pan}
                  onChange={e => setTracks(p => p.map(t => t.id === track.id ? { ...t, pan: +e.target.value } : t))}
                  style={{ width: 60, height: 3, accentColor: track.accentColor }} />
                <span style={{ fontSize: 8, fontFamily: "monospace", color: "rgba(255,255,255,0.3)", minWidth: 20 }}>
                  {track.pan === 0 ? "C" : track.pan < 0 ? `L${Math.abs(Math.round(track.pan * 100))}` : `R${Math.round(track.pan * 100)}`}
                </span>

                <Sep small />

                {/* EQ toggle */}
                <button
                  onClick={() => setTracks(p => p.map(t => t.id === track.id ? { ...t, eqEnabled: !t.eqEnabled } : t))}
                  style={{ ...miniBtn, background: track.eqEnabled ? "rgba(139,92,246,0.2)" : "rgba(255,255,255,0.05)", color: track.eqEnabled ? "#8b5cf6" : "rgba(255,255,255,0.3)" }}>
                  EQ
                </button>

                {track.eqEnabled && (
                  <>
                    {(["eqLowDb","eqMidDb","eqHighDb"] as const).map((key, ki) => (
                      <input key={key} type="range" min={-12} max={12} step={0.5}
                        value={track[key]}
                        title={["Low","Mid","High"][ki] + ` EQ: ${track[key] > 0 ? "+" : ""}${track[key].toFixed(1)} dB`}
                        onChange={e => setTracks(p => p.map(t => t.id === track.id ? { ...t, [key]: +e.target.value } : t))}
                        style={{ width: 32, height: 3, accentColor: ["#f87171","#fbbf24","#34d399"][ki] }} />
                    ))}
                  </>
                )}
              </div>
            </div>
          );})}
        </div>

        {/* ── Right: Timeline ── */}
        <div
          ref={scrollRef}
          onClick={onTimelineClick}
          onMouseMove={onTimelineMouseMove}
          onMouseLeave={onTimelineMouseLeave}
          onWheel={onTimelineWheel}
          style={{ flex: 1, minWidth: 0, overflow: "auto", position: "relative" as const, background: "rgba(8,8,14,0.98)", cursor: mode === "cut" ? "none" : "default" }}
        >
          <div
            ref={timelineRef}
            style={{
              position: "relative" as const,
              minWidth: totalPx,
              minHeight: RULER_H + tracks.length * TRACK_H + 20,
            }}
          >
            {/* ── Ruler ── */}
            <div style={{
              position: "sticky" as const, top: 0, zIndex: 10,
              height: RULER_H, background: "rgba(12,12,20,0.99)",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              pointerEvents: mode === "cut" ? "none" : "auto",
            }}>
              {Array.from({ length: Math.ceil(totalMs / 1000) + 1 }, (_, i) => {
                const x   = msToX(i * 1000, pps);
                const big = i % 5 === 0;
                return (
                  <div key={i} style={{ position: "absolute" as const, left: x, bottom: 0, display: "flex", flexDirection: "column" as const, alignItems: "center" }}>
                    <div style={{ width: 1, height: big ? 12 : 6, background: big ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)" }} />
                    {big && <span style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", marginTop: 1 }}>{fmtMs(i * 1000)}</span>}
                  </div>
                );
              })}
            </div>

            {/* ── Track rows ── */}
            {tracks.map((track, ti) => (
              <div
                key={track.id}
                onDragOver={e => e.preventDefault()}
                onDrop={e => onTrackDrop(e, track.id)}
                onClick={e => {
                  if (mode === "cut") return;
                  e.stopPropagation();
                  setSelectedTrackId(track.id);
                  setRecordTargetId(track.id);
                }}
                onContextMenu={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  setTrackContextMenu({ x: e.clientX, y: e.clientY, trackId: track.id });
                  setSelectedTrackId(track.id);
                  setRecordTargetId(track.id);
                }}
                style={{
                  position: "absolute" as const,
                  top: RULER_H + ti * TRACK_H,
                  left: 0, right: 0, height: TRACK_H,
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  background: recordTargetId === track.id ? `${track.accentColor}08` : "transparent",
                  borderLeft: `2px solid ${recordTargetId === track.id ? track.accentColor + "60" : "transparent"}`,
                }}
              >
                {/* Live waveform canvas — shows while recording into this track */}
                {recording && recordTargetId === track.id && (
                  <canvas
                    ref={liveCanvasRef}
                    style={{
                      position: "absolute" as const,
                      left: msToX(playheadMs, pps),
                      top: 4, bottom: 4, right: 0,
                      height: TRACK_H - 8,
                      pointerEvents: "none",
                      zIndex: 8,
                      borderRadius: 0,
                      border: `1px solid ${track.accentColor}55`,
                    }}
                  />
                )}

                {/* Empty drop hint */}
                {!track.buffer && !recording && (
                  <div style={{
                    position: "absolute" as const, left: 20, top: "50%", transform: "translateY(-50%)",
                    fontSize: 10, color: "rgba(255,255,255,0.15)", fontStyle: "italic",
                  }}>
                    Drop audio here or click + to load
                  </div>
                )}

                {/* Clips */}
                {clips.filter(c => c.trackId === track.id).map(clip => {
                  const left = msToX(clip.timelineStartMs, pps);
                  const w    = Math.max(4, msToX(clip.sourceDurationMs, pps));
                  const isSelected = selectedClipId === clip.id;

                  return (
                    <div
                      key={clip.id}
                      onMouseDown={e => {
                        if (mode === "cut") return;
                        e.stopPropagation();
                        startClipDrag(e, clip.id, "move");
                      }}
                      onClick={e => {
                        if (mode === "cut") return;
                        e.stopPropagation();
                        setSelectedClipId(clip.id);
                      }}
                      onContextMenu={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        setContextMenu({ x: e.clientX, y: e.clientY, clipId: clip.id, trackId: track.id });
                        setSelectedClipId(clip.id);
                      }}
                      style={{
                        position: "absolute" as const,
                        left, top: 6, width: w, height: TRACK_H - 12,
                        borderRadius: 0,
                        background: track.color,
                        border: `1px solid ${isSelected ? track.accentColor : track.accentColor + "55"}`,
                        boxShadow: isSelected ? `0 0 0 1.5px ${track.accentColor}` : "none",
                        cursor: mode === "cut" ? "none" : "grab",
                        overflow: "hidden",
                        zIndex: isSelected ? 5 : 2,
                      }}
                    >
                      {/* Waveform canvas */}
                      <canvas
                        ref={el => { canvasRefs.current[clip.id] = el; }}
                        style={{ position: "absolute" as const, inset: 0, pointerEvents: "none" }}
                      />

                      {/* Fade in overlay */}
                      {clip.fadeInMs > 0 && (
                        <div style={{
                          position: "absolute" as const, left: 0, top: 0, bottom: 0,
                          width: msToX(clip.fadeInMs, pps),
                          background: `linear-gradient(to right, rgba(0,0,0,0.7), transparent)`,
                          pointerEvents: "none",
                        }} />
                      )}

                      {/* Fade out overlay */}
                      {clip.fadeOutMs > 0 && (
                        <div style={{
                          position: "absolute" as const, right: 0, top: 0, bottom: 0,
                          width: msToX(clip.fadeOutMs, pps),
                          background: `linear-gradient(to left, rgba(0,0,0,0.7), transparent)`,
                          pointerEvents: "none",
                        }} />
                      )}

                      {/* Trim handle — start */}
                      <div
                        onMouseDown={e => {
                        if (mode === "cut") return;
                        e.stopPropagation(); startClipDrag(e, clip.id, "trim-start");
                      }}
                        style={{
                          position: "absolute" as const, left: 0, top: 0, bottom: 0, width: 6,
                          background: track.accentColor, opacity: 0.8, cursor: "ew-resize", zIndex: 4,
                          borderRadius: "4px 0 0 4px",
                        }}
                      />

                      {/* Trim handle — end */}
                      <div
                        onMouseDown={e => {
                        if (mode === "cut") return;
                        e.stopPropagation(); startClipDrag(e, clip.id, "trim-end");
                      }}
                        style={{
                          position: "absolute" as const, right: 0, top: 0, bottom: 0, width: 6,
                          background: track.accentColor, opacity: 0.8, cursor: "ew-resize", zIndex: 4,
                          borderRadius: "0 4px 4px 0",
                        }}
                      />

                      {/* Fade-in handle */}
                      <div
                        onMouseDown={e => {
                        if (mode === "cut") return;
                        e.stopPropagation(); startClipDrag(e, clip.id, "fade-in");
                      }}
                        style={{
                          position: "absolute" as const, left: msToX(clip.fadeInMs, pps), top: 0,
                          width: FADE_HANDLE, height: FADE_HANDLE,
                          background: track.accentColor, opacity: 0.7,
                          borderRadius: "0 0 6px 0", cursor: "ew-resize", zIndex: 5,
                        }}
                        title="Drag right to fade in"
                      />

                      {/* Fade-out handle */}
                      <div
                        onMouseDown={e => {
                        if (mode === "cut") return;
                        e.stopPropagation(); startClipDrag(e, clip.id, "fade-out");
                      }}
                        style={{
                          position: "absolute" as const, right: msToX(clip.fadeOutMs, pps), top: 0,
                          width: FADE_HANDLE, height: FADE_HANDLE,
                          background: track.accentColor, opacity: 0.7,
                          borderRadius: "0 0 0 6px", cursor: "ew-resize", zIndex: 5,
                        }}
                        title="Drag left to fade out"
                      />

                      {/* Delete button — shows on selection */}
                      {isSelected && (
                        <button
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); deleteClip(clip.id); }}
                          style={{
                            position: "absolute" as const, top: 2, right: 10,
                            background: "rgba(239,68,68,0.8)", border: "none",
                            color: "#fff", fontSize: 10, fontWeight: 700,
                            borderRadius: 0, padding: "1px 5px", cursor: "pointer",
                            zIndex: 6,
                          }}
                        >
                          ✕
                        </button>
                      )}

                      {/* Duration label */}
                      <div style={{
                        position: "absolute" as const, bottom: 3, left: 8,
                        fontSize: 8, color: track.accentColor,
                        fontFamily: "monospace", pointerEvents: "none",
                        opacity: 0.8,
                      }}>
                        {fmtMs(clip.sourceDurationMs)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            {/* ── Snap indicator — yellow flash when snapping ── */}
            {snapIndicatorMs !== null && (
              <div style={{
                position: "absolute" as const,
                left: msToX(snapIndicatorMs, pps),
                top: 0, bottom: 0, width: 2,
                background: "rgba(251,191,36,0.8)",
                boxShadow: "0 0 8px rgba(251,191,36,0.6)",
                pointerEvents: "none",
                zIndex: 18,
              }} />
            )}

            {/* ── Playhead ── */}
            <div style={{
              position: "absolute" as const,
              left: msToX(playheadMs, pps),
              top: 0, bottom: 0, width: 2,
              background: "#ef4444",
              boxShadow: "0 0 8px rgba(239,68,68,0.6)",
              pointerEvents: "none",
              zIndex: 20,
            }}>
              <div style={{
                position: "absolute" as const, top: 0,
                left: -5, width: 12, height: 12,
                background: "#ef4444",
                clipPath: "polygon(50% 100%, 0% 0%, 100% 0%)",
              }} />
              <div style={{
                position: "absolute" as const, top: 14, left: 4,
                fontSize: 8, color: "#ef4444", fontFamily: "monospace",
                background: "rgba(8,8,14,0.85)", padding: "1px 4px", borderRadius: 0,
                whiteSpace: "nowrap" as const, pointerEvents: "none",
              }}>
                {fmtMs(playheadMs)}
              </div>
            </div>

            {/* ── Precision cursor — dotted line that follows mouse ── */}
            {cursorOnTimeline && cursorMs !== null && (
              <div style={{
                position: "absolute" as const,
                left: msToX(cursorMs, pps),
                top: 0, bottom: 0,
                width: 1,
                // Dotted line using repeating-linear-gradient
                backgroundImage: mode === "cut"
                  ? "repeating-linear-gradient(to bottom, #ef4444 0px, #ef4444 4px, transparent 4px, transparent 8px)"
                  : "repeating-linear-gradient(to bottom, rgba(255,255,255,0.4) 0px, rgba(255,255,255,0.4) 4px, transparent 4px, transparent 8px)",
                pointerEvents: "none",
                zIndex: 19,
              }}>
                {/* Timestamp tooltip — stays in ruler area */}
                <div style={{
                  position: "absolute" as const,
                  top: Math.max(4, Math.min(RULER_H - 18, cursorY - RULER_H)),
                  left: 5,
                  fontSize: 9,
                  fontFamily: "monospace",
                  fontWeight: 700,
                  color: mode === "cut" ? "#ef4444" : "rgba(255,255,255,0.7)",
                  background: "rgba(8,8,14,0.92)",
                  border: `1px solid ${mode === "cut" ? "rgba(239,68,68,0.4)" : "rgba(255,255,255,0.15)"}`,
                  padding: "2px 5px",
                  borderRadius: 0,
                  whiteSpace: "nowrap" as const,
                  pointerEvents: "none",
                  letterSpacing: "0.04em",
                }}>
                  {mode === "cut" && <span style={{ marginRight: 4 }}>✂</span>}
                  {fmtMs(cursorMs)}
                </div>

                {/* Cut mode: scissors follow the mouse Y position */}
                {mode === "cut" && (
                  <div style={{
                    position: "absolute" as const,
                    top: Math.max(RULER_H, cursorY - 8),
                    left: -10,
                    fontSize: 16,
                    lineHeight: 1,
                    pointerEvents: "none",
                    userSelect: "none" as const,
                    color: "#ef4444",
                    filter: "drop-shadow(0 0 4px rgba(239,68,68,0.9))",
                    transform: "rotate(-45deg)",
                    transition: "top 0.02s linear",
                  }}>
                    ✂
                  </div>
                )}

                {/* Snap dots at track midpoints */}
                {tracks.map((_, ti) => (
                  <div key={ti} style={{
                    position: "absolute" as const,
                    top: RULER_H + ti * TRACK_H + TRACK_H / 2 - 3,
                    left: -3,
                    width: 7, height: 7,
                    borderRadius: "50%",
                    background: mode === "cut" ? "#ef4444" : "rgba(255,255,255,0.5)",
                    pointerEvents: "none",
                  }} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{
        flexShrink: 0, padding: "4px 16px",
        borderTop: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
        display: "flex", alignItems: "center", gap: 16, fontSize: 10,
        color: "var(--text-tertiary)",
      }}>
        {tracks.map(t => t.buffer && (
          <span key={t.id}>
            <span style={{ color: t.accentColor, fontWeight: 700 }}>{t.label}</span>
            {" "}{fmtMs(t.durationMs)}
            {t.peakDb !== null && (
              <span style={{ opacity: 0.5 }}> peak {t.peakDb.toFixed(1)}dB</span>
            )}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>
          {fmtMs(playheadMs)} / {fmtMs(totalMs - 5000)}
          {cursorOnTimeline && cursorMs !== null && (
            <span style={{ marginLeft: 8, color: mode === "cut" ? "#ef4444" : "rgba(255,255,255,0.4)" }}>
              {mode === "cut" ? "✂ " : "↗ "}{fmtMs(cursorMs)}
            </span>
          )}
        </span>
      </div>

      {/* ── Track right-click context menu ── */}
      {trackContextMenu && (
        <div
          onClick={() => setTrackContextMenu(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: "fixed",
              left: trackContextMenu.x, top: trackContextMenu.y,
              zIndex: 9999,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-primary)",
              borderRadius: 0, padding: "4px 0",
              minWidth: 210,
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
              fontFamily: "'Inter', system-ui, sans-serif",
            }}
          >
            {/* Header */}
            <div style={{ padding: "6px 14px 4px", borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 4 }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>
                {tracks.find(t => t.id === trackContextMenu.trackId)?.label} track
              </div>
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 1 }}>
                {tracks.find(t => t.id === trackContextMenu.trackId)?.fileName || "empty"}
              </div>
            </div>

            {/* Load file */}
            <CtxItem icon="+" label="Load audio file..." onClick={() => {
              browseFile(trackContextMenu.trackId);
              setTrackContextMenu(null);
            }} />
            <CtxItem icon="✦" label="Open in Cue Editor" color="var(--accent-cyan)" onClick={() => {
              const track = tracks.find(t => t.id === trackContextMenu.trackId);
              if (track?.filePath) onOpenCueEditor?.(track.filePath);
              setTrackContextMenu(null);
            }} />

            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />

            {/* Send to deck */}
            <div style={{ padding: "4px 14px 2px", fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>
              SEND TO LIVE ASSIST DECK
            </div>
            <CtxItem icon="A" label="Load into Deck A" color="var(--accent-blue)" onClick={() => {
              const track = tracks.find(t => t.id === trackContextMenu.trackId);
              const clip  = clips.find(c => c.trackId === trackContextMenu.trackId);
              if (clip) sendToDeck(clip.id, "A");
              else if (track?.filePath) {
                invoke("audio_load", { deck: "A", filePath: track.filePath, title: track.fileName || "", artist: "", gainDb: null });
                setStatus("✓ Loaded into Deck A");
              }
              setTrackContextMenu(null);
            }} />
            <CtxItem icon="B" label="Load into Deck B" color="#34d399" onClick={() => {
              const track = tracks.find(t => t.id === trackContextMenu.trackId);
              const clip  = clips.find(c => c.trackId === trackContextMenu.trackId);
              if (clip) sendToDeck(clip.id, "B");
              else if (track?.filePath) {
                invoke("audio_load", { deck: "B", filePath: track.filePath, title: track.fileName || "", artist: "", gainDb: null });
                setStatus("✓ Loaded into Deck B");
              }
              setTrackContextMenu(null);
            }} />
            <CtxItem icon="C" label="Load into Deck C" color="#a78bfa" onClick={() => {
              const track = tracks.find(t => t.id === trackContextMenu.trackId);
              const clip  = clips.find(c => c.trackId === trackContextMenu.trackId);
              if (clip) sendToDeck(clip.id, "C");
              else if (track?.filePath) {
                invoke("audio_load", { deck: "C", filePath: track.filePath, title: track.fileName || "", artist: "", gainDb: null });
                setStatus("✓ Loaded into Deck C");
              }
              setTrackContextMenu(null);
            }} />

            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />

            <CtxItem icon="🎙" label="Send to Voice Tracker" color="#a78bfa" onClick={() => {
              const clip = clips.find(c => c.trackId === trackContextMenu.trackId);
              if (clip) sendToVoiceTracker(clip.id);
              setTrackContextMenu(null);
            }} />
            <CtxItem icon="⚡" label="Bounce & Place" color="#34d399" onClick={() => {
              bounceAndPlace();
              setTrackContextMenu(null);
            }} />
          </div>
        </div>
      )}

      {/* ── Right-click context menu ── */}
      {contextMenu && (
        <div
          onClick={() => setContextMenu(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 9998,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: "fixed",
              left: contextMenu.x, top: contextMenu.y,
              zIndex: 9999,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-primary)",
              borderRadius: 0, padding: "4px 0",
              minWidth: 200,
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
              fontFamily: "'Inter', system-ui, sans-serif",
            }}
          >
            {/* Header */}
            <div style={{ padding: "6px 14px 4px", borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 4 }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>
                {tracks.find(t => t.id === contextMenu.trackId)?.label} track
              </div>
              <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 1 }}>
                {fmtMs(clips.find(c => c.id === contextMenu.clipId)?.sourceDurationMs || 0)}
              </div>
            </div>

            {/* Actions */}
            <CtxItem icon="✂" label="Cut clip here" onClick={() => {
              const clip = clips.find(c => c.id === contextMenu.clipId);
              if (clip) cutAtMs(clip.timelineStartMs + clip.sourceDurationMs / 2);
              setContextMenu(null);
            }} />
            <CtxItem icon="⊔" label="Join with next clip" onClick={() => {
              setSelectedClipId(contextMenu.clipId);
              joinClips();
              setContextMenu(null);
            }} />
            <CtxItem icon="N" label="Normalize to -1 dBFS" onClick={() => {
              normalize(contextMenu.trackId);
              setContextMenu(null);
            }} />

            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />

            {/* Send to Deck */}
            <div style={{ padding: "4px 14px 2px", fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>
              SEND TO DECK
            </div>
            <CtxItem icon="A" label="Load into Deck A" color="var(--accent-blue)" onClick={() => {
              sendToDeck(contextMenu.clipId, "A");
            }} />
            <CtxItem icon="B" label="Load into Deck B" color="#34d399" onClick={() => {
              sendToDeck(contextMenu.clipId, "B");
            }} />
            <CtxItem icon="C" label="Load into Deck C" color="#a78bfa" onClick={() => {
              sendToDeck(contextMenu.clipId, "C");
            }} />

            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />

            <CtxItem icon="🎙" label="Send to Voice Tracker" color="#a78bfa" onClick={() => {
              sendToVoiceTracker(contextMenu.clipId);
            }} />
            <CtxItem icon="⚡" label="Bounce & Place" color="#34d399" onClick={() => {
              bounceAndPlace();
              setContextMenu(null);
            }} />
            <CtxItem icon="✦" label="Open in Cue Editor" color="var(--accent-cyan)" onClick={() => {
              const track = tracks.find(t => t.id === contextMenu.trackId);
              if (track?.filePath) onOpenCueEditor?.(track.filePath);
              setContextMenu(null);
            }} />

            <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />

            <CtxItem icon="✕" label="Delete clip" color="#ef4444" onClick={() => {
              deleteClip(contextMenu.clipId);
              setContextMenu(null);
            }} />
          </div>
        </div>
      )}

      <style>{`
        @keyframes rec-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>
    </div>
  );
}

// ── Small UI helpers ───────────────────────────────────────────

function CtxItem({ icon, label, onClick, color }: {
  icon: string; label: string; onClick: () => void; color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 9,
        width: "100%", padding: "7px 14px", border: "none",
        background: "transparent", cursor: "pointer", textAlign: "left" as const,
        fontSize: 12, color: color || "var(--text-primary)",
        transition: "background 0.1s",
      }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)"}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
    >
      <span style={{ fontSize: 11, width: 16, textAlign: "center" as const, opacity: 0.7 }}>{icon}</span>
      {label}
    </button>
  );
}

function Btn({ children, onClick, active, color, disabled, style, title }: {
  children: React.ReactNode; onClick?: () => void;
  active?: boolean; color?: string; disabled?: boolean;
  style?: React.CSSProperties; title?: string;
}) {
  const c = color || "#7dd3fc";
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
      cursor: disabled ? "default" : "pointer",
      background: active ? `${c}22` : "var(--bg-tertiary)",
      color: active ? c : "var(--text-secondary)",
      border: `1px solid ${active ? c + "55" : "var(--border-primary)"}`,
      display: "flex", alignItems: "center", gap: 4,
      ...style,
    }}>
      {children}
    </button>
  );
}

function Sep({ small }: { small?: boolean }) {
  return <div style={{ width: 1, height: small ? 12 : 20, background: "var(--border-primary)", flexShrink: 0 }} />;
}

const miniBtn: React.CSSProperties = {
  padding: "1px 5px", borderRadius: 0, fontSize: 9, fontWeight: 700,
  background: "rgba(255,255,255,0.05)", color: "rgba(255,255,255,0.4)",
  border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer",
};
