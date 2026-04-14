/**
 * PhoneDesk.tsx
 *
 * Live phone call intake panel for Ether.
 * - Supports audio interface (WASAPI/ASIO) OR WebRTC/SIP softphone input
 * - Records full call to an in-memory WAV buffer
 * - Live level meter while recording
 * - Waveform review + chop (set in/out) after call ends
 * - Send chopped clip to Deck A, Deck B, Deck C, or a Phone cart slot
 *
 * Wiring needed in App.tsx:
 *   1. Add "phonedesk" to the Panel union type
 *   2. Add {panel === "phonedesk" && <PhoneDesk engine={engine} />} to the panel render block
 *   3. Add a Tools menu Item: <Item label="Phone Desk" onClick={() => set("phonedesk")} />
 *
 * Tauri commands used (already exist in engine-rodio / audio_engine.rs):
 *   - get_audio_devices  → lists WASAPI/ASIO input devices
 *   - audio_load         → loads a temp WAV file to a deck
 *   - audio_play         → plays a deck
 *
 * New Tauri command needed (add to audio_engine.rs):
 *   - save_wav_clip { pcm: Vec<f32>, sample_rate: u32, path: String } -> String (saved path)
 *     Encodes the raw float PCM to a WAV file at a temp path and returns the path.
 */

import { useState, useEffect, useRef, useCallback } from "react";
const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
import { engine, DeckId } from "../audio/engine-rodio";

// ─── Types ────────────────────────────────────────────────────

type InputMode = "device" | "webrtc";
type RecordState = "idle" | "armed" | "recording" | "stopped";
type SendTarget = DeckId | "cart";

interface AudioDevice {
  id: string;
  name: string;
  is_default: boolean;
}

interface Props {
  onClose?: () => void;
}

// ─── Constants ────────────────────────────────────────────────

const SAMPLE_RATE = 48000;
const METER_DECAY = 0.92;   // level meter ballistics
const WAVEFORM_W  = 2400;   // peak samples stored for waveform display

// ─── Utility ─────────────────────────────────────────────────

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00.0";
  const m  = Math.floor(sec / 60);
  const s  = Math.floor(sec % 60);
  const t  = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, "0")}.${t}`;
}

function dbFromLinear(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}

// Encode Float32Array PCM to WAV ArrayBuffer (client-side, for playback preview)
function encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numCh    = 1;
  const bitsPS   = 16;
  const byteRate = sampleRate * numCh * bitsPS / 8;
  const blockAl  = numCh * bitsPS / 8;
  const dataLen  = samples.length * 2;
  const buf      = new ArrayBuffer(44 + dataLen);
  const view     = new DataView(buf);

  const writeStr = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0,  "RIFF");
  view.setUint32(4,  36 + dataLen, true);
  writeStr(8,  "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1,          true);
  view.setUint16(22, numCh,      true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate,   true);
  view.setUint16(32, blockAl,    true);
  view.setUint16(34, bitsPS,     true);
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buf;
}

// ─── Level Meter ──────────────────────────────────────────────

function LevelMeter({ level, peak }: { level: number; peak: number }) {
  const db      = dbFromLinear(level);
  const peakDb  = dbFromLinear(peak);
  const pct     = (v: number) => Math.max(0, Math.min(100, ((v + 60) / 60) * 100));
  const color   = db > -6 ? "#ef4444" : db > -18 ? "#fb923c" : "#008878";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, width: "100%" }}>
      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)" }}>LEVEL</div>
      <div style={{ position: "relative", height: 10, borderRadius: 0, background: "var(--bg-tertiary)", overflow: "hidden", border: "1px solid var(--border-primary)" }}>
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          width: pct(db) + "%",
          background: `linear-gradient(90deg, #008878, ${color})`,
          borderRadius: 0,
          transition: "width 0.05s linear",
        }} />
        {/* Peak hold tick */}
        <div style={{
          position: "absolute", top: 0, bottom: 0, width: 2,
          left: pct(peakDb) + "%",
          background: peakDb > -3 ? "#ef4444" : "#fff",
          opacity: 0.8,
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 8, fontFamily: "'DM Mono', monospace", color: db > -6 ? "#ef4444" : "var(--text-tertiary)" }}>
          {isFinite(db) ? db.toFixed(1) + " dB" : "—"}
        </span>
        <span style={{ fontSize: 8, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)" }}>
          PK {isFinite(peakDb) ? peakDb.toFixed(1) : "—"} dB
        </span>
      </div>
    </div>
  );
}

// ─── Waveform Canvas ─────────────────────────────────────────

function WaveformView({
  peaks, duration, cueIn, cueOut,
  playhead, onSeek,
}: {
  peaks: Float32Array | null;
  duration: number;
  cueIn: number;
  cueOut: number;
  playhead: number;
  onSeek: (sec: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const mid = H / 2;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, W, H);

    if (!peaks || peaks.length === 0 || duration === 0) {
      ctx.fillStyle = "#27272a";
      ctx.font = "11px 'DM Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("No recording yet", W / 2, mid + 4);
      return;
    }

    const inX  = (cueIn  / duration) * W;
    const outX = (cueOut / duration) * W;

    // Muted zone left of cueIn
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, inX, H);

    // Muted zone right of cueOut
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(outX, 0, W - outX, H);

    // Waveform bars
    const barW = Math.max(1, W / peaks.length);
    for (let i = 0; i < peaks.length; i++) {
      const x     = i * barW;
      const barH  = peaks[i] * mid * 0.88;
      const inReg = x >= inX && x <= outX;
      ctx.fillStyle = inReg ? "#008878" : "#27272a";
      ctx.fillRect(x, mid - barH, Math.max(1, barW - 0.5), barH * 2);
    }

    // Cue In handle
    ctx.strokeStyle = "#008878";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(inX, 0); ctx.lineTo(inX, H); ctx.stroke();
    ctx.fillStyle = "#008878";
    ctx.fillRect(inX, 0, 28, 14);
    ctx.fillStyle = "#000";
    ctx.font = "bold 8px 'DM Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText("IN", inX + 4, 10);

    // Cue Out handle
    ctx.strokeStyle = "#f87171";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(outX, 0); ctx.lineTo(outX, H); ctx.stroke();
    ctx.fillStyle = "#f87171";
    ctx.fillRect(outX - 32, 0, 32, 14);
    ctx.fillStyle = "#000";
    ctx.textAlign = "right";
    ctx.fillText("OUT", outX - 4, 10);

    // Playhead
    if (playhead > 0 && playhead < duration) {
      const phX = (playhead / duration) * W;
      ctx.strokeStyle = "#c07820";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Time ruler
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(0, H - 16, W, 16);
    ctx.fillStyle = "#3f3f46";
    ctx.font = "9px 'DM Mono', monospace";
    ctx.textAlign = "center";
    const step = duration < 30 ? 5 : duration < 120 ? 10 : 30;
    for (let t = 0; t <= duration; t += step) {
      const tx = (t / duration) * W;
      ctx.fillStyle = "#3f3f46";
      ctx.fillRect(tx, H - 16, 1, 4);
      ctx.fillStyle = "#52525b";
      ctx.fillText(fmtTime(t), tx, H - 4);
    }
  }, [peaks, duration, cueIn, cueOut, playhead]);

  useEffect(() => { draw(); }, [draw]);

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      draw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(ratio * duration);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      style={{
        width: "100%", height: "100%",
        cursor: "crosshair",
        display: "block",
      }}
    />
  );
}

// ─── Main Component ───────────────────────────────────────────

export default function PhoneDesk({ onClose }: Props) {
  // Input mode
  const [inputMode, setInputMode]   = useState<InputMode>("device");
  const [devices, setDevices]       = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [webrtcUrl, setWebrtcUrl]   = useState("");

  // Record state
  const [recState, setRecState]     = useState<RecordState>("idle");
  const recStateRef                 = useRef<RecordState>("idle");
  const [recDuration, setRecDuration] = useState(0);
  const recDurRef                   = useRef(0);

  // Audio capture
  const audioCtxRef                 = useRef<AudioContext | null>(null);
  const streamRef                   = useRef<MediaStream | null>(null);
  const processorRef                = useRef<ScriptProcessorNode | null>(null);
  const pcmBufferRef                = useRef<Float32Array[]>([]);
  const totalSamplesRef             = useRef(0);

  // Level meter
  const [level, setLevel]           = useState(0);
  const [peak, setPeak]             = useState(0);
  const levelRef                    = useRef(0);
  const peakRef                     = useRef(0);
  const peakHoldTimer               = useRef<any>(null);

  // Live waveform (rolling buffer during record)
  const liveWaveRef                 = useRef<number[]>([]);

  // Recorded clip
  const [recPCM, setRecPCM]         = useState<Float32Array | null>(null);
  const [waveformPeaks, setWaveformPeaks] = useState<Float32Array | null>(null);
  const [clipDuration, setClipDuration]   = useState(0);

  // Cue editor
  const [cueIn, setCueIn]           = useState(0);
  const [cueOut, setCueOut]         = useState(0);
  const cueInRef                    = useRef(0);
  const cueOutRef                   = useRef(0);
  useEffect(() => { cueInRef.current  = cueIn;  }, [cueIn]);
  useEffect(() => { cueOutRef.current = cueOut; }, [cueOut]);

  // Playback preview
  const [previewing, setPreviewing] = useState(false);
  const [playhead, setPlayhead]     = useState(0);
  const previewCtxRef               = useRef<AudioContext | null>(null);
  const previewSrcRef               = useRef<AudioBufferSourceNode | null>(null);
  const previewStartRef             = useRef(0);
  const previewOffsetRef            = useRef(0);
  const previewRafRef               = useRef(0);

  // Send
  const [sendTarget, setSendTarget] = useState<SendTarget>("A");
  const [sending, setSending]       = useState(false);
  const [sent, setSent]             = useState(false);
  const [sendError, setSendError]   = useState("");

  // Timer display
  const timerRef                    = useRef<any>(null);

  // ── Load devices on mount ──
  useEffect(() => {
    invoke<AudioDevice[]>("get_audio_devices")
      .then(devs => {
        const inputs = devs.filter((d: any) => d.is_input !== false);
        setDevices(inputs);
        const def = inputs.find(d => d.is_default) || inputs[0];
        if (def) setSelectedDevice(def.id);
      })
      .catch(() => {
        // Fallback: use Web Audio device enumeration
        navigator.mediaDevices.enumerateDevices().then(devs => {
          const inputs = devs.filter(d => d.kind === "audioinput");
          setDevices(inputs.map(d => ({ id: d.deviceId, name: d.label || d.deviceId.slice(0, 16), is_default: d.deviceId === "default" })));
          if (inputs.length > 0) setSelectedDevice(inputs[0].deviceId);
        }).catch(() => {});
      });
  }, []);

  // ── Level meter RAF ──
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      levelRef.current *= METER_DECAY;
      setLevel(levelRef.current);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ── Recording timer ──
  useEffect(() => {
    if (recState === "recording") {
      timerRef.current = setInterval(() => {
        recDurRef.current += 0.1;
        setRecDuration(recDurRef.current);
      }, 100);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [recState]);

  // ── Start capture ──
  const startCapture = useCallback(async () => {
    try {
      // Close any existing context
      await audioCtxRef.current?.close().catch(() => {});

      let stream: MediaStream;
      if (inputMode === "webrtc") {
        // WebRTC — browser handles the SIP/softphone audio
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      } else {
        // WASAPI/ASIO device — constrain to selected device
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: selectedDevice ? { exact: selectedDevice } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: SAMPLE_RATE,
          }
        });
      }

      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);

      // ScriptProcessor for metering + capture
      // bufferSize 4096 gives ~85ms chunks at 48kHz — low enough latency for metering
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = proc;

      proc.onaudioprocess = (e) => {
        if (recStateRef.current !== "recording") return;
        const ch   = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(ch);

        // Store PCM
        pcmBufferRef.current.push(copy);
        totalSamplesRef.current += copy.length;

        // Level metering
        let max = 0;
        for (let i = 0; i < copy.length; i++) {
          const v = Math.abs(copy[i]);
          if (v > max) max = v;
        }
        if (max > levelRef.current) levelRef.current = max;
        if (max > peakRef.current) {
          peakRef.current = max;
          setPeak(max);
          clearTimeout(peakHoldTimer.current);
          peakHoldTimer.current = setTimeout(() => { peakRef.current = 0; setPeak(0); }, 2000);
        }

        // Live waveform — downsample to one peak per 1024 samples
        let wMax = 0;
        for (let i = 0; i < copy.length; i++) { const v = Math.abs(copy[i]); if (v > wMax) wMax = v; }
        liveWaveRef.current.push(wMax);
        if (liveWaveRef.current.length > WAVEFORM_W) liveWaveRef.current.shift();
      };

      source.connect(proc);
      proc.connect(ctx.destination); // must connect to dest for onaudioprocess to fire (Chrome quirk)

      pcmBufferRef.current  = [];
      totalSamplesRef.current = 0;
      liveWaveRef.current   = [];
      recDurRef.current     = 0;
      setRecDuration(0);

      recStateRef.current = "recording";
      setRecState("recording");
    } catch (e: any) {
      console.error("[PhoneDesk] capture failed:", e);
      setRecState("idle");
    }
  }, [inputMode, selectedDevice]);

  // ── Stop capture ──
  const stopCapture = useCallback(() => {
    recStateRef.current = "stopped";
    setRecState("stopped");

    // Kill stream tracks
    streamRef.current?.getTracks().forEach(t => t.stop());

    // Disconnect processor
    processorRef.current?.disconnect();

    // Flatten PCM buffers
    const chunks = pcmBufferRef.current;
    const total  = chunks.reduce((s, c) => s + c.length, 0);
    const flat   = new Float32Array(total);
    let off = 0;
    for (const chunk of chunks) { flat.set(chunk, off); off += chunk.length; }

    const dur = total / SAMPLE_RATE;
    setRecPCM(flat);
    setClipDuration(dur);
    setCueIn(0);
    setCueOut(dur);
    cueInRef.current  = 0;
    cueOutRef.current = dur;
    setPlayhead(0);

    // Build waveform peaks (3000 bars)
    const bars      = Math.min(3000, Math.max(100, Math.floor(total / 64)));
    const blockSize = Math.floor(total / bars);
    const peaks     = new Float32Array(bars);
    let gMax = 0;
    for (let i = 0; i < bars; i++) {
      let mx = 0;
      const start = i * blockSize;
      for (let j = 0; j < blockSize; j++) { const v = Math.abs(flat[start + j] || 0); if (v > mx) mx = v; }
      peaks[i] = mx;
      if (mx > gMax) gMax = mx;
    }
    if (gMax > 0) for (let i = 0; i < bars; i++) peaks[i] /= gMax;
    setWaveformPeaks(peaks);
  }, []);

  // ── Arm / Record / Stop button ──
  const handleRecButton = useCallback(() => {
    if (recState === "idle" || recState === "stopped") {
      setRecState("armed");
      recStateRef.current = "armed";
      // Small delay so user can prepare, then auto-start
      setTimeout(() => startCapture(), 500);
    } else if (recState === "armed" || recState === "recording") {
      stopCapture();
    }
  }, [recState, startCapture, stopCapture]);

  // ── Preview playback ──
  const startPreview = useCallback(async (fromSec?: number) => {
    if (!recPCM) return;
    previewSrcRef.current?.stop();
    await previewCtxRef.current?.close().catch(() => {});

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    previewCtxRef.current = ctx;

    const buf = ctx.createBuffer(1, recPCM.length, SAMPLE_RATE);
    buf.copyToChannel(recPCM, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const start  = Math.max(cueInRef.current, fromSec ?? cueInRef.current);
    const end    = cueOutRef.current;
    const offset = start;
    const dur    = end - start;

    src.start(0, offset, dur);
    src.onended = () => { setPreviewing(false); cancelAnimationFrame(previewRafRef.current); };
    previewSrcRef.current  = src;
    previewStartRef.current  = ctx.currentTime;
    previewOffsetRef.current = offset;
    setPreviewing(true);
    setPlayhead(start);

    const tick = () => {
      const pos = previewOffsetRef.current + (previewCtxRef.current!.currentTime - previewStartRef.current);
      setPlayhead(Math.min(pos, cueOutRef.current));
      if (pos < cueOutRef.current) previewRafRef.current = requestAnimationFrame(tick);
    };
    previewRafRef.current = requestAnimationFrame(tick);
  }, [recPCM]);

  const stopPreview = useCallback(() => {
    previewSrcRef.current?.stop();
    setPreviewing(false);
    cancelAnimationFrame(previewRafRef.current);
  }, []);

  // ── Send clip to deck / cart ──
  const sendClip = useCallback(async () => {
    if (!recPCM || sending) return;
    setSending(true);
    setSendError("");

    try {
      // Slice the chopped region
      const inSample  = Math.floor(cueInRef.current  * SAMPLE_RATE);
      const outSample = Math.floor(cueOutRef.current * SAMPLE_RATE);
      const sliced    = recPCM.slice(inSample, outSample);

      // Encode to WAV and save via Tauri command
      // Falls back to a Blob object URL for immediate Web Audio playback if command fails
      let filePath = "";
      try {
        filePath = await invoke<string>("save_wav_clip", {
          pcm:        Array.from(sliced),
          sampleRate: SAMPLE_RATE,
          path:       `phone_clip_${Date.now()}.wav`,
        });
      } catch {
        // Fallback: encode in-browser and use a blob URL
        const wavBuf   = encodeWAV(sliced, SAMPLE_RATE);
        const blob     = new Blob([wavBuf], { type: "audio/wav" });
        filePath       = URL.createObjectURL(blob);
      }

      const title  = `Phone Clip ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const artist = "Phone";

      if (sendTarget === "cart") {
        // Dispatch a custom event — CartWall listens for this to add a hot button
        window.dispatchEvent(new CustomEvent("ether:phone-clip", { detail: { filePath, title } }));
      } else {
        await engine.loadToDeck(sendTarget as DeckId, filePath, title, artist);
      }

      setSent(true);
      setTimeout(() => setSent(false), 3000);
    } catch (e: any) {
      setSendError(String(e));
    } finally {
      setSending(false);
    }
  }, [recPCM, sendTarget, sending]);

  // ── Save recording to disk ──
  const [saving, setSaving]     = useState(false);
  const [savedPath, setSavedPath] = useState("");

  const saveRecording = useCallback(async () => {
    if (!recPCM || saving) return;
    setSaving(true);
    try {
      const now   = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}-${String(now.getMinutes()).padStart(2,"0")}-${String(now.getSeconds()).padStart(2,"0")}`;
      const fileName = `phone-recording-${stamp}.wav`;

      const wavBuf = encodeWAV(recPCM, SAMPLE_RATE);
      const bytes  = new Uint8Array(wavBuf);

      // Try Electron fs.writeFile first, fall back to browser download
      try {
        const appDir = await (window as any).ether.system.getAppDataDir();
        const dir    = appDir + "/phone-recordings";
        await (window as any).ether.fs.mkdir(dir).catch(() => {});
        const filePath = dir + "/" + fileName;
        await (window as any).ether.fs.writeFile(filePath, Array.from(bytes));
        setSavedPath(filePath);
      } catch {
        // Browser download fallback
        const blob = new Blob([wavBuf], { type: "audio/wav" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url; a.download = fileName; a.click();
        URL.revokeObjectURL(url);
        setSavedPath(fileName);
      }
      setTimeout(() => setSavedPath(""), 4000);
    } finally {
      setSaving(false);
    }
  }, [recPCM, saving]);

  // ── Clip keyboard shortcuts ──
  // Left arrow → snap to beginning, Space → play/stop, Right arrow → snap to end
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only fire when phone desk is focused / active — skip if user is typing in an input
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      const clipReady = recPCM !== null && recState === "stopped";
      if (!clipReady) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (previewing) stopPreview(); else startPreview();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        setPlayhead(cueInRef.current);
        if (previewing) { stopPreview(); startPreview(cueInRef.current); }
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        setPlayhead(cueOutRef.current);
        stopPreview();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recPCM, recState, previewing, startPreview, stopPreview]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      audioCtxRef.current?.close().catch(() => {});
      previewCtxRef.current?.close().catch(() => {});
      cancelAnimationFrame(previewRafRef.current);
      clearInterval(timerRef.current);
    };
  }, []);

  // ─── Derived ────────────────────────────────────────────────

  const hasClip     = recPCM !== null && recState === "stopped";
  const clipLen     = cueOut - cueIn;
  const isRecording = recState === "recording";
  const isArmed     = recState === "armed";

  // ─── Pop-out ─────────────────────────────────────────────────

  const openGuestEditorWindow = async () => {
    await (window as any).ether.invoke("window:guesteditor");
  };

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      background: "var(--bg-primary)",
      fontFamily: "'IBM Plex Mono', 'DM Mono', monospace",
      color: "var(--text-primary)",
      userSelect: "none",
    }}>

      {/* ── Header ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 14,
        padding: "12px 20px",
        background: "var(--bg-secondary)",
        borderBottom: "1px solid var(--border-primary)",
        flexShrink: 0,
      }}>
        {/* Indicator dot */}
        <div style={{
          width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
          background: isRecording ? "#ef4444" : isArmed ? "#fb923c" : hasClip ? "#008878" : "#3f3f46",
          boxShadow: isRecording ? "0 0 12px #ef444488" : isArmed ? "0 0 10px #fb923c88" : "none",
          animation: isRecording ? "phone-blink 1s ease-in-out infinite" : "none",
        }} />
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.18em", color: isRecording ? "#ef4444" : "var(--text-tertiary)", textTransform: "uppercase" }}>
            {isRecording ? "● RECORDING" : isArmed ? "ARMED" : hasClip ? "CLIP READY" : "Phone Desk"}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--text-primary)", marginTop: 1, fontFamily: "'Syne', sans-serif" }}>
            Call Intake &amp; Chop
          </div>
        </div>

        {/* Recording timer */}
        <div style={{
          marginLeft: 20,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 28, fontWeight: 300,
          letterSpacing: "-0.03em",
          color: isRecording ? "#ef4444" : "var(--text-secondary)",
          transition: "color 0.3s",
        }}>
          {fmtTime(recDuration)}
        </div>

        <div style={{ flex: 1 }} />

        {/* Level meter — compact in header */}
        <div style={{ width: 200, flexShrink: 0 }}>
          <LevelMeter level={level} peak={peak} />
        </div>

        {/* Pop-out button */}
        <button
          title="Pop out to separate window"
          onClick={openGuestEditorWindow}
          style={{ background: "none", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", padding: "0 10px", height: 26, display: "flex", alignItems: "center", gap: 5, transition: "all 0.12s", borderRadius: 0, flexShrink: 0, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", fontFamily: "'DM Mono', monospace" }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = "#6080c0"; (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(96,128,192,0.4)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = "var(--text-tertiary)"; (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-primary)"; }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Pop Out
        </button>

        {onClose && (
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 0, border: "1px solid var(--border-primary)",
            background: "transparent", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 13,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.1)"; (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
          >✕</button>
        )}
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>

        {/* ── LEFT: Input config + record controls ── */}
        <div style={{
          width: 280, flexShrink: 0,
          borderRight: "1px solid var(--border-primary)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-secondary)",
        }}>

          {/* Input mode toggle */}
          <div style={{ padding: "16px 16px 0" }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", marginBottom: 8 }}>INPUT SOURCE</div>
            <div style={{ display: "flex", gap: 4, background: "var(--bg-tertiary)", borderRadius: 0, padding: 3, border: "1px solid var(--border-primary)" }}>
              {([
                { id: "device", label: "Audio Interface" },
                { id: "webrtc", label: "Softphone / SIP" },
              ] as const).map(({ id, label }) => (
                <button key={id} onClick={() => setInputMode(id)}
                  disabled={isRecording || isArmed}
                  style={{
                    flex: 1, height: 30, borderRadius: 0, border: "none", cursor: "pointer",
                    fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
                    transition: "all 0.15s",
                    background: inputMode === id ? "var(--accent-blue)" : "transparent",
                    color:      inputMode === id ? "#fff" : "var(--text-tertiary)",
                    opacity: (isRecording || isArmed) ? 0.45 : 1,
                  }}
                >{label}</button>
              ))}
            </div>
          </div>

          {/* Device / WebRTC config */}
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border-primary)" }}>
            {inputMode === "device" ? (
              <>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", marginBottom: 6 }}>DEVICE</div>
                <select
                  value={selectedDevice}
                  onChange={e => setSelectedDevice(e.target.value)}
                  disabled={isRecording || isArmed}
                  style={{
                    width: "100%", padding: "8px 10px", borderRadius: 0,
                    background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)", fontSize: 11, outline: "none", cursor: "pointer",
                    fontFamily: "'IBM Plex Mono', monospace",
                  }}
                >
                  {devices.length === 0 && <option value="">No devices found</option>}
                  {devices.map(d => <option key={d.id} value={d.id}>{d.name}{d.is_default ? " (default)" : ""}</option>)}
                </select>
                <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 }}>
                  Select the audio interface input connected to your phone hybrid or hybrid return.
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", marginBottom: 6 }}>SIP / WEBRTC URL</div>
                <input
                  type="text"
                  placeholder="sip:user@server or leave blank"
                  value={webrtcUrl}
                  onChange={e => setWebrtcUrl(e.target.value)}
                  disabled={isRecording || isArmed}
                  style={{
                    width: "100%", padding: "8px 10px", borderRadius: 0,
                    background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
                    color: "var(--text-primary)", fontSize: 11, outline: "none",
                    fontFamily: "'IBM Plex Mono', monospace", boxSizing: "border-box",
                  }}
                />
                <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 }}>
                  Browser will capture default mic input. Route your softphone audio to a virtual audio device and select that above, or use the browser's default mic if your softphone feeds it.
                </div>
              </>
            )}
          </div>

          {/* BIG record button */}
          <div style={{ padding: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <button
              onClick={handleRecButton}
              style={{
                width: 96, height: 96, borderRadius: "50%", border: "none",
                cursor: "pointer", flexShrink: 0,
                background: isRecording
                  ? "radial-gradient(circle, #ef4444, #b91c1c)"
                  : isArmed
                  ? "radial-gradient(circle, #fb923c, #c2410c)"
                  : "radial-gradient(circle, #27272a, #18181b)",
                boxShadow: isRecording
                  ? "0 0 0 4px rgba(239,68,68,0.2), 0 0 40px rgba(239,68,68,0.35)"
                  : isArmed
                  ? "0 0 0 4px rgba(251,146,60,0.25), 0 0 24px rgba(251,146,60,0.3)"
                  : "0 0 0 1px var(--border-primary), inset 0 1px 0 rgba(255,255,255,0.05)",
                transition: "all 0.2s",
                animation: isArmed ? "phone-blink 0.5s ease-in-out infinite" : "none",
              }}
              onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = "scale(0.94)"; }}
              onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
            >
              {isRecording ? (
                // Stop square
                <svg width="24" height="24" viewBox="0 0 24 24" fill="#fff">
                  <rect x="4" y="4" width="16" height="16" rx="3"/>
                </svg>
              ) : (
                // Record circle
                <svg width="28" height="28" viewBox="0 0 28 28" fill={isArmed ? "#fff" : "#ef4444"}>
                  <circle cx="14" cy="14" r="10"/>
                </svg>
              )}
            </button>

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: isRecording ? "#ef4444" : "var(--text-tertiary)", textAlign: "center" }}>
              {isRecording ? "CLICK TO STOP" : isArmed ? "STARTING..." : recState === "stopped" ? "RE-RECORD" : "RECORD"}
            </div>
          </div>

          {/* Clip info */}
          {hasClip && (
            <div style={{ margin: "0 16px 16px", padding: "12px 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
              <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", marginBottom: 8 }}>RECORDED CLIP</div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>Total</span>
                <span style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", color: "var(--text-primary)" }}>{fmtTime(clipDuration)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#008878" }}>Cue In</span>
                <span style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", color: "#008878" }}>{fmtTime(cueIn)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "#f87171" }}>Cue Out</span>
                <span style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", color: "#f87171" }}>{fmtTime(cueOut)}</span>
              </div>
              <div style={{ height: 1, background: "var(--border-primary)", margin: "8px 0" }} />
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-secondary)" }}>Clip length</span>
                <span style={{ fontSize: 11, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: "var(--text-primary)" }}>{fmtTime(clipLen)}</span>
              </div>
            </div>
          )}

          <div style={{ flex: 1 }} />

          {/* Tips */}
          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border-primary)" }}>
            <div style={{ fontSize: 9, color: "var(--text-tertiary)", lineHeight: 1.7 }}>
              <div>① Record the full call</div>
              <div>② Drag IN / OUT handles to trim</div>
              <div>③ Preview, then fire to a deck</div>
              <div style={{ marginTop: 6, opacity: 0.6 }}>
                <div>⌨ Space — play / stop</div>
                <div>⌨ ← — snap to start</div>
                <div>⌨ → — snap to end</div>
              </div>
            </div>
          </div>
        </div>

        {/* ── RIGHT: Waveform + controls ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

          {/* Waveform area */}
          <div style={{ flex: 1, position: "relative", minHeight: 0, background: "#0a0a0f" }}>
            {!hasClip && recState !== "recording" && (
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: 14, color: "var(--text-tertiary)",
              }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" style={{ opacity: 0.25 }}>
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.64 3.35 2 2 0 0 1 3.62 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Hit record to capture the call</div>
                <div style={{ fontSize: 11, opacity: 0.5 }}>Waveform appears after recording stops</div>
              </div>
            )}

            {/* Live level bars during recording */}
            {isRecording && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 2, padding: "0 24px" }}>
                {Array.from({ length: 80 }).map((_, i) => (
                  <div key={i} style={{
                    flex: 1, borderRadius: 0,
                    background: "#ef4444",
                    opacity: Math.random() * 0.6 + 0.1,
                    height: `${(liveWaveRef.current[liveWaveRef.current.length - 80 + i] ?? Math.random() * 0.3) * 80 + 4}%`,
                    transition: "height 0.1s",
                  }} />
                ))}
                <div style={{ position: "absolute", bottom: 12, left: "50%", transform: "translateX(-50%)", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#ef4444", animation: "phone-blink 1s ease-in-out infinite" }}>
                  ● RECORDING — {fmtTime(recDuration)}
                </div>
              </div>
            )}

            {hasClip && (
              <WaveformView
                peaks={waveformPeaks}
                duration={clipDuration}
                cueIn={cueIn}
                cueOut={cueOut}
                playhead={playhead}
                onSeek={(sec) => {
                  setPlayhead(sec);
                  if (previewing) startPreview(sec);
                }}
              />
            )}
          </div>

          {/* Cue controls */}
          {hasClip && (
            <div style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
              borderTop: "1px solid var(--border-primary)",
              background: "var(--bg-secondary)", flexShrink: 0,
            }}>
              {/* IN / OUT nudge */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", color: "#008878" }}>CUE IN</div>
                <div style={{ display: "flex", gap: 3 }}>
                  {[
                    { label: "◀◀", d: -1    },
                    { label: "◀",  d: -0.1  },
                    { label: "▶",  d:  0.1  },
                    { label: "▶▶", d:  1    },
                  ].map(({ label, d }) => (
                    <button key={label} onClick={() => setCueIn(v => Math.max(0, Math.min(v + d, cueOutRef.current - 0.1)))}
                      style={{ width: 26, height: 24, borderRadius: 0, border: "1px solid #00887830", background: "#00887810", color: "#008878", fontSize: 9, cursor: "pointer", fontWeight: 700 }}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", color: "#008878", letterSpacing: "-0.02em" }}>{fmtTime(cueIn)}</div>
              </div>

              <div style={{ width: 1, height: 48, background: "var(--border-primary)" }} />

              {/* Preview */}
              <button
                onClick={() => previewing ? stopPreview() : startPreview()}
                style={{
                  height: 40, padding: "0 20px", borderRadius: 0,
                  background: previewing ? "#34d399" : "var(--bg-tertiary)",
                  color: previewing ? "#000" : "var(--text-secondary)",
                  fontSize: 11, fontWeight: 700, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                  boxShadow: previewing ? "0 0 20px rgba(52,211,153,0.4)" : "none",
                  transition: "all 0.15s",
                  border: previewing ? "none" : "1px solid var(--border-primary)",
                }}
              >
                {previewing
                  ? <><svg width="11" height="11" viewBox="0 0 13 13" fill="currentColor"><rect x="1" y="0" width="4" height="13" rx="2"/><rect x="8" y="0" width="4" height="13" rx="2"/></svg> STOP</>
                  : <><svg width="11" height="11" viewBox="0 0 13 13" fill="currentColor"><polygon points="1,0 13,6.5 1,13"/></svg> PREVIEW</>
                }
              </button>

              <div style={{ width: 1, height: 48, background: "var(--border-primary)" }} />

              {/* OUT nudge */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", color: "#f87171" }}>CUE OUT</div>
                <div style={{ display: "flex", gap: 3 }}>
                  {[
                    { label: "◀◀", d: -1    },
                    { label: "◀",  d: -0.1  },
                    { label: "▶",  d:  0.1  },
                    { label: "▶▶", d:  1    },
                  ].map(({ label, d }) => (
                    <button key={label} onClick={() => setCueOut(v => Math.max(cueInRef.current + 0.1, Math.min(v + d, clipDuration)))}
                      style={{ width: 26, height: 24, borderRadius: 0, border: "1px solid #f8717130", background: "#f8717110", color: "#f87171", fontSize: 9, cursor: "pointer", fontWeight: 700 }}>
                      {label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", color: "#f87171", letterSpacing: "-0.02em" }}>{fmtTime(cueOut)}</div>
              </div>

              <div style={{ width: 1, height: 48, background: "var(--border-primary)" }} />

              {/* Reset cues */}
              <button onClick={() => { setCueIn(0); setCueOut(clipDuration); }}
                style={{ height: 30, padding: "0 12px", borderRadius: 0, border: "1px solid var(--border-primary)", background: "transparent", color: "var(--text-tertiary)", fontSize: 10, cursor: "pointer", fontWeight: 700, letterSpacing: "0.06em" }}>
                RESET
              </button>

              <div style={{ flex: 1 }} />

              {/* Send target + fire button */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)" }}>SEND TO</div>
                {(["A", "B", "C", "cart"] as SendTarget[]).map(t => (
                  <button key={t} onClick={() => setSendTarget(t)}
                    style={{
                      height: 32, padding: "0 12px", borderRadius: 0,
                      border: sendTarget === t ? "none" : "1px solid var(--border-primary)",
                      background: sendTarget === t
                        ? t === "A" ? "var(--accent-blue)"
                        : t === "B" ? "var(--accent-green)"
                        : t === "C" ? "#a78bfa"
                        : "#fb923c"
                        : "var(--bg-tertiary)",
                      color: sendTarget === t ? (t === "cart" ? "#000" : "#fff") : "var(--text-tertiary)",
                      fontSize: 10, fontWeight: 800, cursor: "pointer",
                      letterSpacing: "0.04em",
                      transition: "all 0.12s",
                    }}
                  >{t === "cart" ? "CART" : `Deck ${t}`}</button>
                ))}

                <button
                  onClick={sendClip}
                  disabled={sending || !hasClip}
                  style={{
                    height: 40, padding: "0 24px", borderRadius: 0, border: "none",
                    background: sent ? "#34d399" : sending ? "#27272a" : "#ef4444",
                    color: sent ? "#000" : "#fff",
                    fontSize: 11, fontWeight: 800, letterSpacing: "0.06em",
                    cursor: (!hasClip || sending) ? "not-allowed" : "pointer",
                    opacity: !hasClip ? 0.4 : 1,
                    boxShadow: (!hasClip || sending) ? "none" : sent ? "0 0 20px rgba(52,211,153,0.4)" : "0 0 20px rgba(239,68,68,0.35)",
                    transition: "all 0.2s",
                    display: "flex", alignItems: "center", gap: 8,
                  }}
                  onMouseDown={e => { if (hasClip && !sending) (e.currentTarget as HTMLElement).style.transform = "scale(0.96)"; }}
                  onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = "scale(1)"; }}
                >
                  {sent ? "✓ SENT" : sending ? "SENDING..." : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                      FIRE
                    </>
                  )}
                </button>

                {/* Save to disk */}
                <button
                  onClick={saveRecording}
                  disabled={saving || !hasClip}
                  title="Save recording to disk"
                  style={{
                    height: 40, padding: "0 14px", borderRadius: 0,
                    border: "1px solid var(--border-primary)",
                    background: savedPath ? "rgba(0,136,120,0.15)" : "var(--bg-tertiary)",
                    color: savedPath ? "#008878" : "var(--text-tertiary)",
                    fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
                    cursor: (!hasClip || saving) ? "not-allowed" : "pointer",
                    opacity: !hasClip ? 0.4 : 1,
                    transition: "all 0.2s",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  {savedPath ? (
                    <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg> SAVED</>
                  ) : saving ? "SAVING..." : (
                    <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> SAVE</>
                  )}
                </button>
              </div>
            </div>
          )}

          {sendError && (
            <div style={{ padding: "8px 16px", background: "rgba(239,68,68,0.08)", borderTop: "1px solid rgba(239,68,68,0.2)", fontSize: 11, color: "#ef4444", flexShrink: 0 }}>
              {sendError}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes phone-blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}
