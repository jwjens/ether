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
  private endTriggered = new Set<DeckId>();

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

    } catch (e) {
      console.error("[ENGINE] Poll error:", e);
    }
  }

  private checkEndByPosition(deckId: DeckId, pos: number, dur: number, prevStatus: DeckStatus) {
    if (
      prevStatus === "playing" &&
      dur > 5 &&
      pos > 0 &&
      (dur - pos) < 0.3 &&
      !this.endTriggered.has(deckId)
    ) {
      this.endTriggered.add(deckId);
      console.log(`[ENGINE] ${deckId} near end (${pos.toFixed(1)}/${dur.toFixed(1)}) — rotating`);

      if (deckId === "A") {
        this.stateA = { ...this.stateA, status: "ended" };
        if (this.stateB.filePath) {
          this.handleRotate("A", "B");
        } else if (this.autoAdvance) {
          this.handleLoadNextToDeck("A");
        }
      } else if (deckId === "B") {
        this.stateB = { ...this.stateB, status: "ended" };
        console.log(`[ENGINE] B ended — stateC.filePath: "${this.stateC.filePath}" | stateC.title: "${this.stateC.title}" | autoAdvance: ${this.autoAdvance}`);
        if (this.stateC.filePath) {
          console.log("[ENGINE] Rotating B→C:", this.stateC.title);
          this.handleRotate("B", "C");
        } else if (this.autoAdvance) {
          console.log("[ENGINE] No C loaded — loading next to B from queue, queue len:", this.queue.length);
          this.handleLoadNextToDeck("B");
        }
      } else if (deckId === "C") {
        this.stateC = { ...this.stateC, status: "ended" };
        if (this.autoAdvance || this.queue.length > 0) {
          this.handleRotateCtoA();
        }
      }
    }
  }

  private async handleRotate(fromId: DeckId, toId: DeckId) {
    if (this.advancing) { console.warn("[ENGINE] handleRotate blocked"); return; }
    this.advancing = true;
    try {
      await invoke("audio_play", { deck: toId });
      if (toId === "A") this.stateA = { ...this.stateA, status: "playing", positionSec: 0 };
      if (toId === "B") this.stateB = { ...this.stateB, status: "playing", positionSec: 0 };
      if (toId === "C") this.stateC = { ...this.stateC, status: "playing", positionSec: 0 };
      this.endTriggered.delete(toId);
      this.listeners.forEach(l => l(toId, toId === "A" ? this.stateA : toId === "B" ? this.stateB : this.stateC));

      // Dequeue the track toId just started playing — it was preloaded from queue[0]
      if (this.queue.length > 0) this.dequeue();

      // Preload the right deck for the next step in rotation
      if (toId === "B") {
        // C already has queue[1] which is now queue[0] after dequeue — reload to be safe
        setTimeout(() => this.preloadDeck("C", 0), 800);
      } else if (toId === "C") {
        // Next rotation is C→A, preload A
        setTimeout(() => this.preloadDeck("A", 0), 800);
      } else if (toId === "A") {
        // Next rotation is A→B→C, preload both
        setTimeout(async () => {
          await this.preloadDeck("B", 0);
          setTimeout(() => this.preloadDeck("C", 1), 400);
        }, 800);
      }
    } catch (e) {
      console.error("[ENGINE] handleRotate error:", e);
    } finally {
      this.advancing = false;
    }
  }

  private async handleRotateCtoA() {
    if (this.advancing) return;
    this.advancing = true;
    try {
      await this.refillIfNeeded();
      if (this.queue.length === 0) return;
      const next = this.dequeue();
      await this.loadToDeck("A", next.filePath, next.title, next.artist, next.gainDb);
      await invoke("audio_play", { deck: "A" });
      this.stateA = { ...this.stateA, status: "playing", positionSec: 0 };
      this.endTriggered.delete("A");
      this.listeners.forEach(l => l("A", this.stateA));
      setTimeout(async () => {
        await this.preloadDeck("B", 0);
        setTimeout(() => this.preloadDeck("C", 1), 400);
      }, 800);
    } catch (e) {
      console.error("[ENGINE] handleRotateCtoA error:", e);
    } finally {
      this.advancing = false;
    }
  }

  private async handleLoadNextToDeck(deckId: DeckId) {
    if (this.advancing) return;
    this.advancing = true;
    try {
      await this.refillIfNeeded();
      if (this.queue.length === 0) return;
      const next = this.dequeue();
      await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb);
      await invoke("audio_play", { deck: deckId });
      if (deckId === "A") { this.stateA = { ...this.stateA, status: "playing", positionSec: 0 }; this.endTriggered.delete("A"); }
      if (deckId === "B") { this.stateB = { ...this.stateB, status: "playing", positionSec: 0 }; this.endTriggered.delete("B"); }
      if (deckId === "C") { this.stateC = { ...this.stateC, status: "playing", positionSec: 0 }; this.endTriggered.delete("C"); }
    } catch (e) {
      console.error("[ENGINE] handleLoadNextToDeck error:", e);
    } finally {
      this.advancing = false;
    }
  }

  private async preloadDeck(deckId: DeckId, queueIndex = 0) {
    if (this.queue.length <= queueIndex) return;
    const next = this.queue[queueIndex];
    try {
      await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb);
      console.log(`[ENGINE] Preloaded ${deckId} (queue[${queueIndex}]):`, next.title);
    } catch (e) {
      console.error(`[ENGINE] Preload ${deckId} failed:`, e);
    }
  }

  private async refillIfNeeded() {
    if (this.queue.length === 0 && this.continuous && this.refillCallback) {
      const songs = await this.refillCallback();
      this.queue.push(...songs);
    }
  }

  private dequeue(): { filePath: string; title: string; artist: string; gainDb?: number } {
    const idx = this.shuffle ? Math.floor(Math.random() * this.queue.length) : 0;
    return this.queue.splice(idx, 1)[0];
  }

  triggerPreload() {
    this.preloadDeck("B", 0).then(() => {
      setTimeout(() => this.preloadDeck("C", 1), 400);
    });
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
      stop: () => {
        this.endTriggered.delete(deckId);
        return invoke("audio_stop", { deck: deckId });
      },
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
    invoke("audio_play", { deck: toId });
    from.fadeTo(0, ms / 1000);
    setTimeout(() => invoke("audio_stop", { deck: fromId }), ms + 100);
  }

  checkOutroCrossfade() {}
}

export const engine = new AudioEngine();
