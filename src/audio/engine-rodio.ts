import { invoke } from "@tauri-apps/api/core";

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

  autoAdvance = false;
  shuffle = false;
  continuous = false;
  outroCrossfade = false;
  crossfadeDuration = 3;
  private advancing = false;

  init() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), 100);
  }

  private async poll() {
    try {
      const s = await invoke<any>("audio_get_state");
      const now = Date.now();
      const elapsed = (now - this.lastPollTime) / 1000;
      this.lastPollTime = now;

      const prevA = this.stateA.status;
      const prevB = this.stateB.status;

      // Preserve duration and increment position when playing
      const durA = this.stateA.durationSec;
      const durB = this.stateB.durationSec;
      const isPlayingA = !s.deckA.isFinished && this.stateA.status === "playing";
      const isPlayingB = !s.deckB.isFinished && this.stateB.status === "playing";
      const posA = isPlayingA ? Math.min(this.stateA.positionSec + elapsed, durA || 9999) : this.stateA.positionSec;
      const posB = isPlayingB ? Math.min(this.stateB.positionSec + elapsed, durB || 9999) : this.stateB.positionSec;

      const newA = makeState("A", s.deckA);
      const newB = makeState("B", s.deckB);

      this.stateA = { ...newA, durationSec: durA, positionSec: posA };
      this.stateB = { ...newB, durationSec: durB, positionSec: posB };

      // C is UI-only state, don't overwrite from Rust
      this.listeners.forEach(l => l("A", this.stateA));
      this.listeners.forEach(l => l("B", this.stateB));
      this.listeners.forEach(l => l("C", this.stateC));

      // Detect track end
      if (s.deckA.isFinished && prevA === "playing") {
        this.stateA = { ...this.stateA, status: "ended" };
        if (this.autoAdvance) this.handleDeckEnd("A");
      }
      if (s.deckB.isFinished && prevB === "playing") {
        this.stateB = { ...this.stateB, status: "ended" };
        if (this.autoAdvance) this.handleDeckEnd("B");
      }
    } catch {}
  }

  private async handleDeckEnd(deckId: DeckId) {
    if (this.advancing) return;
    this.advancing = true;
    try {
      if (this.queue.length === 0 && this.continuous && this.refillCallback) {
        const songs = await this.refillCallback();
        this.queue.push(...songs);
      }
      if (this.queue.length === 0) return;
      const idx = this.shuffle ? Math.floor(Math.random() * this.queue.length) : 0;
      const next = this.queue.splice(idx, 1)[0];
      await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb);
      await invoke("audio_play", { deck: deckId === "C" ? "B" : deckId });
      if (deckId === "A") this.stateA = { ...this.stateA, status: "playing", positionSec: 0 };
      if (deckId === "B") this.stateB = { ...this.stateB, status: "playing", positionSec: 0 };
    } finally {
      this.advancing = false;
    }
  }

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onPlayStart(fn: (deckId: DeckId, title: string, artist: string, filePath: string) => void): () => void {
    this.playStartCallbacks.add(fn); return () => this.playStartCallbacks.delete(fn);
  }

  getDeck(id: DeckId | string) {
    const state = id === "A" ? this.stateA : id === "C" ? this.stateC : this.stateB;
    return {
      getState: () => state,
      play: () => {
        const rustDeck = id === "C" ? "B" : id;
        if (id === "A") this.stateA = { ...this.stateA, status: "playing" };
        if (id === "B") this.stateB = { ...this.stateB, status: "playing" };
        return invoke("audio_play", { deck: rustDeck });
      },
      pause: () => invoke("audio_pause", { deck: id === "C" ? "B" : id }),
      resume: () => invoke("audio_play", { deck: id === "C" ? "B" : id }),
      stop: () => invoke("audio_stop", { deck: id === "C" ? "B" : id }),
      setVolume: (v: number) => invoke("audio_set_volume", { deck: id === "C" ? "B" : id, volume: v }),
      fadeTo: (vol: number, sec: number) => {
        const steps = 20;
        const current = state.volume;
        const diff = vol - current;
        let step = 0;
        const rustDeck = id === "C" ? "B" : id;
        const interval = setInterval(() => {
          step++;
          invoke("audio_set_volume", { deck: rustDeck, volume: current + (diff * step / steps) });
          if (step >= steps) clearInterval(interval);
        }, (sec * 1000) / steps);
      },
    };
  }

  async loadToDeck(id: DeckId | string, filePath: string, title: string, artist: string, gainDb?: number) {
    this.init();
    const rustDeck = (id === "C" || id === "B") ? "B" : "A";
    await invoke("audio_load", { deck: rustDeck, filePath, title, artist, gainDb: gainDb ?? 0 });

    // Update state immediately
    const newState = { title, artist, filePath, positionSec: 0, durationSec: 0, status: "idle" as DeckStatus, volume: 1, peaks: [] };
    if (id === "A") this.stateA = { ...this.stateA, ...newState, id: "A" };
    if (id === "B") this.stateB = { ...this.stateB, ...newState, id: "B" };
    if (id === "C") this.stateC = { ...this.stateC, ...newState, id: "C" };

    // Get duration async
    invoke<number>("get_file_duration", { filePath }).then(dur => {
      if (id === "A") this.stateA = { ...this.stateA, durationSec: dur };
      if (id === "B") this.stateB = { ...this.stateB, durationSec: dur };
      if (id === "C") this.stateC = { ...this.stateC, durationSec: dur };
    }).catch(() => {});

    this.playStartCallbacks.forEach(fn => fn(id as DeckId, title, artist, filePath));
  }

  notifyPlayStart(deckId: DeckId, title: string, artist: string, filePath: string) {
    this.playStartCallbacks.forEach(fn => fn(deckId, title, artist, filePath));
  }

  addToQueue(songs: { filePath: string; title: string; artist: string; gainDb?: number }[]) { this.queue.push(...songs); }
  clearQueue() { this.queue = []; }
  getQueue() { return [...this.queue]; }
  setRefillCallback(fn: () => Promise<{ filePath: string; title: string; artist: string }[]>) { this.refillCallback = fn; }

  async setOutputDevice(_id: string) {}

  crossfade(fromId: DeckId, toId: DeckId, ms = 2000) {
    const from = this.getDeck(fromId);
    const to = this.getDeck(toId);
    to.setVolume(1);
    invoke("audio_play", { deck: toId === "C" ? "B" : toId });
    from.fadeTo(0, ms / 1000);
    setTimeout(() => invoke("audio_stop", { deck: fromId === "C" ? "B" : fromId }), ms + 100);
  }

  checkOutroCrossfade() {}
}

export const engine = new AudioEngine();
