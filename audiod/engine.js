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
// SLICE 4 — the master rack document: seeded from the legacy keys, written back to them (docs/dsp-rack-framework.md).
const RackSeed = require(path.join(__dirname, "rack-seed.js"));
const MicInput = require(path.join(__dirname, "mic-input.js"));
const loggen = require("./loggen");
const segueOverlap = require("./segue-overlap");   // the station's segue overlap — one reader, shared with Generate
const playlog = require("./playlog");
const { classifyCartFlow } = require("./cart-observe");   // 2026-10-04: a cart on a dead aux is a FAULT, not FIRING

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
    // THE QUEUE ENTRY EACH DECK HOLDS (design §3.9, Phase 1: "each deck holds its own row; only that row is consumed
    // at go-live"). Before this, a go-live took out WHATEVER WAS FIRST in the queue (dequeue) and a calendar re-cue
    // emptied a deck without letting go of its entry, so the queue fell one entry out of step with the decks and the
    // entry that had just aired was cued again: eight rows aired twice on ovowforestmusic 10/16
    // (docs/playout-change-audit-2026-10-17.md). null = the deck holds nothing from the queue (a hand load).
    this.deckQid = { A: null, B: null, C: null };
    // ROWS THAT HAVE GONE TO AIR, in memory, set the moment a deck goes live — so no path can cue one again even while
    // its database stamp is being retried. Bounded; the reader only reaches back over today.
    this._airedRows = new Set();
    this._recordGen = 0;                 // bumps per go-live, so a late retry never stamps a row over a newer one
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
    // NO LITERAL. The number that decides when the next song starts is the operator's. It is stored with
    // the STATION (station_config_kv 'segue_overlap_sec', synced) and delivered by
    // _applySegueOverlapFromKv on the poll — the same pattern the processing settings use — and by the
    // app's setSegueOverlap command. Until the operator's number arrives this is 0, which means "no early
    // rotate": every song simply plays to its natural end. That is the fail-safe direction. A literal here
    // would be a number that shapes what goes to air, chosen in code, where nobody could see it.
    this.segueOverlap = 0;
    this.segueTriggered = new Set();     // decks whose early overlap-rotate has begun (double-trigger guard)
    // Decks awaiting retirement after a rotate. A deck leaves this map ONLY by draining — never by elapsed
    // time. See _retireTick: nothing in this engine can shorten a song.
    this._retiring = new Map();
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
    // ── JINGLES overlay v1 (daemon = log-reader that orchestrates the CART overlay fire) ──────────────
    // _airGen: on-air generation, bumped every time ANY deck goes live (_fireStart). The Bug-A-immunity
    // token: an armed jingle captures it; ANY advance/skip/manual load goes through _fireStart,
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
      // SLICE 1 S6 — the audio callback's health counters, as DELTAS since the last line: underruns
      // (a deck's decode ring ran dry), overruns (a late callback), lock misses (0 by construction) and
      // dropped events. All four read 0 on a healthy station; a non-zero is the line to look at.
      const rtNow = { ur: lv.rt_underruns || 0, ov: lv.rt_overruns || 0, lm: lv.rt_lock_misses || 0, ev: lv.rt_events_dropped || 0 };
      const rtPrev = this._lastMixRt || rtNow;
      const d = (k) => Math.max(0, rtNow[k] - rtPrev[k]);
      this._lastMixRt = rtNow;
      console.log(
        `[mix s${this.stationId}] active=${lv.active_decks || 0} frames=+${df} peak=${(lv.master || 0).toFixed(3)} mon=${(lv.mon_vol || 0).toFixed(2)} | ${decks}` +
        ` | rt ur=+${d("ur")} ov=+${d("ov")} lm=+${d("lm")} ev=+${d("ev")}`
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
    // Branch POWER — "Process local output" / "Process stream". Not modules, never part of a preset.
    let local = false, stream = false;
    let rows;
    try {
      // THIS station's rows only (WHERE station_id = this engine's station) — the rack, and the legacy keys it
      // is seeded from. SLICE 4: the master GEQ is now read here too, so it is delivered to THIS station's
      // engine and RE-APPLIED whenever an engine starts (it used to be applied only when someone moved a
      // slider, to whichever station the renderer defaulted to — docs/dsp-rack-framework.md §8).
      const keys = ["proc_local", "proc_stream", ...RackSeed.RACK_KEYS];
      rows = this.db.prepare(
        `SELECT key, value FROM station_config_kv WHERE station_id=? AND key IN (${keys.map(k => `'${k}'`).join(",")}) AND deleted_at IS NULL`
      ).all(this.stationId);
    } catch (e) {
      // Leave the last-applied state untouched — never disturb playout for a read failure. But SAY SO:
      // this used to return silently, so a station whose KV could not be read looked identical to one
      // with nothing to change. Rate-limited to once a minute so a persistent fault cannot flood.
      if (!this._procKvErrAt || (now - this._procKvErrAt) > 60000) {
        this._procKvErrAt = now;
        this._log("processing kv ✗", String(e && e.message || e));
      }
      return;
    }
    const get = (k) => { const r = rows.find(x => x.key === k); return r ? r.value : undefined; };
    local = get("proc_local") === "1" || get("proc_local") === "true";
    stream = get("proc_stream") === "1" || get("proc_stream") === "true";
    // SLICE 4 — THE MASTER RACK: the stored `rack_master` document, or — for a station that has never opened
    // the rack — the rack SEEDED from the keys every earlier build wrote (audiod/rack-seed.js). A station with
    // nothing stored runs the shipped chain, bit-identical to before. While LINKED the stream branch runs the
    // monitor's modules (the document says so; the engine is handed both branches).
    const { doc, source } = RackSeed.seedMasterRack(get);
    const L = RackSeed.branchParams(doc, "local");
    const geq = RackSeed.geqOf(doc);
    const docStr = JSON.stringify(doc);
    const eqActive = !!(geq.on && geq.bands && geq.bands.some(g => Math.abs(g) > 0.05));
    const prev = this._procApplied;
    const changed = !prev || prev.local !== local || prev.stream !== stream || prev.docStr !== docStr;
    const reassert = (local || stream || eqActive) && (now - (this._procAssertedAt || 0) > 15000);
    if (!changed && !reassert) return;
    this._procApplied = { local, stream, docStr };
    this._procOn = local || stream;
    this._procAssertedAt = now;
    try {
      A.audioSetProcessing(this.stationId, local, stream, L.target);
      if (typeof A.audioSetMasterRack === "function") {
        // THE RACK — one document, one Params block. The live-only bypasses are not in it (the engine keeps
        // what it is running), so this ~15 s re-assert can never clear a bypass the operator engaged.
        let res = null;
        try { res = JSON.parse(A.audioSetMasterRack(this.stationId, docStr)); } catch { res = null; }
        if (!res || res.ok !== true) this._log("rack refused ✗", (res && res.reason) || "no answer from the engine");
      } else {
        // An engine older than slice 4 (the daemon and the addon normally ship together): the legacy numbers,
        // and the GEQ — which the legacy path never re-applied at all.
        const S = RackSeed.branchParams(doc, "stream");
        if (typeof A.audioSetProcessorParams === "function") {
          A.audioSetProcessorParams(this.stationId, 0, L.target, L.ceiling, L.release, L.rate, L.clamp);
          A.audioSetProcessorParams(this.stationId, 1, S.target, S.ceiling, S.release, S.rate, S.clamp);
        }
        if (typeof A.audioSetEq === "function") A.audioSetEq(this.stationId, JSON.stringify(geq.on && geq.bands ? geq.bands : new Array(10).fill(0)));
      }
      if (changed) this._log("processing", `local=${local} stream=${stream} | rack (${source}) link=${doc.link} ` +
        `monitor target=${L.target} ceiling=${L.ceiling} | GEQ ${geq.bands ? (geq.on ? (eqActive ? "on" : "flat") : "OUT") : "removed"}`);
    } catch (e) { this._log("processing apply ✗", String(e)); }
  }

  // SLICE 5 — THE CHANNEL RACKS (docs/dsp-channel-rack-eq.md §3). THIS station's `rack_ch_<slot>` documents,
  // read on the same 3 s cadence as the master rack and delivered with audioSetChannelRack when one changes —
  // so they land on connect and re-land on every fresh engine (a new engine object starts with nothing
  // applied). A rack with anything IN is re-asserted every 15 s, like the master: a command sent in a
  // no-device window is dropped by the engine, and an identical re-send is a no-op there (same plan → no fade).
  // A fader with no document is never sent anything: its rack stays empty — today's exact arithmetic.
  // THE MIC (docs/dsp-mic-in-engine.md §4) — THIS station's `mic_input_<slot>` patches (machine-local), read on
  // the same 3 s cadence and delivered with audioSetMicInput when one changes: so a patch lands on connect,
  // re-lands on every fresh engine (a new engine object starts with nothing applied), and an unpatch (the row
  // removed or emptied) unpatches. The ENGINE opens, watches and re-opens the device; this only says what is
  // patched where. A slot never patched is never sent anything.
  // PARK MIC BUFFER (Jeff, 2026-10-16: "visible 'Park mic buffer' setting starting at 120 ms") — the station's own setting,
  // read on the same 3 s cadence and sent when it changes (and to every fresh engine). Not set → the engine keeps the value
  // it starts with (native/src/micin.rs PARK_BUFFER_START_MS = 120, the same number Preferences writes in).
  _applyParkMicBufferFromKv(now) {
    if (now - (this._pmbCheckedAt || 0) < 3000) return;
    this._pmbCheckedAt = now;
    if (typeof A.audioSetParkMicBuffer !== "function") return;
    let ms = null;
    try {
      const r = this.db.prepare("SELECT value FROM station_config_kv WHERE station_id=? AND key='park_mic_buffer_ms' AND deleted_at IS NULL").get(this.stationId);
      const n = r ? Number(r.value) : NaN;
      if (r && String(r.value).trim() !== "" && Number.isFinite(n)) ms = Math.round(n);
    } catch { return; }
    if (ms == null || ms === this._pmbApplied) return;
    try { const v = A.audioSetParkMicBuffer(this.stationId, ms); this._pmbApplied = ms; this._log("park mic buffer", `${v} ms`); }
    catch (e) { this._log("park mic buffer ✗", String(e && e.message || e)); }
  }

  _applyMicInputsFromKv(now) {
    if (now - (this._micCheckedAt || 0) < 3000) return;
    this._micCheckedAt = now;
    if (typeof A.audioSetMicInput !== "function") return;   // an engine older than the mic input
    let rows;
    try {
      const keys = MicInput.MIC_KEYS;
      rows = this.db.prepare(
        `SELECT key, value FROM station_config_kv WHERE station_id=? AND key IN (${keys.map(k => `'${k}'`).join(",")}) AND deleted_at IS NULL`
      ).all(this.stationId);
    } catch (e) {
      if (!this._micErrAt || (now - this._micErrAt) > 60000) { this._micErrAt = now; this._log("mic inputs kv ✗", String(e && e.message || e)); }
      return;
    }
    if (!this._micApplied) this._micApplied = {};
    for (const slot of MicInput.MIC_SLOTS) {
      const r = rows.find(x => x.key === MicInput.micKey(slot));
      const p = MicInput.parseMicInput(r && r.value);
      const want = p ? MicInput.serializeMicInput(p) : "";
      const prev = this._micApplied[slot];
      if (prev === undefined && !want) continue;   // never patched, nothing to unpatch
      if (prev === want) continue;
      let res = null;
      try { res = JSON.parse(A.audioSetMicInput(this.stationId, slot, p ? p.device : "", p ? p.channel : 0, p ? p.gainDb : 0)); }
      catch (e) { res = { ok: false, reason: String(e && e.message || e) }; }
      this._micApplied[slot] = want;   // a refused patch is not retried every 3 s; a new edit re-sends
      if (res && res.ok === true) this._log("mic input", `${slot}: ${p ? `${p.device} · input ${p.channel} · ${p.gainDb >= 0 ? "+" : ""}${p.gainDb} dB` : "unpatched"}`);
      else this._log("mic input refused ✗", `${slot}: ${(res && res.reason) || "no answer from the engine"}`);
    }
  }

  _applyChannelRacksFromKv(now) {
    if (now - (this._chRackCheckedAt || 0) < 3000) return;
    this._chRackCheckedAt = now;
    if (typeof A.audioSetChannelRack !== "function") return;   // an engine older than slice 5
    let rows;
    try {
      const keys = RackSeed.CHANNEL_KEYS;
      rows = this.db.prepare(
        `SELECT key, value FROM station_config_kv WHERE station_id=? AND key IN (${keys.map(k => `'${k}'`).join(",")}) AND deleted_at IS NULL`
      ).all(this.stationId);
    } catch (e) {
      if (!this._chRackErrAt || (now - this._chRackErrAt) > 60000) { this._chRackErrAt = now; this._log("channel racks kv ✗", String(e && e.message || e)); }
      return;
    }
    const get = (k) => { const r = rows.find(x => x.key === k); return r ? r.value : undefined; };
    if (!this._chApplied) this._chApplied = {};
    const reassert = now - (this._chAssertedAt || 0) > 15000;
    if (reassert) this._chAssertedAt = now;
    for (const slot of RackSeed.CHANNEL_SLOTS) {
      const { doc, source } = RackSeed.channelRack(get, slot);
      const docStr = JSON.stringify(doc);
      const prev = this._chApplied[slot];
      // Never-applied + empty = nothing to send (the engine's rack is already empty).
      if (prev === undefined && source === "empty") continue;
      const changed = prev !== docStr;
      if (!changed && !(reassert && RackSeed.channelRackActive(doc))) continue;
      let res = null;
      try { res = JSON.parse(A.audioSetChannelRack(this.stationId, slot, docStr)); } catch (e) { res = { ok: false, reason: String(e && e.message || e) }; }
      if (res && res.ok === true) {
        this._chApplied[slot] = docStr;
        if (changed) this._log("channel rack", `${slot}: ${RackSeed.channelRackActive(doc) ? "IN" : "nothing IN"} (${doc.sections.ch.length} slot(s))`);
      } else {
        this._chApplied[slot] = docStr;   // do not retry a refused document every 3 s; a new edit re-sends
        this._log("channel rack refused ✗", `${slot}: ${(res && res.reason) || "no answer from the engine"}`);
      }
    }
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
        // OBSERVED BYPASS. Echoed back from the bus so every window renders the engine's actual state
        // rather than its own copy: the rack lives in a pop-out (a separate renderer) and the banner on
        // the Master Out row lives in the main window, so a UI-local flag would let the two disagree.
        // State is read, never assumed.
        rideBypass: !!lv.proc_ride_bypass, limiterBypass: !!lv.proc_limiter_bypass,
        // The ceiling the limiter is ACTUALLY holding. Carried here so a panel never has to print a
        // literal "-1 dBTP" that stops being true the moment the operator moves the control.
        ceilingDbtp: lv.proc_ceiling_dbtp ?? -1.0,
        // THE STREAM BRANCH's own meters and parameters. Present whether or not the operator has split
        // them: while linked they simply read the same as the monitor, which is the honest report.
        stream: {
          inLufs: lv.proc_stream_in_lufs ?? -70, outLufs: lv.proc_stream_out_lufs ?? -70,
          grDb: lv.proc_stream_gr_db ?? 0, rideGainDb: lv.proc_stream_ride_gain_db ?? 0,
          inPeakDb: dbfs(lv.proc_stream_in_peak ?? 0), outPeakDb: dbfs(lv.proc_stream_out_peak ?? 0),
          target: lv.proc_stream_target_lufs ?? -14, ceilingDbtp: lv.proc_stream_ceiling_dbtp ?? -1,
          releaseMs: lv.proc_stream_release_ms ?? 120, rideRate: lv.proc_stream_ride_rate ?? 1.5,
          rideClamp: lv.proc_stream_ride_clamp ?? 12,
          rideBypass: !!lv.proc_stream_ride_bypass, limiterBypass: !!lv.proc_stream_limiter_bypass,
        },

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
  // EVERY load goes through the daemon's one normalizer (audiod/loudness.js via DaemonEngine.loadHook): gain = the station's
  // target − the file's measured loudness. A per-item gain passed here is ignored (Jeff, 2026-10-11: no per-item trims).
  _load(deck, fp, title, artist, _gainDbIgnored) {
    if (typeof DaemonEngine.loadHook === "function") return DaemonEngine.loadHook(deck, fp, title, artist, this.stationId);
    return A.audioLoad(deck, fp, title || "", artist || "", 0, this.stationId);
  }
  /** Load a deck starting `startSec` into the file (the engine's audio_load_from): the watchdog resuming a stalled song
   *  at the exact spot. Through the same normalizer as every load. False when the engine cannot (an older engine). */
  _loadFrom(deck, fp, title, artist, startSec) {
    if (typeof DaemonEngine.loadHook === "function") return DaemonEngine.loadHook(deck, fp, title, artist, this.stationId, startSec);
    if (typeof A.audioLoadFrom !== "function") return false;
    return A.audioLoadFrom(deck, fp, title || "", artist || "", 0, startSec, this.stationId);
  }
  // Pure + testable: which deck ids are rotation decks. CART is the jingle overlay, not a rotation deck.
  _isRotationDeck(deck) { return deck === "A" || deck === "B" || deck === "C"; }
  // A deck plays at whatever fader the OPERATOR set — automation NEVER moves a deck fader (those are
  // operator controls). Just clear the overlap guard so this deck's next seam can early-start again.
  // liveDeck observer (2026-07-29): also record the deck the engine itself put on air. Every path that
  // puts a MUSIC deck live funnels through here — handleRotate, load-next, play-now, skip,
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
    this.deckQid[id]     = t.qid ?? null;                 // which queue entry this deck holds; replaced with the occupant
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
    this._applyChannelRacksFromKv(now); // SLICE 5: each fader's channel rack (rack_ch_<slot>)
    this._applyMicInputsFromKv(now);    // THE MIC: each source channel's input patch (mic_input_<slot>, machine-local)
    this._applyParkMicBufferFromKv(now); // PARK MIC: the station's Park mic buffer (park_mic_buffer_ms)
    this._applySegueOverlapFromKv(now); // the operator's segue overlap, stored with the station
    this._applyPflDimFromKv(now);       // PFL: the programme dim in the local output while a PFL is on
    this._applyCueDeviceFromKv(now);    // PFL: the cue output device on this machine (machine-local)

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

    // Retire drained decks. Sits here, on the freshest deck state and before any decision work, for the
    // same reason the guard above does. It can only ever stop a deck that has already finished.
    this._retireTick(now);

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
    // while the seam bridges. Observed, not claimed: only counts when samples are actually flowing on CART.
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

  // ── No top-of-hour hard cut (removed 2026-10-04, Jeff's ruling) ─────────────────────────────────────
  // There used to be a once-an-hour cut here that stopped A/B/C mid-song, cleared the queue and
  // reloaded from the new hour's log. It is gone. A song that crosses :00 plays to its end and the new
  // hour JOINS after it: on flipped stations loggen.selectRowForNow's hour join (audiod/hour-join.js)
  // makes the hour's head the next row instead of letting the anchored reader skip past it; on legacy
  // stations the queue already holds the new hour's rows in log order. Pinned by
  // audiod/top-of-hour-removed.test.js, audiod/hour-join.test.js and audiod/smoke-hour-rollover.js.

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
    if (playing) {
      this._lastPlayingAt = now; this._watchdogArmed = true;   // healthy → re-arm
      // What is on air, and where it is — the song the watchdog resumes if it stalls (Jeff, 2026-10-19).
      const st = this._deckState(playing);
      this._lastLive = { deck: playing, filePath: st.filePath || "", title: st.title || "", artist: st.artist || "", positionSec: st.positionSec || 0, durationSec: st.durationSec || 0 };
      return;
    }

    // Is there anything to recover WITH? A cued/loaded deck, or queued (or continuous-refillable) content.
    // A deck "has content" when it has a FILE (filePath) — never a title. Rust's audio_stop clears the
    // file but (until 2026-09-16) kept the title, so a stopped deck read as content here, the recovery
    // below picked it, Rust refused to play it, and the retry fired every 2s until the top of the hour
    // — 8 hours of dead air on OV, 1h33m on OVEVENTS (docs/ovevents-crash-loop-alarm-2026-09-15.md §4).
    const haveContent = order.some(d => !!this._deckState(d).filePath) || this.queue.length > 0 || this.continuous;
    if (!haveContent) return;                               // genuinely nothing to play — not a stall
    // A PLANNED SILENCE is not a stall (2026-10-18): the log has nothing that may play until the next show starts (or
    // another day's rows), or no show is on. The refill starts the next row when it is due.
    if (this._logWait && this.queue.length === 0) { this._lastPlayingAt = now; return; }
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
    this._advance("watchdog-recover", () => this._resumeStalled());
  }

  // ── THE WATCHDOG RESUMES THE STALLED SONG, NEVER A DIFFERENT DECK (Jeff, 2026-10-19) ─────────────────────
  // "Watchdog: after a stall, resume the stalled song at the exact spot it stalled. Never play a different deck."
  // It used to play whatever idle deck held a file (a cued standby, any loaded deck), or load the queue onto deck A.
  // Now: the deck that was last on air is the one that resumes. If it still holds its song, it plays on from where the
  // engine holds it. If its song had ended (a segue that failed to start), the stalled thing is the log's NEXT row —
  // the deck cued with it by the log goes on, nothing else. If the stalled deck lost its source, nothing else is played:
  // it is reported loudly (resuming mid-song needs a seek the native engine does not have yet — see the build report).
  async _resumeStalled() {
    const order = ["A", "B", "C"];
    if (order.some(d => this._deckState(d).status === "playing")) return false;
    const last = this._lastLive;
    if (last && last.deck) {
      const st = this._deckState(last.deck);
      const endedNaturally = Number.isFinite(last.durationSec) && last.durationSec > 0 && last.positionSec >= last.durationSec - 1.5;
      if (!endedNaturally) {
        if (st.filePath && st.filePath === last.filePath && this._play(last.deck) !== false) {
          this._setDeck(last.deck, { status: "playing" });
          this.endTriggered.delete(last.deck);
          this._log(`watchdog: resumed the stalled song on deck ${last.deck} — "${last.title || "(untitled)"}" (at ${Math.round(last.positionSec)}s)`);
          return true;
        }
        // THE SOURCE IS GONE: reload the same song on the same deck AT THE EXACT SPOT it stalled (Jeff, 2026-10-19: "after a
        // stall, resume the stalled song at the exact spot it stalled. Never play a different deck."). The position is the
        // last one heard on air (this poll tick's live position stream).
        if (last.filePath && this._loadFrom(last.deck, last.filePath, last.title, last.artist, last.positionSec) !== false
            && this._play(last.deck) !== false) {
          this._setDeck(last.deck, { status: "playing", filePath: last.filePath, title: last.title || "", positionSec: last.positionSec, durationSec: last.durationSec });
          this.endTriggered.delete(last.deck);
          this._log(`watchdog: reloaded the stalled song on deck ${last.deck} at the exact spot — "${last.title || "(untitled)"}" from ${last.positionSec.toFixed(1)}s`);
          try { this.emit("stall-resumed", { stationId: this.stationId, deck: last.deck, title: last.title || "", filePath: last.filePath, positionSec: last.positionSec, how: "reloaded-at-position" }); } catch {}
          return true;
        }
        this._log(`watchdog: the stalled song on deck ${last.deck} ("${last.title || "(untitled)"}") cannot be resumed — its source is gone; nothing else is played`);
        this.emit("error", { stationId: this.stationId, where: "watchdog", kind: "stalled-unresumable", deck: last.deck, title: last.title || "", filePath: last.filePath || "",
          error: `stalled song "${last.title || ""}" on deck ${last.deck} lost its source at ${Math.round(last.positionSec)}s — not resumed, no other deck played` });
        return false;
      }
    }
    // The song had ended: the log's next row goes on — the deck the log cued with it (the queue's head entry), else load it.
    const head = this.queue.find(q => !this._isAired(q));
    const cuedDeck = head ? order.find(d => this.deckQid[d] === head.qid && this._deckState(d).status === "idle" && !!this._deckState(d).filePath) : null;
    if (cuedDeck) {
      if (this._play(cuedDeck) === false) { this._log(`watchdog: deck ${cuedDeck} refused the log's next row`); return false; }
      this._setDeck(cuedDeck, { status: "playing", positionSec: 0 });
      this.endTriggered.delete(cuedDeck); this.deckReady.delete(cuedDeck);
      this._consumeDeckEntry(cuedDeck);
      this._fireStart(cuedDeck);
      this._log(`watchdog: the song had ended — the log's next row on deck ${cuedDeck}: "${this._deckState(cuedDeck).title || "(untitled)"}"`);
      return true;
    }
    await this.refillIfNeeded();
    const next = this._takePending();
    if (!next) return false;
    const deck = (last && last.deck) || "A";
    if (!this.loadToDeck(deck, next)) return false;
    this.deckChainType[deck] = next.chainType || "segue";
    if (this._play(deck) === false) return false;
    this._setDeck(deck, { status: "playing", positionSec: 0 });
    this.endTriggered.delete(deck);
    this._fireStart(deck);
    this._log(`watchdog: the song had ended — the log's next row loaded on deck ${deck}: "${next.title || "(untitled)"}"`);
    return true;
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
    // CONTENT IS A FILE, NOT A TITLE (2026-09-16). These three picks selected on `.title`, and Rust's
    // audio_stop left the title on a deck it had emptied — so a deck the calendar re-cue had just
    // stopped was picked, refused by Rust, marked LIVE anyway, logged as a play, and picked again 2s
    // later until the top of the hour. filePath is the bit Rust clears when a deck truly has nothing.
    const hasFile = (d) => !!this._deckState(d).filePath;
    const cued = order.find(d => this.manualCue.has(d) && this._deckState(d).status === "idle" && hasFile(d))
              || order.find(d => this.deckReady.has(d) && this._deckState(d).status === "idle" && hasFile(d))
              || order.find(d => this._deckState(d).status === "idle" && hasFile(d));
    if (cued) {
      // RUST'S REFUSAL IS THE TRUTH. audio_play returns false when the deck has no content
      // (native/src/lib.rs). Before this the return value was dropped: status became "playing",
      // _fireStart wrote a play_log row and bumped the jingle generation for audio that never
      // started. Now a refusal changes NO state that claims air — it is logged, surfaced, the
      // phantom deck is emptied on our side too, and recovery falls through to the queue.
      if (this._play(cued) === false) {
        const was = this._deckState(cued);   // read BEFORE the deck is emptied below — the ledger names what we thought was there
        this._log("resume-playout: deck " + cued + " REFUSED by the engine (no content loaded) — falling through to the queue");
        this.emit("error", { stationId: this.stationId, where: "resume-playout", kind: "refused", deck: cued, title: was.title || "", filePath: was.filePath || "", error: "play refused — deck " + cued + " has no loaded source; loading from the queue instead" });
        // Counted where a missing file is counted (Library & Rotation "skipped this hour") and written to
        // health-events.jsonl with deck + file. A refusal that only the daemon log knew about was the
        // gap named in docs/ovevents-crash-loop-alarm-2026-09-15.md §5 addendum.
        this._noteLoadSkip(was.title || "(empty deck)", "refused by engine — deck " + cued + " had no loaded source", { deck: cued, filePath: was.filePath || "" });
        this.deckReady.delete(cued);
        this.manualCue.delete(cued);
        this._setDeck(cued, { status: "idle", title: "", artist: "", filePath: "", positionSec: 0 });
      } else {
        this._setDeck(cued, { status: "playing", positionSec: 0 });
        this.endTriggered.delete(cued);
        this.deckReady.delete(cued);
        if (this.manualCue.has(cued)) this.manualCue.delete(cued);  // it just went live
        this._consumeDeckEntry(cued);                                 // its own entry, never "whatever is first"
        this._fireStart(cued);
        this._log("resume-playout: deck " + cued + " LIVE — " + (this._deckState(cued).title || "(untitled)"));
        return true;
      }
    }
    // Nothing cued anywhere — load + play the next PLAYABLE track from the queue onto deck A.
    await this.refillIfNeeded();
    let guard = 0;
    while (this.queue.length > 0 && guard++ < 100) {
      const next = this._takePending();
      if (!next) break;
      if (this.loadToDeck("A", next)) {
        this.deckChainType.A = next.chainType || "segue";
        if (this._play("A") === false) {   // same contract: a refused play is not a play
          this._log("resume-playout: deck A REFUSED by the engine after load — skipping " + (next.filePath || ""));
          this.emit("error", { stationId: this.stationId, where: "resume-playout", kind: "refused", deck: "A", title: next.title || "", filePath: next.filePath || "", error: "play refused after load: " + (next.filePath || "") });
          this._noteLoadSkip(next.title, "refused by engine after load (resume-playout)", { deck: "A", filePath: next.filePath || "" });
          this._setDeck("A", { status: "idle", title: "", artist: "", filePath: "", positionSec: 0 });
          continue;
        }
        this._setDeck("A", { status: "playing", positionSec: 0 });
        this.endTriggered.delete("A");
        this._fireStart("A");
        this._log("resume-playout: deck A LIVE — " + (this.stateA.title || "(untitled)"));
        return true;
      }
      this.emit("error", { stationId: this.stationId, where: "resume-playout", kind: "unplayable", deck: "A", title: next.title || "", filePath: next.filePath || "", error: "skipped unplayable: " + (next.filePath || "") });
      this._noteLoadSkip(next.title, "unplayable at load (resume-playout)", { deck: "A", filePath: next.filePath || "" });
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
    // THE TWO 5s BELOW ARE NOT THE SAME DECISION. They share a value and nothing else, and someone will
    // eventually change them together. Do not.
    //
    //   dur > 5 in positionEnd      — UNEXPLAINED. It arrived with "Ether v1.5 initial release" and no
    //                                 commit, comment or doc says why short items are excluded from the
    //                                 engine's own clock. Its effect: an item of 5s or less on a rotation
    //                                 deck can ONLY end via Rust's finished flag (observed 2026-09-07 —
    //                                 a 4s item with no backend flag never ends at all). Nothing under 5s
    //                                 reaches a rotation deck today, which is why it has never bitten.
    //
    //   (dur - pos) < 5 in genuineBackendEnd — DELIBERATE, and a real incident fix: 5fcb47f (2026-05-12)
    //                                 "Rust occasionally emits a spurious 'ended' status for a preloaded
    //                                 or mid-play deck ... causing C to fire and play over an active
    //                                 deck." The position must corroborate the flag. The `dur <= 5` escape
    //                                 beside it exists so short items, whose position can never satisfy a
    //                                 5s window, are not locked out of the only gate they have.
    //
    // The 0.3 is also unexplained (same v1.5 origin) but it is not a truncation risk: the window has no
    // floor, so any late sample still lands in it, and checkEnd only triggers a rotate — it stops nothing.
    // See docs/end-detection-trace-2026-09-07.md for the observations behind all three.
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
      // — _jingleTick starts the incoming deck at this deck's natural end. Defers ONLY
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

  /** Retire decks that have finished after a rotate. Poll-driven, and the ONLY automatic path that stops
   *  a rotation deck. THE CONTRACT: a deck that reports playing is never stopped, for any elapsed time.
   *  A deck leaves _retiring by draining, by being re-loaded (deckGen), or by becoming the target.
   *
   *  A deck that never drains is a real fault, not something to cut short: it is reported once as a
   *  health event and left alone. The liveDeck guard owns that case — it stops a foreign deck past its
   *  grace, conditionally and loudly, which is where "a deck holding audio it shouldn't" belongs. */
  _retireTick(now) {
    if (!this._retiring.size) return;
    for (const [deck, r] of [...this._retiring]) {
      if (this._outgoingStopAction(deck, r.gen, r.toId) !== "stop") { this._retiring.delete(deck); continue; }
      if (this._deckState(deck).status === "playing") {
        // STILL HAS AUDIO — leave it alone. Say so once if it is abnormally long, so a deck that never
        // drains is visible rather than silent (observed, never assumed).
        if (!r.warned && now - r.since > this._foreignGraceMs()) {
          r.warned = true;
          this._log(`retire ${deck}: still playing ${((now - r.since) / 1000).toFixed(1)}s after the rotate — NOT stopping it (the song owns its tail)`);
          try { this.emit("error", { stationId: this.stationId, where: "deck-retire-slow", deck, error: `deck ${deck} still playing ${Math.round((now - r.since) / 1000)}s after its rotate — not stopped` }); } catch {}
        }
        continue;
      }
      this._retiring.delete(deck);
      this._advance("stop:" + deck, async () => this._retireDeck(deck, "drained"));
    }
  }

  /** The stop itself — bookkeeping only, never a truncation. Tells Rust the slot is idle and clears the
   *  readiness flags, exactly as the Bug-A deferred stop did. */
  _retireDeck(deck, why) {
    this._stop(deck);
    this.deckReady.delete(deck);
    this.endTriggered.delete(deck);
    this._log(`retire ${deck} (${why})`);
  }

  /** The operator's segue overlap, read from the station. Same delivery pattern as the processing
   *  settings: cheap, poll-driven, and it never disturbs playout if the KV is unreadable. The app also
   *  pushes it live via setSegueOverlap; this is what makes the daemon correct on its own. */
  _applySegueOverlapFromKv(now) {
    if (now - (this._segueKvAt || 0) < 3000) return;
    this._segueKvAt = now;
    try {
      // The one reader (audiod/segue-overlap.js) — Generate times the log with the same number.
      const next = segueOverlap.readSegueOverlapSec(this.db, this.stationId);
      if (next == null) return;                                      // unset or unreadable → leave what we have
      if (next === this.segueOverlap) return;
      this.segueOverlap = next;
      this._log(`segue overlap = ${next}s (from the station's settings)`);
    } catch { /* KV unreadable → keep the last value; never disturb playout */ }
  }

  // PFL (docs/help-channel-faders.md) — the station's `pfl_dim_db`: how far the programme in the local output
  // drops while any channel's PFL is on. Delivered on change AND to every fresh engine (a new engine object
  // starts with nothing applied). Unset → the engine keeps PFL_DIM_DB_DEFAULT, which is what Preferences shows.
  _applyPflDimFromKv(now) {
    if (now - (this._pflDimAt || 0) < 3000) return;
    this._pflDimAt = now;
    if (typeof A.audioSetPflDim !== "function") return;
    try {
      const row = this.db.prepare(
        "SELECT value FROM station_config_kv WHERE station_id=? AND key='pfl_dim_db' AND deleted_at IS NULL"
      ).get(this.stationId);
      if (!row || row.value == null || row.value === "") return;
      const v = parseFloat(row.value);
      if (!Number.isFinite(v)) return;
      const next = Math.max(-60, Math.min(0, v));
      if (next === this._pflDimApplied) return;
      if (A.audioSetPflDim(this.stationId, next)) { this._pflDimApplied = next; this._log(`PFL dim = ${next} dB (from the station's settings)`); }
    } catch { /* KV unreadable → keep the last value; never disturb playout */ }
  }

  // PFL OUTPUT DEVICE — this machine's `pfl_cue_device` ("" = same as the main output). Delivered on change and to
  // every fresh engine; the ENGINE opens it (the AUX monitor's device path), never falls back, and reports its state.
  // A station never set is never sent anything (the engine starts at "same as main").
  _applyCueDeviceFromKv(now) {
    if (now - (this._cueDevAt || 0) < 3000) return;
    this._cueDevAt = now;
    if (typeof A.audioSetCueDevice !== "function") return;
    try {
      const row = this.db.prepare(
        "SELECT value FROM station_config_kv WHERE station_id=? AND key='pfl_cue_device' AND deleted_at IS NULL"
      ).get(this.stationId);
      const want = row && row.value != null ? String(row.value) : "";
      if (this._cueDevApplied === undefined && !want) return;
      if (want === this._cueDevApplied) return;
      if (A.audioSetCueDevice(this.stationId, want)) {
        this._cueDevApplied = want;
        this._log(`PFL output = ${want ? `"${want}"` : "same as the main output"} (this machine's setting)`);
      }
    } catch { /* KV unreadable → keep the last value; never disturb playout */ }
  }

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
        // THE OUTGOING SONG ALWAYS PLAYS TO ITS NATURAL END. Nothing here stops a deck that still has
        // audio. The incoming plays OVER it.
        //
        // WHAT THIS REPLACES, AND WHY. This was a setTimeout at crossfadeDuration*1000 + 500 that stopped
        // the outgoing deck on a clock, explicitly forcing the stop even while the deck reported playing.
        // That delay was calibrated in 7d2d159 (2026-05-05) for a rotate that happened at the deck's
        // NATURAL END, and its purpose was never to end audio — it was to clear a stale Rust "playing"
        // status AFTER the audio had drained. Its own words: "The natural tail still plays out, then Rust
        // is told the deck is idle." segueOverlap later moved the rotate N seconds BEFORE the end and
        // nobody revisited the delay, so with an overlap of 5 it cut 1.5s off the end of every segued
        // song. The stale-status problem it was invented for is separately closed: audio_get_state
        // persists status='ended' onto the deck when it consumes the finished flag (lib.rs:243-249), so
        // "still playing" is now a truthful reading and can be trusted as the condition.
        //
        // Bug A is untouched. The retire still runs on the _advance chain (serialized with preload), still
        // carries the deckGen guard via _outgoingStopAction, and still clears deckReady/endTriggered when
        // it fires so a nulled Rust source is never left marked "ready". ONLY THE TRIGGER CHANGED — from a
        // clock to the deck's own drained state.
        // PRELOAD CADENCE ONLY — how soon _armAfterRotate cues the two standby decks. This is NOT a stop
        // delay: nothing in this engine stops a deck on a clock any more.
        const cfMs = Number.isFinite(opts && opts.cutMs) ? opts.cutMs : this.crossfadeDuration * 1000;
        const fromGen = this.deckGen[fromId];
        if (Number.isFinite(opts && opts.cutMs)) {
          // An OPERATOR safety cut (take-over) is a deliberate hard stop and keeps its timer: a person
          // asked for that audio to come off now. Automation never takes this branch.
          setTimeout(() => this._advance("stop:" + fromId, async () => {
            if (this._outgoingStopAction(fromId, fromGen, toId) !== "stop") return;
            this._retireDeck(fromId, "operator-cut");
          }), opts.cutMs);
        } else {
          this._retiring.set(fromId, { gen: fromGen, toId, since: Date.now(), warned: false });
        }
        this._setDeck(toId, { status: "playing", positionSec: 0 });
        this._fireStart(toId);
        this._log("segue: deck " + toId + " LIVE — " + (this._deckState(toId).title || "(untitled)"));
        this.deckReady.delete(toId); this.endTriggered.delete(toId);
        // A hand-loaded deck wasn't fed from the queue — don't dequeue against it (that would drop
        // an unrelated upcoming song). Auto-cued decks DO consume their queue slot.
        if (this.manualCue.has(toId)) this.manualCue.delete(toId);
        this._consumeDeckEntry(toId);   // the entry THIS deck holds (none for a hand load), never the first in the queue
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
          const next = this._takePending();
          if (!next) break;
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
  // TWO LAYERS (2026-09-16): `preload()` is the public wrapper — it queues the work on the serialized
  // advance chain, as every caller outside the chain must. `_preloadNow()` is the body — it assumes it
  // is ALREADY running on the chain and must be the one called from inside another _advance op.
  //
  // Why: the calendar re-cue (_resyncCuedDecks) ran inside `_advance("recue:B")` and did
  // `await this.preload(B)`. preload chained a NEW op onto advanceP — which at that moment was the
  // promise of the recue op itself — and awaited it. The recue waited for the preload; the preload was
  // queued behind the recue. Every re-cue wedged the chain for the rest of the song (44 of 44 on
  // OVEVENTS, `advanceP WEDGED <song length>ms`), nothing was cued for the seam, and the stall
  // recovery then picked the deck the re-cue had just emptied — the 2-second dead-air loop.
  // Receipts: docs/ovevents-crash-loop-alarm-2026-09-15.md §4.2.
  preload(deckId, queueIndex = 0) {
    if (this.deckReady.has(deckId)) return Promise.resolve();   // already cued — idempotent
    const st = this._deckState(deckId);
    if (st.status === "playing" || st.status === "paused") return Promise.resolve();
    return this._advance("preload:" + deckId, () => this._preloadNow(deckId, queueIndex));
  }
  // The body. ONLY call this from code that is already executing on the advance chain.
  // ONLY A PENDING ENTRY IS CUED (Phase 1). `queueIndex` used to be a position in the WHOLE queue, so position 0
  // could be an entry another deck already held, or one that had aired. Every deck now takes the FIRST pending
  // entry (pending = in the queue, held by no deck, not aired): a deck already cued holds its own entry, which is
  // therefore not pending, so "the next deck takes the next song" follows without counting. `queueIndex` is kept
  // for the callers' signature and no longer used. `opts.qid` (a calendar re-cue) names the exact entry.
  async _preloadNow(deckId, queueIndex = 0, opts = null) {
    void queueIndex;
    if (this.deckReady.has(deckId)) return;                   // re-check inside the chain
    const st2 = this._deckState(deckId);
    if (st2.status === "playing" || st2.status === "paused") return;
    // Never cue a file that's already playing/cued on another deck — that stacked the same song.
    const onOtherDecks = ["A", "B", "C"].filter(d => d !== deckId).map(d => this._deckState(d).filePath).filter(Boolean);
    let guard = 0;
    while (guard++ < 100) {
      const pending = this.queue.filter(q => !this.boundQids.has(q.qid));
      let next = opts && opts.qid ? pending.find(q => q.qid === opts.qid) : null;
      if (opts && opts.qid && !next) return;                  // the named entry is gone: the next refill decides
      if (!next) next = pending.find(q => !onOtherDecks.includes(q.filePath));
      if (!next) return;
      if (this._isAired(next)) { this._dropAired(next, "preload"); if (opts) opts = null; continue; }
      if (this.loadToDeck(deckId, { ...next })) { this.deckChainType[deckId] = next.chainType || "segue"; this.deckReady.add(deckId); if (next.qid) this.boundQids.add(next.qid); return; }
      const qi = this.queue.indexOf(next); if (qi >= 0) this.queue.splice(qi, 1);
      if (opts) opts = null;
      this.emit("queue", { stationId: this.stationId, items: this.queue });
      this.emit("error", { stationId: this.stationId, where: "preload", error: "dropped unplayable: " + (next.filePath || "") });
      this._noteLoadSkip(next.title, "unplayable at load (preload)");
    }
  }

  // Slice B — every skip of an unresolvable row is LOUD: a structured health event (title, station,
  // reason) that main routes to the library-health skipped-at-load sense + health-events.jsonl. A deck
  // load must never die silently again.
  // `extra` (2026-09-16): deck + file, so a REFUSED play (the engine had the deck, Rust had no file) is
  // named in the ledger as fully as a missing file is — main routes this to library-health.noteSkip.
  _noteLoadSkip(title, reason, extra) {
    try { this.emit("loadskip", { stationId: this.stationId, title: title || "(untitled)", reason, ...(extra || {}) }); } catch { /* never break playout */ }
  }

  // Log-Reader Flip (ACTIVATION) — is the time-anchored log-reader ON for THIS station? Per-station via
  // station_config_kv key='log_reader_flip' (LOCAL-AUTHORITATIVE, rider B — never synced), plus the dev
  // env global override. Cached 5s so a canary toggle takes effect within seconds, no restart. Read-only.
  //
  // ALWAYS ON (Jeff, 2026-10-19: "Log reader for everything: on for every station on every computer, retire the old
  // path. One way to play the log, no per-machine switch."). The switch was per computer and never synced, so two
  // machines could play the same station two different ways; the old path had no hour boundary at all, so every row of
  // an hour that overran :00 played into the next hour. The method stays so its callers read the same; the key is ignored.
  _logReaderOn() { return true; }

  async refillIfNeeded() {
    if (!this.continuous) return;
    // Log-Reader Flip: when ON for this station, playout is a READ-THROUGH of generated_schedule via the
    // §2.7 selector — the queue becomes a cache of log rows >= the playhead (§2.3). OFF path below is
    // byte-identical to the pre-flip legacy behaviour.
    return this._refillFromLog();
  }

  // The retired queue-sourced refill (loggen.fillQueue), kept only so its health senses' wording is on record; nothing
  // calls it. One way to play the log (Jeff, 2026-10-19).
  async _retiredQueueRefill() {
    // ── legacy queue-sourced refill (retired) ──
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
        // …but never a song the operator added (queue:enqueue): manually added songs are never taken out (Jeff, 2026-10-18).
        this.queue = this.queue.filter(q => typeof q.scheduledAt === "number" || q.handAdded);
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
  async _refillFromLog(opts = {}) {
    const now = Date.now();
    // `force` bypasses the 2s throttle. AUTO uses it: engaging automation must anchor to the calendar
    // THIS second, not up to two seconds later, because the row it picks is the one that goes to air.
    if (!opts.force && now - (this._lastRefillAt || 0) < 2000) return;
    this._lastRefillAt = now;
    // Rule 1 (Jeff, 2026-10-19): a cued row whose hour has ended never airs — let it go before reading.
    this._releaseEndedHourRows(Math.floor(now / 1000));
    let r;
    // The seam: when the queue's next entry would start (a row of the next show is offered once that show has started).
    const seamTs = this._projectedSeamTs();
    // THE LOG PLAYS AS BUILT (Jeff, 2026-10-18): the reader is told which log row is on air, and offers the row after it.
    // The reference is the LAST LOG ROW THAT WENT TO AIR in this AUTO session (on air now, or finished — a wait for the
    // next show keeps the place, so that show opens with its first row). null = nothing of
    // the log has aired since AUTO came on: the row for now (or, at a show's start, that piece's first row).
    const readOpts = { seamTs, onAirRowId: this._lastLogRowAired ?? null, ...(this._startAtPieceHead ? { fromPieceStart: true } : {}) };
    try { r = loggen.readLogAnchored(this.db, this.stationId, 20, undefined, readOpts); }
    catch (e) { this._log("logreader refill error: " + String(e)); return; }
    // Every row the read offered was refused by the playout check: stamp them and read again (bounded), so a refusal is
    // never taken for the end of the log.
    for (let k = 0; k < 10 && r.mode === "skipping"; k++) {
      const held = new Set(["A", "B", "C"].map(d => this.deckSchedId[d]).filter(x => x != null));
      for (const sk of (r.skip || [])) {
        if (held.has(sk.rowId)) continue;
        try { this.db.prepare("UPDATE generated_schedule SET state='skipped', pick_reason=? WHERE id=? AND station_id=? AND state='pending'").run(`skipped at playout: ${sk.rule} ${sk.measuredMin}/${sk.settingMin} min`, sk.rowId, this.stationId); } catch {}
        this._log(`PLAYOUT CHECK: "${sk.title || "(untitled)"}" (row ${sk.rowId}) skipped — ${sk.rule} ${sk.measuredMin} of ${sk.settingMin} min`);
      }
      try { r = loggen.readLogAnchored(this.db, this.stationId, 20, undefined, readOpts); } catch (e) { this._log("logreader refill error: " + String(e)); return; }
    }
    // NOTHING DUE. No built-in fill (Jeff, 2026-10-18): the station waits for the next row it may play — the next show's
    // start, or a row's own time. A wait INSIDE a show (the log has nothing more for it) is reported; outside every show
    // there is no programming and silence is correct.
    const _wasWaiting = !!this._logWait;
    this._logWait = r.mode === "nothing-due" && !r.items.length;   // a planned silence: the stall watchdog stands down
    if (r.mode === "nothing-due" && !r.items.length) {
      const why = r.inShow ? "inside-show" : "no-show";
      const key = why + ":" + (r.nextDueTs || "");
      if (this._lastWaitReason !== key) {
        this._lastWaitReason = key;
        this._log(`waiting: nothing is due${r.nextDueTs ? " — the next log row may start at " + new Date(r.nextDueTs * 1000).toLocaleTimeString() : " — the log has no more rows"} (${why})`);
        if (r.inShow) { try { this.emit("logreader-floor", { stationId: this.stationId, reason: "waiting:log-ended-inside-show", nextDueTs: r.nextDueTs ?? null }); } catch {} }
      }
      // THE LOG IS DONE AND NO SHOW FOLLOWS → AUTO TURNS OFF (Jeff, 2026-10-18: "when rows are done being played and there
      // is no show following scheduled auto turns off and nothing plays"). Only after log rows have aired in this AUTO
      // session (automation started before the first row still waits for it), and only once no deck is playing.
      const anyPlaying = ["A", "B", "C"].some(d => { const st = this._deckState(d); return st && st.status === "playing"; });
      if (!r.inShow && this._started && this._logAiredSinceStart && !anyPlaying) {
        this._log("AUTO OFF: the log rows are done and no show follows — automation turned off, nothing plays");
        this.stop();
        this._logAiredSinceStart = false;
        try { this.emit("enginestate", { stationId: this.stationId, state: this._engineState || "off", started: false }); } catch {}
        try { this.emit("logreader-auto-off", { stationId: this.stationId, reason: "log-done-no-show" }); } catch {}
        return;
      }
    }
    if (r.items.length) this._lastWaitReason = null;
    // THE WAIT IS OVER (the next show has started, or the next day): its first row goes to air
    // now, not when the stall watchdog notices the silence.
    if (_wasWaiting && r.items.length && this._started && this._mayDecide()
        && !["A", "B", "C"].some(d => { const st = this._deckState(d); return st && st.status === "playing"; })) {
      this._lastPlayingAt = Date.now();
      setImmediate(() => { this._advance("log-due", () => this._resumePlayout()); });
    }
    // THE PLAYOUT CHECK (Phase 3): rows refused because, by now, they break a rule against what aired. A row a deck already
    // holds is not refused here: it was checked when it was offered, and the deck airs it (stamping it 'skipped' would make
    // the record lie, as 'missed' did — the Phase 1 lesson).
    { const held = new Set(["A", "B", "C"].map(d => this.deckSchedId[d]).filter(x => x != null));
      if (r.skip && r.skip.length && held.size) r.skip = r.skip.filter(k => !held.has(k.rowId)); }
    if (r.skip && r.skip.length) {
      for (const k of r.skip) {
        try { this.db.prepare("UPDATE generated_schedule SET state='skipped', pick_reason=? WHERE id=? AND station_id=? AND state='pending'").run(`skipped at playout: ${k.rule} ${k.measuredMin}/${k.settingMin} min`, k.rowId, this.stationId); } catch {}
        this._log(`PLAYOUT CHECK: "${k.title || "(untitled)"}" (row ${k.rowId}) skipped — ${k.rule} ${k.measuredMin} of ${k.settingMin} min`);
      }
      try { this.emit("logreader-missed", { stationId: this.stationId, count: r.skip.length, driftSec: r.driftSec, reason: "playout-check" }); } catch {}
    }

    // THE BOUND HEAD IS THE CUED DECKS, AND IT STAYS IN THE QUEUE. (Reverted 2026-09-14, same night.)
    //
    // §2.4a says "only the currently-playing deck is committed", and I read that as "the bound head
    // should contain only the playing deck's row". That is wrong about this data structure: dequeue()
    // splices an item OUT of the queue and out of boundQids the moment its deck goes live (:1572-1577),
    // so the playing row is never in the queue at all. Filtering the bound head down to playing decks
    // therefore made it ALWAYS EMPTY — which dropped the cued decks' items from the queue while the
    // decks still held them, desynced dequeue() from what was actually loaded, and produced rows
    // stamped `missed` while they were audibly on air.
    //
    // §2.4a is still right, and it is honoured by _resyncCuedDecks below: the cued decks FOLLOW the
    // calendar by being re-cued when they diverge, not by being evicted from the queue that tracks
    // them. "Not committed" means "may be replaced", not "must not be represented".
    const boundHead = this.queue.filter(q => this.boundQids.has(q.qid));
    const boundSchedIds = new Set(boundHead.map(q => q.schedId).filter(x => x != null));

    // NOTHING TO OFFER. The end-of-hour reset that stood here — every 2 s it emptied everything not on a deck, so a song
    // the operator added during the wait for :00 vanished — is gone (Jeff, 2026-10-18). Inside a show the log no longer
    // waits for :00, so the reader says 'nothing-due' only where the show schedule says nothing of this log may play
    // now: the show has ended, the next row is another show's or another day's, or the log is done. Then:
    //   • songs added by hand that are not log rows stay in Up Next (manually added songs are never taken out);
    //   • LOG rows the reader no longer offers come out of Up Next and off the standby decks — they belong to an hour
    //     that has ended (they are stamped didn't-air at the next read) or to a piece that has not started, and a row
    //     left cued would air after the show (Jeff: "a show's last row ends and nothing plays after the show"). A row
    //     added by hand stays in the log, untouched; it airs once its show is on again.
    // A read ERROR changes nothing: a database hiccup must never empty a cued deck.
    if (!r.items.length) {
      if (r.mode !== "nothing-due") return;
      const pend = this.queue.filter(q => !this.boundQids.has(q.qid));
      const keep = pend.filter(q => q.handAdded && q.schedId == null);
      if (keep.length !== pend.length) {
        this.queue = [...boundHead, ...keep];
        this.emit("queue", { stationId: this.stationId, source: "logreader:" + r.mode, items: this.queue });
      }
      this._releaseStandbyLogRows("the log has nothing that may play now");
      return;
    }

    // A ROW A DECK HOLDS IS NEVER MARKED MISSED (Phase 1). The reader names every pending row before the anchor, and that
    // included rows already cued on a standby deck — which then aired, so the record said 'missed' for songs that played
    // (the Phase 1 test: 15 of 38 rows in a drifting evening). A cued row is going to air; whether it should (Hour start,
    // the clock on air) is Phase 3's decision, never the record's.
    const _held = new Set(["A", "B", "C"].map(d => this.deckSchedId[d]).filter(x => x != null));
    if (_held.size && r.missedRowIds.length) r.missedRowIds = r.missedRowIds.filter(id => !_held.has(id));
    // BEHIND — stamp the skipped-past pending rows 'missed' (day-bounded, from readLogAnchored). Loud.
    if (r.missedRowIds.length) {
      try {
        const ph = r.missedRowIds.map(() => "?").join(",");
        // Never a row added by hand (Jeff, 2026-10-18): the reader already leaves them out; the statement says so too.
        this.db.prepare(`UPDATE generated_schedule SET state='missed' WHERE id IN (${ph}) AND station_id=? AND state='pending' AND ${loggen.notOperatorSql("generated_schedule")}`).run(...r.missedRowIds, this.stationId);
      } catch { /* stamping is best-effort; never break playout */ }
      try { this.emit("logreader-missed", { stationId: this.stationId, count: r.missedRowIds.length, driftSec: r.driftSec }); } catch {}
      // A COMMERCIAL THAT DID NOT AIR IS NAMED.
      //
      // Jeff, 2026-09-14: "A missed spot must be loud — Health Monitor, naming the spot and the time.
      // Six today and I only found out by asking." Nothing was on air yet, so there was no billing
      // consequence — and that will not be true for long.
      //
      // The count above is not enough: "8 rows missed" reads as bookkeeping, and a song that did not
      // air is a programming choice while a spot that did not air is an advertiser who was billed for
      // something that never played. So SPOTS are separated out and each one is named with its slot
      // time. Emitted per sweep, never per row, so a long catch-up is one honest line and not a storm.
      try {
        const ph2 = r.missedRowIds.map(() => "?").join(",");
        const spots = this.db.prepare(
          `SELECT title, scheduled_at FROM generated_schedule
            WHERE id IN (${ph2}) AND station_id = ? AND content_class = 'SPOT'
            ORDER BY scheduled_at`).all(...r.missedRowIds, this.stationId);
        if (spots.length) {
          const named = spots.map(s => ({ title: s.title || "(untitled)", scheduledAt: s.scheduled_at }));
          this.emit("spot-missed", { stationId: this.stationId, count: named.length, spots: named });
          for (const s of named) {
            this._log(`SPOT DID NOT AIR — "${s.title}" was due ${new Date(s.scheduledAt * 1000).toLocaleTimeString()}`);
          }
        }
      } catch (e) { this._log("spot-missed report failed (stamping already done): " + String(e)); }
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

    this._retirePassedSweepers();


    // A cued deck that is no longer the calendar's next row is re-cued below (_resyncCuedDecks).
    // Rebuild the PENDING region from the anchored log rows (dedup vs the bound head).
    const seen = new Set(boundSchedIds); const kept = [];
    for (const it of r.items) {
      if (it.schedId != null && seen.has(it.schedId)) continue;
      if (this._isAired(it)) continue;      // it went to air; its stamp may still be landing — never offer it again
      // Resolve rather than merely test: a row from another install names a folder we do not have,
      // and the library tier finds it by basename. Keep the RESOLVED path or the deck loads the one
      // that does not exist.
      const rp = this._resolveLocal(it.filePath);
      if (!rp) { if (!it.fileKey) this._noteLoadSkip(it.title, "unresolvable — no local file, no file_key"); continue; }
      if (it.schedId != null) seen.add(it.schedId);
      kept.push(rp === it.filePath ? it : { ...it, filePath: rp });
    }
    // THE PLAYER PLAYS THE LOG, IN ORDER. (Reorder deleted 2026-09-15.)
    //
    // Jeff: "The generator does the math weeks ahead; the player plays the log. A mechanism that can
    // only correct drift that doesn't exist, and drops spots when it can't, has no reason to be there."
    //
    // orderForNearestAnchor weighed "spot now" against "spot after the next song" and promoted the
    // closer one. It existed to pick the least-bad seam among seams that had drifted off their anchors.
    // But Generate already places a spot ON its anchor — measured over a day on station 2, mean 1.9s —
    // and the drift it was correcting was never shown to exist: the only evidence was air times from a
    // dev box that runs intermittently, which is not a receipt for anything.
    //
    // What it DID reliably do was fail in one direction. It could only reorder rows that were not yet
    // cued, so when a spot came due behind an already-cued song it could not move it, the slot passed,
    // and the anchored reader stamped the spot `missed` — an advertiser's commercial silently not
    // airing. A mechanism that cannot help when it matters, and can hurt when it does not, is not one
    // worth keeping.
    //
    // The decks follow the calendar instead: _resyncCuedDecks re-cues a standby deck whose row is no
    // longer what the calendar says is next — the same job, done from the right end.
    const freshPending = this._ensureIds(kept);
    // Only emit if the pending region actually changed (avoid a queue-event storm on the 2s tick).
    const oldPendingItems = this.queue.filter(q => !this.boundQids.has(q.qid));
    // A song added by hand that is not a log row (a cart, a voice track, a spot) is kept, after the log's rows: the
    // rebuild reads only the log, and before 2026-10-18 it dropped every such entry within 2 s.
    const handKept = oldPendingItems.filter(q => q.handAdded && q.schedId == null);
    const oldPending = oldPendingItems.map(q => q.schedId ?? ("q" + q.qid)).join(",");
    const newPending = [...freshPending, ...handKept].map(q => q.schedId ?? ("q" + q.qid)).join(",");
    this.queue = [...boundHead, ...freshPending, ...handKept];
    if (oldPending !== newPending) {
      this.emit("queue", { stationId: this.stationId, source: "logreader", items: this.queue });
      this._log("logreader refill: " + freshPending.length + " pending from log (mode=" + r.mode + ", queue=" + this.queue.length + ")");
      this._resyncCuedDecks();

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
    }

  }

  /** The next seam, in epoch SECONDS: now + what remains on the playing deck. No deck playing → now.
   *  Reads only the state _segueTick already uses; never writes. */
  //
  // THE LATEST-ENDING PLAYING DECK (2026-10-19). It took the first playing deck in A,B,C order — during a segue overlap
  // that can be the OUTGOING song with seconds left, so the seam came out early and a row of an hour that was about to
  // end still looked startable before :00 (rule 1: the 2 PM leftovers that played 3:00–3:15).
  _projectedSeamTs() {
    const nowSec = Math.floor(Date.now() / 1000);
    let remaining = 0;
    for (const d of ["A", "B", "C"]) {
      const st = this._deckState(d);
      if (st.status !== "playing") continue;
      remaining = Math.max(remaining, (st.durationSec || 0) - (st.positionSec || 0));
    }
    return nowSec + (remaining > 0 ? Math.round(remaining) : 0);
  }

  // ── RULE 1: THE TOP OF THE HOUR (Jeff, 2026-10-19) ───────────────────────────────────────────────────────
  // "The song crossing :00 plays out, then the NEW hour's first row. The old hour's remaining rows are marked
  // didn't-play and never air in the new hour." The reader already passes them over when it reads — but a row it had
  // cued on a STANDBY deck before :00 was never judged again and aired (the 2 PM leftovers, 3:00–3:15 on OV). So, the
  // moment a piece has ended by the clock, every standby deck still holding an automatic row of it lets go, the row is
  // stamped didn't-play, and the decks are cued from the new hour — while the crossing song is still on air.
  // A row added by hand is exempt (Jeff, 2026-10-19: it plays after the crossing song). Returns the rows let go.
  _releaseEndedHourRows(nowSec) {
    const ended = [];
    for (const d of ["A", "B", "C"]) {
      const id = this.deckSchedId[d];
      if (id == null || this.manualCue.has(d)) continue;
      const st = this._deckState(d);
      if (st.status === "playing" || st.status === "paused") continue;
      let row = null;
      try { row = this.db.prepare(`SELECT gs.id, gs.source, gs.title, ${loggen.logKeySql(this.db)} AS lk FROM generated_schedule gs WHERE gs.id = ? AND gs.station_id = ?`).get(id, this.stationId); } catch {}
      if (!row || loggen.isOperatorRow(row)) continue;
      let endTs = null;
      try { endTs = loggen.pieceEndFor(this.db, this.stationId, row.lk); } catch {}
      if (endTs == null || nowSec < endTs) continue;
      ended.push({ d, id, title: row.title || st.title || "(untitled)" });
    }
    if (!ended.length) return ended;
    try {
      const ph = ended.map(() => "?").join(",");
      this.db.prepare(`UPDATE generated_schedule SET state='missed' WHERE id IN (${ph}) AND station_id=? AND state='pending' AND ${loggen.notOperatorSql("generated_schedule")}`)
        .run(...ended.map(e => e.id), this.stationId);
    } catch { /* stamping is best-effort; the deck still lets go */ }
    this._advance("hour-ended:" + ended.map(e => e.d).join(""), async () => {
      for (const e of ended) {
        const st = this._deckState(e.d);
        if (st.status === "playing" || st.status === "paused" || this.manualCue.has(e.d) || this.deckSchedId[e.d] !== e.id) continue;
        this._stop(e.d);
        this.deckReady.delete(e.d); this.endTriggered.delete(e.d);
        this._releaseDeckEntry(e.d);
        this.deckSchedId[e.d] = null;
        this.queue = this.queue.filter(q => q.schedId !== e.id);
        this._setDeck(e.d, { status: "idle", title: "", artist: "", filePath: "", positionSec: 0 });
        this._log(`top of the hour: standby deck ${e.d} let go of "${e.title}" (row ${e.id}) — its hour has ended; marked didn't-play`);
        this._maybeEmitDeck(e.d);
      }
    });
    try { this.emit("logreader-missed", { stationId: this.stationId, count: ended.length, driftSec: 0, why: "hour-ended" }); } catch {}
    return ended;
  }

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
  _writeOperatorLogRow(info, deck, via, place = null) {
    if (!this._logReaderOn() || !info || !info.filePath) return null;
    const where = `deck=${deck || "?"} via=${via || "?"}`;
    const base = String(info.filePath).split(/[\\/]/).pop();
    const cls = this._resolveHandLoadClass(info.filePath);

    // REFUSALS ARE LOGGED. A silent refusal is how this class of bug hides.
    if (cls !== "MUSIC") {
      this._log(`LOG-READER hand-load: ${where} class=${cls || "UNKNOWN"} file="${base}" → NO ROW ` +
                `(${cls ? "not music — imaging/commercial never enters the airable music log" : "unresolved — not in songs, spots or cart_slots"})`);
      return null;
    }

    try {
      // WHERE THE ROW GOES. A deck hand-load is at the playhead: now, in the log hour that owns now. A song added to Up
      // Next is placed by the caller (place = { scheduledAt, logHourTs }): right after the last entry in Up Next.
      const nowTs = Math.floor(Date.now() / 1000);
      const at = place && Number.isFinite(place.scheduledAt) ? place.scheduledAt : nowTs;
      const hourTs = place && Number.isFinite(place.logHourTs) ? place.logHourTs : loggen.pieceStartFor(this.db, this.stationId, at);
      let songId = info.songId ?? null, durS = info.durationMs ? Math.round(info.durationMs / 1000) : null;
      if (songId == null) {   // the library row behind the file: the playout check and the Program Log read the song
        try {
          const s = this.db.prepare("SELECT id, duration_ms FROM songs WHERE file_path = ? AND deleted_at IS NULL LIMIT 1").get(info.filePath);
          if (s) { songId = s.id; if (durS == null && s.duration_ms) durS = Math.round(s.duration_ms / 1000); }
        } catch {}
      }
      const iso = new Date().toISOString();
      const withHour = loggen.hasLogHour(this.db);
      const r = this.db.prepare(
        `INSERT INTO generated_schedule (scheduled_at, song_id, title, artist, file_path, file_key, duration_s, station_id, uuid, state, source, content_class, created_at, updated_at${withHour ? ", log_hour_ts" : ""})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'operator', 'MUSIC', ?, ?${withHour ? ", ?" : ""})`
      ).run(at, songId, info.title || "", info.artist || "", info.filePath, info.fileKey || null,
            durS, this.stationId, crypto.randomUUID(), iso, iso, ...(withHour ? [hourTs] : []));
      try { this.emit("logreader-operator-write", { stationId: this.stationId, title: info.title || "" }); } catch {}
      this._log(`LOG-READER hand-load: ${where} class=MUSIC file="${base}" → wrote row id=${r.lastInsertRowid}`);
      return { id: Number(r.lastInsertRowid), scheduled_at: at, lk: hourTs };
    } catch (e) { this._log(`LOG-READER hand-load: ${where} file="${base}" → the row could not be written: ${String(e)}`); return null; }
  }

  /** A deck went live: take ITS entry out of the queue (by qid). A deck holding nothing from the queue takes out
   *  nothing — never "whatever is first". */
  _consumeDeckEntry(deckId) {
    const qid = this.deckQid[deckId];
    if (!qid) return;
    this.boundQids.delete(qid);
    const i = this.queue.findIndex(q => q.qid === qid);
    if (i >= 0) { this.queue.splice(i, 1); this.emit("queue", { stationId: this.stationId, items: this.queue }); }
  }
  /** A cued deck lets go of its entry (a re-cue, the X): no longer "on a deck". The entry stays in the queue as
   *  pending if it is still there, so the log decides where it goes next. */
  _releaseDeckEntry(deckId) {
    const qid = this.deckQid[deckId];
    this.deckQid[deckId] = null;
    if (qid) this.boundQids.delete(qid);
  }
  /** Has this queue entry's row gone to air? (in memory, set at go-live) */
  _isAired(item) { return !!item && item.schedId != null && this._airedRows.has(item.schedId); }
  _noteAired(schedId) {
    if (schedId == null) return;
    this._airedRows.add(schedId);
    if (this._airedRows.size > 4000) this._airedRows.delete(this._airedRows.values().next().value);
  }
  _dropAired(item, where) {
    const qi = this.queue.indexOf(item); if (qi >= 0) this.queue.splice(qi, 1);
    if (item.qid) this.boundQids.delete(item.qid);
    this._log(`${where}: dropped "${item.title || "(untitled)"}" (row ${item.schedId}) — it has already aired`);
    this.emit("queue", { stationId: this.stationId, items: this.queue });
  }
  /** Take the first PENDING entry (held by no deck, not aired) out of the queue. */
  _takePending() {
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      if (this.boundQids.has(q.qid)) continue;
      if (this._isAired(q)) { this._dropAired(q, "queue"); i--; continue; }
      this.queue.splice(i, 1);
      this.emit("queue", { stationId: this.stationId, items: this.queue });
      return q;
    }
    return null;
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
  // ── THE AUDIO LIBRARY TIER (2026-09-04) ──────────────────────────────────────────────────────
  //
  // The daemon half of the resolver. main.js has the same tier in resolveLocalAudioPath, and BOTH
  // are required: fixing one alone gets announcements onto decks while nothing airs, or the reverse
  // (Jeff, 2026-09-04). The app resolves what an operator loads; this resolves what automation airs.
  //
  // WHY: `file_path` is a synced blob-ref that in v0 ships the literal absolute path, so a row from
  // another install names a folder this machine does not have. On OV that silenced every sweeper,
  // announcement and cart while the bytes sat in the audio library under the right name. Under the
  // one-library rule the basename plus THIS machine's library is what travels.
  //
  // Rebuilt at most every 30s — a log refill resolves dozens of rows in a burst, and walking the
  // folder per row would be pathological on the audio thread's doorstep.
  _libraryDir() {
    if (this.__libDir !== undefined) return this.__libDir;
    let dir = null;
    try {
      const prof = process.env.ETHER_PROFILE_DIR;
      if (prof) dir = fs.readFileSync(path.join(prof, 'music-dir.txt'), 'utf8').trim() || null;
    } catch { /* not set — fall through to the default */ }
    if (!dir) {
      // Same default as the app's defaultLibraryDir(): <Music>/ether music library.
      try { dir = path.join(require('os').homedir(), 'Music', 'ether music library'); } catch { dir = null; }
    }
    this.__libDir = dir;
    return dir;
  }
  _libIndex() {
    const now = Date.now();
    if (!this.__libIdx || now - (this.__libIdxAt || 0) > 30000) {
      try { this.__libIdx = require('../electron/audio-library-index').buildIndex(this._libraryDir()); }
      catch (e) { this.__libIdx = { byBasename: new Map(), byNorm: new Map(), files: 0 }; }
      this.__libIdxAt = now;
    }
    return this.__libIdx;
  }

  /**
   * Resolve a stored path to something this machine can actually play.
   * @returns an absolute path, or null.
   *
   * THIS RETURNS A PATH, NOT A BOOLEAN, and that distinction is the whole fix. `_fileOk` only ever
   * answered "is this playable?" — so a row whose file lived in the library under a different
   * directory could pass the gate and then be loaded from the path that does not exist. Callers
   * must use what comes back here.
   */
  _resolveLocal(fp) {
    if (!fp) return null;
    if (/^[a-z]+:\/\//i.test(fp)) return fp;                 // a URL is the daemon's to stream, not to stat
    if (fs.existsSync(fp) && this._dur(fp) > 0) return fp;    // fast path — the stored path is right
    try {
      const hit = require('../electron/audio-library-index').findInIndex(this._libIndex(), fp);
      if (hit && fs.existsSync(hit) && this._dur(hit) > 0) {
        this._log(`resolved from audio library: ${require('../electron/audio-library-index').storedBasename(fp)} -> ${hit}`);
        return hit;
      }
    } catch { /* index unavailable — fall through to unresolvable */ }
    return null;
  }

  // Kept as the boolean gate every existing call site expects, now backed by the resolver so the
  // two can never disagree about what "playable" means.
  _fileOk(fp) { return !!this._resolveLocal(fp); }

  // REWRITES filePath to whatever actually resolves, rather than only filtering. An item that
  // survives this is one the deck can load from the path it carries.
  _playable(items) {
    return (items || []).reduce((out, it) => {
      if (!it) return out;
      const r = this._resolveLocal(it.filePath);
      if (r) out.push(r === it.filePath ? it : { ...it, filePath: r });
      return out;
    }, []);
  }
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
                      // path (rotate / load-next / skip / play-now / resume).
    this.emit("playstart", { stationId: this.stationId, deck: deckId, title: st.title, artist: st.artist, filePath: st.filePath });
    // Item 10 Phase 2 Step 4: the daemon owns play logging in daemon-driven mode (the
    // renderer's logPlay is gated off), so Play History survives a UI/app restart. Never
    // throws into the playout path.
    // WHAT AIRED IS THE RECORD (design §3.9, Phase 1): the play and the row's stamp in ONE transaction, now, on this
    // path — not a moment later off the chain inside a catch that swallowed every error, which is how a busy
    // database left an aired row 'pending' for the reader to offer again (10/16).
    this._recordGoLive(deckId, st);
    // Log-Reader Flip Phase 1/3 — SHADOW (observational), DEFERRED OFF THE ADVANCE CRITICAL PATH
    // (2026-07-22 incident fix). These do DB read/write (a COUNT + two UPDATEs); under DB contention a
    // slow op here previously stalled _fireStart → stalled the serialized advance chain → delayed the
    // deferred deck-stop → a leaked/overlapping deck. setImmediate runs them AFTER the current advance
    // tick completes, so the shadow can NEVER again delay a rotation or its stop — the shadow's own stated
    // principle ("must never perturb playout"), now enforced by placement. Capture the row id now
    // (deckSchedId may be overwritten by a later load before this fires). Order preserved: EVAL (compares
    // while the row is still 'pending') THEN STAMP.
    // The stamp is no longer here (it is in _recordGoLive, above). The shadow evaluation stays deferred and is told
    // which row just aired, so it still compares "what aired" with "what the reader would air".
    const _shadowSchedId = this.deckSchedId[deckId];
    setImmediate(() => {
      try { this._shadowEvalTimeAnchor(deckId, _shadowSchedId); } catch { /* never perturb playout */ }
    });
  }

  /** The go-live record. In memory first (no path can cue this row again from this second), then the database, in
   *  one transaction (audiod/playlog.js recordGoLive). A failed write is retried every 500 ms for 30 s; a retry that
   *  a newer go-live overtakes stamps its row 'played', never 'playing' over the newer one; a write that never lands
   *  is an alert (`not-stamped`). Never throws into playout. */
  _recordGoLive(deckId, st) {
    if (this.deckSchedId && this.deckSchedId[deckId] != null) { this._logAiredSinceStart = true; this._lastLogRowAired = this.deckSchedId[deckId]; this._startAtPieceHead = false; }
    try {
      const schedId = this.deckSchedId[deckId] ?? null;
      const at = Math.floor(Date.now() / 1000);
      const gen = ++this._recordGen;
      const twiceInMemory = schedId != null && this._airedRows.has(schedId);
      this._noteAired(schedId);
      const args = { stationId: this.stationId, title: st.title, artist: st.artist, deck: deckId, durationMs: Math.round((st.durationSec || 0) * 1000),
        sessionId: SESSION, filePath: st.filePath, contentClass: this.deckContentClass[deckId] || null, rowId: schedId, playedAt: at };
      const done = (r) => {
        if (r.repeat || twiceInMemory) this._alert("row-aired-twice", { severity: "red", rowId: schedId, rowUuid: r.rowUuid, at, title: st.title, artist: st.artist, filePath: st.filePath, path: "go-live:" + deckId,
          message: `"${st.title || "(untitled)"}" (log row ${schedId}) went to air again — it had already aired` });
        if (r.retired) this._alert("retired-row-aired", { severity: "yellow", rowId: schedId, rowUuid: r.rowUuid, at, title: st.title, artist: st.artist, filePath: st.filePath, path: "go-live:" + deckId,
          message: `"${st.title || "(untitled)"}" (log row ${schedId}) aired after the log had marked it ${r.retired}` });
        if (r.missingRow) this._alert("not-stamped", { severity: "yellow", rowId: schedId, at, title: st.title, artist: st.artist, filePath: st.filePath, path: "go-live:" + deckId,
          message: `"${st.title || "(untitled)"}" aired as log row ${schedId}, which is no longer in the log — the play is recorded without its row` });
      };
      const r = playlog.recordGoLive(this.db, args);
      if (r.ok) { done(r); return; }
      this._log(`RECORD failed for "${st.title || "(untitled)"}" (row ${schedId ?? "—"}): ${r.error} — retrying; the row is already held as aired`);
      let tries = 0;
      const retry = () => {
        tries++;
        // Overtaken by a newer go-live: this play still happened and is still written, but its row is no longer
        // the one on air, so it is stamped 'played', never 'playing'.
        const r2 = playlog.recordGoLive(this.db, gen === this._recordGen ? args : { ...args, overlay: true });
        if (r2.ok) { this._log(`RECORD landed for row ${schedId ?? "—"} after ${tries} retr${tries === 1 ? "y" : "ies"}`); done(r2); return; }
        if (tries < 60) { setTimeout(retry, 500); return; }
        this._alert("not-stamped", { severity: "red", rowId: schedId, at, title: st.title, artist: st.artist, filePath: st.filePath, path: "go-live:" + deckId,
          message: `"${st.title || "(untitled)"}" aired at ${new Date(at * 1000).toLocaleTimeString()} but neither its play nor its log row could be written for 30 s: ${r2.error}` });
      };
      setTimeout(retry, 500);
    } catch (e) { this._log("record error (playout unaffected): " + String(e)); }
  }

  /** One structured alert (design §6.2): main stamps it into the v1 schema, the ledger, the stream and the list. The
   *  engine only detects and reports. */
  _alert(kind, d) {
    try { this.emit("alert", { stationId: this.stationId, kind, ...d }); } catch {}
  }

  /** SWEEPER ROWS: one that fired was stamped 'played' when it fired (_logJinglePlay). One whose seam went by without
   *  it firing is stamped 'missed' here: scheduled before the music row now on air, today, not the one armed. */
  _retirePassedSweepers() {
    try {
      const p = this.db.prepare("SELECT MAX(scheduled_at) AS ts FROM generated_schedule WHERE station_id=? AND state='playing' AND deleted_at IS NULL AND (content_class IS NULL OR content_class NOT IN ('JIN','SWP'))").get(this.stationId);
      if (!p || p.ts == null) return;
      const d0 = new Date(); d0.setHours(0, 0, 0, 0);
      const keep = this._jingle && this._jingle.rowId != null ? this._jingle.rowId : -1;
      const r = this.db.prepare(`UPDATE generated_schedule SET state='missed' WHERE station_id=? AND state='pending' AND deleted_at IS NULL
          AND content_class IN ('JIN','SWP') AND scheduled_at >= ? AND scheduled_at < ? AND id != ?`).run(this.stationId, Math.floor(d0.getTime() / 1000), p.ts, keep);
      if (r && r.changes) this._log(`sweepers: ${r.changes} sweeper row(s) whose seam passed without firing stamped 'missed'`);
    } catch { /* never break playout */ }
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
      // The aired row is already stamped (Phase 1 records at go-live), so the reader is asked as if it were still
      // pending: "which row would you air now?" must be answered with the row that just went live still in the running.
      const d = loggen.selectRowForNow(this.db, this.stationId, nowTs, undefined, { asPending: airedSchedId });
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

  // queue:enqueue — THE OPERATOR ADDS TO UP NEXT (the Library's Q, a drop on Up Next, the jock strip's search, the
  // remote). Jeff, 2026-10-18: "manually adding songs should never be taken out." On the log reader the queue is rebuilt
  // from the log every 2 s, so an entry that is not a log row was wiped within 2 s. Now a library song added here BECOMES
  // A LOG ROW ADDED BY HAND (source='operator'), placed at the bottom of Up Next: right after the last entry there, in
  // that entry's log hour. Nothing automatic removes, skips or stamps it (loggen: never passed over while its show is on,
  // never refused by the playout check, never stamped didn't-air; Generate keeps operator rows; the Program Log shows
  // it). Only the user removes it (the X, or the Program Log's delete). Anything that cannot be a music row (a cart,
  // a voice track, a spot — _writeOperatorLogRow's rule) stays in Up Next as a hand-added entry every rebuild keeps.
  // Legacy addToQueue (crash-recovery restores, the renderer's own playout) is NOT an operator add and is unchanged.
  intentEnqueue(items) {
    const list = (items || []).filter(it => it && it.filePath);
    if (!this._logReaderOn()) {
      this.queue.push(...this._ensureIds(this._playable(list).map(it => ({ ...it, handAdded: true }))));
      this.emit("queue", { stationId: this.stationId, items: this.queue });
      return true;
    }
    let place = this._bottomOfUpNext();
    const rest = [];
    for (const it of list) {
      const row = this._writeOperatorLogRow(it, "-", "queue:enqueue", place);
      if (row) place = { scheduledAt: row.scheduled_at + 1, logHourTs: row.lk };
      else rest.push(it);
    }
    if (rest.length) this.queue.push(...this._ensureIds(this._playable(rest).map(it => ({ ...it, handAdded: true }))));
    this.emit("queue", { stationId: this.stationId, items: this.queue });
    // Show it in Up Next now, not on the next 2 s tick.
    Promise.resolve().then(() => this._refillFromLog({ force: true, why: "queue:enqueue" })).catch(() => {});
    return true;
  }

  /** Where a song added to the bottom of Up Next goes in the log: one second after the last log row in Up Next (or the
   *  row on air when Up Next holds none), in that row's log hour — so it sorts right after it (log order is log hour,
   *  scheduled_at, id). Nothing of the log anywhere → null: now, in the log hour that owns now. */
  _bottomOfUpNext() {
    try {
      const lastQ = [...this.queue].reverse().find(q => q.schedId != null);
      const id = lastQ ? lastQ.schedId : this._lastLogRowAired;
      if (id == null) return null;
      const r = this.db.prepare(`SELECT gs.scheduled_at, ${loggen.logKeySql(this.db)} AS lk FROM generated_schedule gs WHERE gs.id = ? AND gs.station_id = ?`).get(id, this.stationId);
      return r ? { scheduledAt: r.scheduled_at + 1, logHourTs: r.lk } : null;
    } catch { return null; }
  }

  /** The log has nothing that may play now (the show has ended, the next row is another show's or another day's, the
   *  log is done): a standby deck holding a LOG row lets go of it, so it cannot air after the show. Never a deck the
   *  operator cued by hand, never a playing or paused deck. The row itself is not touched. */
  _releaseStandbyLogRows(why) {
    const held = ["A", "B", "C"].filter(d => {
      const st = this._deckState(d);
      return this.deckSchedId[d] != null && st.status !== "playing" && st.status !== "paused" && !this.manualCue.has(d);
    });
    if (!held.length || this._jingle) return;
    this._advance("release-standby:" + held.join(""), async () => {
      for (const d of held) {
        const st = this._deckState(d);
        if (st.status === "playing" || st.status === "paused" || this.manualCue.has(d) || this.deckSchedId[d] == null) continue;
        const was = st.title || "(untitled)";
        this._stop(d);
        this.deckReady.delete(d); this.endTriggered.delete(d);
        this._releaseDeckEntry(d);
        this.deckSchedId[d] = null;
        this._setDeck(d, { status: "idle", title: "", artist: "", filePath: "", positionSec: 0 });
        this._log(`standby deck ${d} let go of "${was}" — ${why}`);
        this._maybeEmitDeck(d);
      }
    });
  }

  // queue:remove — THE X (Phase 1, T12). Removing an entry takes its ROW OUT OF THE LOG (a pending row only, soft
  // delete, the same as the Program Log's delete), so the next refill — which re-reads the log every 2 s — cannot
  // bring it back. Before, only the in-memory entry went and the row stayed pending, so it returned at once ("X not
  // removing songs", 10/17). An entry cued on a deck comes off that deck and the deck is cued with the next one. The
  // song on air is not in the queue; it is not removed here (the board's OFF does that).
  intentRemove(qid) {
    if (!qid) return false;
    const idx = this.queue.findIndex(it => it.qid === qid);
    if (idx < 0) return false;
    const item = this.queue[idx];
    const onDeck = ["A", "B", "C"].find(d => this.deckQid[d] === qid);
    if (onDeck && (this._deckState(onDeck).status === "playing" || this._deckState(onDeck).status === "paused")) {
      this._log(`queue X refused: "${item.title || "(untitled)"}" is on air on deck ${onDeck}`);
      return false;
    }
    this._removeLogRow(item, "removed from Up Next");
    if (onDeck) {
      this._advance("x-off-deck:" + onDeck, async () => {
        if (this._deckState(onDeck).status === "playing" || this.deckQid[onDeck] !== qid) return;
        this._stop(onDeck);
        this.deckReady.delete(onDeck); this.endTriggered.delete(onDeck);
        this._releaseDeckEntry(onDeck);
        this._setDeck(onDeck, { status: "idle", title: "", artist: "", filePath: "", positionSec: 0 });
        const i = this.queue.findIndex(q => q.qid === qid); if (i >= 0) this.queue.splice(i, 1);
        this._log(`queue X: "${item.title || "(untitled)"}" taken off deck ${onDeck} and out of the log`);
        this.emit("queue", { stationId: this.stationId, items: this.queue });
        if (this._mayDecide()) await this._preloadNow(onDeck, 0);
        this._maybeEmitDeck(onDeck);
      });
      return true;
    }
    this.queue.splice(idx, 1);
    this._log(`queue X: "${item.title || "(untitled)"}" out of Up Next and out of the log`);
    this.emit("queue", { stationId: this.stationId, items: this.queue });
    return true;
  }

  /** Take a queue entry's row out of the log: pending rows only (the record is never touched), soft delete. */
  _removeLogRow(item, why) {
    if (!item || item.schedId == null) return;
    try {
      const iso = new Date().toISOString();
      const r = this.db.prepare("UPDATE generated_schedule SET deleted_at=?, updated_at=? WHERE id=? AND station_id=? AND deleted_at IS NULL AND (state IS NULL OR state='pending')")
        .run(iso, iso, item.schedId, this.stationId);
      if (r && r.changes) { try { this.emit("log-row-removed", { stationId: this.stationId, rowId: item.schedId, title: item.title || "", why }); } catch {} }
    } catch (e) { this._log("queue X: could not take the row out of the log — " + String(e)); }
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
        this._consumeDeckEntry(target);
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
  async start(opts = {}) {
    this.init();
    const wasStarted = this._started;
    // A fresh AUTO session starts from the log's time, not from where an earlier session left off. A show's start
    // (ether-audiod.js _showStartTick) begins at that piece's FIRST row.
    if (!wasStarted) { this._lastLogRowAired = null; this._startAtPieceHead = !!opts.fromPieceStart; }
    // Coming back from MANUAL: the next refill's row-retirement is a handover, not a "behind" alarm.
    this._resumingFromManual = !wasStarted;
    this._started = true;   // Stage 3b: automation engaged — the stall watchdog is now allowed to recover.
    if (!wasStarted) this._logAiredSinceStart = false;   // AUTO OFF at the log's end needs a log row aired in THIS session
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
    // AUTO ANCHORS TO THE CALENDAR.
    //
    // This used to take queue[0] — whatever happened to be queued — and play it. It never asked what
    // should be on air at this second, so engaging automation after any break resumed wherever the
    // queue had been left rather than where the clock is. The anchored reader then ran on the next
    // refill tick and could only correct the tail BEHIND a start that was already wrong, because the
    // deck it had just started was in the bound head.
    //
    // Jeff: "the calendar is always supposed to be running no matter what." Engaging automation is
    // exactly the moment to obey that — forced, so it anchors to THIS second and not up to two
    // seconds later, because the row this picks is the one that goes to air.
    if (this._logReaderOn()) {
      try { await this._refillFromLog({ force: true }); }
      catch (e) { this._log("automationStart: anchor refill failed, using the existing queue — " + String(e)); }
    }
    // Load the first PLAYABLE track into A, skipping any missing-file items.
    let loaded = false, guard = 0;
    while (this.queue.length > 0 && guard++ < 100) {
      const first = this._takePending();
      if (!first) break;
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
  //   BRIDGING— outgoing deck ended; incoming starts at that end; the jingle plays on over both.
  //   CLEARED — incoming deck live again.  ARMED_CANCELLED — superseded/failed before firing (no log row).
  // THE ARM WINDOW IS NOT A LEAD-IN CEILING. It gates promotion from SCHEDULED to ARMED, and nothing
  // else — the read-ahead already queries the seam OUTSIDE it, cached per seam, so a wider window costs
  // no extra database work. Its only real cost is exposure: an ARMED sweeper is cancelled by
  // _jingleSuperseded on a skip or a manual load, so arming earlier means more
  // chances to be superseded.
  //
  // It was 30 from 48c7f1a (2026-07-14, JINGLES overlay v1) and never revisited. Nothing in that commit,
  // in either design doc, or anywhere in the history says why — and at the time the lead defaults were
  // 5 and 2, so 30 was six times the largest reachable value and could not bite.
  //
  // It became a SILENT CEILING on 2026-09-06, when LEAD became an operator control. Observed on the real
  // _jingleTick: at LEAD 40 / overlap 5 the sweeper armed at 30s remaining and fired at 29.75s, giving
  // 24.75s of lead instead of 40 — and the clamp starts at LEAD 26, not 30. The effective ceiling is
  // (_ARM_WINDOW_S - segueOverlap).
  //
  // 90 is chosen so it is not a practical limit for any imaging placed on a seam. The Sweepers panel
  // bounds its LEAD input at (90 - segueOverlap) so the UI can never offer a number this will not
  // honour — keep the two in step.
  static get _ARM_WINDOW_S() { return 90; }
  /** The largest LEAD this engine can actually honour at the current overlap. The UI mirrors it. */
  effectiveLeadCeiling() { return Math.max(0, DaemonEngine._ARM_WINDOW_S - (this.segueOverlap || 0)); }
  static get _FIRE_CONFIRM_MS() { return 900; }    // fired but no samples within this → failed, cancel

  _emitJingle(state, j) {
    try { this.emit("jingle", { stationId: this.stationId, state, deck: j ? j.deck : null,
      title: j ? j.title : null, categoryId: j ? j.categoryId : null, contentClass: j ? j.contentClass : null,
      leadInSec: j ? j.leadIn : null, jinDurSec: j ? (j.jinDur || 0) : null, ts: Date.now() }); } catch {}
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
    // The decision lives in cart-observe.js (pure, tested): signal / loaded-and-active / nothing, and since
    // 2026-10-04 FAULT when every channel is aux-routed and the aux output is down.
    try { return classifyCartFlow(JSON.parse(A.audioGetLevels(this.stationId)), channels); }
    catch { return { flowing: false, peak: 0, how: "levels-unreadable" }; }
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

  /**
   * THE DECKS FOLLOW THE CALENDAR. Re-cue any NON-PLAYING deck whose loaded row is no longer what the
   * calendar says comes next.
   *
   * Without this the anchored rebuild corrects the queue and the decks keep playing yesterday's idea
   * of it: a spot that came due while the next song was already cued could never take its slot, and
   * its row was stamped `missed` without airing.
   *
   * THE SAFETY BOUNDARY, and it is the whole of it:
   *   - a deck that is PLAYING or PAUSED is never touched. That is §2.4a's "committed", and it is why
   *     this can never interrupt audio.
   *   - nothing happens once the seam is in motion: a triggered segue or an ARMED/FIRING sweeper means
   *     the rotate is already being set up against this deck, and swapping the file under it then is
   *     the one way this could bite.
   *   - a margin on the playing deck's remaining time, so a re-cue cannot land in the same tick as the
   *     rotate that consumes it.
   *   - it runs inside _advance, the same serialized chain every other deck command uses, so it cannot
   *     interleave with a rotate even if the margin is wrong.
   *
   * The sweeper is NOT endangered: _jingleSuperseded keys on the OUTGOING deck's generation, and this
   * only ever reloads an incoming one.
   *
   * If a re-cue does leave a deck unready, _rotateBody's play-skip guard re-preloads and retries rather
   * than going silent — the backstop that was already there.
   */
  _resyncCuedDecks() {
    try {
      if (!this._started || !this._logReaderOn()) return;
      if (this._jingle) return;                                   // a sweeper is armed/firing for this seam
      const order = ["A", "B", "C"];
      const playing = order.find(d => this._deckState(d).status === "playing");
      if (playing && this.segueTriggered.has(playing)) return;     // the rotate has already begun
      if (playing) {
        const st = this._deckState(playing);
        const remaining = (st.durationSec || 0) - (st.positionSec || 0);
        // Below this there is no useful time to reload and the rotate is imminent. segueOverlap is the
        // moment the incoming would start; a couple of seconds beyond it is the honest floor.
        if (!(remaining > (this.segueOverlap || 0) + 2)) return;
      }
      // BY ROW (Phase 1). The standby decks, in the order they will go to air, must hold the next entries of the log,
      // in log order. Before, the check compared FILES and a replaced deck kept its entry marked "on a deck", so the
      // queue drifted out of step with the decks (the 10/16 replays). Now each standby deck's entry is compared with
      // the entry the log wants there; a deck that differs lets go of its entry (back to pending if the log still has
      // it) and is cued with the exact entry, by qid.
      const i0 = order.indexOf(playing || "A");
      const standby = [];
      for (const d of (playing ? [order[(i0 + 1) % 3], order[(i0 + 2) % 3]] : order)) {
        if (this._deckState(d).status === "playing" || this._deckState(d).status === "paused") continue;
        if (this.manualCue.has(d)) continue;                      // the operator cued this by hand — theirs
        standby.push(d);
      }
      const keyOf = (q) => (q && q.schedId != null ? "r" + q.schedId : q ? "q" + q.qid : null);
      const upcoming = this.queue.filter(q => !this._isAired(q))
        .map((q, i) => ({ q, i })).sort((x, y) => ((x.q.logHourTs ?? x.q.scheduledAt ?? Infinity) - (y.q.logHourTs ?? y.q.scheduledAt ?? Infinity))
          || ((x.q.scheduledAt ?? Infinity) - (y.q.scheduledAt ?? Infinity)) || (x.i - y.i)).map(x => x.q);   // LOG order: a row past :00 stays in its own hour (v66)
      if (!upcoming.length) return;
      const wrong = [];
      standby.forEach((d, k) => {
        if (!this.deckReady.has(d)) return;                        // nothing cued here; preload will fill it
        const want = upcoming[k];
        if (!want) return;
        const holds = this.queue.find(q => q.qid === this.deckQid[d]);
        if (holds && keyOf(holds) === keyOf(want)) return;          // already right
        wrong.push({ d, want, was: this._deckState(d).title || "(untitled)" });
      });
      if (!wrong.length) return;
      this._advance("recue:" + wrong.map(w => w.d).join(""), async () => {
        // Re-check inside the chain: a rotate may have taken a deck live since we decided. Any change → do nothing;
        // the next refill decides again.
        if (this._jingle) return;
        for (const w of wrong) {
          const s2 = this._deckState(w.d);
          if (s2.status === "playing" || s2.status === "paused") return;
          if (this.manualCue.has(w.d)) return;
        }
        const todo = wrong;
        // First every wrong deck lets go (so an entry one of them held is free for another), then each is cued.
        for (const w of todo) {
          this._stop(w.d);
          this.deckReady.delete(w.d);
          this.endTriggered.delete(w.d);
          this._releaseDeckEntry(w.d);
          // Our side of the deck is emptied WITH the file, not just the status: a title left behind on
          // an empty deck is what the stall recovery used to pick (see _resumePlayout).
          this._setDeck(w.d, { status: "idle", title: "", artist: "", filePath: "", positionSec: 0 });
        }
        for (const w of todo) {
          this._log(`calendar re-cue: deck ${w.d} held "${w.was}" — the log now says "${w.want.title || "(untitled)"}" (row ${w.want.schedId ?? "—"})`);
          // We ARE the advance chain here — call the body, never the chained wrapper (see preload()).
          await this._preloadNow(w.d, 0, { qid: w.want.qid });
        }
      });
    } catch (e) { this._log("recue error (playout unaffected): " + String(e)); }
  }

  _nextRotateDeck(fromDeck) {
    const order = ["A", "B", "C"]; const i = order.indexOf(fromDeck);
    const n1 = order[(i + 1) % 3], n2 = order[(i + 2) % 3];
    if (this.deckReady.has(n1)) return n1;
    if (this.deckReady.has(n2)) return n2;
    return null;
  }

  /** Is an armed AUTO-POST entry due to fire against this deck state? Milliseconds throughout; the
   *  position is the only live term. Separated out so the harness can drive the real predicate. */
  _autoPostFireDue(j, st) {
    const posMs = Math.max(0, (st && st.positionSec ? st.positionSec : 0) * 1000);
    return posMs >= (j.postMs - j.cutEndMs);
  }

  /**
   * ARM AUTO-POST AFTER THE ROTATE — the whole reason this is a separate path.
   *
   * An entry armed before a rotate does not survive it: _jingleSuperseded cancels on an airGen bump, on
   * the armed deck no longer playing, and on a deckGen change, and a rotate is all three. Rather than
   * weaken that guard — it is Bug-A immunity and it earns its keep — AUTO-POST simply arms later, on
   * the deck that is now playing, so there is no rotate left to survive. Supersession then protects it
   * exactly as it protects every other arm: a FURTHER rotate cancels it, which is correct, because the
   * song it belongs to is gone.
   *
   * Returns true if it armed. Never throws into playout.
   */
  _autoPostArm(deck) {
    try {
      if (this._jingle) return false;                       // something is already armed or firing
      const sched = this.deckSched ? this.deckSched[deck] : null;
      if (sched == null) return false;                      // the deck has no schedule identity to key on
      const jin = loggen.readAutoPostForSong(this.db, this.stationId, sched, this._firedJinRows.slice(-100));
      if (!jin) return false;
      if (!this._fileOk(jin.filePath)) { this._noteFiredRow(jin.rowId); return false; }
      this._armJingle(jin, deck);
      this._log(`auto-post armed on ${deck} post=${jin.postMs}ms cut_end=${jin.cutEndMs}ms ` +
                `fires at position ${((jin.postMs - jin.cutEndMs) / 1000).toFixed(2)}s - "${jin.title}"`);
      return true;
    } catch (e) { this._log("autoPostArm error (playout unaffected): " + String(e)); return false; }
  }

  _armJingle(jin, deck) {
    this._jingle = {
      phase: "armed", rowId: jin.rowId, filePath: jin.filePath, title: jin.title, artist: jin.artist,
      jinDur: (jin.durationMs || 0) / 1000, leadIn: jin.leadInSec,
      categoryId: jin.jingleCategoryId, contentClass: 'SWP',   // v52: one imaging class
      // AUTO-POST terms, absent on a LEAD arm. Copied onto the entry so the fire predicate reads no DB.
      chainType: jin.chainType || null, postMs: jin.postMs ?? null, cutEndMs: jin.cutEndMs ?? null,
      deck, airGen: this._airGen, deckGen: this.deckGen[deck],
      firedAt: 0, firingConfirmedAt: 0, nextStart: 0, outgoingEndedAt: 0,
    };
    // NOT consumed here. Arming is not airing: a row marked fired at arm time was gone forever even
    // when it was superseded or refused, so an unaired sweeper counted as aired. _fireJingle consumes it
    // once a channel has actually accepted it. While armed, _jingleTick returns early and never re-queries,
    // so nothing can double-arm in the gap; a cancel legitimately puts the row back in play for this seam.
    // NEVER ASSERT A NUMBER THE ENGINE DID NOT HONOUR. The old line printed the requested lead and
    // stopped there, so a LEAD of 40 logged "lead_in=40s" while the sweeper actually got 24.75s. A log
    // that repeats the operator's number back at them is not evidence — it is the same defect as the
    // control that swallowed it.
    // CLEAN SPOT EDGES APPLY TO IMAGING TOO.
    //
    // Jeff, station 2, on air 2026-09-14: "sweepers are being scheduled against the GC spot."
    //
    // The sweeper is stamped at the INCOMING song's slot and is correct there — 0 sweeper rows in
    // that log sit at a SPOT slot. But LEAD fires it N seconds before the OUTGOING element ends, and
    // when that element is a commercial the sweeper plays over its tail. Measured on station 2: all
    // 4,223 spots in the log were followed by a sweeper reaching 2s back into them.
    //
    // THIS IS NOT A NEW EDITORIAL JUDGEMENT, and it is deliberately NOT a refusal. bd87a95 deleted a
    // guard that SUPPRESSED the seam entirely whenever a deck held a SPOT, because it silently dropped
    // placements the operator had scheduled — "whether a sweeper suits a seam is the operator's call".
    // That still stands: the sweeper below still fires. What it may not do is bleed BACKWARDS into
    // content it was never assigned to.
    //
    // The rule it restores is already shipped twice over: _segueTick refuses to overlap a spot's tail
    // ("a SPOT is exclusive PROGRAM content — the spot plays alone"), and docs/help-spots.md promises
    // operators "clean start, clean end, no music overlap in or out AND NO SWEEPER OVER IT". The
    // sweeper path was the one route that never honoured it.
    //
    // Expressed as a CEILING rather than a branch, so it rides the clamp machinery that already
    // exists here — including the rule that the engine never asserts a number it did not honour.
    const outgoingIsSpot = this.deckContentClass[deck] === "SPOT";
    this._jingle.spotEdge = outgoingIsSpot;   // read by the fire predicate; captured here, never re-queried
    const ceiling = outgoingIsSpot ? 0 : this.effectiveLeadCeiling();
    const effective = Math.min(jin.leadInSec, ceiling);
    this._jingle.leadInRequested = jin.leadInSec;
    this._jingle.leadInEffective = effective;
    if (effective < jin.leadInSec) {
      if (outgoingIsSpot) {
        this._log(`${this._jingle.contentClass} ARMED — "${jin.title}" over deck ${deck} seam (lead_in ${jin.leadInSec}s REQUESTED but 0s EFFECTIVE — deck ${deck} holds a SPOT and a commercial airs clean; the sweeper starts at the seam instead of over its tail)`);
        try {
          this.emit("error", { stationId: this.stationId, where: "sweeper-lead-clamped-spot",
            error: `sweeper "${jin.title}" asked for a ${jin.leadInSec}s lead, but the outgoing element is a commercial — it fires at the seam so the spot airs clean`,
            requestedSec: jin.leadInSec, effectiveSec: 0, ceilingSec: 0, reason: "clean-spot-edge" });
        } catch {}
      } else {
      this._log(`${this._jingle.contentClass} ARMED — "${jin.title}" over deck ${deck} seam (lead_in ${jin.leadInSec}s REQUESTED but ${effective}s EFFECTIVE — the arm window caps it at ${DaemonEngine._ARM_WINDOW_S}s minus a ${this.segueOverlap}s overlap)`);
      try {
        this.emit("error", { stationId: this.stationId, where: "sweeper-lead-clamped",
          error: `sweeper "${jin.title}" asked for a ${jin.leadInSec}s lead; the arm window allows ${ceiling}s, so it fires ${effective}s ahead`,
          requestedSec: jin.leadInSec, effectiveSec: effective, ceilingSec: ceiling,
          armWindowSec: DaemonEngine._ARM_WINDOW_S, segueOverlapSec: this.segueOverlap });
      } catch {}
      }
    } else {
      this._log(`${this._jingle.contentClass} ARMED — "${jin.title}" over deck ${deck} seam (lead_in=${jin.leadInSec}s)`);
    }
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
      // The sweeper's own log row is stamped 'played' in the same transaction (Phase 1: "sweepers stamped").
      const r = playlog.recordGoLive(this.db, { stationId: this.stationId, title: j.title, artist: j.artist, deck: (j.channels && j.channels[0]) || "CART",
        durationMs: Math.round((j.jinDur || 0) * 1000), sessionId: SESSION, filePath: j.filePath, contentClass: j.contentClass || "JIN", rowId: j.rowId ?? null, overlay: true });
      if (!r.ok) this._alert("not-stamped", { severity: "yellow", rowId: j.rowId ?? null, at: Math.floor(Date.now() / 1000), title: j.title, filePath: j.filePath, path: "sweeper",
        message: `sweeper "${j.title || "(untitled)"}" fired but could not be recorded: ${r.error}` });
    } catch {}
  }

  // Should this deck's end DEFER to a bridging jingle? Only if the jingle is confirmed firing on THIS
  // deck's seam and there is still jingle audio left to play on over the incoming.
  _jingleShouldBridge(deckId) {
    const j = this._jingle;
    if (!j || j.deck !== deckId || !j.firingConfirmedAt || !j.firedAt) return false;
    const jingleEnd = j.firedAt + j.jinDur * 1000;
    return jingleEnd > Date.now() + 150;   // still jingle tail left to weave the incoming under
  }
  _jingleBeginBridge(deckId) {
    const j = this._jingle; if (!j) return;
    const now = Date.now();
    // The incoming starts at the outgoing's NATURAL END — the same moment it would start with no sweeper
    // on the seam at all. The sweeper's length is not an input: it plays on over the incoming and ends
    // when it ends. Automation NEVER fades a deck; the outgoing rides its own mastered tail out.
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
  _foreignGraceMs() { return ((this.segueOverlap || 0) + this.crossfadeDuration) * 1000 + 1500; }

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
      // (Removed 2026-09-06: a guard that deferred this segue while a sweeper was ARMED, so it would "fire
      // first". Unreachable now — poll() runs _jingleTick before _segueTick, and the sweeper fires at
      // leadIn + segueOverlap, strictly earlier than this point for any LEAD > 0; at LEAD 0 they coincide
      // and _jingleTick still runs first. It also cost real time: while it held, the incoming started late,
      // so every sweepered seam overlapped by ~leadIn instead of the operator's segueOverlap.)
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
          // THE SWEEPER BELONGS TO THE SONG IT INTRODUCES. LEAD is measured forward from the moment the
          // INCOMING song begins, not backward from the outgoing song's end — so LEAD 3 puts three seconds
          // of sweeper over the tail of whatever came before it, every time, whatever that was. The copy is
          // about the record starting, so it has to land ahead of that record, not on top of it.
          // The incoming begins when the outgoing has segueOverlap left (_segueTick, :2080); that is the
          // definition of its start, not a correction. Both terms read the same live deck position, so this
          // cannot drift — generated_schedule.scheduled_at is a plan, not a clock (measured 2026-09-06:
          // only ~10% of plays land within 1s of their scheduled time).
          // AUTO-POST fires off the INCOMING deck's POSITION, not the outgoing's remaining time. The
          // cut is chosen so it fits inside the intro, so its last audible moment lands on the post:
          //     fire when P >= post - cutEnd
          // Both terms are milliseconds on the row; P is the live deck position. This arm was created
          // AFTER the rotate (see _autoPostArm), so j.deck is the song being introduced and the
          // outgoing has already finished — which is what keeps a sweeper off the end of a song.
          if (j.chainType === 'auto_post') {
            if (this._autoPostFireDue(j, st)) this._fireJingle(j);
            return;
          }
          // THE NUMBER THE ENGINE COMPUTED IS THE NUMBER THE ENGINE USES.
          //
          // This read j.leadIn — the REQUESTED lead — while _armJingle computed leadInEffective and
          // stored it. Nothing ever read it. So the 4.6.36 spot clamp logged a reduction, emitted a
          // health event, and changed nothing about when the sweeper fired. A value computed, logged
          // and never read is worse than no value: it reports a fix that is not happening.
          const lead = (j.leadInEffective != null) ? j.leadInEffective : j.leadIn;

          // AND NO OVERLAP TERM AT A SPOT EDGE.
          //
          // segueOverlap is added because on a music->music seam the incoming starts that many seconds
          // early (_segueTick), so firing then lands the sweeper on the incoming song's start. At a SPOT
          // edge _segueTick REFUSES the early start ("a SPOT is exclusive PROGRAM content"), so there is
          // no overlap to compensate for and adding it aims the sweeper three seconds INTO the
          // commercial's tail — the exact thing the clamp exists to prevent.
          const overlap = j.spotEdge ? 0 : this.segueOverlap;

          // THE SEAM IS A TICK WIDE, and pretending otherwise is why lead 0 could never fire. poll()
          // runs every 250ms and checkEnd() runs BEFORE this in the same tick, so by the time
          // `remaining` would read exactly 0 the rotate has already happened and _jingleSuperseded
          // cancels the entry. Firing on the last tick the outgoing is still playing is the closest a
          // 250ms poll can get to the seam, and it is the difference between firing late and never
          // firing at all. The residue is under a quarter second over the very end of the spot.
          //
          // The fully clean version fires off the INCOMING deck's position the way _autoPostArm does,
          // so the sweeper starts with the song rather than at the end of what preceded it. That is a
          // lifecycle change, not a predicate change, and it is not this fix.
          const SEAM_EPS_S = 0.3;   // one poll tick (250ms) plus a margin
          const threshold = (lead + overlap) || SEAM_EPS_S;
          if (remaining <= threshold) this._fireJingle(j);   // FIRE on the advance chain
          return;
        }
        // firing / bridging
        const obs = this._cartObserve(j.channels);
        // A cart on a dead aux is a FAULT, said once per fire — never FIRING. flowing is false, so it is not
        // confirmed, not logged as played, and not bridged: the rotation proceeds as if it had not aired, because
        // in the room it did not.
        if (obs.fault) {
          if (!j.faultAt) {
            j.faultAt = now; this._emitJingle("FAULT", j);
            this._log("jingle FAULT on " + (j.channels || ["CART"]).join("+") + " peak=" + obs.peak.toFixed(4) + " — " + obs.how + " - \"" + j.title + "\"");
          }
        }
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
          // Start the incoming deck at the outgoing's natural end. Reuse the proven rotate paths.
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

      // AUTO-POST belongs to the song PLAYING NOW, not to the seam ahead — it fires inside this song's
      // intro. Tried first and every tick until it arms, because the rotate that started this song is
      // the event it waits for, and an entry armed before that rotate would have been cancelled by it.
      // Returns false instantly when the placement is not auto_post, so the LEAD path below is reached
      // on exactly the seams it always was.
      if (this._autoPostArm(P)) { this._clearScheduled("auto-post-armed"); return; }
      const nextDeck = this._nextRotateDeck(P);
      // A SCHEDULED SWEEPER FIRES. The engine used to suppress the seam whenever the outgoing or incoming
      // deck was a SPOT — an editorial judgement ("imaging doesn't belong next to a commercial") made in
      // code, silently dropping placements the operator scheduled. Whether a sweeper suits a seam is the
      // operator's call, not the engine's; the only condition that may cancel one is preventing dead air.
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
      categoryId: jin.jingleCategoryId, leadIn: jin.leadInSec,
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
      this._noteFiredRow(j.rowId);   // a channel accepted it — NOW the placement is consumed (see _armJingle)
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
    // The next deck is already cued (its own entry, in log order): play what it holds. Otherwise load the next
    // PLAYABLE pending entry, skipping missing-file items.
    let loaded = this.deckReady.has(next) && !!this._deckState(next).filePath && this._deckState(next).status !== "playing", guard = 0;
    while (!loaded && this.queue.length > 0 && guard++ < 100) {
      const item = this._takePending();
      if (!item) break;
      if (this.loadToDeck(next, item)) { this.deckChainType[next] = item.chainType || "segue"; loaded = true; break; }
      this.emit("error", { stationId: this.stationId, where: "skip", error: "skipped unplayable: " + (item.filePath || "") });
      if (this.queue.length === 0) await this.refillIfNeeded();
    }
    if (!loaded) return false;
    this._play(next);
    this._setDeck(next, { status: "playing", positionSec: 0 });
    this.endTriggered.delete(next); this.deckReady.delete(next);
    if (this.manualCue.has(next)) this.manualCue.delete(next);
    this._consumeDeckEntry(next);
    this._fireStart(next);
    this._log("skip: deck " + next + " LIVE — " + (this._deckState(next).title || "(untitled)"));
    if (playing && playing !== next) this._stop(playing);
    setTimeout(() => this.preload(order[(order.indexOf(next) + 1) % 3], 0), 600);
    return true;
  }
}

module.exports = { DaemonEngine };
