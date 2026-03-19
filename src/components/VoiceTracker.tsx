import { useState, useEffect, useRef, useCallback } from "react";
import { query, execute } from "../db/client";
import { engine } from "../audio/engine-rodio";

interface VoiceTrack {
  id: number; title: string; file_path: string;
  show_id: number | null; duration_ms: number;
  recorded_by: string | null; recorded_at: number;
}

interface Show { id: number; name: string; }

interface ClockSlot {
  index: number;
  type: "song" | "break";
  category?: string;
  label?: string;
  trackId?: number | null;
  durationMin: number;
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2,"0") + ":" + String(s % 60).padStart(2,"0");
}
function fmtMsFull(ms: number): string {
  const s = ms / 1000;
  return String(Math.floor(s / 60)).padStart(2,"0") + ":" + String(Math.floor(s % 60)).padStart(2,"0") + "." + Math.floor((s % 1) * 10);
}
function fmtDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
}

const CAT_COLORS: Record<string, string> = {
  A: "#38bdf8", B: "#34d399", C: "#a78bfa", D: "#fb923c",
  break: "#f87171", jingle: "#22d3ee", psa: "#fbbf24",
};

// Default clock template: typical AC radio hour
const DEFAULT_SLOTS: ClockSlot[] = [
  { index: 0,  type: "song",  category: "A", durationMin: 3.5, label: "Power A" },
  { index: 1,  type: "break", durationMin: 0.5, label: "Break" },
  { index: 2,  type: "song",  category: "B", durationMin: 3.5, label: "Current B" },
  { index: 3,  type: "song",  category: "C", durationMin: 3.5, label: "Recurrent C" },
  { index: 4,  type: "break", durationMin: 0.5, label: "Break" },
  { index: 5,  type: "song",  category: "A", durationMin: 3.5, label: "Power A" },
  { index: 6,  type: "song",  category: "D", durationMin: 3.5, label: "Gold D" },
  { index: 7,  type: "break", durationMin: 0.5, label: "Break" },
  { index: 8,  type: "song",  category: "B", durationMin: 3.5, label: "Current B" },
  { index: 9,  type: "song",  category: "A", durationMin: 3.5, label: "Power A" },
  { index: 10, type: "break", durationMin: 0.5, label: "Break" },
  { index: 11, type: "song",  category: "C", durationMin: 3.5, label: "Recurrent C" },
  { index: 12, type: "song",  category: "D", durationMin: 3.5, label: "Gold D" },
  { index: 13, type: "break", durationMin: 0.5, label: "Break" },
  { index: 14, type: "song",  category: "B", durationMin: 3.5, label: "Current B" },
  { index: 15, type: "song",  category: "A", durationMin: 3.5, label: "Power A" },
];

// ── Programming Clock ────────────────────────────────────────

function ProgrammingClock({ slots, tracks, onAssign, onUnassign, selectedSlot, onSelectSlot }: {
  slots: ClockSlot[];
  tracks: VoiceTrack[];
  onAssign: (slotIdx: number, trackId: number) => void;
  onUnassign: (slotIdx: number) => void;
  selectedSlot: number | null;
  onSelectSlot: (idx: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const SIZE = 320;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const R_OUTER = 140;
  const R_INNER = 80;
  const R_LABEL = 118;

  const totalMin = slots.reduce((s, sl) => s + sl.durationMin, 0);

  // Compute angle ranges for each slot
  const slotAngles = (() => {
    let angle = -Math.PI / 2; // start at 12 o'clock
    return slots.map(sl => {
      const sweep = (sl.durationMin / totalMin) * Math.PI * 2;
      const start = angle;
      angle += sweep;
      return { start, end: angle, mid: start + sweep / 2 };
    });
  })();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = SIZE + "px";
    canvas.style.height = SIZE + "px";
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, SIZE, SIZE);

    // Draw each slot
    slots.forEach((sl, i) => {
      const { start, end, mid } = slotAngles[i];
      const isSelected = selectedSlot === i;
      const isHovered = hoverSlot === i;
      const hasTrack = sl.type === "break" && sl.trackId;

      let color = sl.type === "break"
        ? (hasTrack ? "#34d399" : "#f87171")
        : (CAT_COLORS[sl.category || ""] || "#64748b");

      // Draw arc segment
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(start) * R_INNER, CY + Math.sin(start) * R_INNER);
      ctx.arc(CX, CY, R_OUTER, start, end);
      ctx.arc(CX, CY, R_INNER, end, start, true);
      ctx.closePath();

      ctx.fillStyle = color + (isSelected ? "ff" : isHovered ? "dd" : "99");
      ctx.fill();

      // Border
      ctx.strokeStyle = isSelected ? "#fff" : "rgba(255,255,255,0.15)";
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Label in middle of segment
      const sweep = end - start;
      if (sweep > 0.18) {
        const lx = CX + Math.cos(mid) * R_LABEL;
        const ly = CY + Math.sin(mid) * R_LABEL;
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(mid + Math.PI / 2);
        ctx.fillStyle = sl.type === "break" ? "#fff" : "rgba(255,255,255,0.9)";
        ctx.font = `700 ${sl.type === "break" ? 9 : 10}px Inter, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        if (sl.type === "break") {
          ctx.fillText(hasTrack ? "✓ VT" : "BREAK", 0, 0);
        } else {
          ctx.fillText(sl.category || "", 0, -5);
          ctx.font = "8px Inter, sans-serif";
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.fillText(sl.durationMin.toFixed(1) + "m", 0, 5);
        }
        ctx.restore();
      }
    });

    // Center circle
    ctx.beginPath();
    ctx.arc(CX, CY, R_INNER - 4, 0, Math.PI * 2);
    ctx.fillStyle = "var(--bg-secondary, #13131a)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Center text
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "700 11px Syne, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("1 HOUR", CX, CY - 7);
    ctx.font = "9px Inter, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillText(totalMin.toFixed(0) + " min", CX, CY + 8);

    // 12 o'clock tick
    ctx.beginPath();
    ctx.moveTo(CX, CY - R_OUTER - 4);
    ctx.lineTo(CX, CY - R_OUTER + 4);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();

  }, [slots, selectedSlot, hoverSlot]);

  const getSlotFromPoint = (x: number, y: number): number | null => {
    const dx = x - CX;
    const dy = y - CY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < R_INNER || dist > R_OUTER) return null;
    let angle = Math.atan2(dy, dx);
    if (angle < -Math.PI / 2) angle += Math.PI * 2;
    const startAngle = -Math.PI / 2;
    const normalizedAngle = angle - startAngle;
    const pct = ((normalizedAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    let cumulative = 0;
    const total = Math.PI * 2;
    for (let i = 0; i < slots.length; i++) {
      cumulative += (slots[i].durationMin / totalMin) * total;
      if (pct < cumulative) return i;
    }
    return null;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = getSlotFromPoint(e.clientX - rect.left, e.clientY - rect.top);
    setHoverSlot(idx);
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = getSlotFromPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (idx !== null) onSelectSlot(selectedSlot === idx ? null : idx);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, alignItems: "center", gap: 12 }}>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverSlot(null)}
        onClick={handleClick}
        style={{ cursor: "pointer", borderRadius: "50%" }}
      />

      {/* Slot detail panel */}
      {selectedSlot !== null && (
        <div style={{ width: "100%", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 12, padding: 14 }}>
          {slots[selectedSlot].type === "break" ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 10 }}>
                🎙 Break slot — assign a voice track
              </div>
              {slots[selectedSlot].trackId ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.3)", borderRadius: 8, padding: "8px 12px" }}>
                  <span style={{ fontSize: 12, color: "var(--accent-green)", fontWeight: 500 }}>
                    ✓ {tracks.find(t => t.id === slots[selectedSlot].trackId)?.title || "Voice Track"}
                  </span>
                  <button onClick={() => onUnassign(selectedSlot)} style={{ fontSize: 10, color: "var(--accent-red)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Remove</button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" as any, gap: 6 }}>
                  {tracks.length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>Record a voice track first, then assign it here</div>
                  ) : tracks.map(t => (
                    <button key={t.id} onClick={() => onAssign(selectedSlot, t.id)} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                      background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
                      color: "var(--text-primary)", textAlign: "left" as any,
                    }}>
                      <span style={{ fontSize: 12, fontWeight: 500 }}>{t.title}</span>
                      <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)" }}>{fmtMs(t.duration_ms)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              <span style={{ fontWeight: 600, color: CAT_COLORS[slots[selectedSlot].category || ""] || "var(--text-primary)" }}>Category {slots[selectedSlot].category}</span>
              {" · "}{slots[selectedSlot].durationMin} min · {slots[selectedSlot].label}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main VoiceTracker ────────────────────────────────────────

export default function VoiceTracker({ inputDeviceId }: { inputDeviceId?: string }) {
  const [tracks, setTracks] = useState<VoiceTrack[]>([]);
  const [shows, setShows] = useState<Show[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [djName, setDjName] = useState("DJ");
  const [selectedShow, setSelectedShow] = useState<number | null>(null);
  const [trackTitle, setTrackTitle] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [playProgress, setPlayProgress] = useState<Record<number, number>>({});
  const [slots, setSlots] = useState<ClockSlot[]>(DEFAULT_SLOTS);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [view, setView] = useState<"clock" | "list">("clock");

  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);
  const startTimeRef = useRef(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelRafRef = useRef<number>(0);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const wavePointsRef = useRef<number[]>([]);
  const waveRafRef = useRef<number>(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const load = async () => {
    setTracks(await query<VoiceTrack>("SELECT * FROM voice_tracks ORDER BY recorded_at DESC LIMIT 50"));
    setShows(await query<Show>("SELECT id, name FROM shows ORDER BY start_hour"));
  };
  useEffect(() => { load(); }, []);

  const drawWaveform = useCallback(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.offsetWidth * devicePixelRatio;
    const h = canvas.offsetHeight * devicePixelRatio;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    const pts = wavePointsRef.current;
    if (pts.length === 0) { waveRafRef.current = requestAnimationFrame(drawWaveform); return; }
    const step = w / Math.max(pts.length, 300);
    ctx.beginPath();
    ctx.strokeStyle = "#f87171";
    ctx.lineWidth = 1.5 * devicePixelRatio;
    pts.forEach((v, i) => {
      const x = i * step;
      const barH = v * (h / 2) * 0.8;
      ctx.moveTo(x, h / 2 - barH);
      ctx.lineTo(x, h / 2 + barH);
    });
    ctx.stroke();
    ctx.beginPath();
    ctx.strokeStyle = "rgba(248,113,113,0.15)";
    ctx.lineWidth = devicePixelRatio;
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();
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
    wavePointsRef.current.push(rms * 3);
    if (wavePointsRef.current.length > 800) wavePointsRef.current.shift();
    levelRafRef.current = requestAnimationFrame(pollLevel);
  }, []);

  const startRecording = async () => {
    try {
      const constraints = inputDeviceId ? { audio: { deviceId: { exact: inputDeviceId } } } : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      chunksRef.current = []; wavePointsRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(100);
      mediaRecRef.current = mr;
      startTimeRef.current = Date.now();
      setRecording(true); setRecordTime(0);
      timerRef.current = setInterval(() => setRecordTime(Date.now() - startTimeRef.current), 50);
      levelRafRef.current = requestAnimationFrame(pollLevel);
      waveRafRef.current = requestAnimationFrame(drawWaveform);
    } catch { alert("Could not access microphone. Check Settings → Audio Devices."); }
  };

  const stopRecording = async () => {
    const mr = mediaRecRef.current;
    if (!mr) return;
    return new Promise<void>((resolve) => {
      mr.onstop = async () => {
        clearInterval(timerRef.current);
        cancelAnimationFrame(levelRafRef.current);
        cancelAnimationFrame(waveRafRef.current);
        setRecording(false); setInputLevel(0);
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const durMs = Date.now() - startTimeRef.current;
        const title = trackTitle.trim() || ("Break " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
        const reader = new FileReader();
        reader.onload = async () => {
          await execute("INSERT INTO voice_tracks (title, file_path, show_id, duration_ms, recorded_by) VALUES (?,?,?,?,?)",
            [title, reader.result as string, selectedShow, durMs, djName]);
          setTrackTitle(""); load();
        };
        reader.readAsDataURL(blob);
        mr.stream.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close();
        resolve();
      };
      mr.stop();
    });
  };

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

  const queueTrack = (track: VoiceTrack) => {
    engine.addToQueue([{ filePath: track.file_path, title: "[VT] " + track.title, artist: track.recorded_by || "DJ" }]);
  };

  const deleteTrack = async (id: number) => {
    if (!confirm("Delete this voice track?")) return;
    if (playingId === id) { audioRef.current?.pause(); setPlayingId(null); }
    await execute("DELETE FROM voice_tracks WHERE id = ?", [id]);
    setSlots(prev => prev.map(sl => sl.trackId === id ? { ...sl, trackId: null } : sl));
    load();
  };

  const assignBreak = (slotIdx: number, trackId: number) => {
    setSlots(prev => prev.map((sl, i) => i === slotIdx ? { ...sl, trackId } : sl));
    setSelectedSlot(null);
  };

  const unassignBreak = (slotIdx: number) => {
    setSlots(prev => prev.map((sl, i) => i === slotIdx ? { ...sl, trackId: null } : sl));
  };

  const levelBars = 24;
  const levelActive = Math.round(inputLevel * levelBars * 8);
  const breakSlots = slots.filter(s => s.type === "break");
  const assignedCount = breakSlots.filter(s => s.trackId).length;

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, gap: 16, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Voice Tracking</h1>
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 0" }}>Record DJ breaks and place them in the hour clock</p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setView("clock")} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer", background: view === "clock" ? "var(--accent-blue)" : "var(--bg-secondary)", color: view === "clock" ? "#fff" : "var(--text-tertiary)", border: view === "clock" ? "none" : "1px solid var(--border-primary)" }}>🕐 Clock</button>
          <button onClick={() => setView("list")} style={{ padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer", background: view === "list" ? "var(--accent-blue)" : "var(--bg-secondary)", color: view === "list" ? "#fff" : "var(--text-tertiary)", border: view === "list" ? "none" : "1px solid var(--border-primary)" }}>☰ List</button>
        </div>
      </div>

      {/* Main layout */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>

        {/* Left: Recording studio */}
        <div style={{ width: 380, flexShrink: 0 }}>
          <div style={{
            background: "var(--bg-secondary)",
            border: `2px solid ${recording ? "#f87171" : "var(--border-primary)"}`,
            borderRadius: 16, overflow: "hidden",
            boxShadow: recording ? "0 0 32px rgba(248,113,113,0.15)" : "var(--shadow-md)",
            transition: "border-color 0.3s, box-shadow 0.3s",
          }}>
            {/* Studio header */}
            <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-primary)", background: recording ? "rgba(248,113,113,0.06)" : "var(--bg-tertiary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: recording ? "#f87171" : "var(--text-tertiary)", boxShadow: recording ? "0 0 8px #f87171" : "none", animation: recording ? "onair-pulse 1s infinite" : "none" }} />
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as any, color: recording ? "#f87171" : "var(--text-tertiary)" }}>{recording ? "RECORDING" : "STUDIO"}</span>
              </div>
              {recording && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 18, fontWeight: 500, color: "#f87171" }}>{fmtMsFull(recordTime)}</span>}
            </div>

            <div style={{ padding: 16 }}>
              {/* Session fields */}
              <div style={{ display: "flex", flexDirection: "column" as any, gap: 8, marginBottom: 12 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input placeholder="Your name" value={djName} onChange={e => setDjName(e.target.value)}
                    style={{ width: 120, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
                  <select value={selectedShow || ""} onChange={e => setSelectedShow(e.target.value ? parseInt(e.target.value) : null)}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 8, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
                    <option value="">No show</option>
                    {shows.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <input placeholder="Break title — e.g. Morning opener, After news..." value={trackTitle} onChange={e => setTrackTitle(e.target.value)}
                  style={{ padding: "8px 10px", borderRadius: 8, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
              </div>

              {/* Waveform + level */}
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <div style={{ flex: 1, background: "var(--bg-tertiary)", borderRadius: 8, border: "1px solid var(--border-primary)", height: 72, position: "relative", overflow: "hidden" }}>
                  {!recording && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>Waveform appears here when recording</span>
                  </div>}
                  <canvas ref={waveCanvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
                </div>
                <div style={{ width: 32, background: "var(--bg-tertiary)", borderRadius: 8, border: "1px solid var(--border-primary)", display: "flex", flexDirection: "column" as any, alignItems: "center", justifyContent: "flex-end", padding: "6px 0", gap: 1.5 }}>
                  {Array.from({ length: levelBars }).reverse().map((_, i) => {
                    const idx = levelBars - 1 - i;
                    const active = idx < levelActive;
                    const color = idx > levelBars * 0.85 ? "#f87171" : idx > levelBars * 0.65 ? "#fbbf24" : "#34d399";
                    return <div key={i} style={{ width: 16, height: 2.5, borderRadius: 1, background: active ? color : "var(--border-primary)", transition: "background 0.04s" }} />;
                  })}
                  <div style={{ fontSize: 7, fontWeight: 700, color: "var(--text-tertiary)", marginTop: 3 }}>IN</div>
                </div>
              </div>

              {/* Record button */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {!recording ? (
                  <button onClick={startRecording} style={{ width: 48, height: 48, borderRadius: "50%", background: "#ef4444", border: "3px solid rgba(239,68,68,0.3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 0 16px rgba(239,68,68,0.4)" }}>
                    <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff" }} />
                  </button>
                ) : (
                  <button onClick={stopRecording} style={{ width: 48, height: 48, borderRadius: "50%", background: "#0a0a0a", border: "3px solid #f87171", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <div style={{ width: 14, height: 14, borderRadius: 2, background: "#f87171" }} />
                  </button>
                )}
                <div style={{ fontSize: 12, color: recording ? "#f87171" : "var(--text-tertiary)", lineHeight: 1.5 }}>
                  {recording ? "Click stop when done — saves automatically" : "Click to start recording your break"}
                </div>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap" as any, gap: 6 }}>
            {Object.entries(CAT_COLORS).filter(([k]) => ["A","B","C","D"].includes(k)).map(([k, v]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, background: v + "20", border: "1px solid " + v + "40" }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: v }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: v }}>Category {k}</span>
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#f87171" }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: "#f87171" }}>Break (empty)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.3)" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399" }} />
              <span style={{ fontSize: 10, fontWeight: 700, color: "#34d399" }}>Break (filled ✓)</span>
            </div>
          </div>
        </div>

        {/* Right: Clock or List */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {view === "clock" ? (
            <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 16, padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Hour Programming Clock</div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    Click a red break slot to assign a recorded voice track · {assignedCount}/{breakSlots.length} breaks filled
                  </div>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", textAlign: "right" as any }}>
                  <div>{slots.filter(s => s.type === "song").length} songs</div>
                  <div>{breakSlots.length} breaks</div>
                </div>
              </div>

              {/* Progress bar for filled breaks */}
              <div style={{ height: 4, background: "var(--bg-tertiary)", borderRadius: 2, marginBottom: 20, overflow: "hidden" }}>
                <div style={{ height: "100%", width: (assignedCount / Math.max(breakSlots.length, 1) * 100) + "%", background: "var(--accent-green)", borderRadius: 2, transition: "width 0.4s ease" }} />
              </div>

              <ProgrammingClock
                slots={slots}
                tracks={tracks}
                onAssign={assignBreak}
                onUnassign={unassignBreak}
                selectedSlot={selectedSlot}
                onSelectSlot={setSelectedSlot}
              />
            </div>
          ) : (
            /* List view */
            <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 16, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Recorded Breaks</div>
              </div>
              {tracks.length === 0 ? (
                <div style={{ textAlign: "center" as any, padding: "48px 24px" }}>
                  <div style={{ fontSize: 32, marginBottom: 10 }}>🎙</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No voice tracks yet</div>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Record a break on the left and it'll appear here</div>
                </div>
              ) : tracks.map((t, i) => {
                const isPlaying = playingId === t.id;
                const progress = playProgress[t.id] || 0;
                return (
                  <div key={t.id} style={{ borderBottom: i < tracks.length - 1 ? "1px solid var(--border-primary)" : "none", padding: "12px 20px", background: isPlaying ? "rgba(52,211,153,0.04)" : "transparent" }}
                    onMouseEnter={e => { if (!isPlaying) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={e => { if (!isPlaying) e.currentTarget.style.background = "transparent"; }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button onClick={() => playTrack(t)} style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0, background: isPlaying ? "var(--accent-green)" : "var(--bg-tertiary)", border: "1px solid " + (isPlaying ? "var(--accent-green)" : "var(--border-secondary)"), cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isPlaying ? "#000" : "var(--text-secondary)" }}>
                        {isPlaying ? <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><rect x="0" y="0" width="3" height="10" rx="1"/><rect x="5" y="0" width="3" height="10" rx="1"/></svg> : <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor" style={{ marginLeft: 1 }}><polygon points="0,0 8,5 0,10"/></svg>}
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{t.title}</span>
                          {t.recorded_by && <span style={{ fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0 }}>{t.recorded_by}</span>}
                          <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", flexShrink: 0, marginLeft: "auto" }}>{fmtMs(t.duration_ms)}</span>
                        </div>
                        <div style={{ height: 3, background: "var(--bg-tertiary)", borderRadius: 2, cursor: "pointer", overflow: "hidden" }} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); if (audioRef.current && isPlaying) audioRef.current.currentTime = ((e.clientX - r.left) / r.width) * audioRef.current.duration; }}>
                          <div style={{ height: "100%", width: (progress * 100) + "%", background: "var(--accent-green)", borderRadius: 2 }} />
                        </div>
                        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>{fmtDate(t.recorded_at)}</div>
                      </div>
                      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        <button onClick={() => queueTrack(t)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>+ Queue</button>
                        <button onClick={() => deleteTrack(t.id)} style={{ padding: "5px 8px", borderRadius: 7, fontSize: 10, color: "var(--text-tertiary)", background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
