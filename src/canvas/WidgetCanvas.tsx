// @ts-nocheck
import React, { useState, useRef, useCallback, useEffect } from "react";
import { CanvasEngineState } from "./CanvasEngine";
import { WidgetInstance, WidgetType, WIDGET_REGISTRY, CELL_SIZE, GRID_COLS, GRID_ROWS } from "./WidgetRegistry";
import { DeckState } from "../audio/engine-rodio";

// ── Widget renderer — routes to the right component ──────────
import DeckWidget from "./widgets/DeckWidget";
import {
  QueueWidget,
  MicWidget,
  ClockWidget,
  LibraryWidget,
  NowPlayingWidget,
  LogoWidget,
  HistoryWidget,
} from "./widgets/Widgets";
import { EpisodeMode, RemoteGuestWidget, OneClickExport, ShowNotesAI } from "../components/PodcastMode";

interface WidgetProps {
  instance: WidgetInstance;
  deckStates: Record<string, DeckState | null>;
  engine: any;
}

function WidgetContent({ instance, deckStates, engine }: WidgetProps) {
  const { type, config } = instance;
  switch (type) {
    case "deck":     return <DeckWidget instance={instance} deckStates={deckStates} engine={engine} />;
    case "queue":    return <QueueWidget instance={instance} engine={engine} />;
    case "mic":      return <MicWidget instance={instance} />;
    case "clock":    return <ClockWidget instance={instance} />;
    case "library":  return <LibraryWidget instance={instance} engine={engine} />;
    case "nowplaying": return <NowPlayingWidget instance={instance} deckStates={deckStates} />;
    case "logo":     return <LogoWidget instance={instance} />;
    case "history":  return <HistoryWidget instance={instance} />;
    case "episode":  return <EpisodeMode onClose={() => {}} />;
    case "remoteguest": return <RemoteGuestWidget />;
    case "export":   return <OneClickExport />;
    case "shownotes": return <ShowNotesAI />;
    default: return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-tertiary)", fontSize: 12 }}>
        {WIDGET_REGISTRY[type]?.label || type}
      </div>
    );
  }
}

// ── Widget shell — the draggable/resizable container ──────────
interface ShellProps {
  instance: WidgetInstance;
  engine: CanvasEngineState;
  deckStates: Record<string, DeckState | null>;
  audioEngine: any;
  selected: boolean;
  onSelect: () => void;
}

function WidgetShell({ instance, engine, deckStates, audioEngine, selected, onSelect }: ShellProps) {
  const dragStartRef = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);
  const resizeStartRef = useRef<{ mx: number; my: number; ow: number; oh: number } | null>(null);

  const handleDragStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    dragStartRef.current = { mx: e.clientX, my: e.clientY, ox: instance.x, oy: instance.y };
    onSelect();

    // Pixel-level drag — update visual position smoothly, snap to grid on release
    const el = (e.currentTarget as HTMLElement).closest("[data-widget-shell]") as HTMLElement;
    const container = el?.parentElement;
    if (el) el.style.transition = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current || !el || !container) return;
      const cw = container.clientWidth; const ch = container.clientHeight;
      const pxX = (dragStartRef.current.ox / GRID_COLS) * cw + (ev.clientX - dragStartRef.current.mx);
      const pxY = (dragStartRef.current.oy / GRID_ROWS) * ch + (ev.clientY - dragStartRef.current.my);
      el.style.left = pxX + "px";
      el.style.top = pxY + "px";
    };
    const onUp = (ev: MouseEvent) => {
      if (!dragStartRef.current || !container) return;
      const cw = container.clientWidth; const ch = container.clientHeight;
      const cellW = cw / GRID_COLS; const cellH = ch / GRID_ROWS;
      const dx = Math.round((ev.clientX - dragStartRef.current.mx) / cellW);
      const dy = Math.round((ev.clientY - dragStartRef.current.my) / cellH);
      engine.moveWidget(instance.id, dragStartRef.current.ox + dx, dragStartRef.current.oy + dy);
      if (el) { el.style.left = ""; el.style.top = ""; el.style.transition = ""; }
      dragStartRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    resizeStartRef.current = { mx: e.clientX, my: e.clientY, ow: instance.w, oh: instance.h };
    const onMove = (_ev: MouseEvent) => {
      // TODO(WidgetCanvas rebuild): resize logic referenced undeclared onRight/onBottom
      // — silently returned dw=0/dh=0 since original commit, resize handle never worked.
      // Original code preserved below for reference during rebuild:
      //   const container = (document.querySelector("[data-widget-shell]")?.parentElement) as HTMLElement;
      //   const cellW = container ? container.clientWidth / GRID_COLS : CELL_SIZE;
      //   const cellH = container ? container.clientHeight / GRID_ROWS : CELL_SIZE;
      //   const dw = onRight ? Math.round((ev.clientX - resizeStartRef.current.mx) / cellW) : 0;
      //   const dh = onBottom ? Math.round((ev.clientY - resizeStartRef.current.my) / cellH) : 0;
      //   engine.resizeWidget(instance.id, resizeStartRef.current.ow + dw, resizeStartRef.current.oh + dh);
      return;
    };
    const onUp = () => {
      resizeStartRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const def = WIDGET_REGISTRY[instance.type];
  const label = instance.label || def.label;

  const [hovered, setHovered] = useState(false);
  const [resizeCursor, setResizeCursor] = useState("default");

  // Edge/corner cursor detection
  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const edge = 10;
    const w = rect.width; const h = rect.height;
    const onRight = x > w - edge; const onBottom = y > h - edge;
    const onLeft = x < edge; const onTop = y < edge;
    if ((onRight && onBottom) || (onLeft && onTop)) setResizeCursor("nwse-resize");
    else if ((onRight && onTop) || (onLeft && onBottom)) setResizeCursor("nesw-resize");
    else if (onRight || onLeft) setResizeCursor("ew-resize");
    else if (onBottom || onTop) setResizeCursor("ns-resize");
    else setResizeCursor("default");
  };

  const handleEdgeMouseDown = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const edge = 10;
    const w = rect.width; const h = rect.height;
    const onRight = x > w - edge; const onBottom = y > h - edge;
    if (!onRight && !onBottom) return; // not on a resize edge — let drag handle it
    e.stopPropagation();
    resizeStartRef.current = { mx: e.clientX, my: e.clientY, ow: instance.w, oh: instance.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const dw = onRight ? Math.round((ev.clientX - resizeStartRef.current.mx) / CELL_SIZE) : 0;
      const dh = onBottom ? Math.round((ev.clientY - resizeStartRef.current.my) / CELL_SIZE) : 0;
      engine.resizeWidget(instance.id, resizeStartRef.current.ow + dw, resizeStartRef.current.oh + dh);
    };
    const onUp = () => {
      resizeStartRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      data-widget-shell="true"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setResizeCursor("default"); }}
      onMouseMove={handleMouseMove}
      onMouseDown={handleEdgeMouseDown}
      style={{
        position: "absolute",
        left: `${(instance.x / GRID_COLS) * 100}%`,
        top: `${(instance.y / GRID_ROWS) * 100}%`,
        width: `${(instance.w / GRID_COLS) * 100}%`,
        height: `${(instance.h / GRID_ROWS) * 100}%`,
        boxSizing: "border-box" as const,
        border: "none",
        borderRadius: 0,
        overflow: "hidden",
        zIndex: selected ? 10 : 1,
        background: "var(--bg-primary)",
        cursor: resizeCursor,
      }}
    >
      {/* Drag handle — tiny grip dots, top center, only on hover */}
      {hovered && resizeCursor === "default" && (
        <div
          onMouseDown={e => { e.stopPropagation(); handleDragStart(e); }}
          style={{
            position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)",
            zIndex: 20, padding: "3px 8px", borderRadius: 0,
            background: "rgba(0,0,0,0.5)", backdropFilter: "blur(8px)",
            cursor: "grab", display: "flex", alignItems: "center", gap: 1,
            opacity: 0.7, transition: "opacity 0.15s",
          }}
          title="Drag to move"
        >
          <svg width="16" height="6" viewBox="0 0 16 6" fill="rgba(255,255,255,0.6)">
            <circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="10" cy="2" r="1.2"/><circle cx="14" cy="2" r="1.2"/>
            <circle cx="2" cy="5" r="1.2"/><circle cx="6" cy="5" r="1.2"/><circle cx="10" cy="5" r="1.2"/><circle cx="14" cy="5" r="1.2"/>
          </svg>
        </div>
      )}

      {/* Widget content — full size */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <WidgetContent instance={instance} deckStates={deckStates} engine={audioEngine} />
      </div>

      {/* Resize corner indicator — bottom right, subtle */}
      {hovered && (
        <div style={{
          position: "absolute", bottom: 3, right: 3, zIndex: 20,
          width: 8, height: 8, opacity: 0.3, pointerEvents: "none",
          borderRight: "2px solid var(--text-tertiary)",
          borderBottom: "2px solid var(--text-tertiary)",
          borderRadius: "0 0 3px 0",
        }} />
      )}

      {/* Resize handle */}
      {selected && (
        <div
          onMouseDown={handleResizeStart}
          style={{
            position: "absolute", bottom: 0, right: 0,
            width: 18, height: 18,
            cursor: "se-resize",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--accent-cyan)",
            borderRadius: "8px 0 14px 0",
            zIndex: 20,
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="rgba(0,0,0,0.6)">
            <path d="M2 6L6 2M4 6L6 4M6 6L6 6"/>
            <line x1="2" y1="6" x2="6" y2="2" stroke="rgba(0,0,0,0.6)" strokeWidth="1.5" strokeLinecap="round"/>
            <line x1="4" y1="6" x2="6" y2="4" stroke="rgba(0,0,0,0.6)" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      )}
    </div>
  );
}

// ── Layout saver / switcher ──────────────────────────────────
function LayoutSaver({ engine }: { engine: CanvasEngineState }) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(engine.activeLayoutName);
  const [showLayouts, setShowLayouts] = useState(false);

  // Sync name when activeLayoutName changes externally
  useEffect(() => { setName(engine.activeLayoutName); }, [engine.activeLayoutName]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await engine.saveCurrentLayout(name.trim());
    setTimeout(() => setSaving(false), 1200);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, position: "relative" as const }}>
      <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.15)" }} />
      {/* Layout name input */}
      <div style={{ position: "relative" as const }}>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSave()}
          placeholder="Layout name..."
          style={{
            padding: "4px 8px", borderRadius: 0, fontSize: 11, fontWeight: 600,
            background: "rgba(255,255,255,0.1)",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "rgba(255,255,255,0.9)",
            outline: "none", width: 130,
          }}
        />
      </div>
      {/* Save button — appears when name differs */}
      <button
        onClick={handleSave}
        style={{
          padding: "4px 10px", borderRadius: 0,
          background: saving ? "var(--accent-green)" : "rgb(from var(--accent-blue) r g b / 0.25)",
          border: "1px solid rgb(from var(--accent-blue) r g b / 0.4)",
          color: saving ? "#000" : "var(--accent-cyan)",
          fontSize: 10, fontWeight: 700, cursor: "pointer",
          transition: "all 0.2s", whiteSpace: "nowrap" as const,
        }}
      >{saving ? "✓ Saved!" : "Save"}</button>
      {/* Layouts dropdown */}
      {engine.layouts.length > 0 && (
        <button
          onClick={() => setShowLayouts(p => !p)}
          style={{ padding: "4px 8px", borderRadius: 0, background: "rgba(255,255,255,0.08)", border: "none", color: "rgba(255,255,255,0.5)", fontSize: 10, cursor: "pointer" }}
        >▾</button>
      )}
      {showLayouts && (
        <div style={{
          position: "absolute" as const, top: "calc(100% + 6px)", left: 0, zIndex: 999,
          background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)",
          borderRadius: 0, padding: 6, minWidth: 200,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        }}>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", padding: "4px 8px 6px", textTransform: "uppercase" as const }}>Saved Layouts</div>
          {engine.layouts.map(l => (
            <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 4px" }}>
              <button
                onClick={() => { engine.loadLayout(l.id); setShowLayouts(false); }}
                style={{
                  flex: 1, textAlign: "left" as const, padding: "6px 8px", borderRadius: 0,
                  background: l.name === engine.activeLayoutName ? "rgb(from var(--accent-blue) r g b / 0.12)" : "none",
                  border: "none", color: l.name === engine.activeLayoutName ? "var(--accent-cyan)" : "var(--text-primary)",
                  fontSize: 12, fontWeight: l.name === engine.activeLayoutName ? 700 : 400, cursor: "pointer",
                }}
              >{l.name}</button>
              <button
                onClick={() => engine.deleteLayout(l.id)}
                style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 12, padding: "4px 6px", borderRadius: 0 }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "var(--accent-red)"}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"}
              >✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Widget picker panel ───────────────────────────────────────

function WidgetPicker({ engine, onClose }: { engine: CanvasEngineState; onClose: () => void }) {
  const categories = ["audio", "library", "broadcast", "custom"] as const;
  const catLabels = { audio: "Audio", library: "Library", broadcast: "Broadcast", custom: "Custom" };

  return (
    <div style={{
      position: "fixed", right: 0, top: 0, bottom: 0, width: 280,
      background: "var(--bg-secondary)",
      borderLeft: "1px solid var(--border-primary)",
      zIndex: 1000,
      display: "flex", flexDirection: "column" as const,
      fontFamily: "'Inter', system-ui, sans-serif",
      overflowY: "auto" as const,
    }}>
      <div style={{ padding: "16px 16px 8px", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Add Widget</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>Click to add to canvas</div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}>✕</button>
      </div>

      {categories.map(cat => {
        const widgets = Object.values(WIDGET_REGISTRY).filter(w => w.category === cat);
        return (
          <div key={cat} style={{ padding: "12px 16px" }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", marginBottom: 8, textTransform: "uppercase" as const }}>{catLabels[cat]}</div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
              {widgets.map(def => {
                const canAdd = engine.canAdd(def.type);
                return (
                  <button
                    key={def.type}
                    onClick={() => canAdd && engine.addWidget(def.type)}
                    disabled={!canAdd}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 12px", borderRadius: 0,
                      background: canAdd ? "var(--bg-tertiary)" : "transparent",
                      border: `1px solid ${canAdd ? "var(--border-primary)" : "transparent"}`,
                      color: canAdd ? "var(--text-primary)" : "var(--text-tertiary)",
                      cursor: canAdd ? "pointer" : "not-allowed",
                      textAlign: "left" as const,
                      opacity: canAdd ? 1 : 0.4,
                      transition: "all 0.1s",
                    }}
                    onMouseEnter={e => canAdd && ((e.currentTarget as HTMLElement).style.background = "var(--bg-hover)")}
                    onMouseLeave={e => canAdd && ((e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)")}
                  >
                    <div style={{ width: 28, height: 28, borderRadius: 0, background: canAdd ? "var(--accent-cyan)" + "20" : "var(--bg-secondary)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={canAdd ? "var(--accent-cyan)" : "var(--text-tertiary)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d={def.icon} />
                      </svg>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{def.label}</div>
                      <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{def.description}</div>
                    </div>
                    {def.proOnly && (
                      <span style={{ fontSize: 7, fontWeight: 800, color: "#a78bfa", background: "rgba(167,139,250,0.15)", padding: "2px 5px", borderRadius: 0, letterSpacing: "0.08em", flexShrink: 0 }}>PRO</span>
                    )}
                    {!canAdd && (
                      <span style={{ fontSize: 7, color: "var(--text-tertiary)", flexShrink: 0 }}>Added</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Grid overlay — shown in edit mode ─────────────────────────

function GridOverlay() {
  return (
    <svg
      style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.04, zIndex: 0 }}
      width={GRID_COLS * CELL_SIZE}
      height={GRID_ROWS * CELL_SIZE}
    >
      {Array.from({ length: GRID_COLS + 1 }, (_, i) => (
        <line key={`v${i}`} x1={i * CELL_SIZE} y1={0} x2={i * CELL_SIZE} y2={GRID_ROWS * CELL_SIZE} stroke="white" strokeWidth="1" />
      ))}
      {Array.from({ length: GRID_ROWS + 1 }, (_, i) => (
        <line key={`h${i}`} x1={0} y1={i * CELL_SIZE} x2={GRID_COLS * CELL_SIZE} y2={i * CELL_SIZE} stroke="white" strokeWidth="1" />
      ))}
    </svg>
  );
}

// ── Main canvas ───────────────────────────────────────────────

interface WidgetCanvasProps {
  canvasEngine: CanvasEngineState;
  deckStates: Record<string, DeckState | null>;
  audioEngine: any;
}

export default function WidgetCanvas({ canvasEngine, deckStates, audioEngine }: WidgetCanvasProps) {
  const { widgets, selected, setSelected } = canvasEngine;

  // Deselect on canvas click
  const handleCanvasClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement) === e.currentTarget) setSelected(null);
  };

  return (
    <div style={{ position: "relative", flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" as const }}>



      {/* Canvas — fills all available space */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" as const }}>
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
        }}
        onClick={handleCanvasClick}
      >


        {widgets.map(w => (
          <WidgetShell
            key={w.id}
            instance={w}
            engine={canvasEngine}
            deckStates={deckStates}
            audioEngine={audioEngine}
            selected={selected === w.id}
            onSelect={() => setSelected(w.id)}
          />
        ))}

        {/* Empty canvas hint */}
        {widgets.length === 0 && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column" as const,
            alignItems: "center", justifyContent: "center", gap: 12,
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1" strokeLinecap="round" opacity="0.3">
              <rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/>
              <rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>
            </svg>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-tertiary)" }}>Your canvas is empty</div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", opacity: 0.6 }}>Click the settings icon to add widgets</div>
            {/* TODO(WidgetCanvas rebuild): picker button removed — setEditMode and setShowPicker
                were never declared, would ReferenceError on click. Restore when picker state
                and JSX are wired during rebuild. Original JSX preserved for reference:
            <button
              onClick={() => { setEditMode(true); setShowPicker(true); }}
              style={{ padding: "8px 20px", borderRadius: 0, background: "var(--accent-cyan)", border: "none", color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer", marginTop: 4 }}
            >+ Add your first widget</button>
            */}
          </div>
        )}
      </div>
      </div>{/* end scroll wrapper */}

      {/* Widget picker panel */}

    </div>
  );
}
