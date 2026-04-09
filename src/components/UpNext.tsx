import { useState, useEffect, useRef, useCallback } from "react";
import { engine } from "../audio/engine-rodio";
import { query } from "../db/client";
import { getNextTransition, NextTransition } from "../audio/showClock";

// ── Types ─────────────────────────────────────────────────────

interface ShowInfo { name: string; start_hour: number; end_hour: number; days: string; }
interface CategoryInfo { id: number; code: string; name: string; color: string; }

// ── Helpers ───────────────────────────────────────────────────

function fmtHour(h: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:00 ${suffix}`;
}

function fmtDur(ms: number): string {
  if (!ms || ms <= 0) return "";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Tiny artwork cache
const artCache: Record<string, string> = {};
async function fetchArt(title: string, artist: string): Promise<string | null> {
  const key = `${title}::${artist}`;
  if (artCache[key] !== undefined) return artCache[key] || null;
  try {
    const q = encodeURIComponent(`${title} ${artist}`.replace(/\(feat\..*?\)/gi, "").replace(/\s*[-–]\s*remaster.*/gi, "").trim());
    const r = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`);
    const d = await r.json();
    const url = d?.results?.[0]?.artworkUrl100?.replace("100x100bb", "60x60bb") ?? null;
    artCache[key] = url || "";
    return url;
  } catch { artCache[key] = ""; return null; }
}

// ── ShowTicker (embedded in panel) ───────────────────────────

function NowPlayingBlock() {
  const [now, setNow]               = useState(() => new Date());
  const [currentShow, setCurrentShow] = useState<ShowInfo | null>(null);
  const [nextTransition, setNextTrans] = useState<NextTransition | null>(null);
  const [nextShow, setNextShow]     = useState<ShowInfo | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadShows = useCallback(async () => {
    try {
      const shows = await query<ShowInfo>("SELECT name, start_hour, end_hour, days FROM shows WHERE is_active = 1 ORDER BY start_hour");
      const hour = new Date().getHours();
      const curr = shows.find(s => {
        if (s.end_hour === 0 || s.end_hour === s.start_hour) return hour >= s.start_hour;
        if (s.end_hour > s.start_hour) return hour >= s.start_hour && hour < s.end_hour;
        return hour >= s.start_hour || hour < s.end_hour;
      }) ?? null;
      setCurrentShow(curr);
      const nx = await getNextTransition();
      setNextTrans(nx);
      if (nx) {
        const nxShow = shows.find(s => s.name === nx.showName) ?? null;
        setNextShow(nxShow);
      }
    } catch {}
  }, []);

  useEffect(() => { loadShows(); const id = setInterval(loadShows, 30_000); return () => clearInterval(id); }, [loadShows]);

  const hasTransition = nextTransition !== null;
  const transitionSecs = hasTransition
    ? Math.max(0, Math.round((nextTransition!.startsAt.getTime() - now.getTime()) / 1000))
    : null;
  const elapsed = now.getMinutes() * 60 + now.getSeconds();
  const hourRemaining = 3600 - elapsed;
  const displaySecs = transitionSecs !== null ? transitionSecs : hourRemaining;

  const mm = String(Math.floor(displaySecs / 60)).padStart(2, "0");
  const ss = String(displaySecs % 60).padStart(2, "0");

  const critical = hasTransition
    ? transitionSecs !== null && transitionSecs <= 600
    : hourRemaining <= 600;

  // Show progress bar
  const showDurationSecs = currentShow
    ? (() => {
        const endH = currentShow.end_hour === 0 ? 24 : currentShow.end_hour;
        return (endH - currentShow.start_hour) * 3600;
      })()
    : 3600;
  const showElapsedSecs = currentShow
    ? (now.getHours() - currentShow.start_hour) * 3600 + elapsed
    : elapsed;
  const barProgress = Math.min(1, Math.max(0, showElapsedSecs / showDurationSecs));
  const barAmber = barProgress > 0.85 || critical;

  const countdownLabel = hasTransition
    ? `until ${nextTransition!.showName}`
    : "remaining in hour";

  const nextStartTime = nextTransition
    ? nextTransition.startsAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <>
      {/* Now playing block */}
      <div style={{
        background: "#111118",
        borderLeft: "2px solid #6040c0",
        padding: "12px 14px",
        marginBottom: 1,
      }}>
        {/* Live dot + label */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span className="ether-live-dot" />
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: "#6040c0", textTransform: "uppercase" as const }}>Now playing</span>
        </div>

        {/* Show name */}
        <div style={{ fontSize: 12, fontWeight: 500, color: "#c0c0d0", marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
          {currentShow?.name ?? "Unscheduled"}
        </div>

        {/* Countdown */}
        <div style={{ marginBottom: 6 }}>
          <span style={{
            fontFamily: "'DM Mono', 'Courier New', monospace",
            fontSize: 36, fontWeight: 300,
            color: critical ? "#c87828" : "#e0e0f0",
            letterSpacing: "-0.02em", lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
            transition: "color 2s",
            display: "inline-block",
          }}>
            <span>{mm}:</span>
            <span className="ether-tick">{ss}</span>
          </span>
        </div>

        {/* Label */}
        <div style={{ fontSize: 10, color: "#5050a0", marginBottom: 10, letterSpacing: "0.02em" }}>
          {critical && <span style={{ color: "#c87828", marginRight: 4 }}>⚡</span>}
          {countdownLabel}
        </div>

        {/* Progress bar */}
        <div style={{ height: 2, background: "#1a1a2a", overflow: "hidden", position: "relative" as const }}>
          <div style={{
            height: "100%",
            width: `${barProgress * 100}%`,
            background: barAmber ? "#8a5a10" : "#6040c0",
            position: "relative" as const,
            transition: "width 1s linear, background 2s",
          }}>
            <span className={barAmber ? "ether-glow-amber" : "ether-glow-purple"} />
          </div>
        </div>
      </div>

      {/* Next show block */}
      {nextTransition && (
        <div style={{
          background: "#0e0e14",
          borderLeft: "1px solid #252535",
          padding: "10px 14px",
          marginBottom: 1,
        }}>
          <div style={{ fontSize: 9, color: "#6060a0", letterSpacing: "0.1em", textTransform: "uppercase" as const, marginBottom: 4 }}>↳ Next show</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#505060" }}>{nextStartTime}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#808090", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 }}>{nextTransition.showName}</span>
          </div>
        </div>
      )}

      {/* CSS keyframes */}
      <style>{`
        @keyframes ether-pulse {
          0%,100%{opacity:1;transform:scale(1);}
          50%{opacity:0.4;transform:scale(0.85);}
        }
        @keyframes ether-tick {
          0%{opacity:1;}50%{opacity:0.6;}100%{opacity:1;}
        }
        @keyframes ether-glow {
          0%,100%{box-shadow:0 0 4px 1px #6040c060;}
          50%{box-shadow:0 0 8px 2px #6040c090;}
        }
        @keyframes ether-glow-amber {
          0%,100%{box-shadow:0 0 4px 1px #8a5a1060;}
          50%{box-shadow:0 0 8px 2px #8a5a1090;}
        }
        .ether-live-dot {
          display:inline-block;
          width:6px;height:6px;border-radius:50%;
          background:#8060e0;
          animation:ether-pulse 1.8s ease-in-out infinite;
        }
        .ether-tick {
          animation:ether-tick 1s steps(1,end) infinite;
          display:inline-block;
        }
        .ether-glow-purple::after {
          content:'';
          position:absolute;top:0;right:0;
          width:3px;height:100%;
          animation:ether-glow 2s ease-in-out infinite;
        }
        .ether-glow-amber::after {
          content:'';
          position:absolute;top:0;right:0;
          width:3px;height:100%;
          animation:ether-glow-amber 1.2s ease-in-out infinite;
        }
      `}</style>
    </>
  );
}

// ── UpNext (main component) ────────────────────────────────────

interface Props { queueLen: number; onQueueChange: () => void; }

const CATEGORY_COLORS: Record<string, string> = {
  A: "#ef4444", B: "#f59e0b", C: "#22c55e", D: "#3b82f6",
  spot: "#a855f7", liner: "#ec4899", jingle: "#14b8a6", news: "#6366f1",
};

export default function UpNext({ queueLen, onQueueChange }: Props) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [categories, setCategories]   = useState<CategoryInfo[]>([]);
  const [artUrls, setArtUrls]         = useState<Record<string, string>>({});
  const [totalDuration, setTotalDuration] = useState(0);

  const dragIdxRef     = useRef<number | null>(null);
  const dragOverIdxRef = useRef<number | null>(null);
  const isDraggingRef  = useRef(false);
  const dragStartYRef  = useRef(0);
  const [dragVisual, setDragVisual] = useState<{ from: number | null; over: number | null }>({ from: null, over: null });

  const queue = engine.getQueue();

  useEffect(() => {
    queue.forEach(item => {
      const key = `${item.title}::${item.artist}`;
      if (artUrls[key] !== undefined) return;
      fetchArt(item.title || "", item.artist || "").then(url => {
        if (url) setArtUrls(prev => ({ ...prev, [key]: url }));
      });
    });
    setTotalDuration(queue.reduce((s, q) => s + ((q as any).durationMs || 0), 0));
  }, [queueLen]);

  useEffect(() => {
    (async () => {
      try { setCategories(await query<CategoryInfo>("SELECT id, code, name, color FROM categories")); } catch {}
    })();
  }, []);

  const getItemColor = (item: any): string => {
    if (item.itemType) return CATEGORY_COLORS[item.itemType] || "#4a4a6a";
    if (item.category) {
      const cat = categories.find(c => String(c.id) === String(item.category));
      if (cat) return cat.color || CATEGORY_COLORS[cat.code] || "#4a4a6a";
    }
    const t = (item.title || "").toLowerCase();
    if (t.startsWith("[vt]")) return "#ec4899";
    if (t.includes("jingle") || t.includes("sweeper")) return CATEGORY_COLORS["jingle"];
    if (t.includes("promo") || t.includes("psa")) return CATEGORY_COLORS["spot"];
    return "#4a4a6a";
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
    setTimeout(() => engine.triggerPreload(), 100);
  };

  const handleMouseDown = (e: React.MouseEvent, idx: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragIdxRef.current = idx;
    dragOverIdxRef.current = idx;
    isDraggingRef.current = false;
    dragStartYRef.current = e.clientY;

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientY - dragStartYRef.current) > 5) isDraggingRef.current = true;
      if (!isDraggingRef.current) return;
      const items = Array.from(document.querySelectorAll("[data-queue-item]"));
      let over = items.length - 1;
      for (let i = 0; i < items.length; i++) {
        const rect = items[i].getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) { over = i; break; }
      }
      dragOverIdxRef.current = over;
      setDragVisual({ from: dragIdxRef.current, over });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
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
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleContext = (e: React.MouseEvent, idx: number) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, idx }); };
  const closeContext = () => setContextMenu(null);
  const moveUp   = (idx: number) => { if (idx <= 0) return; const q = engine.getQueue(); const it = q.splice(idx, 1)[0]; q.splice(idx - 1, 0, it); rebuild(q); closeContext(); };
  const moveDown = (idx: number) => { const q = engine.getQueue(); if (idx >= q.length - 1) return; const it = q.splice(idx, 1)[0]; q.splice(idx + 1, 0, it); rebuild(q); closeContext(); };
  const moveToTop    = (idx: number) => { const q = engine.getQueue(); const it = q.splice(idx, 1)[0]; q.unshift(it); rebuild(q); closeContext(); };
  const moveToBottom = (idx: number) => { const q = engine.getQueue(); const it = q.splice(idx, 1)[0]; q.push(it); rebuild(q); closeContext(); };
  const removeItem   = (idx: number) => { const q = engine.getQueue(); q.splice(idx, 1); rebuild(q); closeContext(); };

  const handleCartDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; };
  const handleCartDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const cartData = e.dataTransfer.getData("application/cart");
    if (cartData) {
      try { const cart = JSON.parse(cartData); engine.addToQueue([{ filePath: cart.filePath, title: cart.title, artist: cart.artist || "" }]); onQueueChange(); } catch {}
    }
  };

  const totalDurStr = totalDuration > 0
    ? (Math.floor(totalDuration / 3600000) > 0
        ? `${Math.floor(totalDuration / 3600000)}h ${Math.floor((totalDuration % 3600000) / 60000)}m`
        : `${Math.floor(totalDuration / 60000)}m ${Math.floor((totalDuration % 60000) / 1000)}s`)
    : null;

  return (
    <div
      style={{ background: "#0e0e12", border: "1px solid #1e1e2e", display: "flex", flexDirection: "column" as any, height: "100%", overflow: "hidden" }}
      onClick={closeContext}
    >
      {/* Panel header */}
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #1e1e2e", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "#505070", textTransform: "uppercase" as const }}>Up Next</span>
          <span style={{ fontSize: 9, color: "#505070", fontFamily: "'DM Mono', monospace" }}>({queueLen})</span>
          {totalDurStr && (
            <span style={{ fontSize: 9, color: "#505070", fontFamily: "'DM Mono', monospace", background: "#111118", padding: "1px 6px", border: "1px solid #1e1e2e" }}>{totalDurStr}</span>
          )}
        </div>
        {queue.length > 0 && (
          <button onClick={() => { engine.clearQueue(); onQueueChange(); }}
            style={{ fontSize: 9, color: "#505070", background: "none", border: "none", cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase" as const }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "#ef4444"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "#505070"}
          >Clear All</button>
        )}
      </div>

      {/* Now playing + next show */}
      <div style={{ flexShrink: 0 }}>
        <NowPlayingBlock />
      </div>

      {/* Queue section */}
      <div style={{ padding: "8px 14px 4px", borderBottom: "1px solid #1e1e2e", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "#505070", textTransform: "uppercase" as const }}>Queue</span>
        <span style={{ fontSize: 9, color: "#505070", fontFamily: "'DM Mono', monospace" }}>{queue.length}</span>
      </div>

      {/* Queue list */}
      <div style={{ flex: 1, overflowY: "auto" as any }} onDragOver={handleCartDragOver} onDrop={handleCartDrop}>
        {queue.length === 0 ? (
          <div style={{ padding: "28px 14px", textAlign: "center" as any }}>
            <div style={{ fontSize: 11, color: "#505070", marginBottom: 4 }}>Queue empty</div>
            <div style={{ fontSize: 10, color: "#1e1e2e" }}>Drag carts here or use GEN LOG</div>
          </div>
        ) : queue.slice(0, 50).map((item, i) => {
          const color = getItemColor(item);
          const catLabel = getCatLabel(item);
          const ms = (item as any).durationMs || (item as any).duration_ms || 0;
          const artKey = `${item.title}::${item.artist}`;
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
                padding: "8px 14px",
                borderBottom: "1px solid #1e1e2e",
                borderTop: isDropTarget ? "2px solid #6040c0" : "none",
                background: isBeingDragged ? "rgba(96,64,192,0.06)" : "transparent",
                opacity: isBeingDragged ? 0.4 : 1,
                cursor: isBeingDragged ? "grabbing" : "grab",
                userSelect: "none" as any,
                transition: "background 0.1s",
              }}
            >
              {/* Position */}
              <span style={{ fontSize: 9, color: "#505070", width: 14, textAlign: "right" as any, flexShrink: 0, fontFamily: "'DM Mono', monospace" }}>{i + 1}</span>

              {/* Artwork */}
              <div style={{ width: 28, height: 28, flexShrink: 0, background: `${color}12`, border: `1px solid ${color}20`, overflow: "hidden" }}>
                {artUrls[artKey]
                  ? <img src={artUrls[artKey]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: color }}>♪</div>
                }
              </div>

              {/* Cat badge */}
              {catLabel && (
                <span style={{ fontSize: 7, fontWeight: 800, color: "#000", background: color, padding: "1px 4px", letterSpacing: "0.06em", flexShrink: 0 }}>{catLabel}</span>
              )}

              {/* Title + artist */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#c0c0d0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, letterSpacing: "-0.01em" }}>{item.title}</div>
                <div style={{ fontSize: 9, color: "#606070", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{item.artist}</div>
              </div>

              {/* Duration */}
              {ms > 0 && (
                <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "#505070", flexShrink: 0 }}>{fmtDur(ms)}</span>
              )}

              {/* Remove */}
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); removeItem(i); }}
                style={{ fontSize: 9, color: "#505070", background: "none", border: "none", cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "#505070"; }}
              >✕</button>
            </div>
          );
        })}
        {queue.length > 50 && (
          <div style={{ padding: 8, fontSize: 9, color: "#505070", textAlign: "center" as any, fontFamily: "'DM Mono', monospace" }}>+{queue.length - 50} more</div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          style={{ position: "fixed" as any, zIndex: 50, background: "#111118", border: "1px solid #1e1e2e", padding: "4px 0", minWidth: 180, left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ padding: "4px 12px", fontSize: 9, color: "#505070", borderBottom: "1px solid #1e1e2e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, fontFamily: "'DM Mono', monospace" }}>{queue[contextMenu.idx]?.title}</div>
          {[
            { label: "Play Next", fn: () => moveToTop(contextMenu.idx) },
            { label: "Move Up",   fn: () => moveUp(contextMenu.idx) },
            { label: "Move Down", fn: () => moveDown(contextMenu.idx) },
            { label: "Move to Bottom", fn: () => moveToBottom(contextMenu.idx) },
          ].map(item => (
            <button key={item.label} onClick={item.fn} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 11, color: "#9090b0", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "#1a1a2a"}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}
            >{item.label}</button>
          ))}
          <div style={{ borderTop: "1px solid #1e1e2e" }} />
          <button onClick={() => removeItem(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 11, color: "#ef4444", background: "none", border: "none", cursor: "pointer" }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "#1a1a2a"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}
          >Remove</button>
        </div>
      )}
    </div>
  );
}
