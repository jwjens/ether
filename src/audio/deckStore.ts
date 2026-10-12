// src/audio/deckStore.ts — DECK STATE LIVES OUTSIDE APP (2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md, docs/ui-freeze-diagnosis.md §2A. App held deckA/B/C in useState and
// replaced them on EVERY deck event (≥ 1/s per playing deck — the position ticks), so the whole app, about 156 hooks
// and every docked panel, re-rendered once a second. Now one store per engine holds them; a component subscribes only
// to what it shows:
//   useDecks(engine)                 — the full deck states + queue length (the board, which shows the countdowns)
//   useDeckSelect(engine, sel)       — one derived value; re-renders only when THAT value changes (App: which deck is on
//                                      air and its title — a track change, never a position tick)
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { AudioEngine, DeckState } from "./engine-rodio";

export type DeckSnap = { A: DeckState | null; B: DeckState | null; C: DeckState | null; queueLen: number };

type Store = { snap: DeckSnap; listeners: Set<() => void>; unsub: (() => void) | null };
const stores = new WeakMap<AudioEngine, Store>();

function read(engine: AudioEngine): DeckSnap {
  return {
    A: engine.getDeck("A")?.getState?.() ?? null,
    B: engine.getDeck("B")?.getState?.() ?? null,
    C: engine.getDeck("C")?.getState?.() ?? null,
    queueLen: engine.getQueue().length,
  };
}

function storeFor(engine: AudioEngine): Store {
  let s = stores.get(engine);
  if (!s) { s = { snap: read(engine), listeners: new Set(), unsub: null }; stores.set(engine, s); }
  return s;
}

function subscribe(engine: AudioEngine, l: () => void): () => void {
  const s = storeFor(engine);
  s.listeners.add(l);
  if (!s.unsub) {
    s.snap = read(engine);
    s.unsub = engine.on((id, st) => {
      const prev = s!.snap;
      const next: DeckSnap = { ...prev, queueLen: engine.getQueue().length };
      if (id === "A" || id === "B" || id === "C") next[id] = { ...st };
      s!.snap = next;
      s!.listeners.forEach(fn => { try { fn(); } catch { /* one listener never stops the rest */ } });
    });
  }
  return () => {
    s!.listeners.delete(l);
    if (s!.listeners.size === 0 && s!.unsub) { s!.unsub(); s!.unsub = null; }
  };
}

/** The full deck states and queue length. Re-renders on every deck event (the countdown needs it). */
export function useDecks(engine: AudioEngine): DeckSnap {
  const sub = useCallback((l: () => void) => subscribe(engine, l), [engine]);
  const get = useCallback(() => storeFor(engine).snap, [engine]);
  return useSyncExternalStore(sub, get, get);
}

/** One derived value. Re-renders only when `sel`'s result changes (by `eq`, default Object.is). */
export function useDeckSelect<T>(engine: AudioEngine, sel: (s: DeckSnap) => T, eq: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ snap: DeckSnap; value: T } | null>(null);
  const sub = useCallback((l: () => void) => subscribe(engine, l), [engine]);
  const get = useCallback(() => {
    const snap = storeFor(engine).snap;
    if (last.current && last.current.snap === snap) return last.current.value;
    const value = sel(snap);
    if (last.current && eq(last.current.value, value)) { last.current = { snap, value: last.current.value }; return last.current.value; }
    last.current = { snap, value };
    return value;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);
  return useSyncExternalStore(sub, get, get);
}

/** What App shows about the decks: which one is on air, its title/artist, and the queue length. No positions. */
export type OnAir = { id: "A" | "B" | "C" | null; title: string; artist: string; titles: [string | null, string | null, string | null]; queueLen: number };
export function selectOnAir(s: DeckSnap): OnAir {
  const id = s.A?.status === "playing" ? "A" : s.B?.status === "playing" ? "B" : s.C?.status === "playing" ? "C" : null;
  const d = id ? s[id] : null;
  const t = (x: DeckState | null) => (x?.status === "playing" ? (x.title || "") : null);
  return { id, title: d?.title || "", artist: d?.artist || "", titles: [t(s.A), t(s.B), t(s.C)], queueLen: s.queueLen };
}
export const sameOnAir = (a: OnAir, b: OnAir) =>
  a.id === b.id && a.title === b.title && a.artist === b.artist && a.queueLen === b.queueLen &&
  a.titles[0] === b.titles[0] && a.titles[1] === b.titles[1] && a.titles[2] === b.titles[2];
