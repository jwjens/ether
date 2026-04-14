// Electron IPC — all audio commands go through window.ether.audio.*
async function invoke(cmd: string, args?: any): Promise<any> {
  const e = (window as any).ether;
  if (!e) { console.error("[ENGINE] window.ether not available — preload not loaded?"); return null; }
  switch (cmd) {
    case "audio_load":        return e.audio.load(args.deck, args.filePath, args.title, args.artist, args.gainDb);
    case "audio_play":        return e.audio.play(args.deck);
    case "audio_pause":       return e.audio.pause(args.deck);
    case "audio_stop":        return e.audio.stop(args.deck);
    case "audio_set_volume":  return e.audio.setVolume(args.deck, args.volume);
    case "audio_get_state":   return e.audio.getState();
    case "get_file_duration": return e.audio.getFileDuration(args.filePath);
    case "get_levels":        return e.audio.getLevels();
    case "watchdog_set":      return e.audio.watchdogSet(args.active, args.thresholdSec);
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
  private listeners = new Set<Listener>();
  private playStartCallbacks = new Set<(deckId: DeckId, title: string, artist: string, filePath: string) => void>();

  private stateA: DeckState = makeState("A", {});
  private stateB: DeckState = makeState("B", {});
  private stateC: DeckState = makeState("C", {});

  private pollTimer: any = null;
  private lastPollTime = Date.now();

  private queue: { filePath: string; title: string; artist: string; gainDb?: number }[] = [];
  private refillCallback: (() => Promise<{ filePath: string; title: string; artist: string }[]>) | null = null;

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
    this.pollTimer = setInterval(() => this.poll(), 100);
  }

  private async poll() {
    try {
      const s = await invoke("audio_get_state");
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

      this.listeners.forEach(l => l("A", this.stateA));
      this.listeners.forEach(l => l("B", this.stateB));
      this.listeners.forEach(l => l("C", this.stateC));

      this.checkEndByPosition("A", posA, durA, prevA);
      this.checkEndByPosition("B", posB, durB, prevB);
      this.checkEndByPosition("C", posC, durC, prevC);
      // Reset per-tick end gate — only one deck end is processed per 100ms poll cycle.
      this.processingEnd = false;

    } catch (e) {
      console.error("[ENGINE] Poll error:", e);
    }
  }

  private checkEndByPosition(deckId: DeckId, pos: number, dur: number, prevStatus: DeckStatus) {
    // Only one end event per poll tick — if another deck already fired this tick, skip.
    if (this.processingEnd) return;
    if (prevStatus === "playing" && dur > 5 && pos > 0 && (dur - pos) < 0.3 && !this.endTriggered.has(deckId)) {
      this.processingEnd = true;
      this.endTriggered.add(deckId);
      if (deckId === "A") {
        this.stateA = { ...this.stateA, status: "ended" };
        if (this.stateB.filePath) { this.handleRotate("A", "B"); }
        else if (this.autoAdvance) { this.handleLoadNextToDeck("A"); }
      } else if (deckId === "B") {
        this.stateB = { ...this.stateB, status: "ended" };
        if (this.stateC.filePath) { this.handleRotate("B", "C"); }
        else if (this.autoAdvance) { this.handleLoadNextToDeck("B"); }
      } else if (deckId === "C") {
        this.stateC = { ...this.stateC, status: "ended" };
        if (this.autoAdvance || this.queue.length > 0) { this.handleRotateCtoA(); }
      }
    }
  }

  private handleRotate(fromId: DeckId, toId: DeckId) {
    this.advancePromise = this.advancePromise.then(async () => {
      try {
        // Check the Rust backend: if the DESTINATION deck is already playing, bail.
        // We only check toId — fromId is expected to still be playing at this point
        // (checkEndByPosition fires 300ms before the track ends, so the from-deck
        // hasn't stopped yet). Checking "any deck playing" would always bail here.
        const liveState = await invoke("audio_get_state");
        if (liveState) {
          const liveTo = toId === "A" ? liveState.deckA : toId === "B" ? liveState.deckB : liveState.deckC;
          if (liveTo?.status === "playing") return;  // destination already playing — skip
        }
        await invoke("audio_play", { deck: toId });
        if (toId === "A") this.stateA = { ...this.stateA, status: "playing", positionSec: 0 };
        if (toId === "B") this.stateB = { ...this.stateB, status: "playing", positionSec: 0 };
        if (toId === "C") this.stateC = { ...this.stateC, status: "playing", positionSec: 0 };
        const toState2 = toId === "A" ? this.stateA : toId === "B" ? this.stateB : this.stateC;
        this.notifyPlayStart(toId, toState2.title, toState2.artist, toState2.filePath);
        // Only clear the destination deck's end-trigger — we want to allow toId to end
        // naturally later. Do NOT clear fromId here: the native backend may still report
        // fromId as "playing" for a tick or two while the OS drains the audio buffer.
        // Clearing fromId now lets checkEndByPosition re-fire on that stale "playing"
        // status before the deck reaches position 0 with a fresh track, causing a second
        // spurious rotation. fromId's endTriggered entry is cleared safely by loadToDeck
        // when preloadDeck loads the next song into it (position resets to 0 first).
        this.endTriggered.delete(toId);
        if (this.queue.length > 0) this.dequeue();
        if (toId === "B") { setTimeout(() => this.preloadDeck("C", 0), 800); }
        else if (toId === "C") { setTimeout(() => this.preloadDeck("A", 0), 800); }
        else if (toId === "A") { setTimeout(async () => { await this.preloadDeck("B", 0); setTimeout(() => this.preloadDeck("C", 1), 400); }, 800); }
      } catch (e) { console.error("[ENGINE] handleRotate error:", e); }
    });
  }

  private handleRotateCtoA() {
    this.advancePromise = this.advancePromise.then(async () => {
      try {
        // Check the Rust backend: if deck A (the destination) is already playing, bail.
        // C may still be playing when this fires (300ms before end), so we only check A.
        const liveState = await invoke("audio_get_state");
        if (liveState) {
          if (liveState.deckA?.status === "playing") return;  // A already playing — skip
        }
        await this.refillIfNeeded();
        if (this.queue.length === 0) return;
        const next = this.dequeue();
        await this.loadToDeck("A", next.filePath, next.title, next.artist, next.gainDb);
        await invoke("audio_play", { deck: "A" });
        this.stateA = { ...this.stateA, status: "playing", positionSec: 0 };
        this.notifyPlayStart("A", next.title, next.artist, next.filePath);
        this.endTriggered.delete("A");
        this.endTriggered.delete("C");
        setTimeout(async () => { await this.preloadDeck("B", 0); setTimeout(() => this.preloadDeck("C", 1), 400); }, 800);
      } catch (e) { console.error("[ENGINE] handleRotateCtoA error:", e); }
    });
  }

  private handleLoadNextToDeck(deckId: DeckId) {
    this.advancePromise = this.advancePromise.then(async () => {
      try {
        // Check the Rust backend: if the destination deck is already playing, bail.
        const liveState = await invoke("audio_get_state");
        if (liveState) {
          const liveDeck = deckId === "A" ? liveState.deckA : deckId === "B" ? liveState.deckB : liveState.deckC;
          if (liveDeck?.status === "playing") return;  // already playing — skip
        }
        await this.refillIfNeeded();
        if (this.queue.length === 0) return;
        const next = this.dequeue();
        await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb);
        await invoke("audio_play", { deck: deckId });
        if (deckId === "A") { this.stateA = { ...this.stateA, status: "playing", positionSec: 0 }; this.endTriggered.delete("A"); }
        if (deckId === "B") { this.stateB = { ...this.stateB, status: "playing", positionSec: 0 }; this.endTriggered.delete("B"); }
        if (deckId === "C") { this.stateC = { ...this.stateC, status: "playing", positionSec: 0 }; this.endTriggered.delete("C"); }
        this.notifyPlayStart(deckId, next.title, next.artist, next.filePath);
      } catch (e) { console.error("[ENGINE] handleLoadNextToDeck error:", e); }
    });
  }

  private async preloadDeck(deckId: DeckId, queueIndex = 0) {
    if (this.queue.length <= queueIndex) return;
    // Never clobber a deck that is actively playing or paused — it would interrupt audio
    const deckState = deckId === "A" ? this.stateA : deckId === "B" ? this.stateB : this.stateC;
    if (deckState?.status === "playing" || deckState?.status === "paused") return;
    const next = this.queue[queueIndex];
    try {
      await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb);
      console.log(`[ENGINE] Preloaded ${deckId} (queue[${queueIndex}]):`, next.title);
    } catch (e) { console.error(`[ENGINE] Preload ${deckId} failed:`, e); }
  }

  private async refillIfNeeded() {
    if (this.queue.length === 0 && this.continuous && this.refillCallback) {
      const songs = await this.refillCallback();
      this.queue.push(...songs);
    }
  }

  private dequeue() {
    const idx = this.shuffle ? Math.floor(Math.random() * this.queue.length) : 0;
    return this.queue.splice(idx, 1)[0];
  }

  triggerPreload() {
    this.preloadDeck("B", 0).then(() => { setTimeout(() => this.preloadDeck("C", 1), 400); });
  }

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
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
        return invoke("audio_play", { deck: deckId });
      },
      pause: () => invoke("audio_pause", { deck: deckId }),
      resume: () => invoke("audio_play", { deck: deckId }),
      stop: () => { this.endTriggered.delete(deckId); return invoke("audio_stop", { deck: deckId }); },
      setVolume: (v: number) => invoke("audio_set_volume", { deck: deckId, volume: v }),
      fadeTo: (vol: number, sec: number) => {
        const steps = 20;
        const current = getState().volume;
        const diff = vol - current;
        let step = 0;
        const interval = setInterval(() => {
          step++;
          invoke("audio_set_volume", { deck: deckId, volume: current + (diff * step / steps) });
          if (step >= steps) clearInterval(interval);
        }, (sec * 1000) / steps);
      },
    };
  }

  async loadToDeck(id: DeckId | string, filePath: string, title: string, artist: string, gainDb?: number) {
    this.init();
    await invoke("audio_load", { deck: id, filePath, title, artist, gainDb: gainDb ?? 0 });
    const newState = { title, artist, filePath, positionSec: 0, durationSec: 0, status: "idle" as DeckStatus, volume: 1, peaks: [] };
    if (id === "A") this.stateA = { ...this.stateA, ...newState, id: "A" };
    if (id === "B") this.stateB = { ...this.stateB, ...newState, id: "B" };
    if (id === "C") this.stateC = { ...this.stateC, ...newState, id: "C" };
    this.endTriggered.delete(id as DeckId);
    invoke("get_file_duration", { filePath }).then((dur: number) => {
      if (id === "A") this.stateA = { ...this.stateA, durationSec: dur };
      if (id === "B") this.stateB = { ...this.stateB, durationSec: dur };
      if (id === "C") this.stateC = { ...this.stateC, durationSec: dur };
    }).catch(() => {});
    // NOTE: playStartCallbacks are NOT fired here — loadToDeck is also used for
    // preloading standby decks. Callers that actually start playback must call
    // notifyPlayStart() after audio_play succeeds.
  }

  notifyPlayStart(deckId: DeckId, title: string, artist: string, filePath: string) {
    this.playStartCallbacks.forEach(fn => fn(deckId, title, artist, filePath));
  }

  addToQueue(songs: { filePath: string; title: string; artist: string; gainDb?: number }[]) { this.queue.push(...songs); }
  clearQueue() { this.queue = []; }
  getQueue() { return [...this.queue]; }
  /** Reorder/replace pending queue without touching decks or triggering any load. Safe to call while playing. */
  replaceQueue(songs: { filePath: string; title: string; artist: string; gainDb?: number }[]) { this.queue = [...songs]; }
  setRefillCallback(fn: () => Promise<{ filePath: string; title: string; artist: string }[]>) { this.refillCallback = fn; }
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
      await this.loadToDeck("A", next.filePath, next.title, next.artist, next.gainDb);
      await invoke("audio_play", { deck: "A" });
      this.stateA = { ...this.stateA, status: "playing", positionSec: 0 };
      this.notifyPlayStart("A", next.title, next.artist, next.filePath);
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
    invoke("audio_play", { deck: toId });
    from.fadeTo(0, ms / 1000);
    setTimeout(() => invoke("audio_stop", { deck: fromId }), ms + 100);
  }

  checkOutroCrossfade() {}
}

export const engine = new AudioEngine();
