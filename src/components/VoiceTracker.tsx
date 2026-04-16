import { useState, useEffect, useRef, useCallback } from "react";
import { query, execute } from "../db/client";
import { engine } from "../audio/engine-rodio";

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
  music: "#38bdf8", liner: "#fb923c", sweeper: "#34d399",
  news: "#fbbf24", jingle: "#e879f9",
};
const isTalkSlot = (t: string) => t === "talkset" || t === "talk_break";

// ─── Canvas VU Meter ──────────────────────────────────────────

function HorizontalVU({ level, peak, recording }: { level: number; peak: number; recording: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(e.contentRect.width * dpr);
        canvas.height = Math.floor(e.contentRect.height * dpr);
        canvas.style.width = e.contentRect.width + "px";
        canvas.style.height = e.contentRect.height + "px";
      }
    });
    ro.observe(canvas);

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return; }
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Background
      const cs = getComputedStyle(canvas);
      ctx.fillStyle = cs.getPropertyValue("--bg-primary").trim() || "#0d0d0f";
      ctx.fillRect(0, 0, w, h);

      // dB scale labels along top
      const dpr = window.devicePixelRatio || 1;
      ctx.font = `${8 * dpr}px 'DM Mono', monospace`;
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.textBaseline = "top";
      const labels = [{ db: -40, pct: 0 }, { db: -20, pct: 0.25 }, { db: -10, pct: 0.5 }, { db: -6, pct: 0.65 }, { db: -3, pct: 0.8 }, { db: 0, pct: 1 }];
      for (const l of labels) {
        const x = l.pct * w;
        ctx.fillText(`${l.db}`, x + 2 * dpr, 2 * dpr);
        ctx.fillStyle = "rgba(255,255,255,0.06)";
        ctx.fillRect(x, 0, 1, h);
        ctx.fillStyle = "rgba(255,255,255,0.18)";
      }

      // Meter bar area
      const barTop = 14 * dpr;
      const barH = h - barTop - 4 * dpr;
      const lvl = Math.min(1, level * 5); // scale up for visibility
      const pk = Math.min(1, peak * 5);
      const barW = lvl * w;

      // Gradient fill
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#00c8a8");
      grad.addColorStop(0.6, "#c0a020");
      grad.addColorStop(0.85, "#c02828");
      ctx.fillStyle = grad;
      ctx.fillRect(0, barTop, barW, barH);

      // Peak indicator
      if (pk > 0.01 && recording) {
        const pkX = pk * w;
        ctx.fillStyle = pk > 0.8 ? "#ef4444" : pk > 0.6 ? "#fbbf24" : "#22d3ee";
        ctx.fillRect(pkX - 1 * dpr, barTop, 2 * dpr, barH);
      }

      // Status label
      ctx.font = `bold ${9 * dpr}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillStyle = !recording ? "rgba(255,255,255,0.12)" : lvl > 0.8 ? "#ef4444" : lvl > 0.4 ? "#fbbf24" : "#00c8a8";
      const label = !recording ? "STANDBY" : lvl > 0.8 ? "HOT" : lvl > 0.4 ? "GOOD" : "LOW";
      ctx.fillText(label, w - ctx.measureText(label).width - 4 * dpr, barTop + barH / 2);

      rafRef.current = requestAnimationFrame(draw);
    };
    draw();
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current); };
  }, [level, peak, recording]);

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

// ─── Main Component ────────────────────────────────────────────

export default function VoiceTracker({ inputDeviceId }: { inputDeviceId?: string }) {

  // Data
  const [tracks, setTracks]     = useState<VoiceTrack[]>([]);
  const [shows, setShows]       = useState<Show[]>([]);
  const [clocks, setClocks]     = useState<Clock[]>([]);
  const [clockSlots, setClockSlots] = useState<ClockSlot[]>([]);

  // Scheduled songs for prev/next context (Zetta-style three-track)
  const [scheduledSongs, setScheduledSongs] = useState<ScheduledSong[]>([]);
  const [selectedSlotPos, setSelectedSlotPos] = useState<number | null>(null);

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
    const [tr, sh, cl] = await Promise.all([
      query<VoiceTrack>("SELECT * FROM voice_tracks ORDER BY recorded_at DESC LIMIT 100"),
      query<Show>("SELECT * FROM shows ORDER BY start_hour"),
      query<Clock>("SELECT * FROM clocks ORDER BY name"),
    ]);
    setTracks(tr || []); setShows(sh || []); setClocks(cl || []);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { wavePointsRef.current = []; }, []);
  useEffect(() => { execute("ALTER TABLE voice_tracks ADD COLUMN clock_slot_id INTEGER").catch(() => {}); }, []);

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
    query<ScheduledSong>(
      "SELECT position, title, artist, duration_ms FROM scheduled_log WHERE hour = ? ORDER BY position",
      [selectedHour]
    ).then(r => setScheduledSongs(Array.isArray(r) ? r : [])).catch(() => setScheduledSongs([]));
  }, [selectedHour]);

  // Derive prev/next songs for the selected slot
  const songs = scheduledSongs || [];
  const prevSong = selectedSlotPos !== null
    ? songs.filter(s => s.position < selectedSlotPos).sort((a, b) => b.position - a.position)[0] || null
    : null;
  const nextSong = selectedSlotPos !== null
    ? songs.filter(s => s.position > selectedSlotPos).sort((a, b) => a.position - b.position)[0] || null
    : null;

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

    // Waveform
    if (pts.length > 1) {
      const step = w / Math.max(pts.length, 200);
      const grad = ctx.createLinearGradient(0, 0, 0, waveH);
      grad.addColorStop(0, "rgba(248,113,113,0.7)"); grad.addColorStop(0.5, "rgba(248,113,113,0.15)"); grad.addColorStop(1, "rgba(248,113,113,0.03)");
      ctx.beginPath(); ctx.moveTo(0, waveH / 2);
      pts.forEach((v, i) => ctx.lineTo(i * step, waveH / 2 - v * (waveH / 2) * 0.85));
      ctx.lineTo(pts.length * step, waveH / 2); ctx.fillStyle = grad; ctx.fill();

      const gradB = ctx.createLinearGradient(0, waveH, 0, 0);
      gradB.addColorStop(0, "rgba(248,113,113,0.5)"); gradB.addColorStop(0.5, "rgba(248,113,113,0.06)");
      ctx.beginPath(); ctx.moveTo(0, waveH / 2);
      pts.forEach((v, i) => ctx.lineTo(i * step, waveH / 2 + v * (waveH / 2) * 0.85));
      ctx.lineTo(pts.length * step, waveH / 2); ctx.fillStyle = gradB; ctx.fill();

      ctx.beginPath(); ctx.moveTo(0, waveH / 2);
      pts.forEach((v, i) => ctx.lineTo(i * step, waveH / 2 - v * (waveH / 2) * 0.85));
      ctx.strokeStyle = "#f87171"; ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = "#f87171"; ctx.shadowBlur = 8 * dpr; ctx.stroke(); ctx.shadowBlur = 0;
    }

    // Center line
    ctx.beginPath(); ctx.moveTo(0, waveH / 2); ctx.lineTo(w, waveH / 2);
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]); ctx.stroke(); ctx.setLineDash([]);

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
    const durMs = Date.now() - startTimeRef.current;
    let saved = false;
    try { mr.requestData(); } catch {}
    const saveRecording = async () => {
      if (saved) return; saved = true;
      try {
        if (chunksRef.current.length === 0) { alert("Recording failed — no audio was captured."); return; }
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        const title = trackTitle.trim() || `Break ${fmtHour(selectedHour)} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        const matchingShow = shows.find(s => { const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour; return selectedHour >= s.start_hour && selectedHour < end; });
        await new Promise<void>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = async () => {
            try {
              try { await execute("INSERT INTO voice_tracks (title, file_path, show_id, duration_ms, recorded_by, clock_slot_id) VALUES (?,?,?,?,?,?)", [title, reader.result as string, matchingShow?.id ?? null, durMs, djName, null]); }
              catch { await execute("INSERT INTO voice_tracks (title, file_path, show_id, duration_ms, recorded_by) VALUES (?,?,?,?,?)", [title, reader.result as string, matchingShow?.id ?? null, durMs, djName]); }
              setTrackTitle("");
              load().then(async () => {
                if (recordingForSlot) {
                  const latest = await query<VoiceTrack>("SELECT * FROM voice_tracks ORDER BY recorded_at DESC LIMIT 1");
                  if (latest.length > 0) {
                    await execute("UPDATE voice_tracks SET clock_slot_id = NULL WHERE clock_slot_id = ?", [recordingForSlot.id]);
                    await execute("UPDATE voice_tracks SET clock_slot_id = ? WHERE id = ?", [recordingForSlot.id, latest[0].id]);
                    load();
                  }
                  setRecordingForSlot(null);
                }
              });
              resolve();
            } catch (e) { reject(e); }
          };
          reader.readAsDataURL(blob);
        });
      } catch (e) { console.error("[VoiceTracker] save failed:", e); alert("Failed to save recording: " + String(e)); }
      finally { mr.stream.getTracks().forEach(t => t.stop()); audioCtxRef.current?.close().catch(() => {}); }
    };
    mr.addEventListener("stop", saveRecording, { once: true });
    setTimeout(() => saveRecording(), 3000);
    mr.stop();
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
    await execute("DELETE FROM voice_tracks WHERE id = ?", [id]); load();
  };

  // ── Slot assignment ──
  const assignToSlot = async (slotId: number, trackId: number) => {
    await execute("UPDATE voice_tracks SET clock_slot_id = NULL WHERE clock_slot_id = ?", [slotId]);
    await execute("UPDATE voice_tracks SET clock_slot_id = ? WHERE id = ?", [slotId, trackId]);
    load();
  };
  const unassignFromSlot = async (slotId: number) => {
    await execute("UPDATE voice_tracks SET clock_slot_id = NULL WHERE clock_slot_id = ?", [slotId]); load();
  };

  // ── SPACE keyboard shortcut ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT") return;
      e.preventDefault();
      if (recording) stopRecording(); else startRecording();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  // ── Derived ──
  const talkSlots   = (clockSlots || []).filter(s => isTalkSlot(s.slot_type));
  const filled      = talkSlots.filter(s => (tracks || []).some(t => t.clock_slot_id === s.id)).length;
  const matchedClock = (clocks || []).find(c => c.id === selectedClock);
  const matchedShow  = (shows || []).find(s => { const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour; return selectedHour >= s.start_hour && selectedHour < end; });

  const targetMs = recordingForSlot ? recordingForSlot.duration_min * 60000 : 0;
  const over = targetMs > 0 && recordTime > targetMs;

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
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 16, fontWeight: 300, color: recording ? (over ? "var(--accent-amber)" : "var(--accent-red)") : "var(--text-tertiary)", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", minWidth: 70, textAlign: "right" as const }}>
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
          {talkSlots.length > 0 && (
            <>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 9, fontWeight: 700, color: filled === talkSlots.length ? "var(--accent-green)" : "var(--accent-red)" }}>
                {filled}/{talkSlots.length} filled
              </span>
              <div style={{ width: 60, height: 4, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: ((filled / Math.max(talkSlots.length, 1)) * 100) + "%", background: filled === talkSlots.length ? "var(--accent-green)" : "var(--accent-red)", transition: "width 0.3s" }} />
              </div>
            </>
          )}
        </div>

        {/* ── Three-Lane Transition View ── */}

        {/* Top lane: Previous song */}
        <SongLane song={prevSong} label="prev" color="var(--accent-cyan)" />

        {/* Middle lane: YOUR VOICE — waveform hero */}
        <div style={{ flex: 1, minHeight: 140, position: "relative", overflow: "hidden", borderBottom: "1px solid var(--border-primary)" }}>
          {!recording && wavePointsRef.current.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, pointerEvents: "none" }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1.2" strokeLinecap="round">
                <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/>
              </svg>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.08)", letterSpacing: "0.15em", fontWeight: 700 }}>YOUR VOICE TRACK</div>
            </div>
          )}
          <canvas ref={waveCanvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
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
          {!recording ? (
            <button onClick={startRecording} style={{
              width: 44, height: 36, borderRadius: 0, flexShrink: 0,
              background: "var(--accent-red)", border: "none", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", color: "#fff",
              fontSize: 14, fontWeight: 700,
              boxShadow: "0 0 16px rgba(248,113,113,0.3)",
              transition: "all 0.15s",
            }}>●</button>
          ) : (
            <button onClick={stopRecording} style={{
              width: 44, height: 36, borderRadius: 0, flexShrink: 0,
              background: "var(--bg-tertiary)", border: "2px solid var(--accent-red)", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent-red)",
              fontSize: 11, fontWeight: 700,
              animation: "vt-pulse 1s infinite",
            }}>■</button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: recording ? "var(--accent-red)" : "var(--text-tertiary)" }}>
              {recording ? "Recording — press SPACE or click ■ to stop" : "Press SPACE or click ● to record"}
            </div>
            <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 1 }}>
              {recordingForSlot
                ? `Slot ${recordingForSlot.position + 1} · target ${fmtDuration(recordingForSlot.duration_min)} · ${recordingForSlot.label || "Talk Break"}`
                : selectedSlotPos !== null ? "Recording for selected slot" : "Select a break slot on the right to set target duration"
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
        </div>
      </div>

      {/* ══════════════ RIGHT — Break Slots + Library ══════════════ */}
      <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-secondary)" }}>

        {/* Slot header */}
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 4 }}>BREAK SLOTS</div>
          {selectedTrackId && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 9, color: "#a78bfa", fontWeight: 700 }}>Click a slot to assign</span>
              <button onClick={() => setSelectedTrackId(null)} style={{ fontSize: 8, padding: "1px 6px", background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", cursor: "pointer", borderRadius: 0, marginLeft: "auto" }}>cancel</button>
            </div>
          )}
        </div>

        {/* Slots list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
          {!selectedClock ? (
            <div style={{ padding: "24px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 }}>No clock for {fmtHour(selectedHour)}</div>
              <div style={{ fontSize: 9, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                Set up shows and clocks in Schedule to see break slots here.
              </div>
            </div>
          ) : talkSlots.length === 0 ? (
            <div style={{ padding: "24px 12px", textAlign: "center", fontSize: 10, color: "var(--text-tertiary)" }}>
              No talk break slots in this clock.
            </div>
          ) : (
            talkSlots.map(slot => (
              <SlotCard key={slot.id} slot={slot} tracks={tracks} selectedTrackId={selectedTrackId}
                isSelected={selectedSlotPos === slot.position}
                onAssign={(slotId, trackId) => { assignToSlot(slotId, trackId); setSelectedTrackId(null); }}
                onUnassign={unassignFromSlot} onPlay={playTrack}
                onRecordFor={s => { setRecordingForSlot(s); setTrackTitle(s.label || "Talk Break"); setSelectedSlotPos(s.position); }}
                onSelect={s => setSelectedSlotPos(s.position === selectedSlotPos ? null : s.position)}
                playingId={playingId}
              />
            ))
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
