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
  contentClass?: string | null;   // MUSIC/SPOT/… — lets the UI flash a SPOT-holding deck (amber)
}

type Listener = (id: DeckId, state: DeckState) => void;

// Honest engine-state truth layer (Slice 1). Mirrors the backend contract's engine_state enum exactly.
export type EngineState = "live" | "stalled" | "off";

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
    contentClass: s.content_class ?? s.contentClass ?? null,
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

  private queue: { filePath: string; title: string; artist: string; gainDb?: number; chainType?: "segue" | "stop"; durationMs?: number; qid?: string; scheduledAt?: number }[] = [];
  // generated_schedule scheduled_at of the row currently on each deck — the exact single-source
  // identity the Calendar matches (no text/clock guessing). Lives here so native state
  // round-trips don't wipe it.
  private deckSched: Record<string, number | undefined> = {};
  // In-process only: the content class loaded on each deck (daemon mode carries it on the deck event).
  // poll() rebuilds deck state from the native engine (no class), so we overlay this at emit time.
  private deckContentClass: Record<string, string | null> = {};
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
  crossfadeDuration = 3;                 // manual X-key / AUTO-X crossfade (in-process path)
  segueOverlap = 3;                      // routine auto segue OVERLAP (seconds the next song starts early, 0 = off) — daemon-side, no fades
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
  // §3 gate state. `daemonEnabledObserved` is the daemon's OWN last answer — distinct from
  // `daemonDriven`, which is this engine's committed mode. They disagreeing IS the fault to catch.
  private daemonEnabledObserved: boolean | null = null;
  private daemonDetectPollN = 0;      // low-frequency re-ask counter (only runs while not daemon-driven)
  private contradictionWarned = false;
  private localAdvanceSince = Date.now();
  private daemonQueuePollN = 0; // low-frequency Up-Next resync counter (daemon mode)
  // Honest engine-state truth layer (Slice 1): the daemon's live | stalled | off, mirrored from its
  // `enginestate` events (+ a one-shot resync pull on attach). In daemon mode this cached value is the
  // authoritative answer engineState() returns; in-process mode derives it live. Seeds "off".
  private _daemonEngineState: EngineState = "off";
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

  /**
   * Release everything init() started: the 250 ms poll and every daemon IPC listener.
   *
   * Without this there was no teardown at all — no clearInterval anywhere — so once the
   * HOP 4 fix started initialising each station's engine, visiting N stations left N poll
   * timers running for the session. In the in-process fallback that is worse than untidy:
   * every initialised engine runs end-detection against the single global native engine,
   * so two of them detect the same track end and both advance.
   *
   * Safe to call repeatedly, and safe to call before init(). After stop(), a later init()
   * re-attaches cleanly — daemonDetectStarted is reset so detectDaemon() runs again.
   * Deliberately does NOT touch deck state, the queue, or anything the daemon owns: this
   * stops the renderer's mirror, never playout.
   */
  stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const off of this.daemonUnsub) { try { off(); } catch { /* listener already gone */ } }
    this.daemonUnsub = [];
    // Allow a future init() to re-run detection and re-subscribe.
    this.daemonDetectStarted = false;
  }

  /** True while any music deck is playing — used to decide whether stopping is safe. */
  hasPlayingDeck(): boolean {
    return this.stateA.status === "playing"
        || this.stateB.status === "playing"
        || this.stateC.status === "playing";
  }

  /** Resolves when the daemon-vs-in-process decision is settled. */
  awaitDaemonReady(): Promise<void> { return this.daemonReady || Promise.resolve(); }

  // ── DAEMON-MODE GATE (§3 of docs/design-renderer-as-pure-view-2026-07-30.md) ────────────────────
  // The decision used to be ONE-SHOT: whatever daemonEnabled() answered at init was final, forever, with
  // no retry. If it answered false because the socket wasn't up yet (the known cold-stage race), this
  // engine ran its OWN advance chain for the life of the station — issuing loads and plays into the very
  // Rust engine the daemon was driving. That is what put two brains on station 4 on 2026-07-30 (46.0s and
  // 50.6s of double air; the loads are visible as source='operator' rows 1.24s apart, the renderer's
  // post-rotate preload signature).
  //
  // The rule now: TRUE LATCHES, FALSE NEVER DOES. "Not yet" is not "no".
  private detectDaemon() {
    if (this.daemonDetectStarted) return;
    this.daemonDetectStarted = true;
    this.daemonReady = new Promise<void>((r) => { this.resolveDaemonReady = r; });
    const a = (window as any).ether?.audio;
    if (!a?.daemonEnabled) { this.resolveDaemonReady(); return; }
    a.daemonEnabled().then((on: boolean) => {
      this.daemonEnabledObserved = !!on;
      if (on) { this.daemonDriven = true; rotLog("[ROT] daemon-driven: local advance DISABLED, mirroring ether-audiod"); this.attachDaemonEvents(); }
      // NOT latched false — poll() keeps asking until the daemon answers yes (recheckDaemon below).
      else rotLog("[ROT] in-process engine (daemon not active — fallback or disabled); will re-check every 5s");
    }).catch(() => {}).finally(() => this.resolveDaemonReady());
  }

  /** Re-ask while we are NOT daemon-driven. Only a `true` is acted on; a `false` just means "ask again",
   *  so a daemon that comes up late is adopted instead of being missed for the life of the engine. */
  private async recheckDaemon(): Promise<void> {
    if (this.daemonDriven) return;
    const a = (window as any).ether?.audio;
    if (!a?.daemonEnabled) return;
    let on = false;
    try { on = !!(await a.daemonEnabled()); } catch { return; }
    this.daemonEnabledObserved = on;
    if (!on) return;                      // still absent — try again next cycle. NEVER latch false.
    rotLog(`[ROT] daemon LATE-DETECTED after ${((Date.now() - this.localAdvanceSince) / 1000).toFixed(0)}s of in-process advance — local advance DISABLED, attaching`);
    console.warn(`[ENGINE] station ${this.stationId}: daemon became available after init — switching to daemon-driven. Local advance had been active; if any deck was started locally the daemon's liveDeck guard will clear it.`);
    this.daemonDriven = true;
    this.attachDaemonEvents();
  }

  /** THE SINGLE CHOKE POINT (§3.2). One decision gates every autonomous path — end-detection, and
   *  therefore handleRotate → preloadDeck / refillIfNeeded, which are only ever reached through it.
   *  The six existing per-call-site `if (this.daemonDriven) return;` guards stay as belt-and-braces;
   *  this is what makes them unreachable rather than merely correct.
   *
   *  CONTRADICTION ASSERTION: if the daemon reports ENABLED while this engine still thinks it is
   *  in-process, running the local advance would be the two-brains fault by definition. Refuse, loudly,
   *  once — and keep refusing silently until recheckDaemon() resolves it. */
  private localAdvanceAllowed(): boolean {
    if (this.daemonDriven) return false;
    if (this.daemonEnabledObserved === true) {
      if (!this.contradictionWarned) {
        this.contradictionWarned = true;
        const msg = `[ROT] CONTRADICTION — daemon reports ENABLED but this engine (station ${this.stationId}) is not daemon-driven. REFUSING local advance (this is the two-brains fault).`;
        rotLog(msg);
        console.error("[ENGINE] " + msg);
      }
      return false;
    }
    return true;
  }

  private attachDaemonEvents() {
    const a = (window as any).ether?.audio;
    if (!a) return;
    // Re-push the routine segue overlap — the daemon resets to its default on respawn, so a
    // (re)connect (incl. the update/crash respawn) must restore the operator's setting.
    this.pushSegueOverlap();
    // Mirror the daemon's queue so getQueue() (the Up Next UI) stays current. Stage 0: carry the
    // daemon's per-entry qid so the mirror can address an exact entry (Stage 2 intent commands).
    if (a.onQueue) {
      const h = a.onQueue((m: any) => {
        if (m && m.stationId != null && m.stationId !== this.stationId) return; // only THIS station's queue — never another station's
        if (Array.isArray(m?.items)) {
          this.queue = m.items.map((it: any) => ({
            filePath: it.filePath, title: it.title, artist: it.artist || "", durationMs: it.durationMs, chainType: it.chainType, qid: it.qid,
          }));
          // Stage 2a: engine-rodio is the SOLE consumer of the raw daemon queue event; it re-emits
          // the app-standard `ether:queue-changed` signal so Up Next (and any queue UI) re-renders
          // within ~50ms of a daemon change, without the renderer pushing its mirror back.
          try { window.dispatchEvent(new CustomEvent("ether:queue-changed")); } catch {}
        }
      });
      this.daemonUnsub.push(() => a.offQueue?.(h));
    }
    // Stage 0: the daemon is the authority for A/B/C deck state. Mirror its `deck` events
    // (status/title/duration + cued/deckReady) into stateA/B/C, instead of deriving deck status
    // from our own native poll. poll() now only ticks positionSec for a smooth countdown.
    if (a.onDeck) {
      const h = a.onDeck((m: any) => {
        if (m && m.stationId != null && m.stationId !== this.stationId) return; // only THIS station's decks — OV's on-air deck must not bleed into another station's view
        const id = m?.deck as DeckId;
        if (id !== "A" && id !== "B" && id !== "C") return;
        const st = makeState(id, m.state || {});
        // Daemon is authoritative for the schedule-row identity too — absorb it so getDeckSched()
        // (and the Calendar) match the exact row in daemon mode, same as in-process.
        this.deckSched[String(id)] = typeof m.state?.scheduledAt === "number" ? m.state.scheduledAt : undefined;
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
      const h = a.onPlayStart((m: any) => { if (m && m.stationId != null && m.stationId !== this.stationId) return; if (m?.deck) this.notifyPlayStart(m.deck as DeckId, m.title || "", m.artist || "", m.filePath || ""); });
      this.daemonUnsub.push(() => a.offPlayStart?.(h));
    }
    // Honest engine-state truth layer (Slice 1): mirror the daemon's live|stalled|off so the now-
    // playing payload + keepalive report the real state. Only THIS station's events.
    if (a.onEngineState) {
      const h = a.onEngineState((m: any) => {
        if (m && m.stationId != null && m.stationId !== this.stationId) return;
        if (m?.state === "live" || m?.state === "stalled" || m?.state === "off") this._daemonEngineState = m.state;
      });
      this.daemonUnsub.push(() => a.offEngineState?.(h));
    }
    // The daemon only pushes queue/enginestate on *change*. A freshly-attached renderer (first
    // launch, Ctrl+R reload, or daemon respawn) would otherwise show a stale/empty Up Next and the
    // "off" engine-state seed until the next mutation. Pull both once now; poll()/events converge.
    void this.resyncDaemonQueue();
    void this.resyncDaemonEngineState();
    void this.resyncDaemonDecks();
  }

  /** One-shot pull of the daemon's authoritative per-deck fader volume on (re)attach, so a stale value
   *  left in renderer state by a prior session / in-process fallback can never persist on screen (the
   *  honest-UI rule: the fader shows the engine's observed volume, not a remembered position). Only the
   *  volume is merged — status/title/position stay owned by the onDeck event stream. */
  private async resyncDaemonDecks(): Promise<void> {
    const a = (window as any).ether?.audio;
    if (!a?.daemon) return;
    try {
      const r = await a.daemon("getState", { stationId: this.stationId });
      const s = (r && typeof r === "object" && "result" in r) ? (r as any).result : r;
      if (!s) return;
      (["A", "B", "C"] as DeckId[]).forEach(id => {
        const ds = id === "A" ? s.deckA : id === "B" ? s.deckB : s.deckC;
        if (!ds) return;
        // Volume ONLY — defaults to unity when the daemon omits it.
        //
        // REVERTED 2026-07-30 (was 4.4.104 / commit 29640ef): this merge also re-anchored
        // positionSec and durationSec here, to bound countdown drift. It could never work.
        // `getState` is the daemon's RAW RUST state (audiod/ether-audiod.js:112 →
        // A.audioGetState), and Rust's per-deck payload — DeckMeta::info, native/src/audio.rs:82
        // — carries { id, status, title, artist, file_path, volume, is_finished } and NO
        // position_sec / duration_sec at all. So makeState() below yields positionSec === 0 on
        // every single call. The position write was unguarded (`typeof 0 === "number"` passes,
        // unlike the duration write's `> 0` test), so every resync slammed the countdown to 0:00
        // and poll() spent the next seconds climbing back — an oscillation for the whole song,
        // on every daemon-driven station. See docs/countdown-oscillation-regression-2026-07-30.md.
        //
        // Position and duration belong to the onDeck event stream, which the daemon maintains by
        // wall-clock accumulation (audiod/engine.js:288-296) and delivers atomically. Nothing here
        // has a correct source for them. Do not re-add a re-anchor without one — that needs a new
        // daemon command exposing the ENGINE's tracked deck state, not audio_get_state.
        const vol = makeState(id, ds).volume;
        if (id === "A") this.stateA = { ...this.stateA, volume: vol };
        else if (id === "B") this.stateB = { ...this.stateB, volume: vol };
        else this.stateC = { ...this.stateC, volume: vol };
        const st = id === "A" ? this.stateA : id === "B" ? this.stateB : this.stateC;
        this.listeners.forEach(l => l(id, st));
      });
    } catch { /* daemon not answering yet — the next deck event resyncs it */ }
  }

  /** One-shot pull of the daemon's current engine state (live|stalled|off) so a freshly-attached
   *  renderer reports the real state immediately, not the "off" seed, until the next change event. */
  private async resyncDaemonEngineState(): Promise<void> {
    const a = (window as any).ether?.audio;
    if (!a?.daemon) return;
    try {
      const r = await a.daemon("getEngineState", { stationId: this.stationId });
      const s = (r && typeof r === "object" && "result" in r) ? (r as any).result : r;
      if (s === "live" || s === "stalled" || s === "off") this._daemonEngineState = s;
    } catch { /* daemon not answering yet — the next enginestate event will set it */ }
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
        filePath: it.filePath, title: it.title, artist: it.artist || "", durationMs: it.durationMs, chainType: it.chainType, qid: it.qid, contentClass: it.contentClass, scheduledAt: it.scheduledAt,
      }));
      this.listeners.forEach(l => l("A", this.stateA)); // nudge subscribers (queue length changed)
    } catch { /* daemon not answering yet — the next onQueue event will populate it */ }
  }

  /** Kick off unattended playout in the daemon (fill + play + advance). The renderer's
   *  go-on-air calls this instead of starting playback locally when daemon-driven. */
  async startDaemonAutomation(): Promise<boolean> {
    if (!this.daemonDriven) return false;
    this.pushSegueOverlap();   // ensure the daemon has the operator's segue setting before it airs
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

  /** §3.4 — the playout mode this engine is actually in, for the Health Monitor. Honest by construction:
   *  `mode` is what this engine committed to, `daemonEnabled` is the daemon's own last answer, and
   *  `contradiction` is true when they disagree — a station running its own advance while the daemon is
   *  up. That is a FAULT, and it must be visible rather than inferred from log forensics days later. */
  getPlayoutMode(): { stationId: number; mode: "daemon" | "in-process"; daemonEnabled: boolean | null; contradiction: boolean; localAdvanceSec: number } {
    return {
      stationId: this.stationId,
      mode: this.daemonDriven ? "daemon" : "in-process",
      daemonEnabled: this.daemonEnabledObserved,
      contradiction: !this.daemonDriven && this.daemonEnabledObserved === true,
      localAdvanceSec: this.daemonDriven ? 0 : Math.round((Date.now() - this.localAdvanceSince) / 1000),
    };
  }

  /** Honest engine state for reporting: live | stalled | off (Slice 1). Daemon-driven → the daemon's
   *  authoritative value (mirrored via enginestate). In-process → derived locally from the SAME honest
   *  criterion: live iff a deck is actually playing; off iff automation disengaged; otherwise stalled.
   *  NEVER returns "live" for a silent/stalled engine — that invariant is the whole point of the slice. */
  engineState(): EngineState {
    if (this.daemonDriven) return this._daemonEngineState;
    const playing = this.stateA.status === "playing" || this.stateB.status === "playing" || this.stateC.status === "playing";
    if (playing) return "live";
    if (!this._autoAdvance) return "off";
    return "stalled";
  }

  // ── Stage 1: typed wrappers for the daemon's explicit-intent commands (queue:* / deck:*). Added
  // so Stage 2 is a wiring change, not new logic — NOTHING in the UI calls these yet. Each forwards
  // to the daemon via the generic bridge and resolves with the daemon's ack ({ ok, result }).
  private daemonCmd(cmd: string, args: Record<string, any>): Promise<any> {
    return (window as any).ether?.audio?.daemon?.(cmd, { stationId: this.stationId, ...args });
  }
  queueEnqueue(items: any[]): Promise<any> { return this.daemonCmd("queue:enqueue", { items }); }
  queueRemove(qid: string): Promise<any> { return this.daemonCmd("queue:remove", { qid }); }
  queueReorder(qid: string, toIndex: number): Promise<any> { return this.daemonCmd("queue:reorder", { qid, toIndex }); }
  queueMove(qid: string, where: "top" | "bottom"): Promise<any> { return this.daemonCmd("queue:move", { qid, where }); }
  queueClearPending(): Promise<any> { return this.daemonCmd("queue:clear", {}); }
  deckCue(deck: DeckId, songRef: { filePath: string; title: string; artist: string; gainDb?: number; durationMs?: number; chainType?: "segue" | "stop" }): Promise<any> { return this.daemonCmd("deck:cue", { deck, songRef }); }
  deckCrossfade(from?: DeckId, to?: DeckId): Promise<any> { return this.daemonCmd("deck:crossfade", { from, to }); }
  // Routine segue overlap (auto). Stored locally + pushed to the daemon (the daemon resets to its
  // default on respawn, so this is re-pushed on every daemon (re)connect + automation start).
  setSegueOverlap(seconds: number): Promise<any> | void {
    this.segueOverlap = Math.max(0, Math.min(10, seconds || 0));
    if (this.daemonDriven) return this.daemonCmd("setSegueOverlap", { seconds: this.segueOverlap });
  }
  private pushSegueOverlap(): void {
    if (this.daemonDriven) { try { this.daemonCmd("setSegueOverlap", { seconds: this.segueOverlap }); } catch {} }
  }

  private async poll() {
    try {
      // Daemon mode: queue events are change-only, so periodically reconcile Up Next with the
      // daemon's authoritative queue (~every 5s). Cheap safety net against any missed event
      // (daemon respawn without a renderer reload, dropped IPC, etc.).
      if (this.daemonDriven && (++this.daemonQueuePollN % 20 === 0)) void this.resyncDaemonQueue();
      // §3.1 — while NOT daemon-driven, keep asking whether the daemon has come up (~5s). A daemon that
      // starts late must be adopted; the old one-shot detect missed it for the life of the engine.
      if (!this.daemonDriven && (++this.daemonDetectPollN % 20 === 5)) void this.recheckDaemon();
      // NOTE: there is deliberately NO periodic resyncDaemonDecks() here. 4.4.104 added one on this
      // same 5 s cadence to re-anchor deck position; it wrote 0 every time (see the method) and was
      // reverted 2026-07-30. resyncDaemonDecks is volume-only and one-shot on attach, as before.

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
      this.stateA = this.daemonDriven ? { ...this.stateA, positionSec: posA } : { ...makeState("A", s.deckA), durationSec: durA, positionSec: posA, contentClass: this.deckContentClass["A"] ?? null };
      this.stateB = this.daemonDriven ? { ...this.stateB, positionSec: posB } : { ...makeState("B", s.deckB), durationSec: durB, positionSec: posB, contentClass: this.deckContentClass["B"] ?? null };
      this.stateC = this.daemonDriven ? { ...this.stateC, positionSec: posC } : { ...makeState("C", s.deckC), durationSec: durC, positionSec: posC, contentClass: this.deckContentClass["C"] ?? null };

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

      // §3.2 SINGLE CHOKE POINT — one decision, not six call-site guards. End-detection is the ONLY
      // entry to the autonomous chain (handleRotate → preloadDeck / refillIfNeeded are reached solely
      // through it), so gating here makes the whole chain unreachable in daemon mode rather than merely
      // guarded inside. localAdvanceAllowed() also refuses when the daemon says ENABLED while we are not
      // daemon-driven — the two-brains contradiction.
      if (this.localAdvanceAllowed()) {
        this.checkEndByPosition("A", posA, durA, prevA, rustEndedA);
        this.checkEndByPosition("B", posB, durB, prevB, rustEndedB);
        this.checkEndByPosition("C", posC, durC, prevC, rustEndedC);
      }
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
        await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb, next.durationMs, next.scheduledAt, (next as any).contentClass);
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
      await this.loadToDeck(deckId, next.filePath, next.title, next.artist, next.gainDb, next.durationMs, next.scheduledAt, (next as any).contentClass);
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

  async loadToDeck(id: DeckId | string, filePath: string, title: string, artist: string, gainDb?: number, durationMs?: number, scheduledAt?: number, contentClass?: string | null) {
    rotLog(`[ROT] loadToDeck ${id}: "${title}" | decks: A="${this.stateA.title}"(${this.stateA.status}) B="${this.stateB.title}"(${this.stateB.status}) C="${this.stateC.title}"(${this.stateC.status})`);
    this.init();
    this.deckSched[String(id)] = scheduledAt;   // remember this deck's schedule-row identity
    this.deckContentClass[String(id)] = contentClass ?? null;   // for the SPOT-deck flash (in-process path)
    await invoke("audio_load", { deck: id, filePath, title, artist, gainDb: gainDb ?? 0, stationId: this.stationId });
    const newState = { title, artist, filePath, positionSec: 0, durationSec: (durationMs ?? 0) / 1000, status: "idle" as DeckStatus, volume: 1, peaks: [], contentClass: contentClass ?? null };
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

  addToQueue(songs: { filePath: string; title: string; artist: string; gainDb?: number; chainType?: "segue" | "stop"; durationMs?: number; scheduledAt?: number }[]) {
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
  /** The generated_schedule scheduled_at of the row currently loaded on a deck (exact, not text-matched). */
  getDeckSched(id: DeckId | string): number | undefined { return this.deckSched[String(id)]; }
  /** Drop any queued item that is NOT a generated_schedule row (no scheduledAt). Called after a
   *  schedule fill so a live-picked / crash-restored pollutant can never sit in a schedule-driven
   *  queue — the queue can then only ever contain rows the Calendar also shows. */
  purgeUnscheduled() {
    if (this.daemonDriven) return;   // daemon purges its own queue in its fill cycle
    const before = this.queue.length;
    this.queue = this.queue.filter(q => typeof q.scheduledAt === "number");
    if (this.queue.length !== before) rotLog(`[ROT] purgeUnscheduled — dropped ${before - this.queue.length} non-scheduled item(s)`);
  }
  /** Reorder/replace pending queue without touching decks or triggering any load. Safe to call while playing. */
  replaceQueue(songs: { filePath: string; title: string; artist: string; gainDb?: number; chainType?: "segue" | "stop"; durationMs?: number }[]) {
    // Stage 2b: the renderer may NO LONGER push its whole queue mirror to the daemon — that echo was
    // the "clobber" that re-introduced played/duplicate songs and raced rotation (Bugs 1 & 3). The
    // daemon is the single source of truth; every daemon-mode queue edit now goes through the
    // id-addressed intents (queue:reorder/remove/move/enqueue/clear). This is a guarded no-op; the
    // warning flags any stray caller so it can be migrated. (In-process keeps the local replace.)
    if (this.daemonDriven) {
      console.warn("[ENGINE] replaceQueue ignored in daemon mode — use queue:* intent commands (Stage 2b)");
      return;
    }
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
      await this.loadToDeck("A", next.filePath, next.title, next.artist, next.gainDb, next.durationMs, next.scheduledAt);
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
