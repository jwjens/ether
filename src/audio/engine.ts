import { readFile } from "@tauri-apps/plugin-fs";

export type DeckId = "A" | "B";
export type DeckStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface DeckState {
  id: DeckId; status: DeckStatus; title: string; artist: string;
  filePath: string; durationSec: number; positionSec: number;
  volume: number; error: string | null;
  peaks: number[];
}

type Listener = (deck: DeckId, state: DeckState) => void;
type EndCallback = (deck: DeckId) => void;

function extractPeaks(buffer: AudioBuffer, numPeaks: number): number[] {
  const chan = buffer.getChannelData(0);
  const step = Math.floor(chan.length / numPeaks);
  const peaks: number[] = [];
  for (let i = 0; i < numPeaks; i++) {
    let max = 0;
    const start = i * step;
    const end = Math.min(start + step, chan.length);
    for (let j = start; j < end; j++) {
      const abs = Math.abs(chan[j]);
      if (abs > max) max = abs;
    }
    peaks.push(max);
  }
  return peaks;
}

class Deck {
  id: DeckId;
  private ctx: AudioContext;
  private gainNode: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private buf: AudioBuffer | null = null;
  private startedAt = 0;
  private offset = 0;
  private timer: any = null;
  private notify: Listener;
  private onEnd: EndCallback;
  status: DeckStatus = "idle";
  title = ""; artist = ""; filePath = "";
  durationSec = 0; volume = 1; error: string | null = null;
  peaks: number[] = [];

  constructor(id: DeckId, ctx: AudioContext, notify: Listener, onEnd: EndCallback) {
    this.id = id; this.ctx = ctx; this.notify = notify; this.onEnd = onEnd;
    this.gainNode = ctx.createGain(); this.gainNode.connect(ctx.destination);
  }

  get positionSec(): number {
    if (this.status !== "playing") return this.offset;
    return this.offset + (this.ctx.currentTime - this.startedAt);
  }

  getState(): DeckState {
    return { id: this.id, status: this.status, title: this.title, artist: this.artist,
      filePath: this.filePath, durationSec: this.durationSec, positionSec: this.positionSec,
      volume: this.volume, error: this.error, peaks: this.peaks };
  }

  private emit() { this.notify(this.id, this.getState()); }

  async load(filePath: string, title: string, artist: string) {
    this.stop();
    this.status = "loading"; this.filePath = filePath;
    this.title = title; this.artist = artist; this.error = null;
    this.peaks = [];
    this.emit();
    try {
      const bytes = await readFile(filePath);
      const ab = bytes.buffer;
      this.buf = await this.ctx.decodeAudioData(ab);
      this.durationSec = this.buf.duration;
      this.peaks = extractPeaks(this.buf, 200);
      this.status = "idle"; this.emit();
    } catch (e) {
      this.status = "error"; this.error = String(e); this.emit();
    }
  }

  play(fromSec = 0) {
    if (!this.buf) return;
    if (this.status === "playing") this.killSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buf; src.connect(this.gainNode);
    src.start(0, fromSec);
    this.source = src; this.startedAt = this.ctx.currentTime;
    this.offset = fromSec; this.status = "playing"; this.emit();
    if (fromSec === 0) { (globalThis as any).__etherEngine?.notifyPlayStart(this.id, this.title, this.artist, this.filePath); }
    src.onended = () => {
      if (this.status === "playing") {
        this.status = "ended"; this.offset = this.durationSec;
        this.clearTimer(); this.emit();
        this.onEnd(this.id);
      }
    };
    this.startTimer();
  }

  pause() {
    if (this.status !== "playing") return;
    this.offset = this.positionSec; this.killSource();
    this.status = "paused"; this.clearTimer(); this.emit();
  }

  resume() { if (this.status === "paused") this.play(this.offset); }

  stop() {
    this.killSource(); this.clearTimer();
    this.status = "idle"; this.offset = 0;
    this.gainNode.gain.setValueAtTime(1, this.ctx.currentTime);
    this.volume = 1; this.emit();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  fadeTo(vol: number, sec: number) {
    this.volume = vol;
    this.gainNode.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + sec);
  }

  private killSource() { try { this.source?.stop(); } catch {} this.source = null; }
  private startTimer() { this.clearTimer(); this.timer = setInterval(() => this.emit(), 100); }
  private clearTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private deckA: Deck | null = null;
  private deckB: Deck | null = null;
  private listeners = new Set<Listener>();
  private playStartCallbacks = new Set<(deckId: DeckId, title: string, artist: string, filePath: string) => void>();
  private onEvt: Listener = (id, st) => { this.listeners.forEach(l => l(id, st)); };

  private queue: { filePath: string; title: string; artist: string }[] = [];
  autoAdvance = false;
  continuous = false;
  private refillCallback: (() => Promise<{ filePath: string; title: string; artist: string }[]>) | null = null;
  shuffle = false;

  private handleDeckEnd = (deckId: DeckId) => {
    if (!this.autoAdvance) return;
    if (this.queue.length === 0 && this.continuous && this.refillCallback) {
      this.refillCallback().then(songs => {
        this.queue.push(...songs);
        this.handleDeckEnd(deckId);
      });
      return;
    }
    if (this.queue.length === 0) return;
    let idx = 0;
    if (this.shuffle) idx = Math.floor(Math.random() * this.queue.length);
    const next = this.queue.splice(idx, 1)[0];
    const deck = this.getDeck(deckId);
    if (deck) {
      deck.load(next.filePath, next.title, next.artist).then(() => {
        deck.play();
        this.listeners.forEach(l => l(deckId, deck.getState()));
      });
    }
  };

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.deckA = new Deck("A", this.ctx, this.onEvt, this.handleDeckEnd);
    this.deckB = new Deck("B", this.ctx, this.onEvt, this.handleDeckEnd);
  }

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onPlayStart(fn: (deckId: DeckId, title: string, artist: string, filePath: string) => void): () => void { this.playStartCallbacks.add(fn); return () => this.playStartCallbacks.delete(fn); }
  getDeck(id: DeckId): Deck | null { return id === "A" ? this.deckA : this.deckB; }

  async loadToDeck(id: DeckId, filePath: string, title: string, artist: string) {
    this.init(); const d = this.getDeck(id); if (d) await d.load(filePath, title, artist);
  }

  notifyPlayStart(deckId: DeckId, title: string, artist: string, filePath: string) {
    this.playStartCallbacks.forEach(fn => fn(deckId, title, artist, filePath));
  }

  addToQueue(songs: { filePath: string; title: string; artist: string }[]) { this.queue.push(...songs); }
  clearQueue() { this.queue = []; }
  setRefillCallback(fn: () => Promise<{ filePath: string; title: string; artist: string }[]>) { this.refillCallback = fn; }
  getQueue() { return [...this.queue]; }

  crossfade(fromId: DeckId, toId: DeckId, ms = 2000) {
    const from = this.getDeck(fromId);
    const to = this.getDeck(toId);
    if (!from || !to) return;
    to.setVolume(1);
    to.play();
    from.fadeTo(0, ms / 1000);
    setTimeout(() => { from.stop(); from.setVolume(1); }, ms + 100);
  }
}

export const engine = new AudioEngine();