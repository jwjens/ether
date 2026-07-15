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

function fmtSec(sec: number): string {
  if (!sec || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// A / B / C deck accent colors — must match the fader strips + ThreeSlotBar.
const DECK_COLORS: Record<"A" | "B" | "C", string> = { A: "var(--deck-a)", B: "var(--deck-b)", C: "var(--deck-c)" };

interface DeckRowState { title: string; artist: string; status: string; positionSec: number; durationSec: number; filePath: string; }

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

// Class-color audit (jingles v1 D3): JIN teal + SPOT amber use the canonical tokens; others unchanged.
const CATEGORY_COLORS: Record<string, string> = {
  A: "#ef4444", B: "#f59e0b", C: "#22c55e", D: "#3b82f6",
  spot: "#fbbf24", liner: "#ec4899", jingle: "#14e0c8", news: "#6366f1",
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
    // Stage 2a: re-render promptly when the daemon's queue changes (engine-rodio re-emits
    // `ether:queue-changed` on every daemon queue event) — not just on the 1s poll. This is what
    // makes intent-driven edits feel instant now that we no longer push the mirror synchronously.
    const onChanged = () => setQueue(engine.getQueue());
    window.addEventListener("ether:queue-changed", onChanged);
    return () => { clearInterval(interval); window.removeEventListener("ether:queue-changed", onChanged); };
  }, [engine, queueLen]);

  useEffect(() => {
    const update = () => setAnyPlaying(
      (["A", "B", "C"] as const).some(s => engine.getDeck(s)?.getState().status === "playing")
    );
    update();
    return engine.on(update);
  }, [engine]);

  // Live A/B/C deck snapshots for the stacked deck rows. engine.on fires on every state
  // change; the 1s tick keeps the playing deck's countdown + progress fresh between events.
  const [deckStates, setDeckStates] = useState<Record<"A" | "B" | "C", DeckRowState>>({
    A: { title: "", artist: "", status: "idle", positionSec: 0, durationSec: 0, filePath: "" },
    B: { title: "", artist: "", status: "idle", positionSec: 0, durationSec: 0, filePath: "" },
    C: { title: "", artist: "", status: "idle", positionSec: 0, durationSec: 0, filePath: "" },
  });
  useEffect(() => {
    const pull = () => setDeckStates(prev => {
      const next = { ...prev };
      (["A", "B", "C"] as const).forEach(id => {
        const s = engine.getDeck(id)?.getState?.();
        next[id] = {
          title: s?.title ?? "", artist: s?.artist ?? "", status: s?.status ?? "idle",
          positionSec: s?.positionSec ?? 0, durationSec: s?.durationSec ?? 0,
          filePath: (s as any)?.filePath ?? "",
        };
      });
      return next;
    });
    pull();
    const unsub = engine.on(pull);
    const tick = setInterval(pull, 1000);
    return () => { unsub(); clearInterval(tick); };
  }, [engine]);

  // Resolve artwork for the songs currently on the decks (local embedded art first, iTunes fallback).
  useEffect(() => {
    (["A", "B", "C"] as const).forEach(id => {
      const s = deckStates[id];
      if (!s.title) return;
      const key = `${s.title}::${s.artist}`;
      if (artUrls[key] !== undefined) return;
      (async () => {
        const local = await getLocalArt(s.filePath);
        const url = local || await fetchArt(s.title, s.artist);
        if (url) setArtUrls(prev => ({ ...prev, [key]: url }));
      })();
    });
  }, [deckStates.A.title, deckStates.B.title, deckStates.C.title]);

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
        if (engine.isDaemonDriven) {
          const qid = engine.getQueue()[from]?.qid;          // Stage 2a: reorder by id, not by array push
          if (qid) engine.queueReorder(qid, to);
        } else {
          const q = engine.getQueue();
          const [item] = q.splice(from, 1);
          q.splice(to, 0, item);
          rebuild(q);
        }
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
  // Stage 2a: in daemon mode every queue edit becomes an id-addressed intent to the daemon (the
  // single source of truth) — never a local splice + replaceQueue clobber. The qid is read from the
  // mirror at the clicked engine-index; the daemon's queue event reconciles the UI. In-process mode
  // keeps the local splice + rebuild path unchanged.
  const qidAt = (idx: number): string | undefined => engine.getQueue()[idx]?.qid;
  const moveUp   = (idx: number) => { if (idx <= 0) return; if (engine.isDaemonDriven) { const qid = qidAt(idx); if (qid) engine.queueReorder(qid, idx - 1); closeContext(); return; } const q = engine.getQueue(); const it = q.splice(idx, 1)[0]; q.splice(idx - 1, 0, it); rebuild(q); closeContext(); };
  const moveDown = (idx: number) => { if (engine.isDaemonDriven) { const qid = qidAt(idx); if (qid) engine.queueReorder(qid, idx + 1); closeContext(); return; } const q = engine.getQueue(); if (idx >= q.length - 1) return; const it = q.splice(idx, 1)[0]; q.splice(idx + 1, 0, it); rebuild(q); closeContext(); };
  const moveToTop    = (idx: number) => { if (engine.isDaemonDriven) { const qid = qidAt(idx); if (qid) engine.queueMove(qid, "top"); closeContext(); return; } const q = engine.getQueue(); const it = q.splice(idx, 1)[0]; q.unshift(it); rebuild(q); closeContext(); };
  const moveToBottom = (idx: number) => { if (engine.isDaemonDriven) { const qid = qidAt(idx); if (qid) engine.queueMove(qid, "bottom"); closeContext(); return; } const q = engine.getQueue(); const it = q.splice(idx, 1)[0]; q.push(it); rebuild(q); closeContext(); };
  const removeItem   = (idx: number) => { if (engine.isDaemonDriven) { const qid = qidAt(idx); if (qid) engine.queueRemove(qid); closeContext(); return; } const q = engine.getQueue(); q.splice(idx, 1); rebuild(q); closeContext(); };

  const handleCartDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; };
  const handleCartDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const cartData = e.dataTransfer.getData("application/cart");
    if (cartData) {
      try {
        const cart = JSON.parse(cartData);
        const item = { filePath: cart.filePath, title: cart.title, artist: cart.artist || "" };
        if (engine.isDaemonDriven) engine.queueEnqueue([item]); else engine.addToQueue([item]);  // Stage 2a
        onQueueChange();
      } catch {}
    }
  };

  return (
    <div
      style={{ background: "var(--bg-primary)", border: "none", display: "flex", flexDirection: "column" as any, height: "100%", overflow: "hidden" }}
      onClick={closeContext}
    >
      {/* NEXT UP header removed — show name now lives in the top bar; Clear All moved to the bottom bar */}

      {/* Flash keyframe — pulses the deck color over a row during the last 10s so a DJ
          knows to start talking. Color-agnostic (the overlay's bg is set per-deck inline). */}
      <style>{`@keyframes deck-row-flash { 0%,100% { opacity: 0.06; } 50% { opacity: 0.5; } }`}</style>

      {/* ── Stacked A / B / C deck rows — color-coded, animated, flash in last 10s ── */}
      <div style={{ flexShrink: 0, borderBottom: "2px solid rgba(255,255,255,0.07)" }}>
        {(() => {
        // Role of each deck for the color-coding: playing → duration progress (below);
        // next → pulse; third → solid. "next" = the cued deck after the playing one (cyclic A→B→C).
        const _order = ["A", "B", "C"] as const;
        const _playingId = _order.find(d => deckStates[d].status === "playing") || null;
        let _nextId: "A" | "B" | "C" | null = null;
        if (_playingId) {
          const _si = _order.indexOf(_playingId);
          for (let _i = 1; _i <= 2; _i++) { const _c = _order[(_si + _i) % 3]; if (deckStates[_c].title) { _nextId = _c; break; } }
        }
        return _order.map(id => {
          const s = deckStates[id];
          const color = DECK_COLORS[id];
          const isPlaying = s.status === "playing";
          const role: "playing" | "next" | "third" = isPlaying ? "playing" : id === _nextId ? "next" : "third";
          const dur = s.durationSec || 0;
          const pos = s.positionSec || 0;
          const remaining = Math.max(0, dur - pos);
          const isEndingSoon = isPlaying && dur > 0 && remaining <= 10;
          const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
          const hasTrack = !!s.title;
          const timeStr = isPlaying ? `-${fmtSec(remaining)}` : (dur > 0 ? fmtSec(dur) : "");
          const artKey = `${s.title}::${s.artist}`;
          return (
            <div key={id} style={{
              position: "relative", overflow: "hidden", display: "flex", alignItems: "stretch",
              height: 94, flexShrink: 0,
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              background: "transparent",
            }}>
              {/* full-row color wash — playing = dim base (progress fills it), next = pulsing, third = solid */}
              {hasTrack && (
                <div
                  className={role === "next" ? "deck-bar-pulse" : ""}
                  style={{
                    position: "absolute", inset: 0, background: color, zIndex: 0, pointerEvents: "none",
                    opacity: role === "playing" ? 0.3 : role === "next" ? undefined : 0.9,
                  }}
                />
              )}
              {/* progress fill (playing deck) — duration-synced animation over the dim base */}
              {isPlaying && (
                <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: `${pct}%`, background: color, opacity: 0.92, zIndex: 0, pointerEvents: "none", transition: "width 1s linear" }} />
              )}
              {/* last-10s flash overlay */}
              {isEndingSoon && (
                <div style={{ position: "absolute", inset: 0, background: color, zIndex: 0, pointerEvents: "none", animation: "deck-row-flash 0.85s ease-in-out infinite" }} />
              )}
              {/* (deck color strip removed) */}
              {/* content */}
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 13, padding: "0 14px", minWidth: 0, zIndex: 1 }}>
                <div style={{ width: 74, height: 74, flexShrink: 0, background: "var(--bg-tertiary)", border: `1px solid ${color}55`, overflow: "hidden" }}>
                  {artUrls[artKey] && <img src={artUrls[artKey]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span style={{ fontSize: 19, fontWeight: 800, letterSpacing: "-0.01em", color: hasTrack ? "var(--text-primary)" : "var(--text-tertiary)", fontStyle: hasTrack ? "normal" : "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.title || "—"}
                    </span>
                  </div>
                  {s.artist && (
                    <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 3 }}>{s.artist}</div>
                  )}
                </div>
                {hasTrack && (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.02em" }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: isEndingSoon ? "#fbbf24" : (isPlaying ? "#fff" : "var(--text-tertiary)") }}>{fmtSec(pos)}</span>
                    <span style={{ fontSize: 15, fontWeight: 800, color: isPlaying ? "#fff" : "var(--text-secondary)" }}>{dur > 0 ? fmtSec(dur) : "--:--"}</span>
                  </div>
                )}
              </div>
            </div>
          );
        });
        })()}
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
                borderTop: isDropTarget ? "2px solid var(--accent-blue)" : "none",
                background: isBeingDragged ? "rgb(from var(--accent-blue) r g b / 0.06)" : "transparent",
                opacity: isBeingDragged ? 0.4 : 1,
                cursor: isBeingDragged ? "grabbing" : "grab",
                userSelect: "none" as any,
                transition: "background 0.1s",
                animation: undefined,
              } as React.CSSProperties}
            >
              {/* (category color strip removed — clean, no unexplained colors) */}

              {/* Main content */}
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 15, padding: "18px 16px 18px 14px", minWidth: 0 }}>
                {/* Album art thumbnail — emphasized */}
                <div style={{ width: 74, height: 74, flexShrink: 0, background: "var(--bg-tertiary)", border: "1px solid rgba(255,255,255,0.08)", overflow: "hidden" }}>
                  {artUrls[artKey] && (
                    <img src={artUrls[artKey]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  )}
                </div>

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
                      fontSize: i === 0 ? 19 : 17, fontWeight: 800, color: "var(--text-primary)",
                      overflow: i === 0 && topScrollPx > 0 ? "visible" : "hidden",
                      textOverflow: i === 0 && topScrollPx > 0 ? undefined : "ellipsis",
                      whiteSpace: "nowrap" as any, letterSpacing: "-0.01em",
                      ...(i === 0 && topScrollPx > 0 ? { animation: "nextup-title-scroll 9s ease-in-out infinite", "--scroll-x": `-${topScrollPx}px` } : {}),
                    } as React.CSSProperties}
                  >{item.title}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, marginTop: 3 }}>{item.artist}</div>
                </div>

                {/* Right side: duration only — elapsed lives on the playing deck rows, not queued */}
                <div style={{ display: "flex", alignItems: "center", flexShrink: 0, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.02em" }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)" }}>{ms > 0 ? fmtDur(ms) : "--:--"}</span>
                </div>

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
