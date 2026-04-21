// src/components/Studio.tsx
// Video podcast recording & streaming studio.
// Dark steel aesthetic: #111114 backgrounds, sharp edges, zero border-radius.

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import { query as dbQuery, execute as dbExec } from "../db/client";
import { VideoEngineProvider, useVideoEngine } from "./VideoEngine/VideoEngineContext";
import VideoEngineCanvas from "./VideoEngine/VideoEngineCanvas";
import VideoEnginePanel  from "./VideoEngine/VideoEnginePanel";

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
  conn: RTCPeerConnection | null;
  muted: boolean;
  status: "pending" | "accepted" | "denied";
  offer?: any;
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

interface MultiRtmpDest {
  id: string;
  name: string;
  url: string;
  key: string;
  enabled: boolean;
  status: "idle" | "live" | "error";
  error?: string;
}

interface Scene {
  id: string;
  name: string;
  lowerThirds: LowerThird[];
  layout: "camera-only" | "side-by-side" | "pip" | "screen-only";
}

interface ScreenSource {
  id: string;
  label: string;
  stream: MediaStream;
}

interface BrandKit {
  logoDataUrl: string | null;
  accentColor: string;
  ltBgColor: string;
  ltTextColor: string;
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
// useScenes
// ─────────────────────────────────────────────────────────────

const DEFAULT_SCENE: Scene = { id: "main", name: "Main", lowerThirds: [], layout: "camera-only" };

function useScenes() {
  const [scenes, setScenes] = useState<Scene[]>([DEFAULT_SCENE]);
  const [activeId, setActiveId] = useState("main");

  useEffect(() => {
    dbQuery<{ value: string }>("SELECT value FROM station_config_kv WHERE key='studio_scenes'")
      .then(rows => {
        if (rows[0]) {
          const saved = JSON.parse(rows[0].value);
          if (Array.isArray(saved) && saved.length > 0) setScenes(saved);
        }
      }).catch(() => {});
  }, []);

  const persist = useCallback((s: Scene[]) => {
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_scenes',?)", [JSON.stringify(s)]).catch(() => {});
  }, []);

  const addScene = useCallback(() => {
    setScenes(prev => {
      const id = Date.now().toString();
      const s: Scene = { id, name: `Scene ${prev.length + 1}`, lowerThirds: [], layout: "camera-only" };
      const next = [...prev, s];
      persist(next);
      setActiveId(id);
      return next;
    });
  }, [persist]);

  const renameScene = useCallback((id: string, name: string) => {
    const next = scenes.map(s => s.id === id ? { ...s, name } : s);
    setScenes(next); persist(next);
  }, [scenes, persist]);

  const deleteScene = useCallback((id: string) => {
    setScenes(prev => {
      if (prev.length <= 1) return prev;
      const next = prev.filter(s => s.id !== id);
      persist(next);
      setActiveId(cur => cur === id ? next[0].id : cur);
      return next;
    });
  }, [persist]);

  const updateScene = useCallback((id: string, patch: Partial<Scene>) => {
    const next = scenes.map(s => s.id === id ? { ...s, ...patch } : s);
    setScenes(next); persist(next);
  }, [scenes, persist]);

  const active = scenes.find(s => s.id === activeId) || scenes[0];

  return { scenes, active, activeId, setActiveId, addScene, renameScene, deleteScene, updateScene };
}

// ─────────────────────────────────────────────────────────────
// useScreenShare
// ─────────────────────────────────────────────────────────────

function useScreenShare() {
  const [sources, setSources] = useState<ScreenSource[]>([]);

  const addSource = useCallback(async () => {
    try {
      const stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      const label = track?.label || "Screen";
      const id = Date.now().toString();
      setSources(prev => [...prev, { id, label, stream }]);
      track.onended = () => setSources(prev => prev.filter(s => s.id !== id));
    } catch {}
  }, []);

  const removeSource = useCallback((id: string) => {
    setSources(prev => {
      const src = prev.find(s => s.id === id);
      src?.stream.getTracks().forEach(t => t.stop());
      return prev.filter(s => s.id !== id);
    });
  }, []);

  return { sources, addSource, removeSource };
}

// ─────────────────────────────────────────────────────────────
// useClipBuffer — rolling 30s buffer
// ─────────────────────────────────────────────────────────────

function useClipBuffer(stream: MediaStream | null, seconds = 30) {
  const chunksRef = useRef<{ data: ArrayBuffer; ts: number }[]>([]);
  const recRef    = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (!stream) return;
    if (!MediaRecorder.isTypeSupported("video/webm")) return;
    const mr = new MediaRecorder(stream, { mimeType: "video/webm" });
    recRef.current = mr;
    mr.ondataavailable = async (e) => {
      if (e.data.size === 0) return;
      const now = Date.now();
      chunksRef.current.push({ data: await e.data.arrayBuffer(), ts: now });
      // Prune chunks older than window
      const cutoff = now - seconds * 1000;
      chunksRef.current = chunksRef.current.filter(c => c.ts >= cutoff);
    };
    mr.start(1000);
    return () => { try { mr.stop(); } catch {} recRef.current = null; };
  }, [stream, seconds]);

  const saveClip = useCallback(async () => {
    if (chunksRef.current.length === 0) return;
    const blobs = chunksRef.current.map(c => new Uint8Array(c.data));
    const blob = new Blob(blobs, { type: "video/webm" });
    const buf = await blob.arrayBuffer();
    const defaultPath = `clip-${new Date().toISOString().replace(/[:.]/g,"-")}.webm`;
    const fp = await (window as any).ether.dialog.saveFile({
      defaultPath,
      filters: [{ name: "WebM Video", extensions: ["webm"] }],
    });
    if (fp) await invoke("studio:record:saveClip", { path: fp, data: buf });
  }, []);

  return { saveClip };
}

// ─────────────────────────────────────────────────────────────
// useSmartCut — auto-switch to loudest speaker
// ─────────────────────────────────────────────────────────────

function useSmartCut(sources: { id: string; stream: MediaStream | null }[], enabled: boolean) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const ctxRef      = useRef<AudioContext | null>(null);
  const analyzersRef = useRef<Map<string, AnalyserNode>>(new Map());
  const rafRef      = useRef<number>(0);

  useEffect(() => {
    if (!enabled) { cancelAnimationFrame(rafRef.current); setActiveId(null); return; }
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    analyzersRef.current.clear();

    for (const src of sources) {
      if (!src.stream) continue;
      try {
        const node = ctx.createMediaStreamSource(src.stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        node.connect(analyser);
        analyzersRef.current.set(src.id, analyser);
      } catch {}
    }

    const buf = new Uint8Array(128);
    const tick = () => {
      let bestId: string | null = null, bestLevel = 0;
      analyzersRef.current.forEach((analyser, id) => {
        analyser.getByteFrequencyData(buf);
        const level = buf.reduce((a, b) => a + b, 0) / buf.length;
        if (level > bestLevel) { bestLevel = level; bestId = id; }
      });
      if (bestLevel > 5) setActiveId(bestId);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(rafRef.current);
      ctx.close().catch(() => {});
    };
  }, [enabled, sources]);

  return activeId;
}

// ─────────────────────────────────────────────────────────────
// useBrandKit
// ─────────────────────────────────────────────────────────────

const DEFAULT_BRAND: BrandKit = {
  logoDataUrl: null,
  accentColor: "#7858c8",
  ltBgColor: "rgba(0,0,0,0.75)",
  ltTextColor: "#ffffff",
};

function useBrandKit(): [BrandKit, (k: BrandKit) => void] {
  const [kit, setKit] = useState<BrandKit>(DEFAULT_BRAND);

  useEffect(() => {
    dbQuery<{ value: string }>("SELECT value FROM station_config_kv WHERE key='studio_brand_kit'")
      .then(rows => { if (rows[0]) setKit({ ...DEFAULT_BRAND, ...JSON.parse(rows[0].value) }); })
      .catch(() => {});
  }, []);

  const update = useCallback((k: BrandKit) => {
    setKit(k);
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_brand_kit',?)", [JSON.stringify(k)]).catch(() => {});
  }, []);

  return [kit, update];
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
  fontSize: 12, fontWeight: 700, letterSpacing: "0.07em", cursor: "pointer",
  textTransform: "uppercase" as const,
});

const label: React.CSSProperties = {
  fontSize: 13, fontWeight: 700, letterSpacing: "0.1em",
  textTransform: "uppercase" as const, color: TXT2, marginBottom: 4,
};

const inp: React.CSSProperties = {
  width: "100%", padding: "5px 8px",
  background: BG0, border: `1px solid ${BOR}`,
  color: TXT, fontSize: 13, outline: "none",
};

// ─────────────────────────────────────────────────────────────
// useWebRTCGuests
// ─────────────────────────────────────────────────────────────

function useWebRTCGuests(enabled: boolean) {
  const [guests, setGuests] = useState<GuestPeer[]>([]);
  const wsRef    = useRef<WebSocket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    let ws: WebSocket;
    try { ws = new WebSocket("ws://localhost:9091/signal?role=host"); }
    catch { return; }
    wsRef.current = ws;

    ws.onopen = () => console.log("[STUDIO-HOST] WebSocket connected");

    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const { from, type, payload, name } = msg;

        if (type === "offer") {
          setGuests(prev => prev.find(g => g.id === from) ? prev : [
            ...prev, { id: from, name: name || `Guest ${prev.length + 1}`, stream: null, conn: null, muted: false, status: "pending", offer: payload },
          ]);
        } else if (type === "ice") {
          const pc = peersRef.current.get(from);
          if (pc && payload) try { await pc.addIceCandidate(payload); } catch {}
        } else if (type === "leave") {
          const pc = peersRef.current.get(from);
          if (pc) { pc.close(); peersRef.current.delete(from); }
          setGuests(prev => prev.filter(g => g.id !== from));
        }
      } catch (e) { console.error("[STUDIO-HOST] message error:", e); }
    };

    ws.onclose = () => { wsRef.current = null; };
    ws.onerror = (e) => console.error("[STUDIO-HOST] WebSocket error:", e);

    return () => {
      ws.close();
      peersRef.current.forEach(pc => pc.close());
      peersRef.current.clear();
      setGuests([]);
      wsRef.current = null;
    };
  }, [enabled]);

  const acceptGuest = useCallback(async (id: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    setGuests(prev => {
      const guest = prev.find(g => g.id === id);
      if (!guest || !guest.offer) return prev;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
      });
      peersRef.current.set(id, pc);

      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        setGuests(p => p.map(g => g.id === id ? { ...g, stream } : g));
      };
      pc.onicecandidate = (e) => {
        if (e.candidate && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ to: id, type: "ice", payload: e.candidate }));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          peersRef.current.delete(id);
          setGuests(p => p.filter(g => g.id !== id));
        }
      };

      (async () => {
        try {
          await pc.setRemoteDescription(guest.offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ to: id, type: "answer", payload: answer }));
        } catch (e) { console.error("[STUDIO-HOST] accept error:", e); }
      })();

      return prev.map(g => g.id === id ? { ...g, status: "accepted", conn: pc } : g);
    });
  }, []);

  const denyGuest = useCallback((id: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to: id, type: "denied" }));
    setGuests(prev => prev.filter(g => g.id !== id));
  }, []);

  const removeGuest = useCallback((id: string) => {
    const pc = peersRef.current.get(id);
    if (pc) { pc.close(); peersRef.current.delete(id); }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ to: id, type: "denied" }));
    setGuests(prev => prev.filter(g => g.id !== id));
  }, []);

  const toggleMute = useCallback((id: string) => {
    setGuests(prev => prev.map(g => {
      if (g.id !== id) return g;
      g.stream?.getAudioTracks().forEach(t => { t.enabled = g.muted; });
      return { ...g, muted: !g.muted };
    }));
  }, []);

  useEffect(() => {
    const slotToIndex = (slot: string) => slot.toUpperCase().charCodeAt(0) - "E".charCodeAt(0);

    const onToggle = (e: Event) => {
      const d = (e as CustomEvent).detail as { slot: string; active: boolean };
      if (!d?.slot) return;
      const idx = slotToIndex(d.slot);
      setGuests(prev => prev.map((g, i) => {
        if (i !== idx) return g;
        const muted = !d.active;
        g.stream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
        return { ...g, muted };
      }));
    };

    const onVolume = (e: Event) => {
      const d = (e as CustomEvent).detail as { slot: string; volume: number };
      if (!d?.slot) return;
      const idx = slotToIndex(d.slot);
      setGuests(prev => prev.map((g, i) => i !== idx ? g : { ...g, volume: Math.max(0, Math.min(2, d.volume)) }));
    };

    window.addEventListener("ether:guest-toggle", onToggle as EventListener);
    window.addEventListener("ether:guest-volume", onVolume as EventListener);
    return () => {
      window.removeEventListener("ether:guest-toggle", onToggle as EventListener);
      window.removeEventListener("ether:guest-volume", onVolume as EventListener);
    };
  }, []);

  return { guests, acceptGuest, denyGuest, removeGuest, toggleMute };
}

// ─────────────────────────────────────────────────────────────
// useLevelMeter
// ─────────────────────────────────────────────────────────────

function useLevelMeter(stream: MediaStream | null) {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!stream) { setLevel(0); return; }
    const ctx      = new AudioContext();
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
    return () => { cancelAnimationFrame(rafRef.current); ctx.close(); };
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
      <div style={{ height: "100%", width: `${pct}%`, background: pct > 85 ? RED : pct > 60 ? AMB : GRN, transition: "width 0.05s" }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HostCamera
// ─────────────────────────────────────────────────────────────

function HostCamera({
  onStream, lowerThirds, teleMode, teleOpacity, teleScript, teleFontSize,
  teleScrolling, teleScrollRef, resolution, isRecording, showGrid, showFrameOverlays,
  brandKit, smartCutActive,
}: {
  onStream: (s: MediaStream | null) => void;
  lowerThirds: LowerThird[];
  teleMode: TeleMode; teleOpacity: number; teleScript: string; teleFontSize: number;
  teleScrolling: boolean; teleScrollRef: React.RefObject<HTMLDivElement>;
  resolution: ResKey; isRecording?: boolean; showGrid?: boolean; showFrameOverlays?: boolean;
  brandKit?: BrandKit; smartCutActive?: boolean;
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
        s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: w }, height: { ideal: h } }, audio: true });
      } catch {
        s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true });
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

  useEffect(() => {
    start(resolution);
    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); };
  }, [resolution]); // eslint-disable-line

  const ltPos = (i: number): React.CSSProperties => ({ position: "absolute", bottom: 48 + i * 56, left: 16 });
  const frameColor = "#4040a0";
  const cornerLen = 20, cornerW = 2;
  const corners: { top?: 0; bottom?: 0; left?: 0; right?: 0 }[] = [
    { top: 0, left: 0 }, { top: 0, right: 0 }, { bottom: 0, left: 0 }, { bottom: 0, right: 0 },
  ];

  const ltAccent = brandKit?.accentColor || PUR;
  const ltBg     = brandKit?.ltBgColor   || "rgba(0,0,0,0.75)";
  const ltColor  = brandKit?.ltTextColor || "#ffffff";

  return (
    <div style={{ position: "relative", background: "#0a0a10", border: `1px solid #1a1a22`, flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* Smart cut active indicator */}
      {smartCutActive && (
        <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 10, background: "rgba(0,200,168,0.15)", border: "1px solid #00c8a8", padding: "2px 10px", fontSize: 11, fontWeight: 700, color: "#00c8a8", letterSpacing: "0.1em", pointerEvents: "none" }}>
          AI CUT
        </div>
      )}

      {/* Brand logo overlay */}
      {brandKit?.logoDataUrl && actualRes && (
        <img src={brandKit.logoDataUrl} alt="" style={{ position: "absolute", bottom: 12, right: 12, maxHeight: 48, maxWidth: 120, objectFit: "contain", opacity: 0.85, pointerEvents: "none", zIndex: 5 }} />
      )}

      {!actualRes && !error && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, pointerEvents: "none" }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2a2a50" strokeWidth="1.5" strokeLinecap="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          <span style={{ fontSize: 13, color: "#2a2a50", letterSpacing: "0.05em" }}>Camera not active</span>
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

      {actualRes && showFrameOverlays && (
        <>
          {corners.map((pos, i) => (
            <div key={i} style={{ position: "absolute", ...pos, width: cornerLen, height: cornerLen, pointerEvents: "none" }}>
              <div style={{ position: "absolute", top: pos.bottom !== undefined ? undefined : 0, bottom: pos.bottom !== undefined ? 0 : undefined, left: pos.right !== undefined ? undefined : 0, right: pos.right !== undefined ? 0 : undefined, width: cornerLen, height: cornerW, background: frameColor }} />
              <div style={{ position: "absolute", top: pos.bottom !== undefined ? undefined : 0, bottom: pos.bottom !== undefined ? 0 : undefined, left: pos.right !== undefined ? undefined : 0, right: pos.right !== undefined ? 0 : undefined, width: cornerW, height: cornerLen, background: frameColor }} />
            </div>
          ))}
          <div style={{ position: "absolute", top: "10%", left: "10%", right: "10%", bottom: "10%", border: `0.5px solid ${frameColor}`, pointerEvents: "none" }} />
          {showGrid && (
            <>
              <div style={{ position: "absolute", top: "33.33%", left: 0, right: 0, height: 1, background: "rgba(100,100,180,0.15)", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: "66.66%", left: 0, right: 0, height: 1, background: "rgba(100,100,180,0.15)", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 0, bottom: 0, left: "33.33%", width: 1, background: "rgba(100,100,180,0.15)", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 0, bottom: 0, left: "66.66%", width: 1, background: "rgba(100,100,180,0.15)", pointerEvents: "none" }} />
            </>
          )}
          <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.65)", padding: "2px 7px", fontSize: 13, fontWeight: 700, color: "#8080b0", letterSpacing: "0.1em", pointerEvents: "none" }}>
            {error?.includes("4K") ? `⚠ ${actualRes}` : RES[resolution].label}
          </div>
          {isRecording && (
            <div style={{ position: "absolute", top: 8, left: 8, display: "flex", alignItems: "center", gap: 5, background: "rgba(0,0,0,0.65)", padding: "2px 8px", pointerEvents: "none" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: RED, animation: "rec-pulse 1.4s ease-in-out infinite" }} />
              <span style={{ fontSize: 13, fontWeight: 800, color: RED, letterSpacing: "0.12em" }}>REC</span>
            </div>
          )}
        </>
      )}

      {actualRes && !showFrameOverlays && (
        <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.55)", padding: "2px 7px", fontSize: 13, fontWeight: 700, color: TXT2, letterSpacing: "0.08em" }}>
          {error?.includes("4K") ? `⚠ ${actualRes}` : actualRes}
        </div>
      )}

      {teleMode === "overlay" && teleScript && (
        <div ref={teleScrollRef} style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${teleOpacity * 0.6})`, padding: "10% 12%", overflowY: "hidden", color: "#fff", fontSize: teleFontSize, fontWeight: 600, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "none", pointerEvents: "none" }}>
          {teleScript}
        </div>
      )}

      {lowerThirds.filter(lt => lt.visible).map((lt, i) => (
        <div key={lt.id} style={{ ...ltPos(i), background: ltBg, borderLeft: `3px solid ${ltAccent}`, padding: "7px 14px", backdropFilter: "blur(4px)" }}>
          <div style={{ color: ltColor, fontSize: 15, fontWeight: 700, letterSpacing: "0.01em" }}>{lt.name}</div>
          {lt.title && <div style={{ color: ltColor, opacity: 0.7, fontSize: 13, marginTop: 2 }}>{lt.title}</div>}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SceneSwitcher — strip at bottom of canvas
// ─────────────────────────────────────────────────────────────

function SceneSwitcher({ scenes, activeId, onSwitch, onAdd, onRename, onDelete }: {
  scenes: Scene[]; activeId: string;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = parseInt(e.key);
      if (n >= 1 && n <= scenes.length && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = document.activeElement as HTMLElement;
        if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        onSwitch(scenes[n - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scenes, onSwitch]);

  return (
    <div style={{ height: 40, display: "flex", alignItems: "center", gap: 4, padding: "0 8px", background: BG0, borderTop: `1px solid ${BOR}`, flexShrink: 0, overflowX: "auto" }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: "#404060", letterSpacing: "0.12em", textTransform: "uppercase", whiteSpace: "nowrap", marginRight: 4 }}>SCENES</span>
      {scenes.map((s, i) => (
        <div key={s.id} style={{ position: "relative", flexShrink: 0 }}>
          {editing === s.id ? (
            <input
              autoFocus value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onBlur={() => { onRename(s.id, editVal || s.name); setEditing(null); }}
              onKeyDown={e => { if (e.key === "Enter") { onRename(s.id, editVal || s.name); setEditing(null); } if (e.key === "Escape") setEditing(null); }}
              style={{ width: 80, padding: "2px 6px", fontSize: 12, background: BG3, border: `1px solid ${PUR}`, color: TXT, outline: "none" }}
            />
          ) : (
            <button
              onClick={() => onSwitch(s.id)}
              onDoubleClick={() => { setEditing(s.id); setEditVal(s.name); }}
              style={{
                padding: "3px 10px", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em",
                background: activeId === s.id ? PUR : BG2,
                border: `1px solid ${activeId === s.id ? PUR : BOR}`,
                color: activeId === s.id ? "#fff" : TXT2,
                cursor: "pointer", whiteSpace: "nowrap",
              }}
              title={`Scene ${i + 1} — press ${i + 1} to switch`}
            >
              {i + 1}. {s.name}
            </button>
          )}
          {scenes.length > 1 && (
            <button
              onClick={() => onDelete(s.id)}
              title="Delete scene"
              style={{ position: "absolute", top: -4, right: -4, width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, background: BG3, border: `1px solid ${BOR}`, color: TXT2, cursor: "pointer", borderRadius: "50%", padding: 0, lineHeight: 1 }}
            >×</button>
          )}
        </div>
      ))}
      <button onClick={onAdd} title="Add scene" style={{ padding: "3px 8px", fontSize: 12, background: "none", border: `1px solid ${BOR}`, color: TXT2, cursor: "pointer", flexShrink: 0 }}>+ Scene</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ScreenSourceTile
// ─────────────────────────────────────────────────────────────

function ScreenSourceTile({ src, onRemove, onAddToScene, smartCutActive }: { src: ScreenSource; onRemove: () => void; onAddToScene?: () => void; smartCutActive?: boolean }) {
  const vidRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (vidRef.current && src.stream) vidRef.current.srcObject = src.stream;
  }, [src.stream]);

  return (
    <div style={{ background: BG0, border: `1px solid ${smartCutActive ? "#00c8a8" : BOR}`, flexShrink: 0 }}>
      <div style={{ position: "relative", height: 110 }}>
        <video ref={vidRef} autoPlay playsInline muted style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", background: "#000" }} />
        <div style={{ position: "absolute", top: 4, left: 4, background: "rgba(0,0,0,0.8)", padding: "2px 7px", fontSize: 10, fontWeight: 700, color: "#9090c0", letterSpacing: "0.08em", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {src.label}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderTop: `1px solid ${BOR}`, background: BG1 }}>
        <span style={{ flex: 1, fontSize: 11, color: TXT2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{src.label}</span>
        {onAddToScene && (
          <button
            onClick={onAddToScene}
            title="Add to current scene"
            style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, background: "rgba(0,200,168,0.15)", border: "1px solid #00c8a8", color: "#00c8a8", cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
          >+</button>
        )}
        <button
          onClick={onRemove}
          title="Remove source"
          style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 900, background: "rgba(220,50,50,0.12)", border: `1px solid ${RED}`, color: RED, cursor: "pointer", flexShrink: 0, lineHeight: 1 }}
        >×</button>
      </div>
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
      {guest.stream && (
        <div style={{ position: "absolute", top: 6, left: 6, display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", background: "#0e9090", border: "1px solid #14c8c8", boxShadow: "0 0 10px rgba(20,184,184,0.5)" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff", animation: "mic-blink 1.2s ease-in-out infinite", flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", letterSpacing: "0.12em" }}>ON AIR</span>
        </div>
      )}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "rgba(14,14,20,0.85)", padding: "5px 8px", display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: TXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{guest.name}</span>
        <button onClick={onMute} title={guest.muted ? "Unmute" : "Mute"} style={{ background: "none", border: "none", color: guest.muted ? RED : TXT2, cursor: "pointer", fontSize: 13, padding: "1px 3px" }}>
          {guest.muted ? "🔇" : "🔊"}
        </button>
        <button onClick={onRemove} title="Remove guest" style={{ background: "none", border: "none", color: RED, cursor: "pointer", fontSize: 12, padding: "1px 3px" }}>×</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GuestSidebar
// ─────────────────────────────────────────────────────────────

function GuestSidebar({ guests, enabled, onToggle, onMute, onRemove }: {
  guests: GuestPeer[]; enabled: boolean; onToggle: () => void;
  onMute: (id: string) => void; onRemove: (id: string) => void;
}) {
  const [localIp, setLocalIp] = useState("127.0.0.1");
  const [copied, setCopied]   = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const token = useMemo(() => Math.random().toString(36).slice(2, 10), []);

  useEffect(() => { invoke("studio:getLocalIp").then((ip: string) => setLocalIp(ip || "127.0.0.1")); }, []);

  useEffect(() => {
    if (enabled) {
      setTunnelLoading(true);
      invoke("studio:startTunnel").then((res: { url: string | null; error: string | null }) => {
        setTunnelUrl(res?.url ?? null); setTunnelLoading(false);
      }).catch(() => { setTunnelUrl(null); setTunnelLoading(false); });
    } else {
      invoke("studio:stopTunnel").catch(() => {});
      setTunnelUrl(null);
    }
  }, [enabled]);

  const localLink = `http://${localIp}:9091/join?s=${token}`;
  const link = tunnelUrl ? `${tunnelUrl}/join?s=${token}` : localLink;
  const copy = () => { navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "8px 10px", borderBottom: `1px solid ${BOR}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ ...label, marginBottom: 0 }}>Guests ({guests.length})</span>
          <button onClick={onToggle} style={btn(enabled, GRN)}>{enabled ? "On" : "Enable"}</button>
        </div>
        {enabled && (
          <div>
            <div style={{ ...label, marginBottom: 3 }}>Invite Link{tunnelUrl ? "" : tunnelLoading ? "" : " (local)"}</div>
            {tunnelLoading ? (
              <div style={{ fontSize: 13, color: BOR, padding: "4px 0" }}>Getting public link…</div>
            ) : (
              <div style={{ display: "flex", gap: 4 }}>
                <input readOnly value={link} style={{ ...inp, fontSize: 13, color: "#7090e8", flex: 1 }} />
                <button onClick={copy} style={{ ...btn(copied, GRN), whiteSpace: "nowrap" }}>{copied ? "✓" : "Copy"}</button>
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, padding: 6 }}>
        {guests.length === 0 ? (
          <div style={{ color: BOR, fontSize: 12, textAlign: "center", padding: "20px 10px" }}>
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
// TeleprompterPanel
// ─────────────────────────────────────────────────────────────

function TeleprompterPanel({
  script, setScript, mode, setMode, speed, setSpeed,
  opacity, setOpacity, fontSize, setFontSize, scrolling, setScrolling, scrollRef,
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
      <div>
        <div style={label}>Scroll Speed</div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["slow","medium","fast"] as TeleSpeed[]).map(s => (
            <button key={s} onClick={() => setSpeed(s)} style={{ ...btn(speed === s, PUR), flex: 1, padding: "4px 0" }}>{s}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button onClick={() => setScrolling(!scrolling)} style={{ ...btn(scrolling, GRN), flex: 1 }}>{scrolling ? "Pause" : "Play"}</button>
        <button onClick={reset} style={{ ...btn(), flex: 1 }}>Reset</button>
      </div>
      <div>
        <div style={label}>Font Size — {fontSize}px</div>
        <input type="range" min={18} max={48} value={fontSize} onChange={e => setFontSize(+e.target.value)} style={{ width: "100%" }} />
      </div>
      {mode === "overlay" && (
        <div>
          <div style={label}>Overlay Opacity — {Math.round(opacity * 100)}%</div>
          <input type="range" min={0.2} max={0.8} step={0.05} value={opacity} onChange={e => setOpacity(+e.target.value)} style={{ width: "100%" }} />
        </div>
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={label}>Script</div>
        <textarea value={script} onChange={e => setScript(e.target.value)} placeholder="Paste or type your script here…"
          style={{ ...inp, flex: 1, resize: "none", lineHeight: 1.6, minHeight: 160 }} />
      </div>
      {mode === "sidebar" && script && (
        <div>
          <div style={label}>Preview</div>
          <div ref={scrollRef} style={{ height: 200, overflowY: "hidden", background: BG0, border: `1px solid ${BOR}`, padding: "12px 14px", color: "#fff", fontSize: Math.max(10, fontSize * 0.55), lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "none" }}>
            {script}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// LowerThirdsPanel
// ─────────────────────────────────────────────────────────────

function LowerThirdsPanel({ items, onChange }: { items: LowerThird[]; onChange: (v: LowerThird[]) => void }) {
  const add = () => onChange([...items, { id: Date.now().toString(), name: "Guest Name", title: "Title / Role", visible: false }]);

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map(lt => (
        <div key={lt.id} style={{ background: BG0, border: `1px solid ${lt.visible ? GRN : BOR}`, padding: 8 }}>
          <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
            <input value={lt.name} onChange={e => onChange(items.map(i => i.id === lt.id ? { ...i, name: e.target.value } : i))} style={{ ...inp, flex: 1, fontSize: 13 }} placeholder="Name" />
            <input value={lt.title} onChange={e => onChange(items.map(i => i.id === lt.id ? { ...i, title: e.target.value } : i))} style={{ ...inp, flex: 1.5, fontSize: 13 }} placeholder="Title" />
          </div>
          <div style={{ display: "flex", gap: 5 }}>
            <button onClick={() => onChange(items.map(i => i.id === lt.id ? { ...i, visible: !i.visible } : i))} style={{ ...btn(lt.visible, GRN), flex: 1 }}>
              {lt.visible ? "Live" : "Off"}
            </button>
            <button onClick={() => onChange(items.filter(i => i.id !== lt.id))} style={{ ...btn(false, RED), color: RED }}>×</button>
          </div>
        </div>
      ))}
      <button onClick={add} style={{ ...btn(), width: "100%", padding: "6px 0", borderStyle: "dashed" }}>+ Add Lower Third</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MultiRTMPPanel — up to 4 simultaneous destinations
// ─────────────────────────────────────────────────────────────

const RTMP_PRESETS = [
  { name: "YouTube",  url: "rtmp://a.rtmp.youtube.com/live2" },
  { name: "Twitch",   url: "rtmp://live.twitch.tv/live" },
  { name: "Facebook", url: "rtmp://live-api-s.facebook.com:80/rtmp" },
  { name: "Custom",   url: "" },
];

function MultiRTMPPanel({ stream, bitrateKbps }: { stream: MediaStream | null; bitrateKbps: number }) {
  const initDests = (): MultiRtmpDest[] => RTMP_PRESETS.map((p, i) => ({
    id: String(i), name: p.name, url: p.url, key: "", enabled: false, status: "idle",
  }));

  const [dests, setDests] = useState<MultiRtmpDest[]>(initDests);
  const [editId, setEditId] = useState<string | null>("0");
  const recordersRef = useRef<Map<string, MediaRecorder>>(new Map());

  // Load saved config
  useEffect(() => {
    dbQuery<{ value: string }>("SELECT value FROM station_config_kv WHERE key='studio_rtmp_multi'")
      .then(rows => { if (rows[0]) setDests(JSON.parse(rows[0].value).map((d: MultiRtmpDest) => ({ ...d, status: "idle" }))); })
      .catch(() => {});
  }, []);

  const save = (d: MultiRtmpDest[]) => {
    setDests(d);
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_rtmp_multi',?)", [JSON.stringify(d)]).catch(() => {});
  };

  const patch = (id: string, p: Partial<MultiRtmpDest>) => save(dests.map(d => d.id === id ? { ...d, ...p } : d));

  const goLive = async (d: MultiRtmpDest) => {
    if (!stream) { patch(d.id, { status: "error", error: "No camera stream" }); return; }
    if (!d.url)  { patch(d.id, { status: "error", error: "RTMP URL required" }); return; }
    try {
      const res = await invoke("studio:rtmp:start", { url: d.url, key: d.key, destId: d.id });
      if (!res?.ok) { patch(d.id, { status: "error", error: res?.error || "Failed to start" }); return; }
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
      const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrateKbps * 1000 });
      recordersRef.current.set(d.id, mr);
      mr.ondataavailable = async (e) => {
        if (e.data.size > 0) invoke("studio:rtmp:chunk", { destId: d.id, data: await e.data.arrayBuffer() });
      };
      mr.start(250);
      patch(d.id, { status: "live", error: undefined });
    } catch (e: any) { patch(d.id, { status: "error", error: e.message }); }
  };

  const stopDest = async (d: MultiRtmpDest) => {
    recordersRef.current.get(d.id)?.stop();
    recordersRef.current.delete(d.id);
    await invoke("studio:rtmp:stop", { destId: d.id }).catch(() => {});
    patch(d.id, { status: "idle", error: undefined });
  };

  const goLiveAll = () => dests.filter(d => d.enabled && d.url).forEach(goLive);
  const stopAll   = () => dests.filter(d => d.status === "live").forEach(stopDest);
  const anyLive   = dests.some(d => d.status === "live");

  useEffect(() => {
    const h = ipcOn("studio:rtmp:stopped", ({ destId }: { destId?: string }) => {
      if (destId) patch(destId, { status: "idle" });
    });
    return () => ipcOff("studio:rtmp:stopped", h);
  }, []); // eslint-disable-line

  const editDest = dests.find(d => d.id === editId);

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Destination list */}
      {dests.map(d => (
        <div key={d.id} style={{ border: `1px solid ${d.status === "live" ? RED : editId === d.id ? PUR : BOR}`, background: BG0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px" }}>
            <button
              onClick={() => patch(d.id, { enabled: !d.enabled })}
              style={{ width: 14, height: 14, borderRadius: 2, border: `1px solid ${d.enabled ? PUR : BOR}`, background: d.enabled ? PUR : "none", cursor: "pointer", flexShrink: 0, padding: 0 }}
              title="Enable/disable"
            />
            <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: d.status === "live" ? RED : TXT, letterSpacing: "0.06em" }}>{d.name}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: d.status === "live" ? RED : d.status === "error" ? AMB : BOR, letterSpacing: "0.1em" }}>
              {d.status === "live" ? "● LIVE" : d.status === "error" ? "⚠ ERR" : "○ IDLE"}
            </span>
            <button onClick={() => setEditId(editId === d.id ? null : d.id)} style={{ ...btn(editId === d.id), padding: "2px 8px", fontSize: 11 }}>
              {editId === d.id ? "Close" : "Edit"}
            </button>
            {d.status === "live"
              ? <button onClick={() => stopDest(d)} style={{ ...btn(true, RED), padding: "2px 8px", fontSize: 11 }}>Stop</button>
              : <button onClick={() => goLive(d)} disabled={!d.enabled || !d.url} style={{ ...btn(false, GRN), padding: "2px 8px", fontSize: 11, opacity: (!d.enabled || !d.url) ? 0.4 : 1 }}>Go</button>
            }
          </div>
          {editId === d.id && (
            <div style={{ padding: "6px 8px", borderTop: `1px solid ${BOR}`, display: "flex", flexDirection: "column", gap: 5 }}>
              <input value={d.name} onChange={e => patch(d.id, { name: e.target.value })} style={{ ...inp, fontSize: 12 }} placeholder="Name" />
              <input value={d.url} onChange={e => patch(d.id, { url: e.target.value })} style={{ ...inp, fontSize: 12, fontFamily: "monospace" }} placeholder="rtmp://..." />
              <input value={d.key} onChange={e => patch(d.id, { key: e.target.value })} type="password" style={{ ...inp, fontSize: 12, fontFamily: "monospace" }} placeholder="Stream key" />
              {d.error && <div style={{ fontSize: 11, color: AMB }}>{d.error}</div>}
            </div>
          )}
        </div>
      ))}

      {/* Global controls */}
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button onClick={anyLive ? stopAll : goLiveAll} style={{ ...btn(anyLive, anyLive ? RED : GRN), flex: 1, padding: "7px 0", fontSize: 13 }}>
          {anyLive ? "Stop All" : "Go Live — All Enabled"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: TXT2, lineHeight: 1.5 }}>
        Check destinations to enable. Use "Go" per-destination or "Go Live" for all checked at once.
        Up to 4 simultaneous RTMP targets.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// BrandKitPanel
// ─────────────────────────────────────────────────────────────

function BrandKitPanel({ kit, onChange }: { kit: BrandKit; onChange: (k: BrandKit) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);

  const pickLogo = () => fileRef.current?.click();

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => onChange({ ...kit, logoDataUrl: ev.target?.result as string });
    reader.readAsDataURL(f);
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Logo */}
      <div>
        <div style={label}>Station Logo</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {kit.logoDataUrl ? (
            <img src={kit.logoDataUrl} alt="logo" style={{ height: 40, maxWidth: 100, objectFit: "contain", background: BG0, border: `1px solid ${BOR}`, padding: 4 }} />
          ) : (
            <div style={{ width: 100, height: 40, background: BG0, border: `1px solid ${BOR}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ fontSize: 11, color: BOR }}>No logo</span>
            </div>
          )}
          <button onClick={pickLogo} style={btn()}>Upload PNG</button>
          {kit.logoDataUrl && <button onClick={() => onChange({ ...kit, logoDataUrl: null })} style={{ ...btn(false, RED), color: RED }}>Remove</button>}
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={onFile} style={{ display: "none" }} />
        <div style={{ fontSize: 11, color: TXT2, marginTop: 4 }}>Shown in bottom-right corner of camera</div>
      </div>

      {/* Accent color */}
      <div>
        <div style={label}>Accent Color</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="color" value={kit.accentColor} onChange={e => onChange({ ...kit, accentColor: e.target.value })}
            style={{ width: 36, height: 28, background: "none", border: `1px solid ${BOR}`, cursor: "pointer", padding: 1 }} />
          <span style={{ fontSize: 13, color: TXT, fontFamily: "monospace" }}>{kit.accentColor}</span>
          <div style={{ width: 32, height: 20, background: kit.accentColor, border: "none" }} />
        </div>
        <div style={{ fontSize: 11, color: TXT2, marginTop: 2 }}>Lower thirds accent bar color</div>
      </div>

      {/* Lower third bg */}
      <div>
        <div style={label}>Lower Third Background</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="color" value={kit.ltBgColor.startsWith("rgba") ? "#000000" : kit.ltBgColor}
            onChange={e => onChange({ ...kit, ltBgColor: e.target.value })}
            style={{ width: 36, height: 28, background: "none", border: `1px solid ${BOR}`, cursor: "pointer", padding: 1 }} />
          <input value={kit.ltBgColor} onChange={e => onChange({ ...kit, ltBgColor: e.target.value })}
            style={{ ...inp, width: 160, fontSize: 12, fontFamily: "monospace" }} placeholder="rgba(0,0,0,0.75)" />
        </div>
      </div>

      {/* Lower third text color */}
      <div>
        <div style={label}>Lower Third Text</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="color" value={kit.ltTextColor} onChange={e => onChange({ ...kit, ltTextColor: e.target.value })}
            style={{ width: 36, height: 28, background: "none", border: `1px solid ${BOR}`, cursor: "pointer", padding: 1 }} />
          <span style={{ fontSize: 13, color: kit.ltTextColor, fontFamily: "monospace", background: kit.ltBgColor, padding: "2px 8px" }}>Preview Text</span>
        </div>
      </div>

      {/* Preview */}
      <div>
        <div style={label}>Lower Third Preview</div>
        <div style={{ background: BG0, height: 60, position: "relative", border: `1px solid ${BOR}`, overflow: "hidden" }}>
          <div style={{ position: "absolute", bottom: 6, left: 8, background: kit.ltBgColor, borderLeft: `3px solid ${kit.accentColor}`, padding: "5px 12px" }}>
            <div style={{ color: kit.ltTextColor, fontSize: 13, fontWeight: 700 }}>Guest Name</div>
            <div style={{ color: kit.ltTextColor, opacity: 0.7, fontSize: 11 }}>Title / Role</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Thin wrapper that pulls addLayerFromSource from VideoEngineContext.
// Matches a Studio ScreenSource (by stream.id) to a VideoEngine VideoSource, then adds a canvas layer.
function SourcesPanelWithEngine(props: Omit<React.ComponentProps<typeof SourcesPanel>, "onAddToScene">) {
  const { addLayerFromSource, sources } = useVideoEngine();
  const handleAddToScene = useCallback((streamId: string) => {
    const match = sources.find(s => s.stream?.id === streamId);
    if (match) addLayerFromSource(match.id);
  }, [addLayerFromSource, sources]);
  return <SourcesPanel {...props} onAddToScene={handleAddToScene} />;
}

// ─────────────────────────────────────────────────────────────
// SourcesPanel — screen share + source management
// ─────────────────────────────────────────────────────────────

function SourcesPanel({ screenSources, onAddScreen, onRemoveScreen, onAddToScene, smartCutId, smartCutEnabled, onToggleSmartCut, hostStream, guests }: {
  screenSources: ScreenSource[];
  onAddScreen: () => void;
  onRemoveScreen: (id: string) => void;
  onAddToScene?: (id: string) => void;
  smartCutId: string | null;
  smartCutEnabled: boolean;
  onToggleSmartCut: () => void;
  hostStream: MediaStream | null;
  guests: GuestPeer[];
}) {
  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Screen share */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={label}>Screen Sources</div>
          <button onClick={onAddScreen} style={{ ...btn(), padding: "3px 10px", fontSize: 11 }}>+ Screen</button>
        </div>
        {screenSources.length === 0 ? (
          <div style={{ fontSize: 12, color: BOR, padding: "10px 0" }}>No screen sources — click "+ Screen" to capture a monitor or window</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {screenSources.map(s => (
              <ScreenSourceTile key={s.id} src={s} onRemove={() => onRemoveScreen(s.id)} onAddToScene={onAddToScene ? () => onAddToScene(s.stream.id) : undefined} smartCutActive={smartCutEnabled && smartCutId === s.id} />
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: BOR }} />

      {/* Smart Cut */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ ...label, marginBottom: 0 }}>Smart Cut</div>
          <button onClick={onToggleSmartCut} style={btn(smartCutEnabled, "#00c8a8")}>
            {smartCutEnabled ? "● On" : "Off"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: TXT2, lineHeight: 1.6 }}>
          AI auto-switching — automatically highlights whoever is speaking based on audio levels. Works across host, guests, and screen sources.
        </div>
        {smartCutEnabled && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            <SmartCutIndicator label="Host" active={smartCutId === "host"} hasStream={!!hostStream} />
            {guests.filter(g => g.status === "accepted").map(g => (
              <SmartCutIndicator key={g.id} label={g.name} active={smartCutId === g.id} hasStream={!!g.stream} />
            ))}
            {screenSources.map(s => (
              <SmartCutIndicator key={s.id} label={s.label} active={smartCutId === s.id} hasStream />
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: BOR }} />

      {/* Virtual camera */}
      <div>
        <div style={{ ...label, marginBottom: 6 }}>Virtual Camera</div>
        <div style={{ fontSize: 12, color: TXT2, lineHeight: 1.6, marginBottom: 8 }}>
          To appear as a webcam in Zoom or Teams, install <span style={{ color: "#7090e8" }}>OBS Virtual Camera</span> and use OBS with an NDI/Spout source pointed at Ether's RTMP output.
        </div>
        <div style={{ fontSize: 11, color: "#404060", padding: "6px 8px", background: BG0, border: `1px solid ${BOR}` }}>
          Native virtual camera requires OS-level drivers not available in browser sandbox. RTMP → OBS → Virtual Camera is the standard broadcast workflow.
        </div>
      </div>
    </div>
  );
}

function SmartCutIndicator({ label, active, hasStream }: { label: string; active: boolean; hasStream: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", background: active ? "rgba(0,200,168,0.08)" : BG0, border: `1px solid ${active ? "#00c8a8" : BOR}` }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: active ? "#00c8a8" : hasStream ? BOR : "#202030", flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: active ? "#00c8a8" : TXT2, flex: 1 }}>{label}</span>
      {active && <span style={{ fontSize: 10, fontWeight: 700, color: "#00c8a8", letterSpacing: "0.1em" }}>ACTIVE</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// QualityPanel
// ─────────────────────────────────────────────────────────────

function QualityPanel({ resolution, setResolution, bitrate, setBitrate, stream }: {
  resolution: ResKey; setResolution: (v: ResKey) => void;
  bitrate: BrKey;    setBitrate:    (v: BrKey)  => void;
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
    background: active ? PUR : BG2, border: `1px solid ${active ? PUR : BOR}`,
    color: active ? "#fff" : TXT, fontSize: 12, fontWeight: active ? 700 : 400,
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left" as const,
  });

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
      <div>
        <div style={label}>Resolution</div>
        {(Object.keys(RES) as ResKey[]).map(r => {
          const sup = support(r);
          return (
            <button key={r} onClick={() => setResolution(r)} style={rowStyle(resolution === r)}>
              <div><span style={{ fontWeight: 700 }}>{RES[r].label}</span><span style={{ marginLeft: 6, opacity: 0.6, fontSize: 13 }}>{RES[r].desc}</span></div>
              {sup === "yes" && <span style={{ color: "#22c55e", fontSize: 12 }}>✓</span>}
              {sup === "no"  && <span style={{ color: AMB, fontSize: 12 }}>⚠</span>}
            </button>
          );
        })}
      </div>
      <div>
        <div style={label}>Bitrate</div>
        {(Object.keys(BITRATES) as BrKey[]).map(b => (
          <button key={b} onClick={() => setBitrate(b)} style={rowStyle(bitrate === b)}>
            <div><span style={{ fontWeight: 700 }}>{BITRATES[b].label}</span><span style={{ marginLeft: 6, opacity: 0.6, fontSize: 13 }}>{BITRATES[b].desc}</span></div>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 13, color: TXT2, lineHeight: 1.5, borderTop: `1px solid ${BOR}`, paddingTop: 10 }}>
        Resolution restarts the camera stream. Bitrate applies to recording and RTMP output.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// StatusBar
// ─────────────────────────────────────────────────────────────

function StatusBar({ isRecording, isStreaming, guestCount, hostLevel, onToggleRecord, stream, onSaveClip, smartCutEnabled, onToggleSmartCut }: {
  isRecording: boolean; isStreaming: boolean; guestCount: number; hostLevel: number;
  onToggleRecord: () => void; stream: MediaStream | null;
  onSaveClip: () => void;
  smartCutEnabled: boolean; onToggleSmartCut: () => void;
}) {
  const [secs, setSecs] = useState(0);
  const ref = useRef<any>(null);

  useEffect(() => {
    if (isRecording) {
      setSecs(0); ref.current = setInterval(() => setSecs(s => s + 1), 1000);
    } else { clearInterval(ref.current); setSecs(0); }
    return () => clearInterval(ref.current);
  }, [isRecording]);

  const fmt = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  };

  return (
    <div style={{ height: 38, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", background: BG1, borderTop: `1px solid ${BOR}`, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: isStreaming ? RED : BG3, boxShadow: isStreaming ? `0 0 8px ${RED}` : "none" }} />
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", color: isStreaming ? RED : TXT2 }}>
          {isStreaming ? "LIVE" : "OFFLINE"}
        </span>
      </div>

      <div style={{ width: 1, height: 14, background: BOR }} />

      <button onClick={onToggleRecord} disabled={!stream} style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", border: "none", cursor: stream ? "pointer" : "not-allowed", background: isRecording ? RED : BG2, color: isRecording ? "#fff" : TXT2, fontSize: 12, fontWeight: 700, letterSpacing: "0.06em" }}>
        <div style={{ width: 7, height: 7, borderRadius: isRecording ? 0 : "50%", background: "currentColor" }} />
        {isRecording ? `REC  ${fmt(secs)}` : "Record"}
      </button>

      {/* Clip buffer button */}
      <button onClick={onSaveClip} disabled={!stream} title="Save last 30 seconds as clip" style={{ padding: "3px 9px", border: `1px solid ${BOR}`, background: BG2, color: stream ? AMB : BOR, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", cursor: stream ? "pointer" : "not-allowed" }}>
        ⏮ CLIP
      </button>

      <div style={{ flex: 1 }} />

      {/* Smart Cut indicator */}
      <button onClick={onToggleSmartCut} title="AI Smart Cut — auto-switch to loudest speaker" style={{ padding: "3px 9px", border: `1px solid ${smartCutEnabled ? "#00c8a8" : BOR}`, background: smartCutEnabled ? "rgba(0,200,168,0.12)" : BG2, color: smartCutEnabled ? "#00c8a8" : TXT2, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer" }}>
        ✦ AI CUT
      </button>

      <div style={{ width: 1, height: 14, background: BOR }} />

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 13, color: TXT2, letterSpacing: "0.06em" }}>HOST</span>
        <div style={{ width: 60, height: 4, background: BG0 }}>
          <div style={{ height: "100%", width: `${Math.min(hostLevel * 100, 100)}%`, background: hostLevel > 0.85 ? RED : hostLevel > 0.6 ? AMB : GRN, transition: "width 0.05s" }} />
        </div>
      </div>

      <div style={{ width: 1, height: 14, background: BOR }} />
      <span style={{ fontSize: 12, color: TXT2 }}>{guestCount} guest{guestCount !== 1 ? "s" : ""}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// EmbeddedStudio
// ─────────────────────────────────────────────────────────────

type EmbedTab = "chat" | "guests" | "script" | "settings";

function EmbeddedStudio({
  hostStream, setHostStream, lowerThirds, resolution, setResolution, bitrate, setBitrate,
  isRecording, isStreaming, setIsStreaming, showGrid, setShowGrid,
  teleScript, setTeleScript, teleScrollRef, hostLevel, toggleRecord,
  guests, acceptGuest, denyGuest, removeGuest, toggleMute, guestsEnabled, setGuestsEnabled,
}: {
  hostStream: MediaStream | null; setHostStream: (s: MediaStream | null) => void;
  lowerThirds: LowerThird[];
  resolution: ResKey; setResolution: (v: ResKey) => void;
  bitrate: BrKey; setBitrate: (v: BrKey) => void;
  isRecording: boolean; isStreaming: boolean; setIsStreaming: (v: boolean) => void;
  showGrid: boolean; setShowGrid: (fn: (v: boolean) => boolean) => void;
  teleScript: string; setTeleScript: (v: string) => void;
  teleScrollRef: React.RefObject<HTMLDivElement>;
  hostLevel: number; toggleRecord: () => void;
  guests: GuestPeer[]; acceptGuest: (id: string) => void; denyGuest: (id: string) => void; removeGuest: (id: string) => void; toggleMute: (id: string) => void;
  guestsEnabled: boolean; setGuestsEnabled: (fn: (v: boolean) => boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<EmbedTab>("script");
  const [teleOverlay, setTeleOverlay] = useState(false);
  const [teleSpeed, setTeleSpeed] = useState(14);
  const [teleFontSize, setTeleFontSize] = useState(22);
  const [rtmpUrl, setRtmpUrl] = useState("");
  const [streamKey, setStreamKey] = useState("");

  useEffect(() => {
    dbQuery<{ key: string; value: string }>("SELECT key, value FROM station_config_kv WHERE key IN ('studio_rtmp_url','studio_stream_key')")
      .then(rows => { rows.forEach(r => { if (r.key === "studio_rtmp_url") setRtmpUrl(r.value); if (r.key === "studio_stream_key") setStreamKey(r.value); }); })
      .catch(() => {});
  }, []);

  const saveRtmp = () => {
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_rtmp_url',?)", [rtmpUrl]).catch(() => {});
    dbExec("INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('studio_stream_key',?)", [streamKey]).catch(() => {});
  };

  const TABS: Array<{ id: EmbedTab; label: string }> = [
    { id: "chat", label: "Chat" }, { id: "guests", label: "Guests" },
    { id: "script", label: "Script" }, { id: "settings", label: "Settings" },
  ];

  const [invitePublic, setInvitePublic] = useState<string | null>(null);
  const [inviteLocal, setInviteLocal]   = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteCopied, setInviteCopied]   = useState(false);
  const [inviteError, setInviteError]     = useState<string | null>(null);
  const inviteToken = useMemo(() => Math.random().toString(36).slice(2, 10), []);

  const generateInvite = async () => {
    setInviteLoading(true); setInviteError(null);
    try {
      const ip = await invoke("studio:getLocalIp") as string || "127.0.0.1";
      setInviteLocal(`http://${ip}:9091/join?s=${inviteToken}`);
      try {
        const res = await invoke("studio:startTunnel") as { url: string | null; error: string | null };
        if (res?.url) setInvitePublic(`${res.url}/join?s=${inviteToken}`);
        else setInviteError(res?.error || "Tunnel failed — use local link");
      } catch { setInviteError("Tunnel unavailable — local link works same-network"); }
    } catch { setInviteError("Could not get network info"); }
    setInviteLoading(false);
  };

  const copyInvite = (link: string) => {
    navigator.clipboard.writeText(link).then(() => { setInviteCopied(true); setTimeout(() => setInviteCopied(false), 2000); }).catch(() => {});
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: BG1, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderBottom: `1px solid ${BOR}`, flexShrink: 0, background: BG0 }}>
        <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: "0.14em", color: "#4040a0", textTransform: "uppercase" as const }}>Video Studio</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowGrid(g => !g)} style={{ padding: "2px 7px", fontSize: 13, fontWeight: 700, background: showGrid ? "rgba(64,64,160,0.3)" : "transparent", border: `1px solid ${showGrid ? "#4040a0" : BOR}`, color: showGrid ? "#8080d0" : TXT2, cursor: "pointer" }}>Grid</button>
        <button onClick={toggleRecord} disabled={!hostStream} style={{ padding: "2px 8px", fontSize: 13, fontWeight: 700, background: isRecording ? RED : "transparent", border: `1px solid ${isRecording ? RED : BOR}`, color: isRecording ? "#fff" : TXT2, cursor: "pointer" }}>{isRecording ? "■ Stop" : "⏺ Rec"}</button>
        <button onClick={() => setIsStreaming(!isStreaming)} style={{ padding: "2px 8px", fontSize: 13, fontWeight: 700, background: isStreaming ? "#22c55e" : "transparent", border: `1px solid ${isStreaming ? "#22c55e" : BOR}`, color: isStreaming ? "#fff" : TXT2, cursor: "pointer" }}>{isStreaming ? "● Live" : "Go Live"}</button>
      </div>

      <div style={{ width: "100%", aspectRatio: "16/9", flexShrink: 0, position: "relative", background: "#0a0a10" }}>
        <HostCamera
          onStream={setHostStream} lowerThirds={lowerThirds}
          teleMode={teleOverlay ? "overlay" : "off"} teleOpacity={0.82}
          teleScript={teleScript} teleFontSize={teleFontSize}
          teleScrolling={false} teleScrollRef={teleScrollRef}
          resolution={resolution} isRecording={isRecording}
          showGrid={showGrid} showFrameOverlays
        />
        <LevelBar level={hostLevel} height={3} />
      </div>

      <div style={{ display: "flex", borderBottom: `1px solid ${BOR}`, flexShrink: 0, background: BG0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{ flex: 1, padding: "5px 0", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase" as const, background: "none", color: activeTab === t.id ? "#00c8a8" : TXT2, borderBottom: `2px solid ${activeTab === t.id ? "#00c8a8" : "transparent"}` }}>{t.label}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, background: BG1 }}>
        {activeTab === "chat" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
            {isStreaming ? (
              <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
                <div style={{ flex: 1, background: "#060608", border: `1px solid ${BOR}`, padding: "6px 8px", overflowY: "auto", fontSize: 12, color: "#808090" }}>
                  <div style={{ color: TXT2, fontStyle: "italic" }}>Chat connected — messages will appear here.</div>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: "center" as const, color: TXT2, fontSize: 13, lineHeight: 1.7 }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: 8, opacity: 0.3 }}><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                <div>Chat will appear when you go live.</div>
              </div>
            )}
          </div>
        )}

        {activeTab === "guests" && (
          <div style={{ padding: "10px 12px" }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
              <button onClick={() => setGuestsEnabled(v => !v)} style={{ padding: "4px 10px", fontSize: 13, background: "transparent", border: `1px solid ${BOR}`, color: guestsEnabled ? "#22c55e" : TXT2, cursor: "pointer" }}>{guestsEnabled ? "● Guests On" : "Enable"}</button>
              <button onClick={generateInvite} disabled={inviteLoading} style={{ padding: "4px 12px", fontSize: 13, fontWeight: 700, background: invitePublic || inviteLocal ? "transparent" : "#6040c0", border: invitePublic || inviteLocal ? `1px solid ${BOR}` : "none", color: invitePublic || inviteLocal ? TXT2 : "#fff", cursor: "pointer", opacity: inviteLoading ? 0.6 : 1 }}>{inviteLoading ? "Creating link..." : invitePublic || inviteLocal ? "Refresh Link" : "Get Invite Link"}</button>
            </div>
            {invitePublic && (
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#22c55e", letterSpacing: "0.1em", marginBottom: 3 }}>PUBLIC LINK</div>
                <div style={{ display: "flex", gap: 4 }}>
                  <input readOnly value={invitePublic} onClick={e => (e.target as HTMLInputElement).select()} style={{ flex: 1, padding: "4px 8px", fontSize: 12, fontFamily: "monospace", background: BG0, border: `1px solid ${BOR}`, color: "#7090e8", outline: "none" }} />
                  <button onClick={() => copyInvite(invitePublic)} style={{ padding: "4px 8px", fontSize: 12, fontWeight: 700, background: inviteCopied ? "#22c55e" : "transparent", border: `1px solid ${inviteCopied ? "#22c55e" : BOR}`, color: inviteCopied ? "#000" : TXT2, cursor: "pointer" }}>{inviteCopied ? "✓" : "Copy"}</button>
                </div>
              </div>
            )}
            {inviteLocal && (
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#38bdf8", letterSpacing: "0.1em", marginBottom: 3 }}>LOCAL LINK</div>
                <div style={{ display: "flex", gap: 4 }}>
                  <input readOnly value={inviteLocal} onClick={e => (e.target as HTMLInputElement).select()} style={{ flex: 1, padding: "4px 8px", fontSize: 12, fontFamily: "monospace", background: BG0, border: `1px solid ${BOR}`, color: "#6080a8", outline: "none" }} />
                  <button onClick={() => copyInvite(inviteLocal)} style={{ padding: "4px 8px", fontSize: 12, fontWeight: 700, background: "transparent", border: `1px solid ${BOR}`, color: TXT2, cursor: "pointer" }}>Copy</button>
                </div>
              </div>
            )}
            {inviteError && <div style={{ fontSize: 12, color: "#f59e0b", marginBottom: 6, padding: "4px 8px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>{inviteError}</div>}
            {guests.filter(g => g.status === "pending").map(g => (
              <div key={g.id} style={{ padding: "10px 12px", marginBottom: 6, background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.3)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#a78bfa", marginBottom: 4 }}>"{g.name}" wants to join</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => acceptGuest(g.id)} style={{ flex: 1, padding: "6px", fontSize: 12, fontWeight: 700, background: "#22c55e", border: "none", color: "#000", cursor: "pointer" }}>Accept</button>
                  <button onClick={() => denyGuest(g.id)} style={{ flex: 1, padding: "6px", fontSize: 12, fontWeight: 700, background: "transparent", border: `1px solid ${RED}`, color: RED, cursor: "pointer" }}>Deny</button>
                </div>
              </div>
            ))}
            {guests.filter(g => g.status === "accepted").length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {guests.filter(g => g.status === "accepted").map(g => (
                  <div key={g.id} style={{ background: BG0, border: `1px solid ${BOR}`, padding: 6 }}>
                    {g.stream ? <video ref={el => { if (el && el.srcObject !== g.stream) el.srcObject = g.stream; }} autoPlay playsInline style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", display: "block", background: "#0a0a10" }} /> : <div style={{ width: "100%", aspectRatio: "4/3", background: "#0a0a10", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 12, color: "#22c55e" }}>● Connected</span></div>}
                    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
                      <span style={{ flex: 1, fontSize: 12, color: TXT2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{g.name}</span>
                      <button onClick={() => toggleMute(g.id)} style={{ padding: "1px 5px", fontSize: 11, background: "none", border: `1px solid ${BOR}`, color: g.muted ? AMB : TXT2, cursor: "pointer" }}>{g.muted ? "Unmute" : "Mute"}</button>
                      <button onClick={() => removeGuest(g.id)} style={{ padding: "1px 5px", fontSize: 11, background: "none", border: `1px solid ${BOR}`, color: RED, cursor: "pointer" }}>Kick</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "script" && (
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <textarea value={teleScript} onChange={e => setTeleScript(e.target.value)} placeholder="Paste or type your script here…" rows={6}
              style={{ width: "100%", padding: "8px 10px", background: BG0, border: `1px solid ${BOR}`, color: TXT, fontSize: 13, lineHeight: 1.6, resize: "vertical" as const, outline: "none", fontFamily: "'Inter', system-ui, sans-serif" }} />
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={label}>Speed</span>
              <input type="range" min={4} max={40} step={2} value={teleSpeed} onChange={e => setTeleSpeed(Number(e.target.value))} style={{ flex: 1, accentColor: "#00c8a8", height: 3 }} />
              <span style={{ fontSize: 13, color: TXT2, width: 28, textAlign: "right" as const }}>{teleSpeed}px</span>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={label}>Font</span>
              <input type="range" min={14} max={48} step={2} value={teleFontSize} onChange={e => setTeleFontSize(Number(e.target.value))} style={{ flex: 1, accentColor: "#00c8a8", height: 3 }} />
              <span style={{ fontSize: 13, color: TXT2, width: 28, textAlign: "right" as const }}>{teleFontSize}px</span>
            </div>
            <button onClick={() => setTeleOverlay(v => !v)} style={{ padding: "4px 12px", fontSize: 13, fontWeight: 700, background: teleOverlay ? "#6040c0" : "transparent", border: `1px solid ${teleOverlay ? "#6040c0" : BOR}`, color: teleOverlay ? "#fff" : TXT2, cursor: "pointer" }}>
              {teleOverlay ? "● Overlay On" : "Overlay Off"}
            </button>
          </div>
        )}

        {activeTab === "settings" && (
          <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <div style={label}>Resolution</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(Object.keys(RES) as ResKey[]).map(k => (
                  <button key={k} onClick={() => setResolution(k)} style={{ flex: 1, padding: "4px 0", fontSize: 13, fontWeight: 700, background: resolution === k ? "#6040c0" : "transparent", border: `1px solid ${resolution === k ? "#6040c0" : BOR}`, color: resolution === k ? "#fff" : TXT2, cursor: "pointer" }}>{RES[k].label}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={label}>Bitrate</div>
              <div style={{ display: "flex", gap: 4 }}>
                {(Object.keys(BITRATES) as BrKey[]).map(k => (
                  <button key={k} onClick={() => setBitrate(k)} style={{ flex: 1, padding: "4px 0", fontSize: 13, fontWeight: 700, background: bitrate === k ? "#6040c0" : "transparent", border: `1px solid ${bitrate === k ? "#6040c0" : BOR}`, color: bitrate === k ? "#fff" : TXT2, cursor: "pointer" }}>{BITRATES[k].label}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={label}>RTMP Destination</div>
              <input value={rtmpUrl} onChange={e => setRtmpUrl(e.target.value)} onBlur={saveRtmp} placeholder="rtmp://live.youtube.com/live2" style={{ ...inp, marginBottom: 4 }} />
              <input value={streamKey} onChange={e => setStreamKey(e.target.value)} onBlur={saveRtmp} placeholder="Stream key" type="password" style={inp} />
            </div>
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

type RightTab = "engine" | "guests" | "tele" | "lower" | "rtmp" | "quality" | "sources" | "brand";

export default function Studio({ embedded }: { embedded?: boolean } = {}) {
  const [hostStream, setHostStream]       = useState<MediaStream | null>(null);
  const [guestsEnabled, setGuestsEnabled] = useState(false);
  const [rightTab, setRightTab]           = useState<RightTab>("engine");
  const [isStreaming, setIsStreaming]     = useState(false);
  const [isRecording, setIsRecording]     = useState(false);
  const [showGrid, setShowGrid]           = useState(false);
  const [smartCutEnabled, setSmartCutEnabled] = useState(false);

  const { resolution, setResolution, bitrate, setBitrate, bitrateKbps } = useVideoQuality();
  const { scenes, active: activeScene, activeId: activeSceneId, setActiveId: setActiveSceneId, addScene, renameScene, deleteScene, updateScene } = useScenes();
  const { sources: screenSources, addSource: addScreenSource, removeSource: removeScreenSource } = useScreenShare();
  const [brandKit, setBrandKit] = useBrandKit();

  const [teleMode, setTeleMode]         = useState<TeleMode>("off");
  const [teleSpeed, setTeleSpeed]       = useState<TeleSpeed>("medium");
  const [teleOpacity, setTeleOpacity]   = useState(0.5);
  const [teleFontSize, setTeleFontSize] = useState(28);
  const [teleScript, setTeleScript]     = useState("");
  const [teleScrolling, setTeleScrolling] = useState(false);
  const teleScrollRef = useRef<HTMLDivElement>(null);

  const hostLevel = useLevelMeter(hostStream);
  const { guests, acceptGuest, denyGuest, removeGuest, toggleMute } = useWebRTCGuests(guestsEnabled);

  // Smart cut sources — host + accepted guests
  const smartCutSources = useMemo(() => [
    { id: "host", stream: hostStream },
    ...guests.filter(g => g.status === "accepted").map(g => ({ id: g.id, stream: g.stream })),
    ...screenSources.map(s => ({ id: s.id, stream: s.stream })),
  ], [hostStream, guests, screenSources]);

  const smartCutActiveId = useSmartCut(smartCutSources, smartCutEnabled);

  // Clip buffer
  const { saveClip } = useClipBuffer(hostStream, 30);

  // Sync lowerThirds from active scene into scene on changes
  const lowerThirds = activeScene.lowerThirds;
  const setLowerThirds = useCallback((v: LowerThird[]) => {
    updateScene(activeSceneId, { lowerThirds: v });
  }, [activeSceneId, updateScene]);

  // Teleprompter auto-scroll
  useEffect(() => {
    if (!teleScrolling) return;
    const px = teleSpeed === "slow" ? 0.6 : teleSpeed === "medium" ? 1.4 : 2.8;
    const id = setInterval(() => { if (teleScrollRef.current) teleScrollRef.current.scrollTop += px; }, 16);
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
      recorderRef.current?.stop(); recorderRef.current = null;
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
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const mr = new MediaRecorder(hostStream, { mimeType, videoBitsPerSecond: bitrateKbps * 1000 });
    recorderRef.current = mr;
    mr.ondataavailable = async (e) => { if (e.data.size > 0) invoke("studio:record:chunk", await e.data.arrayBuffer()); };
    mr.onstop = () => setIsRecording(false);
    mr.start(500);
    setIsRecording(true);
  }, [hostStream, isRecording, bitrateKbps]);

  const tab = (t: RightTab, lbl: string) => (
    <button onClick={() => setRightTab(t)} style={{ flex: 1, padding: "11px 6px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase" as const, background: rightTab === t ? BG1 : BG2, color: rightTab === t ? TXT : TXT2, borderBottom: `2px solid ${rightTab === t ? PUR : "transparent"}`, transition: "all 0.12s", whiteSpace: "nowrap" as const }}
      onMouseEnter={e => { if (rightTab !== t) (e.currentTarget as HTMLElement).style.color = TXT; }}
      onMouseLeave={e => { if (rightTab !== t) (e.currentTarget as HTMLElement).style.color = TXT2; }}
    >{lbl}</button>
  );

  if (embedded) {
    return (
      <EmbeddedStudio
        hostStream={hostStream} setHostStream={setHostStream} lowerThirds={lowerThirds}
        resolution={resolution} setResolution={setResolution} bitrate={bitrate} setBitrate={setBitrate}
        isRecording={isRecording} isStreaming={isStreaming} setIsStreaming={setIsStreaming}
        showGrid={showGrid} setShowGrid={setShowGrid}
        teleScript={teleScript} setTeleScript={setTeleScript} teleScrollRef={teleScrollRef}
        hostLevel={hostLevel} toggleRecord={toggleRecord}
        guests={guests} acceptGuest={acceptGuest} denyGuest={denyGuest} removeGuest={removeGuest} toggleMute={toggleMute}
        guestsEnabled={guestsEnabled} setGuestsEnabled={setGuestsEnabled}
      />
    );
  }

  return (
    <VideoEngineProvider>
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: BG1, overflow: "hidden" }}>

      <div style={{ flex: 1, display: "flex", width: "100%", minHeight: 0, overflow: "hidden" }}>

        {/* Left: main canvas area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>

          <div style={{ display: rightTab === "engine" ? "flex" : "none", flex: 1, flexDirection: "column" as const, minHeight: 0 }}>
            <VideoEngineCanvas />
          </div>

          <div style={{ display: rightTab !== "engine" ? "flex" : "none", flex: 1, flexDirection: "column" as const, minHeight: 0 }}>
            <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
              <HostCamera
                onStream={setHostStream} lowerThirds={lowerThirds}
                teleMode={teleMode} teleOpacity={teleOpacity} teleScript={teleScript}
                teleFontSize={teleFontSize} teleScrolling={teleScrolling} teleScrollRef={teleScrollRef}
                resolution={resolution} isRecording={isRecording} showGrid={showGrid}
                showFrameOverlays={!!embedded}
                brandKit={brandKit}
                smartCutActive={smartCutEnabled && smartCutActiveId === "host"}
              />

              {/* Sidebar teleprompter */}
              {teleMode === "sidebar" && teleScript && (
                <div style={{ width: 260, background: BG0, borderLeft: `1px solid ${BOR}`, display: "flex", flexDirection: "column" }}>
                  <div style={{ padding: "6px 10px", borderBottom: `1px solid ${BOR}`, fontSize: 13, fontWeight: 700, color: TXT2, letterSpacing: "0.08em" }}>TELEPROMPTER</div>
                  <div ref={teleScrollRef} style={{ flex: 1, overflowY: "hidden", padding: "16px 14px", color: "#fff", fontSize: teleFontSize, fontWeight: 600, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "none" }}>
                    {teleScript}
                  </div>
                  <div style={{ height: 3, background: BG3, flexShrink: 0 }}>
                    <div style={{ height: "100%", width: "30%", background: PUR }} />
                  </div>
                </div>
              )}
            </div>
            <LevelBar level={hostLevel} height={5} />
          </div>

        </div>

        {/* Right sidebar */}
        <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", borderLeft: `1px solid ${BOR}`, background: BG2, overflow: "hidden" }}>
          <div style={{ display: "flex", flexDirection: "column", borderBottom: `1px solid ${BOR}`, flexShrink: 0, background: BG2 }}>
            <div style={{ display: "flex", borderBottom: `1px solid ${BOR}` }}>
              {tab("engine",  "Engine")}
              {tab("guests",  "Guests")}
              {tab("sources", "Sources")}
              {tab("tele",    "Script")}
            </div>
            <div style={{ display: "flex" }}>
              {tab("lower",   "L3rds")}
              {tab("rtmp",    "RTMP")}
              {tab("brand",   "Brand")}
              {tab("quality", "Quality")}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0, width: "100%" }}>
            {rightTab === "guests" && (
              <GuestSidebar guests={guests} enabled={guestsEnabled} onToggle={() => setGuestsEnabled(v => !v)} onMute={toggleMute} onRemove={removeGuest} />
            )}
            {rightTab === "sources" && (
              <SourcesPanelWithEngine
                screenSources={screenSources}
                onAddScreen={addScreenSource}
                onRemoveScreen={removeScreenSource}
                smartCutId={smartCutActiveId}
                smartCutEnabled={smartCutEnabled}
                onToggleSmartCut={() => setSmartCutEnabled(v => !v)}
                hostStream={hostStream}
                guests={guests}
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
              <MultiRTMPPanel stream={hostStream} bitrateKbps={bitrateKbps} />
            )}
            {rightTab === "brand" && (
              <BrandKitPanel kit={brandKit} onChange={setBrandKit} />
            )}
            {rightTab === "quality" && (
              <QualityPanel resolution={resolution} setResolution={setResolution} bitrate={bitrate} setBitrate={setBitrate} stream={hostStream} />
            )}
            <div style={{ display: rightTab === "engine" ? "block" : "none" }}>
              <VideoEnginePanel />
            </div>
          </div>
        </div>
      </div>

      <StatusBar
        isRecording={isRecording} isStreaming={isStreaming}
        guestCount={guests.length} hostLevel={hostLevel}
        onToggleRecord={toggleRecord} stream={hostStream}
        onSaveClip={saveClip}
        smartCutEnabled={smartCutEnabled}
        onToggleSmartCut={() => setSmartCutEnabled(v => !v)}
      />

      <style>{`
        @keyframes rec-pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }
        @keyframes mic-blink  { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
        @keyframes vt-pulse   { 0%,100%{border-color:rgba(167,139,250,0.3);} 50%{border-color:rgba(167,139,250,0.8);} }
      `}</style>
    </div>
    </VideoEngineProvider>
  );
}
