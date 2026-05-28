// audiod/engine.js — daemon-side playout engine (Item 10, Phase 1 step 3).
//
// Faithful port of src/audio/engine-rodio.ts's queue + A→B→C rotation + preload +
// end-detection, adapted for the daemon: addon calls are SYNCHRONOUS (no IPC promise),
// and the renderer's `listeners` become `emit(event, payload)` broadcasts over the pipe.
// Refill is the node:sqlite-backed scheduler in loggen.js — so the daemon keeps its own
// queue full and advances unattended, with no renderer.
//
// SCOPE (additive — the live app still owns playout until the Phase-2 cutover):
//   • Owns: queue, advance/rotate/preload, end-detection, on-format refill (read-only DB).
//   • Emits: `deck` (state change), `queue` (queue change), `playstart` (deck went live).
//   • Does NOT write the DB: play-logging stays in the app to avoid double-logging while
//     both run. At cutover the daemon takes over logging (it already emits `playstart`).
//   • Cart channel + crossfade/EQ live in the addon and are unchanged.

const path = require("path");
const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));
const loggen = require("./loggen");

function makeState(id, s = {}) {
  return {
    id, status: s.status || "idle", title: s.title || "", artist: s.artist || "",
    filePath: s.file_path || s.filePath || "",
    positionSec: s.position_sec || s.positionSec || 0,
    durationSec: s.duration_sec || s.durationSec || 0,
    volume: s.volume ?? 1,
  };
}

class DaemonEngine {
  // db: node:sqlite DatabaseSync (read-only) for loggen.  emit(event, payload): pipe broadcast.
  constructor(stationId, db, emit) {
    this.stationId = stationId;
    this.db = db;
    this.emit = emit;
    this.queue = [];
    this.stateA = makeState("A"); this.stateB = makeState("B"); this.stateC = makeState("C");
    this.lastFired = {};
    this.deckChainType = { A: "segue", B: "segue", C: "segue" };
    this.deckReady = new Set();
    this.endTriggered = new Set();
    this.processingEnd = false;
    this.autoAdvance = true;     // automation engine = always auto-advancing
    this.continuous = true;      // refill from the scheduler when the queue empties
    this.shuffle = false;
    this.crossfadeDuration = 3;
    this.advanceP = Promise.resolve();
    this.pollTimer = null;
    this.lastPollTime = Date.now();
  }

  // ── addon wrappers (synchronous) ──
  _load(deck, fp, title, artist, gainDb) { return A.audioLoad(deck, fp, title || "", artist || "", gainDb ?? 0, this.stationId); }
  _play(deck) { return A.audioPlay(deck, this.stationId); }
  _stop(deck) { try { return A.audioStop(deck, this.stationId); } catch {} }
  _state() { try { return JSON.parse(A.audioGetState(this.stationId)); } catch { return null; } }
  _dur(fp) { try { return A.getFileDuration(fp); } catch { return 0; } }

  // ── lifecycle ──
  init() {
    A.initAudioEngine(this.stationId);
    if (!this.pollTimer) { this.processingEnd = false; this.pollTimer = setInterval(() => this.poll(), 250); }
  }
  stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this._stop("A"); this._stop("B"); this._stop("C");
  }

  _deckState(id) { return id === "A" ? this.stateA : id === "B" ? this.stateB : this.stateC; }
  _setDeck(id, patch) {
    if (id === "A") this.stateA = { ...this.stateA, ...patch };
    else if (id === "B") this.stateB = { ...this.stateB, ...patch };
    else if (id === "C") this.stateC = { ...this.stateC, ...patch };
  }

  // ── poll (mirrors engine-rodio poll + checkEndByPosition) ──
  poll() {
    const s = this._state();
    if (!s) return;
    const now = Date.now();
    const elapsed = (now - this.lastPollTime) / 1000;
    this.lastPollTime = now;

    const prev = { A: this.stateA.status, B: this.stateB.status, C: this.stateC.status };
    const dur = { A: this.stateA.durationSec, B: this.stateB.durationSec, C: this.stateC.durationSec };
    const pos = {
      A: this.stateA.status === "playing" ? Math.min(this.stateA.positionSec + elapsed, dur.A || 9999) : this.stateA.positionSec,
      B: this.stateB.status === "playing" ? Math.min(this.stateB.positionSec + elapsed, dur.B || 9999) : this.stateB.positionSec,
      C: this.stateC.status === "playing" ? Math.min(this.stateC.positionSec + elapsed, dur.C || 9999) : this.stateC.positionSec,
    };
    this.stateA = { ...makeState("A", s.deckA), durationSec: dur.A, positionSec: pos.A };
    this.stateB = { ...makeState("B", s.deckB), durationSec: dur.B, positionSec: pos.B };
    this.stateC = { ...makeState("C", s.deckC), durationSec: dur.C, positionSec: pos.C };

    for (const id of ["A", "B", "C"]) this._maybeEmitDeck(id);

    const rustEnded = {
      A: s.deckA?.status === "ended" && prev.A === "playing",
      B: s.deckB?.status === "ended" && prev.B === "playing",
      C: s.deckC?.status === "ended" && prev.C === "playing",
    };
    this.checkEnd("A", pos.A, dur.A, prev.A, rustEnded.A);
    this.checkEnd("B", pos.B, dur.B, prev.B, rustEnded.B);
    this.checkEnd("C", pos.C, dur.C, prev.C, rustEnded.C);
    this.processingEnd = false;
  }

  _changed(prev, next) {
    if (!prev) return true;
    return prev.status !== next.status || prev.filePath !== next.filePath || prev.title !== next.title ||
      Math.floor(prev.positionSec) !== Math.floor(next.positionSec) || prev.durationSec !== next.durationSec;
  }
  _maybeEmitDeck(id) {
    const st = this._deckState(id);
    if (this._changed(this.lastFired[id], st)) this.emit("deck", { stationId: this.stationId, deck: id, state: st });
    this.lastFired[id] = st;
  }

  checkEnd(deckId, pos, dur, prevStatus, backendEnded = false) {
    if (this.processingEnd) return;
    const positionEnd = prevStatus === "playing" && dur > 5 && pos > 0 && (dur - pos) < 0.3;
    const genuineBackendEnd = backendEnded && (dur <= 5 || (dur - pos) < 5);
    if ((positionEnd || genuineBackendEnd) && !this.endTriggered.has(deckId)) {
      this.processingEnd = true;
      this.endTriggered.add(deckId);

      if (this.deckChainType[deckId] === "stop") {
        this._setDeck(deckId, { status: "ended" });
        this.emit("chainstop", { stationId: this.stationId, deck: deckId });
        return;
      }
      this._setDeck(deckId, { status: "ended" });

      if (deckId === "A") {
        if (this.deckReady.has("B")) this.handleRotate("A", "B");
        else if (this.autoAdvance && this.stateB.status !== "playing" && this.stateC.status !== "playing") this.handleLoadNext("A");
      } else if (deckId === "B") {
        if (this.deckReady.has("C")) this.handleRotate("B", "C");
        else if (this.autoAdvance && this.stateA.status !== "playing" && this.stateC.status !== "playing") this.handleLoadNext("B");
      } else if (deckId === "C") {
        if (this.deckReady.has("A")) this.handleRotate("C", "A");
        else if ((this.autoAdvance || this.queue.length > 0) && this.stateA.status !== "playing" && this.stateB.status !== "playing") this.handleLoadNext("A");
      }
    }
  }

  handleRotate(fromId, toId) {
    this.advanceP = this.advanceP.then(async () => {
      try {
        const live = this._state();
        const liveTo = live ? (toId === "A" ? live.deckA : toId === "B" ? live.deckB : live.deckC) : null;
        const otherPlaying = live ? (
          (fromId !== "A" && live.deckA?.status === "playing") ||
          (fromId !== "B" && live.deckB?.status === "playing") ||
          (fromId !== "C" && live.deckC?.status === "playing")) : false;
        if (liveTo?.status === "playing" || otherPlaying) return; // spurious-end guard
        this._play(toId);
        const cfMs = this.crossfadeDuration * 1000;
        setTimeout(() => this._stop(fromId), cfMs + 500);
        this._setDeck(toId, { status: "playing", positionSec: 0 });
        this._fireStart(toId);
        this.deckReady.delete(toId); this.endTriggered.delete(toId);
        if (this.queue.length > 0) this.dequeue();
        const nearDelay = cfMs + 800;
        if (toId === "B") { setTimeout(() => this.preload("C", 0), 800); setTimeout(() => this.preload("A", 1), nearDelay); }
        else if (toId === "C") { setTimeout(() => this.preload("A", 0), 800); setTimeout(() => this.preload("B", 1), nearDelay); }
        else if (toId === "A") { setTimeout(async () => { await this.refillIfNeeded(); this.preload("B", 0); }, 800); setTimeout(() => this.preload("C", 1), nearDelay); }
      } catch (e) { this.emit("error", { stationId: this.stationId, where: "handleRotate", error: String(e) }); }
    });
  }

  handleLoadNext(deckId) {
    this.advanceP = this.advanceP.then(async () => {
      try {
        const live = this._state();
        if (live) { const ld = deckId === "A" ? live.deckA : deckId === "B" ? live.deckB : live.deckC; if (ld?.status === "playing") return; }
        await this.refillIfNeeded();
        if (this.queue.length === 0) return;
        const next = this.dequeue();
        this.deckChainType[deckId] = next.chainType || "segue";
        this.loadToDeck(deckId, next);
        this._play(deckId);
        this._setDeck(deckId, { status: "playing", positionSec: 0 });
        this.endTriggered.delete(deckId);
        this._fireStart(deckId);
      } catch (e) { this.emit("error", { stationId: this.stationId, where: "handleLoadNext", error: String(e) }); }
    });
  }

  async preload(deckId, queueIndex = 0) {
    if (this.queue.length <= queueIndex) return;
    const st = this._deckState(deckId);
    if (st.status === "playing" || st.status === "paused") return;
    const next = this.queue[queueIndex];
    try { this.deckChainType[deckId] = next.chainType || "segue"; this.loadToDeck(deckId, next); this.deckReady.add(deckId); }
    catch (e) { this.emit("error", { stationId: this.stationId, where: "preload", error: String(e) }); }
  }

  async refillIfNeeded() {
    if (this.queue.length === 0 && this.continuous) {
      const fill = loggen.fillQueue(this.db, this.stationId, 20);
      this.queue.push(...fill.items);
      this.emit("queue", { stationId: this.stationId, source: fill.source, items: this.queue });
    }
  }

  dequeue() {
    const idx = this.shuffle ? Math.floor(Math.random() * this.queue.length) : 0;
    const item = this.queue.splice(idx, 1)[0];
    this.emit("queue", { stationId: this.stationId, items: this.queue });
    return item;
  }

  loadToDeck(id, item) {
    this._load(id, item.filePath, item.title, item.artist, item.gainDb);
    this._setDeck(id, { title: item.title || "", artist: item.artist || "", filePath: item.filePath, positionSec: 0, durationSec: (item.durationMs ?? 0) / 1000, status: "idle", volume: 1 });
    this.endTriggered.delete(id);
    const d = this._dur(item.filePath);
    if (d > 0) this._setDeck(id, { durationSec: d });
    this._maybeEmitDeck(id);
  }

  _fireStart(deckId) {
    const st = this._deckState(deckId);
    this.emit("playstart", { stationId: this.stationId, deck: deckId, title: st.title, artist: st.artist, filePath: st.filePath });
  }

  // ── operator/queue API (called from daemon command handlers) ──
  addToQueue(items) { this.queue.push(...items); this.emit("queue", { stationId: this.stationId, items: this.queue }); }
  replaceQueue(items) { this.queue = [...items]; this.emit("queue", { stationId: this.stationId, items: this.queue }); }
  clearQueue() { this.queue = []; this.emit("queue", { stationId: this.stationId, items: this.queue }); }
  getQueue() { return [...this.queue]; }

  // Fill (if empty), load deck A, play, and preload B/C — the unattended start.
  async start() {
    this.init();
    await this.refillIfNeeded();
    if (this.queue.length === 0) return false;
    const first = this.dequeue();
    this.deckChainType.A = first.chainType || "segue";
    this.loadToDeck("A", first);
    this._play("A");
    this._setDeck("A", { status: "playing", positionSec: 0 });
    this._fireStart("A");
    setTimeout(async () => { await this.preload("B", 0); setTimeout(() => this.preload("C", 1), 400); }, 800);
    return true;
  }
}

module.exports = { DaemonEngine };
