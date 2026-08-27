import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { query } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { getActiveShowClock } from "../audio/loggen";
import { resolveArtwork } from "../lib/albumArt";

// ── Types ─────────────────────────────────────────────────────

interface CategoryInfo { id: number; code: string; name: string; color: string; }

function fmtDur(ms: number): string {
  if (!ms || ms <= 0) return "";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 'HH:MM:SS' → '8:45 PM', or '8:45:30 PM' when the seconds matter. An announcement's time is an
 *  exact instant, so it is shown as one. */
function fmtTime12(t: string): string {
  const [h, m, sec] = String(t || "").split(":");
  const hr = parseInt(h);
  if (!Number.isFinite(hr)) return "";
  const ss = Number(sec || 0);
  return (hr === 0 ? 12 : hr > 12 ? hr - 12 : hr) + ":" + m +
         (ss ? ":" + String(ss).padStart(2, "0") : "") + " " + (hr >= 12 ? "PM" : "AM");
}

function fmtSec(sec: number): string {
  if (!sec || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// A / B / C deck accent colors — must match the fader strips + ThreeSlotBar.
const DECK_COLORS: Record<"A" | "B" | "C", string> = { A: "var(--deck-a)", B: "var(--deck-b)", C: "var(--deck-c)" };

interface DeckRowState { title: string; artist: string; status: string; positionSec: number; durationSec: number; filePath: string; contentClass: string | null; }

// The iTunes lookup that used to live here has MOVED to src/lib/albumArt.ts as
// `fetchMusicStoreArt`, reachable only through `resolveArtwork()`. It is not exported from this
// module any more, so no component can call a music store directly for something that might be a
// spot. Artwork resolution is routed by content class in one place — see albumArt.ts.

// ── UpNext (main component) ────────────────────────────────────

interface Props {
  queueLen: number;
  onQueueChange: () => void;
  // JINGLES indicator: the scheduled/armed/firing jingle for a deck's upcoming seam. Rendered as a third
  // line under that deck's duration — grey = SCHEDULED (read-ahead from song start), solid white = ARMED,
  // blinking yellow = FIRING. Class-aware (JIN/SWP).
  jingleOverlay?: { deck: string | null; state: string; title: string | null; contentClass: string | null; jinDurSec: number | null } | null;
}

// Class-color audit (jingles v1 D3): JIN teal + SPOT amber use the canonical tokens; others unchanged.
const CATEGORY_COLORS: Record<string, string> = {
  A: "#ef4444", B: "#f59e0b", C: "#22c55e", D: "#3b82f6",
  spot: "#fbbf24", liner: "#ec4899", jingle: "#14e0c8", sweeper: "#4f46e5", news: "#6366f1",
};

export default function UpNext({ queueLen, onQueueChange, jingleOverlay = null }: Props) {
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

  // ── UPCOMING ANNOUNCEMENTS (2026-08-26) ───────────────────────────────────────────────────────
  // docs/announcements-in-the-log-investigation-2026-08-26.md — Option C, part 2.
  //
  // DISPLAY-ONLY MERGE. These rows are read from announcement_schedule and interleaved into the list
  // for viewing. They are NOT put into the queue and NOT into generated_schedule — that is Option B,
  // which the log reader and the auto-fitter read, and it is explicitly deferred to the flip's
  // Phase 3 as a separate, deliberately-verified change. Nothing here can move a song, a spot or a
  // jingle: it is a second array rendered alongside the first.
  //
  // An announcement still fires exactly as it did — its own 250ms tick in main, onto the Announcement
  // source channel, through the ducker. This only shows the operator where it will land.
  const [annRows, setAnnRows] = useState<{ uuid: string; title: string; at: number; time: string }[]>([]);
  useEffect(() => {
    if (!isReady || stationId == null) return;
    let stop = false;
    const load = async () => {
      try {
        const now = new Date();
        // Local date parts, never toISOString() — that is UTC and would ask for the wrong day's
        // announcements every evening west of Greenwich.
        const today = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
        const r = await (window as any).ether?.announcements?.listSchedule?.(stationId, { scope: "date", date: today });
        if (!r?.ok || stop) return;
        // Titles live on the ASSET, not the entry. One small read rather than widening the handler.
        const assets = await queryScoped<{ uuid: string; title: string }>(
          "SELECT uuid, title FROM announcements WHERE is_active = 1 AND deleted_at IS NULL", [], stationId);
        const byUuid = new Map(assets.map(a => [a.uuid, a.title]));
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const rows = (r.rows || [])
          // An entry whose asset is inactive or gone will not fire, so it must not be shown as if it
          // would — the queue is a claim about what is about to happen.
          .filter((e: any) => e.trigger_time && byUuid.has(e.announcement_uuid))
          .map((e: any) => {
            const [h, m, sec] = String(e.trigger_time).split(":").map(Number);
            return {
              uuid: e.uuid as string,
              title: byUuid.get(e.announcement_uuid) || "Announcement",
              at: midnight + ((h || 0) * 3600 + (m || 0) * 60 + (sec || 0)) * 1000,
              time: String(e.trigger_time),
            };
          })
          // Only what is still ahead. One that has already fired is history, and history now lives in
          // the play log — announcements finally write a play_log row when they air.
          .filter((x: { at: number }) => x.at >= Date.now() - 30_000)
          .sort((a: { at: number }, b: { at: number }) => a.at - b.at);
        if (!stop) setAnnRows(rows);
      } catch { /* the queue renders without them — nothing is invented */ }
    };
    load();
    const id = setInterval(load, 20000);
    return () => { stop = true; clearInterval(id); };
  }, [stationId, isReady]);

  const [queue, setQueue] = useState(() => engine.getQueue());
  // Slice C: live queue lint — scheduledAt → seconds-too-early for any upcoming row whose song/artist
  // is still RESTING at its projected air time (from library-health, rules-derived). Yellow chip.
  const [lintMap, setLintMap] = useState<Record<number, number>>({});

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

  // ── Slice C: live queue lint — fetch upcoming separation violations (rules-derived, main-process) ──
  useEffect(() => {
    if (!isReady) return;
    let stop = false;
    const fetchLint = async () => {
      try {
        const rows = await (window as any).ether?.invoke?.("library-health:queue-lint", stationId);
        if (stop || !Array.isArray(rows)) return;
        const m: Record<number, number> = {};
        for (const r of rows) if (r?.scheduledAt != null) m[r.scheduledAt] = r.violatesBySec;
        setLintMap(m);
      } catch { /* IPC absent */ }
    };
    fetchLint();
    const id = setInterval(fetchLint, 60000);   // gentle — the lint window moves slowly; 60s is plenty
    return () => { stop = true; clearInterval(id); };
  }, [stationId, isReady]);

  // ── Log-Reader Flip Phase 2: read-path SHADOW-COMPARE (always-on, observational) ──
  // Fetch the log-derived up-next (generated_schedule ≥ playhead — the SAME source the calendar reads)
  // and diff it against the live engine queue by title, positionally. Divergences are appended to the
  // health ledger (userData/playhead-divergence.jsonl) — the read-path burn-in that gates the Phase 3
  // flip. This changes NO render and NO playout; it only measures whether the log view and the queue
  // agree yet. (The flag-gated render switch — UpNext/▶ actually rendering the log — lands with Phase 3,
  // when the playhead is time-anchored and the log view is the row-for-now; §2.7.)
  useEffect(() => {
    if (!isReady) return;
    let alive = true;
    const ether = (window as any).ether;
    if (!ether?.invoke) return;
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const compare = async () => {
      try {
        const r = await ether.invoke("schedule:playhead-view", stationId, 12);
        if (!alive || !r?.ok) return;
        const logTitles = (r.upNext || []).map((row: any) => norm(row.title));
        const q = engine.getQueue().slice(2, 2 + logTitles.length).map((it: any) => norm(it?.title));
        let mismatch = 0;
        const n = Math.max(q.length, logTitles.length);
        for (let i = 0; i < n; i++) if ((q[i] || "") !== (logTitles[i] || "")) mismatch++;
        if (mismatch > 0) {
          ether.emit?.("health:playhead-divergence", {
            stationId, kind: "upnext-read-mismatch", mismatch, compared: n,
            playingLog: r.playing?.title ?? null,
            queueHead: engine.getQueue().slice(2, 5).map((it: any) => it?.title || ""),
            logHead: (r.upNext || []).slice(0, 3).map((row: any) => row.title || ""),
          });
        }
      } catch { /* shadow-compare never affects the UI */ }
    };
    compare();
    // 30s cadence only — NOT on every ether:queue-changed. On a live box the daemon fires queue events
    // frequently (and, pre-flip, the divergence is ~constant), so the old 5s + per-queue-event trigger
    // ran an async IPC round-trip many times/sec against a renderer already handling ~90 levels
    // events/sec — back-pressured invoke promises that could accumulate. A burn-in read only needs a
    // periodic sample.
    const id = setInterval(compare, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [stationId, isReady, engine]);

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
    A: { title: "", artist: "", status: "idle", positionSec: 0, durationSec: 0, filePath: "", contentClass: null },
    B: { title: "", artist: "", status: "idle", positionSec: 0, durationSec: 0, filePath: "", contentClass: null },
    C: { title: "", artist: "", status: "idle", positionSec: 0, durationSec: 0, filePath: "", contentClass: null },
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
          contentClass: (s as any)?.contentClass ?? null,
        };
      });
      return next;
    });
    pull();
    const unsub = engine.on(pull);
    const tick = setInterval(pull, 1000);
    return () => { unsub(); clearInterval(tick); };
  }, [engine]);

  // Artwork for whatever is on the decks. resolveArtwork routes by content class: a spot takes the
  // spot chain (override → embedded → nothing) which contains no music-store lookup at all.
  useEffect(() => {
    (["A", "B", "C"] as const).forEach(id => {
      const s = deckStates[id];
      if (!s.title) return;
      const key = `${s.title}::${s.artist}`;
      if (artUrls[key] !== undefined) return;
      (async () => {
        const url = await resolveArtwork(s.filePath, s.contentClass, s.title, s.artist, stationId);
        if (url) setArtUrls(prev => ({ ...prev, [key]: url }));
      })();
    });
  }, [deckStates.A.title, deckStates.B.title, deckStates.C.title, stationId]);

  useEffect(() => {
    queue.forEach(item => {
      const key = `${item.title}::${item.artist}`;
      if (artUrls[key] !== undefined) return;
      (async () => {
        const cc = (item as any).contentClass ?? (item as any).content_class ?? null;
        const url = await resolveArtwork((item as any).filePath, cc, item.title || "", item.artist || "", stationId);
        if (url) setArtUrls(prev => ({ ...prev, [key]: url }));
      })();
    });
  }, [queueLen, stationId]);

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

  // INTERLEAVE BY PROJECTED TIME. The queue plays back to back, so a row's air time is now plus the
  // durations ahead of it — that projection is exactly how a queue is read. An announcement's time is
  // NOT a projection: it is the clock time it will fire at. That is why the two kinds of row are
  // shown differently — a song carries a duration, an announcement carries its time.
  const mergedUpcoming: any[] = (() => {
    const out: any[] = [];
    const upcoming = queue.slice(2, 52);
    let clock = Date.now();
    let ai = 0;
    for (let qi = 0; qi < upcoming.length; qi++) {
      while (ai < annRows.length && annRows[ai].at <= clock) out.push({ __ann: annRows[ai++] });
      out.push(upcoming[qi]);
      clock += (upcoming[qi] as any)?.durationMs || 0;
    }
    while (ai < annRows.length) out.push({ __ann: annRows[ai++] });
    return out;
  })();

  return (
    <div
      style={{ background: "var(--bg-primary)", border: "none", display: "flex", flexDirection: "column" as any, height: "100%", overflow: "hidden" }}
      onClick={closeContext}
    >
      {/* NEXT UP header removed — show name now lives in the top bar; Clear All moved to the bottom bar */}

      {/* Flash keyframe — pulses the deck color over a row during the last 10s so a DJ
          knows to start talking. Color-agnostic (the overlay's bg is set per-deck inline). */}
      <style>{`@keyframes deck-row-flash { 0%,100% { opacity: 0.06; } 50% { opacity: 0.5; } }
        @keyframes jingle-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        @keyframes spot-deck-flash { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        .spot-deck-flash { animation: spot-deck-flash 1s ease-in-out infinite; }`}</style>

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
          // SPOT-deck flash: a deck holding a SPOT (commercial/promo) gets an amber pulsing frame from load
          // until it finishes airing — exclusive to spots (songs never flash), distinct from the jingle
          // third-row indicator. Dies when the spot ends (status 'ended') and music takes over.
          const isSpotDeck = s.contentClass === "SPOT" && hasTrack && s.status !== "ended";
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
              {/* SPOT deck flash — amber pulsing frame + faint wash, SPOT-exclusive (songs never flash) */}
              {isSpotDeck && (
                <div className="spot-deck-flash" style={{ position: "absolute", inset: 0, zIndex: 4, pointerEvents: "none", boxShadow: "inset 0 0 0 3px #fbbf24", background: "rgba(251,191,36,0.12)" }} />
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
              {/* JINGLES third line — the jingle's NAME + time under THIS deck's duration. Grey = SCHEDULED
                  (read-ahead from song start), solid white = ARMED, blinking yellow = FIRING. Class-aware
                  (JIN/SWP). The countdown colors above are untouched — nothing shared with the countdown. */}
              {jingleOverlay && jingleOverlay.deck === id && jingleOverlay.state && (() => {
                const firing = jingleOverlay.state === "FIRING";
                const scheduled = jingleOverlay.state === "SCHEDULED";
                // SCHEDULED (read-ahead, from song start) = grey · ARMED (seam imminent) = white · FIRING = yellow.
                const col = firing ? "#ffe93b" : scheduled ? "#8b909b" : "#ffffff";
                const tag = "SWP";   // v52: one imaging class
                const jdur = jingleOverlay.jinDurSec || 0;
                return (
                  <div className={firing ? "jingle-blink" : ""} style={{
                    position: "absolute", left: 101, right: 14, bottom: 6, zIndex: 2,
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                    fontFamily: "'DM Mono', monospace", pointerEvents: "none",
                  }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, color: col }}>
                      <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.08em", padding: "1px 4px", borderRadius: 2, border: `1px solid ${col}`, flexShrink: 0 }}>{tag}</span>
                      <span style={{ fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{jingleOverlay.title || "jingle"}</span>
                    </span>
                    {jdur > 0 && <span style={{ fontSize: 12, fontWeight: 800, color: col, flexShrink: 0 }}>{fmtSec(jdur)}</span>}
                  </div>
                );
              })()}
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
            {mergedUpcoming.map((item: any, i: number) => {
              // An ANNOUNCEMENT row. Styled by class the way SPOT rows already are, and carrying its
              // exact fire time instead of a duration.
              if (item.__ann) {
                const a = item.__ann;
                return (
                  <div key={"ann-" + a.uuid} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "11px 16px 11px 13px",
                    borderLeft: "3px solid var(--accent-cyan)",
                    background: "rgb(from var(--accent-cyan) r g b / 0.07)",
                  }}>
                    <span style={{
                      padding: "1px 5px", fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace",
                      color: "var(--accent-cyan)", background: "rgb(from var(--accent-cyan) r g b / 0.14)",
                      border: "1px solid rgb(from var(--accent-cyan) r g b / 0.45)", letterSpacing: "0.06em",
                      flexShrink: 0,
                    }}>ANN</span>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: "var(--text-primary)",
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{a.title}</div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--accent-cyan)", flexShrink: 0 }}>
                      {fmtTime12(a.time)}
                    </div>
                  </div>
                );
              }

          const engineIdx = i + 2;
          const color = getItemColor(item);
          const catLabel = getCatLabel(item);
          // A spot (commercial/promo) in the live queue → gold/amber, matching the calendar. Detected the
          // same way the daemon/generator tags them: itemType 'spot', content_class 'SPOT', or a spot id.
          const isSpot = (item as any).itemType === "spot"
            || (item as any).contentClass === "SPOT" || (item as any).content_class === "SPOT"
            || (item as any).spot_id != null || (item as any).spotId != null;
          const ms = (item as any).durationMs || (item as any).duration_ms || 0;
          const lintEarly = (item as any).scheduledAt != null ? lintMap[(item as any).scheduledAt] : undefined;
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
                borderLeft: isSpot ? "3px solid #fbbf24" : "3px solid transparent",
                background: isBeingDragged ? "rgb(from var(--accent-blue) r g b / 0.06)" : isSpot ? "rgba(251,191,36,0.06)" : "transparent",
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
                  >{isSpot && <span style={{ marginRight: 7, padding: "1px 5px", fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: "#fbbf24", background: "rgba(251,191,36,0.14)", border: "1px solid rgba(251,191,36,0.45)", letterSpacing: "0.06em", verticalAlign: "middle" as any }}>SPOT</span>}{item.title}</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, marginTop: 3 }}>{item.artist}</div>
                  {lintEarly != null && lintEarly > 0 && (
                    <div title="This placement airs before the song/artist separation rule allows" style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 9, fontWeight: 800, letterSpacing: "0.04em", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.4)", padding: "1px 5px", borderRadius: 2, textTransform: "uppercase" as const }}>
                      ⚠ separation · {Math.round(lintEarly / 60)}m early
                    </div>
                  )}
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
