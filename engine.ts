/**
 * OpenAir Audio Engine
 * 
 * Dual-deck broadcast player using Web Audio API.
 * Deck A = "on air", Deck B = "next/cued"
 * 
 * Works inside Tauri's webview — same as a browser.
 * For lower-latency or multi-device output, swap AudioContext
 * for a Tauri Rust command that calls rodio.
 */

export type DeckId = 'A' | 'B';
export type DeckStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface DeckState {
  id: DeckId;
  status: DeckStatus;
  filePath: string | null;
  title: string;
  artist: string;
  durationMs: number;
  positionMs: number;
  introMs: number;
  outroMs: number;
  volume: number;
  isCued: boolean;
  error: string | null;
}

export type EngineEventType =
  | 'deck_status_change'
  | 'deck_position'
  | 'deck_intro_reached'
  | 'deck_outro_reached'
  | 'deck_ended'
  | 'cart_status_change'
  | 'error';

export interface EngineEvent {
  type: EngineEventType;
  deck?: DeckId;
  cartId?: string;
  state?: DeckState;
  positionMs?: number;
  error?: string;
}

type EngineListener = (event: EngineEvent) => void;

// ============================================================
// DECK
// ============================================================

class Deck {
  readonly id: DeckId;
  private ctx: AudioContext;
  private gainNode: GainNode;
  private sourceNode: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  status: DeckStatus = 'idle';
  filePath: string | null = null;
  title = '';
  artist = '';
  durationMs = 0;
  introMs = 0;
  outroMs = 0;
  volume = 1.0;
  isCued = false;
  error: string | null = null;

  private startedAt = 0;       // AudioContext.currentTime when play started
  private offsetMs = 0;         // where in the file we started
  private positionTimer: ReturnType<typeof setInterval> | null = null;
  private onEvent: (e: EngineEvent) => void;

  constructor(id: DeckId, ctx: AudioContext, onEvent: (e: EngineEvent) => void) {
    this.id = id;
    this.ctx = ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.connect(ctx.destination);
    this.onEvent = onEvent;
  }

  get positionMs(): number {
    if (this.status !== 'playing') return this.offsetMs;
    return this.offsetMs + (this.ctx.currentTime - this.startedAt) * 1000;
  }

  async load(filePath: string, title = '', artist = '', introMs = 0, outroMs = 0): Promise<void> {
    this.stop();
    this.status = 'loading';
    this.filePath = filePath;
    this.title = title;
    this.artist = artist;
    this.introMs = introMs;
    this.outroMs = outroMs;
    this.error = null;
    this.emit('deck_status_change');

    try {
      // In Tauri, file:// URIs work for local files via allowlist
      const url = filePath.startsWith('http') ? filePath : `file://${filePath}`;
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
      this.durationMs = this.buffer.duration * 1000;
      this.status = 'idle';
      this.isCued = true;
      this.emit('deck_status_change');
    } catch (err) {
      this.status = 'error';
      this.error = String(err);
      this.emit('error', { error: this.error });
    }
  }

  play(fromMs = 0): void {
    if (!this.buffer) return;
    if (this.status === 'playing') this.pause();

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gainNode);

    const offsetSec = fromMs / 1000;
    source.start(0, offsetSec);
    this.sourceNode = source;
    this.startedAt = this.ctx.currentTime;
    this.offsetMs = fromMs;
    this.status = 'playing';
    this.isCued = false;
    this.emit('deck_status_change');

    source.onended = () => {
      if (this.status === 'playing') {
        this.status = 'ended';
        this.offsetMs = this.durationMs;
        this.clearPositionTimer();
        this.emit('deck_ended');
        this.emit('deck_status_change');
      }
    };

    this.startPositionTimer();
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.offsetMs = this.positionMs;
    this.sourceNode?.stop();
    this.sourceNode = null;
    this.status = 'paused';
    this.clearPositionTimer();
    this.emit('deck_status_change');
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.play(this.offsetMs);
  }

  stop(): void {
    this.sourceNode?.stop();
    this.sourceNode = null;
    this.clearPositionTimer();
    this.status = 'idle';
    this.offsetMs = 0;
    this.isCued = false;
    this.emit('deck_status_change');
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  fadeTo(targetVol: number, durationSec: number): void {
    this.gainNode.gain.linearRampToValueAtTime(
      targetVol,
      this.ctx.currentTime + durationSec,
    );
  }

  getState(): DeckState {
    return {
      id: this.id,
      status: this.status,
      filePath: this.filePath,
      title: this.title,
      artist: this.artist,
      durationMs: this.durationMs,
      positionMs: this.positionMs,
      introMs: this.introMs,
      outroMs: this.outroMs,
      volume: this.volume,
      isCued: this.isCued,
      error: this.error,
    };
  }

  private emit(type: EngineEventType, extra: Partial<EngineEvent> = {}): void {
    this.onEvent({ type, deck: this.id, state: this.getState(), ...extra });
  }

  private startPositionTimer(): void {
    this.clearPositionTimer();
    this.positionTimer = setInterval(() => {
      const pos = this.positionMs;
      this.onEvent({ type: 'deck_position', deck: this.id, positionMs: pos });

      // Fire intro/outro markers
      if (this.introMs > 0 && pos >= this.introMs && pos < this.introMs + 100) {
        this.onEvent({ type: 'deck_intro_reached', deck: this.id });
      }
      const outroPoint = this.durationMs - this.outroMs;
      if (this.outroMs > 0 && pos >= outroPoint && pos < outroPoint + 100) {
        this.onEvent({ type: 'deck_outro_reached', deck: this.id });
      }
    }, 80); // ~12fps position updates
  }

  private clearPositionTimer(): void {
    if (this.positionTimer) {
      clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
  }
}

// ============================================================
// CART PLAYER (for cart wall buttons)
// ============================================================

class CartPlayer {
  readonly cartId: string;
  private ctx: AudioContext;
  private gainNode: GainNode;
  private sourceNode: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;

  status: DeckStatus = 'idle';
  private onEvent: (e: EngineEvent) => void;

  constructor(cartId: string, ctx: AudioContext, onEvent: (e: EngineEvent) => void) {
    this.cartId = cartId;
    this.ctx = ctx;
    this.gainNode = ctx.createGain();
    this.gainNode.connect(ctx.destination);
    this.onEvent = onEvent;
  }

  async load(filePath: string): Promise<void> {
    const url = filePath.startsWith('http') ? filePath : `file://${filePath}`;
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
  }

  play(): void {
    if (!this.buffer) return;
    this.sourceNode?.stop();
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gainNode);
    source.start(0);
    this.sourceNode = source;
    this.status = 'playing';
    this.onEvent({ type: 'cart_status_change', cartId: this.cartId });
    source.onended = () => {
      this.status = 'ended';
      this.onEvent({ type: 'cart_status_change', cartId: this.cartId });
    };
  }

  stop(): void {
    this.sourceNode?.stop();
    this.sourceNode = null;
    this.status = 'idle';
    this.onEvent({ type: 'cart_status_change', cartId: this.cartId });
  }

  toggle(): void {
    if (this.status === 'playing') this.stop();
    else this.play();
  }
}

// ============================================================
// MAIN ENGINE
// ============================================================

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private deckA: Deck | null = null;
  private deckB: Deck | null = null;
  private cartPlayers: Map<string, CartPlayer> = new Map();
  private listeners: Set<EngineListener> = new Set();

  private onDeckEvent = (event: EngineEvent): void => {
    this.listeners.forEach(l => l(event));
  };

  /** Must be called from a user gesture (click) */
  init(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.deckA = new Deck('A', this.ctx, this.onDeckEvent);
    this.deckB = new Deck('B', this.ctx, this.onDeckEvent);
  }

  on(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getDeck(id: DeckId): Deck {
    this.assertInit();
    return id === 'A' ? this.deckA! : this.deckB!;
  }

  getState(): { a: DeckState; b: DeckState } {
    return {
      a: this.deckA?.getState() ?? emptyDeckState('A'),
      b: this.deckB?.getState() ?? emptyDeckState('B'),
    };
  }

  /** Load to next available deck (whichever isn't playing) */
  async loadNext(
    filePath: string,
    title: string,
    artist: string,
    introMs = 0,
    outroMs = 0,
  ): Promise<DeckId> {
    this.assertInit();
    const targetDeck =
      this.deckA!.status !== 'playing' ? this.deckA! : this.deckB!;
    await targetDeck.load(filePath, title, artist, introMs, outroMs);
    return targetDeck.id;
  }

  /** Crossfade A→B or B→A */
  crossfade(outDeck: DeckId, inDeck: DeckId, durationMs = 2000): void {
    this.assertInit();
    const out = this.getDeck(outDeck);
    const inn = this.getDeck(inDeck);
    inn.play();
    out.fadeTo(0, durationMs / 1000);
    setTimeout(() => out.stop(), durationMs + 50);
  }

  // CART WALL

  async loadCart(cartId: string, filePath: string): Promise<void> {
    this.assertInit();
    const player = new CartPlayer(cartId, this.ctx!, this.onDeckEvent);
    await player.load(filePath);
    this.cartPlayers.set(cartId, player);
  }

  fireCart(cartId: string, mode: 'instant' | 'toggle' | 'loop'): void {
    const player = this.cartPlayers.get(cartId);
    if (!player) return;
    if (mode === 'toggle') player.toggle();
    else player.play();
  }

  stopCart(cartId: string): void {
    this.cartPlayers.get(cartId)?.stop();
  }

  stopAllCarts(): void {
    this.cartPlayers.forEach(p => p.stop());
  }

  private assertInit(): void {
    if (!this.ctx) throw new Error('AudioEngine not initialized. Call init() first.');
  }
}

function emptyDeckState(id: DeckId): DeckState {
  return {
    id, status: 'idle', filePath: null, title: '', artist: '',
    durationMs: 0, positionMs: 0, introMs: 0, outroMs: 0,
    volume: 1, isCued: false, error: null,
  };
}

/** Singleton for use throughout the app */
export const engine = new AudioEngine();
