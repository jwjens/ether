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
  // runtime — which voice track is assigned
  voice_track_id?: number | null;
  voice_track_title?: string | null;
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

const SLOT_COLOR: Record<string, string> = {
  talkset:    "#a78bfa",
  talk_break: "#a78bfa",
  spot_break: "#f87171",
  music:      "#38bdf8",
  liner:      "#fb923c",
  sweeper:    "#34d399",
  news:       "#fbbf24",
  jingle:     "#e879f9",
};

const isTalkSlot = (t: string) => t === "talkset" || t === "talk_break";

// ─── VU Meter ─────────────────────────────────────────────────

function VUMeter({ level, peak, recording }: { level: number; peak: number; recording: boolean }) {
  const BARS = 32;
  const active = Math.min(BARS, Math.round(level * BARS * 10));
  const peakBar = Math.min(BARS - 1, Math.round(peak * BARS * 10));
  return (
    <div style={{ padding: "10px 14px", background: "#080808" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.2)", letterSpacing: "0.15em", textTransform: "uppercase" }}>INPUT LEVEL</span>
        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", color: !recording ? "rgba(255,255,255,0.15)" : level > 0.7 ? "#a02020" : level > 0.35 ? "#a07020" : "#008878" }}>
          {!recording ? "—" : level > 0.7 ? "HOT" : level > 0.35 ? "GOOD" : "LOW"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 2.5, alignItems: "flex-end", height: 44 }}>
        {Array.from({ length: BARS }).map((_, i) => {
          const pct = i / BARS;
          const color = pct > 0.80 ? "#a02020" : pct > 0.60 ? "#a07020" : "#008878";
          const barH = 16 + pct * 28;
          const isActive = i < active;
          const isPeak = i === peakBar && recording && peakBar > 0;
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
              {isPeak && <div style={{ width: "100%", height: 2, borderRadius: 0, background: color }} />}
              <div style={{ width: "100%", height: barH, borderRadius: 0, background: isActive ? color : "#111116", transition: "background 0.04s" }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Clock Slot Row (drag target) ────────────────────────────

function fmtDuration(min: number): string {
  if (min <= 0) return "open";
  const totalSec = Math.round(min * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `:${String(s).padStart(2, "0")}`;
  if (s === 0) return `${m}:00`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function SlotRow({
  slot, tracks, selectedTrackId, onAssign, onUnassign, onPlay, onRecordFor, playingId,
}: {
  slot: ClockSlot;
  tracks: VoiceTrack[];
  selectedTrackId: number | null;
  onAssign: (slotId: number, trackId: number) => void;
  onUnassign: (slotId: number) => void;
  onPlay: (t: VoiceTrack) => void;
  onRecordFor: (slot: ClockSlot) => void;
  playingId: number | null;
}) {
  const isTalk = isTalkSlot(slot.slot_type);
  const color = SLOT_COLOR[slot.slot_type] || "#64748b";
  const assigned = tracks.find(t => t.clock_slot_id === slot.id);
  const isPlaying = assigned ? playingId === assigned.id : false;
  const canReceive = isTalk && !assigned && selectedTrackId !== null;

  // Actual vs target comparison
  const targetMs = slot.duration_min * 60000;
  const actualMs = assigned?.duration_ms ?? 0;
  const diff = actualMs - targetMs;
  const diffLabel = Math.abs(diff) < 3000 ? null
    : diff > 0 ? `+${fmtMs(diff)} over`
    : `${fmtMs(Math.abs(diff))} short`;
  const diffColor = diff > 5000 ? "#fbbf24" : diff < -10000 ? "#f87171" : "#34d399";

  return (
    <div
      onClick={() => { if (canReceive) onAssign(slot.id, selectedTrackId!); }}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 14px", borderRadius: 0,
        border: canReceive
          ? `2px dashed ${color}`
          : assigned
          ? `1px solid ${color}55`
          : `1px solid ${isTalk ? color + "35" : "var(--border-primary)"}`,
        background: canReceive
          ? color + "10"
          : assigned
          ? color + "08"
          : isTalk ? "var(--bg-secondary)" : "var(--bg-tertiary)",
        transition: "all 0.12s",
        opacity: isTalk ? 1 : 0.45,
        cursor: canReceive ? "pointer" : "default",
        boxShadow: canReceive ? `0 0 0 2px ${color}30` : "none",
      }}
    >
      {/* Position number */}
      <div style={{ width: 24, height: 24, borderRadius: 0, background: color + "22", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <span style={{ fontSize: 9, fontWeight: 800, color }}>{slot.position + 1}</span>
      </div>

      {/* TALK badge */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color, background: color + "20", borderRadius: 0, padding: "2px 6px", display: "inline-block" }}>
          {isTalk ? "TALK" : slot.slot_type.toUpperCase().slice(0, 5)}
        </div>
      </div>

      {/* Label + target duration */}
      <div style={{ minWidth: 70, flexShrink: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: isTalk ? "var(--text-primary)" : "var(--text-tertiary)" }}>
          {slot.label || (isTalk ? "Talk Break" : slot.slot_type)}
        </div>
        <div style={{ fontSize: 9, color: color + "80", fontFamily: "'DM Mono', monospace", fontWeight: 700 }}>
          target {fmtDuration(slot.duration_min)}
        </div>
      </div>

      {/* Right side */}
      {isTalk && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
          {assigned ? (
            // ── Assigned: show actual length + diff from target ──
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: color + "15", border: `1px solid ${color}40`, borderRadius: 0, padding: "5px 10px", flex: 1 }}>
              <button
                onClick={e => { e.stopPropagation(); onPlay(assigned); }}
                style={{ width: 22, height: 22, borderRadius: "50%", border: "none", background: isPlaying ? color : color + "30", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isPlaying ? "#000" : color, flexShrink: 0 }}
              >
                {isPlaying
                  ? <svg width="7" height="8" viewBox="0 0 8 9" fill="currentColor"><rect x="0" y="0" width="2.5" height="9" rx="1"/><rect x="5" y="0" width="2.5" height="9" rx="1"/></svg>
                  : <svg width="7" height="8" viewBox="0 0 6 8" fill="currentColor" style={{ marginLeft: 1 }}><polygon points="0,0 6,4 0,8"/></svg>
                }
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{assigned.title}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 9, color: color + "80", fontFamily: "'DM Mono', monospace" }}>
                    {fmtMs(actualMs)} actual
                  </span>
                  {diffLabel && (
                    <span style={{ fontSize: 8, fontWeight: 700, color: diffColor, background: diffColor + "18", borderRadius: 0, padding: "1px 4px" }}>
                      {diffLabel}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); onUnassign(slot.id); }}
                style={{ flexShrink: 0, fontSize: 11, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
              >✕</button>
            </div>
          ) : canReceive ? (
            // ── A track is selected — ready to assign ──
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 0, background: color + "20", border: `1px solid ${color}60`, cursor: "pointer" }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ color }}><polyline points="20 6 9 17 4 12"/></svg>
              <span style={{ fontSize: 11, fontWeight: 700, color }}>Click to assign</span>
            </div>
          ) : (
            // ── Empty — offer to record directly for this slot ──
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontStyle: "italic", opacity: 0.5 }}>— empty —</span>
              <button
                onClick={e => { e.stopPropagation(); onRecordFor(slot); }}
                style={{ fontSize: 9, fontWeight: 700, padding: "3px 9px", borderRadius: 0, background: color + "15", border: `1px solid ${color}35`, color, cursor: "pointer", letterSpacing: "0.04em" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = color + "25"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = color + "15"; }}
              >
                ● REC
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Track Card (click-to-select + draggable) ─────────────────

function TrackCard({
  track, selected, onSelect, onPlay, onQueue, onDelete, playingId, playProgress,
}: {
  track: VoiceTrack;
  selected: boolean;
  onSelect: (id: number | null) => void;
  onPlay: (t: VoiceTrack) => void;
  onQueue: (t: VoiceTrack) => void;
  onDelete: (id: number) => void;
  playingId: number | null;
  playProgress: Record<number, number>;
}) {
  const isPlaying = playingId === track.id;
  const progress = playProgress[track.id] || 0;

  return (
    <div
      onClick={() => onSelect(selected ? null : track.id)}
      style={{
        padding: "10px 14px", borderRadius: 0, cursor: "pointer",
        background: selected
          ? "rgba(167,139,250,0.12)"
          : isPlaying ? "rgba(52,211,153,0.06)" : "var(--bg-tertiary)",
        border: selected
          ? "2px solid #a78bfa"
          : isPlaying ? "1px solid rgba(52,211,153,0.3)" : "1px solid var(--border-primary)",
        transition: "all 0.12s",
        display: "flex", alignItems: "center", gap: 10,
        boxShadow: selected ? "0 0 0 3px rgba(167,139,250,0.15)" : "none",
      }}
    >
      {/* Selection indicator / drag handle */}
      <div style={{ width: 20, height: 20, borderRadius: 0, flexShrink: 0, border: `1.5px solid ${selected ? "#a78bfa" : "var(--border-secondary)"}`, background: selected ? "#a78bfa" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}>
        {selected
          ? <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><polyline points="1,3.5 3.5,6 8,1" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          : <svg width="8" height="10" viewBox="0 0 8 10" fill="var(--text-tertiary)" style={{ opacity: 0.3 }}><circle cx="2.5" cy="2" r="1"/><circle cx="5.5" cy="2" r="1"/><circle cx="2.5" cy="5" r="1"/><circle cx="5.5" cy="5" r="1"/><circle cx="2.5" cy="8" r="1"/><circle cx="5.5" cy="8" r="1"/></svg>
        }
      </div>

      {/* Play button */}
      <button
        onClick={e => { e.stopPropagation(); onPlay(track); }}
        style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, background: isPlaying ? "var(--accent-green)" : "var(--bg-secondary)", border: `1px solid ${isPlaying ? "var(--accent-green)" : "var(--border-secondary)"}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isPlaying ? "#000" : "var(--text-secondary)" }}
      >
        {isPlaying
          ? <svg width="7" height="8" viewBox="0 0 8 9" fill="currentColor"><rect x="0" y="0" width="3" height="9" rx="1"/><rect x="5" y="0" width="3" height="9" rx="1"/></svg>
          : <svg width="7" height="8" viewBox="0 0 6 8" fill="currentColor" style={{ marginLeft: 1 }}><polygon points="0,0 8,5 0,10"/></svg>
        }
      </button>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: selected ? "#a78bfa" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{track.title}</span>
          <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", marginLeft: "auto", flexShrink: 0 }}>{fmtMs(track.duration_ms)}</span>
        </div>
        <div style={{ height: 2, background: "var(--bg-secondary)", borderRadius: 0, overflow: "hidden" }}>
          <div style={{ height: "100%", width: (progress * 100) + "%", background: "var(--accent-green)", borderRadius: 0 }} />
        </div>
        <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, color: "var(--text-tertiary)" }}>{fmtDate(track.recorded_at)}</span>
          {track.clock_slot_id
            ? <span style={{ fontSize: 8, fontWeight: 700, background: "rgba(52,211,153,0.15)", color: "#34d399", borderRadius: 0, padding: "1px 5px" }}>✓ ASSIGNED</span>
            : <span style={{ fontSize: 8, color: "var(--text-tertiary)", opacity: 0.5 }}>unassigned</span>
          }
        </div>
      </div>

      {/* Actions */}
      <button onClick={e => { e.stopPropagation(); onQueue(track); }} style={{ padding: "3px 8px", borderRadius: 0, fontSize: 9, fontWeight: 700, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", flexShrink: 0 }}>Q</button>
      <button onClick={e => { e.stopPropagation(); onDelete(track.id); }} style={{ fontSize: 11, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "4px", flexShrink: 0 }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
      >✕</button>
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

  // Which talk slot the DJ is recording for (sets target duration)
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
    setTracks(tr);
    setShows(sh);
    setClocks(cl);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Clear any stale waveform from previous session
  useEffect(() => { wavePointsRef.current = []; }, []);

  // FIX: Ensure clock_slot_id column exists (safe to run every time)
  useEffect(() => {
    execute("ALTER TABLE voice_tracks ADD COLUMN clock_slot_id INTEGER").catch(() => {});
  }, []);

  // ── When hour changes, find matching show → clock → slots ──

  useEffect(() => {
    const matchingShow = shows.find(s => {
      const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour;
      return selectedHour >= s.start_hour && selectedHour < end;
    });
    const clockId = matchingShow?.clock_id ?? null;
    setSelectedClock(clockId);
  }, [selectedHour, shows]);

  useEffect(() => {
    if (!selectedClock) { setClockSlots([]); return; }
    query<ClockSlot>(
      `SELECT cs.*, c.code as category_code
       FROM clock_slots cs
       LEFT JOIN categories c ON c.id = cs.category_id
       WHERE cs.clock_id = ?
       ORDER BY cs.position`,
      [selectedClock]
    ).then(slots => {
      // Attach which voice track is assigned to each slot
      const enriched = slots.map(slot => {
        const assigned = tracks.find(t => t.clock_slot_id === slot.id);
        return { ...slot, voice_track_id: assigned?.id ?? null, voice_track_title: assigned?.title ?? null };
      });
      setClockSlots(enriched);
    });
  }, [selectedClock, tracks]);

  // ── Waveform drawing ──

  const drawWaveform = useCallback(() => {
    const canvas = waveCanvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = devicePixelRatio || 1;
    const w = canvas.offsetWidth * dpr; const h = canvas.offsetHeight * dpr;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    const pts = wavePointsRef.current;

    ctx.strokeStyle = "rgba(255,255,255,0.04)"; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, h/4*i); ctx.lineTo(w, h/4*i); ctx.stroke(); }

    if (pts.length > 1) {
      const step = w / Math.max(pts.length, 200);
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(248,113,113,0.7)");
      grad.addColorStop(0.5, "rgba(248,113,113,0.2)");
      grad.addColorStop(1, "rgba(248,113,113,0.05)");

      ctx.beginPath(); ctx.moveTo(0, h/2);
      pts.forEach((v, i) => ctx.lineTo(i * step, h/2 - v * (h/2) * 0.85));
      ctx.lineTo(pts.length * step, h/2);
      ctx.fillStyle = grad; ctx.fill();

      const gradB = ctx.createLinearGradient(0, h, 0, 0);
      gradB.addColorStop(0, "rgba(248,113,113,0.5)");
      gradB.addColorStop(0.5, "rgba(248,113,113,0.08)");
      gradB.addColorStop(1, "rgba(248,113,113,0.01)");
      ctx.beginPath(); ctx.moveTo(0, h/2);
      pts.forEach((v, i) => ctx.lineTo(i * step, h/2 + v * (h/2) * 0.85));
      ctx.lineTo(pts.length * step, h/2);
      ctx.fillStyle = gradB; ctx.fill();

      ctx.beginPath(); ctx.moveTo(0, h/2);
      pts.forEach((v, i) => ctx.lineTo(i * step, h/2 - v * (h/2) * 0.85));
      ctx.strokeStyle = "#f87171"; ctx.lineWidth = 2 * dpr;
      ctx.shadowColor = "#f87171"; ctx.shadowBlur = 10 * dpr;
      ctx.stroke(); ctx.shadowBlur = 0;
    }

    ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2);
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]); ctx.stroke(); ctx.setLineDash([]);
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
      const constraints = inputDeviceId
        ? { audio: { deviceId: { exact: inputDeviceId } } }
        : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const ctx = new AudioContext(); audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      source.connect(analyser); analyserRef.current = analyser;

      // FIX: WebView2 on Windows often doesn't support audio/webm;codecs=opus.
      // Try supported mimeTypes in order, fall back to browser default.
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg",
        "",
      ].find(m => m === "" || MediaRecorder.isTypeSupported(m)) ?? "";

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
    setRecording(false);
    setInputLevel(0);

    const durMs = Date.now() - startTimeRef.current;

    // Guard: only save once regardless of which path fires first
    let saved = false;

    // Force flush any buffered data before stopping
    try { mr.requestData(); } catch {}

    const saveRecording = async () => {
      if (saved) return;
      saved = true;

      try {
        if (chunksRef.current.length === 0) {
          alert("Recording failed — no audio was captured. Make sure your mic is selected in Settings → Audio Devices.");
          return;
        }

        const mimeType = mr.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const title = trackTitle.trim() ||
          `Break ${fmtHour(selectedHour)} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

        const matchingShow = shows.find(s => {
          const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour;
          return selectedHour >= s.start_hour && selectedHour < end;
        });

        await new Promise<void>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = async () => {
            try {
              try {
                await execute(
                  "INSERT INTO voice_tracks (title, file_path, show_id, duration_ms, recorded_by, clock_slot_id) VALUES (?,?,?,?,?,?)",
                  [title, reader.result as string, matchingShow?.id ?? null, durMs, djName, null]
                );
              } catch {
                await execute(
                  "INSERT INTO voice_tracks (title, file_path, show_id, duration_ms, recorded_by) VALUES (?,?,?,?,?)",
                  [title, reader.result as string, matchingShow?.id ?? null, durMs, djName]
                );
              }
              setTrackTitle("");
              load().then(async () => {
                // If recording was targeted at a specific slot, auto-assign it
                if (recordingForSlot) {
                  const latest = await query<VoiceTrack>(
                    "SELECT * FROM voice_tracks ORDER BY recorded_at DESC LIMIT 1"
                  );
                  if (latest.length > 0) {
                    await execute("UPDATE voice_tracks SET clock_slot_id = NULL WHERE clock_slot_id = ?", [recordingForSlot.id]);
                    await execute("UPDATE voice_tracks SET clock_slot_id = ? WHERE id = ?", [recordingForSlot.id, latest[0].id]);
                    load();
                  }
                  setRecordingForSlot(null);
                }
              });
              resolve();
            } catch (e) {
              reject(e);
            }
          };
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.error("[VoiceTracker] save failed:", e);
        alert("Failed to save recording: " + String(e));
      } finally {
        mr.stream.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close().catch(() => {});
      }
    };

    mr.addEventListener("stop", saveRecording, { once: true });

    // Fallback: if stop event never fires, save after 3s
    setTimeout(() => saveRecording(), 3000);

    mr.stop();
  };

  // ── Playback ──

  const playTrack = (track: VoiceTrack) => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (playingId === track.id) { setPlayingId(null); return; }
    const audio = new Audio(track.file_path);
    audioRef.current = audio;
    setPlayingId(track.id);
    audio.ontimeupdate = () => setPlayProgress(p => ({ ...p, [track.id]: audio.currentTime / (audio.duration || 1) }));
    audio.onended = () => { setPlayingId(null); setPlayProgress(p => ({ ...p, [track.id]: 0 })); };
    audio.play();
  };

  const queueTrack = (t: VoiceTrack) =>
    engine.addToQueue([{ filePath: t.file_path, title: "[VT] " + t.title, artist: t.recorded_by || "DJ" }]);

  const deleteTrack = async (id: number) => {
    if (!confirm("Delete this voice track?")) return;
    if (playingId === id) { audioRef.current?.pause(); setPlayingId(null); }
    await execute("DELETE FROM voice_tracks WHERE id = ?", [id]);
    load();
  };

  // ── Slot assignment (drag & drop) ──

  const assignToSlot = async (slotId: number, trackId: number) => {
    // Remove from any previous slot
    await execute("UPDATE voice_tracks SET clock_slot_id = NULL WHERE clock_slot_id = ?", [slotId]);
    await execute("UPDATE voice_tracks SET clock_slot_id = ? WHERE id = ?", [slotId, trackId]);
    load();
  };

  const unassignFromSlot = async (slotId: number) => {
    await execute("UPDATE voice_tracks SET clock_slot_id = NULL WHERE clock_slot_id = ?", [slotId]);
    load();
  };

  // ── Derived ──

  const talkSlots   = clockSlots.filter(s => isTalkSlot(s.slot_type));
  const otherSlots  = clockSlots.filter(s => !isTalkSlot(s.slot_type));
  const filled      = talkSlots.filter(s => tracks.some(t => t.clock_slot_id === s.id)).length;
  const matchedClock = clocks.find(c => c.id === selectedClock);
  const matchedShow  = shows.find(s => {
    const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour;
    return selectedHour >= s.start_hour && selectedHour < end;
  });

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", gap: 20, fontFamily: "'Inter', system-ui, sans-serif", height: "100%", overflow: "hidden" }}>

      {/* ═══════════════════════════════════════════════════════
          LEFT — Dark Studio Panel
      ═══════════════════════════════════════════════════════ */}
      <div style={{
        width: 460, flexShrink: 0,
        background: "linear-gradient(160deg, #0f0f1a 0%, #13131f 60%, #0a0a14 100%)",
        borderRadius: 0,
        border: `1px solid ${recording ? "rgba(248,113,113,0.3)" : "rgba(255,255,255,0.08)"}`,
        boxShadow: recording ? "0 0 60px rgba(248,113,113,0.2), inset 0 0 80px rgba(248,113,113,0.03)" : "0 8px 40px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        transition: "border-color 0.4s, box-shadow 0.4s",
      }}>

        {/* Studio header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: recording ? "#f87171" : "rgba(255,255,255,0.15)", boxShadow: recording ? "0 0 14px #f87171, 0 0 28px rgba(248,113,113,0.4)" : "none", animation: recording ? "vt-pulse 1s infinite" : "none", transition: "all 0.3s" }} />
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.2em", textTransform: "uppercase", color: recording ? "#f87171" : "rgba(255,255,255,0.25)" }}>
              {recording ? "● RECORDING" : "STUDIO"}
            </span>
          </div>
          {recording && (() => {
            const targetMs = recordingForSlot ? recordingForSlot.duration_min * 60000 : 0;
            const over = targetMs > 0 && recordTime > targetMs;
            const pct = targetMs > 0 ? Math.min(recordTime / targetMs, 1) : 0;
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {/* Progress bar toward target */}
                {targetMs > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                    <div style={{ width: 80, height: 3, borderRadius: 0, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: (pct * 100) + "%", borderRadius: 0, background: over ? "#f87171" : pct > 0.85 ? "#fbbf24" : "#34d399", transition: "width 0.1s, background 0.3s" }} />
                    </div>
                    <span style={{ fontSize: 8, fontFamily: "'DM Mono', monospace", color: over ? "#f87171" : "rgba(255,255,255,0.25)", letterSpacing: "0.06em" }}>
                      {over ? `+${fmtMsFull(recordTime - targetMs)} over` : `target ${fmtDuration(recordingForSlot!.duration_min)}`}
                    </span>
                  </div>
                )}
                {/* Elapsed */}
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, fontWeight: 300, color: over ? "#fbbf24" : "#f87171", letterSpacing: "-0.03em" }}>
                  {fmtMsFull(recordTime)}
                </span>
              </div>
            );
          })()}
        </div>

        {/* ── Hour / Clock selector ── */}
        <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.16em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase", marginBottom: 8 }}>Recording for hour</div>

          {/* Hour dropdown — scrollable 24h list */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={selectedHour}
              onChange={e => setSelectedHour(parseInt(e.target.value))}
              disabled={recording}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", outline: "none", cursor: "pointer", fontFamily: "'DM Mono', monospace", colorScheme: "dark" }}
            >
              {Array.from({ length: 24 }, (_, h) => {
                const show = shows.find(s => {
                  const end = s.end_hour <= s.start_hour ? s.end_hour + 24 : s.end_hour;
                  return h >= s.start_hour && h < end;
                });
                return (
                  <option key={h} value={h} style={{ background: "#1a1a2e", color: "#fff" }}>
                    {fmtHour(h)}{show ? `  —  ${show.name}` : ""}
                  </option>
                );
              })}
            </select>

            {/* Clock badge */}
            {matchedClock && (
              <div style={{ padding: "6px 10px", borderRadius: 0, background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.25)", flexShrink: 0 }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(167,139,250,0.7)", textTransform: "uppercase", marginBottom: 1 }}>Clock</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#a78bfa" }}>{matchedClock.name}</div>
              </div>
            )}
          </div>

          {/* Show & talk slot summary */}
          {matchedShow && (
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: matchedShow.color || "#64748b", flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{matchedShow.name}</span>
              {talkSlots.length > 0 && (
                <>
                  <span style={{ color: "rgba(255,255,255,0.15)" }}>·</span>
                  <span style={{ fontSize: 11, color: filled === talkSlots.length ? "#34d399" : "#f87171", fontWeight: 700 }}>
                    {filled}/{talkSlots.length} talk breaks filled
                  </span>
                </>
              )}
              {!selectedClock && (
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", fontStyle: "italic" }}>No clock assigned to this show</span>
              )}
            </div>
          )}
          {!matchedShow && (
            <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.2)", fontStyle: "italic" }}>No show scheduled at {fmtHour(selectedHour)}</div>
          )}
        </div>

        {/* Session fields */}
        <div style={{ padding: "12px 20px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Your name"
              value={djName}
              onChange={e => setDjName(e.target.value)}
              style={{ width: 130, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", outline: "none" }}
            />
            <input
              placeholder="Break title — Morning opener..."
              value={trackTitle}
              onChange={e => setTrackTitle(e.target.value)}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", outline: "none" }}
            />
          </div>
        </div>

        {/* Waveform monitor */}
        <div style={{ margin: "0 20px", flex: 1, minHeight: 120, background: "rgba(0,0,0,0.5)", borderRadius: 0, border: "1px solid rgba(255,255,255,0.05)", position: "relative", overflow: "hidden" }}>
          {!recording && wavePointsRef.current.length === 0 && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" strokeLinecap="round"><path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.12)", letterSpacing: "0.1em" }}>WAVEFORM</div>
            </div>
          )}
          <canvas ref={waveCanvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
        </div>

        {/* VU Meter */}
        <div style={{ margin: "12px 20px 0" }}>
          <VUMeter level={inputLevel} peak={peakLevel} recording={recording} />
        </div>

        {/* Record button */}
        <div style={{ padding: "14px 20px 16px", display: "flex", alignItems: "center", gap: 14 }}>
          {!recording ? (
            <button onClick={startRecording} style={{ width: 60, height: 60, borderRadius: "50%", flexShrink: 0, background: "radial-gradient(circle at 35% 35%, #ff6b6b, #ef4444)", border: "4px solid rgba(239,68,68,0.25)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 28px rgba(239,68,68,0.45), 0 4px 16px rgba(0,0,0,0.5)" }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "0 2px 6px rgba(0,0,0,0.3)" }} />
            </button>
          ) : (
            <button onClick={stopRecording} style={{ width: 60, height: 60, borderRadius: "50%", flexShrink: 0, background: "#0a0a14", border: "4px solid #f87171", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 28px rgba(248,113,113,0.35)" }}>
              <div style={{ width: 16, height: 16, borderRadius: 0, background: "#f87171" }} />
            </button>
          )}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: recording ? "#f87171" : "rgba(255,255,255,0.4)" }}>
              {recording ? "Recording — click to stop" : "Click to record"}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 3 }}>
              {recording
                ? recordingForSlot
                  ? `Target: ${fmtDuration(recordingForSlot.duration_min)} · ${recordingForSlot.label || "Talk Break"}`
                  : "Saves automatically when you stop"
                : recordingForSlot
                  ? `Recording for slot ${recordingForSlot.position + 1} · aim for ${fmtDuration(recordingForSlot.duration_min)}`
                  : `${fmtHour(selectedHour)}${matchedShow ? " · " + matchedShow.name : ""} · select a slot to set target`
              }
            </div>
          </div>
        </div>

        {/* Recorded tracks mini-list */}
        {tracks.length > 0 && (
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", overflowY: "auto", maxHeight: 200 }}>
            <div style={{ padding: "8px 20px 4px", fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.2)", letterSpacing: "0.15em", textTransform: "uppercase" }}>
              Recorded breaks ({tracks.length}) — drag to assign
            </div>
            {tracks.map((t, i) => {
              const isPlaying = playingId === t.id;
              const progress = playProgress[t.id] || 0;
              return (
                <div
                  key={t.id}
                  onClick={() => setSelectedTrackId(selectedTrackId === t.id ? null : t.id)}
                  style={{ padding: "8px 20px", borderBottom: i < tracks.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", background: selectedTrackId === t.id ? "rgba(167,139,250,0.15)" : "transparent", transition: "background 0.1s" }}
                >
                  <button onClick={() => playTrack(t)} style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, background: isPlaying ? "#34d399" : "rgba(255,255,255,0.07)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isPlaying ? "#000" : "#fff" }}>
                    {isPlaying ? <svg width="7" height="9" viewBox="0 0 7 9" fill="currentColor"><rect x="0" y="0" width="2.5" height="9" rx="1"/><rect x="4.5" y="0" width="2.5" height="9" rx="1"/></svg> : <svg width="6" height="8" viewBox="0 0 6 8" fill="currentColor" style={{ marginLeft: 1 }}><polygon points="0,0 6,4 0,8"/></svg>}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</div>
                    <div style={{ height: 2, background: "rgba(255,255,255,0.07)", borderRadius: 0, marginTop: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: (progress * 100) + "%", background: "#34d399" }} />
                    </div>
                  </div>
                  <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "rgba(255,255,255,0.3)", flexShrink: 0 }}>{fmtMs(t.duration_ms)}</span>
                  {t.clock_slot_id && <span style={{ fontSize: 8, color: "#a78bfa", flexShrink: 0 }}>●</span>}
                  <button onClick={() => queueTrack(t)} style={{ padding: "2px 7px", borderRadius: 0, fontSize: 9, fontWeight: 700, background: "rgba(56,189,248,0.12)", color: "#38bdf8", border: "none", cursor: "pointer" }}>Q</button>
                  <button onClick={() => deleteTrack(t.id)} style={{ fontSize: 10, color: "rgba(255,255,255,0.18)", background: "none", border: "none", cursor: "pointer" }}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════
          RIGHT — Clock slots always visible, library below
      ═══════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 14, overflow: "hidden", minWidth: 0 }}>

        {/* Right header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Voice Tracking</h1>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 0" }}>
              Record a break · drag it onto a purple TALK slot below
            </p>
          </div>
          {talkSlots.length > 0 && (
            <div style={{ fontSize: 12, fontWeight: 700, color: filled === talkSlots.length ? "var(--accent-green)" : "var(--accent-red)", flexShrink: 0 }}>
              {filled}/{talkSlots.length} talk breaks filled
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>

          {/* ── CLOCK SLOTS — always shown ── */}
          {!selectedClock ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 40, background: "var(--bg-secondary)", borderRadius: 0, border: "1px solid var(--border-primary)" }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" style={{ opacity: 0.4 }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>No format clock for {fmtHour(selectedHour)}</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", textAlign: "center", maxWidth: 300, lineHeight: 1.6 }}>
                {shows.length === 0
                  ? <>No shows configured yet. Go to <strong style={{ color: "var(--accent-cyan)" }}>Schedule → Show Scheduler → Shows & Dayparts</strong> to create a show, then assign a Format Clock to it.</>
                  : matchedShow
                  ? <><strong style={{ color: "#a78bfa" }}>{matchedShow.name}</strong> has no clock assigned. Go to <strong style={{ color: "var(--accent-cyan)" }}>Schedule → Show Scheduler → Shows & Dayparts</strong> and assign a Format Clock to this show.</>
                  : <>No show covers {fmtHour(selectedHour)}. Go to <strong style={{ color: "var(--accent-cyan)" }}>Schedule → Show Scheduler → Shows & Dayparts</strong> to set up your dayparts.</>
                }
              </div>
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", background: "var(--bg-tertiary)", borderRadius: 0, padding: "8px 14px", border: "1px solid var(--border-primary)" }}>
                💡 You can still record breaks now — assign them to slots once the clock is set up
              </div>
            </div>
          ) : (
            <>
              {/* Fill progress */}
              {talkSlots.length > 0 && (
                <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "12px 16px", flexShrink: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Talk Breaks — drag your recorded breaks onto the slots below</span>
                    <span style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", fontWeight: 700, color: filled === talkSlots.length ? "var(--accent-green)" : "var(--accent-red)" }}>
                      {filled} / {talkSlots.length}
                    </span>
                  </div>
                  <div style={{ height: 5, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: ((filled / Math.max(talkSlots.length, 1)) * 100) + "%", background: filled === talkSlots.length ? "var(--accent-green)" : "linear-gradient(90deg, var(--accent-red), var(--accent-amber))", borderRadius: 0, transition: "width 0.4s" }} />
                  </div>
                </div>
              )}

              {/* Talk slots */}
              {talkSlots.length > 0 && (
                <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden", flexShrink: 0 }}>
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 0, background: "#a78bfa" }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)" }}>Talk Break Slots</span>
                    {selectedTrackId
                      ? <span style={{ fontSize: 10, color: "#a78bfa", fontWeight: 700 }}>← click a slot to assign "{tracks.find(t => t.id === selectedTrackId)?.title}"</span>
                      : <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>select a recorded break below, then click a slot</span>
                    }
                    {selectedTrackId && (
                      <button onClick={() => setSelectedTrackId(null)} style={{ marginLeft: "auto", fontSize: 9, padding: "2px 8px", borderRadius: 0, background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", cursor: "pointer" }}>cancel</button>
                    )}
                  </div>
                  <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 5 }}>
                    {talkSlots.map(slot => (
                      <SlotRow key={slot.id} slot={slot} tracks={tracks} selectedTrackId={selectedTrackId}
                        onAssign={(slotId, trackId) => { assignToSlot(slotId, trackId); setSelectedTrackId(null); }}
                        onUnassign={unassignFromSlot}
                        onPlay={playTrack}
                        onRecordFor={slot => { setRecordingForSlot(slot); setTrackTitle(slot.label || "Talk Break"); }}
                        playingId={playingId}
                      />
                    ))}
                  </div>
                </div>
              )}


              {clockSlots.length === 0 && (
                <div style={{ textAlign: "center", padding: "32px 24px", color: "var(--text-tertiary)", fontSize: 13 }}>
                  This clock has no slots yet. Add some in Scheduler → Format Clocks.
                </div>
              )}
            </>
          )}

          {/* ── LIBRARY — collapsible, always available for dragging ── */}
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden", flexShrink: 0 }}>
            <button
              onClick={() => setLibExpanded(p => !p)}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", background: "var(--bg-tertiary)", border: "none", cursor: "pointer", textAlign: "left" }}
            >
              <span style={{ fontSize: 9, color: "var(--text-tertiary)", transform: libExpanded ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform 0.15s" }}>▶</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "'Syne', sans-serif" }}>All Recorded Breaks ({tracks.length})</span>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: 4 }}>— click to select, then click a TALK slot above to assign</span>
            </button>
            {libExpanded && (
              tracks.length === 0 ? (
                <div style={{ textAlign: "center", padding: "32px 24px" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No voice tracks yet</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Record your first break in the studio panel on the left</div>
                </div>
              ) : (
                <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                  {tracks.map(t => (
                    <TrackCard key={t.id} track={t} selected={selectedTrackId === t.id} onSelect={setSelectedTrackId} onPlay={playTrack} onQueue={queueTrack} onDelete={deleteTrack} playingId={playingId} playProgress={playProgress} />
                  ))}
                </div>
              )
            )}
          </div>

        </div>
      </div>

      <style>{`
        @keyframes vt-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 14px #f87171, 0 0 28px rgba(248,113,113,0.4); }
          50%       { opacity: 0.5; box-shadow: 0 0 6px #f87171; }
        }
      `}</style>
    </div>
  );
}
