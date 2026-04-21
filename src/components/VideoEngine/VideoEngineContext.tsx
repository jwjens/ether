// VideoEngineContext.tsx — Phase 0 (Electron-native) shared state for the video engine.
//
// All capture is browser-API-native: getDisplayMedia / getUserMedia / desktopCapturer
// (the last one only via main-process IPC). Sources are MediaStream objects held in
// memory here; the canvas compositor consumes them.
//
// Output flows: canvas.captureStream() → MediaRecorder → onDataAvailable → IPC chunks
// → main process pipes to ffmpeg → RTMP / MP4.
//
// This file does NOT touch Ether's existing audio chain. Audio for the stream is
// tapped from a passive MediaStreamAudioDestinationNode in Phase 4 of the rebuild;
// for now, MediaRecorder runs video-only.

import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from "react";

const ether: any = (window as any).ether;

// ── Types ───────────────────────────────────────────────────────────────────
export interface VideoSource {
  id:         string;        // local stable id
  kind:       "screen" | "window" | "camera" | "image";
  label:      string;
  stream?:    MediaStream;   // for screen/window/camera
  imageBitmap?: ImageBitmap; // for image (logo)
  width?:     number;
  height?:    number;
  thumbnailDataUrl?: string; // stable preview shown in sidebar
  externalId?: string;       // for dedupe — desktopCapturer id, deviceId, file path
}

export interface ChromaKey {
  color:      [number, number, number];
  tolerance:  number;
  smoothness: number;
}

// ── Layer effects ──────────────────────────────────────────────────────────
export interface LayerEffects {
  border?:       { color: string; width: number };        // px stroke around source
  cornerRadius?: number;                                  // px, 0 = sharp
  shadow?:       { color: string; blur: number; ox: number; oy: number }; // drop shadow
  label?:        { text: string; x: number; y: number; color: string; bg: string; size: number }; // overlay text — x/y are 0-1 canvas coords, drag to position
}

export interface SceneLayer {
  source_id:  string;
  x: number; y: number; w: number; h: number;
  z: number; opacity: number;
  chroma_key: ChromaKey | null;
  effects?:   LayerEffects | null;
}

export interface RtmpDestination {
  url: string; key: string; label: string;
  backupUrl?: string; backupKey?: string;
}

// ── Scenes ─────────────────────────────────────────────────────────────────
export interface Scene {
  id:     string;
  name:   string;
  layers: SceneLayer[];       // snapshot of the layer layout at save-time
}

export type TransitionType = "cut" | "fade" | "wipe-left" | "wipe-right" | "wipe-up" | "wipe-down";

export interface TransitionState {
  from:     SceneLayer[];      // old scene snapshot
  to:       SceneLayer[];      // target scene snapshot
  type:     TransitionType;
  duration: number;            // ms
  started:  number;            // performance.now() at start
}

export interface EncoderConfig {
  width:  number;
  height: number;
  fps:    number;
  bitrate_kbps:      number;
  keyframe_interval: number;
  codec:  string;   // "h264/auto", "h264/nvenc", "h265/software", etc.
}

export type SinkConnectionStatus = "connecting" | "connected" | "reconnecting" | "failed";

export interface VideoStatus {
  streaming: boolean;
  recording: boolean;
  fpsActual: number;
  sinks: Array<{ id: string; label: string; uptimeMs: number; framesWritten: number; status: SinkConnectionStatus }>;
  events: Array<{ type: "warning" | "recovery"; id: string; label: string; message?: string; ts: number }>;
}

export interface DesktopSourcePick {
  id: string; name: string; kind: "screen" | "window";
  thumbnailDataUrl: string;
}

export const DEFAULT_ENCODER: EncoderConfig = {
  width: 1920, height: 1080, fps: 30,
  bitrate_kbps: 6000, keyframe_interval: 2,
  codec: "h264/auto",
};

// ── Layout presets (pure math, ported from prior implementation) ────────────
export type LayoutPreset =
  | "solo" | "2up-horizontal" | "2up-vertical" | "3up" | "4up" | "pip" | "focus";

export function computePresetPlacements(preset: LayoutPreset, n: number): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  if (n === 0) return out;
  const hide = { x: 0, y: 0, w: 0, h: 0 };
  switch (preset) {
    case "solo":
      out.push({ x: 0, y: 0, w: 1, h: 1 });
      for (let i = 1; i < n; i++) out.push(hide);
      break;
    case "2up-horizontal":
      out.push({ x: 0, y: 0.15, w: 0.5, h: 0.7 });
      out.push({ x: 0.5, y: 0.15, w: 0.5, h: 0.7 });
      for (let i = 2; i < n; i++) out.push(hide);
      break;
    case "2up-vertical":
      out.push({ x: 0, y: 0, w: 1, h: 0.5 });
      out.push({ x: 0, y: 0.5, w: 1, h: 0.5 });
      for (let i = 2; i < n; i++) out.push(hide);
      break;
    case "3up":
      out.push({ x: 0, y: 0, w: 0.66, h: 1 });
      out.push({ x: 0.66, y: 0, w: 0.34, h: 0.5 });
      out.push({ x: 0.66, y: 0.5, w: 0.34, h: 0.5 });
      for (let i = 3; i < n; i++) out.push(hide);
      break;
    case "4up":
      out.push({ x: 0, y: 0, w: 0.5, h: 0.5 });
      out.push({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
      out.push({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
      out.push({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
      for (let i = 4; i < n; i++) out.push(hide);
      break;
    case "pip":
      out.push({ x: 0, y: 0, w: 1, h: 1 });
      out.push({ x: 0.68, y: 0.68, w: 0.28, h: 0.28 });
      for (let i = 2; i < n; i++) out.push(hide);
      break;
    case "focus": {
      out.push({ x: 0, y: 0, w: 1, h: 0.74 });
      const thumbs = Math.min(3, n - 1);
      if (thumbs > 0) {
        const tW = 0.3, tH = 0.22;
        const gap = (1 - thumbs * tW) / (thumbs + 1);
        for (let i = 0; i < thumbs; i++) {
          out.push({ x: gap + i * (tW + gap), y: 0.76, w: tW, h: tH });
        }
      }
      while (out.length < n) out.push(hide);
      break;
    }
  }
  return out;
}

export const LAYOUT_PRESETS: { id: LayoutPreset; label: string; icon: string }[] = [
  { id: "solo",            label: "Solo",   icon: "▢" },
  { id: "2up-horizontal",  label: "2-up H", icon: "▢▢" },
  { id: "2up-vertical",    label: "2-up V", icon: "⬓" },
  { id: "3up",             label: "3-up",   icon: "▣" },
  { id: "4up",             label: "4-up",   icon: "⊞" },
  { id: "pip",             label: "PiP",    icon: "◱" },
  { id: "focus",           label: "Focus",  icon: "◨" },
];

// ── Generic NxM grid for n ≥ 5 (centers the last row if it's not full) ──
function gridSlots(n: number): { x: number; y: number; w: number; h: number }[] {
  const slots: { x: number; y: number; w: number; h: number }[] = [];
  if (n <= 0) return slots;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const lastRow = r === rows - 1;
    const itemsInLastRow = n - cols * (rows - 1);
    if (lastRow && itemsInLastRow < cols) {
      // Center the partial last row horizontally
      const xOff = (1 - itemsInLastRow * cellW) / 2;
      const colInRow = i - cols * (rows - 1);
      slots.push({ x: xOff + colInRow * cellW, y: r * cellH, w: cellW, h: cellH });
    } else {
      slots.push({ x: c * cellW, y: r * cellH, w: cellW, h: cellH });
    }
  }
  return slots;
}

/** Auto-arrange layers based on count. Image (logo) layers are left in place
 *  so a corner bug doesn't get blown away when you add a video source. */
export function autoArrange(layers: SceneLayer[], sources: VideoSource[]): SceneLayer[] {
  // Separate image layers (untouched) from video/screen/window/camera layers (rearranged)
  const videoIdx: number[] = [];
  layers.forEach((l, i) => {
    const src = sources.find(s => s.id === l.source_id);
    if (src?.kind !== "image") videoIdx.push(i);
  });
  const n = videoIdx.length;
  let slots: { x: number; y: number; w: number; h: number }[];
  if (n === 0) return layers.map((l, i) => ({ ...l, z: i }));
  if (n === 1)      slots = computePresetPlacements("solo", 1);
  else if (n === 2) slots = computePresetPlacements("2up-horizontal", 2);
  else if (n === 3) slots = computePresetPlacements("3up", 3);
  else if (n === 4) slots = computePresetPlacements("4up", 4);
  else              slots = gridSlots(n);

  // Build a map of layer-index → new placement (for video layers only)
  const placements = new Map<number, typeof slots[0]>();
  videoIdx.forEach((origIdx, slotIdx) => {
    placements.set(origIdx, slots[slotIdx] || { x: 0, y: 0, w: 1, h: 1 });
  });

  return layers.map((l, i) => {
    const p = placements.get(i);
    if (!p) return { ...l, z: i };           // image layer — leave bounds alone
    return { ...l, x: p.x, y: p.y, w: p.w, h: p.h, z: i, opacity: 1 };
  });
}

// ── Context value ──────────────────────────────────────────────────────────
interface CtxValue {
  // Core data
  sources: VideoSource[];
  layers: SceneLayer[];
  config: EncoderConfig;
  destination: RtmpDestination;           // kept for backward compat (first dest)
  destinations: RtmpDestination[];        // multi-RTMP list
  recordPath: string;
  status: VideoStatus | null;
  encoders: string[];
  selectedLayerIdx: number | null;
  err: string;

  // Source actions — desktop picker is split: panel calls listDesktopSources,
  // shows its own modal, then calls addDesktopSource with the chosen item.
  // (Electron disables window.prompt() so we cannot prompt() in the renderer.)
  listDesktopSources: (kind: "screen" | "window") => Promise<DesktopSourcePick[]>;
  addDesktopSource: (kind: "screen" | "window", item: DesktopSourcePick) => Promise<void>;
  addCameraSource: (deviceId: string, label: string) => Promise<void>;
  addImageSource: (file: File) => Promise<string | null>;
  removeSource: (id: string) => void;

  // Scene actions
  addLayerFromSource: (sourceId: string) => void;
  patchLayer: (idx: number, patch: Partial<SceneLayer>) => void;
  removeLayer: (idx: number) => void;
  setLayers: (next: SceneLayer[]) => void;
  selectLayer: (idx: number | null) => void;
  applyLayoutPreset: (preset: LayoutPreset) => void;

  // Scenes
  scenes: Scene[];
  activeSceneId: string | null;
  transition: TransitionState | null;
  transitionType: TransitionType;
  transitionDuration: number;
  saveScene: (name: string) => void;
  loadScene: (id: string) => void;
  deleteScene: (id: string) => void;
  renameScene: (id: string, name: string) => void;
  updateScene: (id: string) => void;
  setTransitionType: (t: TransitionType) => void;
  setTransitionDuration: (ms: number) => void;
  finishTransition: () => void;

  // Config / destination
  setConfig: (c: EncoderConfig) => void;
  setDestination: (d: RtmpDestination) => void;
  setDestinations: (ds: RtmpDestination[]) => void;
  addDestination: (d: RtmpDestination) => void;
  removeDestination: (idx: number) => void;
  patchDestination: (idx: number, patch: Partial<RtmpDestination>) => void;
  setRecordPath: (p: string) => void;

  // Stream / record control — these need access to the canvas's captureStream,
  // which is owned by VideoEngineCanvas. The canvas calls registerCanvasStream
  // during mount; this context invokes it when starting a sink.
  registerCaptureStream: (stream: MediaStream | null) => void;
  startStream: () => Promise<void>;
  stopStream:  () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording:  () => Promise<void>;

  // Camera enumeration helper for the picker
  listCameras: () => Promise<MediaDeviceInfo[]>;

  setErr: (s: string) => void;
}

const VideoEngineContext = createContext<CtxValue | null>(null);

export function useVideoEngine(): CtxValue {
  const ctx = useContext(VideoEngineContext);
  if (!ctx) throw new Error("useVideoEngine() must be used inside <VideoEngineProvider>");
  return ctx;
}

// ── Provider ───────────────────────────────────────────────────────────────
export function VideoEngineProvider({ children }: { children: React.ReactNode }) {
  const [sources, setSources] = useState<VideoSource[]>([]);
  const [layers, setLayersState] = useState<SceneLayer[]>([]);
  const [config, setConfig] = useState<EncoderConfig>(DEFAULT_ENCODER);
  const [destinations, setDestinations] = useState<RtmpDestination[]>([
    { url: "rtmp://a.rtmp.youtube.com/live2", key: "", label: "Destination 1" },
  ]);
  // Backward compat: the first destination is the "primary" one.
  const destination = destinations[0] || { url: "", key: "", label: "" };
  const setDestination = useCallback((d: RtmpDestination) => {
    setDestinations(prev => { const n = [...prev]; n[0] = d; return n; });
  }, []);
  const addDestination = useCallback((d: RtmpDestination) => {
    setDestinations(prev => [...prev, d]);
  }, []);
  const removeDestination = useCallback((idx: number) => {
    setDestinations(prev => prev.filter((_, i) => i !== idx));
  }, []);
  const patchDestination = useCallback((idx: number, patch: Partial<RtmpDestination>) => {
    setDestinations(prev => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
  }, []);
  const [recordPath, setRecordPath] = useState<string>("");
  const [status, setStatus] = useState<VideoStatus | null>(null);
  const [encoders, setEncoders] = useState<string[]>([]);
  const [selectedLayerIdx, setSelectedLayerIdx] = useState<number | null>(null);
  const [err, setErr] = useState<string>("");

  // Captured stream from <canvas> is registered by VideoEngineCanvas.
  const captureStreamRef = useRef<MediaStream | null>(null);
  // MediaRecorders for active stream and recording sinks.
  const streamRecRef = useRef<MediaRecorder | null>(null);
  const recordRecRef = useRef<MediaRecorder | null>(null);
  // Live ref to sources so callbacks can read the latest without staleness.
  const sourcesRef = useRef<VideoSource[]>([]);
  useEffect(() => { sourcesRef.current = sources; }, [sources]);

  // ── Scene state ──────────────────────────────────────────────────────
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [transition, setTransition] = useState<TransitionState | null>(null);
  const [transitionType, setTransitionType] = useState<TransitionType>("fade");
  const [transitionDuration, setTransitionDuration] = useState(500); // ms

  const saveScene = useCallback((name: string) => {
    const id = `scene_${Date.now().toString(36)}`;
    setScenes(prev => [...prev, { id, name, layers: [...layers] }]);
    setActiveSceneId(id);
  }, [layers]);

  const updateScene = useCallback((id: string) => {
    setScenes(prev => prev.map(s => s.id === id ? { ...s, layers: [...layers] } : s));
  }, [layers]);

  const deleteScene = useCallback((id: string) => {
    setScenes(prev => prev.filter(s => s.id !== id));
    if (activeSceneId === id) setActiveSceneId(null);
  }, [activeSceneId]);

  const renameScene = useCallback((id: string, name: string) => {
    setScenes(prev => prev.map(s => s.id === id ? { ...s, name } : s));
  }, []);

  // loadScene: when a transition type is "cut", switch immediately.
  // For fade/wipe, set up the transition state, and the canvas will blend
  // between old → new over the duration. When transition completes, the
  // canvas calls setTransition(null).
  const loadScene = useCallback((id: string) => {
    const scene = scenes.find(s => s.id === id);
    if (!scene) return;
    if (transitionType === "cut" || transitionDuration < 50) {
      setLayersState(scene.layers.map((l, i) => ({ ...l, z: i })));
      setActiveSceneId(id);
      setTransition(null);
    } else {
      setTransition({
        from: [...layers],
        to: scene.layers.map((l, i) => ({ ...l, z: i })),
        type: transitionType,
        duration: transitionDuration,
        started: performance.now(),
      });
      // Immediately set the active scene id, but delay layer swap
      // until the transition completes (handled in canvas).
      setActiveSceneId(id);
    }
  }, [scenes, layers, transitionType, transitionDuration]);

  // Called by VideoEngineCanvas when the transition animation finishes.
  const finishTransition = useCallback(() => {
    if (transition) {
      setLayersState(transition.to);
      setTransition(null);
    }
  }, [transition]);

  // ── Initial encoder enum ──────────────────────────────────────────────
  useEffect(() => {
    if (!ether?.video?.listEncoders) {
      setErr("ether.video bridge missing — restart Ether after preload changes.");
      return;
    }
    ether.video.listEncoders().then(setEncoders).catch(() => setEncoders([]));
  }, []);

  // ── Status polling every 500 ms ───────────────────────────────────────
  useEffect(() => {
    if (!ether?.video?.getStatus) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await ether.video.getStatus();
        if (alive) {
          setStatus({ ...s, fpsActual: s.fpsActual ?? 0 });
          // Broadcast to App.tsx so the header indicator dot can show/hide
          // without lifting VideoEngineProvider out of the Studio tree.
          window.dispatchEvent(new CustomEvent("ether:video-status", {
            detail: { streaming: !!s.streaming, recording: !!s.recording },
          }));
        }
      } catch {}
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // ── Source actions ────────────────────────────────────────────────────
  const listDesktopSources = useCallback(async (kind: "screen" | "window"): Promise<DesktopSourcePick[]> => {
    if (!ether?.video?.listSources) {
      setErr("ether.video bridge missing. Fully QUIT Ether (close the window AND kill the Electron process), then run npm run electron:dev again.");
      return [];
    }
    const items = await ether.video.listSources([kind]);
    if (!Array.isArray(items)) {
      setErr(`ether.video.listSources returned ${typeof items}, not an array. Fully restart Electron.`);
      return [];
    }
    return items;
  }, []);

  const addDesktopSource = useCallback(async (kind: "screen" | "window", item: DesktopSourcePick) => {
    try {
      // Dedupe: if a source already references this exact desktopCapturer id, bail.
      const dupeId = item.id;
      let dupe = false;
      setSources(prev => {
        if (prev.some(s => s.externalId === dupeId)) { dupe = true; }
        return prev;
      });
      if (dupe) {
        setErr(`"${item.name}" is already in your sources. Click → Scene to use it again, or remove and re-add.`);
        return;
      }
      // Modern Electron: pre-stage the source ID in main, then trigger
      // getDisplayMedia. The handler returns this source plus loopback audio
      // (Windows) so streams/recordings get system sound automatically.
      await ether.video.setDesktopSource(item.id);
      const stream: MediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
        audio: true,   // ask for audio; main handler returns 'loopback' on Windows
      });
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      const id = `${kind}_${Date.now().toString(36)}`;
      setSources(prev => [...prev, {
        id, kind, label: item.name, stream,
        width: settings.width, height: settings.height,
        thumbnailDataUrl: item.thumbnailDataUrl,
        externalId: item.id,
      }]);
      setErr("");
    } catch (e: any) { setErr(`${kind} capture failed: ${e?.message || e}`); }
  }, []);

  const addCameraSource = useCallback(async (deviceId: string, label: string) => {
    try {
      let dupe = false;
      setSources(prev => {
        if (prev.some(s => s.externalId === deviceId)) { dupe = true; }
        return prev;
      });
      if (dupe) {
        setErr(`Camera "${label}" is already in your sources.`);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: deviceId }, width: 1280, height: 720, frameRate: 30 },
      });
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      const id = `cam_${Date.now().toString(36)}`;
      setSources(prev => [...prev, {
        id, kind: "camera", label, stream,
        width: settings.width, height: settings.height,
        externalId: deviceId,
      }]);
      setErr("");
    } catch (e: any) { setErr(`Camera failed: ${e?.message || e}`); }
  }, []);

  const addImageSource = useCallback(async (file: File): Promise<string | null> => {
    try {
      const bmp = await createImageBitmap(file);
      const id = `img_${Date.now().toString(36)}`;
      setSources(prev => [...prev, {
        id, kind: "image", label: file.name,
        imageBitmap: bmp, width: bmp.width, height: bmp.height,
      }]);
      return id;
    } catch (e: any) { setErr(`Image load failed: ${e?.message || e}`); return null; }
  }, []);

  const removeSource = useCallback((id: string) => {
    setSources(prev => {
      const t = prev.find(s => s.id === id);
      if (t?.stream) t.stream.getTracks().forEach(tr => tr.stop());
      if (t?.imageBitmap) t.imageBitmap.close();
      return prev.filter(s => s.id !== id);
    });
    setLayersState(prev => {
      const filtered = prev.filter(l => l.source_id !== id);
      // Use the post-removal sources list for layout. We can't read sources
      // synchronously here (state update queued) — so build it manually.
      const nextSources = sourcesRef.current.filter(s => s.id !== id);
      return autoArrange(filtered, nextSources);
    });
  }, []);

  // ── Scene actions ─────────────────────────────────────────────────────
  // Auto-arrange on add: 1 → solo, 2 → 2-up, 3 → 3-up, 4 → 4-up, 5+ → grid.
  // Image (logo) layers keep their position so a corner bug doesn't get reset.
  const addLayerFromSource = useCallback((sourceId: string) => {
    setLayersState(prev => {
      const newLayer: SceneLayer = {
        source_id: sourceId, x: 0, y: 0, w: 1, h: 1,
        z: prev.length, opacity: 1, chroma_key: null,
      };
      return autoArrange([...prev, newLayer], sourcesRef.current);
    });
  }, []);

  const patchLayer = useCallback((idx: number, patch: Partial<SceneLayer>) => {
    setLayersState(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  }, []);

  // Auto-rebalance on remove too — if you have 4 sources tiled and pull one,
  // the remaining 3 collapse into the 3-up arrangement automatically.
  const removeLayer = useCallback((idx: number) => {
    setLayersState(prev => {
      const filtered = prev.filter((_, i) => i !== idx);
      return autoArrange(filtered, sourcesRef.current);
    });
    setSelectedLayerIdx(null);
  }, []);

  const setLayers = useCallback((next: SceneLayer[]) => setLayersState(next), []);

  const applyLayoutPreset = useCallback((preset: LayoutPreset) => {
    setLayersState(prev => {
      const slots = computePresetPlacements(preset, prev.length);
      return prev.map((l, i) => {
        const s = slots[i] || { x: 0, y: 0, w: 0, h: 0 };
        return { ...l, x: s.x, y: s.y, w: s.w, h: s.h, z: i, opacity: 1 };
      });
    });
  }, []);

  // ── Stream / record ───────────────────────────────────────────────────
  const registerCaptureStream = useCallback((stream: MediaStream | null) => {
    captureStreamRef.current = stream;
  }, []);

  const buildRecorder = useCallback((onChunk: (chunk: Uint8Array) => void): MediaRecorder | null => {
    const videoStream = captureStreamRef.current;
    if (!videoStream) { setErr("Canvas capture stream not ready yet."); return null; }

    // Build a combined stream: canvas video track + first available audio track
    // from any active source. (Phase 4 audio: getDisplayMedia returns the
    // screen source's loopback audio on Windows when audio: true is requested.)
    const combined = new MediaStream();
    videoStream.getVideoTracks().forEach(t => combined.addTrack(t));
    let audioFound = false;
    for (const src of sources) {
      if (!src.stream) continue;
      const at = src.stream.getAudioTracks();
      if (at.length > 0) {
        combined.addTrack(at[0]);
        audioFound = true;
        break;   // one audio track for now; Phase 5 mixer can sum multiple
      }
    }

    // mp4 from MediaRecorder isn't widely supported in Chromium; webm + ffmpeg remux.
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? "video/webm;codecs=vp8,opus"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const rec = new MediaRecorder(combined, {
      mimeType: mime,
      videoBitsPerSecond: config.bitrate_kbps * 1000,
      audioBitsPerSecond: 128_000,
    });
    rec.ondataavailable = async (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      const ab = await ev.data.arrayBuffer();
      onChunk(new Uint8Array(ab));
    };
    rec.start(200);
    if (!audioFound) {
      console.warn("[video] no audio track in any source — stream/recording will be silent");
    }
    return rec;
  }, [config.bitrate_kbps, sources]);

  // Multi-destination: spawn one ffmpeg per destination; they all receive the
  // same WebM chunks from a single MediaRecorder via pushChunk().
  const startStream = useCallback(async () => {
    const validDests = destinations.filter(d => d.url && d.url.length > 8);
    if (validDests.length === 0) { setErr("Add at least one RTMP destination."); return; }
    const errors: string[] = [];
    for (let i = 0; i < validDests.length; i++) {
      const d = validDests[i];
      const sinkId = validDests.length === 1 ? "stream" : `stream:${i}`;
      try {
        const r = await ether.video.startStream({
          url: d.url, key: d.key, label: d.label || `Dest ${i + 1}`,
          backupUrl: d.backupUrl || null, backupKey: d.backupKey || null,
          fps: config.fps, bitrate_kbps: config.bitrate_kbps,
          keyframe_interval: config.keyframe_interval, codec: config.codec,
          sinkId,
        });
        console.log(`[video] stream sink ${sinkId} started:`, r);
      } catch (e: any) {
        errors.push(`${d.label || d.url}: ${e?.message || e}`);
      }
    }
    // Only build ONE MediaRecorder — pushChunk broadcasts to all sinks.
    const rec = buildRecorder((chunk) => {
      ether.video.pushChunk(chunk).catch(() => {});
    });
    if (!rec) { await ether.video.stopStream(); return; }
    streamRecRef.current = rec;
    if (errors.length > 0) setErr(`Some destinations failed: ${errors.join("; ")}`);
    else setErr("");
  }, [destinations, config, buildRecorder]);

  const stopStream = useCallback(async () => {
    try {
      if (streamRecRef.current) { try { streamRecRef.current.stop(); } catch {} streamRecRef.current = null; }
      // Stop ALL stream sinks (no sinkId = stop all stream:* sinks)
      await ether.video.stopStream();
    } catch (e: any) { setErr(`Stop stream: ${e?.message || e}`); }
  }, []);

  const startRecording = useCallback(async () => {
    if (!recordPath) { setErr("Choose recording path first."); return; }
    try {
      await ether.video.startRecording({
        filePath: recordPath,
        fps: config.fps, bitrate_kbps: config.bitrate_kbps,
        keyframe_interval: config.keyframe_interval, codec: config.codec,
      });
      const rec = buildRecorder((chunk) => {
        ether.video.pushChunk(chunk).catch(() => {});
      });
      if (!rec) { await ether.video.stopRecording(); return; }
      recordRecRef.current = rec;
      setErr("");
    } catch (e: any) { setErr(`Start record: ${e?.message || e}`); }
  }, [recordPath, config, buildRecorder]);

  const stopRecording = useCallback(async () => {
    try {
      if (recordRecRef.current) { try { recordRecRef.current.stop(); } catch {} recordRecRef.current = null; }
      await ether.video.stopRecording();
    } catch (e: any) { setErr(`Stop record: ${e?.message || e}`); }
  }, []);

  // ── Camera enumeration ──────────────────────────────────────────────
  const listCameras = useCallback(async (): Promise<MediaDeviceInfo[]> => {
    try {
      // Some browsers require a getUserMedia call before they'll fully label devices.
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter(d => d.kind === "videoinput");
    } catch { return []; }
  }, []);

  const value: CtxValue = {
    sources, layers, config, destination, destinations, recordPath, status, encoders,
    selectedLayerIdx, err,
    // Scenes
    scenes, activeSceneId, transition, transitionType, transitionDuration,
    saveScene, loadScene, deleteScene, renameScene, updateScene,
    setTransitionType, setTransitionDuration, finishTransition,
    // Sources
    listDesktopSources, addDesktopSource, addCameraSource, addImageSource, removeSource,
    addLayerFromSource, patchLayer, removeLayer, setLayers,
    selectLayer: setSelectedLayerIdx, applyLayoutPreset,
    setConfig, setDestination, setDestinations, addDestination, removeDestination, patchDestination,
    setRecordPath,
    registerCaptureStream, startStream, stopStream, startRecording, stopRecording,
    listCameras, setErr,
  };

  return (
    <VideoEngineContext.Provider value={value}>
      {children}
    </VideoEngineContext.Provider>
  );
}

