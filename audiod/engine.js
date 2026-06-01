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
const fs = require("fs");
const crypto = require("crypto");
const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));
const loggen = require("./loggen");
const playlog = require("./playlog");

// One play-log session id per daemon process (mirrors the renderer's getSessionId()).
const SESSION = crypto.randomUUID();

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
    this.lastReady = {};   // Stage 0: track deckReady per deck so a ready-flip re-emits a deck event.
    this.deckChainType = { A: "segue", B: "segue", C: "segue" };
    this.deckReady = new Set();
    // Decks an operator hand-loaded via the A/B/C buttons. Marked ready so the self-heal won't
    // re-cue over them; flagged manual so the rotate path doesn't dequeue an unrelated song when
    // it crossfades into one (a manual cue didn't come from the queue).
    this.manualCue = new Set();
    // Stage 1: qids of queue entries that preload has loaded onto a standby deck (they stay IN the
    // queue until they rotate on air). queue:* intent commands treat these as protected — you change
    // what's on a deck via deck:* commands, never by editing the queue. Updated SYNCHRONOUSLY: added
    // in preload on a successful load, removed in dequeue() (the single point every advance/rotate
    // path funnels through), so there is no window where a qid is "unbound" before the next preload.
    this.boundQids = new Set();
    this.endTriggered = new Set();
    this.processingEnd = false;
    this.autoAdvance = true;     // automation engine = always auto-advancing
    this.continuous = true;      // refill from the scheduler when the queue empties
    this.shuffle = false;
    this.crossfadeDuration = 3;
    this.advanceP = Promise.resolve();
    // Stage 3b: stall-recovery watchdog state. The invariant it enforces: content present + nobody
    // playing ⇒ somebody playing within ~1s. Without this, an "all decks stopped" state had no
    // recovery path (the v4.3.6 self-heal only tops up idle decks WHILE one is playing) → dead air.
    this._lastPlayingAt = Date.now();   // last tick any deck was playing
    this._advanceStartedAt = 0;          // when the in-flight advance op began (0 = idle) — wedge detection
    this._watchdogArmed = true;          // fire at most once per stall; re-armed when a deck plays again
    this._lastRecoverAt = 0;             // last watchdog recovery attempt — bounded retry if a recovery can't find content
    this._started = false;               // automation engaged (start() called, not stopped). The watchdog only
                                         // recovers while on air — it must never auto-start playout on a fresh daemon.
    this.pollTimer = null;
    this.lastPollTime = Date.now();
  }

  // Daemon-log line, prefixed with the station. console.log is teed to the durable file by
  // audiod/daemon-log.js (and still hits stdout under the off-air harnesses). Diagnostic only —
  // never gates playout, never throws.
  _log(...a) { try { console.log("[engine s" + this.stationId + "]", ...a); } catch {} }

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
    if (this._started) this._log("_started: true → false (automation stopped)");
    this._started = false;   // Stage 3b: automation stopped — disable the stall watchdog (don't fight a deliberate stop).
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
    this._maintain();
    this._watchdog();
  }

  // Stage 3b: stall-recovery watchdog. Runs every poll tick AFTER _maintain. Enforces the invariant
  // "content present + nobody playing ⇒ somebody playing within ~1s" — the backstop that makes a
  // permanent stall impossible, regardless of any race in the rotate logic (3a tightens those).
  _watchdog() {
    const STALL_MS = 1000;       // sustained no-playing window before we call it a stall (rides out a crossfade)
    const WEDGE_MS = 3000;       // an advance op in-flight longer than this = a wedged advanceP chain
    const RETRY_MS = 2000;       // if a recovery couldn't find content, retry at most this often (no tight spin)
    if (!this._started) return;  // only recover while automation is engaged — never auto-start a fresh daemon
    const order = ["A", "B", "C"];
    const now = Date.now();
    const playing = order.find(d => this._deckState(d).status === "playing");
    if (playing) { this._lastPlayingAt = now; this._watchdogArmed = true; return; }  // healthy → re-arm

    // Is there anything to recover WITH? A cued/loaded deck, or queued (or continuous-refillable) content.
    const haveContent = order.some(d => !!this._deckState(d).title) || this.queue.length > 0 || this.continuous;
    if (!haveContent) return;                               // genuinely nothing to play — not a stall
    if (now - this._lastPlayingAt < STALL_MS) return;       // not stalled long enough (could be mid-transition)
    // Fire ONCE per stall (armed). If that recovery can't find content, fall back to a bounded retry
    // every RETRY_MS so a transiently-empty schedule can't leave us permanently disarmed.
    if (!this._watchdogArmed && (now - this._lastRecoverAt) < RETRY_MS) return;

    const inFlight = this._advanceStartedAt !== 0;
    const wedged = inFlight && (now - this._advanceStartedAt) > WEDGE_MS;
    if (inFlight && !wedged) return;                        // a normal advance is running — give it a beat, don't double-fire

    this._watchdogArmed = false;                            // disarm; re-arms only when a deck actually plays
    this._lastRecoverAt = now;
    if (wedged) {
      // The serialized chain is stuck — abandon it so our recovery can actually run.
      this._log("watchdog: advanceP WEDGED " + (now - this._advanceStartedAt) + "ms — resetting chain");
      this.emit("error", { stationId: this.stationId, where: "watchdog", error: `advanceP wedged ${now - this._advanceStartedAt}ms — resetting chain` });
      this.advanceP = Promise.resolve();
      this._advanceStartedAt = 0;
    }
    this._log("watchdog: STALL — no deck playing " + (now - this._lastPlayingAt) + "ms, forcing advance");
    this.emit("error", { stationId: this.stationId, where: "watchdog", error: `stall recovery — no deck playing ${now - this._lastPlayingAt}ms, forcing advance` });
    this._recoverStall();
  }

  // Get audio flowing again after a stall. Respects manual cues: if a deck is hand-cued (or otherwise
  // cued/loaded-idle), PLAY that deck rather than loading a different track over it; only when nothing
  // is loaded anywhere do we pull the next track from the queue onto deck A.
  _recoverStall() {
    this._advance("watchdog-recover", async () => {
      const order = ["A", "B", "C"];
      if (order.some(d => this._deckState(d).status === "playing")) return;  // someone started in the meantime
      // Prefer a cued standby deck (manual cue first → operator intent, then any ready/loaded-idle deck).
      const cued = order.find(d => this.manualCue.has(d) && this._deckState(d).status === "idle" && this._deckState(d).title)
                || order.find(d => this.deckReady.has(d) && this._deckState(d).status === "idle" && this._deckState(d).title)
                || order.find(d => this._deckState(d).status === "idle" && this._deckState(d).title);
      if (cued) {
        this._play(cued);
        this._setDeck(cued, { status: "playing", positionSec: 0 });
        this.endTriggered.delete(cued);
        this.deckReady.delete(cued);
        if (this.manualCue.has(cued)) this.manualCue.delete(cued);  // it just went live; don't dequeue against it
        else if (this.queue.length > 0) this.dequeue();
        this._fireStart(cued);
        return;
      }
      // Nothing cued anywhere — load + play the next PLAYABLE track from the queue onto deck A.
      await this.refillIfNeeded();
      let guard = 0;
      while (this.queue.length > 0 && guard++ < 100) {
        const next = this.dequeue();
        if (this.loadToDeck("A", next)) {
          this.deckChainType.A = next.chainType || "segue";
          this._play("A");
          this._setDeck("A", { status: "playing", positionSec: 0 });
          this.endTriggered.delete("A");
          this._fireStart("A");
          return;
        }
        this.emit("error", { stationId: this.stationId, where: "watchdog-recover", error: "skipped unplayable: " + (next.filePath || "") });
        if (this.queue.length === 0) await this.refillIfNeeded();
      }
    });
  }

  _changed(prev, next) {
    if (!prev) return true;
    return prev.status !== next.status || prev.filePath !== next.filePath || prev.title !== next.title ||
      Math.floor(prev.positionSec) !== Math.floor(next.positionSec) || prev.durationSec !== next.durationSec;
  }
  _maybeEmitDeck(id) {
    const st = this._deckState(id);
    const ready = this.deckReady.has(id);
    // Stage 0: deck events now carry deckReady (cued/ready) so the renderer can mirror cued state
    // instead of guessing. Emit on a status/title/position change OR a ready flip.
    if (this._changed(this.lastFired[id], st) || this.lastReady[id] !== ready) {
      this.emit("deck", { stationId: this.stationId, deck: id, state: st, ready });
    }
    this.lastFired[id] = st;
    this.lastReady[id] = ready;
  }

  // Self-heal each poll tick: keep the queue topped up AND the two idle decks pre-loaded, so a
  // transient empty queue (e.g. right after a daemon respawn) can't cascade into blank decks, no
  // crossfade, or a progress bar with nothing to fill against. preload sets durationSec (→ the bar
  // fills) and marks the deck ready (→ handleRotate crossfades instead of the bare load-next path).
  // The deckReady/not-playing guards + preload's own idempotent guard keep this off handleRotate's toes.
  _maintain() {
    if (this.continuous && this.queue.length < 5) this.refillIfNeeded();
    const order = ["A", "B", "C"];
    const playing = order.find(d => this._deckState(d).status === "playing");
    if (!playing || this.queue.length === 0) return;
    const i = order.indexOf(playing);
    const n1 = order[(i + 1) % 3], n2 = order[(i + 2) % 3];
    if (!this.deckReady.has(n1) && this._deckState(n1).status !== "playing") this.preload(n1, 0);
    if (this.queue.length > 1 && !this.deckReady.has(n2) && this._deckState(n2).status !== "playing") this.preload(n2, 1);
  }

  checkEnd(deckId, pos, dur, prevStatus, backendEnded = false) {
    if (this.processingEnd) return;
    const positionEnd = prevStatus === "playing" && dur > 5 && pos > 0 && (dur - pos) < 0.3;
    const genuineBackendEnd = backendEnded && (dur <= 5 || (dur - pos) < 5);
    if ((positionEnd || genuineBackendEnd) && !this.endTriggered.has(deckId)) {
      this.processingEnd = true;
      this.endTriggered.add(deckId);
      this._log("deck " + deckId + " ended (pos=" + pos.toFixed(1) + "/" + dur + "s, chain=" + this.deckChainType[deckId] + ", readyB=" + this.deckReady.has("B") + " readyC=" + this.deckReady.has("C") + " readyA=" + this.deckReady.has("A") + ")");

      if (this.deckChainType[deckId] === "stop") {
        this._setDeck(deckId, { status: "ended" });
        this.emit("chainstop", { stationId: this.stationId, deck: deckId });
        return;
      }
      this._setDeck(deckId, { status: "ended" });

      // Stage 3a: decide rotate-vs-load-next against FRESH native state, not the per-tick snapshot
      // (this.stateX), so a momentarily-stale "playing" flag can't make us skip the advance. deckReady
      // is now reliable too because preload is serialized on the same advanceP chain (no concurrent load).
      const live = this._state();
      const livePlaying = (d) => { const ld = live ? (d === "A" ? live.deckA : d === "B" ? live.deckB : live.deckC) : null; return ld?.status === "playing"; };
      if (deckId === "A") {
        if (this.deckReady.has("B")) this.handleRotate("A", "B");
        else if (this.autoAdvance && !livePlaying("B") && !livePlaying("C")) this.handleLoadNext("A");
      } else if (deckId === "B") {
        if (this.deckReady.has("C")) this.handleRotate("B", "C");
        else if (this.autoAdvance && !livePlaying("A") && !livePlaying("C")) this.handleLoadNext("B");
      } else if (deckId === "C") {
        if (this.deckReady.has("A")) this.handleRotate("C", "A");
        else if ((this.autoAdvance || this.queue.length > 0) && !livePlaying("A") && !livePlaying("B")) this.handleLoadNext("A");
      }
    }
  }

  // Stage 3b: run an advance op on the serialized chain, recording when it started so the watchdog
  // can detect (and reset) a WEDGED chain. Catches errors so one bad op can't poison advanceP.
  _advance(where, fn) {
    this.advanceP = this.advanceP.then(async () => {
      this._advanceStartedAt = Date.now();
      this._log("advance →", where, "(queue=" + this.queue.length + ")");
      try { await fn(); }
      catch (e) { this._log("advance ✗", where, String(e)); this.emit("error", { stationId: this.stationId, where, error: String(e) }); }
      finally { const ms = Date.now() - this._advanceStartedAt; this._advanceStartedAt = 0; this._log("advance done", where, ms + "ms"); }
    });
    return this.advanceP;
  }

  handleRotate(fromId, toId) {
    this._advance("handleRotate", async () => {
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
        // A hand-loaded deck wasn't fed from the queue — don't dequeue against it (that would drop
        // an unrelated upcoming song). Auto-cued decks DO consume their queue slot.
        if (this.manualCue.has(toId)) this.manualCue.delete(toId);
        else if (this.queue.length > 0) this.dequeue();
        const nearDelay = cfMs + 800;
        if (toId === "B") { setTimeout(() => this.preload("C", 0), 800); setTimeout(() => this.preload("A", 1), nearDelay); }
        else if (toId === "C") { setTimeout(() => this.preload("A", 0), 800); setTimeout(() => this.preload("B", 1), nearDelay); }
        else if (toId === "A") { setTimeout(async () => { await this.refillIfNeeded(); this.preload("B", 0); }, 800); setTimeout(() => this.preload("C", 1), nearDelay); }
    });
  }

  handleLoadNext(deckId) {
    this._advance("handleLoadNext", async () => {
        const live = this._state();
        if (live) { const ld = deckId === "A" ? live.deckA : deckId === "B" ? live.deckB : live.deckC; if (ld?.status === "playing") return; }
        await this.refillIfNeeded();
        // Dequeue + load the next PLAYABLE track, discarding unplayable (missing-file) ones so a
        // dead track never stalls the rotation. Bounded so an all-missing queue can't spin forever.
        let loaded = false, guard = 0;
        while (this.queue.length > 0 && guard++ < 100) {
          const next = this.dequeue();
          if (this.loadToDeck(deckId, next)) { this.deckChainType[deckId] = next.chainType || "segue"; loaded = true; break; }
          this.emit("error", { stationId: this.stationId, where: "handleLoadNext", error: "skipped unplayable: " + (next.filePath || "") });
          if (this.queue.length === 0) await this.refillIfNeeded();
        }
        if (!loaded) return;
        this._play(deckId);
        this._setDeck(deckId, { status: "playing", positionSec: 0 });
        this.endTriggered.delete(deckId);
        this._fireStart(deckId);
    });
  }

  // Stage 3a: serialize the deck LOAD on the SAME advanceP chain as handleRotate/handleLoadNext, so a
  // preload can never overlap a rotate (the race that left handleRotate reading a half-loaded deck /
  // a transient deckReady → the Bug-2 stall). Cheap guards run synchronously up front to avoid queuing
  // obvious no-ops every poll tick; the load (and a re-check, since a rotate may run ahead of us on the
  // chain) runs inside the serialized, wedge-tracked _advance closure.
  preload(deckId, queueIndex = 0) {
    if (this.deckReady.has(deckId)) return Promise.resolve();   // already cued — idempotent
    const st = this._deckState(deckId);
    if (st.status === "playing" || st.status === "paused") return Promise.resolve();
    return this._advance("preload:" + deckId, async () => {
      if (this.deckReady.has(deckId)) return;                   // re-check inside the chain
      const st2 = this._deckState(deckId);
      if (st2.status === "playing" || st2.status === "paused") return;
      // Never cue a file that's already playing/cued on another deck — that stacked the same song.
      const onOtherDecks = ["A", "B", "C"].filter(d => d !== deckId).map(d => this._deckState(d).filePath).filter(Boolean);
      let guard = 0;
      while (this.queue.length > queueIndex && guard++ < 100) {
        const next = this.queue[queueIndex];
        if (onOtherDecks.includes(next.filePath)) { queueIndex++; continue; } // already on another deck — skip
        if (this.loadToDeck(deckId, next)) { this.deckChainType[deckId] = next.chainType || "segue"; this.deckReady.add(deckId); if (next.qid) this.boundQids.add(next.qid); return; }
        this.queue.splice(queueIndex, 1);
        this.emit("queue", { stationId: this.stationId, items: this.queue });
        this.emit("error", { stationId: this.stationId, where: "preload", error: "dropped unplayable: " + (next.filePath || "") });
      }
    });
  }

  async refillIfNeeded() {
    // Refill BEFORE the queue hits 0 (low watermark), so it never sits empty and starves preload.
    if (!this.continuous || this.queue.length >= 5) return;
    // Throttle so we don't hammer loggen every 250ms tick when the schedule genuinely returns nothing.
    const now = Date.now();
    if (now - (this._lastRefillAt || 0) < 2000) return;
    this._lastRefillAt = now;
    const fill = loggen.fillQueue(this.db, this.stationId, 20);
    // Drop tracks whose files are gone (scheduled-then-deleted) — they'd stall the rotation.
    const items = this._ensureIds(this._playable(fill.items));
    if (items.length) {
      this.queue.push(...items);
      this._log("refill: +" + items.length + " from " + fill.source + " (queue=" + this.queue.length + ")");
      this.emit("queue", { stationId: this.stationId, source: fill.source, items: this.queue });
    } else {
      this._log("refill: 0 playable from " + fill.source + " (queue=" + this.queue.length + ")");
    }
  }

  dequeue() {
    const idx = this.shuffle ? Math.floor(Math.random() * this.queue.length) : 0;
    const item = this.queue.splice(idx, 1)[0];
    // Stage 1: a removed entry is no longer a pending queue slot — clear its bound flag here,
    // synchronously, so the rotate path can never leave a stale bound qid behind.
    if (item && item.qid) this.boundQids.delete(item.qid);
    this.emit("queue", { stationId: this.stationId, items: this.queue });
    return item;
  }

  // True if a queue item's file is actually PLAYABLE: a remote/stream URL (can't probe, trust it),
  // or a local file that exists AND the decoder can read (getFileDuration > 0). The duration probe
  // catches both missing files (scheduled-then-deleted) and corrupt/unsupported ones — the addon's
  // audioLoad does NOT reliably report those (it logs "reload failed — skipping" but still returns
  // success), so a dead deck would otherwise get stuck "playing" a non-existent source = dead air.
  _fileOk(fp) {
    if (!fp) return false;
    if (/^[a-z]+:\/\//i.test(fp)) return true;
    return fs.existsSync(fp) && this._dur(fp) > 0;
  }
  _playable(items) { return (items || []).filter(it => it && this._fileOk(it.filePath)); }
  // Stage 0: stamp a stable per-QUEUE-ENTRY id (qid) on each item as it enters the queue. The same
  // song can appear twice, so this is NOT the song's id — it's the identity of THIS queue slot, so
  // the renderer + future intent commands (remove/reorder) can address an exact entry. Preserves an
  // existing qid (e.g. a renderer echo-back of items it already received).
  _ensureIds(items) { return (items || []).map(it => (it && it.qid) ? it : { ...it, qid: crypto.randomUUID() }); }

  // Load a track into a deck. Returns TRUE on success, FALSE if the file is missing or the addon
  // can't load it (corrupt/unsupported) — callers must SKIP a false (never play a dead deck, or
  // the rotation stalls on a non-existent source = dead air). The old version always proceeded.
  loadToDeck(id, item) {
    if (!item || !this._fileOk(item.filePath)) return false;
    let ok;
    try { ok = this._load(id, item.filePath, item.title, item.artist, item.gainDb); }
    catch (e) { this.emit("error", { stationId: this.stationId, where: "loadToDeck", error: String(e) }); return false; }
    if (ok === false) return false;
    this._setDeck(id, { title: item.title || "", artist: item.artist || "", filePath: item.filePath, positionSec: 0, durationSec: (item.durationMs ?? 0) / 1000, status: "idle", volume: 1 });
    this.endTriggered.delete(id);
    const d = this._dur(item.filePath);
    if (d > 0) this._setDeck(id, { durationSec: d });
    this._maybeEmitDeck(id);
    return true;
  }

  _fireStart(deckId) {
    const st = this._deckState(deckId);
    this.emit("playstart", { stationId: this.stationId, deck: deckId, title: st.title, artist: st.artist, filePath: st.filePath });
    // Item 10 Phase 2 Step 4: the daemon owns play logging in daemon-driven mode (the
    // renderer's logPlay is gated off), so Play History survives a UI/app restart. Never
    // throws into the playout path.
    try { playlog.logPlay(this.db, { stationId: this.stationId, title: st.title, artist: st.artist, deck: deckId, durationMs: Math.round((st.durationSec || 0) * 1000), sessionId: SESSION }); } catch {}
  }

  // ── operator/queue API (called from daemon command handlers) ──
  // The renderer hand-loaded a deck (A/B/C button → audio:load). The native deck is already
  // loaded; flag it here so the self-heal (_maintain) won't preload over it and the rotate path
  // treats it as a manual cue. No-op for a playing deck (the load guard already blocks that).
  noteManualCue(deckId) {
    if (!["A", "B", "C"].includes(deckId)) return;
    if (this._deckState(deckId).status === "playing") return;
    this.deckReady.add(deckId);
    this.manualCue.add(deckId);
  }
  addToQueue(items) { this.queue.push(...this._ensureIds(this._playable(items))); this.emit("queue", { stationId: this.stationId, items: this.queue }); }
  replaceQueue(items) { this.queue = this._ensureIds(this._playable(items)); this._pruneBound(); this.emit("queue", { stationId: this.stationId, items: this.queue }); }
  clearQueue() { this.queue = []; this.boundQids.clear(); this.emit("queue", { stationId: this.stationId, items: this.queue }); }
  getQueue() { return [...this.queue]; }

  // ── Stage 1: explicit-intent commands (queue:* / deck:*) ──────────────────────────────────────
  // Additive — these run ALONGSIDE the legacy addToQueue/replaceQueue/clearQueue/load while the
  // renderer migrates (Stage 2). All are id-addressed, idempotent, and tolerant: a stale/unknown
  // intent is a quiet no-op (returns false), never an error or a corrupting mutation.

  // Keep boundQids ⊆ qids actually present in the queue (after a legacy whole-queue replace).
  _pruneBound() { const live = new Set(this.queue.map(it => it.qid)); for (const q of [...this.boundQids]) if (!live.has(q)) this.boundQids.delete(q); }
  // Index of the first PENDING (non-bound) entry — bound entries sit at the head as the cued decks.
  _pendingStart() { const i = this.queue.findIndex(it => !this.boundQids.has(it.qid)); return i < 0 ? this.queue.length : i; }

  // queue:enqueue — append to the bottom (daemon stamps qids). Same effect as legacy addToQueue.
  intentEnqueue(items) { this.addToQueue(items); return true; }

  // queue:remove — drop the pending entry with this qid. No-op if unknown or bound (cued on a deck).
  intentRemove(qid) {
    if (!qid || this.boundQids.has(qid)) return false;
    const idx = this.queue.findIndex(it => it.qid === qid);
    if (idx < 0) return false;
    this.queue.splice(idx, 1);
    this.emit("queue", { stationId: this.stationId, items: this.queue });
    return true;
  }

  // queue:reorder — move a pending entry to toIndex (clamped into the pending region; never above a
  // bound/cued head entry). No-op if unknown, bound, or already there.
  intentReorder(qid, toIndex) {
    if (!qid || this.boundQids.has(qid)) return false;
    const idx = this.queue.findIndex(it => it.qid === qid);
    if (idx < 0) return false;
    const [item] = this.queue.splice(idx, 1);
    const lo = this._pendingStart();
    const dest = Math.max(lo, Math.min(Number.isFinite(toIndex) ? toIndex : this.queue.length, this.queue.length));
    this.queue.splice(dest, 0, item);
    this.emit("queue", { stationId: this.stationId, items: this.queue });
    return true;
  }

  // queue:move — shortcut to the top (first pending slot, "play next") or bottom of the queue.
  intentMove(qid, where) {
    if (where !== "top" && where !== "bottom") return false;
    return this.intentReorder(qid, where === "top" ? this._pendingStart() : this.queue.length);
  }

  // queue:clear — clear the PENDING region only; leave the cued/playing decks (their head entries)
  // alone so audio never stops. (Legacy clearQueue still wipes everything for back-compat.)
  intentClearPending() {
    const before = this.queue.length;
    this.queue = this.queue.filter(it => this.boundQids.has(it.qid));
    if (this.queue.length === before) return false;
    this.emit("queue", { stationId: this.stationId, items: this.queue });
    return true;
  }

  // deck:cue — hand-load a song onto a specific deck (the A/B/C buttons' intent). No-op for a
  // non-A/B/C deck, a playing deck (never override on-air), or an unplayable file. Marks it manual
  // + ready and emits a deck event. songRef = { filePath, title, artist, gainDb?, durationMs? }.
  intentCueDeck(deck, songRef) {
    if (!["A", "B", "C"].includes(deck)) return false;
    if (this._deckState(deck).status === "playing") return false;
    if (!songRef || !this.loadToDeck(deck, songRef)) return false;
    this.deckChainType[deck] = songRef.chainType || "segue";
    this.deckReady.add(deck);
    this.manualCue.add(deck);
    this._maybeEmitDeck(deck);
    return true;
  }

  // deck:crossfade — fade the playing deck to a ready one. Args optional: from defaults to the
  // playing deck, to defaults to the next ready deck in rotation. No-op if there's no playing deck
  // or no ready target. Reuses handleRotate (carries its own spurious-end guards + dequeue).
  intentCrossfade(from, to) {
    const order = ["A", "B", "C"];
    const playing = from && order.includes(from) ? from : order.find(d => this._deckState(d).status === "playing");
    if (!playing) return false;
    let target = to && order.includes(to) ? to : null;
    if (!target) { const i = order.indexOf(playing); for (let k = 1; k <= 2; k++) { const c = order[(i + k) % 3]; if (this.deckReady.has(c)) { target = c; break; } } }
    if (!target || target === playing || !this.deckReady.has(target)) return false;
    this.handleRotate(playing, target);
    return true;
  }

  // Fill (if empty), load deck A, play, and preload B/C — the unattended start.
  async start() {
    this.init();
    const wasStarted = this._started;
    this._started = true;   // Stage 3b: automation engaged — the stall watchdog is now allowed to recover.
    this._log("automationStart: requested" + (wasStarted ? " (already _started)" : " — _started false → true (automation engaged)"));
    this._lastPlayingAt = Date.now();  // grace window so the watchdog doesn't fire before start() plays A
    await this.refillIfNeeded();
    // IDEMPOTENT: never start a deck over one that's already on air. If automationStart is
    // re-issued while a deck is playing — e.g. the app reconnects after a gapless update/restart,
    // or re-runs its startup automation — adopt the running playout instead of starting deck A on
    // top of it (that caused the double-play overlap). _maintain() keeps the idle decks cued.
    const order = ["A", "B", "C"];
    const live = this._state();
    const alreadyOnAir = order.some(d => this._deckState(d).status === "playing")
      || (live && [live.deckA, live.deckB, live.deckC].some(d => d && d.status === "playing"));
    if (alreadyOnAir) { this._log("automationStart: already on air → idempotent no-op (adopting running playout, no reload)"); return true; }
    // Load the first PLAYABLE track into A, skipping any missing-file items.
    let loaded = false, guard = 0;
    while (this.queue.length > 0 && guard++ < 100) {
      const first = this.dequeue();
      if (this.loadToDeck("A", first)) { this.deckChainType.A = first.chainType || "segue"; loaded = true; break; }
      this.emit("error", { stationId: this.stationId, where: "start", error: "skipped unplayable: " + (first.filePath || "") });
      if (this.queue.length === 0) await this.refillIfNeeded();
    }
    if (!loaded) { this._log("automationStart: no playable track to start (queue empty/all unplayable)"); return false; }
    this._play("A");
    this._setDeck("A", { status: "playing", positionSec: 0 });
    this._fireStart("A");
    this._log("automationStart: deck A LIVE — " + (this.stateA.title || "(untitled)"));
    setTimeout(async () => { await this.preload("B", 0); setTimeout(() => this.preload("C", 1), 400); }, 800);
    return true;
  }

  // Force-advance to the next queued track (operator skip / show-clock jump) — independent of
  // position. Loads the next deck in rotation, plays it, stops the current, preloads the next.
  async skip() {
    await this.refillIfNeeded();
    const order = ["A", "B", "C"];
    const playing = order.find(d => this._deckState(d).status === "playing");
    const next = playing ? order[(order.indexOf(playing) + 1) % 3] : "A";
    // Load the next PLAYABLE track, skipping missing-file items.
    let loaded = false, guard = 0;
    while (this.queue.length > 0 && guard++ < 100) {
      const item = this.dequeue();
      if (this.loadToDeck(next, item)) { this.deckChainType[next] = item.chainType || "segue"; loaded = true; break; }
      this.emit("error", { stationId: this.stationId, where: "skip", error: "skipped unplayable: " + (item.filePath || "") });
      if (this.queue.length === 0) await this.refillIfNeeded();
    }
    if (!loaded) return false;
    this._play(next);
    this._setDeck(next, { status: "playing", positionSec: 0 });
    this.endTriggered.delete(next);
    this._fireStart(next);
    if (playing && playing !== next) this._stop(playing);
    setTimeout(() => this.preload(order[(order.indexOf(next) + 1) % 3], 0), 600);
    return true;
  }
}

module.exports = { DaemonEngine };
