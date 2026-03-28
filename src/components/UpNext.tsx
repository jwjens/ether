import { useState, useEffect, useRef } from "react";
import { engine } from "../audio/engine-rodio";
import { query } from "../db/client";

interface Props {
  queueLen: number;
  onQueueChange: () => void;
}

interface CategoryInfo {
  id: number;
  code: string;
  name: string;
  color: string;
}

interface ActiveShow {
  name: string;
  clock_name: string | null;
}

const CATEGORY_COLORS: Record<string, string> = {
  "A": "#ef4444",
  "B": "#f59e0b",
  "C": "#22c55e",
  "D": "#3b82f6",
  "spot": "#a855f7",
  "liner": "#ec4899",
  "jingle": "#14b8a6",
  "news": "#6366f1",
};

// Tiny artwork cache so we don't re-fetch on every render
const artCache: Record<string, string> = {};

async function fetchArt(title: string, artist: string): Promise<string | null> {
  const key = `${title}::${artist}`;
  if (artCache[key] !== undefined) return artCache[key] || null;
  try {
    const q = encodeURIComponent(`${title} ${artist}`.replace(/\(feat\..*?\)/gi, '').replace(/\s*[-–]\s*remaster.*/gi, '').trim());
    const r = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`);
    const d = await r.json();
    const url = d?.results?.[0]?.artworkUrl100?.replace('100x100bb', '60x60bb') ?? null;
    artCache[key] = url || '';
    return url;
  } catch { artCache[key] = ''; return null; }
}

export default function UpNext({ queueLen, onQueueChange }: Props) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [activeShow, setActiveShow] = useState<ActiveShow | null>(null);
  const [artUrls, setArtUrls] = useState<Record<number, string>>({});
  const [totalDuration, setTotalDuration] = useState(0);

  // All drag state in refs so closures always read current values
  const dragIdxRef = useRef<number | null>(null);
  const dragOverIdxRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);

  // Visual state (triggers re-render)
  const [dragVisual, setDragVisual] = useState<{ from: number | null; over: number | null }>({ from: null, over: null });

  const queue = engine.getQueue();

  // Fetch artwork for queue items
  useEffect(() => {
    queue.forEach((item, i) => {
      if (artUrls[i] !== undefined) return;
      fetchArt(item.title || '', item.artist || '').then(url => {
        if (url) setArtUrls(prev => ({ ...prev, [i]: url }));
      });
    });
    // Calculate total queue duration
    const total = queue.reduce((sum, q) => sum + (q.durationMs || 0), 0);
    setTotalDuration(total);
  }, [queueLen]);

  useEffect(() => {
    (async () => {
      try {
        const cats = await query<CategoryInfo>("SELECT id, code, name, color FROM categories");
        setCategories(cats);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const loadShow = async () => {
      try {
        const hour = new Date().getHours();
        const rows = await query<{ name: string; clock_name: string | null }>(
          "SELECT s.name, c.name as clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id WHERE s.start_hour <= ? AND (s.end_hour > ? OR s.end_hour <= s.start_hour) LIMIT 1",
          [hour, hour]
        );
        setActiveShow(rows.length > 0 ? rows[0] : null);
      } catch {}
    };
    loadShow();
    const id = setInterval(loadShow, 30000);
    return () => clearInterval(id);
  }, []);

  const getItemColor = (item: any): string => {
    if (item.itemType) return CATEGORY_COLORS[item.itemType] || "var(--text-tertiary)";
    if (item.category) {
      const cat = categories.find(c => String(c.id) === String(item.category));
      if (cat) return cat.color || CATEGORY_COLORS[cat.code] || "var(--text-tertiary)";
    }
    const t = (item.title || "").toLowerCase();
    if (t.startsWith("[vt]")) return "#ec4899";
    if (t.includes("jingle") || t.includes("sweeper")) return CATEGORY_COLORS["jingle"];
    if (t.includes("promo") || t.includes("psa")) return CATEGORY_COLORS["spot"];
    return "var(--text-tertiary)";
  };

  const getCatLabel = (item: any): string => {
    if (item.itemType) return item.itemType.toUpperCase();
    if (item.category) {
      const cat = categories.find(c => String(c.id) === String(item.category));
      if (cat) return cat.code;
    }
    const t = (item.title || "").toLowerCase();
    if (t.startsWith("[vt]")) return "VT";
    return "";
  };

  const rebuild = (newQ: any[]) => {
    engine.clearQueue();
    engine.addToQueue(newQ);
    onQueueChange();
    // Update B and C to reflect new queue positions
    setTimeout(() => engine.triggerPreload(), 100);
  };

  const handleMouseDown = (e: React.MouseEvent, idx: number) => {
    if (e.button !== 0) return;
    e.preventDefault();

    dragIdxRef.current = idx;
    dragOverIdxRef.current = idx;
    isDraggingRef.current = false;
    dragStartYRef.current = e.clientY;

    const onMouseMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientY - dragStartYRef.current) > 5) {
        isDraggingRef.current = true;
      }
      if (!isDraggingRef.current) return;

      // Find drop target by checking each item's bounding rect
      const items = Array.from(document.querySelectorAll("[data-queue-item]"));
      let newOver = items.length - 1;
      for (let i = 0; i < items.length; i++) {
        const rect = items[i].getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          newOver = i;
          break;
        }
      }

      dragOverIdxRef.current = newOver;
      setDragVisual({ from: dragIdxRef.current, over: newOver });
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      const from = dragIdxRef.current;
      const to = dragOverIdxRef.current;

      if (isDraggingRef.current && from !== null && to !== null && from !== to) {
        const q = engine.getQueue();
        const [item] = q.splice(from, 1);
        q.splice(to, 0, item);
        rebuild(q);
      }

      dragIdxRef.current = null;
      dragOverIdxRef.current = null;
      isDraggingRef.current = false;
      setDragVisual({ from: null, over: null });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleContext = (e: React.MouseEvent, idx: number) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, idx }); };
  const closeContext = () => setContextMenu(null);

  const moveUp = (idx: number) => { if (idx <= 0) return; const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.splice(idx - 1, 0, item); rebuild(q); closeContext(); };
  const moveDown = (idx: number) => { const q = engine.getQueue(); if (idx >= q.length - 1) return; const item = q.splice(idx, 1)[0]; q.splice(idx + 1, 0, item); rebuild(q); closeContext(); };
  const moveToTop = (idx: number) => { const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.unshift(item); rebuild(q); closeContext(); };
  const moveToBottom = (idx: number) => { const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.push(item); rebuild(q); closeContext(); };
  const removeItem = (idx: number) => { const q = engine.getQueue(); q.splice(idx, 1); rebuild(q); closeContext(); };

  const handleCartDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const handleCartDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const cartData = e.dataTransfer.getData("application/cart");
    if (cartData) {
      try {
        const cart = JSON.parse(cartData);
        engine.addToQueue([{ filePath: cart.filePath, title: cart.title, artist: cart.artist || "" }]);
        onQueueChange();
      } catch {}
    }
  };

  return (
    <div
      style={{ background: "var(--bg-secondary)", borderRadius: "var(--radius)", border: "1px solid var(--border-primary)", boxShadow: "var(--shadow-sm)", display: "flex", flexDirection: "column" as any, height: "100%", overflow: "hidden" }}
      onClick={closeContext}
    >
      {/* Header */}
      <div style={{ borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.06em" }}>Up Next ({queueLen})</span>
          {queue.length > 0 && <button onClick={() => { engine.clearQueue(); onQueueChange(); }} style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>Clear All</button>}
        </div>
        {activeShow && (
          <div style={{ padding: "0 14px 8px", display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-green)" }} />
            <span style={{ fontSize: 10, fontWeight: 500, color: "var(--accent-green)" }}>{activeShow.name}</span>
            {activeShow.clock_name && <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>— {activeShow.clock_name}</span>}
          </div>
        )}
      </div>

      {/* Queue list */}
      <div
        style={{ flex: 1, overflowY: "auto" as any }}
        onDragOver={handleCartDragOver}
        onDrop={handleCartDrop}
      >
        {queue.length === 0 ? (
          <div style={{ padding: "32px 12px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic", textAlign: "center" as any }}>
            <div style={{ marginBottom: 4 }}>Queue empty</div>
            <div style={{ fontSize: 10 }}>Drag carts here or use GEN LOG</div>
          </div>
        ) : queue.slice(0, 50).map((item, i) => {
          const color = getItemColor(item);
          const catLabel = getCatLabel(item);
          const isBeingDragged = dragVisual.from === i;
          const isDropTarget = dragVisual.over === i && dragVisual.from !== null && dragVisual.from !== i;

          return (
            <div
              key={i}
              data-queue-item={i}
              onMouseDown={e => handleMouseDown(e, i)}
              onContextMenu={e => handleContext(e, i)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "10px 12px",
                borderBottom: "1px solid var(--border-primary)",
                borderLeft: "4px solid " + color,
                borderTop: isDropTarget ? "2px solid #38bdf8" : "none",
                background: isBeingDragged ? "rgba(56,189,248,0.08)" : i === 0 ? "var(--bg-active)" : "transparent",
                opacity: isBeingDragged ? 0.45 : 1,
                cursor: isBeingDragged ? "grabbing" : "grab",
                userSelect: "none" as any,
                outline: "none",
                animation: i === 0 && !isBeingDragged ? "upnext-pulse 2s ease-in-out infinite" : "none",
              }}
            >
              <span style={{ fontSize: 12, color: "var(--text-tertiary)", flexShrink: 0, opacity: 0.35, pointerEvents: "none" }}>⠿</span>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", width: 18, flexShrink: 0, textAlign: "right" as any, pointerEvents: "none" }}>{i + 1}</span>
              {catLabel && (
                <span style={{ fontSize: 7, fontWeight: 800, color: "#fff", background: color, padding: "2px 6px", borderRadius: 10, letterSpacing: "0.08em", flexShrink: 0, pointerEvents: "none", opacity: 0.9 }}>{catLabel}</span>
              )}
              <div style={{ flex: 1, minWidth: 0, pointerEvents: "none" }}>
                <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, fontWeight: 600, letterSpacing: "-0.01em" }}>{item.title}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{item.artist}</div>
              </div>
              {(item as any).duration_ms > 0 && (
                <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", flexShrink: 0, pointerEvents: "none" }}>
                  {Math.floor((item as any).duration_ms/60000)}:{String(Math.floor(((item as any).duration_ms%60000)/1000)).padStart(2,"0")}
                </span>
              )}
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); removeItem(i); }}
                style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "0 4px", flexShrink: 0 }}
              >✕</button>
            </div>
          );
        })}
        {queue.length > 50 && <div style={{ padding: "8px", fontSize: 10, color: "var(--text-tertiary)", textAlign: "center" as any }}>+ {queue.length - 50} more</div>}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          style={{ position: "fixed" as any, zIndex: 50, background: "var(--bg-elevated, var(--bg-secondary))", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-sm, 8px)", boxShadow: "var(--shadow-lg)", padding: "4px 0", minWidth: 180, left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ padding: "4px 12px", fontSize: 10, color: "var(--text-tertiary)", borderBottom: "1px solid var(--border-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{queue[contextMenu.idx]?.title}</div>
          <button onClick={() => moveToTop(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Play Next</button>
          <button onClick={() => moveUp(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Move Up</button>
          <button onClick={() => moveDown(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Move Down</button>
          <button onClick={() => moveToTop(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Move to Top</button>
          <button onClick={() => moveToBottom(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Move to Bottom</button>
          <div style={{ borderTop: "1px solid var(--border-primary)" }} />
          <button onClick={() => removeItem(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--accent-red)", background: "none", border: "none", cursor: "pointer" }}>Remove</button>
        </div>
      )}
    </div>
  );
}
