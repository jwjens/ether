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
  index: number; type: "song" | "break";
  category?: string; label?: string;
  trackId?: number | null; durationMin: number;
}

function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2,"0") + ":" + String(s % 60).padStart(2,"0");
}
function fmtMsFull(ms: number) {
  const s = ms / 1000;
  return String(Math.floor(s / 60)).padStart(2,"0") + ":" + String(Math.floor(s % 60)).padStart(2,"0") + "." + Math.floor((s % 1) * 10);
}
function fmtDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
}

const CAT_COLORS: Record<string, string> = {
  A: "#38bdf8", B: "#34d399", C: "#a78bfa", D: "#fb923c",
};

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

// ── Giant Programming Clock ──────────────────────────────────

function GiantClock({ slots, tracks, onAssign, onUnassign, selectedSlot, onSelectSlot, pulseFrame }: {
  slots: ClockSlot[]; tracks: VoiceTrack[];
  onAssign: (i: number, id: number) => void;
  onUnassign: (i: number) => void;
  selectedSlot: number | null;
  onSelectSlot: (i: number | null) => void;
  pulseFrame: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const SIZE = 500;
  const CX = SIZE / 2; const CY = SIZE / 2;
  const R_OUTER = 210; const R_INNER = 105;
  const totalMin = slots.reduce((s, sl) => s + sl.durationMin, 0);

  const slotAngles = (() => {
    let angle = -Math.PI / 2;
    return slots.map(sl => {
      const sweep = (sl.durationMin / totalMin) * Math.PI * 2;
      const start = angle; angle += sweep;
      return { start, end: angle, mid: start + sweep / 2, sweep };
    });
  })();

  const getSlotFromPoint = (x: number, y: number) => {
    const dx = x - CX; const dy = y - CY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist < R_INNER || dist > R_OUTER + 20) return null;
    let angle = Math.atan2(dy, dx);
    const norm = ((angle + Math.PI/2 + Math.PI*2) % (Math.PI*2));
    let cum = 0;
    for (let i = 0; i < slots.length; i++) {
      cum += (slots[i].durationMin / totalMin) * Math.PI * 2;
      if (norm < cum) return i;
    }
    return null;
  };

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = devicePixelRatio || 1;
    canvas.width = SIZE * dpr; canvas.height = SIZE * dpr;
    canvas.style.width = SIZE + "px"; canvas.style.height = SIZE + "px";
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Outer decorative rings
    [R_OUTER + 18, R_OUTER + 10].forEach((r, ri) => {
      ctx.beginPath();
      ctx.arc(CX, CY, r, 0, Math.PI * 2);
      ctx.strokeStyle = ri === 0 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.06)";
      ctx.lineWidth = ri === 0 ? 1 : 1.5;
      ctx.stroke();
    });

    slots.forEach((sl, i) => {
      const { start, end, mid, sweep } = slotAngles[i];
      const isSelected = selectedSlot === i;
      const isHover = hover === i;
      const hasTrack = sl.type === "break" && sl.trackId;
      const isEmpty = sl.type === "break" && !sl.trackId;

      let baseColor: string;
      if (sl.type === "break") {
        baseColor = hasTrack ? "#34d399" : "#f87171";
      } else {
        baseColor = CAT_COLORS[sl.category || ""] || "#64748b";
      }

      const pulseAlpha = isEmpty ? 0.6 + 0.25 * Math.sin(pulseFrame * 0.07) : 1;
      const gap = 0.022;
      const s = start + gap; const e = end - gap;

      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(s) * R_INNER, CY + Math.sin(s) * R_INNER);
      ctx.arc(CX, CY, R_OUTER, s, e);
      ctx.arc(CX, CY, R_INNER, e, s, true);
      ctx.closePath();

      // Rich gradient fill
      const midX = CX + Math.cos(mid) * ((R_INNER + R_OUTER) / 2);
      const midY = CY + Math.sin(mid) * ((R_INNER + R_OUTER) / 2);
      const grad = ctx.createRadialGradient(midX, midY, 0, CX, CY, R_OUTER);

      if (sl.type === "break") {
        grad.addColorStop(0, baseColor + "cc");
        grad.addColorStop(1, baseColor + (isSelected ? "ff" : isHover ? "cc" : "88"));
        ctx.globalAlpha = pulseAlpha;
      } else {
        grad.addColorStop(0, baseColor + "bb");
        grad.addColorStop(1, baseColor + (isSelected ? "ee" : isHover ? "bb" : "77"));
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (isSelected) {
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = 24;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (isHover) {
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(0,0,0,0.2)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Inner highlight arc
      ctx.beginPath();
      ctx.arc(CX, CY, R_INNER + 4, s + 0.02, e - 0.02);
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Labels
      if (sweep > 0.14) {
        const lx = CX + Math.cos(mid) * ((R_INNER + R_OUTER) / 2);
        const ly = CY + Math.sin(mid) * ((R_INNER + R_OUTER) / 2);
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(mid + Math.PI / 2);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        if (sl.type === "break") {
          ctx.globalAlpha = isEmpty ? pulseAlpha : 1;
          if (hasTrack) {
            ctx.fillStyle = "#fff";
            ctx.font = "bold 11px Inter, sans-serif";
            ctx.fillText("✓ BREAK", 0, sweep > 0.28 ? -7 : 0);
            if (sweep > 0.28) {
              const t = tracks.find(t => t.id === sl.trackId);
              if (t) {
                ctx.font = "9px Inter, sans-serif";
                ctx.fillStyle = "rgba(255,255,255,0.65)";
                const title = t.title.length > 11 ? t.title.substring(0,11)+"…" : t.title;
                ctx.fillText(title, 0, 7);
              }
            }
          } else {
            ctx.fillStyle = "#fff";
            ctx.font = "bold 10px Inter, sans-serif";
            ctx.fillText("BREAK", 0, sweep > 0.25 ? -6 : 0);
            if (sweep > 0.25) {
              ctx.font = "8px Inter, sans-serif";
              ctx.fillStyle = "rgba(255,255,255,0.5)";
              ctx.fillText("tap to fill", 0, 6);
            }
          }
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = "#fff";
          ctx.font = `bold ${sweep > 0.22 ? 15 : 11}px Syne, sans-serif`;
          ctx.fillText(sl.category || "", 0, sweep > 0.18 ? -7 : 0);
          if (sweep > 0.18) {
            ctx.font = "9px Inter, sans-serif";
            ctx.fillStyle = "rgba(255,255,255,0.5)";
            ctx.fillText(sl.durationMin + "m", 0, 7);
          }
        }
        ctx.restore();
      }

      // Tick at start
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(start) * R_OUTER, CY + Math.sin(start) * R_OUTER);
      ctx.lineTo(CX + Math.cos(start) * (R_OUTER + 10), CY + Math.sin(start) * (R_OUTER + 10));
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1; ctx.stroke();
    });

    // Center hole
    const cGrad = ctx.createRadialGradient(CX, CY-10, 0, CX, CY, R_INNER - 4);
    cGrad.addColorStop(0, "#1e1e35");
    cGrad.addColorStop(1, "#0d0d1a");
    ctx.beginPath();
    ctx.arc(CX, CY, R_INNER - 5, 0, Math.PI * 2);
    ctx.fillStyle = cGrad;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1.5; ctx.stroke();

    // Center content
    const breakSlots = slots.filter(s => s.type === "break");
    const filled = breakSlots.filter(s => s.trackId).length;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";

    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "bold 14px Syne, sans-serif";
    ctx.fillText("1 HOUR", CX, CY - 24);

    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "10px Inter, sans-serif";
    ctx.fillText(totalMin.toFixed(0) + " min", CX, CY - 8);

    ctx.font = "bold 26px DM Mono, monospace";
    ctx.fillStyle = filled === breakSlots.length ? "#34d399" : "#f87171";
    if (filled === breakSlots.length) {
      ctx.shadowColor = "#34d399";
      ctx.shadowBlur = 16;
    }
    ctx.fillText(filled + "/" + breakSlots.length, CX, CY + 12);
    ctx.shadowBlur = 0;

    ctx.font = "9px Inter, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillText("breaks filled", CX, CY + 28);

    // 12 o'clock marker
    ctx.beginPath();
    ctx.moveTo(CX, CY - R_OUTER - 2);
    ctx.lineTo(CX, CY - R_OUTER - 18);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.stroke();
    ctx.lineCap = "butt";

  }, [slots, selectedSlot, hover, pulseFrame, tracks]);

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, alignItems: "center", gap: 16 }}>

      {/* Selected slot panel — ABOVE the clock so it's always visible */}
      {selectedSlot !== null && (
        <div style={{ width: "100%", maxWidth: 500, background: "rgba(255,255,255,0.05)", backdropFilter: "blur(20px)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 16, padding: 20 }}>
          {slots[selectedSlot].type === "break" ? (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 12 }}>🎙 Assign a voice break to this slot</div>
              {slots[selectedSlot].trackId ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.3)", borderRadius: 10, padding: "10px 14px" }}>
                  <span style={{ fontSize: 13, color: "#34d399", fontWeight: 600 }}>✓ {tracks.find(t => t.id === slots[selectedSlot].trackId)?.title}</span>
                  <button onClick={() => onUnassign(selectedSlot)} style={{ fontSize: 11, color: "#f87171", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}>Remove</button>
                </div>
              ) : tracks.length === 0 ? (
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", fontStyle: "italic" }}>Record a voice break first, then assign it here</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" as any, gap: 6 }}>
                  {tracks.map(t => (
                    <button key={t.id} onClick={() => onAssign(selectedSlot, t.id)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderRadius: 10, cursor: "pointer", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", textAlign: "left" as any }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(56,189,248,0.15)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{t.recorded_by} · {fmtMs(t.duration_ms)}</div>
                      </div>
                      <span style={{ fontSize: 11, color: "#38bdf8" }}>Assign →</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: CAT_COLORS[slots[selectedSlot].category || ""] }}>{slots[selectedSlot].label}</span>
              {" · "}{slots[selectedSlot].durationMin} min
            </div>
          )}
        </div>
      )}

      <canvas ref={canvasRef}
        style={{ cursor: "pointer", filter: "drop-shadow(0 0 50px rgba(56,189,248,0.12)) drop-shadow(0 20px 40px rgba(0,0,0,0.5))" }}
        onMouseMove={e => { const r = e.currentTarget.getBoundingClientRect(); setHover(getSlotFromPoint(e.clientX-r.left, e.clientY-r.top)); }}
        onMouseLeave={() => setHover(null)}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); const idx = getSlotFromPoint(e.clientX-r.left, e.clientY-r.top); if (idx !== null) onSelectSlot(selectedSlot === idx ? null : idx); }}
      />
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
  const [peakLevel, setPeakLevel] = useState(0);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [playProgress, setPlayProgress] = useState<Record<number, number>>({});
  const [slots, setSlots] = useState<ClockSlot[]>(DEFAULT_SLOTS);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [view, setView] = useState<"clock" | "list">("clock");
  const [pulseFrame, setPulseFrame] = useState(0);

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
  const pulseRafRef = useRef<number>(0);

  const load = async () => {
    setTracks(await query<VoiceTrack>("SELECT * FROM voice_tracks ORDER BY recorded_at DESC LIMIT 50"));
    setShows(await query<Show>("SELECT id, name FROM shows ORDER BY start_hour"));
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    let frame = 0;
    const animate = () => { frame++; setPulseFrame(frame); pulseRafRef.current = requestAnimationFrame(animate); };
    pulseRafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(pulseRafRef.current);
  }, []);

  const drawWaveform = useCallback(() => {
    const canvas = waveCanvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = devicePixelRatio || 1;
    const w = canvas.offsetWidth * dpr; const h = canvas.offsetHeight * dpr;
    if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    const pts = wavePointsRef.current;

    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, h/4*i); ctx.lineTo(w, h/4*i); ctx.stroke(); }

    if (pts.length > 1) {
      const step = w / Math.max(pts.length, 200);
      const gradTop = ctx.createLinearGradient(0, 0, 0, h);
      gradTop.addColorStop(0, "rgba(248,113,113,0.7)");
      gradTop.addColorStop(0.5, "rgba(248,113,113,0.25)");
      gradTop.addColorStop(1, "rgba(248,113,113,0.05)");
      ctx.beginPath();
      ctx.moveTo(0, h/2);
      pts.forEach((v, i) => ctx.lineTo(i*step, h/2 - v*(h/2)*0.85));
      ctx.lineTo(pts.length*step, h/2);
      ctx.fillStyle = gradTop; ctx.fill();

      const gradBot = ctx.createLinearGradient(0, h, 0, 0);
      gradBot.addColorStop(0, "rgba(248,113,113,0.5)");
      gradBot.addColorStop(0.5, "rgba(248,113,113,0.1)");
      gradBot.addColorStop(1, "rgba(248,113,113,0.02)");
      ctx.beginPath();
      ctx.moveTo(0, h/2);
      pts.forEach((v, i) => ctx.lineTo(i*step, h/2 + v*(h/2)*0.85));
      ctx.lineTo(pts.length*step, h/2);
      ctx.fillStyle = gradBot; ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, h/2);
      pts.forEach((v, i) => ctx.lineTo(i*step, h/2 - v*(h/2)*0.85));
      ctx.strokeStyle = "#f87171"; ctx.lineWidth = 2*dpr; ctx.lineJoin = "round";
      ctx.shadowColor = "#f87171"; ctx.shadowBlur = 10*dpr;
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
    for (let i = 0; i < data.length; i++) { const v = (data[i]-128)/128; sum += v*v; }
    const rms = Math.sqrt(sum / data.length);
    setInputLevel(rms);
    setPeakLevel(p => Math.max(p * 0.994, rms));
    wavePointsRef.current.push(rms * 2.5);
    if (wavePointsRef.current.length > 1200) wavePointsRef.current.shift();
    levelRafRef.current = requestAnimationFrame(pollLevel);
  }, []);

  const startRecording = async () => {
    try {
      const constraints = inputDeviceId ? { audio: { deviceId: { exact: inputDeviceId } } } : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const ctx = new AudioContext(); audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
      source.connect(analyser); analyserRef.current = analyser;
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      chunksRef.current = []; wavePointsRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(100); mediaRecRef.current = mr;
      startTimeRef.current = Date.now();
      setRecording(true); setRecordTime(0); setPeakLevel(0);
      timerRef.current = setInterval(() => setRecordTime(Date.now() - startTimeRef.current), 50);
      levelRafRef.current = requestAnimationFrame(pollLevel);
      waveRafRef.current = requestAnimationFrame(drawWaveform);
    } catch { alert("Could not access microphone. Check Settings → Audio Devices."); }
  };

  const stopRecording = async () => {
    const mr = mediaRecRef.current; if (!mr) return;
    return new Promise<void>(resolve => {
      mr.onstop = async () => {
        clearInterval(timerRef.current);
        cancelAnimationFrame(levelRafRef.current);
        cancelAnimationFrame(waveRafRef.current);
        setRecording(false); setInputLevel(0);
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const durMs = Date.now() - startTimeRef.current;
        const title = trackTitle.trim() || ("Break " + new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }));
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
    await execute("DELETE FROM voice_tracks WHERE id = ?", [id]);
    setSlots(prev => prev.map(sl => sl.trackId === id ? { ...sl, trackId: null } : sl));
    load();
  };

  const assignBreak = (slotIdx: number, trackId: number) => { setSlots(prev => prev.map((sl,i) => i === slotIdx ? { ...sl, trackId } : sl)); setSelectedSlot(null); };
  const unassignBreak = (slotIdx: number) => setSlots(prev => prev.map((sl,i) => i === slotIdx ? { ...sl, trackId: null } : sl));

  const VU_BARS = 32;
  const levelActive = Math.min(VU_BARS, Math.round(inputLevel * VU_BARS * 10));
  const peakBar = Math.min(VU_BARS - 1, Math.round(peakLevel * VU_BARS * 10));
  const breakSlots = slots.filter(s => s.type === "break");
  const assignedCount = breakSlots.filter(s => s.trackId).length;

  return (
    <div style={{ display: "flex", gap: 20, fontFamily: "'Inter', system-ui, sans-serif", height: "100%", overflow: "hidden" }}>

      {/* ── LEFT: Dark studio panel ── */}
      <div style={{
        width: 460, flexShrink: 0,
        background: "linear-gradient(160deg, #0f0f1a 0%, #13131f 60%, #0a0a14 100%)",
        borderRadius: 20, border: `1px solid ${recording ? "rgba(248,113,113,0.3)" : "rgba(255,255,255,0.08)"}`,
        boxShadow: recording ? "0 0 60px rgba(248,113,113,0.2), inset 0 0 80px rgba(248,113,113,0.03)" : "0 8px 40px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column" as any, overflow: "hidden",
        transition: "border-color 0.4s, box-shadow 0.4s",
      }}>
        {/* Header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: recording ? "#f87171" : "rgba(255,255,255,0.15)", boxShadow: recording ? "0 0 14px #f87171, 0 0 28px rgba(248,113,113,0.4)" : "none", animation: recording ? "onair-pulse 1s infinite" : "none", transition: "all 0.3s" }} />
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.2em", textTransform: "uppercase" as any, color: recording ? "#f87171" : "rgba(255,255,255,0.25)" }}>
              {recording ? "● RECORDING" : "STUDIO"}
            </span>
          </div>
          {recording && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, fontWeight: 300, color: "#f87171", letterSpacing: "-0.03em" }}>{fmtMsFull(recordTime)}</span>}
        </div>

        {/* Session fields */}
        <div style={{ padding: "14px 20px 10px", display: "flex", flexDirection: "column" as any, gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Your name" value={djName} onChange={e => setDjName(e.target.value)}
              style={{ width: 130, padding: "8px 12px", borderRadius: 9, fontSize: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", outline: "none" }} />
            <select value={selectedShow || ""} onChange={e => setSelectedShow(e.target.value ? parseInt(e.target.value) : null)}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 9, fontSize: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", outline: "none" }}>
              <option value="">No show</option>
              {shows.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <input placeholder="Break title — Morning opener, Artist toss..." value={trackTitle} onChange={e => setTrackTitle(e.target.value)}
            style={{ padding: "8px 12px", borderRadius: 9, fontSize: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", outline: "none" }} />
        </div>

        {/* Waveform */}
        <div style={{ margin: "0 20px", flex: 1, minHeight: 150, background: "rgba(0,0,0,0.5)", borderRadius: 14, border: "1px solid rgba(255,255,255,0.05)", position: "relative" as any, overflow: "hidden" }}>
          {!recording && wavePointsRef.current.length === 0 && (
            <div style={{ position: "absolute" as any, inset: 0, display: "flex", flexDirection: "column" as any, alignItems: "center", justifyContent: "center", gap: 6 }}>
              <div style={{ fontSize: 24, opacity: 0.1 }}>🎙</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.15)", letterSpacing: "0.1em" }}>WAVEFORM</div>
            </div>
          )}
          <canvas ref={waveCanvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
        </div>

        {/* VU Meter */}
        <div style={{ margin: "12px 20px 0", padding: "12px 14px", background: "rgba(0,0,0,0.35)", borderRadius: 12, border: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.2)", letterSpacing: "0.15em", textTransform: "uppercase" as any }}>INPUT LEVEL</span>
            <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.1em", color: !recording ? "rgba(255,255,255,0.15)" : inputLevel > 0.7 ? "#f87171" : inputLevel > 0.35 ? "#fbbf24" : "#34d399" }}>
              {!recording ? "—" : inputLevel > 0.7 ? "HOT" : inputLevel > 0.35 ? "GOOD" : "LOW"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 2.5, alignItems: "flex-end", height: 44 }}>
            {Array.from({ length: VU_BARS }).map((_, i) => {
              const isActive = i < levelActive;
              const isPeak = i === peakBar && recording && peakBar > 0;
              const pct = i / VU_BARS;
              const color = pct > 0.85 ? "#f87171" : pct > 0.65 ? "#fbbf24" : "#34d399";
              const barH = 16 + (i / VU_BARS) * 28;
              return (
                <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column" as any, alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
                  {isPeak && <div style={{ width: "100%", height: 2, borderRadius: 1, background: color, boxShadow: `0 0 6px ${color}` }} />}
                  <div style={{ width: "100%", height: barH, borderRadius: 1.5, background: isActive ? color : "rgba(255,255,255,0.04)", boxShadow: isActive ? `0 0 6px ${color}50` : "none", transition: "background 0.04s" }} />
                </div>
              );
            })}
          </div>
        </div>

        {/* Record button */}
        <div style={{ padding: "14px 20px 16px", display: "flex", alignItems: "center", gap: 14 }}>
          {!recording ? (
            <button onClick={startRecording} style={{ width: 60, height: 60, borderRadius: "50%", flexShrink: 0, background: "radial-gradient(circle at 35% 35%, #ff6b6b, #ef4444)", border: "4px solid rgba(239,68,68,0.25)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 28px rgba(239,68,68,0.45), 0 4px 16px rgba(0,0,0,0.5)" }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "0 2px 6px rgba(0,0,0,0.3)" }} />
            </button>
          ) : (
            <button onClick={stopRecording} style={{ width: 60, height: 60, borderRadius: "50%", flexShrink: 0, background: "#0a0a14", border: "4px solid #f87171", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 28px rgba(248,113,113,0.35)" }}>
              <div style={{ width: 16, height: 16, borderRadius: 3, background: "#f87171" }} />
            </button>
          )}
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: recording ? "#f87171" : "rgba(255,255,255,0.4)" }}>{recording ? "Recording — click to stop" : "Click to record"}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", marginTop: 3 }}>{recording ? "Saves automatically when you stop" : "Mic selected in Settings → Audio Devices"}</div>
          </div>
        </div>

        {/* Track list */}
        {tracks.length > 0 && (
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", overflowY: "auto" as any, maxHeight: 220 }}>
            <div style={{ padding: "8px 20px 4px", fontSize: 8, fontWeight: 700, color: "rgba(255,255,255,0.2)", letterSpacing: "0.15em", textTransform: "uppercase" as any }}>Recorded Breaks ({tracks.length})</div>
            {tracks.map((t, i) => {
              const isPlaying = playingId === t.id;
              const progress = playProgress[t.id] || 0;
              return (
                <div key={t.id} style={{ padding: "8px 20px", borderBottom: i < tracks.length-1 ? "1px solid rgba(255,255,255,0.04)" : "none", display: "flex", alignItems: "center", gap: 10 }}>
                  <button onClick={() => playTrack(t)} style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, background: isPlaying ? "#34d399" : "rgba(255,255,255,0.07)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isPlaying ? "#000" : "#fff" }}>
                    {isPlaying ? <svg width="7" height="9" viewBox="0 0 7 9" fill="currentColor"><rect x="0" y="0" width="2.5" height="9" rx="1"/><rect x="4.5" y="0" width="2.5" height="9" rx="1"/></svg> : <svg width="6" height="8" viewBox="0 0 6 8" fill="currentColor" style={{ marginLeft: 1 }}><polygon points="0,0 6,4 0,8"/></svg>}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{t.title}</div>
                    <div style={{ height: 2, background: "rgba(255,255,255,0.07)", borderRadius: 1, marginTop: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: (progress*100)+"%", background: "#34d399" }} />
                    </div>
                  </div>
                  <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "rgba(255,255,255,0.3)", flexShrink: 0 }}>{fmtMs(t.duration_ms)}</span>
                  <button onClick={() => queueTrack(t)} style={{ padding: "2px 7px", borderRadius: 5, fontSize: 9, fontWeight: 700, background: "rgba(56,189,248,0.12)", color: "#38bdf8", border: "none", cursor: "pointer" }}>Q</button>
                  <button onClick={() => deleteTrack(t.id)} style={{ fontSize: 10, color: "rgba(255,255,255,0.18)", background: "none", border: "none", cursor: "pointer" }}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── RIGHT: Clock or List ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" as any, gap: 14, overflow: "auto" as any }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Voice Tracking</h1>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 0" }}>Record breaks · assign them to the clock · let automation handle playback</p>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setView("clock")} style={{ padding: "7px 16px", borderRadius: 9, fontSize: 11, fontWeight: 700, cursor: "pointer", background: view === "clock" ? "var(--accent-blue)" : "var(--bg-secondary)", color: view === "clock" ? "#fff" : "var(--text-tertiary)", border: view === "clock" ? "none" : "1px solid var(--border-primary)" }}>🕐 Clock</button>
            <button onClick={() => setView("list")} style={{ padding: "7px 16px", borderRadius: 9, fontSize: 11, fontWeight: 700, cursor: "pointer", background: view === "list" ? "var(--accent-blue)" : "var(--bg-secondary)", color: view === "list" ? "#fff" : "var(--text-tertiary)", border: view === "list" ? "none" : "1px solid var(--border-primary)" }}>☰ List</button>
          </div>
        </div>

        {view === "clock" ? (
          <div style={{ background: "linear-gradient(135deg, #0d0d1a 0%, #111127 50%, #0a0a18 100%)", borderRadius: 20, border: "1px solid rgba(255,255,255,0.07)", padding: "28px 24px", display: "flex", flexDirection: "column" as any, alignItems: "center", boxShadow: "0 8px 40px rgba(0,0,0,0.3), inset 0 0 100px rgba(56,189,248,0.02)", flex: 1 }}>
            {/* Progress */}
            <div style={{ width: "100%", maxWidth: 500, marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: "rgba(255,255,255,0.25)", letterSpacing: "0.12em", textTransform: "uppercase" as any }}>Breaks Filled</span>
                <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", fontWeight: 700, color: assignedCount === breakSlots.length ? "#34d399" : "#f87171" }}>{assignedCount} / {breakSlots.length}</span>
              </div>
              <div style={{ height: 5, background: "rgba(255,255,255,0.05)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: (assignedCount / Math.max(breakSlots.length,1) * 100) + "%", background: assignedCount === breakSlots.length ? "#34d399" : "linear-gradient(90deg, #f87171, #fb923c)", borderRadius: 3, transition: "width 0.5s", boxShadow: "0 0 10px rgba(248,113,113,0.4)" }} />
              </div>
            </div>

            {/* Legend */}
            <div style={{ display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap" as any, justifyContent: "center" }}>
              {Object.entries(CAT_COLORS).map(([k,v]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: v }} />
                  <span style={{ fontSize: 9, fontWeight: 600, color: "rgba(255,255,255,0.4)" }}>Cat {k}</span>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: "#f87171" }} />
                <span style={{ fontSize: 9, fontWeight: 600, color: "rgba(255,255,255,0.4)" }}>Empty break</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: "#34d399" }} />
                <span style={{ fontSize: 9, fontWeight: 600, color: "rgba(255,255,255,0.4)" }}>Filled ✓</span>
              </div>
            </div>

            <GiantClock slots={slots} tracks={tracks} onAssign={assignBreak} onUnassign={unassignBreak} selectedSlot={selectedSlot} onSelectSlot={setSelectedSlot} pulseFrame={pulseFrame} />
          </div>
        ) : (
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 16, overflow: "hidden", flex: 1 }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", fontSize: 13, fontWeight: 700, color: "var(--text-secondary)", fontFamily: "'Syne', sans-serif" }}>Recorded Breaks</div>
            {tracks.length === 0 ? (
              <div style={{ textAlign: "center" as any, padding: "48px 24px" }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>🎙</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No voice tracks yet</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Record a break in the studio panel</div>
              </div>
            ) : tracks.map((t, i) => {
              const isPlaying = playingId === t.id;
              const progress = playProgress[t.id] || 0;
              return (
                <div key={t.id} style={{ padding: "12px 20px", borderBottom: i < tracks.length-1 ? "1px solid var(--border-primary)" : "none", display: "flex", alignItems: "center", gap: 10, background: isPlaying ? "rgba(52,211,153,0.04)" : "transparent" }}>
                  <button onClick={() => playTrack(t)} style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0, background: isPlaying ? "var(--accent-green)" : "var(--bg-tertiary)", border: "1px solid " + (isPlaying ? "var(--accent-green)" : "var(--border-secondary)"), cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isPlaying ? "#000" : "var(--text-secondary)" }}>
                    {isPlaying ? <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><rect x="0" y="0" width="3" height="10" rx="1"/><rect x="5" y="0" width="3" height="10" rx="1"/></svg> : <svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor" style={{ marginLeft: 1 }}><polygon points="0,0 8,5 0,10"/></svg>}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{t.title}</span>
                      {t.recorded_by && <span style={{ fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0 }}>{t.recorded_by}</span>}
                      <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", marginLeft: "auto", flexShrink: 0 }}>{fmtMs(t.duration_ms)}</span>
                    </div>
                    <div style={{ height: 3, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden", cursor: "pointer" }}>
                      <div style={{ height: "100%", width: (progress*100)+"%", background: "var(--accent-green)", borderRadius: 2 }} />
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 4 }}>{fmtDate(t.recorded_at)}</div>
                  </div>
                  <button onClick={() => queueTrack(t)} style={{ padding: "5px 10px", borderRadius: 7, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>+ Queue</button>
                  <button onClick={() => deleteTrack(t.id)} style={{ padding: "5px 8px", borderRadius: 7, fontSize: 10, color: "var(--text-tertiary)", background: "transparent", border: "none", cursor: "pointer" }}>✕</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
