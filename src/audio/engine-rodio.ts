// Tee [ROT] diagnostic logs to tmp-userdata/rotation.log via the main-process IPC channel.
// console.log fires first (DevTools), then fire-and-forget to file. Safe to call before
// window.ether is ready — the optional chain silently drops the message.
export function rotLog(msg: string): void {
  console.log(msg);
  try { (window as any).ether?.fs?.logRotation?.(msg); } catch {}
}

// Electron IPC — all audio commands go through window.ether.audio.*
async function invoke(cmd: string, args?: any): Promise<any> {
  const e = (window as any).ether;
  if (!e) { console.error("[ENGINE] window.ether not available — preload not loaded?"); return null; }
  switch (cmd) {
    case "audio_load":        return e.audio.load(args.deck, args.filePath, args.title, args.artist, args.gainDb, args?.stationId);
    case "audio_play":        return e.audio.play(args.deck, args?.stationId);
    case "audio_pause":       return e.audio.pause(args.deck, args?.stationId);
    case "audio_stop":        return e.audio.stop(args.deck, args?.stationId);
    case "audio_set_volume":  return e.audio.setVolume(args.deck, args.volume, args?.stationId);
    case "audio_get_state":   return e.audio.getState(args?.stationId);
    case "get_file_duration": return e.audio.getFileDuration(args.filePath);
    case "get_levels":        return e.audio.getLevels(args?.stationId);
    case "watchdog_set":      return e.audio.watchdogSet(args.active, args.thresholdSec, args?.stationId);
    default:
      console.warn("[ENGINE] Unknown audio command:", cmd);
      return null;
  }
}


export type DeckId = "A" | "B" | "C";
export type DeckStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface DeckState {
  id: DeckId;
  status: DeckStatus;
  title: string;
  artist: string;
  filePath: string;
  positionSec: number;
  durationSec: number;
  volume: number;
  peaks: number[];
  error?: string;
  outroStartSec?: number;
}

type Listener = (id: DeckId, state: DeckState) => void;

function makeState(id: DeckId, s: any): DeckState {
  return {
    id,
    status: s.status || "idle",
    title: s.title || "",
    artist: s.artist || "",
    filePath: s.file_path || s.filePath || "",
    positionSec: s.position_sec || s.positionSec || 0,
    durationSec: s.duration_sec || s.durationSec || 0,
    volume: s.volume ?? 1,
    peaks: [],
    error: s.error,
  };
}

export class AudioEngine {
  private readonly stationId: number;

  constructor(stationId: number) {
    this.stationId = stationId;
  }

  private listeners = new Set<Listener>();
  private playStartCallbacks = new Set<(deckId: DeckId, title: string, artist: string, filePath: string) => void>();

  private stateA: DeckState = makeState("A", {});
  private stateB: DeckState = makeState("B", {});
  private stateC: DeckState = makeState("C", {});

  private pollTimer: any = null;
  private lastPollTime = Date.now();
  private lastFiredState: { A?: DeckState; B?: DeckState; C?: DeckState } = {};

  private queue: { filePath: string; title: string; artist: string; gainDb?: number; chainType?: "segue" | "stop"; durationMs?: number }[] = [];
  private refillCallback: (() => Promise<{ filePath: string; title: string; artist: string }[]>) | null = null;
  // Per-deck chain type: what happens when THIS deck finishes.
  // Loaded from the queue item at deck-load time.
  private deckChainType: Record<DeckId, "segue" | "stop"> = { A: "segue", B: "segue", C: "segue" };
  // Tracks which standby decks have been freshly preloaded and are ready to play.
  // Set by preloadDeck on success; cleared by handleRotate when the deck goes live.
  private deckReady = new Set<DeckId>();
  // Callback fired when a "stop" chain type prevents auto-advance.
  onChainStop: ((deckId: DeckId) => void) | null = null;

  private _autoAdvance = false;
  get autoAdvance() { return this._autoAdvance; }
  set autoAdvance(v: boolean) {
    this._autoAdvance = v;
    if (v) this.processingEnd = false;  // clear any stuck flag when AUTO-X is enabled
  }
  shuffle = false;
  continuous = false;
  outroCrossfade = false;
  crossfadeDuration = 3;
  // advancePromise serializes advance operations. Any handler chains onto this promise
  // so that concurrent same-tick callers await the in-flight advance rather than
  // spawning a second one.
  private advancePromise: Promise<void> = Promise.resolve();
  // processingEnd prevents multiple deck-end events from firing in the same poll tick.
  // It is set true when the first end is detected, then cleared at the end of poll().
  private processingEnd = false;
  private endTriggered = new Set<DeckId>();

  init() {
    if (this.pollTimer) return;
    this.processingEnd = false;  // clear any flag left over from a previous session
    this.pollTimer = setInterval(() => this.poll(), 250);
  }

  private async poll() {
    try {
      const s = await invoke("audio_get_state", { stationId: this.stationId });
      const now = Date.now();
      const elapsed = (now - this.lastPollTime) / 1000;
      this.lastPollTime = now;

      const prevA = this.stateA.status;
      const prevB = this.stateB.status;
      const prevC = this.stateC.status;

      const durA = this.stateA.durationSec;
      const durB = this.stateB.durationSec;
      const durC = this.stateC.durationSec;

      const posA = (this.stateA.status === "playing") ? Math.min(this.stateA.positionSec + elapsed, durA || 9999) : this.stateA.positionSec;
      const posB = (this.stateB.status === "playing") ? Math.min(this.stateB.positionSec + elapsed, durB || 9999) : this.stateB.positionSec;
      const posC = (this.stateC.status === "playing") ? Math.min(this.stateC.positionSec + elapsed, durC || 9999) : this.stateC.positionSec;

      this.stateA = { ...makeState("A", s.deckA), durationSec: durA, positionSec: posA };
      this.stateB = { ...makeState("B", s.deckB), durationSec: durB, positionSec: posB };
      this.stateC = { ...makeState("C", s.deckC), durationSec: durC, positionSec: posC };

      if (this.stateChanged(this.lastFiredState.A, this.stateA)) { this.listeners.forEach(l => l("A", this.stateA)); }
      this.lastFiredState.A = this.stateA;
      if (this.stateChanged(this.lastFiredState.B, this.stateB)) { this.listeners.forEach(l => l("B", this.stateB)); }
      this.lastFiredState.B = this.stateB;
      if (this.stateChanged(this.lastFiredState.C, this.stateC)) { this.listeners.forEach(l => l("C", this.stateC)); }
      this.lastFiredState.C = this.stateC;

      // Rust's finished flag is a reliable one-shot signal — use it as a fallback
      // when get_file_duration failed (durX=0) and dur>5 can't fire.
      const rustEndedA = s.deckA?.status === "ended" && prevA === "playing";
      const rustEndedB = s.deckB?.status === "ended" && prevB === "playing";
      const rustEndedC = s.deckC?.status === "ended" && prevC === "playing";

      this.checkEndByPosition("A", posA, durA, prevA, rustEndedA);
      this.checkEndByPosition("B", posB, durB, prevB, rustEndedB);
      this.checkEndByPosition("C", posC, durC, prevC, rustEndedC);
      // Reset per-tick end gate — only one deck end is processed per 250ms poll cycle.
      this.processingEnd = false;

    } catch (e) {
      console.error("[ENGINE] Poll error:", e);
    }
  }

  private stateChanged(prev: DeckState | undefined, next: DeckState): boolean {
    if (!prev) return true;
    return (
      prev.status !== next.status ||
      prev.filePath !== next.filePath ||
      prev.title !== next.title ||
      Math.floor(prev.positionSec) !== Math.floor(next.positionSec) ||
      prev.durationSec !== next.durationSec
    );
  }

  private checkEndByPosition(deckId: DeckId, pos: number, dur: number, prevStatus: DeckStatus, backendEnded = false) {
    if (this.processingEnd) return;
    const positionEnd = prevStatus === "playing" && dur > 5 && pos > 0 && (dur - pos) < 0.3;
    // Only trust Rust's "ended" signal when position also confirms we're near the end.
    // Rust occasionally glitches "ended" on preloaded/mid-play decks; guard against that.
    const genuineBackendEnd = backendEnded && (dur <= 5 || (dur - pos) < 5);
    if ((positionEnd || genuineBackendEnd) && !this.endTriggered.has(deckId)) {
      this.processingEnd = true;
      this.endTriggered.add(deckId);
      rotLog(`[ROT] END ${deckId} ("${deckId === "A" ? this.stateA.title : deckId === "B" ? this.stateB.title : this.stateC.title}") posEnd=${positionEnd} rustEnd=${backendEnded} | B.ready=${this.deckReady.has("B")} C.ready=${this.deckReady.has("C")}`);

      // Chain type check — if the CURRENT deck is "stop", halt here.
      // The DJ must manually trigger the next item.
      if (this.deckChainType[deckId] === "stop") {
        if (deckId === "A") this.stateA = { ...this.stateA, status: "ended" };
        if (deckId === "B") this.stateB = { ...this.stateB, status: "ended" };
        if (deckId === "C") this.stateC = { ...this.stateC, status: "ended" };
        console.log(`[ENGINE] chain-stop on deck ${deckId} — waiting for manual trigger`);
        this.onChainStop?.(deckId);
        return;
      }

      if (deckId === "A") {
        this.stateA = { ...this.stateA, status: "ended" };
        if (this.deckReady.has("B")) { this.handleRotate("A", "B"); }
        else if (this.autoAdvance && this.stateB.status !== "playing" && this.stateC.status !== "playing") {
          this.handleLoadNextToDeck("A");
        }
      } else if (deckId === "B") {
        this.stateB = { ...this.stateB, status: "ended" };
        if (this.deckReady.has("C")) { this.handleRotate("B", "C"); }
        else if (this.autoAdvance && this.stateA.status !== "playing" && this.stateC.status !== "playing") {
          this.handleLoadNextToDeck("B");
        }
      } else if (deckId === "C") {
        this.stateC = { ...this.stateC, status: "ended" };
        if (this.deckReady.has("A")) { this.handleRotate("C", "A"); }
        else if ((this.autoAdvance || this.queue.length > 0) && this.stateA.status !== "playing" && this.stateB.status !== "playing") {
          this.handleLoadNextToDeck("A");
        }
      }
    }
  }

  private handleRotate(fromId: DeckId, toId: DeckId) {
    this.advancePromise = this.advancePromise.then(async () => {
      try {
        const liveState = await invoke("audio_get_state", { stationId: this.stationId });
        const liveTo = liveState ? (toId === "A" ? liveState.deckA : toId === "B" ? liveState.deckB : liveState.deckC) : null;
        const otherPlaying = liveState ? (
          (fromId !== "A" && liveState.deckA?.status === "playing") ||
          (fromId !== "B" && liveState.deckB?.status === "playing") ||
          (fromId !== "C" && liveState.deckC?.status === "playing")
        ) : false;
        rotLog(`[ROT] rotate ${fromId}→${toId}: liveTo=${liveTo?.status} otherPlaying=${otherPlaying} | queue: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
        if (liveTo?.status === "playing") { rotLog(`[ROT] rotate ${fromId}→${toId}: BAIL dest already playing`); return; }
        if (otherPlaying) { rotLog(`[ROT] rotate ${fromId}→${toId}: BAIL another deck is playing (spurious end guard)`); return; }
        await invoke("audio_play", { deck: toId, stationId: this.stationId });
        setTimeout(() => { invoke("audio_stop", { deck: fromId, stationId: this.stationId }).catch(() => {}); }, (this.crossfadeDuration * 1000) + 500);
        if (toId === "A") this.stateA = { ...this.stateA, status: "playing", positionSec: 0 };
        if (toId === "B") this.stateB = { ...this.stateB, status: "playing", positionSec: 0 };
        if (toId === "C") this.stateC = { ...this.stateC, status: "playing", positionSec: 0 };
        this.deckReady.delete(toId);
        this.endTriggered.delete(toId);
        if (this.queue.length > 0) this.dequeue();
        rotLog(`[ROT] rotate ${fromId}→${toId}: played ${toId}, queue after dequeue: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
        // Far standby (stopped long ago) preloads immediately.
        // Near standby (just played, still in crossfade) waits until after the fade stop.
        const nearDelay = (this.crossfadeDuration * 1000) + 800;
        if (toId === "B") {
          setTimeout(() => this.preloadDeck("C", 0), 800);
          setTimeout(() => this.preloadDeck("A", 1), nearDelay);
        } else if (toId === "C") {
          setTimeout(() => this.preloadDeck("A", 0), 800);
          setTimeout(() => this.preloadDeck("B", 1), nearDelay);
        } else if (toId === "A") {
          setTimeout(async () => { await this.refillIfNeeded(); await this.preloadDeck("B", 0); }, 800);
          setTimeout(() => this.preloadDeck("C", 1), nearDelay);
        }
      } catch (e) { console.error("[ROT] handleRotate error:", e); }
    });
  }

  private handleLoadNextToDeck(deckId: DeckId) {
    this.advancePromise = this.advancePromise.then(async () => {
      try {
        // Check the Rust backend: if the destination deck is already playing, bail.
        const liveState = await invoke("audio_get_state", { stationId: this.stationId });
        if (liveState) {
          const liveDeck = deckId === "A" ? liveState.deckA : deckId === "B" ? liveState.deckB : liveState.deckC;
          if (liveDeck?.status === "playing") return;  // already playing — skip
        }
        await this.refillIfNeeded();
        if (this.queue.length === 0) return;
        const next = this.dequeue();
        this.deckChainType[deckId] = next.chainType || "segue";
        await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb, next.durationMs);
        await invoke("audio_play", { deck: deckId, stationId: this.stationId });
        if (deckId === "A") { this.stateA = { ...this.stateA, status: "playing", positionSec: 0 }; this.endTriggered.delete("A"); }
        if (deckId === "B") { this.stateB = { ...this.stateB, status: "playing", positionSec: 0 }; this.endTriggered.delete("B"); }
        if (deckId === "C") { this.stateC = { ...this.stateC, status: "playing", positionSec: 0 }; this.endTriggered.delete("C"); }
      } catch (e) { console.error("[ENGINE] handleLoadNextToDeck error:", e); }
    });
  }

  private async preloadDeck(deckId: DeckId, queueIndex = 0) {
    if (this.queue.length <= queueIndex) {
      rotLog(`[ROT] preload ${deckId}[${queueIndex}] SKIP — queue too short (len=${this.queue.length})`);
      return;
    }
    const deckState = deckId === "A" ? this.stateA : deckId === "B" ? this.stateB : this.stateC;
    if (deckState?.status === "playing" || deckState?.status === "paused") {
      rotLog(`[ROT] preload ${deckId}[${queueIndex}] SKIP — deck is ${deckState.status} ("${deckState.title}")`);
      return;
    }
    const next = this.queue[queueIndex];
    rotLog(`[ROT] preload ${deckId}[${queueIndex}] → "${next.title}" | decks: A="${this.stateA.title}"(${this.stateA.status}) B="${this.stateB.title}"(${this.stateB.status}) C="${this.stateC.title}"(${this.stateC.status})`);
    try {
      this.deckChainType[deckId] = next.chainType || "segue";
      await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb, next.durationMs);
      this.deckReady.add(deckId);
    } catch (e) { console.error(`[ROT] preload ${deckId} FAILED:`, e); }
  }

  private async refillIfNeeded() {
    if (this.queue.length === 0 && this.continuous && this.refillCallback) {
      rotLog(`[ROT] refill:begin — queue empty, fetching from refillCallback`);
      const songs = await this.refillCallback();
      this.queue.push(...songs);
      rotLog(`[ROT] refill:complete — added ${songs.length} | queue: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
    }
  }

  private dequeue() {
    const idx = this.shuffle ? Math.floor(Math.random() * this.queue.length) : 0;
    const item = this.queue.splice(idx, 1)[0];
    rotLog(`[ROT] dequeue → "${item?.title}" | queue after: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
    return item;
  }

  triggerPreload() {
    rotLog(`[ROT] triggerPreload — queue: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
    this.preloadDeck("B", 0).then(() => { setTimeout(() => this.preloadDeck("C", 1), 400); });
  }

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  setDeckDuration(id: DeckId, durationSec: number) {
    if (id === "A") { this.stateA = { ...this.stateA, durationSec }; this.listeners.forEach(l => l("A", this.stateA)); }
    if (id === "B") { this.stateB = { ...this.stateB, durationSec }; this.listeners.forEach(l => l("B", this.stateB)); }
    if (id === "C") { this.stateC = { ...this.stateC, durationSec }; this.listeners.forEach(l => l("C", this.stateC)); }
  }
  onPlayStart(fn: (deckId: DeckId, title: string, artist: string, filePath: string) => void): () => void {
    this.playStartCallbacks.add(fn); return () => this.playStartCallbacks.delete(fn);
  }

  getDeck(id: DeckId | string) {
    const deckId = id as DeckId;
    const getState = () => deckId === "A" ? this.stateA : deckId === "B" ? this.stateB : this.stateC;
    return {
      getState,
      play: () => {
        if (deckId === "A") this.stateA = { ...this.stateA, status: "playing" };
        if (deckId === "B") this.stateB = { ...this.stateB, status: "playing" };
        if (deckId === "C") this.stateC = { ...this.stateC, status: "playing" };
        this.endTriggered.delete(deckId);
        return invoke("audio_play", { deck: deckId, stationId: this.stationId });
      },
      pause: () => invoke("audio_pause", { deck: deckId, stationId: this.stationId }),
      resume: () => invoke("audio_play", { deck: deckId, stationId: this.stationId }),
      stop: () => { this.endTriggered.delete(deckId); return invoke("audio_stop", { deck: deckId, stationId: this.stationId }); },
      setVolume: (v: number) => invoke("audio_set_volume", { deck: deckId, volume: v, stationId: this.stationId }),
      fadeTo: (vol: number, sec: number) => {
        const steps = 20;
        const current = getState().volume;
        const diff = vol - current;
        let step = 0;
        const interval = setInterval(() => {
          step++;
          invoke("audio_set_volume", { deck: deckId, volume: current + (diff * step / steps), stationId: this.stationId });
          if (step >= steps) clearInterval(interval);
        }, (sec * 1000) / steps);
      },
    };
  }

  async loadToDeck(id: DeckId | string, filePath: string, title: string, artist: string, gainDb?: number, durationMs?: number) {
    rotLog(`[ROT] loadToDeck ${id}: "${title}" | decks: A="${this.stateA.title}"(${this.stateA.status}) B="${this.stateB.title}"(${this.stateB.status}) C="${this.stateC.title}"(${this.stateC.status})`);
    this.init();
    await invoke("audio_load", { deck: id, filePath, title, artist, gainDb: gainDb ?? 0, stationId: this.stationId });
    const newState = { title, artist, filePath, positionSec: 0, durationSec: (durationMs ?? 0) / 1000, status: "idle" as DeckStatus, volume: 1, peaks: [] };
    if (id === "A") { this.stateA = { ...this.stateA, ...newState, id: "A" }; this.listeners.forEach(l => l("A", this.stateA)); }
    if (id === "B") { this.stateB = { ...this.stateB, ...newState, id: "B" }; this.listeners.forEach(l => l("B", this.stateB)); }
    if (id === "C") { this.stateC = { ...this.stateC, ...newState, id: "C" }; this.listeners.forEach(l => l("C", this.stateC)); }
    this.endTriggered.delete(id as DeckId);
    invoke("get_file_duration", { filePath }).then((dur: number) => {
      if (dur > 0) {
        if (id === "A") { this.stateA = { ...this.stateA, durationSec: dur }; this.listeners.forEach(l => l("A", this.stateA)); }
        if (id === "B") { this.stateB = { ...this.stateB, durationSec: dur }; this.listeners.forEach(l => l("B", this.stateB)); }
        if (id === "C") { this.stateC = { ...this.stateC, durationSec: dur }; this.listeners.forEach(l => l("C", this.stateC)); }
      }
    }).catch((e: unknown) => { console.warn('[ENGINE] get_file_duration failed', id, filePath, e); });
    // NOTE: playStartCallbacks are NOT fired here — loadToDeck is also used for
    // preloading standby decks. Callers that actually start playback must call
    // notifyPlayStart() after audio_play succeeds.
  }

  notifyPlayStart(deckId: DeckId, title: string, artist: string, filePath: string) {
    this.playStartCallbacks.forEach(fn => fn(deckId, title, artist, filePath));
  }

  addToQueue(songs: { filePath: string; title: string; artist: string; gainDb?: number; chainType?: "segue" | "stop"; durationMs?: number }[]) {
    rotLog(`[ROT] addToQueue +${songs.length} | before: [${this.queue.map(q => `"${q.title}"`).join(", ")}] | adding: [${songs.map(s => `"${s.title}"`).join(", ")}]`);
    this.queue.push(...songs);
    rotLog(`[ROT] addToQueue done | after: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
  }
  clearQueue() {
    rotLog(`[ROT] clearQueue — dropping ${this.queue.length} items: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
    this.queue = [];
  }
  getQueue() { return [...this.queue]; }
  /** Reorder/replace pending queue without touching decks or triggering any load. Safe to call while playing. */
  replaceQueue(songs: { filePath: string; title: string; artist: string; gainDb?: number; chainType?: "segue" | "stop"; durationMs?: number }[]) {
    rotLog(`[ROT] replaceQueue — was [${this.queue.map(q => `"${q.title}"`).join(", ")}] | now [${songs.map(s => `"${s.title}"`).join(", ")}]`);
    this.queue = [...songs];
  }

  /** Toggle chain type for a queue item by index */
  setQueueItemChainType(idx: number, chainType: "segue" | "stop") {
    if (idx >= 0 && idx < this.queue.length) this.queue[idx].chainType = chainType;
  }
  setRefillCallback(fn: () => Promise<{ filePath: string; title: string; artist: string }[]>) { this.refillCallback = fn; }
  isDeckReady(id: DeckId): boolean    { return this.deckReady.has(id); }
  markDeckReady(id: DeckId): void     { this.deckReady.add(id); }
  clearDeckReady(id: DeckId): void    { this.deckReady.delete(id); }
  async setOutputDevice(_id: string) {}

  /**
   * Pop the first song from the queue, load it into deck A, and start
   * playing immediately. Used by the show-clock transition so the new
   * show begins on the exact second it's scheduled.
   */
  async jumpToNextSong(): Promise<boolean> {
    if (this.queue.length === 0) return false;
    // Reset the advance chain — show transitions are imperative, bypass the queue
    this.advancePromise = Promise.resolve();
    const next = this.dequeue();
    try {
      await this.loadToDeck("A", next.filePath, next.title, next.artist, next.gainDb, next.durationMs);
      await invoke("audio_play", { deck: "A", stationId: this.stationId });
      this.stateA = { ...this.stateA, status: "playing", positionSec: 0 };
      this.endTriggered.delete("A");
      // Preload next two songs into B and C so rotation is seamless
      setTimeout(async () => {
        await this.preloadDeck("B", 0);
        setTimeout(() => this.preloadDeck("C", 1), 400);
      }, 800);
      return true;
    } catch (e) {
      console.error("[ENGINE] jumpToNextSong error:", e);
      return false;
    }
  }

  crossfade(fromId: DeckId, toId: DeckId, ms = 2000) {
    const from = this.getDeck(fromId);
    const to = this.getDeck(toId);
    to.setVolume(1);
    invoke("audio_play", { deck: toId, stationId: this.stationId });
    from.fadeTo(0, ms / 1000);
    setTimeout(() => invoke("audio_stop", { deck: fromId, stationId: this.stationId }), ms + 100);
  }

  checkOutroCrossfade() {}
}

// SCAFFOLDING: hardcoded 1 matches current Rust default behavior
// (station_id: None → unwrap_or(1) in native/src/lib.rs).
// Replaced in Commit 2 by the AudioEngine registry that creates
// per-station instances dynamically based on which station the
// dashboard is viewing or which station code is operating on.
// Do not "fix" this hardcoded 1 until Commit 2 lands — it is
// intentional transitional state, not a bug.
export const engine = new AudioEngine(1);
