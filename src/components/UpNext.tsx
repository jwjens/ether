import { useState, useEffect, useRef, useCallback } from "react";
import { engine } from "../audio/engine-rodio";
import { query } from "../db/client";
import { getNextTransition, NextTransition } from "../audio/showClock";

// ── ShowTicker ────────────────────────────────────────────────
// Live countdown to next SHOW TRANSITION + current/next show + progress bar.
// Turns amber when less than 5 minutes remain before the next show.

interface ShowInfo { name: string; start_hour: number; end_hour: number; days: string; }

function fmtHour(h: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const h12    = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:00 ${suffix}`;
}

function ShowTicker() {
  const [now, setNow]                         = useState(() => new Date());
  const [currentShow, setCurrentShow]         = useState<ShowInfo | null>(null);
  const [nextTransition, setNextTransition]   = useState<NextTransition | null>(null);

  // Tick every second
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Reload shows + next transition every 30 seconds
  const loadShows = useCallback(async () => {
    try {
      const shows = await query<ShowInfo>(
        "SELECT name, start_hour, end_hour, days FROM shows WHERE is_active = 1 ORDER BY start_hour"
      );
      const hour = new Date().getHours();
      const day  = String(new Date().getDay());

      const current = shows.find(s => {
        if (!s.days.includes(day)) return false;
        if (s.end_hour === 0 || s.end_hour === s.start_hour) return hour >= s.start_hour;
        if (s.end_hour > s.start_hour) return hour >= s.start_hour && hour < s.end_hour;
        return hour >= s.start_hour || hour < s.end_hour;
      }) ?? null;
      setCurrentShow(current);

      // Get the next show transition from showClock
      const nx = await getNextTransition();
      setNextTransition(nx);
    } catch {}
  }, []);

  useEffect(() => {
    loadShows();
    const id = setInterval(loadShows, 30_000);
    return () => clearInterval(id);
  }, [loadShows]);

  // Countdown: if there's a show transition within 24h, count down to it.
  // Otherwise fall back to top-of-hour countdown.
  const hasTransition = nextTransition !== null;
  const transitionSecsAway = hasTransition
    ? Math.max(0, Math.round((nextTransition!.startsAt.getTime() - now.getTime()) / 1000))
    : null;

  // Use top-of-hour as fallback display
  const totalSecs = 3600;
  const elapsed   = now.getMinutes() * 60 + now.getSeconds();
  const hourRemaining = totalSecs - elapsed;

  const displaySecs = transitionSecsAway !== null ? transitionSecsAway : hourRemaining;
  const mm = String(Math.floor(displaySecs / 60)).padStart(2, "0");
  const ss = String(displaySecs % 60).padStart(2, "0");

  // Amber when ≤ 5 minutes to next show transition (300 seconds)
  const criticalThreshold = 300;
  const nearEnd = hasTransition
    ? transitionSecsAway !== null && transitionSecsAway <= criticalThreshold
    : hourRemaining <= 600;

  const barColor = nearEnd ? "#f59e0b" : "#14b8a6";

  // Progress bar: show fraction of time elapsed toward next transition
  const totalForBar = hasTransition
    ? Math.max(1, (nextTransition!.startsAt.getTime() - now.getTime()) / 1000 + displaySecs)
    : totalSecs;
  const progress = hasTransition
    ? Math.max(0, Math.min(1, 1 - (transitionSecsAway || 0) / Math.max(1, totalForBar)))
    : elapsed / totalSecs;

  const countdownLabel = hasTransition
    ? `until ${nextTransition!.showName}`
    : "remaining in hour";

  const nextLine = hasTransition
    ? `↳ ${nextTransition!.showName} at ${nextTransition!.startsAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
    : null;

  return (
    <div style={{ padding: "8px 14px 0", borderBottom: "1px solid var(--border-primary)" }}>
      {/* Row: countdown + show name */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <span style={{
          fontFamily: "'DM Mono', 'Courier New', monospace",
          fontSize: 20, fontWeight: 700,
          color: nearEnd ? "#f59e0b" : "var(--text-primary)",
          letterSpacing: "-0.02em", lineHeight: 1,
          transition: "color 1s",
        }}>
          {mm}:{ss}
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: nearEnd ? "#f59e0b" : "var(--text-tertiary)", transition: "color 1s" }}>
            {countdownLabel}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", letterSpacing: "0.01em" }}>
            {currentShow ? currentShow.name : "Unscheduled"}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: 3, background: "var(--bg-tertiary)", marginBottom: 6, overflow: "hidden" }}>
        <div style={{
          height: "100%",
          width: `${progress * 100}%`,
          background: barColor,
          transition: "width 1s linear, background 2s",
        }} />
      </div>

      {/* Next show transition */}
      {nextLine && (
        <div style={{ paddingBottom: 7, fontSize: 10, color: nearEnd ? "#f59e0b" : "var(--text-tertiary)", letterSpacing: "0.01em", transition: "color 1s", fontWeight: nearEnd ? 700 : 400 }}>
          {nearEnd && "⚡ "}{nextLine}
        </div>
      )}
      {!nextLine && (
        <div style={{ paddingBottom: 7, fontSize: 10, color: "var(--text-tertiary)" }}>
          ↳ No upcoming show transition
        </div>
      )}
    </div>
  );
}

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
  const [artUrls, setArtUrls] = useState<Record<string, string>>({});
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
    queue.forEach((item) => {
      const key = `${item.title}::${item.artist}`;
      if (artUrls[key] !== undefined) return;
      fetchArt(item.title || '', item.artist || '').then(url => {
        if (url) setArtUrls(prev => ({ ...prev, [key]: url }));
      });
    });
    // Calculate total queue duration
    const total = queue.reduce((sum, q) => sum + ((q as any).durationMs || 0), 0);
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
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.06em" }}>Up Next ({queueLen})</span>
            {totalDuration > 0 && (
              <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", background: "var(--bg-tertiary)", padding: "2px 7px", borderRadius: 0, border: "1px solid var(--border-primary)" }}>
                {Math.floor(totalDuration / 3600000) > 0
                  ? `${Math.floor(totalDuration / 3600000)}h ${Math.floor((totalDuration % 3600000) / 60000)}m`
                  : `${Math.floor(totalDuration / 60000)}m ${Math.floor((totalDuration % 60000) / 1000)}s`}
              </span>
            )}
          </div>
          {queue.length > 0 && <button onClick={() => { engine.clearQueue(); onQueueChange(); }} style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer" }}>Clear All</button>}
        </div>
        <ShowTicker />
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
                display: "flex", alignItems: "center", gap: 8,
                padding: i === 0 ? "10px 12px" : "8px 12px",
                borderBottom: "1px solid var(--border-primary)",
                borderLeft: `3px solid ${color}`,
                borderTop: isDropTarget ? "2px solid #38bdf8" : "none",
                background: isBeingDragged
                  ? "rgba(56,189,248,0.08)"
                  : i === 0
                  ? `${color}08`
                  : "transparent",
                opacity: isBeingDragged ? 0.45 : 1,
                cursor: isBeingDragged ? "grabbing" : "grab",
                userSelect: "none" as any,
                outline: "none",
                transition: "background 0.15s",
              }}
            >
              {/* Position number */}
              <span style={{ fontSize: 10, color: "var(--text-tertiary)", width: 16, flexShrink: 0, textAlign: "right" as any, pointerEvents: "none", fontFamily: "'DM Mono', monospace", opacity: 0.5 }}>{i + 1}</span>

              {/* Artwork thumbnail */}
              <div style={{ width: 32, height: 32, borderRadius: 0, flexShrink: 0, overflow: "hidden", background: `${color}18`, border: `1px solid ${color}30`, pointerEvents: "none" }}>
                {artUrls[`${item.title}::${item.artist}`] ? (
                  <img src={artUrls[`${item.title}::${item.artist}`]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>🎵</div>
                )}
              </div>

              {/* Category badge */}
              {catLabel && (
                <span style={{ fontSize: 7, fontWeight: 800, color: "#fff", background: color, padding: "2px 5px", borderRadius: 0, letterSpacing: "0.06em", flexShrink: 0, pointerEvents: "none" }}>{catLabel}</span>
              )}

              {/* Title + artist */}
              <div style={{ flex: 1, minWidth: 0, pointerEvents: "none" }}>
                <div style={{ fontSize: i === 0 ? 13 : 12, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, fontWeight: i === 0 ? 700 : 600, letterSpacing: "-0.01em" }}>{item.title}</div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{item.artist}</div>
              </div>

              {/* Duration — always shown */}
              <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", flexShrink: 0, pointerEvents: "none", opacity: 0.7 }}>
                {(item as any).durationMs > 0
                  ? `${Math.floor((item as any).durationMs/60000)}:${String(Math.floor(((item as any).durationMs%60000)/1000)).padStart(2,"0")}`
                  : (item as any).duration_ms > 0
                  ? `${Math.floor((item as any).duration_ms/60000)}:${String(Math.floor(((item as any).duration_ms%60000)/1000)).padStart(2,"0")}`
                  : ""}
              </span>

              {/* Remove button */}
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); removeItem(i); }}
                style={{ fontSize: 10, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "0 2px", flexShrink: 0, opacity: 0.5 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "0.5"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
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
