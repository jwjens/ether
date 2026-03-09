import { useState, useEffect, useRef, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { queryOne, execute } from "../db/client";

interface Props {
  songId: number;
  filePath: string;
  onSaved: () => void;
}

interface CuePoints {
  cue_in_ms: number;
  cue_out_ms: number;
  intro_end_ms: number;
  outro_start_ms: number;
  duration_ms: number;
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const frac = Math.floor((ms % 1000) / 100);
  return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0") + "." + frac;
}

export default function CueEditor({ songId, filePath, onSaved }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [duration, setDuration] = useState(0);
  const [cueIn, setCueIn] = useState(0);
  const [cueOut, setCueOut] = useState(0);
  const [introEnd, setIntroEnd] = useState(0);
  const [outroStart, setOutroStart] = useState(0);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playPos, setPlayPos] = useState(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const bufRef = useRef<AudioBuffer | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimeRef = useRef(0);
  const startOffsetRef = useRef(0);
  const timerRef = useRef<any>(null);

  // Load audio and extract peaks
  useEffect(() => {
    (async () => {
      try {
        const url = convertFileSrc(filePath);
        const resp = await fetch(url);
        const ab = await resp.arrayBuffer();
        const actx = new AudioContext({ sampleRate: 44100 });
        ctxRef.current = actx;
        const buf = await actx.decodeAudioData(ab);
        bufRef.current = buf;
        const durMs = Math.floor(buf.duration * 1000);
        setDuration(durMs);

        // Extract peaks
        const chan = buf.getChannelData(0);
        const numPeaks = 500;
        const step = Math.floor(chan.length / numPeaks);
        const p: number[] = [];
        for (let i = 0; i < numPeaks; i++) {
          let max = 0;
          const start = i * step;
          const end = Math.min(start + step, chan.length);
          for (let j = start; j < end; j++) {
            const abs = Math.abs(chan[j]);
            if (abs > max) max = abs;
          }
          p.push(max);
        }
        setPeaks(p);

        // Load saved cue points
        const row = await queryOne<CuePoints>("SELECT cue_in_ms, cue_out_ms, intro_end_ms, outro_start_ms, duration_ms FROM songs WHERE id = ?", [songId]);
        if (row) {
          setCueIn(row.cue_in_ms || 0);
          setCueOut(row.cue_out_ms || durMs);
          setIntroEnd(row.intro_end_ms || 0);
          setOutroStart(row.outro_start_ms || durMs);
        } else {
          setCueOut(durMs);
          setOutroStart(durMs);
        }

        // Auto-detect silence at start and end
        const threshold = 0.02;
        let autoIn = 0;
        for (let i = 0; i < chan.length; i++) {
          if (Math.abs(chan[i]) > threshold) {
            autoIn = Math.floor((i / chan.length) * durMs);
            break;
          }
        }
        let autoOut = durMs;
        for (let i = chan.length - 1; i >= 0; i--) {
          if (Math.abs(chan[i]) > threshold) {
            autoOut = Math.floor((i / chan.length) * durMs);
            break;
          }
        }
        if ((!row || !row.cue_in_ms) && autoIn > 50) setCueIn(autoIn);
        if ((!row || !row.cue_out_ms || row.cue_out_ms === durMs) && autoOut < durMs - 50) setCueOut(autoOut);

        setLoading(false);
      } catch (e) {
        console.error("CueEditor load error:", e);
        setLoading(false);
      }
    })();
    return () => { stopPreview(); ctxRef.current?.close(); };
  }, [songId, filePath]);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0 || duration === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    const barW = w / peaks.length;

    ctx.clearRect(0, 0, w, h);

    // Draw regions
    const inX = (cueIn / duration) * w;
    const outX = (cueOut / duration) * w;
    const introX = (introEnd / duration) * w;
    const outroX = (outroStart / duration) * w;

    // Trimmed regions (dark)
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, inX, h);
    ctx.fillRect(outX, 0, w - outX, h);

    // Intro region
    if (introX > inX) {
      ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
      ctx.fillRect(inX, 0, introX - inX, h);
    }

    // Outro region
    if (outroX < outX) {
      ctx.fillStyle = "rgba(239, 68, 68, 0.15)";
      ctx.fillRect(outroX, 0, outX - outroX, h);
    }

    // Draw peaks
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW;
      const barH = peaks[i] * mid * 0.85;
      const posMs = (i / peaks.length) * duration;
      if (posMs < cueIn || posMs > cueOut) {
        ctx.fillStyle = "#27272a";
      } else if (posMs < introEnd) {
        ctx.fillStyle = "#3b82f6";
      } else if (posMs > outroStart) {
        ctx.fillStyle = "#ef4444";
      } else {
        ctx.fillStyle = "#22c55e";
      }
      ctx.fillRect(x, mid - barH, Math.max(1, barW - 0.5), barH * 2);
    }

    // Draw markers
    const drawMarker = (xPos: number, color: string, label: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xPos, 0);
      ctx.lineTo(xPos, h);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = "bold 10px sans-serif";
      ctx.fillText(label, xPos + 3, 12);
    };

    drawMarker(inX, "#3b82f6", "IN");
    drawMarker(outX, "#ef4444", "OUT");
    if (introEnd > 0 && introEnd > cueIn) drawMarker(introX, "#60a5fa", "INTRO");
    if (outroStart > 0 && outroStart < cueOut) drawMarker(outroX, "#f87171", "OUTRO");

    // Playhead
    if (playPos > 0) {
      const px = (playPos / duration) * w;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }, [peaks, duration, cueIn, cueOut, introEnd, outroStart, playPos]);

  // Click on waveform to set position
  const handleWaveClick = (e: React.MouseEvent<HTMLCanvasElement>, marker: "cueIn" | "cueOut" | "introEnd" | "outroStart" | "preview") => {
    const canvas = canvasRef.current;
    if (!canvas || duration === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ms = Math.floor((x / rect.width) * duration);
    if (marker === "cueIn") setCueIn(Math.max(0, ms));
    else if (marker === "cueOut") setCueOut(Math.min(duration, ms));
    else if (marker === "introEnd") setIntroEnd(ms);
    else if (marker === "outroStart") setOutroStart(ms);
    else if (marker === "preview") previewFrom(ms);
  };

  const [clickMode, setClickMode] = useState<"cueIn" | "cueOut" | "introEnd" | "outroStart" | "preview">("preview");

  // Preview playback
  const previewFrom = (ms: number) => {
    stopPreview();
    const actx = ctxRef.current;
    const buf = bufRef.current;
    if (!actx || !buf) return;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(actx.destination);
    src.start(0, ms / 1000);
    srcRef.current = src;
    startTimeRef.current = actx.currentTime;
    startOffsetRef.current = ms;
    setPlaying(true);
    timerRef.current = setInterval(() => {
      const pos = startOffsetRef.current + (actx.currentTime - startTimeRef.current) * 1000;
      setPlayPos(pos);
    }, 50);
    src.onended = () => stopPreview();
  };

  const stopPreview = () => {
    try { srcRef.current?.stop(); } catch {}
    srcRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    setPlaying(false);
    setPlayPos(0);
  };

  const save = async () => {
    await execute(
      "UPDATE songs SET cue_in_ms=?, cue_out_ms=?, intro_end_ms=?, outro_start_ms=?, duration_ms=?, updated_at=unixepoch() WHERE id=?",
      [cueIn, cueOut, introEnd, outroStart, duration, songId]
    );
    onSaved();
  };

  if (loading) return <div className="text-xs text-zinc-500 py-4 text-center">Loading waveform...</div>;

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-zinc-500 uppercase font-bold">Waveform / Cue Points</div>

      <canvas
        ref={canvasRef}
        width={800}
        height={100}
        style={{ width: "100%", height: "100px", borderRadius: "6px", background: "#18181b", cursor: "crosshair" }}
        onClick={e => handleWaveClick(e, clickMode)}
      />

      <div className="flex gap-1">
        {(["preview", "cueIn", "cueOut", "introEnd", "outroStart"] as const).map(m => (
          <button key={m} onClick={() => setClickMode(m)}
            className={clickMode === m
              ? "px-2 py-1 rounded text-[10px] font-bold text-white " + (m === "cueIn" ? "bg-blue-600" : m === "cueOut" ? "bg-red-600" : m === "introEnd" ? "bg-blue-400" : m === "outroStart" ? "bg-red-400" : "bg-zinc-600")
              : "px-2 py-1 rounded text-[10px] font-bold bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }>{m === "preview" ? "Preview" : m === "cueIn" ? "Set IN" : m === "cueOut" ? "Set OUT" : m === "introEnd" ? "Set Intro" : "Set Outro"}</button>
        ))}
        {playing && <button onClick={stopPreview} className="px-2 py-1 rounded text-[10px] font-bold bg-yellow-600 text-white">Stop</button>}
      </div>

      <div className="grid grid-cols-4 gap-2 text-[10px]">
        <div className="bg-zinc-800 rounded p-1.5">
          <span className="text-blue-400 font-bold">CUE IN</span>
          <div className="text-zinc-200 font-mono">{fmtMs(cueIn)}</div>
        </div>
        <div className="bg-zinc-800 rounded p-1.5">
          <span className="text-blue-300 font-bold">INTRO END</span>
          <div className="text-zinc-200 font-mono">{fmtMs(introEnd)}</div>
        </div>
        <div className="bg-zinc-800 rounded p-1.5">
          <span className="text-red-300 font-bold">OUTRO START</span>
          <div className="text-zinc-200 font-mono">{fmtMs(outroStart)}</div>
        </div>
        <div className="bg-zinc-800 rounded p-1.5">
          <span className="text-red-400 font-bold">CUE OUT</span>
          <div className="text-zinc-200 font-mono">{fmtMs(cueOut)}</div>
        </div>
      </div>

      <div className="text-[9px] text-zinc-600">
        <span className="text-blue-400">Blue</span> = intro region | <span className="text-emerald-400">Green</span> = body | <span className="text-red-400">Red</span> = outro region | Dark = trimmed
      </div>

      <button onClick={save} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">Save Cue Points</button>
    </div>
  );
}