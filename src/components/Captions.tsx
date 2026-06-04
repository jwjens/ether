// Captions.tsx — Live transcription overlay + transcript log
//
// Two exports:
//   CaptionsOverlay   — fixed semi-transparent bar at bottom of viewport,
//                       shows last 1–2 lines of live text. Mount once in App.
//   CaptionsLogPanel  — full rolling transcript with timestamps + export,
//                       used as a panel (panel === "captions").

import React, { useState, useEffect, useRef, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────

export interface CaptionLine {
  text:      string;
  timestamp: string;   // ISO 8601
  speaker:   "air" | "iris";
}

// ── Loopback audio tap ────────────────────────────────────────
// Opens a WASAPI loopback stream via desktopCapturer + getUserMedia,
// downsamples to 16 kHz mono Float32, and pumps chunks to the main
// process where Whisper runs. Returns a stop function.

async function startLoopbackTap(deviceId: string | undefined, onChunk: (data: Float32Array) => void): Promise<() => void> {
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl:  false,
  };
  if (deviceId) (audioConstraints as any).deviceId = { exact: deviceId };

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
    video: false,
  });

  const INPUT_SR = 48_000;  // mic devices report 48 kHz on Windows
  const TARGET_SR = 16_000; // Whisper expects 16 kHz
  const RATIO = INPUT_SR / TARGET_SR; // 3:1 downsample

  const ctx    = new AudioContext({ sampleRate: INPUT_SR });
  const source = ctx.createMediaStreamSource(stream);

  // ScriptProcessorNode — deprecated but universally available in Electron.
  // bufferSize 4096 → ~85 ms chunks at 48 kHz → ~1366 samples after 3× downsample.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const proc   = ctx.createScriptProcessor(4096, 1, 1);

  proc.onaudioprocess = (ev) => {
    const input  = ev.inputBuffer.getChannelData(0);
    // Simple 3:1 decimation (good enough for speech; Whisper is robust)
    const outLen = Math.floor(input.length / RATIO);
    const out    = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      out[i] = input[Math.floor(i * RATIO)];
    }
    onChunk(out);
  };

  source.connect(proc);
  proc.connect(ctx.destination);   // must be connected to run in Chrome/Electron

  return () => {
    proc.disconnect();
    source.disconnect();
    ctx.close().catch(() => {});
    stream.getTracks().forEach(t => t.stop());
  };
}

// ── useCaptions hook ──────────────────────────────────────────
// Shared hook — call once at the App level, pass state down as props.

export function useCaptions(active = true) {
  const [enabled,     setEnabled]     = useState(false);
  const [lines,       setLines]       = useState<CaptionLine[]>([]);
  const [status,      setStatus]      = useState<{ state: string; message: string } | null>(null);
  const [micDevices,  setMicDevices]  = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>(
    () => localStorage.getItem("captions_mic_device") || ""
  );
  const stopTapRef = useRef<(() => void) | null>(null);
  const ether = (window as any).ether;

  // Enumerate audio input devices only when video view is active
  useEffect(() => {
    if (!active) return;
    navigator.mediaDevices.enumerateDevices().then(devices => {
      setMicDevices(devices.filter(d => d.kind === "audioinput"));
    }).catch(() => {});
  }, [active]);

  // Subscribe to push events from main process
  useEffect(() => {
    const onLine = (line: CaptionLine) => {
      setLines(prev => {
        const next = [...prev, line];
        // Keep last 60 seconds
        const cutoff = Date.now() - 60_000;
        return next.filter(l => new Date(l.timestamp).getTime() > cutoff);
      });
    };
    const onStatus = (s: { state: string; message: string }) => setStatus(s);

    const hLine   = ether.captions.onLine(onLine);
    const hStatus = ether.captions.onStatus(onStatus);
    return () => {
      ether.captions.offLine(hLine);
      ether.captions.offStatus(hStatus);
    };
  }, []);

  // Load existing transcript when hook mounts (e.g. after page reload)
  useEffect(() => {
    ether.captions.getTranscript().then((t: CaptionLine[]) => {
      if (t && t.length) setLines(t);
    }).catch(() => {});
  }, []);

  const selectMic = useCallback((id: string) => {
    setMicDeviceId(id);
    localStorage.setItem("captions_mic_device", id);
  }, []);

  const enable = useCallback(async () => {
    setEnabled(true);
    await ether.captions.start();
    try {
      stopTapRef.current = await startLoopbackTap(micDeviceId || undefined, (chunk) => {
        ether.captions.sendAudioChunk(chunk);
      });
    } catch (e: any) {
      console.error("[captions] loopback tap failed:", e.message);
      setStatus({ state: "error", message: "Audio capture unavailable: " + e.message });
    }
  }, [micDeviceId]);

  const disable = useCallback(async () => {
    setEnabled(false);
    stopTapRef.current?.();
    stopTapRef.current = null;
    await ether.captions.stop();
  }, []);

  const toggle = useCallback(() => {
    enabled ? disable() : enable();
  }, [enabled, enable, disable]);

  return { enabled, lines, status, toggle, enable, disable, micDevices, micDeviceId, selectMic };
}

// ── CaptionsOverlay ───────────────────────────────────────────

interface OverlayProps {
  lines:   CaptionLine[];
  enabled: boolean;
  status:  { state: string; message: string } | null;
}

export function CaptionsOverlay({ lines, enabled, status }: OverlayProps) {
  if (!enabled) return null;

  // Show last 2 non-empty lines
  const visible = lines
    .filter(l => l.text.trim())
    .slice(-2);

  const isLoading = status?.state === "loading" || status?.state === "error";

  return (
    <div style={{
      position:       "fixed",
      bottom:         24,
      left:           "50%",
      transform:      "translateX(-50%)",
      zIndex:         8000,
      maxWidth:       "min(860px, 90vw)",
      width:          "max-content",
      pointerEvents:  "none",
    }}>
      {/* Status pill while model loads */}
      {isLoading && (
        <div style={{
          textAlign:        "center",
          marginBottom:     6,
          background:       "rgba(0,0,0,0.7)",
          color:            status?.state === "error" ? "#f87171" : "#94a3b8",
          fontSize:         11,
          fontWeight:       600,
          padding:          "4px 12px",
          letterSpacing:    "0.05em",
          backdropFilter:   "blur(6px)",
          display:          "inline-block",
        }}>
          {status?.message}
        </div>
      )}

      {/* Caption lines */}
      {visible.length > 0 && (
        <div style={{
          background:     "rgba(0,0,0,0.82)",
          backdropFilter: "blur(8px)",
          padding:        "10px 20px 12px",
          borderRadius:   0,
          borderTop:      "2px solid rgba(255,255,255,0.08)",
        }}>
          {visible.map((l, i) => (
            <div key={i} style={{
              fontSize:      22,
              fontWeight:    600,
              color:         l.speaker === "iris" ? "#00c8a8" : "#ffffff",
              lineHeight:    1.35,
              textShadow:    "0 1px 4px rgba(0,0,0,0.9)",
              fontFamily:    "'Inter', system-ui, sans-serif",
              letterSpacing: "-0.01em",
              opacity:       i === 0 && visible.length > 1 ? 0.65 : 1,
            }}>
              {l.speaker === "iris" && (
                <span style={{ fontSize: 14, marginRight: 8, opacity: 0.7, verticalAlign: "middle" }}>IRIS</span>
              )}
              {l.text}
            </div>
          ))}
        </div>
      )}

      {/* Idle indicator when running but nothing yet */}
      {visible.length === 0 && !isLoading && (
        <div style={{
          background:   "rgba(0,0,0,0.6)",
          padding:      "6px 16px",
          fontSize:     12,
          color:        "rgba(255,255,255,0.4)",
          letterSpacing:"0.08em",
          fontWeight:   600,
          textAlign:    "center",
        }}>
          CC — LISTENING
        </div>
      )}
    </div>
  );
}

// ── CaptionsLogPanel ──────────────────────────────────────────
// Full rolling transcript with timestamps + export button.
// Used as a panel in App.tsx (panel === "captions").

interface LogProps {
  lines:   CaptionLine[];
  enabled: boolean;
  status:  { state: string; message: string } | null;
  toggle:  () => void;
}

export function CaptionsLogPanel({ lines, enabled, status, toggle }: LogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, autoScroll]);

  const exportTxt = () => {
    const text = lines.map(l => {
      const t = new Date(l.timestamp).toLocaleTimeString();
      const who = l.speaker === "iris" ? "[IRIS]" : "[AIR]";
      return `${t} ${who} ${l.text}`;
    }).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `ether-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportSrt = () => {
    let srt   = "";
    let index = 1;
    // Each line becomes a 5-second subtitle block
    lines.forEach((l) => {
      const start = new Date(l.timestamp);
      const end   = new Date(start.getTime() + 5000);
      const fmt   = (d: Date) =>
        `${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")},000`;
      srt += `${index}\n${fmt(start)} --> ${fmt(end)}\n${l.text}\n\n`;
      index++;
    });
    const blob = new Blob([srt], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `ether-transcript-${new Date().toISOString().slice(0, 10)}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ padding: "0 0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0 }}>Live Captions</h1>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            Powered by OpenAI Whisper (local, free) · {lines.length} lines this session
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {status?.state === "loading" && (
            <span style={{ fontSize: 12, color: "var(--accent-blue)", fontWeight: 600 }}>{status.message}</span>
          )}
          {lines.length > 0 && (
            <>
              <button onClick={exportTxt} style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, cursor: "pointer" }}>
                Export TXT
              </button>
              <button onClick={exportSrt} style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, cursor: "pointer" }}>
                Export SRT
              </button>
            </>
          )}
          <button
            onClick={toggle}
            style={{
              padding:     "7px 16px", fontSize: 12, fontWeight: 700, borderRadius: 0, border: "none", cursor: "pointer",
              background:  enabled ? "rgba(239,68,68,0.15)" : "var(--accent-blue)",
              color:       enabled ? "#f87171" : "#fff",
            }}
          >
            {enabled ? "■ Stop" : "● Start"}
          </button>
        </div>
      </div>

      {/* Status banner */}
      {status?.state === "error" && (
        <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", fontSize: 13, color: "#f87171", marginBottom: 12, flexShrink: 0 }}>
          {status.message}
        </div>
      )}

      {/* Transcript list */}
      <div
        style={{ flex: 1, overflowY: "auto", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollTop + el.clientHeight >= el.scrollHeight - 40);
        }}
      >
        {lines.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: "var(--text-tertiary)", fontSize: 14 }}>
            {enabled
              ? "Listening… transcriptions will appear here"
              : "Press Start to begin live transcription"}
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={i} style={{
              display:      "flex",
              gap:          12,
              padding:      "10px 16px",
              borderBottom: "1px solid var(--border-primary)",
              alignItems:   "flex-start",
            }}>
              {/* Timestamp */}
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', monospace", whiteSpace: "nowrap", paddingTop: 2, flexShrink: 0 }}>
                {new Date(l.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>

              {/* Speaker badge */}
              <span style={{
                fontSize:     10, fontWeight: 800, letterSpacing: "0.1em",
                padding:      "2px 6px", flexShrink: 0,
                background:   l.speaker === "iris" ? "rgba(0,200,168,0.15)" : "rgb(from var(--accent-blue) r g b / 0.1)",
                color:        l.speaker === "iris" ? "#00c8a8" : "var(--accent-blue)",
                border:       `1px solid ${l.speaker === "iris" ? "rgba(0,200,168,0.3)" : "rgb(from var(--accent-blue) r g b / 0.25)"}`,
                alignSelf:    "flex-start",
                marginTop:    1,
              }}>
                {l.speaker === "iris" ? "IRIS" : "AIR"}
              </span>

              {/* Text */}
              <span style={{ fontSize: 14, color: "var(--text-primary)", lineHeight: 1.5, flex: 1 }}>
                {l.text}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Auto-scroll nudge */}
      {!autoScroll && lines.length > 0 && (
        <button
          onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }}
          style={{ margin: "8px auto 0", display: "block", padding: "6px 16px", fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", borderRadius: 0, cursor: "pointer" }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}
