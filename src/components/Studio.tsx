// src/components/Studio.tsx
// Video podcast recording & streaming studio.
// Dark steel aesthetic: #111114 backgrounds, sharp edges, zero border-radius.

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import { query as dbQuery, execute as dbExec } from "../db/client";

const invoke = (cmd: string, args?: any): Promise<any> =>
  (window as any).ether.invoke(cmd, args);
const ipcOn  = (e: string, cb: (p: any) => void) =>
  (window as any).ether.on(e, cb);
const ipcOff = (e: string, h: any) =>
  (window as any).ether.off(e, h);

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface GuestPeer {
  id: string;
  name: string;
  stream: MediaStream | null;
  conn: RTCPeerConnection;
  muted: boolean;
}

interface LowerThird {
  id: string;
  name: string;
  title: string;
  visible: boolean;
}

interface RtmpDest {
  id: number;
  name: string;
  url: string;
  stream_key: string;
}

type TeleMode = "off" | "overlay" | "sidebar";
type TeleSpeed = "slow" | "medium" | "fast";
type ResKey = "720p" | "1080p" | "1440p" | "4k";
type BrKey  = "low" | "medium" | "high" | "ultra";

const RES: Record<ResKey, { w: number; h: number; label: string; desc: string }> = {
  "720p":  { w: 1280,  h: 720,  label: "720p",  desc: "1280×720  default" },
  "1080p": { w: 1920,  h: 1080, label: "1080p", desc: "1920×1080  HD" },
  "1440p": { w: 2560,  h: 1440, label: "1440p", desc: "2560×1440  2K" },
  "4k":    { w: 3840,  h: 2160, label: "4K",    desc: "3840×2160  maximum" },
};

const BITRATES: Record<BrKey, { kbps: number; label: string; desc: string }> = {
  low:    { kbps: 1500,  label: "Low",    desc: "1500 kbps  unstable connections" },
  medium: { kbps: 4000,  label: "Medium", desc: "4000 kbps  balanced (default)" },
  high:   { kbps: 8000,  label: "High",   desc: "8000 kbps  quality streaming" },
  ultra:  { kbps: 16000, label: "Ultra",  desc: "16000 kbps  local recording only" },
};

// ─────────────────────────────────────────────────────────────
// useVideoQuality — persisted to station_config_kv
// ─────────────────────────────────────────────────────────────

function useVideoQuality() {
  const [resolution, setResolutionState] = useState<ResKey>("720p");
  const [bitrate, setBitrateState]       = useState<BrKey>("medium");

  useEffect(() => {
    dbQuery<{ key: string; value: string }>(
      "SELECT key, value FROM station_config_kv WHERE key IN ('studio_resolution','studio_bitrate')"
    ).then(rows => {
      rows.forEach(r => {
        if (r.key === "studio_resolution" && r.value in RES)     setResolutionState(r.value as ResKey);
        if (r.key === "studio_bitrate"    && r.value in BITRATES) setBitrateState(r.value as BrKey);
      });
    }).catch(() => {});
  }, []);

  const setResolution = useCallback((v: ResKey) => {
    setResolutionState(v);
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_resolution',?)", [v]).catch(() => {});
  }, []);

  const setBitrate = useCallback((v: BrKey) => {
    setBitrateState(v);
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_bitrate',?)", [v]).catch(() => {});
  }, []);

  return { resolution, setResolution, bitrate, setBitrate, bitrateKbps: BITRATES[bitrate].kbps };
}

// ─────────────────────────────────────────────────────────────
// Shared style constants
// ─────────────────────────────────────────────────────────────

const BG0  = "#0e0e14";
const BG1  = "#111114";
const BG2  = "#18181f";
const BG3  = "#1e1e28";
const BOR  = "#2a2a38";
const TXT  = "#e8e8f0";
const TXT2 = "#8888a8";
const PUR  = "#7858c8";
const GRN  = "#22c55e";
const RED  = "#ef4444";
const AMB  = "#f59e0b";

const btn = (active?: boolean, color?: string): React.CSSProperties => ({
  padding: "4px 12px", border: `1px solid ${active ? (color || PUR) : BOR}`,
  background: active ? (color || PUR) : BG2, color: active ? "#fff" : TXT2,
  fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", cursor: "pointer",
  textTransform: "uppercase" as const,
});

const label: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
  textTransform: "uppercase" as const, color: TXT2, marginBottom: 4,
};

const inp: React.CSSProperties = {
  width: "100%", padding: "5px 8px",
  background: BG0, border: `1px solid ${BOR}`,
  color: TXT, fontSize: 11, outline: "none",
};

// ─────────────────────────────────────────────────────────────
// useWebRTCGuests
// ─────────────────────────────────────────────────────────────

function useWebRTCGuests(enabled: boolean) {
  const [guests, setGuests] = useState<GuestPeer[]>([]);
  const wsRef    = useRef<WebSocket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket;
    try { ws = new WebSocket("ws://localhost:9091/signal?role=host"); }
    catch { return; }
    wsRef.current = ws;

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      const { from, type, payload, name } = msg;

      if (type === "offer") {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
        peersRef.current.set(from, pc);
        setGuests(prev => prev.find(g => g.id === from) ? prev : [
          ...prev, { id: from, name: name || `Guest ${prev.length + 1}`, stream: null, conn: pc, muted: false },
        ]);
        pc.ontrack = (e) => {
          const stream = e.streams[0] || null;
          setGuests(prev => prev.map(g => g.id === from ? { ...g, stream } : g));
        };
        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ to: from, type: "ice", payload: e.candidate }));
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            peersRef.current.delete(from);
            setGuests(prev => prev.filter(g => g.id !== from));
          }
        };
        try {
          await pc.setRemoteDescription(payload);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ to: from, type: "answer", payload: answer }));
        } catch {}

      } else if (type === "ice") {
        const pc = peersRef.current.get(from);
        if (pc && payload) try { await pc.addIceCandidate(payload); } catch {}
      } else if (type === "leave") {
        const pc = peersRef.current.get(from);
        if (pc) { pc.close(); peersRef.current.delete(from); }
        setGuests(prev => prev.filter(g => g.id !== from));
      }
    };

    return () => {
      ws.close();
      peersRef.current.forEach(pc => pc.close());
      peersRef.current.clear();
      setGuests([]);
    };
  }, [enabled]);

  const removeGuest = useCallback((id: string) => {
    const pc = peersRef.current.get(id);
    if (pc) { pc.close(); peersRef.current.delete(id); }
    setGuests(prev => prev.filter(g => g.id !== id));
  }, []);

  const toggleMute = useCallback((id: string) => {
    setGuests(prev => prev.map(g => {
      if (g.id !== id) return g;
      g.stream?.getAudioTracks().forEach(t => { t.enabled = g.muted; });
      return { ...g, muted: !g.muted };
    }));
  }, []);

  return { guests, removeGuest, toggleMute };
}

// ─────────────────────────────────────────────────────────────
// useLevelMeter
// ─────────────────────────────────────────────────────────────

function useLevelMeter(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number>(0);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!stream) { setLevel(0); return; }
    const ctx      = new AudioContext();
    ctxRef.current = ctx;
    const src      = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      setLevel(buf.reduce((a, b) => a + b, 0) / buf.length / 128);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(rafRef.current);
      ctx.close();
    };
  }, [stream]);

  return level;
}

// ─────────────────────────────────────────────────────────────
// LevelBar
// ─────────────────────────────────────────────────────────────

function LevelBar({ level, height = 4 }: { level: number; height?: number }) {
  const pct = Math.min(level * 100, 100);
  return (
    <div style={{ width: "100%", height, background: BG0, flexShrink: 0 }}>
      <div style={{
        height: "100%", width: `${pct}%`,
        background: pct > 85 ? RED : pct > 60 ? AMB : GRN,
        transition: "width 0.05s",
      }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HostCamera
// ─────────────────────────────────────────────────────────────

function HostCamera({
  onStream,
  lowerThirds,
  teleMode,
  teleOpacity,
  teleScript,
  teleFontSize,
  teleScrolling,
  teleScrollRef,
  resolution,
  isRecording,
  showGrid,
  showFrameOverlays,
}: {
  onStream: (s: MediaStream | null) => void;
  lowerThirds: LowerThird[];
  teleMode: TeleMode;
  teleOpacity: number;
  teleScript: string;
  teleFontSize: number;
  teleScrolling: boolean;
  teleScrollRef: React.RefObject<HTMLDivElement>;
  resolution: ResKey;
  isRecording?: boolean;
  showGrid?: boolean;
  showFrameOverlays?: boolean;
}) {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [actualRes, setActualRes] = useState<string | null>(null);

  const start = useCallback(async (res: ResKey) => {
    try {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const { w, h } = RES[res];
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: w }, height: { ideal: h } },
          audio: true,
        });
      } catch {
        // 4K not supported — fall back to 1080p
        s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
        });
        setError("4K not supported by camera — using 1080p");
      }
      streamRef.current = s;
      onStream(s);
      const vt = s.getVideoTracks()[0];
      const settings = vt?.getSettings();
      if (settings) setActualRes(`${settings.width}×${settings.height}`);
      if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.muted = true; }
      if (error && !error.includes("4K")) setError(null);
    } catch (e: any) { setError(e.message); onStream(null); }
  }, [onStream]); // eslint-disable-line

  // Restart on resolution change
  useEffect(() => {
    start(resolution);
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, [resolution]); // eslint-disable-line

  const ltPos = (i: number): React.CSSProperties => ({
    position: "absolute", bottom: 48 + i * 56, left: 16,
  });

  const frameColor = "#4040a0";
  const cornerLen  = 20;
  const cornerW    = 2;
  const corners: { top?: 0; bottom?: 0; left?: 0; right?: 0 }[] = [
    { top: 0, left: 0 }, { top: 0, right: 0 },
    { bottom: 0, left: 0 }, { bottom: 0, right: 0 },
  ];

  return (
    <div style={{ position: "relative", background: "#0a0a10", border: `1px solid #1a1a22`, flex: 1, minHeight: 0, overflow: "hidden" }}>

      {/* Dark placeholder when no stream */}
      {!actualRes && !error && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, pointerEvents: "none" }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2a2a50" strokeWidth="1.5" strokeLinecap="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          <span style={{ fontSize: 11, color: "#2a2a50", letterSpacing: "0.05em" }}>Camera not active</span>
        </div>
      )}

      {error && !error.includes("4K") ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: RED, fontSize: 12 }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="1" fill="currentColor"/></svg>
          {error}
          <button onClick={() => start(resolution)} style={{ ...btn(), color: "#fff", background: "#3b82f6", border: "none" }}>Retry</button>
        </div>
      ) : (
        <video ref={videoRef} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      )}

      {/* ── Frame treatment overlays (when stream active) ── */}
      {actualRes && showFrameOverlays && (
        <>
          {/* Viewfinder corners — 4 L-shaped markers */}
          {corners.map((pos, i) => (
            <div key={i} style={{ position: "absolute", ...pos, width: cornerLen, height: cornerLen, pointerEvents: "none" }}>
              {/* Horizontal arm */}
              <div style={{
                position: "absolute",
                top: pos.bottom !== undefined ? undefined : 0,
                bottom: pos.bottom !== undefined ? 0 : undefined,
                left: pos.right !== undefined ? undefined : 0,
                right: pos.right !== undefined ? 0 : undefined,
                width: cornerLen, height: cornerW,
                background: frameColor,
              }} />
              {/* Vertical arm */}
              <div style={{
                position: "absolute",
                top: pos.bottom !== undefined ? undefined : 0,
                bottom: pos.bottom !== undefined ? 0 : undefined,
                left: pos.right !== undefined ? undefined : 0,
                right: pos.right !== undefined ? 0 : undefined,
                width: cornerW, height: cornerLen,
                background: frameColor,
              }} />
            </div>
          ))}

          {/* Safe zone — 80% inset rectangle */}
          <div style={{
            position: "absolute",
            top: "10%", left: "10%", right: "10%", bottom: "10%",
            border: `0.5px solid ${frameColor}`,
            pointerEvents: "none",
          }} />

          {/* Rule of thirds grid */}
          {showGrid && (
            <>
              {/* Horizontal thirds */}
              <div style={{ position: "absolute", top: "33.33%", left: 0, right: 0, height: 1, background: "rgba(100,100,180,0.15)", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: "66.66%", left: 0, right: 0, height: 1, background: "rgba(100,100,180,0.15)", pointerEvents: "none" }} />
              {/* Vertical thirds */}
              <div style={{ position: "absolute", top: 0, bottom: 0, left: "33.33%", width: 1, background: "rgba(100,100,180,0.15)", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 0, bottom: 0, left: "66.66%", width: 1, background: "rgba(100,100,180,0.15)", pointerEvents: "none" }} />
            </>
          )}

          {/* Resolution badge — top right, updates immediately with resolution prop */}
          <div style={{
            position: "absolute", top: 8, right: 8,
            background: "rgba(0,0,0,0.65)", padding: "2px 7px",
            fontSize: 9, fontWeight: 700, color: "#8080b0", letterSpacing: "0.1em",
            pointerEvents: "none",
          }}>
            {error?.includes("4K") ? `⚠ ${actualRes}` : RES[resolution].label}
          </div>

          {/* Recording indicator — top left, pulsing when active */}
          {isRecording && (
            <div style={{
              position: "absolute", top: 8, left: 8,
              display: "flex", alignItems: "center", gap: 5,
              background: "rgba(0,0,0,0.65)", padding: "2px 8px",
              pointerEvents: "none",
            }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: RED, animation: "rec-pulse 1.4s ease-in-out infinite" }} />
              <span style={{ fontSize: 9, fontWeight: 800, color: RED, letterSpacing: "0.12em" }}>REC</span>
            </div>
          )}
        </>
      )}

      {/* Resolution badge without frame overlays (standalone mode) */}
      {actualRes && !showFrameOverlays && (
        <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.55)", padding: "2px 7px", fontSize: 9, fontWeight: 700, color: TXT2, letterSpacing: "0.08em" }}>
          {error?.includes("4K") ? `⚠ ${actualRes}` : actualRes}
        </div>
      )}

      {/* Teleprompter overlay mode */}
      {teleMode === "overlay" && teleScript && (
        <div ref={teleScrollRef} style={{
          position: "absolute", inset: 0,
          background: `rgba(0,0,0,${teleOpacity * 0.6})`,
          padding: "10% 12%",
          overflowY: "hidden",
          color: "#fff",
          fontSize: teleFontSize,
          fontWeight: 600,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          userSelect: "none",
          pointerEvents: "none",
        }}>
          {teleScript}
        </div>
      )}

      {/* Lower thirds */}
      {lowerThirds.filter(lt => lt.visible).map((lt, i) => (
        <div key={lt.id} style={{ ...ltPos(i), background: "rgba(0,0,0,0.75)", borderLeft: `3px solid ${PUR}`, padding: "7px 14px", backdropFilter: "blur(4px)" }}>
          <div style={{ color: "#fff", fontSize: 15, fontWeight: 700, letterSpacing: "0.01em" }}>{lt.name}</div>
          {lt.title && <div style={{ color: "#b8a8e8", fontSize: 11, marginTop: 2 }}>{lt.title}</div>}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GuestTile
// ─────────────────────────────────────────────────────────────

function GuestTile({ guest, onMute, onRemove }: { guest: GuestPeer; onMute: () => void; onRemove: () => void }) {
  const vidRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (vidRef.current && guest.stream) vidRef.current.srcObject = guest.stream;
  }, [guest.stream]);

  return (
    <div style={{ position: "relative", background: BG0, border: `1px solid ${BOR}`, flexShrink: 0, height: 130 }}>
      {guest.stream ? (
        <video ref={vidRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      ) : (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: BG3, display: "flex", alignItems: "center", justifyContent: "center", color: TXT2, fontSize: 16, fontWeight: 700 }}>
            {(guest.name[0] || "?").toUpperCase()}
          </div>
        </div>
      )}
      {/* ON AIR badge — top-left when stream is live */}
      {guest.stream && (
        <div style={{ position: "absolute", top: 6, left: 6, display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", background: "#0e9090", border: "1px solid #14c8c8", boxShadow: "0 0 10px rgba(20,184,184,0.5)" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff", boxShadow: "0 0 5px rgba(255,255,255,0.8)", animation: "mic-blink 1.2s ease-in-out infinite", flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", letterSpacing: "0.12em" }}>ON AIR</span>
        </div>
      )}
      {/* Name tag */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(14,14,20,0.85)", padding: "5px 8px", display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600, color: TXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{guest.name}</span>
        <button onClick={onMute} title={guest.muted ? "Unmute" : "Mute"} style={{ background: "none", border: "none", color: guest.muted ? RED : TXT2, cursor: "pointer", fontSize: 11, padding: "1px 3px", lineHeight: 1 }}>
          {guest.muted ? "🔇" : "🔊"}
        </button>
        <button onClick={onRemove} title="Remove guest" style={{ background: "none", border: "none", color: RED, cursor: "pointer", fontSize: 12, padding: "1px 3px", lineHeight: 1 }}>×</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GuestSidebar
// ─────────────────────────────────────────────────────────────

function GuestSidebar({ guests, enabled, onToggle, onMute, onRemove }: {
  guests: GuestPeer[];
  enabled: boolean;
  onToggle: () => void;
  onMute: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [localIp, setLocalIp] = useState("127.0.0.1");
  const [copied, setCopied]   = useState(false);
  const token = useMemo(() => Math.random().toString(36).slice(2, 10), []);

  useEffect(() => {
    invoke("studio:getLocalIp").then((ip: string) => setLocalIp(ip || "127.0.0.1"));
  }, []);

  const link = `http://${localIp}:9091/join?s=${token}`;

  const copy = () => {
    navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "8px 10px", borderBottom: `1px solid ${BOR}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ ...label, marginBottom: 0 }}>Guests ({guests.length})</span>
          <button onClick={onToggle} style={btn(enabled, GRN)}>
            {enabled ? "On" : "Enable"}
          </button>
        </div>
        {enabled && (
          <div>
            <div style={{ ...label, marginBottom: 3 }}>Invite Link</div>
            <div style={{ display: "flex", gap: 4 }}>
              <input readOnly value={link} style={{ ...inp, fontSize: 9, color: "#7090e8", flex: 1 }} />
              <button onClick={copy} style={{ ...btn(copied, GRN), whiteSpace: "nowrap" }}>
                {copied ? "✓" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tiles */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: 6 }}>
        {guests.length === 0 ? (
          <div style={{ color: BOR, fontSize: 10, textAlign: "center", padding: "20px 10px" }}>
            {enabled ? "Waiting for guests…" : "Enable to invite guests"}
          </div>
        ) : guests.map(g => (
          <GuestTile key={g.id} guest={g} onMute={() => onMute(g.id)} onRemove={() => onRemove(g.id)} />
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Teleprompter sidebar panel
// ─────────────────────────────────────────────────────────────

function TeleprompterPanel({
  script, setScript,
  mode, setMode,
  speed, setSpeed,
  opacity, setOpacity,
  fontSize, setFontSize,
  scrolling, setScrolling,
  scrollRef,
}: {
  script: string; setScript: (v: string) => void;
  mode: TeleMode; setMode: (v: TeleMode) => void;
  speed: TeleSpeed; setSpeed: (v: TeleSpeed) => void;
  opacity: number; setOpacity: (v: number) => void;
  fontSize: number; setFontSize: (v: number) => void;
  scrolling: boolean; setScrolling: (v: boolean) => void;
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  const reset = () => { if (scrollRef.current) scrollRef.current.scrollTop = 0; };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10, height: "100%", overflowY: "auto" }}>
      {/* Mode */}
      <div>
        <div style={label}>Mode</div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["off","overlay","sidebar"] as TeleMode[]).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ ...btn(mode === m, PUR), flex: 1, padding: "4px 0" }}>
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Speed */}
      <div>
        <div style={label}>Scroll Speed</div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["slow","medium","fast"] as TeleSpeed[]).map(s => (
            <button key={s} onClick={() => setSpeed(s)} style={{ ...btn(speed === s, PUR), flex: 1, padding: "4px 0" }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 4 }}>
        <button onClick={() => setScrolling(!scrolling)} style={{ ...btn(scrolling, GRN), flex: 1 }}>
          {scrolling ? "Pause" : "Play"}
        </button>
        <button onClick={reset} style={{ ...btn(), flex: 1 }}>Reset</button>
      </div>

      {/* Font size */}
      <div>
        <div style={label}>Font Size — {fontSize}px</div>
        <input type="range" min={18} max={48} value={fontSize} onChange={e => setFontSize(+e.target.value)} style={{ width: "100%" }} />
      </div>

      {/* Opacity (overlay mode) */}
      {mode === "overlay" && (
        <div>
          <div style={label}>Overlay Opacity — {Math.round(opacity * 100)}%</div>
          <input type="range" min={0.2} max={0.8} step={0.05} value={opacity} onChange={e => setOpacity(+e.target.value)} style={{ width: "100%" }} />
        </div>
      )}

      {/* Script */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={label}>Script</div>
        <textarea
          value={script}
          onChange={e => setScript(e.target.value)}
          placeholder="Paste or type your script here…"
          style={{ ...inp, flex: 1, resize: "none", lineHeight: 1.6, minHeight: 160 }}
        />
      </div>

      {/* Sidebar mode preview */}
      {mode === "sidebar" && script && (
        <div>
          <div style={label}>Preview</div>
          <div
            ref={scrollRef}
            style={{
              height: 200, overflowY: "hidden", background: BG0, border: `1px solid ${BOR}`,
              padding: "12px 14px", color: "#fff", fontSize: teleFontSizePreview(fontSize),
              lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "none",
            }}
          >
            {script}
          </div>
          <div style={{ marginTop: 4, fontSize: 9, color: TXT2 }}>↑ Position indicator</div>
        </div>
      )}
    </div>
  );
}

function teleFontSizePreview(fs: number) { return Math.max(10, fs * 0.55); }

// ─────────────────────────────────────────────────────────────
// LowerThirdsPanel
// ─────────────────────────────────────────────────────────────

function LowerThirdsPanel({ items, onChange }: { items: LowerThird[]; onChange: (v: LowerThird[]) => void }) {
  const add = () => onChange([...items, {
    id: Date.now().toString(), name: "Guest Name", title: "Title / Role", visible: false,
  }]);

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map(lt => (
        <div key={lt.id} style={{ background: BG0, border: `1px solid ${lt.visible ? GRN : BOR}`, padding: 8 }}>
          <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
            <input value={lt.name} onChange={e => onChange(items.map(i => i.id === lt.id ? { ...i, name: e.target.value } : i))}
              style={{ ...inp, flex: 1, fontSize: 11 }} placeholder="Name" />
            <input value={lt.title} onChange={e => onChange(items.map(i => i.id === lt.id ? { ...i, title: e.target.value } : i))}
              style={{ ...inp, flex: 1.5, fontSize: 11 }} placeholder="Title" />
          </div>
          <div style={{ display: "flex", gap: 5 }}>
            <button
              onClick={() => onChange(items.map(i => i.id === lt.id ? { ...i, visible: !i.visible } : i))}
              style={{ ...btn(lt.visible, GRN), flex: 1 }}
            >
              {lt.visible ? "Live" : "Off"}
            </button>
            <button onClick={() => onChange(items.filter(i => i.id !== lt.id))}
              style={{ ...btn(false, RED), color: RED }}>×</button>
          </div>
        </div>
      ))}
      <button onClick={add} style={{ ...btn(), width: "100%", padding: "6px 0", borderStyle: "dashed" }}>
        + Add Lower Third
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// RTMPPanel
// ─────────────────────────────────────────────────────────────

function RTMPPanel({ stream, isStreaming, onStreamingChange, bitrateKbps }: {
  stream: MediaStream | null;
  isStreaming: boolean;
  onStreamingChange: (v: boolean) => void;
  bitrateKbps: number;
}) {
  const [dests, setDests]   = useState<RtmpDest[]>([]);
  const [selId, setSelId]   = useState<number | null>(null);
  const [name, setName]     = useState("");
  const [url, setUrl]       = useState("");
  const [key, setKey]       = useState("");
  const [error, setError]   = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  const load = useCallback(async () => {
    const rows = await invoke("studio:rtmp:list");
    setDests(rows || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectDest = (d: RtmpDest) => { setSelId(d.id); setName(d.name); setUrl(d.url); setKey(d.stream_key); };
  const clearForm  = () => { setSelId(null); setName(""); setUrl(""); setKey(""); };

  const save = async () => {
    if (!name || !url) return;
    await invoke("studio:rtmp:save", { id: selId, name, url, key });
    await load(); clearForm();
  };

  const del = async () => {
    if (!selId) return;
    await invoke("studio:rtmp:delete", selId);
    await load(); clearForm();
  };

  const startStream = async () => {
    if (!url) { setError("Enter an RTMP URL"); return; }
    if (!stream) { setError("No camera stream — open camera first"); return; }
    const res = await invoke("studio:rtmp:start", { url, key });
    if (!res?.ok) { setError(res?.error || "Failed to start ffmpeg"); return; }
    setError(null);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus" : "video/webm";
    const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrateKbps * 1000 });
    recorderRef.current = mr;
    mr.ondataavailable = async (e) => {
      if (e.data.size > 0) invoke("studio:rtmp:chunk", await e.data.arrayBuffer());
    };
    mr.start(250);
    onStreamingChange(true);
  };

  const stopStream = async () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    await invoke("studio:rtmp:stop");
    onStreamingChange(false);
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Saved destinations */}
      {dests.length > 0 && (
        <div>
          <div style={label}>Saved Destinations</div>
          {dests.map(d => (
            <div key={d.id} onClick={() => selectDest(d)} style={{
              padding: "5px 8px", cursor: "pointer", fontSize: 11, marginBottom: 2,
              background: selId === d.id ? PUR : BG2,
              color: selId === d.id ? "#fff" : TXT,
              border: `1px solid ${selId === d.id ? PUR : BOR}`,
            }}>{d.name}</div>
          ))}
        </div>
      )}

      <div>
        <div style={label}>Destination Name</div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. YouTube" style={inp} />
      </div>
      <div>
        <div style={label}>RTMP URL</div>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="rtmp://a.rtmp.youtube.com/live2" style={{ ...inp, fontFamily: "monospace" }} />
      </div>
      <div>
        <div style={label}>Stream Key</div>
        <input value={key} onChange={e => setKey(e.target.value)} type="password" placeholder="••••••••" style={{ ...inp, fontFamily: "monospace" }} />
      </div>

      <div style={{ display: "flex", gap: 5 }}>
        <button onClick={save} disabled={!name || !url} style={{ ...btn(), flex: 1 }}>Save</button>
        {selId && <button onClick={del} style={{ ...btn(false, RED), color: RED }}>Delete</button>}
        {selId && <button onClick={clearForm} style={btn()}>New</button>}
      </div>

      {error && <div style={{ fontSize: 10, color: RED }}>{error}</div>}

      <button
        onClick={isStreaming ? stopStream : startStream}
        style={{ ...btn(isStreaming, isStreaming ? RED : GRN), width: "100%", padding: "8px 0", fontSize: 11, marginTop: 4 }}
      >
        {isStreaming ? "Stop Stream" : "Go Live — RTMP"}
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// QualityPanel
// ─────────────────────────────────────────────────────────────

function QualityPanel({ resolution, setResolution, bitrate, setBitrate, stream }: {
  resolution: ResKey; setResolution: (v: ResKey) => void;
  bitrate: BrKey;   setBitrate:    (v: BrKey)  => void;
  stream: MediaStream | null;
}) {
  const [caps, setCaps] = useState<{ maxW: number; maxH: number } | null>(null);

  useEffect(() => {
    if (!stream) { setCaps(null); return; }
    const vt = stream.getVideoTracks()[0];
    if (!vt) return;
    try {
      const c = (vt as any).getCapabilities?.();
      if (c?.width?.max) setCaps({ maxW: c.width.max, maxH: c.height?.max ?? 0 });
    } catch {}
  }, [stream]);

  const support = (r: ResKey): "yes" | "no" | "unknown" => {
    if (!caps) return "unknown";
    return caps.maxW >= RES[r].w && caps.maxH >= RES[r].h ? "yes" : "no";
  };

  const rowStyle = (active: boolean): React.CSSProperties => ({
    width: "100%", marginBottom: 3, padding: "6px 8px",
    background: active ? PUR : BG2,
    border: `1px solid ${active ? PUR : BOR}`,
    color: active ? "#fff" : TXT,
    fontSize: 10, fontWeight: active ? 700 : 400,
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between",
    textAlign: "left" as const,
  });

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
      <div>
        <div style={label}>Resolution</div>
        {(Object.keys(RES) as ResKey[]).map(r => {
          const sup = support(r);
          return (
            <button key={r} onClick={() => setResolution(r)} style={rowStyle(resolution === r)}>
              <div>
                <span style={{ fontWeight: 700 }}>{RES[r].label}</span>
                <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 9 }}>{RES[r].desc}</span>
              </div>
              {sup === "yes"     && <span style={{ color: "#22c55e", fontSize: 10 }}>✓</span>}
              {sup === "no"      && <span style={{ color: AMB,       fontSize: 10 }}>⚠</span>}
            </button>
          );
        })}
      </div>
      <div>
        <div style={label}>Bitrate</div>
        {(Object.keys(BITRATES) as BrKey[]).map(b => (
          <button key={b} onClick={() => setBitrate(b)} style={rowStyle(bitrate === b)}>
            <div>
              <span style={{ fontWeight: 700 }}>{BITRATES[b].label}</span>
              <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 9 }}>{BITRATES[b].desc}</span>
            </div>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 9, color: TXT2, lineHeight: 1.5, borderTop: `1px solid ${BOR}`, paddingTop: 10 }}>
        Resolution restarts the camera stream. Bitrate applies to recording and RTMP output.
        Ultra bitrate is recommended for local recording only.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// StatusBar
// ─────────────────────────────────────────────────────────────

function StatusBar({ isRecording, isStreaming, guestCount, hostLevel, onToggleRecord, stream }: {
  isRecording: boolean;
  isStreaming: boolean;
  guestCount: number;
  hostLevel: number;
  onToggleRecord: () => void;
  stream: MediaStream | null;
}) {
  const [secs, setSecs] = useState(0);
  const ref = useRef<any>(null);

  useEffect(() => {
    if (isRecording) {
      setSecs(0);
      ref.current = setInterval(() => setSecs(s => s + 1), 1000);
    } else {
      clearInterval(ref.current); setSecs(0);
    }
    return () => clearInterval(ref.current);
  }, [isRecording]);

  const fmt = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
      : `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  };

  return (
    <div style={{ height: 38, display: "flex", alignItems: "center", gap: 12, padding: "0 14px", background: BG1, borderTop: `1px solid ${BOR}`, flexShrink: 0 }}>
      {/* LIVE dot */}
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <div style={{
          width: 7, height: 7, borderRadius: "50%",
          background: isStreaming ? RED : BG3,
          boxShadow: isStreaming ? `0 0 8px ${RED}` : "none",
        }} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", color: isStreaming ? RED : TXT2 }}>
          {isStreaming ? "LIVE" : "OFFLINE"}
        </span>
      </div>

      <div style={{ width: 1, height: 14, background: BOR }} />

      {/* Record */}
      <button
        onClick={onToggleRecord}
        disabled={!stream}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "3px 10px", border: "none", cursor: stream ? "pointer" : "not-allowed",
          background: isRecording ? RED : BG2,
          color: isRecording ? "#fff" : TXT2,
          fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
        }}
      >
        <div style={{ width: 7, height: 7, borderRadius: isRecording ? 0 : "50%", background: "currentColor" }} />
        {isRecording ? `REC  ${fmt(secs)}` : "Record"}
      </button>

      <div style={{ flex: 1 }} />

      {/* Host audio level */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 9, color: TXT2, letterSpacing: "0.06em" }}>HOST</span>
        <div style={{ width: 60, height: 4, background: BG0 }}>
          <div style={{ height: "100%", width: `${Math.min(hostLevel * 100, 100)}%`, background: hostLevel > 0.85 ? RED : hostLevel > 0.6 ? AMB : GRN, transition: "width 0.05s" }} />
        </div>
      </div>

      <div style={{ width: 1, height: 14, background: BOR }} />

      {/* Guests */}
      <span style={{ fontSize: 10, color: TXT2 }}>
        {guestCount} guest{guestCount !== 1 ? "s" : ""}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// EmbeddedStudio — 16:9 camera + tabbed controls below
// Used when VideoStudio deck is shown inline in the deck area.
// ─────────────────────────────────────────────────────────────

type EmbedTab = "chat" | "guests" | "script" | "settings";

function EmbeddedStudio({
  hostStream, setHostStream,
  lowerThirds,
  resolution, setResolution,
  bitrate, setBitrate,
  isRecording, isStreaming, setIsStreaming,
  showGrid, setShowGrid,
  teleScript, setTeleScript, teleScrollRef,
  hostLevel,
  toggleRecord,
  guests, removeGuest, toggleMute,
  guestsEnabled, setGuestsEnabled,
}: {
  hostStream: MediaStream | null; setHostStream: (s: MediaStream | null) => void;
  lowerThirds: LowerThird[];
  resolution: ResKey; setResolution: (v: ResKey) => void;
  bitrate: BrKey; setBitrate: (v: BrKey) => void;
  isRecording: boolean; isStreaming: boolean; setIsStreaming: (v: boolean) => void;
  showGrid: boolean; setShowGrid: (fn: (v: boolean) => boolean) => void;
  teleScript: string; setTeleScript: (v: string) => void;
  teleScrollRef: React.RefObject<HTMLDivElement>;
  hostLevel: number;
  toggleRecord: () => void;
  guests: GuestPeer[]; removeGuest: (id: string) => void; toggleMute: (id: string) => void;
  guestsEnabled: boolean; setGuestsEnabled: (fn: (v: boolean) => boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<EmbedTab>("script");
  const [teleOverlay, setTeleOverlay] = useState(false);
  const [teleSpeed, setTeleSpeed] = useState(14); // px/s
  const [teleFontSize, setTeleFontSize] = useState(22);
  const [rtmpUrl, setRtmpUrl] = useState("");
  const [streamKey, setStreamKey] = useState("");

  // Load RTMP settings
  useEffect(() => {
    dbQuery<{ key: string; value: string }>(
      "SELECT key, value FROM station_config_kv WHERE key IN ('studio_rtmp_url','studio_stream_key')"
    ).then(rows => {
      rows.forEach(r => {
        if (r.key === "studio_rtmp_url") setRtmpUrl(r.value);
        if (r.key === "studio_stream_key") setStreamKey(r.value);
      });
    }).catch(() => {});
  }, []);

  const saveRtmp = () => {
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_rtmp_url',?)", [rtmpUrl]).catch(() => {});
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_stream_key',?)", [streamKey]).catch(() => {});
  };

  const TABS: Array<{ id: EmbedTab; label: string }> = [
    { id: "chat",     label: "Chat" },
    { id: "guests",   label: "Guests" },
    { id: "script",   label: "Script" },
    { id: "settings", label: "Settings" },
  ];

  const inviteUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/guest?room=studio`;
  const copyInvite = () => { try { navigator.clipboard.writeText(inviteUrl); } catch {} };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: BG1, overflow: "hidden" }}>

      {/* Header controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderBottom: `1px solid ${BOR}`, flexShrink: 0, background: BG0 }}>
        <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: "0.14em", color: "#4040a0", textTransform: "uppercase" as const }}>Video Studio</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowGrid(g => !g)} style={{
          padding: "2px 7px", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
          background: showGrid ? "rgba(64,64,160,0.3)" : "transparent",
          border: `1px solid ${showGrid ? "#4040a0" : BOR}`,
          color: showGrid ? "#8080d0" : TXT2, cursor: "pointer",
        }}>Grid</button>
        <button onClick={toggleRecord} disabled={!hostStream} style={{
          padding: "2px 8px", fontSize: 9, fontWeight: 700,
          background: isRecording ? RED : "transparent",
          border: `1px solid ${isRecording ? RED : BOR}`,
          color: isRecording ? "#fff" : TXT2, cursor: "pointer",
        }}>{isRecording ? "■ Stop" : "⏺ Rec"}</button>
        <button onClick={() => setIsStreaming(!isStreaming)} style={{
          padding: "2px 8px", fontSize: 9, fontWeight: 700,
          background: isStreaming ? "#22c55e" : "transparent",
          border: `1px solid ${isStreaming ? "#22c55e" : BOR}`,
          color: isStreaming ? "#fff" : TXT2, cursor: "pointer",
        }}>{isStreaming ? "● Live" : "Go Live"}</button>
      </div>

      {/* 16:9 camera — locked aspect ratio, width-driven */}
      <div style={{ width: "100%", aspectRatio: "16/9", flexShrink: 0, position: "relative", background: "#0a0a10" }}>
        <HostCamera
          onStream={setHostStream}
          lowerThirds={lowerThirds}
          teleMode={teleOverlay ? "overlay" : "off"}
          teleOpacity={0.82}
          teleScript={teleScript}
          teleFontSize={teleFontSize}
          teleScrolling={false}
          teleScrollRef={teleScrollRef}
          resolution={resolution}
          isRecording={isRecording}
          showGrid={showGrid}
          showFrameOverlays
        />
        <LevelBar level={hostLevel} height={3} />
      </div>

      {/* Tab strip */}
      <div style={{ display: "flex", borderBottom: `1px solid ${BOR}`, flexShrink: 0, background: BG0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            flex: 1, padding: "5px 0", border: "none", cursor: "pointer",
            fontSize: 9, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase" as const,
            background: "none",
            color: activeTab === t.id ? "#00c8a8" : TXT2,
            borderBottom: `2px solid ${activeTab === t.id ? "#00c8a8" : "transparent"}`,
          }}>{t.label}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, background: BG1 }}>

        {/* CHAT */}
        {activeTab === "chat" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
            {isStreaming ? (
              <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
                <div style={{ flex: 1, background: "#060608", border: `1px solid ${BOR}`, padding: "6px 8px", overflowY: "auto", fontSize: 10, color: "#808090" }}>
                  <div style={{ color: TXT2, fontStyle: "italic" }}>Chat connected — messages will appear here.</div>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: "center" as const, color: TXT2, fontSize: 11, lineHeight: 1.7 }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: 8, opacity: 0.3 }}><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                <div>Chat will appear here</div>
                <div style={{ fontSize: 10, marginTop: 4, color: "#404050" }}>when you go live.</div>
              </div>
            )}
          </div>
        )}

        {/* GUESTS */}
        {activeTab === "guests" && (
          <div style={{ padding: "10px 12px" }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center" }}>
              <button onClick={copyInvite} style={{
                padding: "4px 12px", fontSize: 9, fontWeight: 700, background: "#6040c0", border: "none",
                color: "#fff", cursor: "pointer", letterSpacing: "0.06em",
              }}>Invite Guest</button>
              <button onClick={() => setGuestsEnabled(v => !v)} style={{
                padding: "4px 10px", fontSize: 9, background: "transparent", border: `1px solid ${BOR}`,
                color: guestsEnabled ? "#22c55e" : TXT2, cursor: "pointer",
              }}>{guestsEnabled ? "● Guests On" : "Guests Off"}</button>
            </div>
            {guests.length === 0 ? (
              <div style={{ textAlign: "center" as const, color: TXT2, fontSize: 10, padding: "20px 0", lineHeight: 1.8 }}>
                No guests connected<br />
                <span style={{ fontSize: 9, color: "#404050" }}>Click Invite to add someone.</span>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {guests.map(g => (
                  <div key={g.id} style={{ background: BG0, border: `1px solid ${BOR}`, padding: 6 }}>
                    {g.stream ? (
                      <video
                        ref={el => { if (el) el.srcObject = g.stream; }}
                        autoPlay playsInline muted
                        style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", display: "block", background: "#0a0a10" }}
                      />
                    ) : (
                      <div style={{ width: "100%", aspectRatio: "4/3", background: "#0a0a10", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ fontSize: 10, color: "#303040" }}>No video</span>
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
                      <span style={{ flex: 1, fontSize: 9, color: TXT2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{g.name}</span>
                      <button onClick={() => toggleMute(g.id)} style={{ padding: "1px 5px", fontSize: 8, background: "none", border: `1px solid ${BOR}`, color: g.muted ? AMB : TXT2, cursor: "pointer" }}>{g.muted ? "Unmute" : "Mute"}</button>
                      <button onClick={() => removeGuest(g.id)} style={{ padding: "1px 5px", fontSize: 8, background: "none", border: `1px solid ${BOR}`, color: RED, cursor: "pointer" }}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* SCRIPT / TELEPROMPTER */}
        {activeTab === "script" && (
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea
              value={teleScript}
              onChange={e => setTeleScript(e.target.value)}
              placeholder="Paste or type your script here…"
              rows={6}
              style={{
                width: "100%", padding: "8px 10px", background: BG0,
                border: `1px solid ${BOR}`, color: TXT, fontSize: 11,
                lineHeight: 1.6, resize: "vertical" as const, outline: "none",
                fontFamily: "'Inter', system-ui, sans-serif",
              }}
            />
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={label}>Speed</span>
              <input type="range" min={4} max={40} step={2} value={teleSpeed}
                onChange={e => setTeleSpeed(Number(e.target.value))}
                style={{ flex: 1, accentColor: "#00c8a8", height: 3 }} />
              <span style={{ fontSize: 9, color: TXT2, width: 28, textAlign: "right" as const }}>{teleSpeed}px</span>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={label}>Font</span>
              <input type="range" min={14} max={48} step={2} value={teleFontSize}
                onChange={e => setTeleFontSize(Number(e.target.value))}
                style={{ flex: 1, accentColor: "#00c8a8", height: 3 }} />
              <span style={{ fontSize: 9, color: TXT2, width: 28, textAlign: "right" as const }}>{teleFontSize}px</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => setTeleOverlay(v => !v)}
                style={{
                  padding: "4px 12px", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
                  background: teleOverlay ? "#6040c0" : "transparent",
                  border: `1px solid ${teleOverlay ? "#6040c0" : BOR}`,
                  color: teleOverlay ? "#fff" : TXT2, cursor: "pointer",
                }}
              >{teleOverlay ? "● Overlay On" : "Overlay Off"}</button>
              <span style={{ fontSize: 9, color: "#404050" }}>Script scrolls over camera</span>
            </div>
          </div>
        )}

        {/* SETTINGS */}
        {activeTab === "settings" && (
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <div style={label}>Resolution</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(Object.keys(RES) as ResKey[]).map(k => (
                  <button key={k} onClick={() => setResolution(k)} style={{
                    flex: 1, padding: "4px 0", fontSize: 9, fontWeight: 700,
                    background: resolution === k ? "#6040c0" : "transparent",
                    border: `1px solid ${resolution === k ? "#6040c0" : BOR}`,
                    color: resolution === k ? "#fff" : TXT2, cursor: "pointer",
                  }}>{RES[k].label}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={label}>Bitrate</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(Object.keys(BITRATES) as BrKey[]).map(k => (
                  <button key={k} onClick={() => setBitrate(k)} style={{
                    flex: 1, padding: "4px 0", fontSize: 9, fontWeight: 700,
                    background: bitrate === k ? "#6040c0" : "transparent",
                    border: `1px solid ${bitrate === k ? "#6040c0" : BOR}`,
                    color: bitrate === k ? "#fff" : TXT2, cursor: "pointer",
                  }}>{BITRATES[k].label}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={label}>RTMP Destination</div>
              <input
                value={rtmpUrl} onChange={e => setRtmpUrl(e.target.value)} onBlur={saveRtmp}
                placeholder="rtmp://live.youtube.com/live2"
                style={{ ...inp, marginBottom: 4 }}
              />
              <input
                value={streamKey} onChange={e => setStreamKey(e.target.value)} onBlur={saveRtmp}
                placeholder="Stream key"
                type="password"
                style={{ ...inp }}
              />
            </div>
            <button onClick={() => {}} style={{
              padding: "5px 14px", fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
              background: "transparent", border: `1px solid ${BOR}`, color: TXT2, cursor: "pointer",
            }}>Test Stream</button>
          </div>
        )}
      </div>

      <style>{`@keyframes rec-pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Studio — main export
// ─────────────────────────────────────────────────────────────

type RightTab = "guests" | "tele" | "lower" | "rtmp" | "quality";

export default function Studio({ embedded }: { embedded?: boolean } = {}) {
  const [hostStream, setHostStream]       = useState<MediaStream | null>(null);
  const [guestsEnabled, setGuestsEnabled] = useState(false);
  const [lowerThirds, setLowerThirds]     = useState<LowerThird[]>([]);
  const [rightTab, setRightTab]           = useState<RightTab>("guests");
  const [isStreaming, setIsStreaming]     = useState(false);
  const [isRecording, setIsRecording]     = useState(false);
  const [showGrid, setShowGrid]           = useState(false);

  const { resolution, setResolution, bitrate, setBitrate, bitrateKbps } = useVideoQuality();

  // Teleprompter
  const [teleMode, setTeleMode]           = useState<TeleMode>("off");
  const [teleSpeed, setTeleSpeed]         = useState<TeleSpeed>("medium");
  const [teleOpacity, setTeleOpacity]     = useState(0.5);
  const [teleFontSize, setTeleFontSize]   = useState(28);
  const [teleScript, setTeleScript]       = useState("");
  const [teleScrolling, setTeleScrolling] = useState(false);
  const teleScrollRef = useRef<HTMLDivElement>(null);

  const hostLevel = useLevelMeter(hostStream);

  const { guests, removeGuest, toggleMute } = useWebRTCGuests(guestsEnabled);

  // Auto-scroll teleprompter
  useEffect(() => {
    if (!teleScrolling) return;
    const px = teleSpeed === "slow" ? 0.6 : teleSpeed === "medium" ? 1.4 : 2.8;
    const id = setInterval(() => {
      if (teleScrollRef.current) teleScrollRef.current.scrollTop += px;
    }, 16);
    return () => clearInterval(id);
  }, [teleScrolling, teleSpeed]);

  // Stop streaming when ffmpeg exits
  useEffect(() => {
    const h = ipcOn("studio:rtmp:stopped", () => setIsStreaming(false));
    return () => ipcOff("studio:rtmp:stopped", h);
  }, []);

  // Recording
  const recorderRef = useRef<MediaRecorder | null>(null);

  const toggleRecord = useCallback(async () => {
    if (!hostStream) return;
    if (isRecording) {
      recorderRef.current?.stop();
      recorderRef.current = null;
      await invoke("studio:record:stop");
      setIsRecording(false);
      return;
    }
    const filePath = await (window as any).ether.dialog.saveFile({
      defaultPath: `studio-${Date.now()}.webm`,
      filters: [{ name: "WebM Video", extensions: ["webm"] }],
    });
    if (!filePath) return;
    const res = await invoke("studio:record:start", filePath);
    if (!res?.ok) return;
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus" : "video/webm";
    const mr = new MediaRecorder(hostStream, { mimeType, videoBitsPerSecond: bitrateKbps * 1000 });
    recorderRef.current = mr;
    mr.ondataavailable = async (e) => {
      if (e.data.size > 0) invoke("studio:record:chunk", await e.data.arrayBuffer());
    };
    mr.onstop = () => setIsRecording(false);
    mr.start(500);
    setIsRecording(true);
  }, [hostStream, isRecording]);

  const tab = (t: RightTab, lbl: string) => (
    <button
      onClick={() => setRightTab(t)}
      style={{
        flex: 1, padding: "7px 0", border: "none", cursor: "pointer",
        fontSize: 9, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase" as const,
        background: rightTab === t ? BG1 : BG2,
        color: rightTab === t ? TXT : TXT2,
        borderBottom: `2px solid ${rightTab === t ? PUR : "transparent"}`,
      }}
    >{lbl}</button>
  );

  // ── Embedded deck mode — 16:9 camera + tabbed controls below ───
  if (embedded) {
    return (
      <EmbeddedStudio
        hostStream={hostStream} setHostStream={setHostStream}
        lowerThirds={lowerThirds}
        resolution={resolution} setResolution={setResolution}
        bitrate={bitrate} setBitrate={setBitrate}
        isRecording={isRecording} isStreaming={isStreaming}
        setIsStreaming={setIsStreaming}
        showGrid={showGrid} setShowGrid={setShowGrid}
        teleScript={teleScript} setTeleScript={setTeleScript}
        teleScrollRef={teleScrollRef}
        hostLevel={hostLevel}
        toggleRecord={toggleRecord}
        guests={guests} removeGuest={removeGuest} toggleMute={toggleMute}
        guestsEnabled={guestsEnabled} setGuestsEnabled={setGuestsEnabled}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: BG1, overflow: "hidden" }}>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>

        {/* ── Left: camera + teleprompter sidebar ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

          {/* Camera + sidebar teleprompter */}
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <HostCamera
              onStream={setHostStream}
              lowerThirds={lowerThirds}
              teleMode={teleMode}
              teleOpacity={teleOpacity}
              teleScript={teleScript}
              teleFontSize={teleFontSize}
              teleScrolling={teleScrolling}
              teleScrollRef={teleScrollRef}
              resolution={resolution}
              isRecording={isRecording}
              showGrid={showGrid}
              showFrameOverlays={!!embedded}
            />

            {/* Sidebar teleprompter */}
            {teleMode === "sidebar" && teleScript && (
              <div style={{ width: 260, background: BG0, borderLeft: `1px solid ${BOR}`, display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "6px 10px", borderBottom: `1px solid ${BOR}`, fontSize: 9, fontWeight: 700, color: TXT2, letterSpacing: "0.08em" }}>
                  TELEPROMPTER
                </div>
                <div
                  ref={teleScrollRef}
                  style={{
                    flex: 1, overflowY: "hidden", padding: "16px 14px",
                    color: "#fff", fontSize: teleFontSize, fontWeight: 600,
                    lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    userSelect: "none",
                  }}
                >
                  {teleScript}
                </div>
                {/* Position indicator */}
                <div style={{ height: 3, background: BG3, flexShrink: 0 }}>
                  <div style={{ height: "100%", width: "30%", background: PUR }} />
                </div>
              </div>
            )}
          </div>

          {/* Level bar under camera */}
          <LevelBar level={hostLevel} height={5} />
        </div>

        {/* ── Right sidebar ── */}
        <div style={{ width: 250, display: "flex", flexDirection: "column", borderLeft: `1px solid ${BOR}`, background: BG2, overflow: "hidden" }}>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: `1px solid ${BOR}`, flexShrink: 0, background: BG2 }}>
            {tab("guests",  "Guests")}
            {tab("tele",    "Script")}
            {tab("lower",   "L3rds")}
            {tab("rtmp",    "RTMP")}
            {tab("quality", "Quality")}
          </div>

          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {rightTab === "guests" && (
              <GuestSidebar
                guests={guests}
                enabled={guestsEnabled}
                onToggle={() => setGuestsEnabled(v => !v)}
                onMute={toggleMute}
                onRemove={removeGuest}
              />
            )}
            {rightTab === "tele" && (
              <TeleprompterPanel
                script={teleScript} setScript={setTeleScript}
                mode={teleMode} setMode={setTeleMode}
                speed={teleSpeed} setSpeed={setTeleSpeed}
                opacity={teleOpacity} setOpacity={setTeleOpacity}
                fontSize={teleFontSize} setFontSize={setTeleFontSize}
                scrolling={teleScrolling} setScrolling={setTeleScrolling}
                scrollRef={teleScrollRef}
              />
            )}
            {rightTab === "lower" && (
              <LowerThirdsPanel items={lowerThirds} onChange={setLowerThirds} />
            )}
            {rightTab === "rtmp" && (
              <RTMPPanel
                stream={hostStream}
                isStreaming={isStreaming}
                onStreamingChange={setIsStreaming}
                bitrateKbps={bitrateKbps}
              />
            )}
            {rightTab === "quality" && (
              <QualityPanel
                resolution={resolution} setResolution={setResolution}
                bitrate={bitrate}       setBitrate={setBitrate}
                stream={hostStream}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Status bar ── */}
      <StatusBar
        isRecording={isRecording}
        isStreaming={isStreaming}
        guestCount={guests.length}
        hostLevel={hostLevel}
        onToggleRecord={toggleRecord}
        stream={hostStream}
      />
      <style>{`
        @keyframes rec-pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }
      `}</style>
    </div>
  );
}
