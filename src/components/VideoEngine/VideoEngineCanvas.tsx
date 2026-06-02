// VideoEngineCanvas.tsx — Phase 0 main-area preview.
//
// • One <canvas> at the configured resolution
// • Per-source hidden <video> elements consume each MediaStream
// • requestAnimationFrame loop draws each layer (drawImage + globalAlpha)
//     into the canvas, sorted by z
// • canvas.captureStream() is registered with the context so the
//     MediaRecorder for streaming/recording attaches to the SAME pixels users
//     see in the preview
// • Layer overlays (8-handle resize / drag / snap) for direct manipulation
// • Layout-preset chip strip across the top
// • LIVE / REC indicator top-right

import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  useVideoEngine, SceneLayer, VideoSource,
  LAYOUT_PRESETS, LayoutPreset,
} from "./VideoEngineContext";

// ── Color tokens (match Studio.tsx) ──────────────────────────────────────
const BG0 = "#0e0e14", BG1 = "#111114", BG3 = "#1e1e28";
const BOR = "#2a2a38";
const TXT = "#e8e8f0", TXT2 = "#8888a8";
const PUR = "#7858c8", GRN = "#22c55e", RED = "#ef4444", AMB = "#f59e0b";

const SNAP_PCT = 0.01;     // snap within 1% of an edge / center

type DragMode = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface DragState {
  layerIdx: number;
  mode: DragMode;
  startMx: number;     // 0..1 normalized canvas coords
  startMy: number;
  orig: { x: number; y: number; w: number; h: number };
}

interface LabelDragState {
  layerIdx: number;
  startMx: number;     // 0..1
  startMy: number;
  origX: number;       // original label x
  origY: number;       // original label y
}

export default function VideoEngineCanvas() {
  const eng = useVideoEngine();
  const { sources, layers, config, status, selectedLayerIdx, selectLayer,
          patchLayer, applyLayoutPreset, registerCaptureStream,
          transition, finishTransition } = eng;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef    = useRef<HTMLCanvasElement | null>(null);
  // Per-source hidden <video> elements bound to MediaStreams. Keyed by source id.
  const videoElsRef  = useRef<Map<string, HTMLVideoElement>>(new Map());
  // Offscreen canvases for chroma-key processing. Keyed by `${layerIdx}` since
  // we want a per-layer scratch canvas; size is reset whenever the layer
  // changes dimensions.
  const offscreenRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const rafRef       = useRef<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [labelDrag, setLabelDrag] = useState<LabelDragState | null>(null);

  // ── Maintain hidden <video> per stream source ─────────────────────────
  useEffect(() => {
    const els = videoElsRef.current;
    // Add new
    for (const s of sources) {
      if (s.kind === "image") continue;
      if (!s.stream) continue;
      if (!els.has(s.id)) {
        console.log("[CANVAS] Creating hidden video for source", s.id, s.label, {
          kind: s.kind,
          streamId: s.stream?.id,
          audioTracks: s.stream?.getAudioTracks().length,
          videoTracks: s.stream?.getVideoTracks().length,
        });
        const v = document.createElement("video");
        v.autoplay = true;
        v.muted = true;
        v.playsInline = true;
        v.srcObject = s.stream;
        v.style.display = "none";
        document.body.appendChild(v);
        v.play().catch(() => {});
        els.set(s.id, v);
      }
    }
    // Remove gone
    for (const id of Array.from(els.keys())) {
      if (!sources.find(s => s.id === id)) {
        const v = els.get(id);
        if (v) { try { v.srcObject = null; v.remove(); } catch {} }
        els.delete(id);
      }
    }
  }, [sources]);

  // ── Setup canvas + register captureStream ────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width  = config.width;
    cv.height = config.height;
    // captureStream is what MediaRecorder samples; register with context
    const captured = (cv as any).captureStream(config.fps) as MediaStream;
    registerCaptureStream(captured);
    return () => {
      try { captured.getTracks().forEach(t => t.stop()); } catch {}
      registerCaptureStream(null);
    };
  }, [config.width, config.height, config.fps, registerCaptureStream]);

  // ── Composite render loop ────────────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    let alive = true;
    const lastLog = new Map<string, number>();
    const draw = () => {
      if (!alive) return;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cv.width, cv.height);

      // Iterate layers sorted by z ascending (higher z drawn on top)
      const sorted = [...layers].sort((a, b) => a.z - b.z);
      const usedOffscreenKeys = new Set<string>();
      for (let i = 0; i < sorted.length; i++) {
        const layer = sorted[i];
        const src = sources.find(s => s.id === layer.source_id);
        if (!src) continue;
        const dx = layer.x * cv.width;
        const dy = layer.y * cv.height;
        const dw = layer.w * cv.width;
        const dh = layer.h * cv.height;
        if (dw <= 1 || dh <= 1) continue;

        ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));

        // Choose pixel source
        let pixelSource: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap | null = null;
        let srcW = 0, srcH = 0;
        if (src.kind === "image" && src.imageBitmap) {
          pixelSource = src.imageBitmap;
          srcW = src.imageBitmap.width; srcH = src.imageBitmap.height;
        } else {
          const v = videoElsRef.current.get(src.id);
          if (!v || v.readyState < 2) {
            if (v && v.readyState < 2 && Date.now() - (lastLog.get(src.id) ?? 0) > 2000) {
              console.log("[CANVAS] Video not ready for source", src.id, src.label, "readyState=", v.readyState);
              lastLog.set(src.id, Date.now());
            }
            continue;
          }
          pixelSource = v;
          srcW = v.videoWidth || 1; srcH = v.videoHeight || 1;
        }
        if (!pixelSource) continue;

        // ── Pre-draw: shadow (drawn before the source) ──
        const fx = layer.effects;
        if (fx?.shadow) {
          ctx.shadowColor   = fx.shadow.color;
          ctx.shadowBlur    = fx.shadow.blur;
          ctx.shadowOffsetX = fx.shadow.ox;
          ctx.shadowOffsetY = fx.shadow.oy;
        }

        // ── Rounded corners clip ──
        const hasRadius = fx?.cornerRadius && fx.cornerRadius > 0;
        if (hasRadius) {
          ctx.save();
          const r = fx!.cornerRadius!;
          ctx.beginPath();
          ctx.moveTo(dx + r, dy);
          ctx.lineTo(dx + dw - r, dy);
          ctx.quadraticCurveTo(dx + dw, dy, dx + dw, dy + r);
          ctx.lineTo(dx + dw, dy + dh - r);
          ctx.quadraticCurveTo(dx + dw, dy + dh, dx + dw - r, dy + dh);
          ctx.lineTo(dx + r, dy + dh);
          ctx.quadraticCurveTo(dx, dy + dh, dx, dy + dh - r);
          ctx.lineTo(dx, dy + r);
          ctx.quadraticCurveTo(dx, dy, dx + r, dy);
          ctx.closePath();
          ctx.clip();
        }

        // Chroma-key path: render to per-layer offscreen, mutate alpha, blit
        if (layer.chroma_key) {
          const key = `${i}`;
          usedOffscreenKeys.add(key);
          const offW = Math.max(2, Math.floor(dw));
          const offH = Math.max(2, Math.floor(dh));
          let off = offscreenRef.current.get(key);
          if (!off) {
            off = document.createElement("canvas");
            offscreenRef.current.set(key, off);
          }
          if (off.width !== offW || off.height !== offH) {
            off.width = offW; off.height = offH;
          }
          const offCtx = off.getContext("2d", { willReadFrequently: true });
          if (!offCtx) { if (hasRadius) ctx.restore(); continue; }
          // Draw scaled into offscreen
          offCtx.drawImage(pixelSource as CanvasImageSource, 0, 0, offW, offH);
          // Read pixels, mutate alpha
          let imgData: ImageData;
          try { imgData = offCtx.getImageData(0, 0, offW, offH); }
          catch { if (hasRadius) ctx.restore(); continue; }
          applyChromaKey(imgData, layer.chroma_key);
          offCtx.putImageData(imgData, 0, 0);
          ctx.drawImage(off, dx, dy);
        } else {
          ctx.drawImage(pixelSource as CanvasImageSource, dx, dy, dw, dh);
        }

        // Reset shadow after the source draw so it doesn't affect border/label
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

        if (hasRadius) ctx.restore();

        // ── Border — drawn ON TOP of the source pixels ──
        if (fx?.border && fx.border.width > 0) {
          ctx.strokeStyle = fx.border.color;
          ctx.lineWidth = fx.border.width;
          if (hasRadius) {
            const r = fx.cornerRadius!;
            ctx.beginPath();
            ctx.moveTo(dx + r, dy);
            ctx.lineTo(dx + dw - r, dy);
            ctx.quadraticCurveTo(dx + dw, dy, dx + dw, dy + r);
            ctx.lineTo(dx + dw, dy + dh - r);
            ctx.quadraticCurveTo(dx + dw, dy + dh, dx + dw - r, dy + dh);
            ctx.lineTo(dx + r, dy + dh);
            ctx.quadraticCurveTo(dx, dy + dh, dx, dy + dh - r);
            ctx.lineTo(dx, dy + r);
            ctx.quadraticCurveTo(dx, dy, dx + r, dy);
            ctx.closePath();
            ctx.stroke();
          } else {
            ctx.strokeRect(dx, dy, dw, dh);
          }
        }

        // ── Text label overlay — drawn at absolute canvas x/y coords ──
        // The label's x/y are 0-1 canvas-normalized. Users drag labels
        // via the DOM overlay (hand cursor) — see LabelOverlay below.
        if (fx?.label && fx.label.text) {
          const lbl = fx.label;
          const fontSize = lbl.size || 16;
          ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
          const tm = ctx.measureText(lbl.text);
          const pad = 6;
          const labelH = fontSize + pad * 2;
          const labelW = tm.width + pad * 2;
          const lx = lbl.x * cv.width;
          const ly = lbl.y * cv.height;
          // Background pill
          ctx.fillStyle = lbl.bg || "rgba(0,0,0,0.6)";
          ctx.fillRect(lx, ly, labelW, labelH);
          // Text
          ctx.fillStyle = lbl.color || "#fff";
          ctx.textBaseline = "middle";
          ctx.fillText(lbl.text, lx + pad, ly + labelH / 2);
        }
      }

      // GC offscreen canvases for layers that no longer exist or no longer
      // have chroma-key set. Done this way so the Map doesn't grow forever.
      for (const k of Array.from(offscreenRef.current.keys())) {
        if (!usedOffscreenKeys.has(k)) offscreenRef.current.delete(k);
      }

      // ── Transition overlay — blend "to" scene layers over the current frame ──
      if (transition) {
        const elapsed = performance.now() - transition.started;
        const t = Math.min(1, elapsed / transition.duration); // 0→1 progress
        const toSorted = [...transition.to].sort((a, b) => a.z - b.z);

        if (transition.type === "fade") {
          ctx.globalAlpha = t;
          drawLayerSet(ctx, cv, toSorted, sources, videoElsRef.current);
        } else if (transition.type.startsWith("wipe-")) {
          ctx.save();
          const dir = transition.type.replace("wipe-", "");
          if (dir === "left") {
            ctx.beginPath();
            ctx.rect(cv.width * (1 - t), 0, cv.width * t, cv.height);
            ctx.clip();
          } else if (dir === "right") {
            ctx.beginPath();
            ctx.rect(0, 0, cv.width * t, cv.height);
            ctx.clip();
          } else if (dir === "up") {
            ctx.beginPath();
            ctx.rect(0, cv.height * (1 - t), cv.width, cv.height * t);
            ctx.clip();
          } else if (dir === "down") {
            ctx.beginPath();
            ctx.rect(0, 0, cv.width, cv.height * t);
            ctx.clip();
          }
          ctx.globalAlpha = 1;
          drawLayerSet(ctx, cv, toSorted, sources, videoElsRef.current);
          ctx.restore();
        }

        if (t >= 1) { finishTransition(); }
      }

      ctx.globalAlpha = 1;
      rafRef.current = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [layers, sources]);

  // ── Drag handling on overlay handles ─────────────────────────────────
  const beginDrag = useCallback((idx: number, mode: DragMode) => (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width;
    const my = (e.clientY - r.top)  / r.height;
    const l = layers[idx];
    if (!l) return;
    selectLayer(idx);
    setDrag({
      layerIdx: idx, mode, startMx: mx, startMy: my,
      orig: { x: l.x, y: l.y, w: l.w, h: l.h },
    });
  }, [layers, selectLayer]);

  useEffect(() => {
    if (!drag) return;
    const el = containerRef.current;
    if (!el) return;
    const onMove = (ev: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const mx = (ev.clientX - r.left) / r.width;
      const my = (ev.clientY - r.top)  / r.height;
      const dx = mx - drag.startMx;
      const dy = my - drag.startMy;
      let { x, y, w, h } = drag.orig;
      switch (drag.mode) {
        case "move": x = drag.orig.x + dx; y = drag.orig.y + dy; break;
        case "n":  y = drag.orig.y + dy; h = drag.orig.h - dy; break;
        case "s":  h = drag.orig.h + dy; break;
        case "e":  w = drag.orig.w + dx; break;
        case "w":  x = drag.orig.x + dx; w = drag.orig.w - dx; break;
        case "ne": y = drag.orig.y + dy; h = drag.orig.h - dy; w = drag.orig.w + dx; break;
        case "nw": x = drag.orig.x + dx; y = drag.orig.y + dy; w = drag.orig.w - dx; h = drag.orig.h - dy; break;
        case "se": w = drag.orig.w + dx; h = drag.orig.h + dy; break;
        case "sw": x = drag.orig.x + dx; w = drag.orig.w - dx; h = drag.orig.h + dy; break;
      }
      const MIN = 0.03;
      if (w < MIN) { if (drag.mode.includes("w")) x = drag.orig.x + drag.orig.w - MIN; w = MIN; }
      if (h < MIN) { if (drag.mode.includes("n")) y = drag.orig.y + drag.orig.h - MIN; h = MIN; }
      // Snap to 0 / 0.5 / 1 / thirds within SNAP_PCT
      const candidates = [0, 1/3, 0.5, 2/3, 1];
      const snap = (v: number) => {
        for (const c of candidates) if (Math.abs(v - c) < SNAP_PCT) return c;
        return v;
      };
      if (drag.mode === "move") {
        const nx = snap(x), nrt = snap(x + w);
        if (nx !== x) x = nx; else if (nrt !== x + w) x = nrt - w;
        const ny = snap(y), nbt = snap(y + h);
        if (ny !== y) y = ny; else if (nbt !== y + h) y = nbt - h;
      } else {
        if (drag.mode.includes("w")) { const nx = snap(x); w += (x - nx); x = nx; }
        if (drag.mode.includes("e")) { const re = snap(x + w); w = re - x; }
        if (drag.mode.includes("n")) { const ny = snap(y); h += (y - ny); y = ny; }
        if (drag.mode.includes("s")) { const be = snap(y + h); h = be - y; }
      }
      x = Math.max(0, Math.min(1, x));
      y = Math.max(0, Math.min(1, y));
      w = Math.max(MIN, Math.min(1 - x, w));
      h = Math.max(MIN, Math.min(1 - y, h));
      patchLayer(drag.layerIdx, { x, y, w, h });
    };
    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [drag, patchLayer]);

  // ── Label drag handling ──────────────────────────────────────────────
  const beginLabelDrag = useCallback((layerIdx: number) => (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width;
    const my = (e.clientY - r.top)  / r.height;
    const lbl = layers[layerIdx]?.effects?.label;
    if (!lbl) return;
    selectLayer(layerIdx);
    setLabelDrag({ layerIdx, startMx: mx, startMy: my, origX: lbl.x, origY: lbl.y });
  }, [layers, selectLayer]);

  useEffect(() => {
    if (!labelDrag) return;
    const el = containerRef.current;
    if (!el) return;
    const onMove = (ev: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const mx = (ev.clientX - r.left) / r.width;
      const my = (ev.clientY - r.top)  / r.height;
      const dx = mx - labelDrag.startMx;
      const dy = my - labelDrag.startMy;
      let nx = labelDrag.origX + dx;
      let ny = labelDrag.origY + dy;
      // Clamp so label stays inside canvas
      nx = Math.max(0, Math.min(0.95, nx));
      ny = Math.max(0, Math.min(0.95, ny));
      const layer = layers[labelDrag.layerIdx];
      if (layer?.effects?.label) {
        patchLayer(labelDrag.layerIdx, {
          effects: { ...layer.effects, label: { ...layer.effects.label, x: nx, y: ny } },
        });
      }
    };
    const onUp = () => setLabelDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [labelDrag, layers, patchLayer]);

  const onCanvasClick = () => selectLayer(null);

  // Keyboard nudge
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selectedLayerIdx === null) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      const l = layers[selectedLayerIdx];
      if (!l) return;
      const step = e.shiftKey ? 0.05 : 0.01;
      let patch: Partial<SceneLayer> | null = null;
      if (e.key === "ArrowLeft")  patch = { x: Math.max(0, l.x - step) };
      if (e.key === "ArrowRight") patch = { x: Math.min(1 - l.w, l.x + step) };
      if (e.key === "ArrowUp")    patch = { y: Math.max(0, l.y - step) };
      if (e.key === "ArrowDown")  patch = { y: Math.min(1 - l.h, l.y + step) };
      if (patch) { e.preventDefault(); patchLayer(selectedLayerIdx, patch); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedLayerIdx, layers, patchLayer]);

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      width: "100%", height: "100%",
      background: BG0, color: TXT,
      fontFamily: "Inter, system-ui, sans-serif",
    }}>
      {/* ── Layout preset strip ───────────────────────────────────── */}
      <div style={{
        padding: "8px 12px", background: BG1, borderBottom: `1px solid ${BOR}`,
        display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, color: TXT2, letterSpacing: "0.12em", marginRight: 10, fontWeight: 800 }}>
          LAYOUT
        </span>
        {LAYOUT_PRESETS.map(p => (
          <button
            key={p.id}
            onClick={() => applyLayoutPreset(p.id as LayoutPreset)}
            disabled={layers.length === 0}
            style={{
              padding: "7px 13px", borderRadius: 0,
              background: BG3, color: layers.length === 0 ? TXT2 : TXT,
              border: `1px solid ${BOR}`,
              fontSize: 12, fontWeight: 700,
              cursor: layers.length === 0 ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", gap: 6,
              opacity: layers.length === 0 ? 0.45 : 1,
            }}
          >
            <span style={{ fontSize: 15, fontFamily: "ui-monospace, monospace" }}>{p.icon}</span>
            <span>{p.label}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <LiveIndicator status={status} />
      </div>

      {/* ── Canvas area ──────────────────────────────────────────── */}
      <div style={{
        flex: 1, padding: 16, display: "flex",
        alignItems: "center", justifyContent: "center",
        minHeight: 0, overflow: "hidden", background: "#050507",
      }}>
        <div
          ref={containerRef}
          onMouseDown={onCanvasClick}
          style={{
            position: "relative", aspectRatio: "16 / 9",
            maxHeight: "100%", maxWidth: "100%",
            width: "auto", height: "100%",
            background: "#000", border: `1px solid ${BOR}`,
            boxShadow: "0 0 40px rgba(0,0,0,0.8)",
            overflow: "hidden",
            cursor: drag ? "grabbing" : labelDrag ? "grabbing" : "default",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", pointerEvents: "none" }}
          />
          {layers.length === 0 && (
            <div style={{
              position: "absolute", inset: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: TXT2, fontSize: 13, pointerEvents: "none",
            }}>
              Add a source from the sidebar → drop it into a layout
            </div>
          )}
          {layers.map((layer, idx) => (
            <LayerOverlay
              key={idx} layer={layer}
              selected={selectedLayerIdx === idx}
              sourceLabel={sources.find(s => s.id === layer.source_id)?.label || layer.source_id}
              onBeginDrag={(mode) => beginDrag(idx, mode)}
              onSelect={() => selectLayer(idx)}
            />
          ))}
          {/* Draggable label overlays — hand cursor, grab to move */}
          {layers.map((layer, idx) => {
            const lbl = layer.effects?.label;
            if (!lbl || !lbl.text) return null;
            return (
              <div
                key={`label-${idx}`}
                onMouseDown={beginLabelDrag(idx)}
                title={`Drag to reposition "${lbl.text}"`}
                style={{
                  position: "absolute",
                  left:  `${lbl.x * 100}%`,
                  top:   `${lbl.y * 100}%`,
                  cursor: labelDrag?.layerIdx === idx ? "grabbing" : "grab",
                  pointerEvents: "auto",
                  zIndex: 100,
                  // Visual: match the canvas-drawn label so the overlay aligns perfectly
                  padding: "0 6px",
                  fontSize: lbl.size || 16,
                  fontWeight: 700,
                  fontFamily: "Inter, system-ui, sans-serif",
                  lineHeight: `${(lbl.size || 16) + 12}px`,
                  background: "transparent",  // canvas draws the background — this is just the hit target
                  color: "transparent",        // invisible text — the canvas draws the real text
                  border: selectedLayerIdx === idx ? `1px dashed ${AMB}` : "1px solid transparent",
                  whiteSpace: "nowrap" as const,
                  userSelect: "none" as const,
                }}
              >
                {lbl.text}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Selected-layer strip ──────────────────────────────────── */}
      {selectedLayerIdx !== null && layers[selectedLayerIdx] && (
        <SelectedLayerStrip
          layer={layers[selectedLayerIdx]}
          label={sources.find(s => s.id === layers[selectedLayerIdx].source_id)?.label || ""}
          onPatch={(p) => patchLayer(selectedLayerIdx, p)}
        />
      )}
    </div>
  );
}

// ── Layer overlay with handles ──────────────────────────────────────────
function LayerOverlay({
  layer, selected, sourceLabel, onBeginDrag, onSelect,
}: {
  layer: SceneLayer; selected: boolean; sourceLabel: string;
  onBeginDrag: (mode: DragMode) => (e: React.MouseEvent) => void;
  onSelect: () => void;
}) {
  if (layer.w < 0.02 || layer.h < 0.02) return null;
  const box: React.CSSProperties = {
    position: "absolute",
    left:   `${layer.x * 100}%`,
    top:    `${layer.y * 100}%`,
    width:  `${layer.w * 100}%`,
    height: `${layer.h * 100}%`,
  };
  const borderCol = selected ? PUR : "#ffffff55";
  return (
    <div
      onMouseDown={(e) => { e.stopPropagation(); onSelect(); onBeginDrag("move")(e); }}
      style={{
        ...box,
        border: `1px ${selected ? "solid" : "dashed"} ${borderCol}`,
        boxShadow: selected ? `0 0 0 2px ${PUR}66` : "none",
        cursor: "move",
      }}
    >
      <div style={{
        position: "absolute", top: -20, left: -1, padding: "1px 6px",
        background: selected ? PUR : "#00000088", color: "#fff",
        fontSize: 9, fontWeight: 700, whiteSpace: "nowrap" as const,
        pointerEvents: "none", letterSpacing: 0.3,
      }}>
        {sourceLabel}{selected && layer.opacity < 1 ? ` · ${Math.round(layer.opacity * 100)}%` : ""}
      </div>
      {selected && (
        <>
          <Handle pos="nw" onDown={onBeginDrag("nw")} />
          <Handle pos="n"  onDown={onBeginDrag("n")} />
          <Handle pos="ne" onDown={onBeginDrag("ne")} />
          <Handle pos="e"  onDown={onBeginDrag("e")} />
          <Handle pos="se" onDown={onBeginDrag("se")} />
          <Handle pos="s"  onDown={onBeginDrag("s")} />
          <Handle pos="sw" onDown={onBeginDrag("sw")} />
          <Handle pos="w"  onDown={onBeginDrag("w")} />
        </>
      )}
    </div>
  );
}

function Handle({ pos, onDown }: { pos: DragMode; onDown: (e: React.MouseEvent) => void }) {
  const size = 10;
  const cursor: Record<string, string> = {
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize",
  };
  const style: React.CSSProperties = {
    position: "absolute", width: size, height: size,
    background: "#fff", border: `1px solid ${PUR}`,
    boxShadow: "0 0 4px rgba(0,0,0,0.4)", cursor: cursor[pos] || "default",
  };
  switch (pos) {
    case "nw": style.left = -size/2; style.top = -size/2; break;
    case "n":  style.left = `calc(50% - ${size/2}px)`; style.top = -size/2; break;
    case "ne": style.right = -size/2; style.top = -size/2; break;
    case "e":  style.right = -size/2; style.top = `calc(50% - ${size/2}px)`; break;
    case "se": style.right = -size/2; style.bottom = -size/2; break;
    case "s":  style.left = `calc(50% - ${size/2}px)`; style.bottom = -size/2; break;
    case "sw": style.left = -size/2; style.bottom = -size/2; break;
    case "w":  style.left = -size/2; style.top = `calc(50% - ${size/2}px)`; break;
  }
  return <div style={style} onMouseDown={onDown} />;
}

function SelectedLayerStrip({ layer, label, onPatch }: {
  layer: SceneLayer; label: string; onPatch: (p: Partial<SceneLayer>) => void;
}) {
  const [showChroma, setShowChroma] = useState(false);
  const ck = layer.chroma_key;
  return (
    <div style={{
      padding: "6px 12px", background: BG1, borderTop: `1px solid ${BOR}`,
      display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
      fontSize: 10, color: TXT2, position: "relative" as const,
    }}>
      <span style={{ color: PUR, fontWeight: 700 }}>{label}</span>
      <span>position <span style={{ color: TXT, fontFamily: "ui-monospace, monospace" }}>
        {Math.round(layer.x * 100)},{Math.round(layer.y * 100)}
      </span></span>
      <span>size <span style={{ color: TXT, fontFamily: "ui-monospace, monospace" }}>
        {Math.round(layer.w * 100)}×{Math.round(layer.h * 100)}
      </span></span>
      <span>opacity</span>
      <input
        type="range" min={0} max={1} step={0.01} value={layer.opacity}
        onChange={(e) => onPatch({ opacity: +e.target.value })}
        style={{ width: 100, accentColor: PUR }}
      />
      <span style={{ color: TXT, fontFamily: "ui-monospace, monospace" }}>
        {layer.opacity.toFixed(2)}
      </span>
      <button
        onClick={() => setShowChroma(o => !o)}
        style={{
          padding: "3px 10px", fontSize: 10, fontWeight: 600, cursor: "pointer",
          background: ck ? `${GRN}22` : BG3,
          color: ck ? GRN : TXT,
          border: `1px solid ${ck ? GRN : BOR}`,
          borderRadius: 0, letterSpacing: 0.3,
        }}
      >
        Chroma {ck ? "ON" : "OFF"} ▾
      </button>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 9, color: TXT2 }}>arrows = nudge · shift+arrow = coarse</span>

      {showChroma && (
        <ChromaPopover
          chroma={ck}
          onChange={(next) => onPatch({ chroma_key: next })}
          onClose={() => setShowChroma(false)}
        />
      )}
    </div>
  );
}

function ChromaPopover({ chroma, onChange, onClose }: {
  chroma: { color: [number, number, number]; tolerance: number; smoothness: number } | null;
  onChange: (next: any) => void;
  onClose: () => void;
}) {
  const enabled = !!chroma;
  const ensure = () => chroma || { color: [0, 255, 0] as [number, number, number], tolerance: 0.3, smoothness: 0.1 };
  return (
    <div
      onMouseLeave={onClose}
      style={{
        position: "absolute" as const,
        right: 12, bottom: "100%", marginBottom: 4,
        width: 280, padding: 10,
        background: BG1, border: `1px solid ${BOR}`,
        boxShadow: "0 8px 24px rgba(0,0,0,0.7)",
        zIndex: 50, fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", marginBottom: 8,
        fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: TXT2,
      }}>
        <span style={{ flex: 1 }}>CHROMA KEY</span>
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: TXT }}>
          <input
            type="checkbox" checked={enabled}
            onChange={(e) => onChange(e.target.checked ? ensure() : null)}
          />
          <span>{enabled ? "ON" : "OFF"}</span>
        </label>
      </div>
      {enabled && chroma && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: TXT2, width: 70 }}>Key color</span>
            <input
              type="color"
              value={rgbToHex(chroma.color)}
              onChange={(e) => onChange({ ...chroma, color: hexToRgb(e.target.value) })}
              style={{ flex: 1, height: 24, background: "#000", border: `1px solid ${BOR}`, cursor: "pointer" }}
            />
            <button
              onClick={() => onChange({ ...chroma, color: [0, 255, 0] })}
              title="Reset to classic green"
              style={{
                padding: "3px 6px", fontSize: 9, background: BG3, color: GRN,
                border: `1px solid ${BOR}`, cursor: "pointer", borderRadius: 0,
              }}
            >green</button>
          </div>
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: TXT2, marginBottom: 2 }}>
              <span>Tolerance</span>
              <span style={{ color: TXT, fontFamily: "ui-monospace, monospace" }}>
                {chroma.tolerance.toFixed(2)}
              </span>
            </div>
            <input
              type="range" min={0} max={1} step={0.01} value={chroma.tolerance}
              onChange={(e) => onChange({ ...chroma, tolerance: +e.target.value })}
              style={{ width: "100%", accentColor: GRN }}
            />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: TXT2, marginBottom: 2 }}>
              <span>Smoothness</span>
              <span style={{ color: TXT, fontFamily: "ui-monospace, monospace" }}>
                {chroma.smoothness.toFixed(2)}
              </span>
            </div>
            <input
              type="range" min={0.01} max={1} step={0.01} value={chroma.smoothness}
              onChange={(e) => onChange({ ...chroma, smoothness: +e.target.value })}
              style={{ width: "100%", accentColor: GRN }}
            />
          </div>
          <div style={{ fontSize: 9, color: TXT2, marginTop: 6, lineHeight: 1.4 }}>
            Tolerance = how close to the key color counts as fully transparent.
            Smoothness = how wide the soft edge is past tolerance.
          </div>
        </>
      )}
    </div>
  );
}

function rgbToHex(rgb: [number, number, number]): string {
  return "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("");
}
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/.{2}/g);
  if (!m) return [0, 0, 0];
  return [parseInt(m[0], 16), parseInt(m[1], 16), parseInt(m[2], 16)];
}

// ── Chroma key — per-pixel alpha based on RGB distance to key color ─────
//
// Tolerance:  fully transparent inside this distance from the key color
// Smoothness: soft fall-off width past the tolerance edge
// Distance is normalized 0..1 against sqrt(3)·255 = 441.67.
function applyChromaKey(
  img: ImageData,
  key: { color: [number, number, number]; tolerance: number; smoothness: number },
) {
  const data = img.data;
  const kr = key.color[0], kg = key.color[1], kb = key.color[2];
  const tol = Math.max(0, Math.min(1, key.tolerance));
  const smooth = Math.max(0.001, Math.min(1, key.smoothness));
  const N = data.length;
  for (let i = 0; i < N; i += 4) {
    const dr = data[i]     - kr;
    const dg = data[i + 1] - kg;
    const db = data[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.67;
    // 0 inside tolerance, 1 past tolerance + smooth, smooth in between
    const t = (dist - tol) / smooth;
    const a = t <= 0 ? 0 : t >= 1 ? 1 : t;
    // Multiply existing alpha so we preserve any incoming alpha (e.g. PNG logos)
    data[i + 3] = (data[i + 3] * a) | 0;
  }
}

// ── Draw a full set of layers (used by transitions to render the target scene) ─
function drawLayerSet(
  ctx: CanvasRenderingContext2D,
  cv:  HTMLCanvasElement,
  sortedLayers: SceneLayer[],
  sources: VideoSource[],
  videoEls: Map<string, HTMLVideoElement>,
) {
  for (const layer of sortedLayers) {
    const src = sources.find(s => s.id === layer.source_id);
    if (!src) continue;
    const dx = layer.x * cv.width;
    const dy = layer.y * cv.height;
    const dw = layer.w * cv.width;
    const dh = layer.h * cv.height;
    if (dw <= 1 || dh <= 1) continue;
    let pixelSource: CanvasImageSource | null = null;
    if (src.kind === "image" && src.imageBitmap) {
      pixelSource = src.imageBitmap;
    } else {
      const v = videoEls.get(src.id);
      if (!v || v.readyState < 2) continue;
      pixelSource = v;
    }
    if (!pixelSource) continue;
    ctx.drawImage(pixelSource, dx, dy, dw, dh);
  }
}

function LiveIndicator({ status }: { status: any }) {
  const live = !!status?.streaming;
  const rec  = !!status?.recording;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "3px 8px", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
        background: live ? RED : BG3, color: live ? "#fff" : TXT2,
        border: `1px solid ${live ? RED : BOR}`,
      }}>
        <div style={{
          width: 6, height: 6, background: live ? "#fff" : "#555",
          animation: live ? "vepulse 1s ease-in-out infinite" : undefined,
        }} />
        {live ? "LIVE" : "OFF AIR"}
      </div>
      {rec && (
        <div style={{
          display: "flex", alignItems: "center", gap: 5,
          padding: "3px 8px", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
          background: RED, color: "#fff", border: `1px solid ${RED}`,
        }}>
          <div style={{ width: 6, height: 6, background: "#fff", borderRadius: "50%" }} />
          REC
        </div>
      )}
      <style>{`@keyframes vepulse{0%,100%{opacity:1;}50%{opacity:0.3;}}`}</style>
    </div>
  );
}
