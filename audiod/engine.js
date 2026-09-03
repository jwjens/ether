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
const autofit = require("./autofit");   // §2.7 auto-fitter — OBSERVATION ONLY this release (writes nothing)
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
const SAFETY_CUT_MS = 300;   // operator skip: outgoing off in ~300ms, not the 3s musical overlap
const LOG_READER_FLIP = process.env.ETHER_LOG_READER === "1";   // DEV global override (forces ALL stations on)
// Rider A slack (§2.7): AHEAD airs the next row EARLY silently within this window; beyond it, a health
// event fires (still never waits, never dead-airs — music floats forward).
const FLIP_AHEAD_SLACK_SEC = 120;

// Sustained no-playing window before "nobody playing" is treated as a real stall (rides out a
// crossfade / load-next handoff). Shared by the stall-recovery watchdog AND the honest engine-state
// truth layer (Slice 1) so both judge "stalled" by the SAME criterion — no second, divergent detector.
const STALL_MS = 1000;

// ── SAMPLE CLOCK (2026-08-09) ─────────────────────────────────────────────────────────────────────
// Position was extrapolated from Date.now() on both sides of the process boundary, so the playhead
// drifted from the audio it claimed to describe. Rust now counts the frames it actually pulls from
// each deck (DeckSlot.frames_played) and publishes them per-deck on the levels payload; that count
// is the AUTHORITY and wall-clock is the fallback. Both run side by side for one release so the
// drift can be measured before the wall-clock path is deleted.
// docs/sample-accurate-position-design-2026-08-09.md
const PROGRAM_RATE = 44100;
// Escape hatch: force the legacy wall-clock authority without a rebuild (drift is still computed
// and logged, so this stays diagnosable while it is engaged).
const POSITION_WALL_FORCE = process.env.ETHER_POSITION_WALL_FORCE === "1";
// Levels older than this are not an authority — poll() falls back and SAYS so.
const FRAMES_STALE_MS = 2000;
// Per-deck throttle for the drift line, so a diverging deck cannot flood the log.
const DRIFT_LOG_MS = 5000;

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
    // Content class of the row loaded on each deck (MUSIC/SPOT/JIN…). A SPOT is exclusive PROGRAM content
    // and gets CLEAN EDGES — never the segue overlap, never a jingle over/into it (Jeff's broadcast ruling,
    // 2026-07-23). Set at loadToDeck (the single load funnel); null = unknown/none.
    this.deckContentClass = { A: null, B: null, C: null };
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
    // ── liveDeck OBSERVER (2026-07-29, observation-only) ─────────────────────────────────────────
    // The deck the engine ACTUALLY put on air, set by _play(). This exists because every consumer
    // today derives "the playing deck" by ALPHABETICAL SCAN — `["A","B","C"].find(playing)` in
    // _segueTick/_jingleTick — which silently hands P to whichever letter sorts first when a deck
    // starts outside the advance chain. On 2026-07-29 station 4 that flipped C→A mid-song: C was
    // never any rotate's fromId, so no deferred stop was ever armed and two decks aired for 85s
    // with nothing in the log (docs/station4-double-play-root-cause-2026-07-29.md).
    // THIS RELEASE OBSERVES ONLY. liveDeck is read by nothing but the observer below — P is
    // untouched, no rotate/stop/timing path consults it, and nothing is ever stopped on its word.
    this.liveDeck = null;
    this._foreignSince = 0;      // when the current foreign-deck condition started (0 = none)
    this._foreignLastLogAt = 0;  // last anomaly line emitted, for the re-log cadence
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
  _mixHeartbeat(now, s, lv) {
    try {
      const anyPlaying = ["deckA", "deckB", "deckC"].some((d) => s && s[d] && s[d].status === "playing");
      if (!anyPlaying) return;                                  // idle/stalled → stay quiet
      if (now - (this._lastMixLogAt || 0) < 5000) return;      // 5s cadence
      if (!lv) return;                                          // levels read failed this tick
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

  // ── SAMPLE CLOCK: read + stash ────────────────────────────────────────────────────────────────
  // One levels read per poll tick. Stashes the per-deck frame counts with an arrival stamp so
  // _derivePosition can tell "fresh" from "the addon stopped answering" and degrade OUT LOUD
  // rather than quietly serving a stale number as if it were measured.
  // Returns the parsed levels (also reused by the [mix] heartbeat) or null on failure.
  _readLevels(now) {
    let lv;
    try { lv = JSON.parse(A.audioGetLevels(this.stationId)); } catch { return null; }
    if (lv && Array.isArray(lv.decks)) {
      const f = {};
      for (const d of lv.decks) {
        if (d && d.id && typeof d.frames_played === "number") f[d.id] = d.frames_played;
      }
      this._deckFrames = f;
      this._deckFramesAt = now;
    }
    return lv;
  }

  // ── SAMPLE CLOCK: the position authority ──────────────────────────────────────────────────────
  // Returns { positionSec, positionSecWall, positionDriftMs } for one deck.
  //
  //   positionSec      the AUTHORITY — frames Rust actually pulled / 44100, when trustworthy
  //   positionSecWall  the legacy Date.now() estimate, kept for one release so the drift the flip
  //                    removes can be MEASURED rather than asserted
  //   positionDriftMs  sample − wall. Observability only; never a gate.
  //
  // Falls back to wall-clock when the frames are stale or absent. Every change of authority emits
  // a health event with a reason — a silent degrade would look exactly like a working sample clock.
  _derivePosition(id, live, durSec, elapsed, now) {
    const st   = this._deckState(id);
    const stat = (live && live.status) || st.status;
    const wall = stat === "playing"
      ? Math.min(st.positionSec + elapsed, durSec || 9999)
      : st.positionSec;

    const fresh  = this._deckFramesAt && (now - this._deckFramesAt) < FRAMES_STALE_MS;
    const raw    = fresh && this._deckFrames ? this._deckFrames[id] : undefined;
    const sample = typeof raw === "number" ? raw / PROGRAM_RATE : null;

    // A deck that just started legitimately reads ~0 for a tick or two, so a bare 0 is only
    // suspicious once we already believed we were more than a second into the track.
    let useSample = sample !== null && !(sample === 0 && stat === "playing" && st.positionSec > 1);
    if (POSITION_WALL_FORCE) useSample = false;

    const driftMs = sample !== null ? (sample - wall) * 1000 : null;

    if (!this._posAuth) this._posAuth = {};
    const prev = this._posAuth[id];
    if (!prev || prev.useSample !== useSample) {
      const reason = POSITION_WALL_FORCE ? "forced-wall-clock"
                   : useSample           ? "sample-clock-restored"
                   : !fresh              ? "levels-stale"
                                         : "counter-zero-while-playing";
      try {
        // Rides the established loud-event family that main.js appends to health-events.jsonl
        // (alongside logreader-floor / fill-starved / separation-relaxed). A brand-new event name
        // would have no consumer and the "observability" would be decorative.
        this.emit("position-authority", {
          deck: id, authority: useSample ? "sample" : "wall", reason,
          sampleSec: sample, wallSec: wall, driftMs, ts: now,
        });
      } catch { /* observation must never break a tick */ }
      this._log(`position authority ${id} → ${useSample ? "SAMPLE" : "WALL"} (${reason})`);
    }
    this._posAuth[id] = { useSample };

    if (driftMs !== null && Math.abs(driftMs) > 50) {
      if (!this._driftAt) this._driftAt = {};
      if (now - (this._driftAt[id] || 0) > DRIFT_LOG_MS) {
        this._driftAt[id] = now;
        this._log(`position drift ${id}: sample=${sample.toFixed(3)}s wall=${wall.toFixed(3)}s d=${driftMs.toFixed(0)}ms`);
      }
    }

    return { positionSec: useSample ? sample : wall, positionSecWall: wall, positionDriftMs: driftMs };
  }

  // Audio Processing v1 — deliver the per-station program-bus processing state to the mixer (segue
  // pattern). proc_local / proc_stream / proc_target_lufs live in station_config_kv (per-station,
  // synced); the Settings→Broadcast toggles write them. Read cached 3s (poll-driven), and push to the
  // native mixer via audioSetProcessing whenever the applied triple CHANGES — so it lands on connect,
  // re-lands after a daemon respawn (fresh engine → _procApplied null → first poll applies), and picks
  // up a live toggle within ~3s. While ON, re-assert every 15s so an apply dropped during a device
  // reopen (SetProcessing no-ops in the no-device window) self-heals. Both toggles default OFF →
  // audioSetProcessing(false,false,…) → native takes the CLEAN tap → bit-identical passthrough.
  _applyProcessingFromKv(now) {
    if (now - (this._procCheckedAt || 0) < 3000) return;
    this._procCheckedAt = now;
    let local = false, stream = false, target = -14.0;
    try {
      const rows = this.db.prepare(
        "SELECT key, value FROM station_config_kv WHERE station_id=? AND key IN ('proc_local','proc_stream','proc_target_lufs') AND deleted_at IS NULL"
      ).all(this.stationId);
      for (const r of rows) {
        if (r.key === "proc_local") local = (r.value === "1" || r.value === "true");
        else if (r.key === "proc_stream") stream = (r.value === "1" || r.value === "true");
        else if (r.key === "proc_target_lufs") { const t = parseFloat(r.value); if (!isNaN(t)) target = Math.max(-30, Math.min(-6, t)); }
      }
    } catch { return; }   // KV unreadable → leave the last-applied state untouched; never disturb playout
    const prev = this._procApplied;
    const changed = !prev || prev.local !== local || prev.stream !== stream || prev.target !== target;
    const reassert = (local || stream) && (now - (this._procAssertedAt || 0) > 15000);
    if (!changed && !reassert) return;
    this._procApplied = { local, stream, target };
    this._procOn = local || stream;
    this._procAssertedAt = now;
    try { A.audioSetProcessing(this.stationId, local, stream, target); if (changed) this._log("processing", `local=${local} stream=${stream} target=${target}`); }
    catch (e) { this._log("processing apply ✗", String(e)); }
  }

  // Dedicated processing-meters emit (~15Hz). Its OWN event ("procmeters"), NOT the levels channel —
  // levels already runs ~90/s and is implicated in a renderer OOM, so this rides a separate, lower-rate
  // channel gated to ON. Quiet unless processing is on AND automation is engaged (no silence spam). The
  // meters are OBSERVED at the stage taps (in/out LUFS, gain-reduction, in/out peak) — never claimed.
  // RETAINED for audiod/smoke-manual-mode.js, which calls it directly to assert it is not gated on
  // automation. Nothing schedules it any more — the daemon's station loop is the live emitter.
  _emitProcMeters() {
    // NOT gated on _started (2026-07-31): meters are the jock's level check, and MANUAL is exactly when
    // a human is watching them. Processing is still running in MANUAL, so reporting it is honest.
    if (!this._procOn) return;
    let lv; try { lv = JSON.parse(A.audioGetLevels(this.stationId)); } catch { return; }
    if (!lv || (!lv.proc_local && !lv.proc_stream)) return;   // native says processing off → stay quiet
    const dbfs = (p) => (p > 0 ? Math.max(-70, 20 * Math.log10(p)) : -70);
    try {
      this.emit("procmeters", {
        stationId: this.stationId,
        local: !!lv.proc_local, stream: !!lv.proc_stream,
        target: lv.proc_target_lufs ?? -14,
        inLufs: lv.proc_in_lufs ?? -70, outLufs: lv.proc_out_lufs ?? -70,
        grDb: lv.proc_gr_db ?? 0,
        // The RIDE's applied gain (signed): + boosting quiet material, - pulling loud material down.
        // This is what the meter bars show — grDb is the LIMITER's reduction and sits at 0 at steady
        // state by design, which made a bar bound to it look permanently broken (2026-08-01).
        rideGainDb: lv.proc_ride_gain_db ?? 0,
        inPeakDb: dbfs(lv.proc_in_peak ?? 0), outPeakDb: dbfs(lv.proc_out_peak ?? 0),
        // DECK (aux) PROCESSING — the same four measurements, from the aux bus's own instance of the
        // same processor, on THIS frame rather than a second channel. The Health Monitor renders it
        // with the identical component; there is one processing system and one meter grammar.
        // Present only when an aux deck is actually feeding, so "no deck processing" stays
        // distinguishable from "deck processing at silence".
        aux: (lv.aux_peak ?? 0) > 0 || (lv.aux_proc_out_lufs ?? -70) > -69 ? {
          inLufs: lv.aux_proc_in_lufs ?? -70,
          outLufs: lv.aux_proc_out_lufs ?? -70,
          grDb: lv.aux_proc_gr_db ?? 0,
          rideGainDb: lv.aux_proc_ride_db ?? 0,
          // The aux bus reports its own peak; there is no separate in/out peak tap on it, so both
          // columns read the one measured value rather than inventing a second.
          inPeakDb: dbfs(lv.aux_peak ?? 0), outPeakDb: dbfs(lv.aux_peak ?? 0),
        } : null,
      });
    } catch { /* never break playout for a meter frame */ }
  }

  // ── addon wrappers (synchronous) ──
  _load(deck, fp, title, artist, gainDb) { return A.audioLoad(deck, fp, title || "", artist || "", gainDb ?? 0, this.stationId); }
  // Pure + testable: which deck ids are rotation decks. CART is the jingle overlay, not a rotation deck.
  _isRotationDeck(deck) { return deck === "A" || deck === "B" || deck === "C"; }
  // A deck plays at whatever fader the OPERATOR set — automation NEVER moves a deck fader (those are
  // operator controls). Just clear the overlap guard so this deck's next seam can early-start again.
  // liveDeck observer (2026-07-29): also record the deck the engine itself put on air. Every path that
  // puts a MUSIC deck live funnels through here — handleRotate, load-next, play-now, skip, top-of-hour,
  // resume-playout, automationStart — so this one assignment covers all of them with no per-site edits.
  // Bookkeeping only: the audioPlay call is unchanged and nothing reads liveDeck except the observer.
  _play(deck) {
    if (this._isRotationDeck(deck)) this.liveDeck = deck;
    this.segueTriggered.delete(deck); return A.audioPlay(deck, this.stationId);
  }
  _stop(deck) { try { return A.audioStop(deck, this.stationId); } catch {} }
  _state() { try { return JSON.parse(A.audioGetState(this.stationId)); } catch { return null; } }
  _dur(fp) { try { return A.getFileDuration(fp); } catch { return 0; } }

  // ── lifecycle ──
  init() {
    A.initAudioEngine(this.stationId);
    if (!this.pollTimer) { this.processingEnd = false; this.pollTimer = setInterval(() => this.poll(), 250); }
    // Audio Processing meters are NO LONGER emitted here (2026-08-19). They rode this timer, which
    // exists only for stations that have an automation engine — so a station playing only the jukebox
    // (jukebox:play talks to the addon directly and creates no engine) reported nothing, and the panel
    // read "waiting for audio" while the processor was working. The emit now lives in the daemon's
    // station loop, gated on the PROCESSOR's own state. One writer, and it does not care whether
    // automation is running.
  }
  // ── MANUAL MODE (2026-07-31) — stop DECIDING, never stop RUNNING ───────────────────────────────
  // This used to tear the engine down: it cleared the poll timer and stopped all three decks. That made
  // MANUAL unusable for a live jock — Rust's Stop drops the sink AND loaded_files, so every deck was
  // EMPTY, a hand-pressed play hit `source=None … skipping` and produced dead air, and with the poll
  // dead no deck event could ever correct the UI's optimistic "playing".
  // (docs/manual-mode-dead-air-trace-2026-07-31.md, docs/design-manual-mode-contract-2026-07-31.md)
  //
  // THE CONTRACT: press MANUAL mid-song and the song keeps playing, because nothing tells it to stop.
  // Automation stops deciding — see _mayDecide() — and the engine keeps running: poll, deck events,
  // meters, telemetry and the two-decks observer all continue, so the jock's UI stays live.
  //
  // "Stop automating" and "silence the station" are now TWO VERBS. This is the first; `stopAll`
  // (ether-audiod.js) is the second and stops the decks explicitly. Nothing may depend on the old
  // conflation. Timer teardown belongs to dispose(), called only on daemon shutdown.
  stop() {
    if (this._started) this._log("_started: true → false (automation stopped — MANUAL: decks and poll left running)");
    this._started = false;
  }

  /** Real teardown — daemon shutdown ONLY. Never on automationStop: a jock pressing MANUAL must not
   *  lose the poll loop (deck events, meters, the liveDeck observer all ride on it). */
  dispose() {
    this._started = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this._procMeterTimer) { clearInterval(this._procMeterTimer); this._procMeterTimer = null; }
  }

  /** THE SINGLE CHOKE POINT — may automation make decisions right now? MANUAL = no.
   *  The engine keeps RUNNING either way; this gates only the paths that CHOOSE what airs.
   *  Per-station by construction (_started is per-engine): one station in MANUAL leaves the other
   *  three deciding, untouched. */
  _mayDecide() { return this._started; }

  _deckState(id) { return id === "A" ? this.stateA : id === "B" ? this.stateB : this.stateC; }
  _setDeck(id, patch) {
    if (id === "A") this.stateA = { ...this.stateA, ...patch };
    else if (id === "B") this.stateB = { ...this.stateB, ...patch };
    else if (id === "C") this.stateC = { ...this.stateC, ...patch };
  }

  /** THE ONE PATH THAT CHANGES A DECK'S OCCUPANT (2026-08-02).
   *
   *  Every identity-bearing field is replaced together from ONE track object — title, artist, filePath,
   *  duration, contentClass, schedule identity — and position is reset. No caller can produce a deck
   *  showing one track's title with another's duration or class, because no caller sets them separately.
   *
   *  This exists because two paths used to change an occupant and only one of them set everything:
   *  the automation loadToDeck did it correctly, while the inbound `load` command (a library drag, a
   *  queue click, JockStrip, cart assign — every renderer-initiated load in daemon mode) called
   *  audioLoad + noteManualCue and left contentClass and duration belonging to the PREVIOUS track.
   *
   *  `durationSec` is 0 when unknown. It is NEVER inherited — an unknown duration is honest; a stale one
   *  freezes the countdown. And it is never read from audio_get_state: Rust carries no duration, which
   *  is what made the withdrawn §3 fix wrong.
   */
  _setDeckTrack(id, track) {
    const t = track || {};
    const filePath = t.filePath || "";
    let durationSec = Number.isFinite(t.durationSec) ? t.durationSec
      : (Number.isFinite(t.durationMs) ? t.durationMs / 1000 : 0);
    if (!(durationSec > 0) && filePath) {
      const d = this._dur(filePath);            // getFileDuration — the ONLY other honest source
      if (d > 0) durationSec = d;
    }
    this.deckContentClass[id] = t.contentClass || null;   // set on every occupant change; never inherited
    this.deckSched[id]   = t.scheduledAt ?? null;
    this.deckSchedId[id] = t.schedId ?? null;
    this.deckGen[id] = (this.deckGen[id] || 0) + 1;       // Bug-A: a fresh source invalidates a pending stop
    this.endTriggered.delete(id);
    this._setDeck(id, {
      title: t.title || "", artist: t.artist || "", filePath,
      durationSec, positionSec: 0, status: t.status || "idle", volume: t.volume ?? 1,
    });
    return durationSec;
  }

  // ── poll (mirrors engine-rodio poll + checkEndByPosition) ──
  poll() {
    const s = this._state();
    if (!s) return;
    const now = Date.now();
    const elapsed = (now - this.lastPollTime) / 1000;
    this.lastPollTime = now;

    // SAMPLE CLOCK — one levels read per tick, shared by the position authority below and the
    // [mix] heartbeat. Deliberately NOT piggybacked on the heartbeat's own call: that one runs on
    // a 5s cadence and returns early when idle, which would leave the frame counts stale on nearly
    // every tick and pin the authority to the wall-clock fallback we are replacing.
    const lv = this._readLevels(now);
    this._mixHeartbeat(now, s, lv);   // v4.4.46: diagnostic [mix sN] line every 5s while playing (no-op otherwise)
    this._applyProcessingFromKv(now);   // Audio Processing v1: deliver proc_local/proc_stream/target from KV (segue pattern)

    const prev = { A: this.stateA.status, B: this.stateB.status, C: this.stateC.status };
    // ── IDENTITY-KEYED CARRY (2026-08-02) ───────────────────────────────────────────────────────────
    // Rust supplies NO duration (DeckMeta::info has no duration_sec — see the withdrawn §3 lesson), so
    // duration MUST be carried between ticks. What it must never do is outlive its track: this used to
    // re-impose the previous tick's duration unconditionally, so a deck whose occupant changed showed
    // the NEW title with the OLD duration — position then clamped there, _changed() saw nothing move,
    // and the countdown froze. Live reproducer: a track loaded onto a deck holding an 0:11 spot read
    // "Jack's Lament 0:11/0:11" with the spot's gold class.
    // (docs/deck-state-mixing-reproducer-2026-08-02.md)
    //
    // The carry is now keyed on filePath — the deck's identity. Same file → keep the duration we know;
    // different file → 0 (unknown) until the load path supplies one, never the previous track's number.
    const carryDur = (id, live) => {
      const prev = this._deckState(id);
      const nextPath = (live && (live.file_path ?? live.filePath)) || "";
      return nextPath && nextPath === prev.filePath ? prev.durationSec : 0;
    };
    const dur = { A: carryDur("A", s.deckA), B: carryDur("B", s.deckB), C: carryDur("C", s.deckC) };
    // SAMPLE CLOCK — position now comes from the frames Rust actually pulled, with the wall-clock
    // estimate carried alongside as positionSecWall for the parallel-run window.
    const dA = this._derivePosition("A", s.deckA, dur.A, elapsed, now);
    const dB = this._derivePosition("B", s.deckB, dur.B, elapsed, now);
    const dC = this._derivePosition("C", s.deckC, dur.C, elapsed, now);
    const pos = { A: dA.positionSec, B: dB.positionSec, C: dC.positionSec };
    this.stateA = { ...makeState("A", s.deckA), durationSec: dur.A, ...dA };
    this.stateB = { ...makeState("B", s.deckB), durationSec: dur.B, ...dB };
    this.stateC = { ...makeState("C", s.deckC), durationSec: dur.C, ...dC };

    // liveDeck GUARD: at most one rotation deck audible. Sits HERE, immediately after the deck states
    // are rebuilt from Rust and BEFORE any decision work, so a throw anywhere later in the tick can
    // never skip it — the 2026-07-30 incidents ran ~50s each with nothing else able to end them. It
    // reads the freshest state and does its stop on the advance chain, never inline.
    this._liveDeckObserverTick(now);

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
    if (this._jingle && this._jingle.firingConfirmedAt && this._cartFlowing(this._jingle.channels)) return "live";
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
    // D3 (2026-08-03): carry `started` — whether AUTOMATION is engaged — so the renderer can paint
    // AUTO/MANUAL from OBSERVED daemon state instead of its own KV memory. The UI showed AUTO lit
    // while _started was false, contradicting the live engine on the same screen.
    this.emit("enginestate", { stationId: this.stationId, state: next, started: !!this._started });
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
    // IDENTITY FIRST (2026-08-02): a track change must ALWAYS emit, whatever position does. The frozen
    // countdown was position clamped at a stale duration so nothing here moved and the UI stopped being
    // told anything. filePath/title are the identity; they are checked before any position arithmetic.
    if (prev.filePath !== next.filePath || prev.title !== next.title) return true;
    return prev.status !== next.status ||
      Math.floor(prev.positionSec) !== Math.floor(next.positionSec) || prev.durationSec !== next.durationSec ||
      prev.volume !== next.volume;   // fader truth: re-emit on any volume change so the UI can never lag it
  }
  /** D4 ADOPT — re-emit ALL three decks unconditionally, through the SAME `deck` event the poll uses.
   *  Deck events are normally emitted only on CHANGE (_maybeEmitDeck), so a renderer that attaches late
   *  — the cold-stage race, where the ~307 MB engine stage outruns the app's connect window — subscribes
   *  to a stream that then says nothing until the next track change. Its decks stayed empty until the
   *  app was restarted, which is the entire "close and reopen once" ritual.
   *  Source is the ENGINE's own deck state (duration set by _setDeckTrack) plus the authoritative
   *  scheduledAt/contentClass maps — NEVER raw Rust DeckInfo, which carries no duration and would paint
   *  a 0:00 countdown on every deck (the 4.4.104 regression). Identical payload to _maybeEmitDeck, so
   *  every existing listener applies it with no new plumbing.
   *  Also refreshes lastFired/lastReady so this re-emit cannot make the next poll double-fire. */
  emitDeckSnapshot() {
    const decks = [];
    for (const id of ["A", "B", "C"]) {
      const st = this._deckState(id);
      const ready = this.deckReady.has(id);
      this.emit("deck", { stationId: this.stationId, deck: id, state: { ...st, scheduledAt: this.deckSched[id] ?? null, contentClass: this.deckContentClass[id] ?? null }, ready });
      this.lastFired[id] = st;
      this.lastReady[id] = ready;
      decks.push({ deck: id, title: st.title || "", filePath: st.filePath || "", durationSec: st.durationSec || 0, status: st.status, ready });
    }
    // CART/jingle deliberately NOT snapshotted: the overlay rides its own `jingle` event as a transient
    // arm/fire/bridge LIFECYCLE (_emitJingle), not standing state — there is no "current jingle" field to
    // re-emit, and inventing an "idle" would be a claim the engine never made. An adopting renderer picks
    // up the overlay at the next arm, which is at most one seam away.
    // Automation state rides the adopt as well — otherwise an attaching renderer knows the decks but
    // not whether automation is engaged, and would have to fall back to KV (the defect D3 removes).
    try { this.emit("enginestate", { stationId: this.stationId, state: this._engineState || "off", started: !!this._started }); } catch {}
    this._log("adopt: deck snapshot re-emitted (A/B/C) + automation state for a (re)attaching renderer");
    return { ok: true, stationId: this.stationId, decks };
  }

  _maybeEmitDeck(id) {
    const st = this._deckState(id);
    const ready = this.deckReady.has(id);
    // Stage 0: deck events now carry deckReady (cued/ready) so the renderer can mirror cued state
    // instead of guessing. Emit on a status/title/position change OR a ready flip.
    if (this._changed(this.lastFired[id], st) || this.lastReady[id] !== ready) {
      // contentClass rides the deck event so the UI can flash a SPOT-holding deck (clean-edges sibling):
      // sourced from the authoritative per-deck class map (set at loadToDeck), not the render state.
      this.emit("deck", { stationId: this.stationId, deck: id, state: { ...st, scheduledAt: this.deckSched[id] ?? null, contentClass: this.deckContentClass[id] ?? null }, ready });
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
    // MANUAL: no refill, and above all no preload — the self-heal must never load over a deck the jock
    // cued by hand. (The second of the two paths that were ungated before 2026-07-31.)
    if (!this._mayDecide()) return;
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
    // MANUAL: automation does not decide what follows. A deck ending is the jock's business — no
    // end-detection, therefore no handleRotate. (One of the two paths that were ungated before 2026-07-31.)
    if (!this._mayDecide()) return;
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

  // Bug-A guard (2026-07-22): decide the deferred post-crossfade stop for an outgoing deck. Pure +
  // testable (audiod/smoke-seam-stop.js). Returns:
  //   'skip-reloaded' — a fresh source was loaded onto this deck since the rotate (deckGen bumped); the
  //                     deferred stop must NEVER wipe it.
  //   'skip-target'   — this IS the deck we rotated INTO; never stop the incoming/live deck.
  //   'stop'          — same outgoing source, not the target → STOP it, even if it still reports
  //                     "playing" (a still-playing outgoing deck past the grace is the overlap/leak the
  //                     stop exists to clear). The old code returned early on status==="playing", which
  //                     let a delayed stop leak a decoding deck — this is the fix.
  _outgoingStopAction(fromId, fromGen, toId) {
    if (this.deckGen[fromId] !== fromGen) return "skip-reloaded";
    if (fromId === toId) return "skip-target";
    return "stop";
  }

  // The outgoing deck's stop delay for an OPERATOR safety skip. The routine musical segue keeps
  // crossfadeDuration (3s of overlap); a panic press must not leave the offending audio up that long.
  // (docs/auto-xfade-contract-trace-2026-08-02.md clause 1)
  handleRotate(fromId, toId, opts) {
    this._advance("handleRotate", async () => { await this._rotateBody(fromId, toId, opts); });
  }

  /** The rotate itself — shared by automation's handleRotate and the operator's start/skip. MUST be
   *  called from inside _advance (both callers are). Guards unchanged: spurious-end, play-skip, the
   *  deferred Bug-A stop. `opts.cutMs` overrides the outgoing stop delay; preloads are gated on
   *  _mayDecide() so nothing auto-cues in MANUAL. */
  async _rotateBody(fromId, toId, opts) {
    {
        const live = this._state();
        const liveTo = live ? (toId === "A" ? live.deckA : toId === "B" ? live.deckB : live.deckC) : null;
        const otherPlaying = live ? (
          (fromId !== "A" && live.deckA?.status === "playing") ||
          (fromId !== "B" && live.deckB?.status === "playing") ||
          (fromId !== "C" && live.deckC?.status === "playing")) : false;
        if (liveTo?.status === "playing" || otherPlaying) return false; // spurious-end guard (absorbed)
        // Play-skip guard (Bug A safety net): only segue to a deck that truly holds a loaded source
        // (deckReady is now authoritative — the deferred stop below clears it). If it doesn't, never
        // silently play an empty deck (the "[RUST] Play … source=None … skipping" dead-air) — emit a
        // LOUD error and reload this deck from the queue, then rotate into it once it's ready.
        if (!this.deckReady.has(toId) && this._deckState(toId).status !== "playing") {
          this._log("play-skip GUARD: deck " + toId + " has no ready source — reloading instead of silent skip");
          this.emit("error", { stationId: this.stationId, where: "play-skip", deck: toId, error: "source missing at rotate — reloading deck " + toId });
          setTimeout(() => { this.preload(toId, 0).then(() => { if (this.deckReady.has(toId)) this.handleRotate(fromId, toId); }); }, 0);
          return false;
        }
        this._play(toId);
        const cfMs = Number.isFinite(opts && opts.cutMs) ? opts.cutMs : this.crossfadeDuration * 1000;
        // Bug A (source-wipe race): run the outgoing deck's post-crossfade stop ON the advance chain
        // (serialized with preload) and GUARD it — skip if the deck was re-loaded since (deckGen changed)
        // or went live again; when it does stop, clear deckReady/endTriggered so a nulled Rust source can
        // never be left marked "ready" (the stale-ready → silent source=None play). Replaces the old
        // floating off-chain setTimeout(_stop) that could land after a re-preload and wipe a fresh source.
        const fromGen = this.deckGen[fromId];
        setTimeout(() => this._advance("stop:" + fromId, async () => {
          const act = this._outgoingStopAction(fromId, fromGen, toId);
          if (act !== "stop") return;
          // Bug-A hardening (2026-07-22): the OLD outgoing source is still on this deck (deckGen unchanged)
          // and it isn't the deck we rotated INTO — so it MUST stop. Do NOT skip merely because it still
          // reports "playing": a still-playing outgoing deck past the crossfade grace IS the leaked/overlap
          // deck this deferred stop exists to clear (the 2026-07-21 OF two-decks incident). Force the stop.
          if (this._deckState(fromId).status === "playing") this._log("stop:" + fromId + " — outgoing still playing past grace (same source) → FORCE stop (Bug-A guard)");
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
        this._armAfterRotate(toId, cfMs);
        return true;
    }
  }

  /** Re-arm after any rotate/start: refill the log, then cue the two standby decks.
   *  - refillIfNeeded on EVERY target letter (it used to fire only for "A", so the log-reader continued
   *    from the skipped-to position on one letter in three).
   *  - Gated on _mayDecide(): in MANUAL nothing auto-cues — the jock owns the hour. */
  _armAfterRotate(toId, cfMs) {
    if (!this._mayDecide()) return;
    const near = (Number.isFinite(cfMs) ? cfMs : this.crossfadeDuration * 1000) + 800;
    const order = ["A", "B", "C"];
    const i = order.indexOf(toId);
    const n1 = order[(i + 1) % 3], n2 = order[(i + 2) % 3];
    setTimeout(async () => { await this.refillIfNeeded(); this.preload(n1, 0); }, 800);
    setTimeout(() => this.preload(n2, 1), near);
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

  // Log-Reader Flip (ACTIVATION) — is the time-anchored log-reader ON for THIS station? Per-station via
  // station_config_kv key='log_reader_flip' (LOCAL-AUTHORITATIVE, rider B — never synced), plus the dev
  // env global override. Cached 5s so a canary toggle takes effect within seconds, no restart. Read-only.
  _logReaderOn() {
    if (LOG_READER_FLIP) return true;
    const now = Date.now();
    if (now - (this._flagCheckedAt || 0) < 5000) return this._flagCached || false;
    this._flagCheckedAt = now;
    try {
      const r = this.db.prepare("SELECT value FROM station_config_kv WHERE station_id=? AND key='log_reader_flip' AND deleted_at IS NULL").get(this.stationId);
      this._flagCached = !!(r && (r.value === "1" || r.value === "true"));
    } catch { this._flagCached = false; }
    return this._flagCached;
  }

  async refillIfNeeded() {
    if (!this.continuous) return;
    // Log-Reader Flip: when ON for this station, playout is a READ-THROUGH of generated_schedule via the
    // §2.7 selector — the queue becomes a cache of log rows >= the playhead (§2.3). OFF path below is
    // byte-identical to the pre-flip legacy behaviour.
    if (this._logReaderOn()) return this._refillFromLog();
    // ── legacy queue-sourced refill (unchanged) ──
    // Refill BEFORE the queue hits 0 (low watermark), so it never sits empty and starves preload.
    if (this.queue.length >= 5) return;
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
    // STARVED (2026-07-26): the ladder found no playable song in ANY of this station's own categories.
    // Loud once/60s — never silently borrow a foreign/uncategorized song to paper over an empty library.
    if (fill.starved) this._noteStarved();
    // ENFORCE-SEPARATION relax (2026-07-27): the enforced floor bent rest to avoid dead air — loud.
    if (fill.relaxedCount) this._noteSepRelaxed(fill.relaxedCount);
  }

  // Throttled loud starvation signal → main appends it to health-events.jsonl (fill-starved).
  _noteStarved() {
    const now = Date.now();
    if (now - (this._lastStarvedAt || 0) < 60000) return;
    this._lastStarvedAt = now;
    this._log("STARVED: no playable song in this station's own categories — honest empty (no foreign borrow)");
    try { this.emit("fill-starved", { stationId: this.stationId }); } catch { /* never break playout */ }
  }

  // Throttled loud separation-relax signal → main appends it to health-events.jsonl (separation-relaxed).
  _noteSepRelaxed(count) {
    const now = Date.now();
    if (now - (this._lastSepRelaxAt || 0) < 60000) return;
    this._lastSepRelaxAt = now;
    this._log("SEPARATION RELAXED: enforced floor bent rest on " + count + " pick(s) — category pool exhausted");
    try { this.emit("separation-relaxed", { stationId: this.stationId, count, where: "daemon-fill" }); } catch { /* never break playout */ }
  }

  // Log-Reader Flip (ACTIVATION) — the read-through refill (§2.3). The queue becomes a cache of log rows
  // from the §2.7 playhead forward: keep the cued/bound HEAD (the decks — §2.4a), rebuild the PENDING
  // region from the anchored read. Time-anchored: BEHIND stamps the skipped-past rows 'missed' (day-
  // bounded) and drops them from the pending region; AHEAD (rider A) queues the early row so it plays when
  // the current song ends — never waits, never dead-airs (health event only beyond slack). EXHAUSTED →
  // the emergency floor (loud). Throttled 2s. The proven preload/rotate/loadToDeck path is untouched.
  async _refillFromLog() {
    const now = Date.now();
    if (now - (this._lastRefillAt || 0) < 2000) return;
    this._lastRefillAt = now;
    let r;
    try { r = loggen.readLogAnchored(this.db, this.stationId, 20); }
    catch (e) { this._log("logreader refill error: " + String(e)); return; }

    // Cued/bound head — the decks. NEVER dropped (§2.4a: only the pending region re-syncs to the log).
    const boundHead = this.queue.filter(q => this.boundQids.has(q.qid));
    const boundSchedIds = new Set(boundHead.map(q => q.schedId).filter(x => x != null));

    // EMERGENCY FLOOR — no pending log row for now (log exhausted / error). Loud, then fall to the
    // clock/on-format tiers so a flipped station never dead-airs (§2.6). Off-log, and screamed.
    if (r.mode === "exhausted" || r.mode === "error") {
      try { this.emit("logreader-floor", { stationId: this.stationId, reason: r.mode }); } catch {}
      this._log("LOG-READER FLOOR: log " + r.mode + " — emergency clock/on-format fill (never dead-air)");
      let fill; try { fill = loggen.fillQueue(this.db, this.stationId, 20); } catch { fill = { items: [], source: "none" }; }
      const kept = this._ensureIds((fill.items || []).filter(it => this._fileOk(it.filePath)));
      this.queue = [...boundHead, ...kept];
      this.emit("queue", { stationId: this.stationId, source: "logreader-floor:" + fill.source, items: this.queue });
      if (fill.starved) this._noteStarved();   // in-station library empty even at the floor — loud, no foreign borrow
      if (fill.relaxedCount) this._noteSepRelaxed(fill.relaxedCount);   // enforced floor bent rest — loud
      return;
    }

    // BEHIND — stamp the skipped-past pending rows 'missed' (day-bounded, from readLogAnchored). Loud.
    if (r.missedRowIds.length) {
      try {
        const ph = r.missedRowIds.map(() => "?").join(",");
        this.db.prepare(`UPDATE generated_schedule SET state='missed' WHERE id IN (${ph}) AND station_id=? AND state='pending'`).run(...r.missedRowIds, this.stationId);
      } catch { /* stamping is best-effort; never break playout */ }
      try { this.emit("logreader-missed", { stationId: this.stationId, count: r.missedRowIds.length, driftSec: r.driftSec }); } catch {}
      // WORDING (2026-07-31): after a manual shift this is a HANDOVER, not a fault. The rows are retired
      // as bookkeeping — nothing is aired, nothing is caught up — and without it they sit `pending`
      // forever and become the stale-row debris cleaned out of station 4 on 2026-07-30. The alarm
      // wording ("behind Xm") read like a failure when the jock had simply been driving.
      const _hhmm = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this._log(this._resumingFromManual
        ? `calendar resumed at ${_hhmm} — ${r.missedRowIds.length} rows from the manual shift retired`
        : "LOG-READER: behind " + Math.round(r.driftSec / 60) + "m — stamped " + r.missedRowIds.length + " skipped-past rows 'missed' (day-bounded)");
      this._resumingFromManual = false;
    }

    // AHEAD (rider A) — the early row is already in r.items and will air when the current song ends. NEVER
    // wait / dead-air; within slack it airs silently, beyond slack we health-event it (music floats forward).
    if (r.mode === "ahead" && r.aheadBySec > FLIP_AHEAD_SLACK_SEC) {
      try { this.emit("logreader-ahead", { stationId: this.stationId, aheadSec: r.aheadBySec }); } catch {}
      this._log("LOG-READER: ahead " + Math.round(r.aheadBySec / 60) + "m — next row plays early (never wait)");
    }

    // Rebuild the PENDING region from the anchored log rows (dedup vs the bound head).
    const seen = new Set(boundSchedIds); const kept = [];
    for (const it of r.items) {
      if (it.schedId != null && seen.has(it.schedId)) continue;
      if (!this._fileOk(it.filePath)) { if (!it.fileKey) this._noteLoadSkip(it.title, "unresolvable — no local file, no file_key"); continue; }
      if (it.schedId != null) seen.add(it.schedId);
      kept.push(it);
    }
    // NEAREST-ANCHOR SEAM SELECTION — order the pending region so the next seam lands a due spot as close
    // to its anchor as possible (early or late; closest wins). Pure reorder of rows that were already
    // going to air: no deck command, no effect on the playing deck, and it cannot produce silence.
    // Design: docs/design-nearest-anchor-seam-selection-2026-07-30.md
    const seamTs = this._projectedSeamTs();
    const ordered = loggen.orderForNearestAnchor(kept, seamTs, { nextHourTs: this._nextTopOfHourTs() });
    const promoted = ordered !== kept;   // the selector returns the SAME array when nothing changed

    const freshPending = this._ensureIds(ordered);
    // Only emit if the pending region actually changed (avoid a queue-event storm on the 2s tick).
    const oldPendingItems = this.queue.filter(q => !this.boundQids.has(q.qid));
    const oldPending = oldPendingItems.map(q => q.schedId).join(",");
    const newPending = freshPending.map(q => q.schedId).join(",");
    this.queue = [...boundHead, ...freshPending];
    if (oldPending !== newPending) {
      this.emit("queue", { stationId: this.stationId, source: "logreader", items: this.queue });
      this._log("logreader refill: " + freshPending.length + " pending from log (mode=" + r.mode + ", queue=" + this.queue.length + ")");

      // RECONCILIATION IS A DECISION, NOT A SILENT TIDY-UP (2026-07-30). The rebuild above drops rows
      // that are already cued on a deck (the `seen.has(it.schedId)` continue). That is correct — but
      // when the operator was LOOKING at one of those rows in Up Next, it vanishes with no explanation,
      // which is indistinguishable from a bug. Observed live: "Soak Up The Sun" showed on deck C AND in
      // Up Next, the dedup resolved it, and NOTHING appeared in Live Activity.
      //
      // Only fires on a REAL visible change: we are already inside `oldPending !== newPending`, and we
      // name only rows that were in the previous pending region. The routine per-refill dedup of the
      // cued decks never reaches here, so this cannot become 2s noise.
      const newIds = new Set(freshPending.map(q => q.schedId).filter(x => x != null));
      const dropped = oldPendingItems.filter(q => q.schedId != null && !newIds.has(q.schedId));
      if (dropped.length) {
        const cuedIds = new Set(boundSchedIds);
        const names = dropped.slice(0, 4).map(q =>
          `"${q.title || "(untitled)"}"${cuedIds.has(q.schedId) ? " (already cued on a deck)" : ""}`).join(", ");
        this._log(`logreader reconciled: removed ${dropped.length} row(s) from Up Next — ${names}` +
          (dropped.length > 4 ? ` +${dropped.length - 4} more` : ""));
      }
      if (promoted) {
        const head = freshPending[0];
        this._log(`logreader reconciled: nearest-anchor promoted "${head && head.title ? head.title : "(untitled)"}" to the head of Up Next`);
      }
    }
    // AUTO-FITTER — OBSERVATION ONLY (§2.7). Computes what it WOULD do to make a seam land on the next
    // hard anchor, logs it as a DECISION, and WRITES NOTHING. No row is altered, no queue is reordered,
    // no deck is touched. One observation day on real air before authoring is even proposed.
    this._observeFit(seamTs);

    // COMPANION RE-CUE — a promotion only reaches air if a deck can take it. Without this the spot waits
    // behind whatever was already cued, i.e. "closest" degrades to within-one-SONG instead of
    // within-one-SEAM. Strictly bounded: SPOT promotions only, UNSTARTED standby decks only, and never
    // the deck that is playing.
    if (promoted) this._recueForPromotedSpot(freshPending[0]);
  }

  // ── AUTO-FITTER, OBSERVATION PHASE (§2.7) ───────────────────────────────────────────────────────
  // Computes the fit and says what it WOULD do. It writes nothing — no generated_schedule row, no queue
  // change, no deck command. The whole point of the observation release is a day of real air saying what
  // it would have swapped, BEFORE it is allowed to author a row.
  //
  // Throttled by SIGNATURE, not by time: the refill runs every couple of seconds and the fit for a given
  // window is stable, so re-logging it would drown the Decisions view. A line appears when the window or
  // the proposed action actually changes.
  _observeFit(seamTs) {
    try {
      const anchorTs = this._nextHardAnchorTs(seamTs);
      if (!anchorTs) { this._lastFitSig = ""; return; }

      // Pending MUSIC/SPOT rows in play order — the same region the reader just published.
      const pending = this.queue.filter(q => !this.boundQids.has(q.qid));
      if (!pending.length) { this._lastFitSig = ""; return; }

      // Candidates are separation-filtered by loggen, so a proposed swap can never break separation.
      // Narrow to the category of the row most likely to be swapped (the last one in the window).
      let categoryId = null;
      try {
        const last = pending[pending.length - 1];
        if (last && last.schedId != null) {
          const r = this.db.prepare("SELECT s.category_id c FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id WHERE gs.id = ?").get(last.schedId);
          categoryId = r && r.c != null ? r.c : null;
        }
      } catch { /* fall through to the whole on-format set */ }
      const candidates = loggen.eligibleForFit(this.db, this.stationId, categoryId, 200);

      const fit = autofit.computeFit(seamTs, anchorTs, pending, candidates);
      const a = fit.action;
      const sig = `${anchorTs}|${fit.mode}|${a ? (a.type + ":" + (a.from ? a.from.filePath : "") + ">" + (a.to ? a.to.filePath : a.fill ? a.fill.filePath : "")) : ""}`;
      if (sig === this._lastFitSig) return;
      this._lastFitSig = sig;

      const line = autofit.describeFit(fit, anchorTs, /* observationOnly */ true);
      if (line) this._log(line);

      // A window the fitter cannot close is the condition that starves it — surface it beyond the log.
      if (fit.mode === "no-fit") {
        try {
          this.emit("error", { stationId: this.stationId, where: "autofit",
            error: `no fit for the ${new Date(anchorTs * 1000).toLocaleTimeString([], { hour12: false })} window — ${fit.reason}` });
        } catch {}
      }
    } catch (e) { this._log("autofit observe error (playout unaffected): " + String(e)); }
  }

  /** The next HARD anchor at or after the seam: the top of the hour, or the next pending SPOT row —
   *  whichever comes first. Null when neither is inside the fitter's look-ahead. */
  _nextHardAnchorTs(seamTs) {
    const candidates = [];
    const hourTs = this._nextTopOfHourTs();
    if (hourTs > seamTs) candidates.push(hourTs);
    try {
      const r = this.db.prepare(
        `SELECT scheduled_at FROM generated_schedule
          WHERE station_id = ? AND content_class = 'SPOT' AND state = 'pending' AND deleted_at IS NULL
            AND scheduled_at > ? ORDER BY scheduled_at LIMIT 1`).get(this.stationId, seamTs);
      if (r && Number.isFinite(r.scheduled_at)) candidates.push(r.scheduled_at);
    } catch { /* the hour anchor alone is still a valid window */ }
    if (!candidates.length) return null;
    const next = Math.min(...candidates);
    return (next - seamTs) <= autofit.LOOKAHEAD_SEC ? next : null;
  }

  /** The next seam, in epoch SECONDS: now + what remains on the playing deck. No deck playing → now.
   *  Reads only the state _segueTick already uses; never writes. */
  _projectedSeamTs() {
    const nowSec = Math.floor(Date.now() / 1000);
    const P = ["A", "B", "C"].find(d => this._deckState(d).status === "playing");
    if (!P) return nowSec;
    const st = this._deckState(P);
    const remaining = (st.durationSec || 0) - (st.positionSec || 0);
    return nowSec + (remaining > 0 ? Math.round(remaining) : 0);
  }

  /** Start of the NEXT top of the hour, epoch seconds — anchors at or beyond it belong to the hard cut. */
  _nextTopOfHourTs() {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return Math.floor(d.getTime() / 1000) + 3600;
  }

  /** Re-cue an UNSTARTED standby deck to the promoted spot so it can actually air at the next seam.
   *  Never touches a playing deck, never touches the deck the engine has live, and does nothing unless
   *  the head of the pending region really is a SPOT. Best-effort — a failure just leaves the old cue. */
  _recueForPromotedSpot(head) {
    try {
      if (!head || head.contentClass !== "SPOT") return;
      const live = this.liveDeck;
      // The standby deck that would be rotated into next, if it is cued and NOT playing.
      const target = ["A", "B", "C"].find(d =>
        d !== live &&
        this._deckState(d).status !== "playing" &&      // never re-cue something already sounding
        this.deckReady.has(d)                            // it holds a cued source we would have aired
      );
      if (!target) return;
      const cur = this._deckState(target);
      if (cur.filePath && head.filePath && cur.filePath === head.filePath) return;   // already the spot
      if (!this.loadToDeck(target, head)) return;        // load failed — leave the previous cue intact
      this.deckChainType[target] = head.chainType || "segue";
      this.deckReady.add(target);
      this.dequeue();                                    // the head is now ON the deck, not pending
      this._log(`nearest-anchor: re-cued deck ${target} to SPOT "${head.title || "(untitled)"}" (was "${cur.title || "(empty)"}") — anchor ${head.scheduledAt ?? "?"}`);
      this._maybeEmitDeck(target);
    } catch (e) { this._log("nearest-anchor re-cue error (playout unaffected): " + String(e)); }
  }

  // Log-Reader Flip (ACTIVATION, §2.5) — a jock hand-loading a deck is FIRST-CLASS in the one file: write
  // a generated_schedule row at the playhead stamped source='operator', so the queue/calendar reflect it
  // and it airs AS a log row (zero off-log airs). Only when the flip is ON for this station. Direct local
  // write (like playlog/shadow-stamp); best-effort, never breaks the load. info: {title,artist,filePath,
  // fileKey,songId,durationMs}.
  /** Resolve what a hand-loaded FILE actually is. songs → spots → cart_slots → unknown.
   *
   *  The cart_slots step is the one that matters and the one a songs-only lookup misses: a cart file
   *  may exist in NEITHER songs NOR spots. That is exactly how "Adele   Someone Like You 68" — a cart
   *  with no songs row — took the MUSIC default and became an airable music row (2026-08-04).
   *
   *  Returns "MUSIC" | "SWP" | "SPOT" | "CART" | null (pre-v52 rows may still read "JIN").
   *  null means UNKNOWN, and unknown must
   *  never be treated as music. */
  _resolveHandLoadClass(filePath) {
    if (!filePath) return null;
    try {
      const s = this.db.prepare(
        "SELECT content_class FROM songs WHERE file_path = ? AND deleted_at IS NULL LIMIT 1").get(filePath);
      if (s) return s.content_class || "MUSIC";           // a library row with no class IS music
      const sp = this.db.prepare(
        "SELECT 1 AS n FROM spots WHERE file_path = ? AND deleted_at IS NULL LIMIT 1").get(filePath);
      if (sp) return "SPOT";
      const c = this.db.prepare(
        "SELECT 1 AS n FROM cart_slots WHERE file_path = ? LIMIT 1").get(filePath);
      if (c) return "CART";
      return null;                                         // in no table — unknown, NOT music
    } catch { return null; }
  }

  /** Log-Reader Flip §2.5 — a jock hand-loading a deck is first-class in the one file: write a
   *  generated_schedule row at the playhead stamped source='operator' so the queue/calendar reflect it
   *  and it airs AS a log row (zero off-log airs).
   *
   *  THAT INTENT IS FOR MUSIC ONLY (docs/hand-load-log-design-2026-08-04.md). It used to hardcode
   *  content_class='MUSIC' and state='pending', so hand-firing a cart, jingle or spot wrote an AIRABLE
   *  MUSIC row and the log reader played imaging as music. state='pending' is not a record of
   *  something that happened — it is an INSTRUCTION TO AIR.
   *
   *  Now: resolve the real class, and write a row ONLY for a library MUSIC song. Imaging, commercials
   *  and unknown files write NOTHING — their airing is already recorded by play_log, which resolves
   *  content class properly (audiod/playlog.js:27-35). Refusing to write is always safe; writing a
   *  wrong row into the file every station airs from is not.
   *
   *  info: {title,artist,filePath,fileKey,songId,durationMs}. `deck` and `via` are for the log line —
   *  a title-only message is why a cart fire was mistaken for an operator library-load for two rounds.
   */
  _writeOperatorLogRow(info, deck, via) {
    if (!this._logReaderOn() || !info || !info.filePath) return;
    const where = `deck=${deck || "?"} via=${via || "?"}`;
    const base = String(info.filePath).split(/[\\/]/).pop();
    const cls = this._resolveHandLoadClass(info.filePath);

    // REFUSALS ARE LOGGED. A silent refusal is how this class of bug hides.
    if (cls !== "MUSIC") {
      this._log(`LOG-READER hand-load: ${where} class=${cls || "UNKNOWN"} file="${base}" → NO ROW ` +
                `(${cls ? "not music — imaging/commercial never enters the airable music log" : "unresolved — not in songs, spots or cart_slots"})`);
      return;
    }

    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const iso = new Date().toISOString();
      const r = this.db.prepare(
        `INSERT INTO generated_schedule (scheduled_at, song_id, title, artist, file_path, file_key, duration_s, station_id, uuid, state, source, content_class, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'operator', 'MUSIC', ?, ?)`
      ).run(nowTs, info.songId ?? null, info.title || "", info.artist || "", info.filePath, info.fileKey || null,
            info.durationMs ? Math.round(info.durationMs / 1000) : null, this.stationId, crypto.randomUUID(), iso, iso);
      try { this.emit("logreader-operator-write", { stationId: this.stationId, title: info.title || "" }); } catch {}
      this._log(`LOG-READER hand-load: ${where} class=MUSIC file="${base}" → wrote row id=${r.lastInsertRowid}`);
    } catch (e) { /* never break the operator load */ }
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
    // ONE path for an occupant change — identity, duration and class replaced together (2026-08-02).
    this._setDeckTrack(id, item);
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
    // Log-Reader Flip Phase 1/3 — SHADOW (observational), DEFERRED OFF THE ADVANCE CRITICAL PATH
    // (2026-07-22 incident fix). These do DB read/write (a COUNT + two UPDATEs); under DB contention a
    // slow op here previously stalled _fireStart → stalled the serialized advance chain → delayed the
    // deferred deck-stop → a leaked/overlapping deck. setImmediate runs them AFTER the current advance
    // tick completes, so the shadow can NEVER again delay a rotation or its stop — the shadow's own stated
    // principle ("must never perturb playout"), now enforced by placement. Capture the row id now
    // (deckSchedId may be overwritten by a later load before this fires). Order preserved: EVAL (compares
    // while the row is still 'pending') THEN STAMP.
    const _shadowSchedId = this.deckSchedId[deckId];
    setImmediate(() => {
      try { this._shadowEvalTimeAnchor(deckId, _shadowSchedId); } catch { /* never perturb playout */ }
      try { this._shadowStampPlayhead(_shadowSchedId); } catch { /* never perturb playout */ }
    });
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
  /** A deck was loaded from OUTSIDE the advance chain — the inbound `load` command, which is where
   *  every renderer-initiated load lands in daemon mode (library drag, queue click, JockStrip, cart
   *  assign). `track` carries what the caller knows; the fields Rust already holds are read back when
   *  it does not.
   *
   *  THIS WAS THE HOLE (2026-08-02). It used to set deckReady/manualCue and nothing else, so the deck
   *  kept the PREVIOUS occupant's duration and contentClass while Rust supplied the new title — the
   *  "Jack's Lament 0:11/0:11 with a spot's gold outline" reproducer. It now goes through the same
   *  single occupant-change path automation uses. */
  noteManualCue(deckId, track) {
    if (!["A", "B", "C"].includes(deckId)) return;
    if (this._deckState(deckId).status === "playing") return;
    // Rust has already been told to load; read back what it holds so the identity is right even when the
    // caller passed nothing. Duration is NOT available from Rust — _setDeckTrack resolves it from the
    // file — which is precisely why it must not be inherited from the previous occupant.
    const live = this._state();
    const rust = live ? (deckId === "A" ? live.deckA : deckId === "B" ? live.deckB : live.deckC) : null;
    const t = track || {};
    this._setDeckTrack(deckId, {
      title:    t.title    ?? rust?.title    ?? "",
      artist:   t.artist   ?? rust?.artist   ?? "",
      filePath: t.filePath ?? rust?.file_path ?? "",
      durationMs: t.durationMs,
      contentClass: t.contentClass ?? null,   // unknown → cleared, never the previous track's class
      status: "idle",
    });
    this.deckReady.add(deckId);
    this.manualCue.add(deckId);
    // Flip §2.5: the jock hand-loaded this deck — write it to the log as an operator row so it airs on-log.
    const st = this._deckState(deckId);
    this._writeOperatorLogRow({ title: st.title, artist: st.artist, filePath: st.filePath, durationMs: (st.durationSec || 0) * 1000 }, deckId, "noteManualCue");
    this._maybeEmitDeck(deckId);
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
    // Flip §2.5: cue-to-deck is an operator insert — write it to the log so it airs on-log.
    this._writeOperatorLogRow({ title: songRef.title, artist: songRef.artist, filePath: songRef.filePath, fileKey: songRef.fileKey, songId: songRef.songId ?? songRef.id, durationMs: songRef.durationMs }, deck, "intentDeckCue");
    return true;
  }

  // deck:crossfade — fade the playing deck to a ready one. Args optional: from defaults to the
  // playing deck, to defaults to the next ready deck in rotation. No-op if there's no playing deck
  // or no ready target. Reuses handleRotate (carries its own spurious-end guards + dequeue).
  // ── OPERATOR START / SAFETY SKIP (2026-08-02) ───────────────────────────────────────────────────
  // This is what the deck ON button now calls. It used to back the XFADE button; ON previously issued a
  // RAW audioPlay straight to Rust (App.tsx:3924) — no serialization, no guards, no stop of the
  // outgoing, no liveDeck update. That is the out-of-chain start shape that put two decks on air on
  // 2026-07-29. Every start now goes through the advance chain.
  //
  // THE DECISION IS MADE INSIDE THE CHAIN. It used to be resolved synchronously before queuing, so a
  // rapid double-press read pre-rotate state twice and queued two identical rotates — the second was
  // absorbed by the spurious-end guard (a guard written for spurious END DETECTION, not for
  // double-presses) while the caller was still told `true`. For a SAFETY control, "I pressed it, nothing
  // happened, and it said OK" is the worst possible feedback.
  //
  // Returns an honest outcome: { ok, reason, from, to }.
  intentCrossfade(from, to) {
    return this._advance("operator-start", async () => {
      const order = ["A", "B", "C"];
      // liveDeck FIRST: during the cut window the outgoing still reports "playing", so a status scan
      // resolves against the deck on its way out and a double-press claims a skip that was absorbed.
      const playing = from && order.includes(from) ? from
        : (this.liveDeck && order.includes(this.liveDeck) ? this.liveDeck
          : order.find(d => this._deckState(d).status === "playing")) || null;

      // Requested deck is ALREADY the live one — nothing to do, and say so rather than claiming a skip.
      if (to && to === playing) return { ok: false, reason: "already-live", from: playing, to };

      let target = to && order.includes(to) ? to : null;
      if (!target) { const i = order.indexOf(playing || "A"); for (let k = 1; k <= 2; k++) { const c = order[(i + k) % 3]; if (this.deckReady.has(c)) { target = c; break; } } }
      if (!target) return { ok: false, reason: "no-target" };
      if (!this.deckReady.has(target) && this._deckState(target).status !== "playing") {
        return { ok: false, reason: "target-not-cued", to: target };
      }

      // COLD START — nothing on air. Start the target on the chain; there is no outgoing to stop.
      // Never a raw audioPlay: this runs inside _advance, so it is serialized with preload and stops.
      if (!playing) {
        this._play(target);
        this._setDeck(target, { status: "playing", positionSec: 0 });
        this._fireStart(target);
        this._log("operator start: deck " + target + " LIVE — " + (this._deckState(target).title || "(untitled)"));
        this.deckReady.delete(target); this.endTriggered.delete(target);
        if (this.manualCue.has(target)) this.manualCue.delete(target);
        else if (this.queue.length > 0) this.dequeue();
        this._armAfterRotate(target);
        return { ok: true, reason: "started", to: target };
      }

      // TAKE-OVER — the safety skip. SAFETY_CUT_MS, not the 3s musical overlap: the reasons an operator
      // hits this in an emergency (profanity, wrong track, garbled file) are all reasons the outgoing
      // must come OFF, not linger under the incoming for three and a half seconds.
      const rotated = await this._rotateBody(playing, target, { cutMs: SAFETY_CUT_MS });
      if (!rotated) return { ok: false, reason: "absorbed", from: playing, to: target };
      return { ok: true, reason: "took-over", from: playing, to: target };
    });
  }

  /** Board-style channel OFF — audio off NOW. Serialized like every other transport change, so it can
   *  never interleave with a rotate. Not a pause: the board button kills the channel. */
  intentDeckOff(deckId) {
    return this._advance("operator-off:" + deckId, async () => {
      if (!["A", "B", "C"].includes(deckId)) return { ok: false, reason: "bad-deck" };
      this._stop(deckId);
      this.deckReady.delete(deckId);
      this.endTriggered.delete(deckId);
      if (this.liveDeck === deckId) this.liveDeck = null;
      this._setDeck(deckId, { status: "idle", positionSec: 0 });
      this._log("operator: deck " + deckId + " OFF (channel killed)");
      this._maybeEmitDeck(deckId);
      return { ok: true, reason: "stopped", to: deckId };
    });
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
    // Coming back from MANUAL: the next refill's row-retirement is a handover, not a "behind" alarm.
    this._resumingFromManual = !wasStarted;
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

  // What is the CART overlay bus actually doing RIGHT NOW — the number, and how we know it.
  //
  // The old form returned a bare `true` from EITHER real signal OR `source_present && active &&
  // !paused`, and the caller logged the word "samples flowing" for both. The second is a decoder
  // being loaded, which is not signal — so the log asserted flow on a day the operator's meter
  // showed nothing, and cost hours. Same answer, but it now says which of the two it saw and at what
  // peak. Behaviour is unchanged: `flowing` is the same boolean as before.
  _cartObserve(channels) {
    const chans = (channels && channels.length) ? channels : ["CART"];
    const find = (lv, ch) => (lv.decks || []).find(d => d && (d.id === ch || (ch === "CART" && d.id === 6)));
    try {
      const lv = JSON.parse(A.audioGetLevels(this.stationId));
      let peak = 0;
      for (const ch of chans) { const d = find(lv, ch); if (d && (d.peak || 0) > peak) peak = d.peak || 0; }
      // level_cart is bus.peaks[6] under a named field, so it speaks only for the fallback slot.
      if (chans.includes("CART")) { const legacy = lv.cart || lv.level_cart || 0; if (legacy > peak) peak = legacy; }
      if (peak > 0.0001) return { flowing: true, peak, how: "signal" };
      const loaded = chans.some(ch => { const d = find(lv, ch); return !!(d && d.source_present && d.active && !d.paused); });
      return { flowing: loaded, peak, how: loaded ? "loaded-and-active (NOT signal)" : "nothing" };
    } catch { return { flowing: false, peak: 0, how: "levels-unreadable" }; }
  }
  // Unchanged contract for every existing caller.
  _cartFlowing(channels) { return this._cartObserve(channels).flowing; }

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
      categoryId: jin.jingleCategoryId, contentClass: 'SWP',   // v52: one imaging class
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
    // Stop what it was FIRED on, not a fixed name - the selector may have moved since.
    if (j.firedAt) { for (const ch of (j.channels || ["CART"])) this._stop(ch); }
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

  // Stamp the sweeper play — ONLY on observed firing (rider #2), stamped content_class='SWP' so Phase-1b
  // isolation excludes it from music math / affidavit. deck="CART" (overlay, not a rotation deck).
  _logJinglePlay(j) {
    try {
      playlog.logPlay(this.db, { stationId: this.stationId, title: j.title, artist: j.artist, deck: (j.channels && j.channels[0]) || "CART",
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

  // ── liveDeck OBSERVER — OBSERVATION ONLY, stops nothing ────────────────────────────────────────
  // Pure + testable (audiod/smoke-seam-stop.js). Given the deck the engine put on air and the three
  // deck statuses, return the MUSIC decks that are playing but are NOT the deck the engine believes
  // is live. In healthy operation this is empty except during a legitimate segue overlap, where the
  // incoming deck IS liveDeck (set by _play at the rotate) and the OUTGOING deck is briefly foreign
  // — which is why the caller applies a grace before it says anything.
  // Returns [] when liveDeck is unknown: never report an anomaly we cannot attribute.
  _foreignPlayingDecks(liveDeck, statuses) {
    if (!liveDeck) return [];
    return ["A", "B", "C"].filter(d => d !== liveDeck && statuses[d] === "playing");
  }

  // The grace a foreign deck is allowed before it is reported. Derived from the settings that produce
  // legitimate overlap so it tracks them instead of hardcoding: the incoming starts segueOverlap early
  // and the outgoing's deferred stop lands at crossfadeDuration + 500ms after the rotate, so a NORMAL
  // overlap clears well inside this. Nothing about playout reads this — it is a reporting threshold.
  _foreignGraceMs() { return (this.segueOverlap + this.crossfadeDuration) * 1000 + 1500; }

  // Poll-driven ENFORCEMENT (2026-07-30, was observation-only in 4.4.105). A rotation deck that is
  // playing but is NOT the deck this engine put on air is stopped once it has held past the grace.
  //
  // Justified by live evidence, not inference: two incidents on 2026-07-30 (16:35:10→16:35:51, 46.0s;
  // 16:37:24→16:38:14, 50.6s) put two songs on air for ~50s each, and BOTH ended only when the Bug-A
  // guard happened to catch deck A on its next real rotate. Nothing else would have stopped them —
  // the deferred stop is armed only by handleRotate, so a deck started outside the chain is invisible
  // to it (docs/auto-cycle-double-play-and-flip-engagement-2026-07-30.md).
  //
  // The invariant: AT MOST ONE ROTATION DECK IS AUDIBLE. What this must never do:
  //   • never stop this.liveDeck — the deck the engine itself put on air is by definition correct;
  //   • never touch CART — the jingle overlay is not a rotation deck (_foreignPlayingDecks: A/B/C only);
  //   • never fire during a legitimate segue overlap — the grace (segueOverlap + crossfadeDuration +
  //     1.5s = 7.5s at defaults) outlasts the deferred stop that ends a normal overlap (cf + 500ms =
  //     3.5s) by a factor of two;
  //   • never act on an unknown live deck — _foreignPlayingDecks returns [] when liveDeck is null;
  //   • never throw into playout — same try/catch contract as _segueTick/_jingleTick.
  // The stop runs ON the advance chain (_advance), serialized with preload/rotate exactly like the
  // Bug-A deferred stop, so it cannot land in the middle of a rotate. deckReady/endTriggered are
  // cleared alongside, matching that guard — a nulled Rust source is never left marked "ready".
  _liveDeckObserverTick(now) {
    try {
      const statuses = { A: this.stateA.status, B: this.stateB.status, C: this.stateC.status };
      const foreign = this._foreignPlayingDecks(this.liveDeck, statuses);

      if (foreign.length === 0) {
        if (this._foreignSince) {
          this._log(`liveDeck GUARD — foreign deck cleared after ${((now - this._foreignSince) / 1000).toFixed(1)}s (live=${this.liveDeck})`);
          this._foreignSince = 0; this._foreignLastLogAt = 0;
        }
        return;
      }

      if (!this._foreignSince) this._foreignSince = now;
      const heldMs = now - this._foreignSince;
      if (heldMs < this._foreignGraceMs()) return;   // a normal segue overlap never gets this far

      // Loud on the transition, then at most every 10s while it persists (a stop that cannot land —
      // e.g. the source is being re-started faster than we stop it — must not spam the log).
      const speak = !this._foreignLastLogAt || (now - this._foreignLastLogAt >= 10000);
      if (speak) {
        this._foreignLastLogAt = now;
        const describe = (d) => {
          const st = this._deckState(d) || {};
          return `${d}="${st.title || "(untitled)"}" ${(st.positionSec || 0).toFixed(1)}/${(st.durationSec || 0).toFixed(1)}s`;
        };
        this._log(
          `liveDeck GUARD — TWO DECKS ON AIR (station ${this.stationId}): engine live deck ${describe(this.liveDeck)} ` +
          `| FOREIGN ${foreign.map(describe).join(" | ")} — held ${(heldMs / 1000).toFixed(1)}s past grace → ` +
          (this._mayDecide() ? `STOPPING ${foreign.join(",")}. ` : `MANUAL: observing only, the jock owns the decks. `) +
          `alphabetical P would pick ${["A", "B", "C"].find(d => statuses[d] === "playing")}.`
        );
        // Surface it beyond the log — the Health Monitor consumes engine errors (play-skip does the same).
        try { this.emit("error", { stationId: this.stationId, where: "liveDeckGuard", deck: foreign.join(","), error: `foreign deck(s) ${foreign.join(",")} on air past grace with live deck ${this.liveDeck} — stopped` }); } catch {}
      }

      // MANUAL: OBSERVE ONLY (2026-07-31, Jeff's ruling). A jock may deliberately run two decks — a bed
      // under a talk break — and the guard exists to catch AUTOMATION losing track of itself, not to
      // overrule a person. It still logs, so the operator sees what it sees; it just never acts.
      if (!this._mayDecide()) return;

      // ENFORCE — on the advance chain, so this can never interleave with a rotate/preload.
      const live = this.liveDeck;
      const targets = foreign.slice();
      this._advance("liveDeck-guard", async () => {
        for (const d of targets) {
          // Re-check under the chain: the world may have moved between the tick and our turn.
          if (d === this.liveDeck) continue;                       // it became the live deck legitimately
          if (this._deckState(d).status !== "playing") continue;    // it already stopped
          if (this.liveDeck !== live) continue;                     // a rotate happened — that owns the decks now
          this._stop(d);
          this.deckReady.delete(d);
          this.endTriggered.delete(d);
        }
      });
    } catch (e) { this._log("liveDeckGuard error (playout unaffected): " + String(e)); }
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
      // CLEAN SPOT EDGES: a SPOT is exclusive PROGRAM content — never overlap the incoming over a spot's
      // tail (clean OUT) and never start a spot early over the outgoing's tail (clean IN). The spot plays
      // alone; the natural-end rotate gives a clean cut. Segue overlap is music↔music only.
      if (this.deckContentClass[P] === 'SPOT' || this.deckContentClass[nextDeck] === 'SPOT') {
        this._log(`clean spot edge: ${P}→${nextDeck} — no segue overlap (SPOT is exclusive program)`);
        return;
      }
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
        const obs = this._cartObserve(j.channels);
        if (obs.flowing) {
          this._lastPlayingAt = now;                        // watchdog: the bridge is NOT a stall
          if (!j.firingConfirmedAt) {
            j.firingConfirmedAt = now; this._emitJingle("FIRING", j); this._logJinglePlay(j);
            this._log("jingle FIRING on " + (j.channels || ["CART"]).join("+") + " peak=" + obs.peak.toFixed(4) + " via " + obs.how + " - \"" + j.title + "\"");
          }
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
      // NO IMAGING OVER A COMMERCIAL: a jingle introduces MUSIC, never a SPOT. If the outgoing (playing) OR
      // the incoming deck is a spot, suppress the seam entirely — a spot gets clean edges under any policy.
      if (this.deckContentClass[P] === 'SPOT' || (nextDeck && this.deckContentClass[nextDeck] === 'SPOT')) { this._clearScheduled("spot-seam"); return; }
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
      contentClass: "SWP",                                   // v52: one imaging class
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

  // -- WHERE SWEEPERS ARE DIALLED, READ FRESH ----------------------------------------------------
  //
  // Channels are assignable, so a sweeper's destination is whatever the operator dialled - not a
  // fixed address. This was the literal string "CART" in four places, so dialling a channel to
  // Sweeper could not move the audio: the fire path never consulted deck_configs at all.
  //
  // Read on EVERY fire, so changing the channel takes effect on the very next seam with no restart
  // and no toggle. EVERY channel dialled to a sweeper source, not the first - if the operator dials
  // three, all three carry it. Nothing here picks one on their behalf.
  //
  // BOTH kind values: 'jingle' is the stored key behind the "Sweeper" entry and predates 'sweeper',
  // so matching both means an existing install works with no re-dial and no migration. The stored
  // key is deliberately NOT renamed - changing a persisted value for cosmetics is how a config
  // silently stops matching.
  //
  // Falls back to "CART" when nothing is dialled: a seam must never go silent because a channel was
  // not configured.
  _sweeperChannels() {
    try {
      const rows = this.db.prepare(
        "SELECT slot FROM deck_configs WHERE station_id = ? AND enabled = 1 AND type = 'source' " +
        "AND kind IN ('sweeper','jingle') ORDER BY slot").all(this.stationId);
      const slots = rows.map(r => String(r.slot || "")).filter(Boolean);
      if (slots.length) return slots;
    } catch (e) { this._log("sweeper channel resolve failed (falling back to CART): " + String(e)); }
    return ["CART"];
  }

  // Fire the armed jingle on the dialled sweeper channel(s) - serialized on the advance chain.
  _fireJingle(j) {
    this._advance("jingle-fire", async () => {
      if (this._jingle !== j || j.phase !== "armed") return;         // superseded/cleared while queued
      if (this._jingleSuperseded(j)) { this._cancelJingle("superseded-at-fire"); return; }
      // A failure on ONE channel is reported and the others still fire; only a total failure cancels.
      // Both answers are checked - audioLoad and audioPlay each return false on refusal, and walking
      // past either claimed a fire that never happened ("spoke, therefore played").
      const chans = this._sweeperChannels();
      const firedOn = [];
      for (const ch of chans) {
        let ok;
        try { ok = this._load(ch, j.filePath, j.title, j.artist, 0); }
        catch (e) { this._log("jingle load ERROR on " + ch + ": " + String(e)); continue; }
        if (ok === false) { this._log("jingle load REFUSED on " + ch); continue; }
        const played = this._play(ch);
        if (played === false) { this._log("jingle play REFUSED by the engine on " + ch); continue; }
        firedOn.push(ch);
      }
      if (!firedOn.length) { this._cancelJingle("no-channel-accepted"); return; }
      j.channels = firedOn;                                    // stop and observe address THESE
      const d = this._dur(j.filePath); if (d > 0) j.jinDur = d;
      j.firedAt = Date.now();
      j.phase = "firing";
      this._jingleCartGen++;
      this._log("jingle FIRE issued - \"" + j.title + "\" on " + firedOn.join("+") + " (dur=" + (j.jinDur || 0).toFixed(1) + "s); confirming samples...");
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
