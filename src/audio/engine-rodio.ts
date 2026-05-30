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
  // Dedicated cart channel (native slot "CART") — fires out of master, over the music.
  // Tracked only for the cart UI's countdown/VU; never participates in queue advance.
  private stateCart: DeckState = makeState("C", {});

  private pollTimer: any = null;
  private lastPollTime = Date.now();
  private lastFiredState: { A?: DeckState; B?: DeckState; C?: DeckState } = {};

  private queue: { filePath: string; title: string; artist: string; gainDb?: number; chainType?: "segue" | "stop"; durationMs?: number; qid?: string }[] = [];
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

  // Item 10 Phase 2 Step 2 — when ETHER_AUDIO_DAEMON is on, the out-of-process daemon owns the
  // queue + advance, so the renderer must NOT advance locally (it would race the daemon). This
  // is queried once at init; while still unknown it stays false (safe: the poll only reads
  // forwarded deck state for display, it does not start playback). Deck control + manual loads
  // still route to the daemon via the audio:* IPC forwarders (Step 1) — only the auto-advance
  // brain is disabled here. The engine mirrors the daemon's queue + relays playstart so the
  // Up Next UI and the now-playing/log path (App.tsx onPlayStart) keep working.
  private daemonDriven = false;
  private daemonUnsub: Array<() => void> = [];
  private daemonDetectStarted = false;
  private daemonQueuePollN = 0; // low-frequency Up-Next resync counter (daemon mode)
  // Resolves once the daemon-vs-local decision is known (main confirms the daemon connected, or
  // falls back to the in-process engine). Go-on-air awaits this so it can't race the decision
  // and accidentally start the local engine while the daemon is also taking over.
  private daemonReady!: Promise<void>;
  private resolveDaemonReady: () => void = () => {};

  init() {
    if (this.pollTimer) return;
    this.processingEnd = false;  // clear any flag left over from a previous session
    this.pollTimer = setInterval(() => this.poll(), 250);
    this.detectDaemon();
  }

  /** Resolves when the daemon-vs-in-process decision is settled. */
  awaitDaemonReady(): Promise<void> { return this.daemonReady || Promise.resolve(); }

  private detectDaemon() {
    if (this.daemonDetectStarted) return;
    this.daemonDetectStarted = true;
    this.daemonReady = new Promise<void>((r) => { this.resolveDaemonReady = r; });
    const a = (window as any).ether?.audio;
    if (!a?.daemonEnabled) { this.resolveDaemonReady(); return; }
    a.daemonEnabled().then((on: boolean) => {
      this.daemonDriven = !!on;
      if (on) { rotLog("[ROT] daemon-driven: local advance DISABLED, mirroring ether-audiod"); this.attachDaemonEvents(); }
      else rotLog("[ROT] in-process engine (daemon not active — fallback or disabled)");
    }).catch(() => {}).finally(() => this.resolveDaemonReady());
  }

  private attachDaemonEvents() {
    const a = (window as any).ether?.audio;
    if (!a) return;
    // Mirror the daemon's queue so getQueue() (the Up Next UI) stays current. Stage 0: carry the
    // daemon's per-entry qid so the mirror can address an exact entry (Stage 2 intent commands).
    if (a.onQueue) {
      const h = a.onQueue((m: any) => {
        if (Array.isArray(m?.items)) this.queue = m.items.map((it: any) => ({
          filePath: it.filePath, title: it.title, artist: it.artist || "", durationMs: it.durationMs, chainType: it.chainType, qid: it.qid,
        }));
      });
      this.daemonUnsub.push(() => a.offQueue?.(h));
    }
    // Stage 0: the daemon is the authority for A/B/C deck state. Mirror its `deck` events
    // (status/title/duration + cued/deckReady) into stateA/B/C, instead of deriving deck status
    // from our own native poll. poll() now only ticks positionSec for a smooth countdown.
    if (a.onDeck) {
      const h = a.onDeck((m: any) => {
        const id = m?.deck as DeckId;
        if (id !== "A" && id !== "B" && id !== "C") return;
        const st = makeState(id, m.state || {});
        if (id === "A") this.stateA = st; else if (id === "B") this.stateB = st; else this.stateC = st;
        if (m.ready) this.deckReady.add(id); else this.deckReady.delete(id);
        this.lastFiredState[id] = st;   // keep poll()'s change-detector aligned so it doesn't double-fire
        this.listeners.forEach(l => l(id, st));
      });
      this.daemonUnsub.push(() => a.offDeck?.(h));
    }
    // The daemon advances + starts tracks; relay its playstart so the renderer's now-playing
    // push + play log (App.tsx onPlayStart) keep firing without the renderer driving playback.
    if (a.onPlayStart) {
      const h = a.onPlayStart((m: any) => { if (m?.deck) this.notifyPlayStart(m.deck as DeckId, m.title || "", m.artist || "", m.filePath || ""); });
      this.daemonUnsub.push(() => a.offPlayStart?.(h));
    }
    // The daemon only pushes queue events on *change*. A freshly-attached renderer (first
    // launch, Ctrl+R reload, or daemon respawn) would otherwise show a stale/empty Up Next
    // until the next mutation. Pull the current queue once now; poll() keeps it converged.
    void this.resyncDaemonQueue();
  }

  /** One-shot fetch of the daemon's authoritative queue → mirror into this.queue + fire
   *  listeners so the Up Next UI is correct immediately, not just after the next change. */
  private async resyncDaemonQueue(): Promise<void> {
    const a = (window as any).ether?.audio;
    if (!a?.daemon) return;
    try {
      const r = await a.daemon("getQueue", { stationId: this.stationId });
      const items = Array.isArray(r?.result) ? r.result : (Array.isArray(r) ? r : null);
      if (!items) return;
      this.queue = items.map((it: any) => ({
        filePath: it.filePath, title: it.title, artist: it.artist || "", durationMs: it.durationMs, chainType: it.chainType, qid: it.qid,
      }));
      this.listeners.forEach(l => l("A", this.stateA)); // nudge subscribers (queue length changed)
    } catch { /* daemon not answering yet — the next onQueue event will populate it */ }
  }

  /** Kick off unattended playout in the daemon (fill + play + advance). The renderer's
   *  go-on-air calls this instead of starting playback locally when daemon-driven. */
  async startDaemonAutomation(): Promise<boolean> {
    if (!this.daemonDriven) return false;
    try { const r = await (window as any).ether?.audio?.daemon?.("automationStart", { stationId: this.stationId }); return !!(r && r.ok); }
    catch { return false; }
  }

  /** Stop the daemon's unattended playout (AUTO off, daemon-driven). */
  async stopDaemonAutomation(): Promise<void> {
    if (!this.daemonDriven) return;
    try { await (window as any).ether?.audio?.daemon?.("automationStop", { stationId: this.stationId }); } catch {}
  }

  /** Skip to the next track. Daemon-driven → force-advance in the daemon; else local preload. */
  async skip(): Promise<boolean> {
    if (this.daemonDriven) {
      try { const r = await (window as any).ether?.audio?.daemon?.("skip", { stationId: this.stationId }); return !!(r && r.ok); }
      catch { return false; }
    }
    this.triggerPreload();
    return true;
  }

  /** True when the out-of-process daemon owns playout (renderer is a display/control proxy). */
  get isDaemonDriven(): boolean { return this.daemonDriven; }

  private async poll() {
    try {
      // Daemon mode: queue events are change-only, so periodically reconcile Up Next with the
      // daemon's authoritative queue (~every 5s). Cheap safety net against any missed event
      // (daemon respawn without a renderer reload, dropped IPC, etc.).
      if (this.daemonDriven && (++this.daemonQueuePollN % 20 === 0)) void this.resyncDaemonQueue();

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

      // Stage 0: in daemon mode A/B/C status/title/duration are authoritative from onDeck events;
      // here we only advance positionSec locally for a smooth countdown between those events. The
      // in-process engine keeps reading the native deck state directly (unchanged).
      this.stateA = this.daemonDriven ? { ...this.stateA, positionSec: posA } : { ...makeState("A", s.deckA), durationSec: durA, positionSec: posA };
      this.stateB = this.daemonDriven ? { ...this.stateB, positionSec: posB } : { ...makeState("B", s.deckB), durationSec: durB, positionSec: posB };
      this.stateC = this.daemonDriven ? { ...this.stateC, positionSec: posC } : { ...makeState("C", s.deckC), durationSec: durC, positionSec: posC };

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

      // Dedicated cart channel — track position/duration for the cart UI only.
      // Deliberately NOT run through checkEndByPosition: a finished cart must never
      // advance the music queue. The cart UI polls getDeck("CART").getState() directly.
      if (s.deckCart) {
        const durCart = this.stateCart.durationSec;
        const posCart = (this.stateCart.status === "playing")
          ? Math.min(this.stateCart.positionSec + elapsed, durCart || 9999)
          : this.stateCart.positionSec;
        this.stateCart = { ...makeState("C", s.deckCart), durationSec: durCart, positionSec: posCart };
      }

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
    if (this.daemonDriven) return;  // daemon owns end-detection + advance
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
    if (this.daemonDriven) return;  // daemon owns preload
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
    if (this.daemonDriven) return;  // daemon self-refills via its own scheduler
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
    if (this.daemonDriven) return;  // daemon owns preload
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
    const isCart = id === "CART";
    const getState = () => isCart ? this.stateCart : deckId === "A" ? this.stateA : deckId === "B" ? this.stateB : this.stateC;
    return {
      getState,
      play: () => {
        if (isCart) this.stateCart = { ...this.stateCart, status: "playing" };
        else if (deckId === "A") this.stateA = { ...this.stateA, status: "playing" };
        else if (deckId === "B") this.stateB = { ...this.stateB, status: "playing" };
        else if (deckId === "C") this.stateC = { ...this.stateC, status: "playing" };
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
    if (id === "CART") { this.stateCart = { ...this.stateCart, ...newState }; }
    this.endTriggered.delete(id as DeckId);
    invoke("get_file_duration", { filePath }).then((dur: number) => {
      if (dur > 0) {
        if (id === "A") { this.stateA = { ...this.stateA, durationSec: dur }; this.listeners.forEach(l => l("A", this.stateA)); }
        if (id === "B") { this.stateB = { ...this.stateB, durationSec: dur }; this.listeners.forEach(l => l("B", this.stateB)); }
        if (id === "C") { this.stateC = { ...this.stateC, durationSec: dur }; this.listeners.forEach(l => l("C", this.stateC)); }
        if (id === "CART") { this.stateCart = { ...this.stateCart, durationSec: dur }; }
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
    if (this.daemonDriven) { (window as any).ether?.audio?.daemon?.("enqueue", { stationId: this.stationId, items: songs }); return; }
    rotLog(`[ROT] addToQueue +${songs.length} | before: [${this.queue.map(q => `"${q.title}"`).join(", ")}] | adding: [${songs.map(s => `"${s.title}"`).join(", ")}]`);
    this.queue.push(...songs);
    rotLog(`[ROT] addToQueue done | after: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
  }
  clearQueue() {
    if (this.daemonDriven) { (window as any).ether?.audio?.daemon?.("clearQueue", { stationId: this.stationId }); this.queue = []; return; }
    rotLog(`[ROT] clearQueue — dropping ${this.queue.length} items: [${this.queue.map(q => `"${q.title}"`).join(", ")}]`);
    this.queue = [];
  }
  getQueue() { return [...this.queue]; }
  /** Reorder/replace pending queue without touching decks or triggering any load. Safe to call while playing. */
  replaceQueue(songs: { filePath: string; title: string; artist: string; gainDb?: number; chainType?: "segue" | "stop"; durationMs?: number }[]) {
    if (this.daemonDriven) { (window as any).ether?.audio?.daemon?.("replaceQueue", { stationId: this.stationId, items: songs }); this.queue = [...songs]; return; }
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
    if (this.daemonDriven) return this.skip();  // daemon owns advance — force-advance there
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
// Commit 2 adds the AudioEngine registry (src/audio/engine-registry.ts)
// and AudioEngineProvider (src/audio/AudioEngineContext.tsx) alongside
// this singleton. Commits 3–5 progressively migrate consumers off the
// singleton using getEngine() or useAudioEngine(). Once the last
// consumer is migrated (planned for Commit 5), this singleton and this
// comment can be removed.
// Do not "fix" this hardcoded 1 independently — the migration is
// ordered and tracked.
export const engine = new AudioEngine(1);
