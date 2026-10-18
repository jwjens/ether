// THE LIBRARY'S DECK AND QUEUE ACTIONS — one path for every Library surface (Jeff, 2026-10-18).
//
// The main window's Library, the Library window (☰ → Library) and the Library module on a built surface all call
// libraryDeckActions(): the same load, the same refusal, the same queue command. Before this there were two paths:
//   · the dashboard's loadDeck (App.tsx) resolved the file local-first → R2 and refused a PLAYING deck silently;
//   · the Library window cued with the raw file_path through the daemon only, never checked the deck, and its Q called
//     `eng.enqueue?.()` — a method AudioEngine does not have, so Queue reached nothing.
// Moved here from App.tsx's loadDeck / addToQueue (a pure move) and made the one rule:
//
//   NEVER LOAD OVER A DECK THAT IS ON AIR. "On air" = the deck is playing or paused, as the engine reports it
//   (deckOnAir). The refusal says so plainly, in the same words on every surface (onAirRefusal), and nothing is sent
//   to the engine.
//
//   QUEUE = THE REAL ENQUEUE. Daemon-driven: engine.queueEnqueue → audio:daemon "queue:enqueue" → ether-audiod
//   intentEnqueue (the explicit-intent command). In-process: engine.addToQueue, the engine's own queue.
import type { Dispatch, SetStateAction } from "react";
import type { AudioEngine, DeckId } from "../audio/engine-rodio";
import { autoCueSong } from "../audio/songAnalysis";

/** The fields of a library row these actions read (a subset of App.tsx's SongRow). */
export interface LibrarySong {
  id?: number;
  file_path: string | null;
  title: string;
  artist_name?: string | null;
  duration_ms?: number | null;
  intro_end?: number | null;
  outro_start?: number | null;
}

/** What the operator is told about the last load: progress (err false) or the reason it did not happen (err true). */
export type DeckLoadNotice = { text: string; err: boolean } | null;

/** On air = playing or paused, as the engine reports the deck. */
export function deckOnAir(engine: AudioEngine, deck: DeckId): boolean {
  const st = engine.getDeck(deck)?.getState?.();
  return st?.status === "playing" || st?.status === "paused";
}

/** The refusal, word for word the same on every surface. */
export function onAirRefusal(title: string, deck: DeckId): string {
  return `Deck ${deck} is on air — "${title}" was not loaded. Stop deck ${deck} first.`;
}

/** The dashboard's auto-trim-on-queue preference (App.tsx keeps the same key). */
export function autoSilenceTrimOn(): boolean {
  try { return localStorage.getItem("ether_auto_silence_trim") !== "false"; } catch { return true; }
}

export interface LibraryDeckActionsOpts {
  /** The engine to command, resolved FRESH at every call (command-path station scoping). */
  engine: () => AudioEngine;
  /** Where the operator reads the notice (the dashboard's toast, or the window's own). */
  setNotice: Dispatch<SetStateAction<DeckLoadNotice>>;
  /** Auto-detect cue points for a queued song with none (the dashboard's "auto silence trim"). */
  autoCueOnQueue: () => boolean;
  /** After a song is queued (the dashboard refreshes its queue count). */
  onQueued?: (engine: AudioEngine) => void;
}

/** A refusal or failure stays on screen for 6 s, then clears itself unless something newer replaced it. */
function failWith(setNotice: Dispatch<SetStateAction<DeckLoadNotice>>, text: string) {
  setNotice({ text, err: true });
  setTimeout(() => setNotice(m => (m && m.text === text ? null : m)), 6000);
}

/** Load one song onto one deck, by the one rule. Resolves true when a load was sent. */
export async function loadSongToDeck(o: LibraryDeckActionsOpts, deckId: DeckId, s: LibrarySong): Promise<boolean> {
  if (!s.file_path) { failWith(o.setNotice, `Can't load "${s.title}" — no file on record`); return false; }
  // Command-path station scoping: resolve the engine fresh at call time (getEngine froze to station 1 under a
  // useCallback that closed over render-0 engine — see VU cross-talk).
  let engine = o.engine();
  if (deckOnAir(engine, deckId)) { failWith(o.setNotice, onAirRefusal(s.title, deckId)); return false; }
  // Slice B — loud refusal: resolve the SAME way the cue editor does (local-first → R2-by-file_key),
  // so an R2-only library song loads onto the deck instead of dying silently; on failure, SAY WHY.
  // The resolve is off the deck-load hot path (it's a manual button), so it may fetch from the cloud.
  let filePath = s.file_path;
  o.setNotice({ text: `Loading "${s.title}" onto ${deckId}…`, err: false });
  try {
    const r = await (window as any).ether.invoke("audio:resolve-local-path", s.file_path);
    if (!r?.ok || !r.filePath) {
      failWith(o.setNotice, `Can't load "${s.title}" — ${r?.error === 'no local file, no file_key' ? 'unavailable, needs re-import' : (r?.error || 'file not on this machine')}`);
      return false;
    }
    filePath = r.filePath;
  } catch { /* resolver unreachable — proceed with the raw path; the engine surfaces its own error */ }
  // The resolve can take a cloud round trip: the deck may have gone on air meanwhile. Same rule, asked again.
  engine = o.engine();
  if (deckOnAir(engine, deckId)) { failWith(o.setNotice, onAirRefusal(s.title, deckId)); return false; }
  if (engine.isDaemonDriven) {
    engine.deckCue(deckId, { filePath, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 });
  } else {
    engine.loadToDeck(deckId, filePath, s.title, s.artist_name || "", 0, s.duration_ms ?? 0);
  }
  o.setNotice(null);   // success — clear the Loading… note
  window.dispatchEvent(new CustomEvent('ether:queue-changed'));
  if (s.id && !s.intro_end) autoCueSong(s.id, s.file_path).catch(() => {});
  return true;
}

/** Append one song to the bottom of the queue through the real enqueue. Returns true when a command was sent. */
export function enqueueSong(o: LibraryDeckActionsOpts, s: LibrarySong): boolean {
  if (!s.file_path) return false;
  const engine = o.engine();
  const item = { filePath: s.file_path, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined, durationMs: s.duration_ms ?? 0 };
  if (engine.isDaemonDriven) void engine.queueEnqueue([item]); else engine.addToQueue([item as any]);
  o.onQueued?.(engine);
  window.dispatchEvent(new CustomEvent('ether:queue-changed'));
  // Auto-detect cue points in background if not set
  if (o.autoCueOnQueue() && s.id && !s.intro_end) autoCueSong(s.id, s.file_path).catch(() => {});
  return true;
}

/** The props every Library surface hands LibraryPanel (onEdit is the dashboard's own: it opens its cue editor). */
export function libraryDeckActions(o: LibraryDeckActionsOpts) {
  return {
    onLoadA: (s: any) => { void loadSongToDeck(o, "A", s); },
    onLoadB: (s: any) => { void loadSongToDeck(o, "B", s); },
    onLoadC: (s: any) => { void loadSongToDeck(o, "C", s); },
    onQueue: (s: any) => { enqueueSong(o, s); },
    onSendToStudio: (s: any) => { try { (window as any).ether?.invoke("studio:push-track", { filePath: s.file_path, title: s.title, artist: s.artist_name || "", duration_ms: s.duration_ms }); } catch { /* not in electron */ } },
  };
}

/** The notice, as the operator sees it — the dashboard's toast, used by every surface. */
export function DeckLoadNoticeBar({ notice }: { notice: DeckLoadNotice }) {
  if (!notice) return null;
  return (
    <div role="status" style={{ position: "fixed", bottom: 72, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: "rgba(30,30,40,0.97)", border: `1px solid ${notice.err ? "rgba(224,64,64,0.5)" : "rgb(from var(--accent-blue) r g b / 0.4)"}`, color: notice.err ? "#ff6b6b" : "var(--accent-blue)", padding: "9px 20px", fontSize: 13, fontWeight: 600, fontFamily: "'Inter', system-ui, sans-serif", pointerEvents: "none" }}>
      {notice.text}
    </div>
  );
}
