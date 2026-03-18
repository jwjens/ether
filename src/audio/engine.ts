
import { invoke } from "@tauri-apps/api/core";

export type DeckId = "A" | "B";
export type DeckStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface DeckState {
  id: DeckId; status: DeckStatus; title: string; artist: string;
  filePath: string; durationSec: number; positionSec: number;
  volume: number; error: string | null;
  peaks: number[];
  outroStartSec: number;
}

type Listener = (deck: DeckId, state: DeckState) => void;

function makeState(id: DeckId, data: any): DeckState {
  return {
    id,
    status: data.status || "idle",
    title: data.title || "",
    artist: data.artist || "",
    filePath: data.filePath || "",
    durationSec: data.durationSec || 0,
    positionSec: data.positionSec || 0,
    volume: data.volume ?? 1,
    error: data.error || null,
    peaks: [],
    outroStartSec: 0,
  };
}

export class AudioEngine {
  private listeners = new Set<Listener>();
  private playStartCallbacks = new Set<(deckId: DeckId, title: string, artist: string, filePath: string) => void>();
  private stateA: DeckState = makeState("A", {});
  private stateB: DeckState = makeState("B", {});
  private stateC: DeckState = makeState("C", {});
  private pollTimer: any = null;
  private queue: { filePath: string; title: string; artist: string }[] = [];
  autoAdvance = false;
  outroCrossfade = false;
  crossfadeDuration = 3;
  continuous = false;
  shuffle = false;
  private refillCallback: (() => Promise<{ filePath: string; title: string; artist: string }[]>) | null = null;
  private advancing = false;

  init() {
    if (this.pollTimer) return;
    // Poll Rust audio state every 100ms
    this.pollTimer = setInterval(() => this.poll(), 100);
  }

  private async poll() {
    try {
      const s = await invoke<any>("audio_get_state");
      const prevA = this.stateA.status;
      const prevB = this.stateB.status;
      this.stateA = makeState("A", s.deckA);
      this.stateB = makeState("B", s.deckB);
      if (s.deckC) this.stateC = makeState("C", s.deckC);

      this.listeners.forEach(l => l("A", this.stateA));
      this.listeners.forEach(l => l("B", this.stateB));
      this.listeners.forEach(l => l("C", this.stateC));

      // Check if deck finished playing
      if (s.deckA.isFinished && prevA === "playing" && this.autoAdvance) {
        this.stateA.status = "ended";
        this.handleDeckEnd("A");
      }
      if (s.deckB.isFinished && prevB === "playing" && this.autoAdvance) {
        this.stateB.status = "ended";
        this.handleDeckEnd("B");
      }
    } catch (e) {
      // Rust not ready yet
    }
  }

  private async handleDeckEnd(deckId: DeckId) {
    if (this.advancing) return;
    if (this.queue.length === 0 && this.continuous && this.refillCallback) {
      const songs = await this.refillCallback();
      this.queue.push(...songs);
    }
    if (this.queue.length === 0) return;
    this.advancing = true;
    let idx = this.shuffle ? Math.floor(Math.random() * this.queue.length) : 0;
    const next = this.queue.splice(idx, 1)[0];
    await this.loadToDeck(deckId, next.filePath, next.title, next.artist);
    await invoke("audio_play", { deck: deckId });
    this.advancing = false;
  }

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onPlayStart(fn: (deckId: DeckId, title: string, artist: string, filePath: string) => void): () => void {
    this.playStartCallbacks.add(fn); return () => this.playStartCallbacks.delete(fn);
  }

  getDeck(id: DeckId) {
    const state = id === "A" ? this.stateA : id === "C" ? this.stateC : this.stateB;
    return {
      getState: () => state,
      play: () => invoke("audio_play", { deck: id }),
      pause: () => invoke("audio_pause", { deck: id }),
      resume: () => invoke("audio_play", { deck: id }),
      stop: () => invoke("audio_stop", { deck: id }),
      setVolume: (v: number) => invoke("audio_set_volume", { deck: id, volume: v }),
      fadeTo: (vol: number, sec: number) => {
        // Simple stepped fade
        const steps = 20;
        const current = state.volume;
        const diff = vol - current;
        let step = 0;
        const interval = setInterval(() => {
          step++;
          const newVol = current + (diff * step / steps);
          invoke("audio_set_volume", { deck: id, volume: newVol });
          if (step >= steps) clearInterval(interval);
        }, (sec * 1000) / steps);
      },
    };
  }

  async loadToDeck(id: DeckId, filePath: string, title: string, artist: string) {
    this.init();
    await invoke("audio_load", { deck: id, filePath, title, artist });
    this.playStartCallbacks.forEach(fn => fn(id, title, artist, filePath));
  }

  notifyPlayStart(deckId: DeckId, title: string, artist: string, filePath: string) {
    this.playStartCallbacks.forEach(fn => fn(deckId, title, artist, filePath));
  }

  addToQueue(songs: { filePath: string; title: string; artist: string }[]) { this.queue.push(...songs); }
  clearQueue() { this.queue = []; }
  getQueue() { return [...this.queue]; }
  setRefillCallback(fn: () => Promise<{ filePath: string; title: string; artist: string }[]>) { this.refillCallback = fn; }

  checkOutroCrossfade() {
    // Handled by poll + handleDeckEnd
  }

  async setOutputDevice(_deviceId: string) {
    // rodio uses system default - device selection via system settings
  }

  crossfade(fromId: DeckId, toId: DeckId, ms = 2000) {
    const from = this.getDeck(fromId);
    const to = this.getDeck(toId);
    to.setVolume(1);
    invoke("audio_play", { deck: toId });
    from.fadeTo(0, ms / 1000);
    setTimeout(() => invoke("audio_stop", { deck: fromId }), ms + 100);
  }
}

export const engine = new AudioEngine();


