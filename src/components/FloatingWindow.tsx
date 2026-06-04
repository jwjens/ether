// src/components/FloatingWindow.tsx
// Reusable floating/draggable/resizable FX window — used by Master EQ,
// per-deck EQ/Comp/Reverb, and any other popup panel that should feel
// like an Ableton/Audition plugin window.
//
// Features:
//   - Drag by header to move anywhere on screen
//   - Resize from bottom-right corner
//   - Snap to screen edges when dragged within SNAP_PX (visual feedback)
//   - Position + size persisted to localStorage per window id
//   - Clamped to viewport (can't drag off-screen)
//   - Escape to close
//   - Click X button to close
//
// Usage:
//   <FloatingWindow
//     id="eqrack"
//     title="Master EQ"
//     defaultWidth={920} defaultHeight={420}
//     minWidth={640}    minHeight={320}
//     onClose={() => setOpen(false)}
//   >
//     <YourContent />
//   </FloatingWindow>

import { useEffect, useRef, useState } from "react";

const SNAP_PX = 24;    // distance from edge that triggers snap
const EDGE_PX = 8;     // after snap, stick the window this many px from the edge

interface Props {
  /** Unique id — used as localStorage key for position/size persistence */
  id:              string;
  /** Shown in the drag-handle bezel */
  title?:          string;
  /** Optional subtitle / model-number string shown in the bezel */
  subtitle?:       string;
  /** Default window size (only used on first open when no saved state) */
  defaultWidth:    number;
  defaultHeight:   number;
  /** Minimum size — resize handle respects this */
  minWidth?:       number;
  minHeight?:      number;
  /** Close handler (X button + Escape key) */
  onClose:         () => void;
  /** Called when the user moves/resizes — rare, usually not needed */
  onLayout?:       (layout: { x: number; y: number; w: number; h: number }) => void;
  /** z-index override (default 9999) */
  zIndex?:         number;
  /** Custom top-bar content — if not provided, shows `title` + close button */
  headerContent?:  React.ReactNode;
  /** Render-prop body — receives the inner width/height so content can scale */
  children:        React.ReactNode | ((dims: { width: number; height: number }) => React.ReactNode);
  /** Optional color accent for the drag grip + status LED */
  accentColor?:    string;
}

interface Layout { x: number; y: number; w: number; h: number; }

function loadLayout(id: string, def: Layout): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(`fw_${id}`) || "null");
    if (saved && typeof saved.x === "number") return { ...def, ...saved };
  } catch {}
  return def;
}

function saveLayout(id: string, l: Layout) {
  try { localStorage.setItem(`fw_${id}`, JSON.stringify(l)); } catch {}
}

export default function FloatingWindow({
  id, title, subtitle,
  defaultWidth, defaultHeight,
  minWidth = 320, minHeight = 200,
  onClose, onLayout,
  zIndex = 9999,
  headerContent,
  children,
  accentColor = "var(--accent-cyan)",
}: Props) {
  const [layout, setLayout] = useState<Layout>(() => loadLayout(id, {
    x: Math.max(16, (window.innerWidth - defaultWidth) / 2),
    y: 60,
    w: defaultWidth,
    h: defaultHeight,
  }));
  const [snapHint, setSnapHint] = useState<"left" | "right" | "top" | "bottom" | null>(null);
  const dragRef   = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  // Persist layout whenever it changes (debounced via requestAnimationFrame so
  // we're not hammering localStorage during drag)
  useEffect(() => {
    let raf = 0;
    const save = () => saveLayout(id, layout);
    raf = requestAnimationFrame(save);
    onLayout?.(layout);
    return () => cancelAnimationFrame(raf);
  }, [id, layout, onLayout]);

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Drag (by header) ──
  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, [data-no-drag]")) return;
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      origX:  layout.x,  origY:  layout.y,
    };

    const onMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = me.clientX - dragRef.current.startX;
      const dy = me.clientY - dragRef.current.startY;
      let nx = dragRef.current.origX + dx;
      let ny = dragRef.current.origY + dy;

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Snap-to-edge preview
      let hint: typeof snapHint = null;
      if (nx < SNAP_PX) hint = "left";
      else if (nx + layout.w > vw - SNAP_PX) hint = "right";
      else if (ny < SNAP_PX) hint = "top";
      else if (ny + layout.h > vh - SNAP_PX) hint = "bottom";
      setSnapHint(hint);

      // Clamp so window can't be dragged completely off-screen
      nx = Math.max(-layout.w + 120, Math.min(vw - 120, nx));
      ny = Math.max(0,                Math.min(vh - 40, ny));
      setLayout(l => ({ ...l, x: nx, y: ny }));
    };

    const onUp = () => {
      // Apply snap on release
      if (snapHint) {
        setLayout(l => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let { x, y, w, h } = l;
          if (snapHint === "left")   x = EDGE_PX;
          if (snapHint === "right")  x = vw - w - EDGE_PX;
          if (snapHint === "top")    y = EDGE_PX;
          if (snapHint === "bottom") y = vh - h - EDGE_PX;
          return { x, y, w, h };
        });
      }
      setSnapHint(null);
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Resize (from bottom-right corner) ──
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      startX: e.clientX, startY: e.clientY,
      origW:  layout.w,  origH:  layout.h,
    };

    const onMove = (me: MouseEvent) => {
      if (!resizeRef.current) return;
      const dw = me.clientX - resizeRef.current.startX;
      const dh = me.clientY - resizeRef.current.startY;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const nw = Math.max(minWidth,  Math.min(vw - 20,       resizeRef.current.origW + dw));
      const nh = Math.max(minHeight, Math.min(vh - layout.y - 20, resizeRef.current.origH + dh));
      setLayout(l => ({ ...l, w: nw, h: nh }));
    };

    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Snap-hint overlay positioning
  const snapOverlay = snapHint && (
    <div style={{
      position: "fixed", zIndex: zIndex - 1,
      pointerEvents: "none",
      background: `${accentColor}22`,
      border: `2px solid ${accentColor}`,
      boxShadow: `0 0 20px ${accentColor}66, inset 0 0 20px ${accentColor}22`,
      transition: "all 0.12s ease",
      ...(snapHint === "left"   && { left: 0, top: 0, bottom: 0, width: Math.min(layout.w, 480) }),
      ...(snapHint === "right"  && { right: 0, top: 0, bottom: 0, width: Math.min(layout.w, 480) }),
      ...(snapHint === "top"    && { left: 0, right: 0, top: 0, height: Math.min(layout.h, 300) }),
      ...(snapHint === "bottom" && { left: 0, right: 0, bottom: 0, height: Math.min(layout.h, 300) }),
    }} />
  );

  // Inner body dimensions (subtract header height if we own the default header)
  const headerH = headerContent ? 0 : 44;
  const bodyW = layout.w;
  const bodyH = layout.h - headerH - 1; // -1 for the resize corner border

  return (
    <>
      {snapOverlay}
      <div style={{
        position: "fixed",
        top: layout.y, left: layout.x, zIndex,
        width: layout.w, height: layout.h,
        background: "linear-gradient(180deg, #1a1a22 0%, #121218 50%, #0a0a0f 100%)",
        border: "1px solid #2d2d3a",
        borderRadius: 6,
        boxShadow: "0 24px 60px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04) inset",
        fontFamily: "'Inter', system-ui, sans-serif",
        overflow: "hidden",
        userSelect: (dragRef.current || resizeRef.current) ? "none" : "auto",
        display: "flex", flexDirection: "column",
      }}>
        {headerContent ? (
          // Caller supplies entire header (and manages the drag handle themselves
          // via the startDrag prop exposed below). We wrap in an onMouseDown
          // so the whole caller-supplied header acts as a drag handle.
          <div onMouseDown={startDrag} style={{ flexShrink: 0, cursor: dragRef.current ? "grabbing" : "grab" }}>
            {headerContent}
          </div>
        ) : (
          // Default header — title + close button
          <div
            onMouseDown={startDrag}
            style={{
              height: 44, flexShrink: 0,
              background: "linear-gradient(180deg, #262632 0%, #1a1a22 100%)",
              borderBottom: "1px solid #0a0a0f",
              display: "flex", alignItems: "center", padding: "0 16px", gap: 12,
              cursor: dragRef.current ? "grabbing" : "grab",
              position: "relative",
            }}
          >
            {/* Drag grip dots */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3, pointerEvents: "none" }}>
              {[0, 1, 2, 3].map(i => (
                <div key={i} style={{ display: "flex", gap: 3 }}>
                  <div style={{ width: 2, height: 2, borderRadius: "50%", background: "#3a3a48" }} />
                  <div style={{ width: 2, height: 2, borderRadius: "50%", background: "#3a3a48" }} />
                </div>
              ))}
            </div>
            {title && (
              <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.14em", color: "#ececf2", textTransform: "uppercase" as const }}>
                {title}
              </div>
            )}
            {subtitle && (
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", color: accentColor, textTransform: "uppercase" as const, padding: "2px 8px", border: `1px solid ${accentColor}40`, borderRadius: 3 }}>
                {subtitle}
              </div>
            )}
            <button
              onClick={onClose}
              title="Close (Esc)"
              data-no-drag
              style={{
                marginLeft: "auto",
                width: 28, height: 28, borderRadius: 4,
                background: "#1a1a22", border: "1px solid #3a3a48",
                color: "#a8a8b4", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ef4444"; (e.currentTarget as HTMLElement).style.borderColor = "#ef4444"; (e.currentTarget as HTMLElement).style.color = "#fff"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#1a1a22"; (e.currentTarget as HTMLElement).style.borderColor = "#3a3a48"; (e.currentTarget as HTMLElement).style.color = "#a8a8b4"; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
              </svg>
            </button>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
          {typeof children === "function"
            ? (children as (d: { width: number; height: number }) => React.ReactNode)({ width: bodyW, height: bodyH })
            : children}
        </div>

        {/* Resize corner handle */}
        <div
          onMouseDown={startResize}
          title="Drag to resize"
          style={{
            position: "absolute", right: 0, bottom: 0,
            width: 16, height: 16,
            cursor: "nwse-resize",
            background: `linear-gradient(135deg, transparent 50%, ${accentColor}30 50%, ${accentColor}60 80%)`,
            borderBottomRightRadius: 6,
            zIndex: 2,
          }}
        >
          {/* Diagonal grip lines */}
          <svg width="16" height="16" viewBox="0 0 16 16" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <line x1="12" y1="5"  x2="5"  y2="12" stroke={accentColor} strokeWidth="1" opacity="0.5"/>
            <line x1="14" y1="8"  x2="8"  y2="14" stroke={accentColor} strokeWidth="1" opacity="0.7"/>
            <line x1="15" y1="11" x2="11" y2="15" stroke={accentColor} strokeWidth="1" opacity="0.9"/>
          </svg>
        </div>
      </div>
    </>
  );
}
