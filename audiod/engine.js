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

// ── Log-Reader Flip Phase 3 — the gate ────────────────────────────────────────────────────────────
// ETHER_LOG_READER=1 turns ON the time-anchored log-reader (playout consumes generated_schedule
// directly, playhead = the row-for-now per §2.7). It ships OFF: the flip's ACTIVE branch is gated on
// this flag AND a clean shadow burn-in AND Jeff's separate flip GO. With the flag OFF (this release),
// the daemon runs its legacy queue-sourced playout UNCHANGED and only OBSERVES — the §2.7 boundary
// shadow (_shadowEvalTimeAnchor) records, at every go-live, what the flipped reader WOULD have aired
// vs what legacy aired. That divergence ledger is the burn-in that gates the flip. Inherited from the
// Electron process env via the daemon spawn (audio-daemon-client.js) — no spawn change needed.
const LOG_READER_FLIP = process.env.ETHER_LOG_READER === "1";

// Sustained no-playing window before "nobody playing" is treated as a real stall (rides out a
// crossfade / load-next handoff). Shared by the stall-recovery watchdog AND the honest engine-state
// truth layer (Slice 1) so both judge "stalled" by the SAME criterion — no second, divergent detector.
const STALL_MS = 1000;

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
    // generated_schedule scheduled_at of the row on each deck — emitted with deck events so the
    // renderer/Calendar matches the exact row (single source). Survives native state rebuilds.
    this.deckSched = {};
    // Log-Reader Flip Phase 1 (SHADOW): generated_schedule.id of the row on each deck, so _fireStart
    // can stamp that row's LOCAL-ONLY lifecycle (state/played_at). null = an off-log (live-picked) item.
    this.deckSchedId = {};
    this.deckChainType = { A: "segue", B: "segue", C: "segue" };
    this.deckReady = new Set();
    // Bug A fix (source-wipe race): per-deck LOAD GENERATION — bumped on every fresh loadToDeck. A
    // deferred post-crossfade stop captures this at rotate time and no-ops if it changed (the deck was
    // re-loaded since), so a late stop can never wipe a freshly-preloaded source.
    this.deckGen = { A: 0, B: 0, C: 0 };
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
    // ── Routine segue OVERLAP (auto song→song), DISTINCT from crossfadeDuration (the manual X-key
    // gesture). Governs EVERY automatic segue: when the outgoing deck has ≤ this many seconds left AND
    // the next deck is ready, the incoming starts at FULL over the outgoing's natural tail — both play,
    // the outgoing ends on its own. NO fades: automation NEVER moves a deck fader (those are operator
    // controls). Songs carry their own mastered fade-outs. 0 = wait for the natural end (legacy hard
    // cut). Delivered from the app via setSegueOverlap; the daemon default matches the app default.
    this.segueOverlap = 3;
    this.segueTriggered = new Set();     // decks whose early overlap-rotate has begun (double-trigger guard)
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
    // Honest engine-state truth layer (Slice 1): live | stalled | off, derived ONLY from existing
    // state (_started + deck "playing" + the watchdog's _lastPlayingAt/STALL_MS). Emitted on change
    // so the renderer can report it to the backend. Seeds "off" (automation not engaged on a fresh
    // daemon); the never-false-LIVE bias lives in _computeEngineState.
    this._engineState = "off";
    this._lastHourCut = new Date().getHours();  // top-of-hour hard cut: hour we last fired for. Seeded to the
                                         // current hour so a mid-hour daemon start never fires until the next :00.
    // ── JINGLES overlay v1 (daemon = log-reader that orchestrates the CART overlay fire) ──────────────
    // _airGen: on-air generation, bumped every time ANY deck goes live (_fireStart). The Bug-A-immunity
    // token: an armed jingle captures it; ANY advance/skip/manual/top-of-hour cut goes through _fireStart,
    // bumps it, and the armed jingle is auto-superseded → cancels silently, re-arms next segue. No naked
    // timers anywhere — arming/firing is driven by poll() and serialized on the _advance chain.
    this._airGen = 0;
    this._jingle = null;                 // the current jingle lifecycle object, or null (one at a time)
    this._firedJinRows = [];             // generated_schedule row_ids already fired/consumed (bounded) — never re-arm
    this._jingleCartGen = 0;             // CART load generation (fresh fire invalidates a stale bridge close)
    // Read-ahead SCHEDULED hint: the seam jingle identified from the playing song's START (before the
    // 30s arm window), shown as a persistent grey third-row indicator that promotes to ARMED (white) →
    // FIRING (yellow). Display-only — never touches playout. Re-queried only when the seam identity
    // (_scheduledSig) changes, so it costs at most one DB read per song, not one per poll tick.
    this._scheduled = null;
    this._scheduledSig = "";
    this.pollTimer = null;
    this.lastPollTime = Date.now();
  }

  // Daemon-log line, prefixed with the station. console.log is teed to the durable file by
  // audiod/daemon-log.js (and still hits stdout under the off-air harnesses). Diagnostic only —
  // never gates playout, never throws.
  _log(...a) { try { console.log("[engine s" + this.stationId + "]", ...a); } catch {} }

  // v4.4.46 mix-telemetry heartbeat. One compact `[mix sN]` line every 5s, ONLY while a deck claims
  // status=playing (no spam when idle). Reads the per-station AudioLevels the mixer callback now
  // publishes (active-deck count, per-deck source/active/paused/volume/gain, monitor_vol, post-mix
  // peak, monotonic frames-consumed) and prints the frames DELTA since the last line — a live "is the
  // callback still pulling PCM while the VU reads silent?" signal for the Class-A wedge. Diagnostic
  // only: never gates playout, never throws, no engine-state or watchdog interaction.
  _mixHeartbeat(now, s) {
    try {
      const anyPlaying = ["deckA", "deckB", "deckC"].some((d) => s && s[d] && s[d].status === "playing");
      if (!anyPlaying) return;                                  // idle/stalled → stay quiet
      if (now - (this._lastMixLogAt || 0) < 5000) return;      // 5s cadence
      let lv; try { lv = JSON.parse(A.audioGetLevels(this.stationId)); } catch { return; }
      const df = Math.max(0, (lv.frames_total || 0) - (this._lastMixFrames || 0));
      this._lastMixFrames = lv.frames_total || 0;
      this._lastMixLogAt = now;
      const g = (x) => (x >= 0 ? "+" : "") + (x || 0).toFixed(1);
      const decks = (lv.decks || [])
        .map((d) => `${d.id} src=${d.source_present ? 1 : 0} a=${d.active ? 1 : 0} p=${d.paused ? 1 : 0} vol=${(d.volume || 0).toFixed(2)} g=${g(d.gain_db)}`)
        .join(" | ");
      console.log(
        `[mix s${this.stationId}] active=${lv.active_decks || 0} frames=+${df} peak=${(lv.master || 0).toFixed(3)} mon=${(lv.mon_vol || 0).toFixed(2)} | ${decks}`
      );
    } catch { /* diagnostic only — never disturb playout */ }
  }

  // ── addon wrappers (synchronous) ──
  _load(deck, fp, title, artist, gainDb) { return A.audioLoad(deck, fp, title || "", artist || "", gainDb ?? 0, this.stationId); }
  // A deck plays at whatever fader the OPERATOR set — automation NEVER moves a deck fader (those are
  // operator controls). Just clear the overlap guard so this deck's next seam can early-start again.
  _play(deck) { this.segueTriggered.delete(deck); return A.audioPlay(deck, this.stationId); }
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

    this._mixHeartbeat(now, s);   // v4.4.46: diagnostic [mix sN] line every 5s while playing (no-op otherwise)

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
    this._jingleTick(now);   // JINGLES v1: arm/fire/bridge the CART overlay (poll-driven; runs BEFORE the
                             // watchdog so a confirmed FIRING jingle bumps _lastPlayingAt → the intentional
                             // seam bridge is never mistaken for a stall).
    this._segueTick(now);    // Routine segue overlap: start the incoming early over the outgoing's tail (no
                             // fades). Reads the jingle state set above so it won't preempt an armed jingle.
    this._checkTopOfHour();
    this._watchdog();
    this._emitEngineState();
  }

  // Honest engine state (Slice 1). The ONE invariant: a stalled or silent station can NEVER report
  // "live". Derived purely from state that already exists — no new detection:
  //   off     = automation not engaged (!_started)
  //   live    = a deck is actually playing audio
  //   stalled = automation engaged but no deck is playing (empty/failed refill, wedge, dead air) —
  //             same criterion the watchdog uses (_lastPlayingAt / STALL_MS), so a sub-STALL_MS
  //             crossfade/load-next handoff from a LIVE state holds "live" and doesn't flap, but any
  //             sustained silence (or a non-live origin) reads "stalled", never "live".
  _computeEngineState() {
    if (!this._started) return "off";
    const order = ["A", "B", "C"];
    if (order.some(d => this._deckState(d).status === "playing")) return "live";
    // A confirmed-FIRING jingle bridging the seam IS live audio (over master), even with all A/B/C idle
    // for the underlap window. Observed, not claimed: only counts when samples are actually flowing on CART.
    if (this._jingle && this._jingle.firingConfirmedAt && this._cartFlowing()) return "live";
    // Nobody playing under automation. Ride out only a brief handoff out of a live state; anything
    // longer than the watchdog's stall window — or any non-live origin — is an honest stall.
    if (this._engineState === "live" && (Date.now() - this._lastPlayingAt) < STALL_MS) return "live";
    return "stalled";
  }

  // Current honest state (also the daemon's authoritative answer to the getEngineState command).
  engineState() { return this._engineState; }

  // Emit on change so the renderer mirrors it (→ now-playing payload + keepalive). Cheap: poll() only.
  _emitEngineState() {
    const next = this._computeEngineState();
    if (next === this._engineState) return;
    this._engineState = next;
    this.emit("enginestate", { stationId: this.stationId, state: next });
    this._log("engine-state → " + next);
  }

  // ── Top-of-hour hard cut ──────────────────────────────────────────────────────────────────────
  // Radio needs the top of each hour to hit at :00 (legal/station ID, news, the new hour's first
  // element) — even mid-song. Nothing else here watches the wall clock; rotation only advances at
  // song-end. So once per hour, when the LOCAL hour rolls over, if the schedule has an element for
  // the new hour we hard-cut to it. Fail-safe: any miss (no schedule, query error) leaves the current
  // rotation playing — this never causes dead air. Only runs while automation is engaged.
  _checkTopOfHour() {
    if (!this._started) return;
    const now = new Date();
    const h = now.getHours();
    if (h === this._lastHourCut) return;   // same hour — nothing to do
    this._lastHourCut = h;                  // mark immediately so we fire at most once per boundary
    const hs = new Date(now.getTime()); hs.setMinutes(0, 0, 0);
    this._hardCutTopOfHour(h, Math.floor(hs.getTime() / 1000));
  }

  _hardCutTopOfHour(hour, hourStartTs) {
    let items;
    try { items = this._ensureIds(this._playable(loggen.fillFromHour(this.db, this.stationId, hourStartTs, 20))); }
    catch (e) { this._log("top-of-hour: fill error — " + String(e) + " (rotation continues)"); return; }
    if (!items.length) { this._log("top-of-hour @" + hour + ":00 — no scheduled element, rotation continues"); return; }
    this._log("top-of-hour @" + hour + ":00 HARD CUT → " + (items[0].title || "(untitled)") + " (" + items.length + " queued)");
    this._advance("top-of-hour", async () => {
      // Hard-stop every deck (no fade) and wipe the outgoing hour's runover + cued state.
      this._stop("A"); this._stop("B"); this._stop("C");
      this._setDeck("A", { status: "ended" }); this._setDeck("B", { status: "ended" }); this._setDeck("C", { status: "ended" });
      this.deckReady.clear(); this.manualCue.clear(); this.endTriggered.clear(); this.segueTriggered.clear();
      this.clearQueue();
      this.queue.push(...items);
      this.emit("queue", { stationId: this.stationId, source: "top-of-hour", items: this.queue });
      await new Promise(r => setTimeout(r, 80)); // let the stops reach the audio backend before we load
      // Load + play the new hour's first PLAYABLE element on deck A, skipping any dead files.
      let loaded = false, guard = 0;
      while (this.queue.length > 0 && guard++ < 100) {
        const first = this.dequeue();
        if (this.loadToDeck("A", first)) { this.deckChainType.A = first.chainType || "segue"; loaded = true; break; }
        this.emit("error", { stationId: this.stationId, where: "top-of-hour", error: "skipped unplayable: " + (first.filePath || "") });
        this._noteLoadSkip(first.title, "unplayable at load (top-of-hour)");
      }
      if (!loaded) { this._log("top-of-hour: first element unplayable — rotation will self-heal"); return; }
      this._play("A");
      this._setDeck("A", { status: "playing", positionSec: 0 });
      this.endTriggered.delete("A");
      this._fireStart("A");
      this._log("top-of-hour: deck A LIVE — " + (this.stateA.title || "(untitled)"));
      // Preload B/C so the rotation continues normally through the rest of the hour.
      setTimeout(async () => { await this.preload("B", 0); setTimeout(() => this.preload("C", 1), 400); }, 800);
    });
  }

  // Stage 3b: stall-recovery watchdog. Runs every poll tick AFTER _maintain. Enforces the invariant
  // "content present + nobody playing ⇒ somebody playing within ~1s" — the backstop that makes a
  // permanent stall impossible, regardless of any race in the rotate logic (3a tightens those).
  _watchdog() {
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
    this._advance("watchdog-recover", () => this._resumePlayout());
  }

  // Shared "get audio flowing NOW" primitive — used by the stall watchdog (_recoverStall) AND the
  // manual PLAY NOW command (intentPlayNow). Prefer a cued standby deck (manual cue = operator intent
  // first), else load + play the next PLAYABLE queued track on deck A (refilling). Returns true if it
  // started a deck, false if nothing was available or a deck is already playing. MUST run inside an
  // _advance() chain (callers wrap it) so it can't race a rotate.
  async _resumePlayout() {
    const order = ["A", "B", "C"];
    if (order.some(d => this._deckState(d).status === "playing")) return false;  // someone's already playing
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
      this._log("resume-playout: deck " + cued + " LIVE — " + (this._deckState(cued).title || "(untitled)"));
      return true;
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
        this._log("resume-playout: deck A LIVE — " + (this.stateA.title || "(untitled)"));
        return true;
      }
      this.emit("error", { stationId: this.stationId, where: "resume-playout", error: "skipped unplayable: " + (next.filePath || "") });
      this._noteLoadSkip(next.title, "unplayable at load (resume-playout)");
      if (this.queue.length === 0) await this.refillIfNeeded();
    }
    return false;
  }

  _changed(prev, next) {
    if (!prev) return true;
    return prev.status !== next.status || prev.filePath !== next.filePath || prev.title !== next.title ||
      Math.floor(prev.positionSec) !== Math.floor(next.positionSec) || prev.durationSec !== next.durationSec ||
      prev.volume !== next.volume;   // fader truth: re-emit on any volume change so the UI can never lag it
  }
  _maybeEmitDeck(id) {
    const st = this._deckState(id);
    const ready = this.deckReady.has(id);
    // Stage 0: deck events now carry deckReady (cued/ready) so the renderer can mirror cued state
    // instead of guessing. Emit on a status/title/position change OR a ready flip.
    if (this._changed(this.lastFired[id], st) || this.lastReady[id] !== ready) {
      this.emit("deck", { stationId: this.stationId, deck: id, state: { ...st, scheduledAt: this.deckSched[id] ?? null }, ready });
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

      // JINGLES v1 seam bridge: if a CONFIRMED-FIRING jingle governs this deck's seam AND the incoming
      // song should start AFTER this deck ends (jingle long enough to bridge the gap), DEFER the rotation
      // — _jingleTick starts the incoming deck at the underlap point (before the jingle ends). Defers ONLY
      // on OBSERVED firing (samples flowing), so a non-firing / failed jingle can never cause a bridge or
      // dead air; the normal rotation below proceeds unchanged in every other case.
      // If the segue overlap already started the incoming early (segueTriggered), it owns this seam — the
      // jingle just plays out over the running songs. Otherwise (overlap=0, or not yet started) the jingle
      // bridge starts the incoming at this deck's end so the jingle still covers the transition.
      if (!this.segueTriggered.has(deckId) && this._jingleShouldBridge(deckId)) { this._jingleBeginBridge(deckId); return; }

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
      try { return await fn(); }   // propagate the closure's result (e.g. intentPlayNow true/false); existing callers ignore it
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
        // Play-skip guard (Bug A safety net): only segue to a deck that truly holds a loaded source
        // (deckReady is now authoritative — the deferred stop below clears it). If it doesn't, never
        // silently play an empty deck (the "[RUST] Play … source=None … skipping" dead-air) — emit a
        // LOUD error and reload this deck from the queue, then rotate into it once it's ready.
        if (!this.deckReady.has(toId) && this._deckState(toId).status !== "playing") {
          this._log("play-skip GUARD: deck " + toId + " has no ready source — reloading instead of silent skip");
          this.emit("error", { stationId: this.stationId, where: "play-skip", deck: toId, error: "source missing at rotate — reloading deck " + toId });
          setTimeout(() => { this.preload(toId, 0).then(() => { if (this.deckReady.has(toId)) this.handleRotate(fromId, toId); }); }, 0);
          return;
        }
        this._play(toId);
        const cfMs = this.crossfadeDuration * 1000;
        // Bug A (source-wipe race): run the outgoing deck's post-crossfade stop ON the advance chain
        // (serialized with preload) and GUARD it — skip if the deck was re-loaded since (deckGen changed)
        // or went live again; when it does stop, clear deckReady/endTriggered so a nulled Rust source can
        // never be left marked "ready" (the stale-ready → silent source=None play). Replaces the old
        // floating off-chain setTimeout(_stop) that could land after a re-preload and wipe a fresh source.
        const fromGen = this.deckGen[fromId];
        setTimeout(() => this._advance("stop:" + fromId, async () => {
          if (this.deckGen[fromId] !== fromGen) return;             // re-loaded → fresh source, don't wipe
          if (this._deckState(fromId).status === "playing") return; // live again → never stop a playing deck
          this._stop(fromId);
          this.deckReady.delete(fromId);
          this.endTriggered.delete(fromId);
        }), cfMs + 500);
        this._setDeck(toId, { status: "playing", positionSec: 0 });
        this._fireStart(toId);
        this._log("segue: deck " + toId + " LIVE — " + (this._deckState(toId).title || "(untitled)"));
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
          this._noteLoadSkip(next.title, "unplayable at load (handleLoadNext)");
          if (this.queue.length === 0) await this.refillIfNeeded();
        }
        if (!loaded) return;
        this._play(deckId);
        this._setDeck(deckId, { status: "playing", positionSec: 0 });
        this.endTriggered.delete(deckId);
        this._fireStart(deckId);
        this._log("load-next: deck " + deckId + " LIVE — " + (this._deckState(deckId).title || "(untitled)"));
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
        this._noteLoadSkip(next.title, "unplayable at load (preload)");
      }
    });
  }

  // Slice B — every skip of an unresolvable row is LOUD: a structured health event (title, station,
  // reason) that main routes to the library-health skipped-at-load sense + health-events.jsonl. A deck
  // load must never die silently again.
  _noteLoadSkip(title, reason) {
    try { this.emit("loadskip", { stationId: this.stationId, title: title || "(untitled)", reason }); } catch { /* never break playout */ }
  }

  async refillIfNeeded() {
    // Refill BEFORE the queue hits 0 (low watermark), so it never sits empty and starves preload.
    if (!this.continuous || this.queue.length >= 5) return;
    // Throttle so we don't hammer loggen every 250ms tick when the schedule genuinely returns nothing.
    const now = Date.now();
    if (now - (this._lastRefillAt || 0) < 2000) return;
    this._lastRefillAt = now;
    const fill = loggen.fillQueue(this.db, this.stationId, 20);
    // Slice B rotation honesty: only LOCAL-playable items enter the queue (unchanged behaviour). But be
    // HONEST about WHY a row is dropped: an R2-only row (fileKey present) is prefetch-lag — it will
    // materialize (the prefetch-lag sense tracks it), so defer it quietly this pass. A row with NO local
    // file AND NO fileKey is genuinely DEAD — drop it LOUDLY (a load-skip health event) so it never
    // phantom-fills the pool and separation stays honest. Queue content is identical to before.
    const kept = [];
    for (const it of (fill.items || [])) {
      if (this._fileOk(it.filePath)) kept.push(it);
      else if (!it.fileKey) this._noteLoadSkip(it.title, "unresolvable — no local file, no file_key");
      // else: R2-only → prefetch-lag; silently deferred (prefetch materializes it; next fill picks it up).
    }
    const items = this._ensureIds(kept);
    if (items.length) {
      this.queue.push(...items);
      // Schedule is authoritative — once a generated_schedule fill lands, drop any live-picked /
      // restored pollutant (no scheduledAt) so the daemon queue can ONLY hold scheduled rows.
      if (fill.source === "generated_schedule") {
        const before = this.queue.length;
        this.queue = this.queue.filter(q => typeof q.scheduledAt === "number");
        if (this.queue.length !== before) this._log("purgeUnscheduled: dropped " + (before - this.queue.length) + " non-scheduled");
      }
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
    this.deckGen[id] = (this.deckGen[id] || 0) + 1;   // Bug A: fresh source loaded → invalidate any pending deferred stop for this deck
    this.deckSched[id] = item.scheduledAt ?? null;   // remember this deck's schedule-row identity
    this.deckSchedId[id] = item.schedId ?? null;     // Phase 1 shadow: the generated_schedule row id (null = off-log)
    this._setDeck(id, { title: item.title || "", artist: item.artist || "", filePath: item.filePath, positionSec: 0, durationSec: (item.durationMs ?? 0) / 1000, status: "idle", volume: 1 });
    this.endTriggered.delete(id);
    const d = this._dur(item.filePath);
    if (d > 0) this._setDeck(id, { durationSec: d });
    this._maybeEmitDeck(id);
    return true;
  }

  _fireStart(deckId) {
    const st = this._deckState(deckId);
    this._airGen++;   // JINGLES v1: a new deck went live → any jingle armed against the prior on-air
                      // generation is now superseded (see _jingleSuperseded). Bumps for EVERY go-live
                      // path (rotate / load-next / skip / play-now / top-of-hour / resume).
    this.emit("playstart", { stationId: this.stationId, deck: deckId, title: st.title, artist: st.artist, filePath: st.filePath });
    // Item 10 Phase 2 Step 4: the daemon owns play logging in daemon-driven mode (the
    // renderer's logPlay is gated off), so Play History survives a UI/app restart. Never
    // throws into the playout path.
    try { playlog.logPlay(this.db, { stationId: this.stationId, title: st.title, artist: st.artist, deck: deckId, durationMs: Math.round((st.durationSec || 0) * 1000), sessionId: SESSION, filePath: st.filePath }); } catch {}
    // Log-Reader Flip Phase 3 — TIME-ANCHORED boundary SHADOW (§2.7). BEFORE the Phase 1 stamp (while the
    // aired row is still 'pending' and thus comparable), record what the flipped reader WOULD air "now"
    // vs what legacy just put on air. OBSERVATIONAL — never drives playout.
    this._shadowEvalTimeAnchor(deckId, this.deckSchedId[deckId]);
    // Log-Reader Flip Phase 1 — SHADOW playhead writer. Stamp the generated_schedule row's local-only
    // lifecycle as this deck goes live. OBSERVATIONAL ONLY — changes no playout/queue behavior.
    this._shadowStampPlayhead(this.deckSchedId[deckId]);
  }

  // Log-Reader Flip Phase 3 — TIME-ANCHORED boundary SHADOW (design §2.7). At each go-live boundary,
  // ask the shared selector (loggen.selectRowForNow) what the flip WOULD air "now", and compare it to
  // what legacy actually aired (airedSchedId + the deck's scheduled_at). Emits a `logreader-shadow`
  // record — the burn-in "sense" that quantifies the drift the flip eliminates (e.g. "legacy aired the
  // 4:00 row at 3:19 wall-clock; the flip would have aired the 3:20 row — 40 min behind, 8 rows missed").
  // Runs regardless of the flag (the flag OFF is the burn-in). Read-only; never throws into playout.
  _shadowEvalTimeAnchor(deckId, airedSchedId) {
    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const d = loggen.selectRowForNow(this.db, this.stationId, nowTs);
      const airedAt = this.deckSched[deckId] ?? null;            // aired row's scheduled_at (back-link)
      const wouldId = d.playRow ? d.playRow.row_id : null;
      const rec = {
        stationId: this.stationId, ts: nowTs, deck: deckId, mode: d.mode,
        flag: LOG_READER_FLIP ? 1 : 0,                            // flip ACTIVE? (OFF this release)
        airedSchedId: airedSchedId ?? null, airedScheduledAt: airedAt,
        wouldAirSchedId: wouldId, wouldAirScheduledAt: d.playRow ? d.playRow.scheduled_at : null,
        wouldAirTitle: d.playRow ? d.playRow.title : null,
        driftSec: d.driftSec, missedCount: d.missedCount,
        agrees: airedSchedId != null && wouldId != null && airedSchedId === wouldId,
      };
      this.emit("logreader-shadow", rec);
      if (!rec.agrees) this._log(`[LOGREADER-SHADOW] ${d.mode}: aired row ${airedSchedId} — flip would air row ${wouldId} (drift ${d.driftSec}s, missed ${d.missedCount})`);
    } catch (e) { /* shadow must NEVER perturb playout */ }
  }

  // Log-Reader Flip Phase 1 — SHADOW playhead writer (design §7 Phase 1). As each deck goes live, record
  // the true playhead in generated_schedule's LOCAL-ONLY lifecycle columns (never synced, §5) so a later
  // phase can read the playout position straight from the log — and so we can verify, over a burn-in, that
  // the stamped playhead matches play_log. This is a direct local write on the daemon's own DB handle
  // (same pattern as playlog.logPlay); it does NOT go through the sync mutation path. It changes NO
  // playout behavior. A live-picked (off-log) item has no schedId → retire the prior playhead and count
  // the divergence (the exact decks-vs-calendar mismatch the flip eliminates). Never throws into playout.
  _shadowStampPlayhead(schedId) {
    try {
      const now = Math.floor(Date.now() / 1000);
      if (schedId != null) {
        // New playhead: this row is 'playing'; any other 'playing' row for this station is now 'played'.
        this.db.prepare("UPDATE generated_schedule SET state='played' WHERE station_id=? AND state='playing' AND id!=?").run(this.stationId, schedId);
        this.db.prepare("UPDATE generated_schedule SET state='playing', played_at=? WHERE id=? AND station_id=?").run(now, schedId, this.stationId);
        if (this._playheadOffLog) console.log(`[PLAYHEAD] station ${this.stationId}: back ON-LOG (row ${schedId}).`);
        this._playheadOffLog = false;
      } else {
        // Off-log content on air — the calendar has no row for what's playing. Retire the prior playhead
        // and record the divergence (logged once per off-log run so a long stretch stays visible).
        this.db.prepare("UPDATE generated_schedule SET state='played' WHERE station_id=? AND state='playing'").run(this.stationId);
        this._offLogPlays = (this._offLogPlays || 0) + 1;
        if (!this._playheadOffLog) console.warn(`[PLAYHEAD] station ${this.stationId}: OFF-LOG on air (no generated_schedule row) — decks/queue diverged from the calendar. offLogPlays=${this._offLogPlays}`);
        this._playheadOffLog = true;
      }
    } catch (e) { /* shadow write must NEVER perturb playout */ }
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

  // PLAY NOW — the manual stall escape: get audio on air immediately, bypassing the picker. With a
  // songRef, load + play THAT song now on a free deck (stopping any other playing deck). Without one,
  // run the SAME recovery the watchdog uses (_resumePlayout): play a cued deck if one's ready, else
  // load + play the next queued track. Honest interaction with automation: after the song plays, normal
  // rotation resumes via end-detection IF automation is engaged (_started); if automation is off it
  // plays the one song and stops. Distinct from skip (which always advances the queue, ignoring a
  // hand-cued deck) and from deck:cue (which only cues, never plays).
  intentPlayNow(songRef) {
    return this._advance("play-now", async () => {
      const order = ["A", "B", "C"];
      if (songRef && songRef.filePath) {
        const deck = order.find(d => this._deckState(d).status !== "playing") || "A";
        if (!this.loadToDeck(deck, songRef)) return false;
        this.deckChainType[deck] = songRef.chainType || "segue";
        for (const d of order) if (d !== deck && this._deckState(d).status === "playing") this._stop(d);
        this.deckReady.delete(deck); this.manualCue.delete(deck); this.endTriggered.delete(deck);
        this._play(deck);
        this._setDeck(deck, { status: "playing", positionSec: 0 });
        this._fireStart(deck);
        this._log("play-now: deck " + deck + " LIVE — " + (this._deckState(deck).title || "(untitled)"));
        return true;
      }
      return this._resumePlayout();
    });
  }

  // Fill (if empty), load deck A, play, and preload B/C — the unattended start.
  async start() {
    this.init();
    const wasStarted = this._started;
    this._started = true;   // Stage 3b: automation engaged — the stall watchdog is now allowed to recover.
    this._log("automationStart: requested" + (wasStarted ? " (already _started)" : " — _started false → true (automation engaged)"));
    // Log-Reader Flip Phase 3: announce the gate so a burn-in run (flag OFF) vs a flip run (flag ON) is
    // unambiguous in the daemon log. OFF = legacy playout + §2.7 boundary shadow only.
    if (!wasStarted) this._log("log-reader flip: ETHER_LOG_READER=" + (LOG_READER_FLIP ? "1 (FLIP ACTIVE — time-anchored playout)" : "0 (OFF — legacy playout + §2.7 shadow only)"));
    this._lastPlayingAt = Date.now();  // grace window so the watchdog doesn't fire before start() plays A
    await this.refillIfNeeded();
    // IDEMPOTENT: never start a deck over one that's already on air. If automationStart is
    // re-issued while a deck is playing — e.g. the app reconnects after a gapless update/restart,
    // or re-runs its startup automation — adopt the running playout instead of starting deck A on
    // top of it (that caused the double-play overlap). _maintain() keeps the idle decks cued.
    const order = ["A", "B", "C"];
    const live = this._state();
    const claimsOnAir = order.some(d => this._deckState(d).status === "playing")
      || (live && [live.deckA, live.deckB, live.deckC].some(d => d && d.status === "playing"));
    // OBSERVED, not claimed (2026-07-15 silent-while-playing incident fix): a deck can report status
    // "playing" while the output is dead silent (the cpal/source wedge, or a stale deck adopted after a
    // daemon respawn). ADOPTING that leaves the station silent forever ("adopting running playout" →
    // nothing restarts). So only adopt when audio is ACTUALLY flowing; otherwise hard-clear and force a
    // fresh deck below. _isAudiblyOnAir samples the master peak over ~400ms so a between-song gap doesn't
    // false-trip a force-restart.
    const alreadyOnAir = claimsOnAir && await this._isAudiblyOnAir();
    if (claimsOnAir && !alreadyOnAir) {
      this._log("automationStart: decks claim playing but output is SILENT (observed) — NOT adopting; force-starting a fresh deck");
      this.emit("error", { stationId: this.stationId, where: "automationStart", error: "silent-while-playing on adopt — force-starting a fresh deck" });
      this._stop("A"); this._stop("B"); this._stop("C");
      this._setDeck("A", { status: "ended" }); this._setDeck("B", { status: "ended" }); this._setDeck("C", { status: "ended" });
      this.deckReady.clear(); this.manualCue.clear(); this.endTriggered.clear(); this.segueTriggered.clear();
      this._airGen++;
      await new Promise(r => setTimeout(r, 80));   // let the stops reach the backend before loading A
    }
    if (alreadyOnAir) {
      // Adopt the running deck (never restart it — that caused the double-play overlap), but STILL
      // cue the two idle decks so the rotation can advance. The app reissues automationStart while a
      // deck is already playing (gapless update / reconnect / boot auto-resume); without cueing the
      // standby decks here they stay empty and the song never transitions until a manual AUTO reset.
      this._log("automationStart: already on air (audible) → adopting running playout + cueing idle decks");
      const livePlaying = (d) => this._deckState(d).status === "playing"
        || (live && [live.deckA, live.deckB, live.deckC][order.indexOf(d)] && [live.deckA, live.deckB, live.deckC][order.indexOf(d)].status === "playing");
      const idle = order.filter(d => !livePlaying(d));
      if (idle[0]) setTimeout(async () => { await this.preload(idle[0], 0); if (idle[1]) setTimeout(() => this.preload(idle[1], 1), 400); }, 300);
      return true;
    }
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

  // ── JINGLES overlay v1 — CART overlay orchestration (daemon = log-reader; Generate placed the row) ──
  // Poll-driven, no naked timers, generation-guarded (mirrors the 4.4.48 deckGen Bug-A fix). Lifecycle:
  //   ARMED   — a JIN placement is identified for the upcoming seam; captured on-air + deck generation.
  //   FIRING  — CART audioPlay issued AND samples observed flowing (level_cart); play-log stamped HERE.
  //   BRIDGING— outgoing deck ended; incoming deferred until (jingle end − underlap); jingle bridges.
  //   CLEARED — incoming deck live again.  ARMED_CANCELLED — superseded/failed before firing (no log row).
  static get _ARM_WINDOW_S() { return 30; }       // only look for a seam jingle within this of the end
  static get _FIRE_CONFIRM_MS() { return 900; }    // fired but no samples within this → failed, cancel

  _emitJingle(state, j) {
    try { this.emit("jingle", { stationId: this.stationId, state, deck: j ? j.deck : null,
      title: j ? j.title : null, categoryId: j ? j.categoryId : null, contentClass: j ? j.contentClass : null,
      leadInSec: j ? j.leadIn : null, underlapSec: j ? j.underlap : null, jinDurSec: j ? (j.jinDur || 0) : null, ts: Date.now() }); } catch {}
  }
  _noteFiredRow(rowId) { if (rowId == null) return; this._firedJinRows.push(rowId); if (this._firedJinRows.length > 300) this._firedJinRows.splice(0, this._firedJinRows.length - 300); }

  // Is this station ACTUALLY producing audio (not just a deck claiming status="playing")? Samples the
  // post-mix master peak a few times over ~400ms so a brief between-song gap can't false-negative. Used
  // by automationStart to refuse adopting a silent/wedged deck (2026-07-15 silent-while-playing fix).
  async _isAudiblyOnAir(samples = 4, gapMs = 100) {
    const EPS = 0.002;   // healthy audio peaks ~0.9; silent wedge reads 0.000 — clean separation
    for (let i = 0; i < samples; i++) {
      try { const lv = JSON.parse(A.audioGetLevels(this.stationId)); if ((lv.master || 0) > EPS) return true; } catch {}
      if (i < samples - 1) await new Promise(r => setTimeout(r, gapMs));
    }
    return false;
  }

  // Are samples actually flowing on the CART overlay bus RIGHT NOW? Observed truth, never a claim.
  _cartFlowing() {
    try {
      const lv = JSON.parse(A.audioGetLevels(this.stationId));
      if ((lv.cart || lv.level_cart || 0) > 0.0001) return true;
      const cd = (lv.decks || []).find(d => d && (d.id === "CART" || d.id === 6));
      return !!(cd && cd.source_present && cd.active && !cd.paused);
    } catch { return false; }
  }

  // Supersession (Bug-A immunity) — only meaningful while ARMED (pre-fire). A firing jingle is real audio
  // already on air; we never cancel it mid-play.
  _jingleSuperseded(j) {
    if (this._airGen !== j.airGen) return true;                    // a new deck went live since arm
    if (this._deckState(j.deck).status !== "playing") return true; // armed deck no longer playing
    if (this.deckGen[j.deck] !== j.deckGen) return true;           // armed deck re-loaded (fresh source)
    return false;
  }

  _nextRotateDeck(fromDeck) {
    const order = ["A", "B", "C"]; const i = order.indexOf(fromDeck);
    const n1 = order[(i + 1) % 3], n2 = order[(i + 2) % 3];
    if (this.deckReady.has(n1)) return n1;
    if (this.deckReady.has(n2)) return n2;
    return null;
  }

  _armJingle(jin, deck) {
    this._jingle = {
      phase: "armed", rowId: jin.rowId, filePath: jin.filePath, title: jin.title, artist: jin.artist,
      jinDur: (jin.durationMs || 0) / 1000, leadIn: jin.leadInSec, underlap: jin.underlapSec,
      categoryId: jin.jingleCategoryId, contentClass: jin.contentClass === 'SWP' ? 'SWP' : 'JIN',
      deck, airGen: this._airGen, deckGen: this.deckGen[deck],
      firedAt: 0, firingConfirmedAt: 0, nextStart: 0, outgoingEndedAt: 0,
    };
    this._noteFiredRow(jin.rowId);   // consume the placement so we don't re-arm it if the seam recomputes
    this._log(`${this._jingle.contentClass} ARMED — "${jin.title}" over deck ${deck} seam (lead_in=${jin.leadInSec}s underlap=${jin.underlapSec}s)`);
    this._emitJingle("ARMED", this._jingle);
  }

  // Cancel an ARMED (or fired-but-silent) jingle: emit ARMED_CANCELLED, stop CART defensively, NO play-log.
  _cancelJingle(reason) {
    const j = this._jingle; if (!j) return;
    if (j.firedAt) { this._stop("CART"); }
    this._log(`jingle ARMED_CANCELLED (${reason}) — "${j.title}"`);
    this._emitJingle("ARMED_CANCELLED", j);
    this._jingle = null;
  }
  _clearJingle(reason) {
    const j = this._jingle; if (!j) return;
    this._log(`jingle CLEARED (${reason}) — "${j.title}"`);
    this._emitJingle("CLEARED", j);
    this._jingle = null;
  }

  // Stamp the jingle play — ONLY on observed firing (rider #2), stamped content_class='JIN' so Phase-1b
  // isolation excludes it from music math / affidavit. deck="CART" (overlay, not a rotation deck).
  _logJinglePlay(j) {
    try {
      playlog.logPlay(this.db, { stationId: this.stationId, title: j.title, artist: j.artist, deck: "CART",
        durationMs: Math.round((j.jinDur || 0) * 1000), sessionId: SESSION, filePath: j.filePath, contentClass: j.contentClass || "JIN" });
    } catch {}
  }

  // Should this deck's end DEFER to a bridging jingle? Only if the jingle is confirmed firing on THIS
  // deck's seam and the incoming start (jingle end − underlap) lands AFTER this deck ends (now).
  _jingleShouldBridge(deckId) {
    const j = this._jingle;
    if (!j || j.deck !== deckId || !j.firingConfirmedAt || !j.firedAt) return false;
    const jingleEnd = j.firedAt + j.jinDur * 1000;
    return jingleEnd > Date.now() + 150;   // still jingle tail left to weave the incoming under
  }
  _jingleBeginBridge(deckId) {
    const j = this._jingle; if (!j) return;
    const now = Date.now();
    // Continuous weave (music never stops): automation NEVER fades a deck — the outgoing rides its own
    // mastered tail to its natural end under the jingle, and the instant it ends the incoming enters at
    // full UNDER the jingle's remaining tail. No jingle-alone gap — outgoing-tail · jingle · incoming-head.
    j.nextStart = now;
    j.outgoingEndedAt = now;
    j.phase = "bridging";
    this._log(`jingle BRIDGING — deck ${deckId} ended; incoming enters now under the jingle tail (continuous weave)`);
  }

  // Routine segue OVERLAP brain (poll-driven, never throws into playout). The whole feature: when the
  // playing deck has ≤ segueOverlap seconds left and the next deck is ready, start the incoming NOW at
  // full over the outgoing's natural tail. Both play; the outgoing ends on its own (songs carry their
  // own mastered fade-outs). NO fades — automation never touches a fader. Works on jingle seams too: the
  // early start overlaps under the firing jingle. We only wait if a jingle is still ARMED (not yet
  // firing) on this deck — starting the incoming would bump the on-air generation and supersede the
  // armed jingle before it fires; once it's firing, the incoming may start and overlap the tail.
  _segueTick(now) {
    try {
      if (!this._started || !(this.segueOverlap > 0)) return;
      const P = ["A", "B", "C"].find(d => this._deckState(d).status === "playing");
      if (!P) return;
      const st = this._deckState(P);
      const remaining = (st.durationSec || 0) - (st.positionSec || 0);
      if (!(remaining > 0 && remaining <= this.segueOverlap)) return;
      if (this.segueTriggered.has(P)) return;
      if (this._jingle && this._jingle.deck === P && this._jingle.phase === "armed") return; // let it fire first
      const nextDeck = this._nextRotateDeck(P);
      if (!(nextDeck && this.deckReady.has(nextDeck))) return;
      this.segueTriggered.add(P);
      this._log(`segue overlap: ${P}→${nextDeck} — incoming starts ${this.segueOverlap}s early over ${P}'s tail (no fade)`);
      this.handleRotate(P, nextDeck);
    } catch (e) { this._log("segueTick error (playout unaffected): " + String(e)); }
  }

  // The one poll-driven jingle brain. Never throws into playout.
  _jingleTick(now) {
    try {
      if (!this._started) { if (this._jingle) this._clearJingle("automation-stopped"); this._clearScheduled("automation-stopped"); return; }
      const order = ["A", "B", "C"];
      const j = this._jingle;

      if (j) {
        if (j.phase === "armed") {
          if (this._jingleSuperseded(j)) { this._cancelJingle("superseded"); return; }
          const st = this._deckState(j.deck);
          const remaining = (st.durationSec || 0) - (st.positionSec || 0);
          if (remaining <= j.leadIn) this._fireJingle(j);   // FIRE on the advance chain
          return;
        }
        // firing / bridging
        const flowing = this._cartFlowing();
        if (flowing) {
          this._lastPlayingAt = now;                        // watchdog: the bridge is NOT a stall
          if (!j.firingConfirmedAt) { j.firingConfirmedAt = now; this._emitJingle("FIRING", j); this._logJinglePlay(j); this._log(`jingle FIRING (samples flowing) — "${j.title}"`); }
        }
        // If we NEVER observe flow, we simply never confirm FIRING: no health/log stamp (observed-only) and
        // no seam bridge (_jingleShouldBridge requires firingConfirmedAt) → the NORMAL rotation proceeds and
        // the jingle audio just plays out unlogged. We deliberately do NOT stop CART on non-observation —
        // that would truncate a jingle whose flow our conservative detector merely missed. The entry clears
        // at jingleDoneMs below.
        if (j.phase === "bridging" && now >= j.nextStart) {
          // Start the incoming deck now (underlap before the jingle ends). Reuse the proven rotate paths.
          const to = this._nextRotateDeck(j.deck);
          if (to) this.handleRotate(j.deck, to); else this.handleLoadNext(order[(order.indexOf(j.deck) + 1) % 3]);
          j.phase = "closing";
        }
        // Clear once a rotation deck is live again (incoming took over) OR the jingle audio is well past end.
        const jingleDoneMs = j.firedAt ? j.firedAt + j.jinDur * 1000 + 500 : now;
        if (order.some(d => this._deckState(d).status === "playing") && (j.phase === "closing" || now >= jingleDoneMs)) {
          this._clearJingle("done");
        }
        return;
      }

      // No active jingle → maintain the read-ahead SCHEDULED hint, and arm once inside the window.
      const P = order.find(d => this._deckState(d).status === "playing");
      if (!P) { this._clearScheduled("no-deck"); return; }
      const st = this._deckState(P);
      const remaining = (st.durationSec || 0) - (st.positionSec || 0);
      const afterTs = this.deckSched[P];
      if (!(remaining > 0) || afterTs == null) { this._clearScheduled("unscheduled"); return; }  // non-scheduled row → no seam
      const nextDeck = this._nextRotateDeck(P);
      const beforeTs = (nextDeck && this.deckSched[nextDeck] != null)
        ? this.deckSched[nextDeck]
        : (afterTs + Math.ceil(remaining) + 2);

      if (remaining <= DaemonEngine._ARM_WINDOW_S) {
        // Inside the arm window: hand the read-ahead off to the armed lifecycle with a FRESH read (truth
        // beats a possibly-stale hint if the schedule changed since song start). Promotion, not a retire —
        // null the hint WITHOUT a CLEARED so the indicator flips grey → white in the same tick, no gap.
        const jin = loggen.readJingleForSeam(this.db, this.stationId, afterTs, beforeTs, this._firedJinRows.slice(-100));
        if (!jin) { this._clearScheduled("no-seam"); return; }
        if (!this._fileOk(jin.filePath)) { this._noteFiredRow(jin.rowId); this._clearScheduled("dead-file"); return; }  // dead jingle file → skip, don't arm
        this._scheduled = null; this._scheduledSig = "";
        this._armJingle(jin, P);
        return;
      }

      // Outside the arm window: persistent SCHEDULED (grey) read-ahead. Re-query only when the seam
      // identity (deck + window bounds) changes — at most one DB read per song, never per tick.
      const sig = `${P}:${afterTs}:${beforeTs}`;
      if (this._scheduledSig !== sig) {
        this._scheduledSig = sig;
        const jin = loggen.readJingleForSeam(this.db, this.stationId, afterTs, beforeTs, this._firedJinRows.slice(-100));
        if (jin && this._fileOk(jin.filePath)) this._setScheduled(jin, P);
        else this._clearScheduledEmitOnly("none");   // keep sig (don't re-query) but retire any shown hint
      }
    } catch (e) { this._log("jingleTick error (playout unaffected): " + String(e)); }
  }

  // Read-ahead SCHEDULED (grey) indicator — display-only, never touches playout. Emits once per identity.
  _setScheduled(jin, deck) {
    const prev = this._scheduled;
    if (prev && prev.rowId === jin.rowId && prev.deck === deck) return;   // unchanged → no re-emit
    this._scheduled = {
      rowId: jin.rowId, deck, title: jin.title, artist: jin.artist,
      contentClass: jin.contentClass === "SWP" ? "SWP" : "JIN",
      categoryId: jin.jingleCategoryId, leadIn: jin.leadInSec, underlap: jin.underlapSec,
      jinDur: (jin.durationMs || 0) / 1000,
    };
    this._log(`${this._scheduled.contentClass} SCHEDULED — "${jin.title}" for deck ${deck}'s upcoming seam (read-ahead)`);
    this._emitJingle("SCHEDULED", this._scheduled);
  }
  // Retire a shown SCHEDULED hint AND reset the query signature (so the next tick re-looks-ahead).
  _clearScheduled(reason) {
    this._scheduledSig = "";
    this._clearScheduledEmitOnly(reason);
  }
  // Retire a shown SCHEDULED hint but leave the signature intact (caller manages re-query cadence).
  _clearScheduledEmitOnly(reason) {
    const had = this._scheduled;
    if (!had) return;
    this._scheduled = null;
    this._log(`jingle SCHEDULED retired (${reason}) — "${had.title}"`);
    this._emitJingle("CLEARED", had);
  }

  // Fire the armed jingle on CART — serialized on the advance chain (no naked timer), re-validated inside.
  _fireJingle(j) {
    this._advance("jingle-fire", async () => {
      if (this._jingle !== j || j.phase !== "armed") return;         // superseded/cleared while queued
      if (this._jingleSuperseded(j)) { this._cancelJingle("superseded-at-fire"); return; }
      let ok;
      try { ok = this._load("CART", j.filePath, j.title, j.artist, 0); }
      catch (e) { this._cancelJingle("load-error"); return; }
      if (ok === false) { this._cancelJingle("load-failed"); return; }
      this._play("CART");
      const d = this._dur(j.filePath); if (d > 0) j.jinDur = d;
      j.firedAt = Date.now();
      j.phase = "firing";
      this._jingleCartGen++;
      this._log(`jingle FIRE issued — "${j.title}" on CART (dur=${(j.jinDur || 0).toFixed(1)}s); confirming samples…`);
    });
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
    this._log("skip: deck " + next + " LIVE — " + (this._deckState(next).title || "(untitled)"));
    if (playing && playing !== next) this._stop(playing);
    setTimeout(() => this.preload(order[(order.indexOf(next) + 1) % 3], 0), 600);
    return true;
  }
}

module.exports = { DaemonEngine };
