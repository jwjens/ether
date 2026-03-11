import { useState, useRef, useEffect } from "react";
import { engine } from "../audio/engine";
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
  "A": "#ef4444",  // red - power current
  "B": "#f59e0b",  // amber - secondary
  "C": "#22c55e",  // green - tertiary
  "D": "#3b82f6",  // blue - gold/recurrent
  "spot": "#a855f7", // purple - spots
  "liner": "#ec4899", // pink - liners
  "jingle": "#14b8a6", // teal - jingles
  "news": "#6366f1", // indigo - news
};

export default function UpNext({ queueLen, onQueueChange }: Props) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [activeShow, setActiveShow] = useState<ActiveShow | null>(null);

  const queue = engine.getQueue();

  // Load categories
  useEffect(() => {
    (async () => {
      try {
        const cats = await query<CategoryInfo>("SELECT id, code, name, color FROM categories");
        setCategories(cats);
      } catch {}
    })();
  }, []);

  // Load active show/daypart
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

  // Get color for a queue item
  const getItemColor = (item: any): string => {
    if (item.itemType) {
      return CATEGORY_COLORS[item.itemType] || "var(--text-tertiary)";
    }
    if (item.category) {
      const cat = categories.find(c => String(c.id) === String(item.category));
      if (cat) return cat.color || CATEGORY_COLORS[cat.code] || "var(--text-tertiary)";
    }
    // Try to detect type from title prefix
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
  };

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  };

  const handleDrop = (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault();
    setDragOverIdx(null);
    const cartData = e.dataTransfer.getData("application/cart");
    if (cartData) {
      try {
        const cart = JSON.parse(cartData);
        const q = engine.getQueue();
        q.splice(targetIdx, 0, { filePath: cart.filePath, title: cart.title, artist: cart.artist || "" });
        rebuild(q);
        return;
      } catch {}
    }
    const sourceIdx = dragIdx;
    if (sourceIdx === null || sourceIdx === targetIdx) return;
    const q = engine.getQueue();
    const item = q.splice(sourceIdx, 1)[0];
    q.splice(targetIdx, 0, item);
    rebuild(q);
    setDragIdx(null);
  };

  const handleDragEnd = () => { setDragIdx(null); setDragOverIdx(null); };

  const handleListDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/cart")) { e.preventDefault(); setDropTarget(true); }
  };

  const handleListDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(false);
    const cartData = e.dataTransfer.getData("application/cart");
    if (cartData) {
      try {
        const cart = JSON.parse(cartData);
        engine.addToQueue([{ filePath: cart.filePath, title: cart.title, artist: cart.artist || "" }]);
        onQueueChange();
      } catch {}
    }
  };

  const handleContext = (e: React.MouseEvent, idx: number) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, idx }); };
  const closeContext = () => setContextMenu(null);

  const moveUp = (idx: number) => { if (idx <= 0) return; const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.splice(idx - 1, 0, item); rebuild(q); closeContext(); };
  const moveDown = (idx: number) => { const q = engine.getQueue(); if (idx >= q.length - 1) return; const item = q.splice(idx, 1)[0]; q.splice(idx + 1, 0, item); rebuild(q); closeContext(); };
  const moveToTop = (idx: number) => { const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.unshift(item); rebuild(q); closeContext(); };
  const moveToBottom = (idx: number) => { const q = engine.getQueue(); const item = q.splice(idx, 1)[0]; q.push(item); rebuild(q); closeContext(); };
  const removeItem = (idx: number) => { const q = engine.getQueue(); q.splice(idx, 1); rebuild(q); closeContext(); };

  return (
    <div style={{ background: "var(--bg-secondary)", borderRadius: "var(--radius)", border: "1px solid var(--border-primary)", boxShadow: "var(--shadow-sm)", display: "flex", flexDirection: "column" as any, height: "100%", overflow: "hidden" }} onClick={closeContext}>
      {/* Header with active daypart */}
      <div style={{ borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px" }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.06em" }}>Up Next ({queueLen})</span>
          {queue.length > 0 && <button onClick={() => { engine.clearQueue(); onQueueChange(); }} style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>Clear All</button>}
        </div>
        {activeShow && (
          <div style={{ padding: "0 14px 8px", display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-green)" }}></div>
            <span style={{ fontSize: 10, fontWeight: 500, color: "var(--accent-green)" }}>{activeShow.name}</span>
            {activeShow.clock_name && <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>— {activeShow.clock_name}</span>}
          </div>
        )}
      </div>

      {/* Queue items */}
      <div style={{ flex: 1, overflowY: "auto" as any, ...(dropTarget ? { boxShadow: "inset 0 0 0 2px var(--accent-blue)" } : {}) }}
        onDragOver={handleListDragOver}
        onDragLeave={() => setDropTarget(false)}
        onDrop={handleListDrop}>
        {queue.length === 0 ? (
          <div style={{ padding: "32px 12px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic", textAlign: "center" as any }}>
            <div style={{ marginBottom: 4 }}>Queue empty</div>
            <div style={{ fontSize: 10 }}>Drag carts here or use GEN LOG</div>
          </div>
        ) : queue.slice(0, 50).map((item, i) => {
          const color = getItemColor(item);
          const catLabel = getCatLabel(item);
          return (
            <div key={i}
              draggable
              onDragStart={e => handleDragStart(e, i)}
              onDragOver={e => handleDragOver(e, i)}
              onDrop={e => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
              onContextMenu={e => handleContext(e, i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 10px",
                borderBottom: "1px solid var(--border-primary)",
                cursor: "grab",
                opacity: dragIdx === i ? 0.3 : 1,
                borderTop: dragOverIdx === i ? "2px solid var(--accent-blue)" : "none",
                background: i === 0 ? "var(--bg-tertiary)" : "transparent",
                borderLeft: "3px solid " + color,
              }}>
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", width: 18, flexShrink: 0, textAlign: "right" as any }}>{i + 1}</span>
              {catLabel && (
                <span style={{
                  fontSize: 8,
                  fontWeight: 700,
                  color: "#fff",
                  background: color,
                  padding: "1px 5px",
                  borderRadius: 3,
                  letterSpacing: "0.05em",
                  flexShrink: 0,
                }}>{catLabel}</span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{item.title}</div>
                <div style={{ fontSize: 10, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{item.artist}</div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); removeItem(i); }} style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}>x</button>
            </div>
          );
        })}
        {queue.length > 50 && <div style={{ padding: "8px", fontSize: 10, color: "var(--text-tertiary)", textAlign: "center" as any }}>+ {queue.length - 50} more</div>}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div style={{ position: "fixed" as any, zIndex: 50, background: "var(--bg-elevated, var(--bg-secondary))", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-sm, 8px)", boxShadow: "var(--shadow-lg)", padding: "4px 0", minWidth: 180, left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}>
          <div style={{ padding: "4px 12px", fontSize: 10, color: "var(--text-tertiary)", borderBottom: "1px solid var(--border-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{queue[contextMenu.idx]?.title}</div>
          <button onClick={() => moveToTop(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Play Next</button>
          <button onClick={() => moveUp(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Move Up</button>
          <button onClick={() => moveDown(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Move Down</button>
          <button onClick={() => moveToTop(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Move to Top</button>
          <button onClick={() => moveToBottom(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--text-primary)", background: "none", border: "none", cursor: "pointer" }}>Move to Bottom</button>
          <div style={{ borderTop: "1px solid var(--border-primary)" }}></div>
          <button onClick={() => removeItem(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 12, color: "var(--accent-red)", background: "none", border: "none", cursor: "pointer" }}>Remove</button>
        </div>
      )}
    </div>
  );
}
