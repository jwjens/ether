import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { query } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { useAudioEngine } from "../audio/AudioEngineContext";
import WaveformEditor from "./WaveformEditor";
import { decodeBlobToBuffer, extractPeaks, extractPeaksRange, encodeWav, wavToDataUrl, spliceOut, sliceRegion, insertAt, makeSilence, applyFadeRegion } from "../audio/wavEdit";
import { vuSmooth, vuPeak } from "../lib/vuMeter";

// ─── Types ────────────────────────────────────────────────────

interface VoiceTrack {
  id: number; title: string; file_path: string;
  show_id: number | null; duration_ms: number;
  recorded_by: string | null; recorded_at: number;
  clock_slot_id: number | null;
}

interface Show {
  id: number; name: string; start_hour: number; end_hour: number;
  color: string | null; clock_id: number | null;
}

interface Clock {
  id: number; name: string; color: string | null;
}

interface ClockSlot {
  id: number; clock_id: number; position: number;
  slot_type: string; label: string | null;
  duration_min: number; category_code?: string;
  voice_track_id?: number | null;
  voice_track_title?: string | null;
}

interface ScheduledSong {
  position: number; title: string; artist: string | null; duration_ms: number;
}

// ─── Utilities ────────────────────────────────────────────────

function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}
function fmtMsFull(ms: number) {
  const s = ms / 1000;
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" +
    String(Math.floor(s % 60)).padStart(2, "0") + "." +
    Math.floor((s % 1) * 10);
}
function fmtHour(h: number) {
  if (h === 0)  return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}
function fmtDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(min: number): string {
  if (min <= 0) return "open";
  const totalSec = Math.round(min * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `:${String(s).padStart(2, "0")}`;
  if (s === 0) return `${m}:00`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const SLOT_COLOR: Record<string, string> = {
  talkset: "#a78bfa", talk_break: "#a78bfa", spot_break: "#f87171",
  music: "var(--accent-blue)", liner: "#fb923c", sweeper: "#34d399",
  news: "#fbbf24", jingle: "#e879f9",
};
const isTalkSlot = (t: string) => t === "talkset" || t === "talk_break";

// ─── Canvas VU Meter ──────────────────────────────────────────

function HorizontalVU({ level, peak, recording }: { level: number; peak: number; recording: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef(0);
  // Live values fed in via refs so the draw loop is PERSISTENT (no per-frame effect teardown,
  // which is what made it glitchy). Smoothing uses Ether's shared attack/decay ballistics.
  const targetRef = useRef(0);
  const recRef    = useRef(recording);
  const smoothRef = useRef(0);
  const peakRef   = useRef(0);
  const peakAtRef = useRef(0);
  const lastMsRef = useRef(0);
  useEffect(() => { targetRef.current = level; }, [level]);
  useEffect(() => { recRef.current = recording; if (!recording) { smoothRef.current = 0; peakRef.current = 0; } }, [recording]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.floor(e.contentRect.width * dpr);
        canvas.height = Math.floor(e.contentRect.height * dpr);
        canvas.style.width  = e.contentRect.width + "px";
        canvas.style.height = e.contentRect.height + "px";
      }
    });
    ro.observe(canvas);

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return; }
      const w = canvas.width, h = canvas.height;
      const dpr = window.devicePixelRatio || 1;
      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const dt = Math.min(now - (lastMsRef.current || now), 100); lastMsRef.current = now;

      ctx.clearRect(0, 0, w, h);
      const cs = getComputedStyle(canvas);
      ctx.fillStyle = cs.getPropertyValue("--bg-primary").trim() || "#0d0d0f";
      ctx.fillRect(0, 0, w, h);

      // dB scale labels
      ctx.font = `${8 * dpr}px 'DM Mono', monospace`;
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.textBaseline = "top";
      const labels = [{ db: -40, pct: 0 }, { db: -20, pct: 0.25 }, { db: -10, pct: 0.5 }, { db: -6, pct: 0.65 }, { db: -3, pct: 0.8 }, { db: 0, pct: 1 }];
      for (const l of labels) {
        const x = l.pct * w;
        ctx.fillText(`${l.db}`, x + 2 * dpr, 2 * dpr);
        ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.fillRect(x, 0, 1, h); ctx.fillStyle = "rgba(255,255,255,0.18)";
      }

      // Smoothed level (delta-time attack/decay) — independent of the 20 Hz feed → no jitter
      const target = recRef.current ? Math.min(1, targetRef.current * 5) : 0;
      smoothRef.current = vuSmooth(smoothRef.current, target, dt);
      const lvl = smoothRef.current;
      const pkb = vuPeak(peakRef.current, peakAtRef.current, lvl, now, dt);
      peakRef.current = pkb.peak; peakAtRef.current = pkb.at;

      const barTop = 14 * dpr, barH = h - barTop - 4 * dpr;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#34d399"); grad.addColorStop(0.6, "#c0a020"); grad.addColorStop(0.85, "#c02828");
      ctx.fillStyle = grad; ctx.fillRect(0, barTop, lvl * w, barH);

      // Peak-hold line
      if (recRef.current && peakRef.current > 0.02) {
        const pkX = peakRef.current * w;
        ctx.fillStyle = peakRef.current > 0.8 ? "#ef4444" : peakRef.current > 0.6 ? "#fbbf24" : "#34d399";
        ctx.fillRect(pkX - 1 * dpr, barTop, 2 * dpr, barH);
      }

      // Status label
      ctx.font = `bold ${9 * dpr}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillStyle = !recRef.current ? "rgba(255,255,255,0.12)" : lvl > 0.8 ? "#ef4444" : lvl > 0.4 ? "#fbbf24" : "#34d399";
      const label = !recRef.current ? "STANDBY" : lvl > 0.8 ? "HOT" : lvl > 0.4 ? "GOOD" : "LOW";
      ctx.fillText(label, w - ctx.measureText(label).width - 4 * dpr, barTop + barH / 2);

      rafRef.current = requestAnimationFrame(draw);
    };
    draw();
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current); };
  }, []);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}

// ─── Song Context Lane ────────────────────────────────────────

function SongLane({ song, label, color }: { song: ScheduledSong | null; label: string; color: string }) {
  return (
    <div style={{
      height: 56, display: "flex", alignItems: "center", gap: 12,
      padding: "0 16px", borderBottom: "1px solid var(--border-primary)",
      background: "var(--bg-secondary)",
    }}>
      <div style={{ width: 4, height: 32, background: color, flexShrink: 0 }} />
      <div style={{ width: 18, fontSize: 13, color: "var(--text-tertiary)", flexShrink: 0 }}>
        {label === "prev" ? "♫" : "♫"}
      </div>
      {song ? (
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {song.title}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
            {song.artist || "Unknown"} &middot; {fmtMs(song.duration_ms)}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>
          {label === "prev" ? "Previous song" : "Next song"} &mdash; select a break slot &rarr;
        </div>
      )}
      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>
        {label === "prev" ? "TAIL" : "INTRO"}
      </div>
    </div>
  );
}

// ─── Slot Card ────────────────────────────────────────────────

function SlotCard({
  slot, tracks, selectedTrackId, isSelected, onAssign, onUnassign, onPlay, onRecordFor, onSelect, playingId,
}: {
  slot: ClockSlot; tracks: VoiceTrack[]; selectedTrackId: number | null;
  isSelected: boolean;
  onAssign: (slotId: number, trackId: number) => void;
  onUnassign: (slotId: number) => void;
  onPlay: (t: VoiceTrack) => void;
  onRecordFor: (slot: ClockSlot) => void;
  onSelect: (slot: ClockSlot) => void;
  playingId: number | null;
}) {
  const isTalk = isTalkSlot(slot.slot_type);
  const color = SLOT_COLOR[slot.slot_type] || "#64748b";
  const assigned = tracks.find(t => t.clock_slot_id === slot.id);
  const isPlaying = assigned ? playingId === assigned.id : false;
  const canReceive = isTalk && !assigned && selectedTrackId !== null;
  const targetMs = slot.duration_min * 60000;
  const actualMs = assigned?.duration_ms ?? 0;
  const diff = actualMs - targetMs;
  const diffLabel = Math.abs(diff) < 3000 ? null : diff > 0 ? `+${fmtMs(diff)}` : `-${fmtMs(Math.abs(diff))}`;
  const diffColor = !diffLabel ? "#34d399" : diff > 5000 ? "#fbbf24" : diff < -10000 ? "#f87171" : "#34d399";

  if (!isTalk) return null; // only render talk slots

  return (
    <div
      onClick={() => {
        if (canReceive) onAssign(slot.id, selectedTrackId!);
        else onSelect(slot);
      }}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 10px", borderRadius: 0,
        background: isSelected ? "rgba(167,139,250,0.08)" : canReceive ? color + "10" : "var(--bg-tertiary)",
        border: isSelected ? "1px solid #a78bfa" : canReceive ? `2px dashed ${color}` : "1px solid var(--border-primary)",
        cursor: "pointer", transition: "all 0.12s",
      }}
    >
      <div style={{ width: 22, height: 22, background: color + "22", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 9, fontWeight: 800, color }}>{slot.position + 1}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {slot.label || "Talk Break"}
        </div>
        <div style={{ fontSize: 8, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>
          target {fmtDuration(slot.duration_min)}
        </div>
      </div>
      {assigned ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={e => { e.stopPropagation(); onPlay(assigned); }}
            style={{ width: 22, height: 22, borderRadius: 0, border: "none", background: isPlaying ? "var(--accent-green)" : "var(--bg-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isPlaying ? "#000" : "var(--text-secondary)" }}>
            {isPlaying
              ? <svg width="7" height="8" viewBox="0 0 8 9" fill="currentColor"><rect x="0" y="0" width="2.5" height="9"/><rect x="5" y="0" width="2.5" height="9"/></svg>
              : <svg width="7" height="8" viewBox="0 0 6 8" fill="currentColor" style={{ marginLeft: 1 }}><polygon points="0,0 6,4 0,8"/></svg>}
          </button>
          <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)" }}>{fmtMs(actualMs)}</span>
          {diffLabel && <span style={{ fontSize: 8, fontWeight: 700, color: diffColor, background: diffColor + "18", padding: "1px 4px" }}>{diffLabel}</span>}
          <span style={{ fontSize: 8, color: "#34d399" }}>✓</span>
          <button onClick={e => { e.stopPropagation(); onUnassign(slot.id); }}
            style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "2px" }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}>✕</button>
        </div>
      ) : canReceive ? (
        <span style={{ fontSize: 9, fontWeight: 700, color, padding: "2px 8px", background: color + "20", border: `1px solid ${color}50` }}>Assign</span>
      ) : (
        <button onClick={e => { e.stopPropagation(); onRecordFor(slot); }}
          style={{ fontSize: 8, fontWeight: 700, padding: "3px 8px", background: color + "15", border: `1px solid ${color}35`, color, cursor: "pointer", borderRadius: 0, letterSpacing: "0.04em" }}>● REC</button>
      )}
    </div>
  );
}

// ─── Track Card ───────────────────────────────────────────────

function TrackCard({
  track, selected, onSelect, onPlay, onQueue, onDelete, playingId, playProgress,
}: {
  track: VoiceTrack; selected: boolean;
  onSelect: (id: number | null) => void; onPlay: (t: VoiceTrack) => void;
  onQueue: (t: VoiceTrack) => void; onDelete: (id: number) => void;
  playingId: number | null; playProgress: Record<number, number>;
}) {
  const isPlaying = playingId === track.id;
  const progress = playProgress[track.id] || 0;
  return (
    <div onClick={() => onSelect(selected ? null : track.id)}
      style={{
        padding: "8px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
        background: selected ? "rgba(167,139,250,0.10)" : "var(--bg-tertiary)",
        border: selected ? "1px solid #a78bfa" : "1px solid var(--border-primary)",
        transition: "all 0.12s",
      }}>
      <button onClick={e => { e.stopPropagation(); onPlay(track); }}
        style={{ width: 24, height: 24, borderRadius: 0, flexShrink: 0, background: isPlaying ? "var(--accent-green)" : "var(--bg-secondary)", border: `1px solid ${isPlaying ? "var(--accent-green)" : "var(--border-secondary)"}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isPlaying ? "#000" : "var(--text-secondary)" }}>
        {isPlaying
          ? <svg width="7" height="8" viewBox="0 0 8 9" fill="currentColor"><rect x="0" y="0" width="2.5" height="9"/><rect x="5" y="0" width="2.5" height="9"/></svg>
          : <svg width="6" height="7" viewBox="0 0 6 8" fill="currentColor" style={{ marginLeft: 1 }}><polygon points="0,0 6,4 0,8"/></svg>}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: selected ? "#a78bfa" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{track.title}</span>
          <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", marginLeft: "auto", flexShrink: 0 }}>{fmtMs(track.duration_ms)}</span>
        </div>
        <div style={{ height: 2, background: "var(--bg-secondary)", marginTop: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: (progress * 100) + "%", background: "var(--accent-green)" }} />
        </div>
        <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 8, color: "var(--text-tertiary)" }}>{fmtDate(track.recorded_at)}</span>
          {track.clock_slot_id
            ? <span style={{ fontSize: 7, fontWeight: 700, background: "rgba(52,211,153,0.15)", color: "#34d399", padding: "1px 4px" }}>ASSIGNED</span>
            : null}
        </div>
      </div>
      <button onClick={e => { e.stopPropagation(); onQueue(track); }} style={{ padding: "2px 6px", fontSize: 8, fontWeight: 700, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", borderRadius: 0 }}>Q</button>
      <button onClick={e => { e.stopPropagation(); onDelete(track.id); }} style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "2px" }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}>✕</button>
    </div>
  );
}

// ─── 60-minute hour-fill meter ────────────────────────────────
// Vertical gauge: 0 at top → 60 min at bottom, filled by the hour's total time
// (songs + planned talk breaks). Yellow while building, green on-target (59–60),
// red when over the hour.

function HourMeter({ totalSec }: { totalSec: number }) {
  const pct = Math.min(1, totalSec / 3600);
  const over = totalSec > 3600;
  const onTarget = totalSec >= 3540 && totalSec <= 3600;
  const color = over ? "#ef4444" : onTarget ? "#34d399" : "#fbbf24";
  const mm = Math.floor(totalSec / 60), ss = Math.floor(totalSec % 60);
  return (
    <div style={{ width: 60, flexShrink: 0, borderLeft: "1px solid var(--border-primary)", display: "flex", flexDirection: "column", background: "var(--bg-primary)" }}>
      <div style={{ padding: "8px 4px 6px", textAlign: "center", borderBottom: "1px solid var(--border-primary)" }}>
        <div style={{ fontSize: 7, fontWeight: 800, letterSpacing: "0.1em", color: "var(--text-tertiary)" }}>HOUR FILL</div>
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "'DM Mono', monospace", color, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
          {mm}:{String(ss).padStart(2, "0")}
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", padding: "10px 6px 10px 4px", gap: 3, minHeight: 0 }}>
        {/* minute labels 0 (top) → 60 (bottom) */}
        <div style={{ position: "relative", width: 14, fontSize: 7, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)" }}>
          {[0, 10, 20, 30, 40, 50, 60].map(m => (
            <div key={m} style={{ position: "absolute", top: (m / 60 * 100) + "%", right: 0, transform: "translateY(-50%)" }}>{m}</div>
          ))}
        </div>
        {/* gauge */}
        <div style={{ flex: 1, position: "relative", background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)" }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: (pct * 100) + "%", background: color, opacity: 0.9, transition: "height 0.3s ease, background 0.3s" }} />
          {[10, 20, 30, 40, 50].map(m => (
            <div key={m} style={{ position: "absolute", top: (m / 60 * 100) + "%", left: 0, right: 0, height: 1, background: "rgba(0,0,0,0.45)" }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────

export default function VoiceTracker({ inputDeviceId }: { inputDeviceId?: string }) {
  const engine = useAudioEngine();
  const { stationId, isReady } = useActiveStation();

  // Data
  const [tracks, setTracks]     = useState<VoiceTrack[]>([]);
  const [shows, setShows]       = useState<Show[]>([]);
  const [clocks, setClocks]     = useState<Clock[]>([]);
  const [clockSlots, setClockSlots] = useState<ClockSlot[]>([]);

  // Scheduled songs for prev/next context (Zetta-style three-track)
  const [scheduledSongs, setScheduledSongs] = useState<ScheduledSong[]>([]);
  const [selectedSlotPos, setSelectedSlotPos] = useState<number | null>(null);
  const [breakLen, setBreakLen] = useState<Record<number, number>>({});   // talk-break index → planned seconds
  const [placedBreaks, setPlacedBreaks] = useState<Record<number, boolean>>({}); // index → a take is placed/airing here

  // Hour/clock selection
  const [selectedHour, setSelectedHour]   = useState<number>(new Date().getHours());
  const [selectedClock, setSelectedClock] = useState<number | null>(null);

  // Recording
  const [recording, setRecording]   = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [djName, setDjName]         = useState("DJ");
  const [trackTitle, setTrackTitle] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const [peakLevel, setPeakLevel]   = useState(0);

  // Playback
  const [playingId, setPlayingId]       = useState<number | null>(null);
  const [playProgress, setPlayProgress] = useState<Record<number, number>>({});

  // Selection for click-to-assign
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);

  // Which talk slot the DJ is recording for
  const [recordingForSlot, setRecordingForSlot] = useState<ClockSlot | null>(null);

  // View
  const [libExpanded, setLibExpanded] = useState(true);

  // ── Edit mode (record → select+delete dead air → send to deck/queue/save) ──
  const [editBuffer, setEditBuffer]   = useState<AudioBuffer | null>(null);
  const [editPeaks, setEditPeaks]     = useState<Float32Array | null>(null);
  const [editDur, setEditDur]         = useState(0);          // seconds
  const [editPlayhead, setEditPlayhead] = useState(0);
  const [selection, setSelection]     = useState<{ start: number; end: number } | null>(null);
  const undoRef      = useRef<{ buffer: AudioBuffer; peaks: Float32Array; dur: number }[]>([]);
  const redoRef      = useRef<{ buffer: AudioBuffer; peaks: Float32Array; dur: number }[]>([]);
  const clipboardRef = useRef<AudioBuffer | null>(null);
  const editCtxRef   = useRef<AudioContext | null>(null);
  const editSrcRef   = useRef<AudioBufferSourceNode | null>(null);
  const editRafRef   = useRef<number>(0);
  const editStartRef = useRef(0);
  const editPlayheadRef = useRef(0);
  const markRef      = useRef<number | null>(null);   // pending mark (M sets in, next M sets out)
  useEffect(() => { editPlayheadRef.current = editPlayhead; }, [editPlayhead]);
  const [zoomLevel, setZoomLevel] = useState(1);   // 1 | 4 | 10
  const [viewStart, setViewStart] = useState(0);   // seconds — left edge of the zoom window
  const editing = editBuffer !== null;

  // Refs
  const mediaRecRef   = useRef<MediaRecorder | null>(null);
  const chunksRef     = useRef<Blob[]>([]);
  const timerRef      = useRef<any>(null);
  const startTimeRef  = useRef(0);
  const analyserRef   = useRef<AnalyserNode | null>(null);
  const levelRafRef   = useRef<number>(0);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const wavePointsRef = useRef<number[]>([]);
  const waveRafRef    = useRef<number>(0);
  const audioRef      = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef   = useRef<AudioContext | null>(null);

  // ── Load data ──
  const load = useCallback(async () => {
    if (!isReady) return;
    const [tr, sh, cl] = await Promise.all([
      queryScoped<VoiceTrack>("SELECT * FROM voice_tracks ORDER BY recorded_at DESC LIMIT 100", [], stationId),
      queryScoped<Show>("SELECT * FROM shows ORDER BY start_hour", [], stationId),
      queryScoped<Clock>("SELECT * FROM clocks ORDER BY name", [], stationId),
    ]);
    setTracks(tr || []); setShows(sh || []); setClocks(cl || []);
  }, [isReady, stationId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { wavePointsRef.current = []; }, []);

  // ── When hour changes, find matching show → clock → slots ──
  useEffect(() => {
    const matchingShow = shows.find(s => {
      const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour;
      return selectedHour >= s.start_hour && selectedHour < end;
    });
    setSelectedClock(matchingShow?.clock_id ?? null);
  }, [selectedHour, shows]);

  useEffect(() => {
    if (!selectedClock) { setClockSlots([]); return; }
    // TODO 3b-ii: JOIN query — convert when JOIN scoping is supported
    query<ClockSlot>(
      `SELECT cs.*, c.code as category_code FROM clock_slots cs LEFT JOIN categories c ON c.id = cs.category_id WHERE cs.clock_id = ? ORDER BY cs.position`,
      [selectedClock]
    ).then(slots => {
      if (!Array.isArray(slots)) { setClockSlots([]); return; }
      const enriched = slots.map(slot => {
        const assigned = tracks.find(t => t.clock_slot_id === slot.id);
        return { ...slot, voice_track_id: assigned?.id ?? null, voice_track_title: assigned?.title ?? null };
      });
      setClockSlots(enriched);
    }).catch(() => setClockSlots([]));
  }, [selectedClock, tracks]);

  // ── Load scheduled songs for prev/next song context ──
  useEffect(() => {
    if (!isReady) return;
    queryScoped<ScheduledSong>(
      "SELECT position, title, artist, duration_ms FROM scheduled_log WHERE hour = ? ORDER BY position",
      [selectedHour], stationId
    ).then(r => setScheduledSongs(Array.isArray(r) ? r : [])).catch(() => setScheduledSongs([]));
  }, [selectedHour, isReady]);

  // Derive prev/next songs for the selected slot
  const songs = scheduledSongs || [];
  // selectedSlotPos = the ARRAY INDEX of the song the talk break sits AFTER (between
  // songs[i] and songs[i+1]). Index-based so duplicate/non-sequential log positions can't
  // collide two gaps or skip a song.
  const prevSong = selectedSlotPos !== null ? (songs[selectedSlotPos] ?? null) : null;
  const nextSong = selectedSlotPos !== null ? (songs[selectedSlotPos + 1] ?? null) : null;
  const hourTotalSec = songs.reduce((a, s) => a + (s.duration_ms || 0) / 1000, 0)
    + Object.values(breakLen).reduce((a, b) => a + b, 0);

  // ── Waveform drawing (upgraded with grid + time ruler) ──
  const drawWaveform = useCallback(() => {
    const canvas = waveCanvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = devicePixelRatio || 1;
    const w = canvas.offsetWidth * dpr; const h = canvas.offsetHeight * dpr;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--bg-primary").trim() || "#0d0d0f";
    ctx.fillRect(0, 0, w, h);

    const rulerH = 18 * dpr;
    const waveH = h - rulerH;
    const pts = wavePointsRef.current;

    // Grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.04)"; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, waveH / 4 * i); ctx.lineTo(w, waveH / 4 * i); ctx.stroke(); }
    // Vertical grid every ~80px
    const vStep = 80 * dpr;
    for (let x = vStep; x < w; x += vStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, waveH); ctx.stroke(); }

    // Waveform — green symmetric bars at a FIXED pixel step, so it flows steadily left→right
    // as it records and scrolls once it fills the width (no more squash-to-fit compression).
    const mid = waveH / 2;
    if (pts.length > 0) {
      const stepPx = 2 * dpr;
      const barW = Math.max(1 * dpr, stepPx * 0.82);
      const visibleCount = Math.max(1, Math.floor(w / stepPx));
      const startIdx = Math.max(0, pts.length - visibleCount);
      const grad = ctx.createLinearGradient(0, 0, 0, waveH);
      grad.addColorStop(0, "#6ee7b7"); grad.addColorStop(0.5, "#34d399"); grad.addColorStop(1, "#6ee7b7");
      ctx.fillStyle = grad;
      for (let i = startIdx; i < pts.length; i++) {
        const x = (i - startIdx) * stepPx;
        const amp = Math.min(1, pts[i]) * mid * 0.92;
        ctx.fillRect(x, mid - amp, barW, Math.max(1 * dpr, amp * 2));
      }
    }

    // Center line
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid);
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
    ctx.stroke();

    // Time ruler
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, waveH, w, rulerH);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath(); ctx.moveTo(0, waveH); ctx.lineTo(w, waveH); ctx.stroke();
    // Each point ≈ 50ms (one per rAF at 20fps-ish). 20 pts ≈ 1 second.
    const ptsPerSec = 20;
    const totalSec = pts.length / ptsPerSec;
    const pxPerSec = pts.length > 0 ? w / totalSec : w / 60;
    ctx.font = `${8 * dpr}px 'DM Mono', monospace`;
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.textBaseline = "middle";
    for (let s = 0; s <= totalSec + 1; s++) {
      const x = s * pxPerSec;
      if (x > w) break;
      const major = s % 5 === 0;
      ctx.strokeStyle = major ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)";
      ctx.beginPath(); ctx.moveTo(x, waveH); ctx.lineTo(x, waveH + (major ? rulerH * 0.7 : rulerH * 0.35)); ctx.stroke();
      if (major && s > 0) ctx.fillText(`${s}s`, x + 3 * dpr, waveH + rulerH / 2);
    }

    waveRafRef.current = requestAnimationFrame(drawWaveform);
  }, []);

  const pollLevel = useCallback(() => {
    if (!analyserRef.current) return;
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / data.length);
    setInputLevel(rms);
    setPeakLevel(p => Math.max(p * 0.994, rms));
    wavePointsRef.current.push(rms * 2.5);
    if (wavePointsRef.current.length > 1200) wavePointsRef.current.shift();
    levelRafRef.current = requestAnimationFrame(pollLevel);
  }, []);

  // ── Recording ──
  const startRecording = async () => {
    try {
      const constraints = inputDeviceId ? { audio: { deviceId: { exact: inputDeviceId } } } : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const ctx = new AudioContext(); audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      source.connect(analyser); analyserRef.current = analyser;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", ""].find(m => m === "" || MediaRecorder.isTypeSupported(m)) ?? "";
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = []; wavePointsRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(100); mediaRecRef.current = mr;
      startTimeRef.current = Date.now();
      setRecording(true); setRecordTime(0); setPeakLevel(0);
      timerRef.current = setInterval(() => setRecordTime(Date.now() - startTimeRef.current), 50);
      levelRafRef.current = requestAnimationFrame(pollLevel);
      waveRafRef.current  = requestAnimationFrame(drawWaveform);
    } catch (err) {
      console.error("[VoiceTracker] startRecording failed:", err);
      alert("Could not access microphone. Check Settings → Audio Devices.");
    }
  };

  const stopRecording = async () => {
    const mr = mediaRecRef.current;
    if (!mr || mr.state === "inactive") return;
    clearInterval(timerRef.current);
    cancelAnimationFrame(levelRafRef.current);
    cancelAnimationFrame(waveRafRef.current);
    setRecording(false); setInputLevel(0);
    let done = false;
    try { mr.requestData(); } catch {}
    // On stop → decode the take into an editable buffer. Do NOT auto-save; the DJ trims/edits, then Saves.
    const finalize = async () => {
      if (done) return; done = true;
      try {
        if (chunksRef.current.length === 0) { alert("Recording failed — no audio was captured."); return; }
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        const buf = await decodeBlobToBuffer(blob);
        setEditBuffer(buf);
        setEditPeaks(extractPeaks(buf, 2000));
        setEditDur(buf.duration);
        setSelection(null); setEditPlayhead(0); undoRef.current = []; redoRef.current = []; setZoomLevel(1); setViewStart(0);
      } catch (e) {
        console.error("[VoiceTracker] decode failed:", e);
        alert("Couldn't process the recording: " + String(e));
      } finally {
        mr.stream.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close().catch(() => {});
      }
    };
    mr.addEventListener("stop", finalize, { once: true });
    setTimeout(() => finalize(), 3000);
    mr.stop();
  };

  // ── Edit-mode playback (plays the trimmed region cueIn → cueOut) ──
  const stopEditPlayback = useCallback(() => {
    try { editSrcRef.current?.stop(); } catch {}
    editSrcRef.current = null;
    cancelAnimationFrame(editRafRef.current);
  }, []);
  const playEdit = () => {
    if (!editBuffer) return;
    stopEditPlayback();
    const ctx = editCtxRef.current || new AudioContext(); editCtxRef.current = ctx;
    const src = ctx.createBufferSource(); src.buffer = editBuffer; src.connect(ctx.destination);
    const end = editBuffer.duration;
    const from = (editPlayhead >= end - 0.05 || editPlayhead < 0) ? 0 : editPlayhead;
    src.start(0, from);
    editSrcRef.current = src;
    editStartRef.current = ctx.currentTime - from;
    const tick = () => {
      const pos = ctx.currentTime - editStartRef.current;
      if (pos >= end || !editSrcRef.current) { stopEditPlayback(); setEditPlayhead(0); return; }
      setEditPlayhead(pos); ensureVisible(pos);
      editRafRef.current = requestAnimationFrame(tick);
    };
    editRafRef.current = requestAnimationFrame(tick);
  };
  // Trim tool: splice the selected dead-air region out of the take (Backspace/Delete)
  // History-managed buffer replace (pushes current to undo, clears redo)
  const applyBuffer = (nb: AudioBuffer, clampPlayhead = true) => {
    undoRef.current.push({ buffer: editBuffer!, peaks: editPeaks!, dur: editDur });
    redoRef.current = [];
    setEditBuffer(nb); setEditPeaks(extractPeaks(nb, 2000)); setEditDur(nb.duration);
    if (clampPlayhead) setEditPlayhead(p => Math.min(p, nb.duration));
  };
  const hasSel = () => !!(selection && selection.end - selection.start >= 0.005);
  const deleteSelection = () => { if (!editBuffer || !hasSel()) return; stopEditPlayback(); applyBuffer(spliceOut(editBuffer, selection!.start, selection!.end)); setSelection(null); };
  const cutSelection    = () => { if (!editBuffer || !hasSel()) return; stopEditPlayback(); clipboardRef.current = sliceRegion(editBuffer, selection!.start, selection!.end); applyBuffer(spliceOut(editBuffer, selection!.start, selection!.end)); setSelection(null); };
  const copySelection   = () => { if (!editBuffer || !hasSel()) return; clipboardRef.current = sliceRegion(editBuffer, selection!.start, selection!.end); };
  const pasteClip       = () => { if (!editBuffer || !clipboardRef.current) return; stopEditPlayback(); applyBuffer(insertAt(editBuffer, editPlayheadRef.current, clipboardRef.current)); };
  const insertSilence   = (sec = 0.5) => { if (!editBuffer) return; stopEditPlayback(); applyBuffer(insertAt(editBuffer, editPlayheadRef.current, makeSilence(editBuffer.sampleRate, editBuffer.numberOfChannels, sec))); };
  const fadeSelection   = (type: "in" | "out") => { if (!editBuffer || !hasSel()) return; stopEditPlayback(); applyBuffer(applyFadeRegion(editBuffer, selection!.start, selection!.end, type), false); };
  const selectAll       = () => { if (editDur > 0) setSelection({ start: 0, end: editDur }); };
  const undoEdit = () => {
    const prev = undoRef.current.pop(); if (!prev) return; stopEditPlayback();
    redoRef.current.push({ buffer: editBuffer!, peaks: editPeaks!, dur: editDur });
    setEditBuffer(prev.buffer); setEditPeaks(prev.peaks); setEditDur(prev.dur); setSelection(null);
  };
  const redoEdit = () => {
    const nxt = redoRef.current.pop(); if (!nxt) return; stopEditPlayback();
    undoRef.current.push({ buffer: editBuffer!, peaks: editPeaks!, dur: editDur });
    setEditBuffer(nxt.buffer); setEditPeaks(nxt.peaks); setEditDur(nxt.dur); setSelection(null);
  };

  // ── Zoom (Q cycles x1 → x4 → x10) ──
  const clampView = (s: number, vl: number) => Math.max(0, Math.min(Math.max(0, editDur - vl), s));
  const ensureVisible = (ph: number) => {
    if (zoomLevel <= 1) return;
    const vl = editDur / zoomLevel;
    setViewStart(vs => ph < vs ? clampView(ph - vl * 0.15, vl) : ph > vs + vl ? clampView(ph - vl * 0.85, vl) : vs);
  };
  const cycleZoom = () => {
    const next = zoomLevel === 1 ? 4 : zoomLevel === 4 ? 10 : 1;
    setZoomLevel(next);
    setViewStart(next > 1 ? clampView(editPlayheadRef.current - (editDur / next) / 2, editDur / next) : 0);
  };
  const panViewTo = (clientX: number, rect: DOMRect) => {
    if (zoomLevel <= 1) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const vl = editDur / zoomLevel;
    setViewStart(clampView(ratio * editDur - vl / 2, vl));
  };
  const discardEdit = () => {
    stopEditPlayback();
    setEditBuffer(null); setEditPeaks(null); setEditDur(0); setSelection(null); setEditPlayhead(0); undoRef.current = [];
  };

  // ── Send the cleaned take ──
  const takeTitle = () => trackTitle.trim() || `Break ${fmtHour(selectedHour)} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  // Write the take to a REAL .wav on disk — the on-air engine plays files, not data URLs.
  const writeTakeFile = async (): Promise<string> => {
    const bytes  = new Uint8Array(encodeWav(editBuffer!));
    const appDir = await (window as any).ether.system.getAppDataDir();
    const filePath = `${appDir}/voice-tracks/vt_${Date.now()}.wav`;
    const res = await (window as any).ether.ffmpeg.writeAudio(bytes, filePath);
    if (!res?.ok) throw new Error(res?.error || "writeAudio failed");
    return filePath;
  };
  const sendToDeck = async (deck: "A" | "B" | "C") => {
    if (!editBuffer) return;
    stopEditPlayback();
    try {
      const fp = await writeTakeFile();
      window.dispatchEvent(new CustomEvent("ether:deck-load", { detail: { deck, filePath: fp, title: "[VT] " + takeTitle() } }));
      discardEdit();
    } catch (e) { console.error("[VoiceTracker] send to deck failed:", e); alert("Failed to send: " + String(e)); }
  };
  const sendToQueue = async () => {
    if (!editBuffer) return;
    stopEditPlayback();
    try {
      const fp = await writeTakeFile();
      engine.addToQueue([{ filePath: fp, title: "[VT] " + takeTitle(), artist: djName || "DJ" }]);
      discardEdit();
    } catch (e) { console.error("[VoiceTracker] send to queue failed:", e); alert("Failed to send: " + String(e)); }
  };
  const saveEdit = async () => {
    if (!editBuffer) return;
    stopEditPlayback();
    try {
      const filePath = await writeTakeFile();
      const title = takeTitle();
      const durMs = Math.round(editBuffer.duration * 1000);
      const matchingShow = shows.find(s => { const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour; return selectedHour >= s.start_hour && selectedHour < end; });
      await (window as any).ether.voiceTracks.create({ station_id: stationId, title, file_path: filePath, show_id: matchingShow?.id ?? null, duration_ms: durMs, recorded_by: djName, clock_slot_id: null });
      // Place the take into the playout log at the chosen transition so it airs there.
      // Isolated so a placement miss never loses the recorded take (it's already in the library).
      const pos = selectedSlotPos;
      if (pos !== null && nextSong) {
        try {
          const res = await (window as any).ether.invoke("schedule:insertVoiceTrack", {
            stationId, hour: selectedHour,
            beforeTitle: nextSong.title, beforeArtist: nextSong.artist || "",
            filePath, title: "[VT] " + title, artist: djName || "DJ", durationMs: durMs,
          });
          if (res?.ok) setPlacedBreaks(p => ({ ...p, [pos]: true }));
          else { console.warn("[VoiceTracker] placement skipped:", res?.error); alert("Saved to library, but couldn't place it on air: " + (res?.error || "unknown")); }
        } catch (e) { console.warn("[VoiceTracker] placement IPC unavailable:", e); alert("Saved to library. On-air placement needs an app restart to activate."); }
      }
      setTrackTitle("");
      await load();
      discardEdit();
    } catch (e) { console.error("[VoiceTracker] save failed:", e); alert("Failed to save: " + String(e)); }
  };

  // ── Playback ──
  const playTrack = (track: VoiceTrack) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (playingId === track.id) { setPlayingId(null); return; }
    const audio = new Audio(track.file_path); audioRef.current = audio;
    setPlayingId(track.id);
    audio.ontimeupdate = () => setPlayProgress(p => ({ ...p, [track.id]: audio.currentTime / (audio.duration || 1) }));
    audio.onended = () => { setPlayingId(null); setPlayProgress(p => ({ ...p, [track.id]: 0 })); };
    audio.play();
  };
  const queueTrack = (t: VoiceTrack) => engine.addToQueue([{ filePath: t.file_path, title: "[VT] " + t.title, artist: t.recorded_by || "DJ" }]);
  const deleteTrack = async (id: number) => {
    if (!confirm("Delete this voice track?")) return;
    if (playingId === id) { audioRef.current?.pause(); setPlayingId(null); }
    await (window as any).ether.voiceTracks.deleteById(id); load();
  };

  // ── Slot assignment ──
  const assignToSlot = async (slotId: number, trackId: number) => {
    await (window as any).ether.voiceTracks.clearClockSlotId(slotId);
    await (window as any).ether.voiceTracks.updateById(trackId, { clock_slot_id: slotId });
    load();
  };
  const unassignFromSlot = async (slotId: number) => {
    await (window as any).ether.voiceTracks.clearClockSlotId(slotId); load();
  };

  // ── SPACE keyboard shortcut ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        if (recording) stopRecording();
        else if (editing) { if (editSrcRef.current) stopEditPlayback(); else playEdit(); }
        else startRecording();
      } else if (editing && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        // Nudge the playhead (scrub). Shift = 1s, plain = 0.1s.
        e.preventDefault();
        stopEditPlayback();
        const delta = (e.code === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
        const newPh = Math.max(0, Math.min(editDur, editPlayheadRef.current + delta));
        setEditPlayhead(newPh); ensureVisible(newPh);
      } else if (editing && e.code === "KeyQ") {
        e.preventDefault(); cycleZoom();
      } else if (editing && e.code === "BracketLeft") {
        // Mark In ([) — set the left edge of the selection at the playhead.
        e.preventDefault();
        const ph = editPlayheadRef.current;
        setSelection(sel => ({ start: ph, end: Math.max(ph, sel?.end ?? ph) }));
      } else if (editing && e.code === "BracketRight") {
        // Mark Out (]) — set the right edge of the selection at the playhead.
        e.preventDefault();
        const ph = editPlayheadRef.current;
        setSelection(sel => ({ start: Math.min(ph, sel?.start ?? ph), end: ph }));
      } else if (editing && e.code === "KeyK") {
        // Deselect.
        e.preventDefault(); setSelection(null); markRef.current = null;
      } else if (editing && e.code === "KeyM") {
        // Convenience toggle-mark (first M = in, second M = out → selection).
        e.preventDefault();
        const ph = editPlayheadRef.current;
        if (markRef.current === null) { markRef.current = ph; setSelection(null); }
        else { const a = markRef.current; setSelection({ start: Math.min(a, ph), end: Math.max(a, ph) }); markRef.current = null; }
      } else if (editing && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault(); deleteSelection();
      } else if (editing && (e.ctrlKey || e.metaKey)) {
        const k = e.key.toLowerCase();
        if (k === "z" && e.shiftKey) { e.preventDefault(); redoEdit(); }
        else if (k === "z") { e.preventDefault(); undoEdit(); }
        else if (k === "y") { e.preventDefault(); redoEdit(); }
        else if (k === "a") { e.preventDefault(); selectAll(); }
        else if (k === "c") { e.preventDefault(); copySelection(); }
        else if (k === "x") { e.preventDefault(); cutSelection(); }
        else if (k === "v") { e.preventDefault(); pasteClip(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, editing, selection, zoomLevel, editDur]);

  // ── Derived ──
  const talkSlots   = (clockSlots || []).filter(s => isTalkSlot(s.slot_type));
  const filled      = talkSlots.filter(s => (tracks || []).some(t => t.clock_slot_id === s.id)).length;
  const matchedClock = (clocks || []).find(c => c.id === selectedClock);
  const matchedShow  = (shows || []).find(s => { const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour; return selectedHour >= s.start_hour && selectedHour < end; });

  const targetMs = recordingForSlot ? recordingForSlot.duration_min * 60000 : 0;
  const over = targetMs > 0 && recordTime > targetMs;

  // Zoom view window + range peaks (real detail at high zoom, not stretched pixels)
  const viewLen = (zoomLevel <= 1 || editDur === 0) ? editDur : editDur / zoomLevel;
  const effViewStart = zoomLevel <= 1 ? 0 : Math.max(0, Math.min(viewStart, Math.max(0, editDur - viewLen)));
  const effViewEnd = Math.min(editDur, effViewStart + (viewLen || editDur));
  const viewPeaks = useMemo(
    () => editBuffer ? extractPeaksRange(editBuffer, effViewStart, Math.min(editBuffer.duration, effViewEnd) || editBuffer.duration, 2000) : null,
    [editBuffer, effViewStart, effViewEnd, editPeaks],
  );

  // ─── Render ────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", fontFamily: "'Inter', system-ui, sans-serif", height: "100%", overflow: "hidden" }}>

      {/* ══════════════ LEFT — Studio Panel ══════════════ */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column", overflow: "hidden",
        background: "var(--bg-primary)",
        borderRight: "1px solid var(--border-primary)",
      }}>
        {/* Header bar */}
        <div style={{
          height: 40, padding: "0 16px", display: "flex", alignItems: "center", gap: 10,
          background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", flexShrink: 0,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: recording ? "var(--accent-red)" : "rgba(255,255,255,0.12)",
            boxShadow: recording ? "0 0 12px var(--accent-red)" : "none",
            animation: recording ? "vt-pulse 1s infinite" : "none",
          }} />
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: recording ? "var(--accent-red)" : "var(--text-tertiary)", textTransform: "uppercase" as const }}>
            {recording ? "RECORDING" : "VOICE TRACKER"}
          </span>
          <div style={{ flex: 1 }} />
          {/* DJ name + break title inline */}
          <input value={djName} onChange={e => setDjName(e.target.value)} placeholder="DJ" disabled={recording}
            style={{ width: 80, padding: "3px 8px", fontSize: 10, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", borderRadius: 0, outline: "none" }} />
          <input value={trackTitle} onChange={e => setTrackTitle(e.target.value)} placeholder="Break title..." disabled={recording}
            style={{ width: 140, padding: "3px 8px", fontSize: 10, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", borderRadius: 0, outline: "none" }} />
          {/* Elapsed timer */}
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 26, fontWeight: 800, color: recording ? (over ? "var(--accent-amber)" : "var(--accent-red)") : "var(--text-secondary)", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", minWidth: 104, textAlign: "right" as const }}>
            {fmtMsFull(recordTime)}
          </span>
          <button title="Pop out" onClick={() => (window as any).ether?.invoke("window:popout", "voicetrack")}
            style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "2px", display: "flex", alignItems: "center" }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = "#6080c0"}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = "var(--text-tertiary)"}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>
        </div>

        {/* Hour strip */}
        <div style={{
          height: 36, padding: "0 16px", display: "flex", alignItems: "center", gap: 10,
          background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", flexShrink: 0,
        }}>
          <select value={selectedHour} onChange={e => setSelectedHour(parseInt(e.target.value))} disabled={recording}
            style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", borderRadius: 0, outline: "none", fontFamily: "'DM Mono', monospace", colorScheme: "dark" }}>
            {Array.from({ length: 24 }, (_, h) => {
              const show = shows.find(s => { const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour; return h >= s.start_hour && h < end; });
              return <option key={h} value={h}>{fmtHour(h)}{show ? ` — ${show.name}` : ""}</option>;
            })}
          </select>
          {matchedShow && (
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: matchedShow.color || "var(--accent-purple)" }} />
              <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>{matchedShow.name}</span>
            </div>
          )}
          {selectedSlotPos !== null && (prevSong || nextSong) && (
            <>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 9, fontWeight: 700, color: "var(--accent-cyan)" }}>
                #{(selectedSlotPos ?? 0) + 1} {prevSong ? "→" : ""} #{(selectedSlotPos ?? 0) + 2}
              </span>
            </>
          )}
        </div>

        {/* ── Three-Lane Transition View ── */}

        {/* Top lane: Previous song */}
        <SongLane song={prevSong} label="prev" color="var(--accent-cyan)" />

        {/* Middle lane: YOUR VOICE — premium record stage (idle) → waveform (recording) */}
        <div style={{
          flex: 1, minHeight: 200, position: "relative", overflow: "hidden",
          borderBottom: "1px solid var(--border-primary)",
          background: "radial-gradient(135% 95% at 50% 0%, rgba(136,104,216,0.08), transparent 55%), var(--bg-primary)",
        }}>
          {editing ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                <WaveformEditor
                  peaks={viewPeaks} duration={editDur} viewStart={effViewStart} viewEnd={effViewEnd}
                  playhead={editPlayhead} selection={selection}
                  onSelectionChange={setSelection}
                  onSeek={(s) => { stopEditPlayback(); setEditPlayhead(s); ensureVisible(s); }}
                />
                {zoomLevel > 1 && (
                  <div style={{ position: "absolute", top: 6, right: 8, fontSize: 9, fontWeight: 800, letterSpacing: "0.05em", color: "var(--accent-cyan)", background: "rgba(0,0,0,0.55)", padding: "2px 7px", pointerEvents: "none" }}>×{zoomLevel}</div>
                )}
              </div>
              {zoomLevel > 1 && editDur > 0 && (
                <div onMouseDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  panViewTo(e.clientX, rect);
                  const move = (ev: MouseEvent) => panViewTo(ev.clientX, rect);
                  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
                  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
                }}
                  style={{ height: 10, flexShrink: 0, background: "var(--bg-tertiary)", borderTop: "1px solid var(--border-primary)", position: "relative", cursor: "grab" }}>
                  <div style={{ position: "absolute", top: 1, bottom: 1, left: (effViewStart / editDur * 100) + "%", width: (Math.max(0.02, (effViewEnd - effViewStart) / editDur) * 100) + "%", background: "var(--accent-cyan)", opacity: 0.45 }} />
                </div>
              )}
            </div>
          ) : (
            <>
              <canvas ref={waveCanvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
              {!recording && wavePointsRef.current.length === 0 && (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, pointerEvents: "none" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-secondary)", letterSpacing: "0.01em" }}>
                    {recordingForSlot ? `Ready — ${recordingForSlot.label || "Talk Break"}` : "Ready to voice track"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                    {(djName || "DJ")}{matchedShow ? ` · ${matchedShow.name}` : ""} · {fmtHour(selectedHour)}
                    {recordingForSlot ? ` · target ${fmtDuration(recordingForSlot.duration_min)}` : ""}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Bottom lane: Next song */}
        <SongLane song={nextSong} label="next" color="var(--accent-green)" />

        {/* VU Meter */}
        <div style={{ height: 44, flexShrink: 0, borderBottom: "1px solid var(--border-primary)" }}>
          <HorizontalVU level={inputLevel} peak={peakLevel} recording={recording} />
        </div>

        {/* Transport bar */}
        <div style={{
          height: 52, padding: "0 16px", display: "flex", alignItems: "center", gap: 12,
          background: "var(--bg-secondary)", flexShrink: 0,
        }}>
          {editing ? (
            <>
              {/* Edit transport — play / undo, then send to deck/queue/save */}
              <div style={{ display: "flex", alignItems: "stretch", gap: 1, flexShrink: 0, height: 34 }}>
                <button onClick={() => editSrcRef.current ? stopEditPlayback() : playEdit()} title="Play / stop (Space)" style={{
                  width: 40, borderRadius: 0, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  background: editSrcRef.current ? "var(--accent-green)" : "var(--bg-tertiary)",
                  border: `1px solid ${editSrcRef.current ? "var(--accent-green)" : "var(--border-secondary)"}`,
                  color: editSrcRef.current ? "#0a160d" : "var(--text-secondary)",
                }}>
                  {editSrcRef.current
                    ? <svg width="9" height="9" viewBox="0 0 8 8" fill="currentColor"><rect width="8" height="8"/></svg>
                    : <svg width="9" height="11" viewBox="0 0 6 8" fill="currentColor"><polygon points="0,0 6,4 0,8"/></svg>}
                </button>
                <button onClick={undoEdit} disabled={undoRef.current.length === 0} title="Undo cut (Ctrl+Z)" style={{
                  width: 38, borderRadius: 0, cursor: undoRef.current.length ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)",
                  color: undoRef.current.length ? "var(--text-secondary)" : "var(--text-tertiary)",
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>
                </button>
                <button onClick={redoEdit} disabled={redoRef.current.length === 0} title="Redo (Ctrl+Y)" style={{
                  width: 38, borderRadius: 0, cursor: redoRef.current.length ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)",
                  color: redoRef.current.length ? "var(--text-secondary)" : "var(--text-tertiary)",
                }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/></svg>
                </button>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: selection ? "var(--accent-cyan)" : "var(--text-primary)" }}>
                  {selection ? `Selection ${fmtMs(Math.round(selection.start * 1000))}–${fmtMs(Math.round(selection.end * 1000))} · Del to cut` : `Take ${fmtMs(Math.round(editDur * 1000))}`}
                </div>
                <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 1 }}>
                  Drag or [ ] mark in/out · ←→ scrub · Del cut · K deselect · then send →{recordingForSlot ? ` ${recordingForSlot.label || "slot"}` : ""}
                </div>
              </div>
              {/* FX — fade in / fade out / insert silence */}
              <div style={{ display: "flex", alignItems: "stretch", gap: 1, flexShrink: 0, height: 34 }}>
                <button onClick={() => fadeSelection("in")} disabled={!hasSel()} title="Fade in across selection" style={{
                  width: 32, borderRadius: 0, cursor: hasSel() ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: hasSel() ? "var(--text-secondary)" : "var(--text-tertiary)",
                }}><svg width="14" height="11" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 16 L22 3"/><path d="M2 16 L22 16"/></svg></button>
                <button onClick={() => fadeSelection("out")} disabled={!hasSel()} title="Fade out across selection" style={{
                  width: 32, borderRadius: 0, cursor: hasSel() ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center",
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: hasSel() ? "var(--text-secondary)" : "var(--text-tertiary)",
                }}><svg width="14" height="11" viewBox="0 0 24 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 3 L22 16"/><path d="M2 16 L22 16"/></svg></button>
                <button onClick={() => insertSilence(0.5)} title="Insert 0.5s silence at playhead" style={{
                  padding: "0 8px", borderRadius: 0, cursor: "pointer", fontSize: 9, fontWeight: 700, letterSpacing: "0.04em",
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--text-secondary)",
                }}>SIL</button>
              </div>
              {/* Send targets — Deck A/B/C + Queue */}
              <div style={{ display: "flex", alignItems: "stretch", gap: 1, flexShrink: 0, height: 34 }}>
                {(["A", "B", "C"] as const).map(d => (
                  <button key={d} onClick={() => sendToDeck(d)} title={`Send to Deck ${d}`} style={{
                    width: 34, borderRadius: 0, cursor: "pointer", fontSize: 12, fontWeight: 800,
                    background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--accent-cyan)",
                  }}>{d}</button>
                ))}
                <button onClick={sendToQueue} title="Add to queue" style={{
                  width: 34, borderRadius: 0, cursor: "pointer", fontSize: 12, fontWeight: 800,
                  background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--accent-cyan)",
                }}>Q</button>
              </div>
              <button onClick={saveEdit} disabled={selectedSlotPos === null}
                title={selectedSlotPos === null ? "Pick a talk break in the Hour Log first" : "Add this take to the selected talk break"}
                style={{ height: 34, padding: "0 16px", borderRadius: 0, cursor: selectedSlotPos !== null ? "pointer" : "default", fontSize: 11, fontWeight: 800, letterSpacing: "0.04em",
                  background: selectedSlotPos !== null ? "var(--accent-green)" : "var(--bg-tertiary)",
                  border: selectedSlotPos !== null ? "none" : "1px solid var(--border-secondary)",
                  color: selectedSlotPos !== null ? "#0a160d" : "var(--text-tertiary)" }}>＋ BREAK</button>
              <button onClick={discardEdit} title="Discard take" style={{ height: 34, padding: "0 11px", borderRadius: 0, cursor: "pointer", fontSize: 12, fontWeight: 700, background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--text-tertiary)" }}>✕</button>
            </>
          ) : (<>
          {/* Transport toolbar — rectangular DAW controls */}
          <div style={{ display: "flex", alignItems: "stretch", gap: 1, flexShrink: 0, height: 34 }}>
            {/* Record */}
            <button onClick={startRecording} disabled={recording} title="Record (Space)" style={{
              padding: "0 14px", borderRadius: 0, cursor: recording ? "default" : "pointer",
              display: "flex", alignItems: "center", gap: 7, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em",
              background: recording ? "var(--accent-red)" : "var(--bg-tertiary)",
              border: `1px solid ${recording ? "var(--accent-red)" : "var(--border-secondary)"}`,
              color: recording ? "#160a0c" : "var(--accent-red)",
              animation: recording ? "vt-pulse 1s infinite" : "none",
            }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: recording ? "#160a0c" : "var(--accent-red)", display: "inline-block" }} />REC
            </button>
            {/* Play */}
            <button onClick={() => { const t = tracks[0]; if (t) playTrack(t); }} disabled={tracks.length === 0 || recording} title="Play latest" style={{
              width: 38, borderRadius: 0, cursor: tracks.length && !recording ? "pointer" : "default",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: playingId ? "var(--accent-green)" : "var(--bg-tertiary)",
              border: `1px solid ${playingId ? "var(--accent-green)" : "var(--border-secondary)"}`,
              color: playingId ? "#0a160d" : (tracks.length && !recording ? "var(--text-secondary)" : "var(--text-tertiary)"),
            }}>
              <svg width="9" height="11" viewBox="0 0 6 8" fill="currentColor"><polygon points="0,0 6,4 0,8"/></svg>
            </button>
            {/* Stop */}
            <button onClick={() => { if (recording) stopRecording(); else if (audioRef.current) { audioRef.current.pause(); setPlayingId(null); } }} title="Stop" style={{
              width: 38, borderRadius: 0, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--text-secondary)",
            }}>
              <svg width="9" height="9" viewBox="0 0 8 8" fill="currentColor"><rect x="0" y="0" width="8" height="8"/></svg>
            </button>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: recording ? "var(--accent-red)" : "var(--text-tertiary)" }}>
              {recording ? "Recording — press SPACE or click ■ to stop" : "Press SPACE or click ● to record"}
            </div>
            <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 1 }}>
              {selectedSlotPos !== null && nextSong
                ? `Talk break before "${nextSong.title}" — record, edit, then ＋ BREAK`
                : "Pick a talk break in the Hour Log to place your take"
              }
            </div>
          </div>
          {targetMs > 0 && recording && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
              <div style={{ width: 60, height: 3, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: (Math.min(recordTime / targetMs, 1) * 100) + "%", background: over ? "var(--accent-red)" : "var(--accent-green)", transition: "width 0.1s" }} />
              </div>
              <span style={{ fontSize: 8, fontFamily: "'DM Mono', monospace", color: over ? "var(--accent-red)" : "var(--text-tertiary)" }}>
                {over ? `+${fmtMs(recordTime - targetMs)}` : `${fmtMs(targetMs - recordTime)} left`}
              </span>
            </div>
          )}
          </>)}
        </div>
      </div>

      {/* ══════════════ RIGHT — Break Slots + Library ══════════════ */}
      <div style={{ width: 460, flexShrink: 0, display: "flex", overflow: "hidden", background: "var(--bg-secondary)", borderLeft: "1px solid var(--border-primary)" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>

        {/* Hour log header */}
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, display: "flex", alignItems: "center" }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>HOUR LOG</div>
          <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginLeft: "auto", fontFamily: "'DM Mono', monospace" }}>{fmtHour(selectedHour)} · {songs.length} cuts</div>
        </div>

        {/* Hour log — click a transition between two cuts to talk over it (Zetta-style) */}
        <div style={{ flex: 1, overflowY: "auto", padding: "8px", display: "flex", flexDirection: "column" }}>
          {songs.length === 0 ? (
            <div style={{ padding: "24px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>No log for {fmtHour(selectedHour)}</div>
              <div style={{ fontSize: 9, color: "var(--text-tertiary)", lineHeight: 1.5 }}>Generate the hour in Schedule, then click a transition to talk over it.</div>
            </div>
          ) : (
            songs.map((s, i) => {
              const sel = selectedSlotPos === i;
              const len = breakLen[i] ?? 0;
              const placed = !!placedBreaks[i];
              return (
                <div key={i}>
                  {/* Song row — large */}
                  <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 12px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", marginBottom: 2 }}>
                    <div style={{ width: 20, fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", flexShrink: 0, textAlign: "right" as const }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{s.title}</div>
                      <div style={{ fontSize: 11, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artist || "—"}</div>
                    </div>
                    <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{fmtMs(s.duration_ms)}</div>
                  </div>
                  {/* Talk-break transition — click to select + choose its length */}
                  {i < songs.length - 1 && (
                    <div style={{ display: "flex", alignItems: "stretch", marginBottom: 2,
                      borderLeft: `3px solid ${placed ? "var(--accent-green)" : sel ? "var(--accent-cyan)" : "transparent"}`,
                      background: placed ? "rgb(from var(--accent-green) r g b / 0.10)" : sel ? "rgb(from var(--accent-cyan) r g b / 0.12)" : "none" }}>
                      <button onClick={() => { setSelectedSlotPos(sel ? null : i); setRecordingForSlot(null); }}
                        style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "none", border: "none", cursor: "pointer", textAlign: "left" as const, color: placed ? "var(--accent-green)" : sel ? "var(--accent-cyan)" : "var(--text-tertiary)" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1 }}>{placed ? "●" : sel ? "▸" : "+"}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em" }}>{placed ? "VOICE TRACK PLACED" : sel ? "TALK BREAK" : "talk break"}</span>
                      </button>
                      <select value={len} onChange={e => setBreakLen(b => ({ ...b, [i]: +e.target.value }))} onClick={e => e.stopPropagation()}
                        style={{ fontSize: 16, fontWeight: 800, fontFamily: "'DM Mono', monospace", background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)",
                          color: len ? "var(--accent-cyan)" : "var(--text-tertiary)", padding: "2px 6px", margin: "3px 6px", borderRadius: 0, cursor: "pointer", outline: "none", colorScheme: "dark" as const }}>
                        <option value={0}>—:—</option>
                        <option value={5}>0:05</option>
                        <option value={10}>0:10</option>
                        <option value={15}>0:15</option>
                        <option value={20}>0:20</option>
                        <option value={30}>0:30</option>
                        <option value={45}>0:45</option>
                        <option value={60}>1:00</option>
                        <option value={90}>1:30</option>
                        <option value={120}>2:00</option>
                      </select>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Library */}
        <div style={{ borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
          <button onClick={() => setLibExpanded(p => !p)}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", background: "var(--bg-tertiary)", border: "none", cursor: "pointer", textAlign: "left" }}>
            <span style={{ fontSize: 8, color: "var(--text-tertiary)", transform: libExpanded ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform 0.15s" }}>▶</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-secondary)", letterSpacing: "0.08em" }}>RECORDED ({tracks.length})</span>
          </button>
        </div>
        {libExpanded && (
          <div style={{ overflowY: "auto", maxHeight: 280, padding: "4px 8px", display: "flex", flexDirection: "column", gap: 3 }}>
            {tracks.length === 0 ? (
              <div style={{ padding: "16px 8px", textAlign: "center", fontSize: 10, color: "var(--text-tertiary)" }}>
                No recorded breaks yet. Hit ● REC to start.
              </div>
            ) : tracks.map(t => (
              <TrackCard key={t.id} track={t} selected={selectedTrackId === t.id} onSelect={setSelectedTrackId}
                onPlay={playTrack} onQueue={queueTrack} onDelete={deleteTrack} playingId={playingId} playProgress={playProgress} />
            ))}
          </div>
        )}
        </div>{/* log column */}
        <HourMeter totalSec={hourTotalSec} />
      </div>

      <style>{`
        @keyframes vt-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 12px var(--accent-red); }
          50%       { opacity: 0.6; box-shadow: 0 0 4px var(--accent-red); }
        }
      `}</style>
    </div>
  );
}
