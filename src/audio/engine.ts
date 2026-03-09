import { readFile } from "@tauri-apps/plugin-fs";

export type DeckId = "A" | "B";
export type DeckStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface DeckState {
  id: DeckId;
  status: DeckStatus;
  title: string;
  artist: string;
  filePath: string;
  durationSec: number;
  positionSec: number;
  volume: number;
  error: string | null;
}

type Listener = (deck: DeckId, state: DeckState) => void;

class Deck {
  id: DeckId;
  private ctx: AudioContext;
  private gainNode: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private startedAt = 0;
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private notify: Listener;

  status: DeckStatus = "idle";
  title = "";
  artist = "";
  filePath = "";
  durationSec = 0;
  volume = 1;
  error: string | null = null;

  constructor(id: DeckId, ctx: AudioContext, notify: Listener) {
    this.id = id;
    this.ctx = ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.connect(ctx.destination);
    this.notify = notify;
  }

  get positionSec(): number {
    if (this.status !== "playing") return this.offset;
    return this.offset + (this.ctx.currentTime - this.startedAt);
  }

  getState(): DeckState {
    return { id: this.id, status: this.status, title: this.title, artist: this.artist, filePath: this.filePath, durationSec: this.durationSec, positionSec: this.positionSec, volume: this.volume, error: this.error };
  }

  private emit() { this.notify(this.id, this.getState()); }

  async load(filePath: string, title: string, artist: string) {
    this.stop();
    this.status = "loading";
    this.filePath = filePath;
    this.title = title;
    this.artist = artist;
    this.error = null;
    this.emit();

    try {
      // MANUAL READ BYPASS: Reading bytes directly avoids the 403 Forbidden asset error
      const fileData = await readFile(filePath);
      const ab = fileData.buffer;

      // Decode the raw buffer into audio data
      this.buffer = await this.ctx.decodeAudioData(ab);
      this.durationSec = this.buffer.duration;
      this.status = "idle";
      this.emit();
    } catch (e) {
      this.status = "error";
      this.error = String(e);
      console.error("Audio Load Error:", e);
      this.emit();
    }
  }

  play(fromSec = 0) {
    if (!this.buffer) return;
    if (this.status === "playing") this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gainNode);
    src.start(0, fromSec);
    this.source = src;
    this.startedAt = this.ctx.currentTime;
    this.offset = fromSec;
    this.status = "playing";
    this.emit();

    src.onended = () => {
      if (this.status === "playing") {
        this.status = "ended";
        this.offset = this.durationSec;
        this.clearTimer();
        this.emit();
        // Global event for auto-advance logic
        window.dispatchEvent(new CustomEvent('deck-ended', { detail: { deckId: this.id } }));
      }
    };
    this.startTimer();
  }

  pause() {
    if (this.status !== "playing") return;
    this.offset = this.positionSec;
    this.stopSource();
    this.status = "paused";
    this.clearTimer();
    this.emit();
  }

  resume() { if (this.status === "paused") this.play(this.offset); }

  stop() {
    this.stopSource();
    this.clearTimer();
    this.status = "idle";
    this.offset = 0;
    this.emit();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  fadeTo(vol: number, sec: number) {
    this.gainNode.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + sec);
  }

  private stopSource() { try { this.source?.stop(); } catch {} this.source = null; }

  private startTimer() {
    this.clearTimer();
    this.timer = setInterval(() => this.emit(), 200);
  }

  private clearTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private deckA: Deck | null = null;
  private deckB: Deck | null = null;
  private listeners = new Set<Listener>();

  private onDeckEvent: Listener = (id, state) => { this.listeners.forEach(l => l(id, state)); };

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.deckA = new Deck("A", this.ctx, this.onDeckEvent);
    this.deckB = new Deck("B", this.ctx, this.onDeckEvent);
  }

  on(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  getDeck(id: DeckId): Deck | null { return id === "A" ? this.deckA : this.deckB; }

  getStates(): { a: DeckState; b: DeckState } {
    const empty = (id: DeckId): DeckState => ({ id, status: "idle", title: "", artist: "", filePath: "", durationSec: 0, positionSec: 0, volume: 1, error: null });
    return { a: this.deckA?.getState() ?? empty("A"), b: this.deckB?.getState() ?? empty("B") };
  }

  async loadToDeck(id: DeckId, filePath: string, title: string, artist: string) {
    this.init();
    const deck = this.getDeck(id);
    if (deck) await deck.load(filePath, title, artist);
  }

  crossfade(fromId: DeckId, toId: DeckId, ms = 2000) {
    const from = this.getDeck(fromId);
    const to = this.getDeck(toId);
    if (!from || !to) return;
    to.play();
    from.fadeTo(0, ms / 1000);
    setTimeout(() => from.stop(), ms + 50);
  }
}

export const engine = new AudioEngine();
