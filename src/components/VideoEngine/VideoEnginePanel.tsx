// VideoEnginePanel.tsx — Phase 0 right-sidebar.
//
// Source picker (Screen / Window / Camera / Logo)
// Scene layer list (drag to reorder z, click to select, × to delete)
// Encoder pick (codec family + hardware)
// Single RTMP destination + Go Live
// Recording path + Start/Stop
// Status

import React, { useState } from "react";
import {
  useVideoEngine, SceneLayer, RtmpDestination, EncoderConfig, VideoSource,
  TransitionType, LayerEffects,
} from "./VideoEngineContext";

// Local type for the desktop-source picker modal
interface DesktopPick { id: string; name: string; kind: "screen" | "window"; thumbnailDataUrl: string; }

// Common RTMP destinations — selecting one fills the URL field
const RTMP_PRESETS: { id: string; name: string; url: string; help: string }[] = [
  { id: "youtube",  name: "YouTube Live",  url: "rtmp://a.rtmp.youtube.com/live2",      help: "Get key from studio.youtube.com → Go Live" },
  { id: "twitch",   name: "Twitch",        url: "rtmp://live.twitch.tv/app",            help: "Get key from dashboard.twitch.tv → Stream Key" },
  { id: "facebook", name: "Facebook Live", url: "rtmps://live-api-s.facebook.com:443/rtmp/", help: "Get key from facebook.com/live/producer" },
  { id: "x",        name: "X (Twitter)",   url: "rtmp://va.contribute.live-video.net/app",  help: "Get key from X studio" },
  { id: "kick",     name: "Kick",          url: "rtmps://fa723fc1b171.global-contribute.live-video.net/app/", help: "Get key from kick.com → Settings → Stream Key" },
  { id: "custom",   name: "Custom RTMP",   url: "rtmp://",                              help: "Self-hosted RTMP server, OBS Restream, etc." },
];

// ── Color tokens ─────────────────────────────────────────────────────────
const BG0 = "#0e0e14", BG1 = "#111114", BG2 = "#18181f", BG3 = "#1e1e28";
const BOR = "#2a2a38";
const TXT = "#e8e8f0", TXT2 = "#8888a8";
const PUR = "#7858c8", GRN = "#22c55e", RED = "#ef4444", AMB = "#f59e0b";

const ether: any = (window as any).ether;

function withSequentialZ(layers: SceneLayer[]): SceneLayer[] {
  return layers.map((l, i) => ({ ...l, z: i }));
}

export default function VideoEnginePanel() {
  const eng = useVideoEngine();
  const {
    sources, layers, config, destinations, recordPath, status, encoders,
    selectedLayerIdx, err, setErr,
    listDesktopSources, addDesktopSource,
    addCameraSource, addImageSource, removeSource,
    addLayerFromSource, removeLayer, setLayers, selectLayer,
    setConfig, addDestination, removeDestination, patchDestination, setRecordPath,
    startStream, stopStream, startRecording, stopRecording,
    listCameras,
    removeGuestSource,
  } = eng;

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [showCamPicker, setShowCamPicker] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [desktopPicker, setDesktopPicker] = useState<{ kind: "screen" | "window"; items: DesktopPick[] } | null>(null);

  const openDesktopPicker = async (kind: "screen" | "window") => {
    const items = await listDesktopSources(kind);
    if (items.length === 0) { setErr(`No ${kind}s detected.`); return; }
    if (items.length === 1) { addDesktopSource(kind, items[0]); return; }
    setDesktopPicker({ kind, items });
  };

  const onDragStart = (idx: number) => (e: React.DragEvent) => {
    setDragFrom(idx);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragOver !== idx) setDragOver(idx);
  };
  const onDrop = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragFrom; setDragFrom(null); setDragOver(null);
    if (from === null || from === idx) return;
    const next = [...layers];
    const [moved] = next.splice(from, 1);
    next.splice(idx, 0, moved);
    setLayers(withSequentialZ(next));
    if (selectedLayerIdx === from) selectLayer(idx);
    else if (selectedLayerIdx !== null) {
      if (from < selectedLayerIdx && idx >= selectedLayerIdx) selectLayer(selectedLayerIdx - 1);
      else if (from > selectedLayerIdx && idx <= selectedLayerIdx) selectLayer(selectedLayerIdx + 1);
    }
  };

  const openCameraPicker = async () => {
    const cams = await listCameras();
    if (cams.length === 0) {
      setErr("No cameras detected. Check permissions.");
      return;
    }
    if (cams.length === 1) {
      addCameraSource(cams[0].deviceId, cams[0].label || "Camera");
      return;
    }
    setCameras(cams);
    setShowCamPicker(true);
  };

  const chooseLogo = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const id = await addImageSource(f);
      if (id) {
        // Auto-place as a bottom-right logo bug
        setLayers([...layers, {
          source_id: id, x: 0.82, y: 0.04, w: 0.15, h: 0.12,
          z: layers.length, opacity: 1, chroma_key: null,
        }]);
      }
    };
    input.click();
  };

  const chooseRecordPath = async () => {
    try {
      const res: any = await ether.invoke("dialog:saveFile", {
        defaultPath: `recording_${Date.now()}.mp4`,
        filters: [{ name: "Video", extensions: ["mp4"] }],
      });
      const path = typeof res === "string" ? res : (res?.filePath || res?.path || "");
      if (path) setRecordPath(path);
    } catch {
      const p = prompt("Recording file path:");
      if (p) setRecordPath(p);
    }
  };

  const isStreaming = !!status?.streaming;
  const isRecording = !!status?.recording;

  return (
    <div style={{ padding: 12, color: TXT, fontSize: 12, fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{
        padding: "6px 10px", background: BG1, border: `1px solid ${BOR}`,
        marginBottom: 8, display: "flex", alignItems: "center", gap: 8,
      }}>
        <Led on={!!status} label="ENGINE" />
        <Led on={isStreaming} color={PUR} label="LIVE" />
        <Led on={isRecording} color={RED} label="REC" />
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10, color: TXT2 }}>
          {status ? `${status.sinks.length} sink${status.sinks.length === 1 ? "" : "s"}` : "—"}
        </span>
      </div>

      {err && (
        <div style={{
          padding: "6px 10px", background: "#3b1f22", border: `1px solid ${RED}`,
          color: "#ffb7bc", fontSize: 10, marginBottom: 8, whiteSpace: "pre-wrap",
        }}>
          {err}
          <button onClick={() => setErr("")}
            style={{ float: "right" as const, background: "transparent", border: "none", color: RED, cursor: "pointer", fontSize: 12, padding: 0 }}
          >×</button>
        </div>
      )}

      {/* Sources */}
      <Section title="SOURCES">
        <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
          <Btn onClick={() => openDesktopPicker("screen")}>+ Screen</Btn>
          <Btn onClick={() => openDesktopPicker("window")}>+ Window</Btn>
          <Btn onClick={openCameraPicker}>+ Camera</Btn>
          <Btn onClick={chooseLogo}>+ Logo</Btn>
        </div>
        {sources.length === 0 && (
          <div style={{ fontSize: 9, color: TXT2, padding: "4px 0" }}>
            No sources yet. Add one to start composing.
          </div>
        )}
        {sources.filter(s => s.kind !== "guest").map(s => {
          const GUEST_PUR = "#a855f7";
          const accent = s.kind === "screen" ? GRN
                       : s.kind === "camera" ? PUR
                       : s.kind === "image"  ? AMB
                       : s.kind === "guest"  ? GUEST_PUR
                       :                       "#888";
          const isGuest = s.kind === "guest";
          const icon = s.kind === "camera" ? "▶"
                     : s.kind === "image"  ? "⬢"
                     : s.kind === "guest"  ? "◉"
                     : "▦";
          const isHost = s.externalId === "host";
          const sceneLayerIdx = layers.findIndex(l => l.source_id === s.id);
          const onScene = sceneLayerIdx !== -1;
          const handleRemove = () => {
            if (isGuest) {
              const guestId = s.externalId?.replace("guest:", "") ?? "";
              removeGuestSource(guestId);
            } else {
              removeSource(s.id);
            }
          };
          return (
            <div key={s.id}
              style={{
                display: "flex", alignItems: "center", gap: 6, padding: "5px 4px",
                borderBottom: `1px solid ${BG3}`,
                borderLeft: isGuest ? `2px solid ${GUEST_PUR}` : "2px solid transparent",
              }}
            >
              {s.thumbnailDataUrl ? (
                <img src={s.thumbnailDataUrl} alt=""
                  style={{ width: 36, height: 22, objectFit: "contain" as const,
                           background: "#000", border: `1px solid ${BG3}`, flexShrink: 0 }} />
              ) : (
                <div style={{ width: 36, height: 22, background: BG3, border: `1px solid ${BG3}`,
                              color: accent, display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 13, flexShrink: 0 }}>
                  {icon}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
                  {s.label}
                </div>
                <div style={{ fontSize: 8, color: TXT2, textTransform: "uppercase" as const, letterSpacing: 0.4 }}>
                  {isGuest ? (
                    <span style={{
                      color: "#fff", background: GUEST_PUR,
                      padding: "1px 4px", fontSize: 7, fontWeight: 700, letterSpacing: "0.06em",
                      marginRight: 4,
                    }}>GUEST</span>
                  ) : (
                    <span style={{ color: accent }}>{s.kind}</span>
                  )}
                  {s.width && s.height && ` · ${s.width}×${s.height}`}
                  {s.stream && s.stream.getAudioTracks().length > 0 && " · audio"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button
                  onClick={() => onScene ? removeLayer(sceneLayerIdx) : addLayerFromSource(s.id)}
                  title={onScene ? "Remove from scene" : "Add to scene"}
                  style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: onScene ? "#6b21a8" : "#14b8a6", border: "none", color: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer", lineHeight: 1, borderRadius: 0 }}
                >{onScene ? "−" : "+"}</button>
                {!isHost && (
                  <button
                    onClick={handleRemove}
                    title={isGuest ? "Remove from sources (guest stays connected)" : "Remove source"}
                    style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: "#ef4444", border: "none", color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", lineHeight: 1, borderRadius: 0 }}
                  >×</button>
                )}
              </div>
            </div>
          );
        })}
      </Section>

      {/* Screen / window picker modal — replaces the deprecated prompt() */}
      {desktopPicker && (
        <div
          onClick={() => setDesktopPicker(null)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
        >
          <div onClick={(e) => e.stopPropagation()}
            style={{
              background: BG1, border: `1px solid ${BOR}`, padding: 14,
              minWidth: 480, maxWidth: 720, maxHeight: "80vh", overflowY: "auto",
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", marginBottom: 10,
              fontSize: 11, fontWeight: 700, color: TXT2, letterSpacing: "0.08em",
            }}>
              <span style={{ flex: 1 }}>SELECT {desktopPicker.kind.toUpperCase()}</span>
              <button onClick={() => setDesktopPicker(null)}
                style={{ background: "transparent", border: "none", color: TXT2, fontSize: 14, cursor: "pointer" }}
              >×</button>
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 8,
            }}>
              {desktopPicker.items.map(item => (
                <button key={item.id}
                  onClick={() => {
                    addDesktopSource(desktopPicker.kind, item);
                    setDesktopPicker(null);
                  }}
                  style={{
                    background: BG3, border: `1px solid ${BOR}`,
                    padding: 6, cursor: "pointer", color: TXT,
                    display: "flex", flexDirection: "column" as const, gap: 4,
                    textAlign: "left" as const,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = PUR; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = BOR; }}
                >
                  {item.thumbnailDataUrl ? (
                    <img src={item.thumbnailDataUrl} alt={item.name}
                      style={{ width: "100%", aspectRatio: "16/9", objectFit: "contain" as const, background: "#000", border: `1px solid ${BG3}` }} />
                  ) : (
                    <div style={{ width: "100%", aspectRatio: "16/9", background: "#000", border: `1px solid ${BG3}` }} />
                  )}
                  <span style={{ fontSize: 10, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {item.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Camera picker modal */}
      {showCamPicker && (
        <div
          onClick={() => setShowCamPicker(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
        >
          <div onClick={(e) => e.stopPropagation()}
            style={{
              background: BG1, border: `1px solid ${BOR}`, padding: 14,
              minWidth: 360, maxWidth: 520, maxHeight: "80vh", overflowY: "auto",
            }}
          >
            <div style={{
              display: "flex", alignItems: "center", marginBottom: 10,
              fontSize: 11, fontWeight: 700, color: TXT2, letterSpacing: "0.08em",
            }}>
              <span style={{ flex: 1 }}>SELECT CAMERA</span>
              <button onClick={() => setShowCamPicker(false)}
                style={{ background: "transparent", border: "none", color: TXT2, fontSize: 14, cursor: "pointer" }}
              >×</button>
            </div>
            {cameras.map(c => (
              <button key={c.deviceId}
                onClick={() => { addCameraSource(c.deviceId, c.label || `Camera ${c.deviceId.slice(0, 6)}`); setShowCamPicker(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "8px 10px", marginBottom: 6,
                  background: BG3, color: TXT, border: `1px solid ${BOR}`,
                  fontSize: 11, cursor: "pointer", textAlign: "left" as const,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = PUR; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = BOR; }}
              >
                <div style={{ width: 36, height: 22, background: "#000", border: `1px solid ${BG3}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              color: PUR, fontSize: 13, flexShrink: 0 }}>▶</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.label || c.deviceId}
                  </div>
                  <div style={{ fontSize: 8, color: TXT2, marginTop: 1 }}>
                    {c.deviceId.slice(0, 16)}…
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scene */}
      <Section title={`SCENE (${layers.length})`}>
        {layers.length === 0 && (
          <div style={{ fontSize: 9, color: TXT2, padding: "4px 0" }}>
            Drag layers around on the main preview, or click a layout preset above.
          </div>
        )}
        {layers.map((l, i) => {
          const src = sources.find(s => s.id === l.source_id);
          const selected = selectedLayerIdx === i;
          const isOver = dragOver === i && dragFrom !== null && dragFrom !== i;
          return (
            <div key={i}
              draggable
              onDragStart={onDragStart(i)}
              onDragOver={onDragOver(i)}
              onDrop={onDrop(i)}
              onClick={() => selectLayer(selected ? null : i)}
              style={{
                display: "flex", alignItems: "center", gap: 4, padding: "4px 2px",
                borderBottom: `1px solid ${BG3}`,
                borderTop: isOver ? `2px solid ${PUR}` : "2px solid transparent",
                cursor: "grab", userSelect: "none" as const,
                background: selected ? BG3 : dragFrom === i ? "rgba(120,88,200,0.1)" : undefined,
                opacity: dragFrom === i ? 0.5 : 1,
              }}
            >
              <div style={{ width: 12, color: TXT2, fontSize: 10, lineHeight: 1 }}>⋮⋮</div>
              <div style={{ width: 16, color: TXT2, fontSize: 9 }}>z{l.z}</div>
              <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {src?.label || l.source_id}
              </div>
              <div style={{ fontSize: 9, color: TXT2, fontFamily: "ui-monospace, monospace" }}>
                {Math.round(l.x * 100)}/{Math.round(l.y * 100)} · {Math.round(l.w * 100)}×{Math.round(l.h * 100)}
              </div>
              <Btn small danger onClick={(e) => { e.stopPropagation(); removeLayer(i); }}>×</Btn>
            </div>
          );
        })}
      </Section>

      {/* Layer effects — always visible, prompts to select if nothing selected */}
      {(() => {
        if (selectedLayerIdx === null || !layers[selectedLayerIdx]) {
          return (
            <Section title="EFFECTS">
              <div style={{ fontSize: 9, color: TXT2, padding: "6px 2px" }}>
                Click a layer in the scene list{layers.length > 0 ? " above" : ""} or on the canvas to edit its effects (border, shadow, text label).
              </div>
            </Section>
          );
        }
        const selLayer = layers[selectedLayerIdx];
        const fx = selLayer.effects || {};
        const patch = (next: any) => eng.patchLayer(selectedLayerIdx, { effects: { ...fx, ...next } });
        const src = sources.find(s => s.id === selLayer.source_id);
        return (
          <Section title={`EFFECTS — ${src?.label || "Layer"}`}>
            {/* Border */}
            <Row>
              <Label>Border</Label>
              <input type="number" value={fx.border?.width ?? 0} min={0} max={20} step={1}
                onChange={e => patch({ border: { color: fx.border?.color || "#ffffff", width: +e.target.value } })}
                style={{ ...inStyle, width: 42, textAlign: "right" as const }} />
              <span style={{ fontSize: 8, color: TXT2 }}>px</span>
              <input type="color" value={fx.border?.color || "#ffffff"}
                onChange={e => patch({ border: { width: fx.border?.width || 2, color: e.target.value } })}
                style={{ width: 22, height: 18, padding: 0, border: `1px solid ${BOR}`, cursor: "pointer" }} />
            </Row>
            {/* Corner radius */}
            <Row>
              <Label>Radius</Label>
              <input type="range" min={0} max={100} step={1}
                value={fx.cornerRadius ?? 0}
                onChange={e => patch({ cornerRadius: +e.target.value })}
                style={{ flex: 1 }} />
              <span style={{ fontSize: 9, color: TXT2, fontFamily: "ui-monospace", minWidth: 24, textAlign: "right" as const }}>{fx.cornerRadius ?? 0}</span>
            </Row>
            {/* Shadow */}
            <Row>
              <Label>Shadow</Label>
              <input type="number" value={fx.shadow?.blur ?? 0} min={0} max={50} step={1}
                onChange={e => patch({ shadow: { color: fx.shadow?.color || "rgba(0,0,0,0.5)", blur: +e.target.value, ox: fx.shadow?.ox ?? 4, oy: fx.shadow?.oy ?? 4 } })}
                style={{ ...inStyle, width: 36, textAlign: "right" as const }} />
              <span style={{ fontSize: 8, color: TXT2 }}>blur</span>
              <input type="color" value={fx.shadow?.color || "#000000"}
                onChange={e => patch({ shadow: { blur: fx.shadow?.blur || 10, color: e.target.value, ox: fx.shadow?.ox ?? 4, oy: fx.shadow?.oy ?? 4 } })}
                style={{ width: 22, height: 18, padding: 0, border: `1px solid ${BOR}`, cursor: "pointer" }} />
            </Row>
            {/* Label — text overlay, drag on canvas to position */}
            <Row>
              <Label>Label</Label>
              <input type="text" value={fx.label?.text ?? ""}
                onChange={e => {
                  // Default to bottom-left of the parent source on first type
                  const x = fx.label?.x ?? selLayer.x + 0.01;
                  const y = fx.label?.y ?? (selLayer.y + selLayer.h - 0.05);
                  patch({ label: { text: e.target.value, x, y, color: fx.label?.color || "#ffffff", bg: fx.label?.bg || "rgba(0,0,0,0.6)", size: fx.label?.size || 16 } });
                }}
                placeholder="Text overlay"
                style={{ ...inStyle, flex: 1 }} />
            </Row>
            {fx.label?.text && (
              <>
                <Row>
                  <Label>Size</Label>
                  <input type="range" min={8} max={48} step={1}
                    value={fx.label?.size ?? 16}
                    onChange={e => patch({ label: { ...fx.label!, size: +e.target.value } })}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 9, color: TXT2, fontFamily: "ui-monospace", minWidth: 24, textAlign: "right" as const }}>{fx.label?.size ?? 16}px</span>
                </Row>
                <Row>
                  <Label>Colors</Label>
                  <span style={{ fontSize: 8, color: TXT2 }}>Text</span>
                  <input type="color" value={fx.label?.color || "#ffffff"}
                    onChange={e => patch({ label: { ...fx.label!, color: e.target.value } })}
                    style={{ width: 22, height: 18, padding: 0, border: `1px solid ${BOR}`, cursor: "pointer" }} />
                  <span style={{ fontSize: 8, color: TXT2, marginLeft: 4 }}>Bg</span>
                  <input type="color" value={fx.label?.bg || "#000000"}
                    onChange={e => patch({ label: { ...fx.label!, bg: e.target.value } })}
                    style={{ width: 22, height: 18, padding: 0, border: `1px solid ${BOR}`, cursor: "pointer" }} />
                </Row>
                <div style={{ fontSize: 8, color: AMB, marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 11 }}>✋</span> Drag the label on the canvas to position it
                </div>
              </>
            )}
            {/* Reset all effects */}
            <div style={{ marginTop: 4 }}>
              <Btn small onClick={() => eng.patchLayer(selectedLayerIdx, { effects: null })}>Reset Effects</Btn>
            </div>
          </Section>
        );
      })()}

      {/* Scenes — save/load named scene layouts */}
      <Section title="SCENES">
        <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
          <Btn onClick={() => {
            const name = `Scene ${eng.scenes.length + 1}`;
            eng.saveScene(name);
          }}>+ Save Current</Btn>
        </div>
        {eng.scenes.length === 0 && (
          <div style={{ fontSize: 9, color: TXT2, padding: "4px 0" }}>
            No saved scenes yet. Click "Save Current" to snapshot the current layout.
          </div>
        )}
        {eng.scenes.map(sc => {
          const isActive = eng.activeSceneId === sc.id;
          return (
            <div key={sc.id} style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 4px",
              borderBottom: `1px solid ${BG3}`,
              background: isActive ? "rgba(120,88,200,0.12)" : undefined,
            }}>
              <div style={{
                width: 6, height: 6, background: isActive ? PUR : "#333",
                boxShadow: isActive ? `0 0 4px ${PUR}` : "none", flexShrink: 0,
              }} />
              <div
                style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, cursor: "pointer" }}
                onClick={() => eng.loadScene(sc.id)}
                title={`Switch to "${sc.name}" (${sc.layers.length} layers)`}
              >
                {sc.name}
              </div>
              <span style={{ fontSize: 8, color: TXT2, flexShrink: 0 }}>{sc.layers.length}L</span>
              <Btn small onClick={() => eng.updateScene(sc.id)} title="Overwrite with current layout">⟳</Btn>
              <Btn small danger onClick={() => eng.deleteScene(sc.id)}>×</Btn>
            </div>
          );
        })}
        {/* Transition config */}
        <div style={{ marginTop: 6, padding: "4px 0", borderTop: `1px solid ${BG3}` }}>
          <Row>
            <Label>Transition</Label>
            <select value={eng.transitionType} onChange={e => eng.setTransitionType(e.target.value as TransitionType)} style={selStyle}>
              <option value="cut">Cut</option>
              <option value="fade">Cross Fade</option>
              <option value="wipe-left">Wipe Left</option>
              <option value="wipe-right">Wipe Right</option>
              <option value="wipe-up">Wipe Up</option>
              <option value="wipe-down">Wipe Down</option>
            </select>
          </Row>
          {eng.transitionType !== "cut" && (
            <Row>
              <Label>Duration</Label>
              <NumInput value={eng.transitionDuration} onChange={v => eng.setTransitionDuration(v)} suffix="ms" min={100} max={3000} step={100} />
            </Row>
          )}
        </div>
      </Section>

      {/* Encoder moved to the QUALITY tab (EncoderSection) — de-dup */}

      {/* RTMP destinations moved to the SHOW+ tab (DestinationsSection) — de-dup */}

      {/* Recording */}
      <Section title="RECORDING">
        <Row>
          <input
            value={recordPath}
            readOnly
            placeholder="No file chosen"
            style={{ ...inStyle, flex: 1, cursor: "pointer" }}
            onClick={chooseRecordPath}
          />
          <Btn small onClick={chooseRecordPath}>…</Btn>
        </Row>
        <div style={{ marginTop: 4 }}>
          {isRecording ? (
            <Btn danger onClick={stopRecording} style={{ width: "100%" }}>◼ Stop Recording</Btn>
          ) : (
            <Btn red onClick={startRecording} style={{ width: "100%" }}>● Start Recording</Btn>
          )}
        </div>
      </Section>

      {/* Status */}
      <Section title="STATUS">
        {status?.sinks.length === 0 && (
          <div style={{ fontSize: 9, color: TXT2 }}>Idle — no active sinks.</div>
        )}
        {status?.sinks.map(s => (
          <Row key={s.id}>
            <div style={{ flex: 1, fontSize: 10 }}>{s.label}</div>
            <div style={{ fontSize: 9, color: TXT2, fontFamily: "ui-monospace, monospace" }}>
              {Math.floor(s.uptimeMs / 1000)}s · {s.framesWritten} chunks
            </div>
          </Row>
        ))}
        <div style={{ fontSize: 9, color: TXT2, marginTop: 6 }}>
          Phase 0 — video-only. Audio routing arrives in Phase 4.
        </div>
      </Section>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        padding: "9px 14px", background: BG2, borderBottom: `1px solid ${BOR}`,
        fontSize: 11, fontWeight: 800, color: TXT, letterSpacing: "0.1em", marginBottom: 12,
        textTransform: "uppercase" as const,
      }}>{title}</div>
      <div style={{ padding: "0 4px" }}>{children}</div>
    </div>
  );
}

function Row({ children, onClick, style }: { children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; style?: React.CSSProperties }) {
  return (
    <div onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "8px 4px",
        borderBottom: `1px solid ${BG3}`, ...style,
      }}
    >{children}</div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ width: 92, fontSize: 12, fontWeight: 600, color: TXT2, flexShrink: 0 }}>{children}</div>;
}

function Btn({ children, onClick, small, danger, red, pur, style, title }: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  small?: boolean; danger?: boolean; red?: boolean; pur?: boolean;
  style?: React.CSSProperties; title?: string;
}) {
  const bg = danger ? "#401a20" : red ? "#401a20" : pur ? "#1f1a3a" : BG3;
  const bord = danger ? RED : red ? RED : pur ? PUR : BOR;
  const color = danger ? RED : red ? RED : pur ? PUR : TXT;
  return (
    <button onClick={onClick} title={title}
      style={{
        padding: small ? "4px 9px" : "7px 12px",
        background: bg, border: `1px solid ${bord}`, color,
        fontSize: small ? 11 : 12, cursor: "pointer", borderRadius: 0,
        fontWeight: 700, letterSpacing: "0.03em", ...style,
      }}
    >{children}</button>
  );
}

function Led({ on, label, color = GRN }: { on: boolean; label: string; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em" }}>
      <div style={{
        width: 8, height: 8, background: on ? color : "#333",
        boxShadow: on ? `0 0 6px ${color}` : "none",
      }} />
      <span style={{ color: on ? color : TXT2 }}>{label}</span>
    </div>
  );
}

const selStyle: React.CSSProperties = {
  flex: 1, padding: "7px 9px", background: BG1, color: TXT,
  border: `1px solid ${BOR}`, fontSize: 13, borderRadius: 0,
};
const inStyle: React.CSSProperties = {
  padding: "7px 9px", background: BG1, color: TXT, border: `1px solid ${BOR}`,
  fontSize: 13, borderRadius: 0, fontFamily: "ui-monospace, monospace",
};

function NumInput({ value, onChange, suffix, min, max, step }: {
  value: number; onChange: (v: number) => void; suffix?: string;
  min?: number; max?: number; step?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, flex: 1 }}>
      <input
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(+e.target.value)}
        style={{ ...inStyle, flex: 1, textAlign: "right" as const }}
      />
      {suffix && <span style={{ fontSize: 11, color: TXT2 }}>{suffix}</span>}
    </div>
  );
}

function presetIdFor(url: string): string {
  const match = RTMP_PRESETS.find(p => p.id !== "custom" && url.startsWith(p.url.replace(/\/$/, "")));
  return match?.id || "custom";
}

function codecFamilyOf(s: string): string {
  const [fam] = s.split("/");
  return fam === "h265" || fam === "hevc" ? "h265" : "h264";
}
function codecHwOf(s: string): string {
  const parts = s.split("/");
  return parts[1] || "auto";
}
function buildCodecString(family: string, hw: string): string {
  return hw === "auto" || !hw ? family : `${family}/${hw}`;
}
function hasEncoder(list: string[], family: string, hw: string): boolean {
  const prefix = family === "h265" ? "hevc" : "h264";
  return list.includes(`${prefix}_${hw}`);
}

// ── EncoderSection ────────────────────────────────────────────
// Extracted from the ENGINE tab so the encoder lives ONLY in the QUALITY tab (de-dup). Uses the
// authoritative engine config (eng.config: width/height/fps/bitrate_kbps/codec) — not the legacy
// useVideoQuality parallel that the old QualityPanel edited.
export function EncoderSection() {
  const { config, setConfig, encoders } = useVideoEngine();
  return (
    <div style={{ padding: 12, color: TXT, fontSize: 12, fontFamily: "Inter, system-ui, sans-serif" }}>
      <Section title="ENCODER">
        <Row>
          <Label>Resolution</Label>
          <select
            value={`${config.width}×${config.height}`}
            onChange={(e) => { const [w, h] = e.target.value.split("×").map(Number); setConfig({ ...config, width: w, height: h }); }}
            style={selStyle}
          >
            <option value="1280×720">1280×720</option>
            <option value="1920×1080">1920×1080</option>
            <option value="2560×1440">2560×1440</option>
            <option value="3840×2160">3840×2160</option>
          </select>
        </Row>
        <Row>
          <Label>FPS</Label>
          <select value={config.fps} onChange={(e) => setConfig({ ...config, fps: +e.target.value })} style={selStyle}>
            <option value={24}>24</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </Row>
        <Row>
          <Label>Bitrate</Label>
          <NumInput value={config.bitrate_kbps} onChange={(v) => setConfig({ ...config, bitrate_kbps: v })} suffix="kbps" min={500} max={25000} step={500} />
        </Row>
        <Row>
          <Label>Codec</Label>
          <select
            value={codecFamilyOf(config.codec)}
            onChange={(e) => setConfig({ ...config, codec: buildCodecString(e.target.value, codecHwOf(config.codec)) })}
            style={selStyle}
          >
            <option value="h264">H.264</option>
            <option value="h265">H.265</option>
          </select>
        </Row>
        <Row>
          <Label>Encoder</Label>
          <select
            value={codecHwOf(config.codec)}
            onChange={(e) => setConfig({ ...config, codec: buildCodecString(codecFamilyOf(config.codec), e.target.value) })}
            style={selStyle}
          >
            <option value="auto">Auto (best available)</option>
            {hasEncoder(encoders, codecFamilyOf(config.codec), "nvenc")        && <option value="nvenc">NVIDIA NVENC (GPU)</option>}
            {hasEncoder(encoders, codecFamilyOf(config.codec), "qsv")          && <option value="qsv">Intel Quick Sync (GPU)</option>}
            {hasEncoder(encoders, codecFamilyOf(config.codec), "amf")          && <option value="amf">AMD AMF (GPU)</option>}
            {hasEncoder(encoders, codecFamilyOf(config.codec), "videotoolbox") && <option value="videotoolbox">Apple VideoToolbox (GPU)</option>}
            <option value="software">Software (libx264 / libx265)</option>
          </select>
        </Row>
      </Section>
    </div>
  );
}

// ── DestinationsSection ───────────────────────────────────────
// Extracted from the ENGINE tab → lives in the SHOW+ (streaming/podcast) hub. Uses the authoritative
// eng.destinations (the same store the engine streams from), replacing the parallel MultiRTMPPanel.
export function DestinationsSection() {
  const { destinations, addDestination, removeDestination, patchDestination, status, startStream, stopStream } = useVideoEngine();
  const isStreaming = !!status?.streaming;
  return (
    <div style={{ padding: 12, color: TXT, fontSize: 12, fontFamily: "Inter, system-ui, sans-serif" }}>
      <Section title={`RTMP DESTINATIONS (${destinations.length})`}>
        {destinations.map((dest, i) => {
          const presetId = presetIdFor(dest.url);
          const preset = RTMP_PRESETS.find(p => p.id === presetId);
          const sinkId = destinations.length === 1 ? "stream" : `stream:${i}`;
          const sink   = status?.sinks.find(s => s.id === sinkId);
          const connStatus = sink?.status ?? (isStreaming ? "connecting" : null);
          const borderColor = connStatus === "connected"    ? GRN
                            : connStatus === "reconnecting" ? AMB
                            : connStatus === "failed"       ? RED
                            : BOR;
          const statusDot   = connStatus === "connected"    ? { color: GRN,  label: "LIVE" }
                            : connStatus === "reconnecting" ? { color: AMB,  label: "RECONNECTING…" }
                            : connStatus === "failed"       ? { color: RED,  label: "FAILED" }
                            : connStatus === "connecting"   ? { color: TXT2, label: "CONNECTING…" }
                            : null;
          return (
            <div key={i} style={{ padding: "8px 8px 10px", marginBottom: 8, background: BG2, border: `1px solid ${borderColor}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <select
                  value={presetId}
                  onChange={(e) => { const p = RTMP_PRESETS.find(x => x.id === e.target.value); if (p) patchDestination(i, { url: p.url, label: p.name }); }}
                  style={{ ...selStyle, flex: 1 }}
                >
                  {RTMP_PRESETS.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
                </select>
                {destinations.length > 1 && (<Btn small danger onClick={() => removeDestination(i)}>×</Btn>)}
              </div>
              <input value={dest.label} onChange={(e) => patchDestination(i, { label: e.target.value })} placeholder="Label" style={{ ...inStyle, width: "100%", marginBottom: 5, boxSizing: "border-box" as const }} />
              <input value={dest.url} onChange={(e) => patchDestination(i, { url: e.target.value })} placeholder="rtmp://..." style={{ ...inStyle, width: "100%", marginBottom: 5, boxSizing: "border-box" as const }} />
              <input value={dest.key} type="password" onChange={(e) => patchDestination(i, { key: e.target.value })} placeholder="Stream key" style={{ ...inStyle, width: "100%", marginBottom: 5, boxSizing: "border-box" as const }} />
              <input value={dest.backupUrl ?? ""} onChange={(e) => patchDestination(i, { backupUrl: e.target.value || undefined })} placeholder="Backup RTMP URL (optional failover)" style={{ ...inStyle, width: "100%", marginBottom: dest.backupUrl ? 5 : 0, opacity: 0.7, boxSizing: "border-box" as const }} />
              {dest.backupUrl && (
                <input value={dest.backupKey ?? ""} onChange={(e) => patchDestination(i, { backupKey: e.target.value || undefined })} placeholder="Backup stream key (if different)" type="password" style={{ ...inStyle, width: "100%", boxSizing: "border-box" as const }} />
              )}
              {preset?.help && (<div style={{ fontSize: 10, color: TXT2, marginTop: 5, lineHeight: 1.4 }}>{preset.help}</div>)}
              {statusDot && (
                <div style={{ fontSize: 10, color: statusDot.color, marginTop: 5, fontFamily: "ui-monospace, monospace", display: "flex", gap: 6 }}>
                  <span>● {statusDot.label}</span>
                  {sink && connStatus === "connected" && (<span style={{ color: TXT2 }}>{Math.floor(sink.uptimeMs / 1000)}s · {sink.framesWritten} chunks</span>)}
                </div>
              )}
            </div>
          );
        })}
        <Btn onClick={() => addDestination({ url: "rtmp://", key: "", label: `Destination ${destinations.length + 1}` })} style={{ width: "100%", marginBottom: 8 }}>+ Add Destination</Btn>
        <div style={{ marginTop: 2 }}>
          {isStreaming ? (
            <Btn danger onClick={stopStream} style={{ width: "100%" }}>◼ Stop All Streams</Btn>
          ) : (
            <Btn pur onClick={startStream} style={{ width: "100%" }}>▶ Go Live ({destinations.length} destination{destinations.length !== 1 ? "s" : ""})</Btn>
          )}
        </div>
      </Section>
    </div>
  );
}
