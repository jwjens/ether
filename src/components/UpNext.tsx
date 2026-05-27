import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { query } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { getActiveShowClock } from "../audio/loggen";
import { getLocalArt } from "../lib/albumArt";

// ── Types ─────────────────────────────────────────────────────

interface CategoryInfo { id: number; code: string; name: string; color: string; }

function fmtDur(ms: number): string {
  if (!ms || ms <= 0) return "";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Tiny artwork cache — exported so OnAirDeck can share it
export const artCache: Record<string, string> = {};
export async function fetchArt(title: string, artist: string): Promise<string | null> {
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

// ── UpNext (main component) ────────────────────────────────────

interface Props { queueLen: number; onQueueChange: () => void; }

const CATEGORY_COLORS: Record<string, string> = {
  A: "#ef4444", B: "#f59e0b", C: "#22c55e", D: "#3b82f6",
  spot: "#a855f7", liner: "#ec4899", jingle: "#14b8a6", news: "#6366f1",
};

export default function UpNext({ queueLen, onQueueChange }: Props) {
  const engine = useAudioEngine();
  const { stationId, isReady } = useActiveStation();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [categories, setCategories]   = useState<CategoryInfo[]>([]);
  const [artUrls, setArtUrls]         = useState<Record<string, string>>({});

  const [anyPlaying, setAnyPlaying] = useState(false);

  // The active show/daypart whose clock is ACTUALLY filling the queue right now — the
  // real rotation source (same getActiveShowClock the queue filler uses), not decorative.
  const [currentShow, setCurrentShow] = useState<string | null>(null);
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    const resolve = async () => {
      try { const sc = await getActiveShowClock(stationId); if (!cancelled) setCurrentShow(sc?.showName ?? null); }
      catch { if (!cancelled) setCurrentShow(null); }
    };
    resolve();
    const id = setInterval(resolve, 30000); // shows change on hour boundaries; 30s is plenty
    return () => { cancelled = true; clearInterval(id); };
  }, [stationId, isReady, queueLen]);

  const topTitleRef            = useRef<HTMLDivElement>(null);
  const [topScrollPx, setTopScrollPx] = useState(0);

  const dragIdxRef     = useRef<number | null>(null);
  const dragOverIdxRef = useRef<number | null>(null);
  const isDraggingRef  = useRef(false);
  const dragStartYRef  = useRef(0);
  const [dragVisual, setDragVisual] = useState<{ from: number | null; over: number | null }>({ from: null, over: null });

  const [queue, setQueue] = useState(() => engine.getQueue());

  useEffect(() => {
    setQueue(engine.getQueue());
    const interval = setInterval(() => {
      setQueue(engine.getQueue());
    }, 1000);
    return () => clearInterval(interval);
  }, [engine, queueLen]);

  useEffect(() => {
    const update = () => setAnyPlaying(
      (["A", "B", "C"] as const).some(s => engine.getDeck(s)?.getState().status === "playing")
    );
    update();
    return engine.on(update);
  }, [engine]);

  useEffect(() => {
    queue.forEach(item => {
      const key = `${item.title}::${item.artist}`;
      if (artUrls[key] !== undefined) return;
      // Local-first: embedded cover art from the file, then iTunes as the fallback.
      (async () => {
        const local = await getLocalArt((item as any).filePath);
        const url = local || await fetchArt(item.title || "", item.artist || "");
        if (url) setArtUrls(prev => ({ ...prev, [key]: url }));
      })();
    });
  }, [queueLen]);

  useEffect(() => {
    setTopScrollPx(0); // ensure title div has overflow:hidden when scrollWidth is sampled
    const el = topTitleRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      const overflow = el.scrollWidth - el.offsetWidth;
      setTopScrollPx(overflow > 4 ? overflow + 8 : 0);
    });
    return () => cancelAnimationFrame(id);
  }, [queue[2]?.title]);

  useEffect(() => {
    if (!isReady) return;
    (async () => {
      try { setCategories(await queryScoped<CategoryInfo>("SELECT id, code, name, color FROM categories", [], stationId)); } catch {}
    })();
  }, [isReady]);

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
    engine.replaceQueue(newQ);
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
      // `over` is a visual index (0 = first rendered item = engine queue index 2)
      const engineOver = over + 2;
      dragOverIdxRef.current = engineOver;
      setDragVisual({ from: dragIdxRef.current, over: engineOver });
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

  return (
    <div
      style={{ background: "var(--bg-primary)", border: "none", display: "flex", flexDirection: "column" as any, height: "100%", overflow: "hidden" }}
      onClick={closeContext}
    >
      {/* ── NEXT UP header ── */}
      <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid rgba(255,255,255,0.04)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          {currentShow && (
            <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.18em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, lineHeight: 1 }}>Next Up · On Air</span>
          )}
          <span className="next-up-glow" title={currentShow ? `Rotation source: ${currentShow}` : undefined}
            style={{ fontSize: currentShow ? 17 : 20, fontWeight: 700, letterSpacing: "0.08em", color: "#f97316", textTransform: "uppercase" as const, lineHeight: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {currentShow || "Next Up"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            title="Pop out to separate window"
            onClick={() => (window as any).ether?.invoke("window:popout", "upnext")}
            style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "2px 3px", display: "flex", alignItems: "center", transition: "color 0.12s", borderRadius: 0 }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = "#6080c0"}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = "var(--text-tertiary)"}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
          {queue.length > 0 && (
            <button onClick={() => { engine.clearQueue(); onQueueChange(); }}
              style={{ fontSize: 9, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase" as const }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "#ef4444"}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"}
            >Clear All</button>
          )}
        </div>
      </div>

      {/* Queue list */}
      <div style={{ flex: 1, overflowY: "auto" as any }} onDragOver={handleCartDragOver} onDrop={handleCartDrop}>
        {queue.length < 3 ? (
          <div style={{ padding: "28px 14px", textAlign: "center" as any }}>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4 }}>Queue empty</div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", opacity: 0.4 }}>Drag carts here or use GEN LOG</div>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {queue.slice(2, 52).map((item, i) => {
          const engineIdx = i + 2;
          const color = getItemColor(item);
          const catLabel = getCatLabel(item);
          const ms = (item as any).durationMs || (item as any).duration_ms || 0;
          const artKey = `${item.title}::${item.artist}`;
          const isBeingDragged = dragVisual.from === engineIdx;
          const isDropTarget = dragVisual.over === engineIdx && dragVisual.from !== null && dragVisual.from !== engineIdx;

          return (
            <motion.div
              key={`${item.title}-${item.artist}-${engineIdx}`}
              layout
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{
                layout: { duration: 0.35, ease: [0.4, 0, 0.2, 1] },
                opacity: { duration: 0.2 },
                y: { duration: 0.25 },
              }}
              data-queue-item={i}
              onMouseDown={e => handleMouseDown(e, engineIdx)}
              onContextMenu={e => handleContext(e, engineIdx)}
              className=""
              style={{
                "--pulse-rgb": "34, 211, 153",
                display: "flex", alignItems: "stretch",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                borderTop: isDropTarget ? "2px solid #6040c0" : "none",
                background: isBeingDragged ? "rgba(96,64,192,0.06)" : "transparent",
                opacity: isBeingDragged ? 0.4 : 1,
                cursor: isBeingDragged ? "grabbing" : "grab",
                userSelect: "none" as any,
                transition: "background 0.1s",
                animation: i === 0 ? "nextup-pulse 2.4s ease-in-out infinite" : undefined,
              } as React.CSSProperties}
            >
              {/* 4px left category color strip */}
              <div style={{ width: 4, flexShrink: 0, background: color, opacity: 0.75 }} />

              {/* Main content */}
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, padding: "10px 10px 10px 8px", minWidth: 0 }}>
                {/* Album art thumbnail */}
                <div style={{ width: i === 0 ? 48 : 36, height: i === 0 ? 48 : 36, flexShrink: 0, background: "var(--bg-tertiary)", border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" }}>
                  {artUrls[artKey] && (
                    <img src={artUrls[artKey]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  )}
                </div>

                {/* Cat badge */}
                {catLabel && (
                  <span style={{ fontSize: 7, fontWeight: 800, color: "#000", background: color, padding: "1px 4px", letterSpacing: "0.06em", flexShrink: 0 }}>{catLabel}</span>
                )}

                {/* Title + artist */}
                <div style={{
                  flex: 1, minWidth: 0,
                  ...(i === 0 && topScrollPx > 0 ? {
                    overflow: "hidden",
                    WebkitMaskImage: "linear-gradient(to right, transparent 0px, black 20px)",
                    maskImage: "linear-gradient(to right, transparent 0px, black 20px)",
                  } : {}),
                } as React.CSSProperties}>
                  <div
                    ref={i === 0 ? topTitleRef : undefined}
                    style={{
                      fontSize: i === 0 ? 16 : 11, fontWeight: 600, color: "var(--text-primary)",
                      overflow: i === 0 && topScrollPx > 0 ? "visible" : "hidden",
                      textOverflow: i === 0 && topScrollPx > 0 ? undefined : "ellipsis",
                      whiteSpace: "nowrap" as any, letterSpacing: "-0.01em",
                      ...(i === 0 && topScrollPx > 0 ? { animation: "nextup-title-scroll 9s ease-in-out infinite", "--scroll-x": `-${topScrollPx}px` } : {}),
                    } as React.CSSProperties}
                  >{item.title}</div>
                  <div style={{ fontSize: 9, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{item.artist}</div>
                </div>

                {/* Right side: duration + BPM badge + remove */}
                <div style={{ display: "flex", flexDirection: "column" as any, alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
                  {ms > 0 && (
                    <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)" }}>{fmtDur(ms)}</span>
                  )}
                  {(item as any).bpm > 0 && (
                    <span style={{ fontSize: 7, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: "var(--text-tertiary)", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", padding: "0 3px", letterSpacing: "0.04em" }}>
                      {Math.round((item as any).bpm)} bpm
                    </span>
                  )}
                </div>

                {/* Chain type badge — click to cycle SEG/STOP */}
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => {
                    e.stopPropagation();
                    const cur = (item as any).chainType || "segue";
                    const next = cur === "segue" ? "stop" : "segue";
                    engine.setQueueItemChainType(engineIdx, next);
                    onQueueChange();
                  }}
                  title={((item as any).chainType || "segue") === "segue" ? "Segue — auto-advance to next. Click to change to Stop." : "Stop — wait for manual trigger. Click to change to Segue."}
                  style={{
                    fontSize: 7, fontWeight: 800, letterSpacing: "0.08em",
                    padding: "2px 5px", borderRadius: 0, cursor: "pointer", flexShrink: 0,
                    background: ((item as any).chainType || "segue") === "stop" ? "rgba(239,68,68,0.15)" : "rgba(52,211,153,0.10)",
                    color: ((item as any).chainType || "segue") === "stop" ? "var(--accent-red)" : "var(--accent-green)",
                    border: `1px solid ${((item as any).chainType || "segue") === "stop" ? "rgba(239,68,68,0.3)" : "rgba(52,211,153,0.2)"}`,
                  }}
                >
                  {((item as any).chainType || "segue") === "stop" ? "STOP" : "SEG"}
                </button>

                {/* Remove */}
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); removeItem(engineIdx); }}
                  style={{ fontSize: 9, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                >✕</button>
              </div>
            </motion.div>
          );
        })}
          </AnimatePresence>
        )}
        {queue.length > 52 && (
          <div style={{ padding: 8, fontSize: 9, color: "var(--text-tertiary)", textAlign: "center" as any, fontFamily: "'DM Mono', monospace" }}>+{queue.length - 52} more</div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          style={{ position: "fixed" as any, zIndex: 50, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "4px 0", minWidth: 180, left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ padding: "4px 12px", fontSize: 9, color: "var(--text-tertiary)", borderBottom: "1px solid var(--border-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, fontFamily: "'DM Mono', monospace" }}>{queue[contextMenu.idx]?.title}</div>
          {[
            { label: "Play Next", fn: () => moveToTop(contextMenu.idx) },
            { label: "Move Up",   fn: () => moveUp(contextMenu.idx) },
            { label: "Move Down", fn: () => moveDown(contextMenu.idx) },
            { label: "Move to Bottom", fn: () => moveToBottom(contextMenu.idx) },
          ].map(item => (
            <button key={item.label} onClick={item.fn} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 11, color: "var(--text-secondary)", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}
            >{item.label}</button>
          ))}
          <div style={{ borderTop: "1px solid var(--border-primary)" }} />
          <button onClick={() => removeItem(contextMenu.idx)} style={{ width: "100%", padding: "6px 12px", textAlign: "left" as any, fontSize: 11, color: "#ef4444", background: "none", border: "none", cursor: "pointer" }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}
          >Remove</button>
        </div>
      )}
    </div>
  );
}
