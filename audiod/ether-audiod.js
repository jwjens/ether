// ether-audiod — standalone audio engine daemon (Roadmap Item 10, Phase 1 scaffold).
//
// A bare-Node process that loads the N-API audio addon and exposes the engine over a
// Windows named pipe, so the engine can outlive the Electron UI (gapless updates). This
// scaffold wraps the ADDON command surface + broadcasts levels/deck/stream events; the
// queue / advance / loggen logic (today in engine-rodio.ts) moves in at Phase 1 step 3.
//
// ADDITIVE: nothing in the live app talks to this yet. Run standalone:
//   node audiod/ether-audiod.js
// Validated by audiod/smoke-test.js. Transport + protocol per docs/audio-daemon-phase0.md.

const net = require("net");
const path = require("path");
const os = require("os");

// Durable daemon log FIRST — the daemon runs detached/stdio:"ignore", so without this its
// console output (including a fatal addon-load error below) is discarded. Tees console.* to a file.
// GUARDED: a missing/broken log module must NEVER crash the daemon. A staged build once omitted this file
// (stage-engine DAEMON_FILES) → an unguarded require MODULE_NOT_FOUND took the whole daemon down → dead
// air. Logging is diagnostic only; it can fail without stopping playout.
try { require("./daemon-log").install(); } catch (e) { try { console.error("[audiod] daemon-log unavailable:", e && e.message); } catch { /* ignore */ } }

// Cross-platform IPC endpoint: Windows → named pipe; macOS/Linux → a per-user Unix domain
// socket in the temp dir. Override with ETHER_AUDIOD_PIPE. (Client + watchdog compute the
// same default independently.) `isFileSocket` = a filesystem socket (unix, or Win10 AF_UNIX
// when forced) — those can leave a stale file after a crash and need unlink-on-EADDRINUSE.
function audiodEndpoint() {
  if (process.env.ETHER_AUDIOD_PIPE) return process.env.ETHER_AUDIOD_PIPE;
  if (process.platform === "win32") return "\\\\.\\pipe\\ether-audiod";
  const uid = (process.getuid && process.getuid()) || 0;
  return path.join(os.tmpdir(), `ether-audiod-${uid}.sock`);
}
const PIPE = audiodEndpoint();
const isFileSocket = !PIPE.startsWith("\\\\.\\pipe\\");
// Dev mode (set by the app's audio-daemon-client only when unpackaged): the app is the daemon's
// only client, so when it disconnects (close/restart/hard-kill → OS closes the socket) the daemon
// must exit instead of lingering as a zombie that holds the audio device + pipe. Packaged daemons
// NEVER set this — they must outlive the app during a gapless update. Off by default.
const DEV_REAP = process.env.ETHER_DAEMON_DEV === "1";
// Test seam (never set in production; mirrors the watchdog's WATCHDOG_TEST_* seams): exit
// immediately to simulate a daemon that can't start, so the app's audio-backend fallback
// (electron/main.js setupAudioBackend → in-process engine) can be verified deterministically.
if (process.env.ETHER_AUDIOD_DIE === "1") { console.error("[audiod] ETHER_AUDIOD_DIE — exiting to simulate an unstartable daemon"); process.exit(1); }
const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));
const { DaemonEngine } = require("./engine");
const { StreamSupervisor } = require("./stream");
// v4.4.51: approximate the daemon process start (for the Health Monitor's uptime/restart, reported in
// the ping reply so main doesn't have to scrape the rotating log for the pid).
const DAEMON_STARTED_AT = Date.now() - Math.round((process.uptime && process.uptime() || 0) * 1000);

// Stations we're metering (added on first init/load), so the event loop knows what to poll.
const stations = new Set();
const clients = new Set();
// Stations running the autonomous playout engine (queue + advance + scheduler). The engine
// owns deck-state emission for these, so the generic loop only emits their levels.
const engines = new Map(); // stationId → DaemonEngine

function log(...a) { console.log("[audiod]", ...a); }
function broadcast(obj) { const line = JSON.stringify(obj) + "\n"; for (const c of clients) { try { c.write(line); } catch {} } }

// node:sqlite library handle (read-only, WAL) for the scheduler — opened lazily on first
// automation start. Bare Node can't use better-sqlite3 (V8-ABI); node:sqlite is ABI-stable.
let _db = null;
function getDb() {
  if (_db) return _db;
  const { DatabaseSync } = require("node:sqlite");
  // Resolve the DB path the SAME way the main app does: prefer the explicit ETHER_DB_PATH the app
  // sets (spawnDaemon passes it through, and profile:adopt refreshes it on an account switch), then
  // fall back to resolving the ACTIVE PROFILE through the same one path module main.js uses.
  //
  // PROFILE-PER-ACCOUNT: this fallback used to hardcode the single install-wide directory. Under
  // profiles that would open a database belonging to nobody — or, after an account switch, the
  // WRONG account's. It now reads profiles/active exactly as the app does. With no active profile
  // there is nothing to play: the operator is signed out, and a signed-out profile stays dormant
  // (design property 6) rather than quietly airing someone's stations.
  let dbPath = process.env.ETHER_DB_PATH;
  if (!dbPath) {
    const P = require("../electron/profile-paths");
    const active = P.resolveActive();
    if (active.pending) throw new Error("no active profile (nobody is signed in) — refusing to open a database");
    dbPath = P.dbPath(active.key);
  }
  // Ensure the parent folder exists before opening — on a clean machine it won't, and SQLite
  // throws SQLITE_CANTOPEN if the directory is missing (fresh-install crash).
  try { require("fs").mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {}
  // Read-WRITE: the daemon reads the library (loggen) AND writes the play log (Step 4).
  // WAL + busy_timeout makes cross-process contention with the app's better-sqlite3 a
  // microsecond wait, not a failure (proven by spike-write-contention.js).
  _db = new DatabaseSync(dbPath, { readOnly: false });
  try { _db.exec("PRAGMA journal_mode = WAL"); _db.exec("PRAGMA busy_timeout = 5000"); _db.exec("PRAGMA foreign_keys = ON"); } catch {}
  log("opened library (read-write): " + dbPath);
  return _db;
}
function getEngine(stationId) {
  let e = engines.get(stationId);
  if (!e) { e = new DaemonEngine(stationId, getDb(), (event, payload) => broadcast({ event, ...payload })); engines.set(stationId, e); stations.add(stationId); }
  return e;
}

// Step 5 — Icecast streamer per station. Reads the station's program-bus port; status events
// broadcast as { event: "stream", ... } → main → renderer.
const streams = new Map(); // stationId → StreamSupervisor
function getStream(stationId) {
  let s = streams.get(stationId);
  if (!s) { s = new StreamSupervisor(stationId, () => { try { return A.audioGetProgramBusPort(stationId); } catch { return 0; } }, (st) => broadcast({ event: "stream", ...st })); streams.set(stationId, s); }
  return s;
}

// ── Command surface (addon-backed) ────────────────────────────────────────────
// Each returns a JSON-serializable result (or throws → { ok:false, error }).
// Per-station promise chain for the MANUAL/AUTO toggle. Per station, so a jock toggling one station
// never queues behind another station's automation — the three untouched stations keep deciding.
const _modeChain = new Map();
function modeToggle(stationId, fn) {
  const prev = _modeChain.get(stationId) || Promise.resolve();
  const next = prev.then(fn, fn);   // a failed toggle must not wedge the chain for the next press
  _modeChain.set(stationId, next.catch(() => {}));
  return next;
}

// ── JUKEBOX DECK SOURCE (D/E/F) ────────────────────────────────────────────────────────────────────
//
// Design: docs/jukebox-deck-source-design-2026-08-17.md. The jukebox is an EVENT TOOL patched into a
// deck like a microphone — not playout. It airs through a real Rust deck so the operator mixes it on
// the board, and it logs its plays, but it must not perturb the station in any other way.
//
// THE BOARD IS THE TRUTH (Jeff, 2026-08-17). Whatever fader is live is what streams; putting the
// jukebox on air is an operator decision at the fader, exactly like a mic. So there is NO suppression
// and NO stealth here — a jukebox play emits `deck` and `playstart` and writes play_log like any other
// deck play. The ONLY isolation is the one that already exists: station automation enumerates
// ["A","B","C"] and nothing else (engine.js:521, :604, :648, :905, :1698, …), so it never touches or
// reads a jukebox deck. That is isolation by construction, not by hiding.
//
// Rust already treats D/E/F as first-class: the mixer sums EVERY deck slot with fader, channel cut and
// trim (`native/src/audio.rs:1151` — `for (i, deck) in bus.decks.iter_mut().enumerate()`), and
// `audio_get_state` reports deckD/E/F (`native/src/lib.rs:182-210`). So the audio path needs nothing new.
//
// STANDALONE FOR ONE STRUCTURAL REASON, not a policy one: `engine.js:396` is
//   `_deckState(id) { return id === "A" ? this.stateA : id === "B" ? this.stateB : this.stateC; }`
// Anything that is not A or B resolves to **deck C's state object**. Routing a jukebox load through
// the engine's deck machinery would silently read and overwrite the mirrored state of deck C — the
// deck the station may be airing from. The daemon's JS engine models exactly three decks; until that
// model is widened, a jukebox deck keeps its own state here and emits the same events.
const JUKEBOX_DECKS = ["D", "E", "F"];
const JUKEBOX_SESSION = require("crypto").randomUUID();
const _jukeboxPlaylog = (() => { try { return require("./playlog"); } catch { return null; } })();
/** stationId → { deck, filePath, title, artist, startedAtMs } — what the kiosk last put on air. */
const jukeboxNow = new Map();

function jukeboxDeckInfo(stationId, deck) {
  // The DAEMON is the source of truth for what a deck is doing; the kiosk renders this, never a guess.
  try {
    const st = JSON.parse(A.audioGetState(stationId));
    return st[`deck${deck}`] || null;
  } catch { return null; }
}

const handlers = {
  init:               (m) => { A.initAudioEngine(m.stationId); stations.add(m.stationId); return true; },
  // Quiesce for a database swap. This process holds openair.db open in WAL mode, which locks
  // -wal/-shm — so a restore cannot replace the file while we are running. The app calls this,
  // waits for the reply, then swaps. Everything that reads the database stops first; the handle is
  // reopened lazily by getDb() the next time it is needed, against the NEW file.
  // Playback stops. That is inherent: the station's database is being replaced underneath it.
  releaseDb:          () => {
    for (const s of streams.values())  { try { s.stop(); } catch {} }
    for (const e of engines.values())  { try { e.dispose(); } catch {} }
    for (const sid of stations)        { try { A.audioStop("A", sid); A.audioStop("B", sid); A.audioStop("C", sid); } catch {} }
    let dbWasOpen = false, closeError = null;
    try { if (_db) { _db.close(); _db = null; dbWasOpen = true; } }
    catch (e) { closeError = String(e && e.message || e); }
    log(`releaseDb — engines+streams stopped, db ${dbWasOpen ? "CLOSED" : "was not open"}${closeError ? " (close error: " + closeError + ")" : ""}`);
    return { released: !closeError, dbWasOpen, closeError, stations: stations.size };
  },
  load:               (m) => { stations.add(m.stationId); const r = A.audioLoad(m.deck, m.filePath, m.title || "", m.artist || "", m.gainDb ?? 0, m.stationId); const e = engines.get(m.stationId); if (e) e.noteManualCue(m.deck, { title: m.title, artist: m.artist, filePath: m.filePath, durationMs: m.durationMs, contentClass: m.contentClass ?? null }); return r; },
  // A refused play is a DECISION the operator must see, not a silent no-op (2026-07-31). audioPlay
  // returns false when the deck has no content; say so, name the deck, and tell them what to do.
  play:               (m) => {
    const ok = A.audioPlay(m.deck, m.stationId);
    if (!ok) log(`[engine s${m.stationId}] deck ${m.deck}: play REFUSED — no content loaded (load a track onto this deck first)`);
    return ok;
  },
  pause:              (m) => A.audioPause(m.deck, m.stationId),
  stop:               (m) => A.audioStop(m.deck, m.stationId),
  setVolume:          (m) => A.audioSetVolume(m.deck, m.volume, m.stationId),
  // Console channel cut. MUST live here as well as in-process: main.js routes audio:setMuted to the
  // daemon whenever AUDIO_DAEMON is on (the default on Windows), so a renderer-only or in-process-only
  // mute would be a silent no-op on exactly the setup most operators run.
  setMuted:           (m) => A.audioSetMuted(m.deck, !!m.muted, m.stationId),
  setEq:              (m) => A.audioSetEq(m.stationId, JSON.stringify(m.bands || [])),
  getState:           (m) => JSON.parse(A.audioGetState(m.stationId)),
  getLevels:          (m) => JSON.parse(A.audioGetLevels(m.stationId)),
  getSpectrum:        (m) => JSON.parse(A.audioGetSpectrum(m.stationId)),
  getFileDuration:    (m) => A.getFileDuration(m.filePath),
  listOutputDevices:  ()  => JSON.parse(A.audioListOutputDevices()),
  setOutputDevice:    (m) => A.audioSetOutputDevice(m.stationId, m.device),
  setMonitorVolume:   (m) => A.audioSetMonitorVolume(m.stationId, m.volume),
  // MASTER OUT — the broadcast gain (rides air + the master VU). Distinct from setMonitorVolume,
  // which trims the room speakers only. docs/master-monitor-faders-dead-2026-08-06.md
  setMasterVolume:    (m) => A.audioSetMasterVolume(m.stationId, m.volume),
  // MASTER MONITOR — ONE room level for all stations. No stationId: it is global by design, so it
  // can never grab an individual station strip. docs/master-monitor-faders-dead-2026-08-06.md §7
  setMasterMonitorVolume: (m) => A.audioSetMasterMonitorVolume(m.stationId, m.volume),
  getProgramBusPort:  (m) => A.audioGetProgramBusPort(m.stationId),
  setBroadcastDelay:  (m) => A.audioSetBroadcastDelay(m.seconds, m.stationId),
  dump:               (m) => A.audioDump(m.stationId),
  broadcastDelayState:(m) => JSON.parse(A.audioBroadcastDelayState(m.stationId)),
  watchdogSet:        (m) => A.watchdogSet(m.active, m.thresholdSec, m.stationId),
  ping:               ()  => ({ pong: true, pid: process.pid, startedAt: DAEMON_STARTED_AT }),
  // The app version this daemon was spawned with (passed via env). Lets the app detect a stale
  // daemon left running across an update and reload it (the dead-air-on-update gotcha).
  version:            ()  => process.env.ETHER_DAEMON_VERSION || "0",
  // Graceful remote stop (the HA watchdog sends this on a clean user-quit, so the daemon
  // doesn't outlive the station; an update/relaunch leaves the daemon running instead).
  shutdown:           ()  => { setTimeout(shutdown, 50); return "bye"; },

  // ── autonomous playout engine (Phase 1 step 3): queue + advance + scheduler ──
  // Additive — the live app does not drive these yet (Phase-2 cutover does).
  // MODE TOGGLE — SERIALIZED per station (2026-07-31). A fast MANUAL/AUTO double-click used to
  // interleave: on 2026-07-31 an automationStop landed 2ms after an automationStart mid-adopt, and it
  // took the jock four presses to recover. Chaining each toggle onto the previous one makes rapid
  // clicking QUEUE rather than race, so the last press wins and one press is always enough.
  automationStart:    (m) => modeToggle(m.stationId, () => getEngine(m.stationId).start()),
  automationStop:     (m) => modeToggle(m.stationId, () => { const e = engines.get(m.stationId); if (e) e.stop(); return true; }),
  // Slice 4 — STOP: silence a station and keep it silent. Stop automation (e.stop() disables the stall
  // watchdog so it can't auto-recover) AND stop all three decks. Idempotent; no-op if never started.
  stopAll:            (m) => { const e = engines.get(m.stationId); if (e) e.stop(); for (const d of ["A", "B", "C"]) { try { A.audioStop(d, m.stationId); } catch {} } return true; },
  skip:               (m) => getEngine(m.stationId).skip(),                    // force-advance to next track
  // Step 5 — streaming (ffmpeg → Icecast) inside the daemon, off the daemon's program bus.
  startStream:        (m) => getStream(m.stationId).start(m.config || {}),
  stopStream:         (m) => { const s = streams.get(m.stationId); return s ? s.stop() : { ok: true }; },
  streamStatus:       (m) => { const s = streams.get(m.stationId); return s ? s.status() : { stationId: m.stationId, state: "idle" }; },
  // Real cpal output-callback stamp (epoch ms of the last device callback, ANY station). The
  // authoritative "is the output device alive" signal — independent of the VU levels pipeline. The
  // app's silent-wedge watchdog uses this to tell a real output death (callback stopped) from a
  // levels false-positive (callback still firing) before reloading the whole daemon.
  lastCallbackMs:     (m) => A.audioLastCallbackMs(m.stationId),
  // Per-station output recovery (DESIGN-TRUTH §2): reopen ONLY this station's cpal stream.
  reopenOutput:       (m) => A.audioReopenOutput(m.stationId),

  fill:               (m) => { const e = getEngine(m.stationId); return e.refillIfNeeded().then(() => e.getQueue()); },
  getQueue:           (m) => { const e = engines.get(m.stationId); return e ? e.getQueue() : []; },
  // Honest engine state (Slice 1): live | stalled | off. Authoritative pull so a freshly-attached
  // renderer (launch / reload / daemon respawn) gets the current value without waiting for the next
  // change event. No engine yet (never started) = "off". The live value is pushed via `enginestate`.
  getEngineState:     (m) => { const e = engines.get(m.stationId); return e ? e.engineState() : "off"; },
  enqueue:            (m) => { getEngine(m.stationId).addToQueue(m.items || []); return true; },
  replaceQueue:       (m) => { getEngine(m.stationId).replaceQueue(m.items || []); return true; },
  clearQueue:         (m) => { const e = engines.get(m.stationId); if (e) e.clearQueue(); return true; },

  // ── Stage 1: explicit-intent commands (additive; run ALONGSIDE the legacy ones above) ──
  // The renderer does not call these yet (Stage 2 flips it). All id-addressed, idempotent, tolerant
  // — a stale/unknown intent returns false (a quiet no-op), never an error or a corrupting mutation.
  // ── Jukebox deck source — D/E/F only (see the block above the handler map) ──
  "jukebox:play": (m) => {
    const deck = String(m.deck || "").toUpperCase();
    if (!JUKEBOX_DECKS.includes(deck)) return { ok: false, reason: "deck-not-allowed", allowed: JUKEBOX_DECKS };
    if (!m.filePath) return { ok: false, reason: "no-file" };
    stations.add(m.stationId);
    let loaded;
    try { loaded = A.audioLoad(deck, m.filePath, m.title || "", m.artist || "", m.gainDb ?? 0, m.stationId); }
    catch (e) { return { ok: false, reason: "load-threw", error: String(e && e.message || e) }; }
    if (loaded === false) return { ok: false, reason: "load-failed" };
    let played;
    try { played = A.audioPlay(deck, m.stationId); }
    catch (e) { return { ok: false, reason: "play-threw", error: String(e && e.message || e) }; }
    if (played === false) return { ok: false, reason: "play-failed" };

    jukeboxNow.set(m.stationId, {
      deck, filePath: m.filePath, title: m.title || "", artist: m.artist || "", startedAtMs: Date.now(),
    });

    // Normal deck lifecycle events — the same two the automation decks emit, on the same channels.
    // The board is the truth: a live jukebox fader is on air, so the deck state and now-playing say so.
    broadcast({
      event: "deck", stationId: m.stationId, deck,
      state: {
        status: "playing", title: m.title || "", artist: m.artist || "",
        filePath: m.filePath, durationSec: m.durationMs ? m.durationMs / 1000 : 0,
        positionSec: 0, scheduledAt: null, contentClass: m.contentClass ?? null,
      },
      ready: false,
    });
    broadcast({
      event: "playstart", stationId: m.stationId, deck,
      title: m.title || "", artist: m.artist || "", filePath: m.filePath,
    });

    // Honest history (v39): the row is marked `source='jukebox'` so Play History can tell a public
    // pick from rotation. Logging must never throw into the audio path.
    try {
      if (_jukeboxPlaylog) {
        _jukeboxPlaylog.logPlay(getDb(), {
          stationId: m.stationId, title: m.title || "", artist: m.artist || "", deck,
          durationMs: m.durationMs ?? null, sessionId: JUKEBOX_SESSION,
          filePath: m.filePath, source: "jukebox",
        });
      }
    } catch (e) { console.error("[audiod/jukebox] play_log failed:", e && e.message); }

    return { ok: true, deck, title: m.title || "" };
  },

  "jukebox:stop": (m) => {
    const deck = String(m.deck || "").toUpperCase();
    if (!JUKEBOX_DECKS.includes(deck)) return { ok: false, reason: "deck-not-allowed" };
    try { A.audioStop(deck, m.stationId); } catch { /* already stopped / never opened */ }
    jukeboxNow.delete(m.stationId);
    broadcast({
      event: "deck", stationId: m.stationId, deck,
      state: { status: "stopped", title: "", artist: "", filePath: null, durationSec: 0, positionSec: 0,
               scheduledAt: null, contentClass: null },
      ready: false,
    });
    return { ok: true, deck };
  },

  /** What the jukebox deck is ACTUALLY doing, straight off the engine — status, volume, is_finished.
   *  The kiosk's routing banner and its on-air blink read this and nothing else. */
  "jukebox:state": (m) => {
    const deck = String(m.deck || "").toUpperCase();
    if (!JUKEBOX_DECKS.includes(deck)) return { ok: false, reason: "deck-not-allowed" };
    const info = jukeboxDeckInfo(m.stationId, deck);
    const now = jukeboxNow.get(m.stationId) || null;
    return {
      ok: true, deck, info,
      status: info ? info.status : null,
      volume: info ? info.volume : null,
      isFinished: info ? !!info.is_finished : false,
      nowPlaying: now && now.deck === deck ? now : null,
    };
  },

  "queue:enqueue":    (m) => getEngine(m.stationId).intentEnqueue(m.items || []),
  "queue:remove":     (m) => getEngine(m.stationId).intentRemove(m.qid),
  "queue:reorder":    (m) => getEngine(m.stationId).intentReorder(m.qid, m.toIndex),
  "queue:move":       (m) => getEngine(m.stationId).intentMove(m.qid, m.where),
  "queue:clear":      (m) => getEngine(m.stationId).intentClearPending(),
  "deck:cue":         (m) => getEngine(m.stationId).intentCueDeck(m.deck, m.songRef || {}),
  // Operator start / safety skip — the deck ON button. Serialized, guarded, honest result.
  "deck:crossfade":   (m) => getEngine(m.stationId).intentCrossfade(m.from, m.to),
  // Board-style channel OFF — audio off now, not a pause.
  "deck:off":         (m) => getEngine(m.stationId).intentDeckOff(m.deck),
  // D4 adopt: populate-on-attach. Safe to call at any time — it only re-emits current state.
  "deck:snapshot":    (m) => getEngine(m.stationId).emitDeckSnapshot(),
  // PLAY NOW (Slice 4) — manual stall escape: load+play a song now (with songRef), else play the next
  // cued/queued track. Returns true if it put a deck on air.
  "deck:playNow":     (m) => getEngine(m.stationId).intentPlayNow(m.songRef || null),
  setAutoAdvance:     (m) => { getEngine(m.stationId).autoAdvance = !!m.value; return true; },
  setContinuous:      (m) => { getEngine(m.stationId).continuous = !!m.value; return true; },
  // Routine segue OVERLAP seconds — how many seconds the next song starts before the current one ends
  // (0 = wait for the end). No fades. Delivered from the app on connect + when the slider changes.
  setSegueOverlap:    (m) => { getEngine(m.stationId).segueOverlap = Math.max(0, Math.min(10, Number(m.seconds) || 0)); return true; },
  setShuffle:         (m) => { getEngine(m.stationId).shuffle = !!m.value; return true; },
};

function send(sock, obj) { try { sock.write(JSON.stringify(obj) + "\n"); } catch { /* client gone */ } }

// Commands worth a log line on receipt — the lifecycle/automation surface (NOT the high-rate
// pollers like getState/getLevels/getQueue, which would drown the log). automationStart/Stop
// receipts are the anchor for verifying the auto-resume fix (Commit 2).
const LOGGED_CMDS = new Set(["releaseDb", "automationStart", "automationStop", "skip", "fill", "init", "shutdown", "startStream", "stopStream"]);

function handleLine(sock, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const fn = handlers[msg.cmd];
  if (!fn) { send(sock, { id: msg.id, ok: false, error: "unknown cmd: " + msg.cmd }); return; }
  if (LOGGED_CMDS.has(msg.cmd)) log("cmd " + msg.cmd + " station=" + (msg.stationId ?? "-"));
  try {
    const r = fn(msg);
    // Some handlers (automationStart/fill) return promises — resolve before replying.
    if (r && typeof r.then === "function") r.then(v => send(sock, { id: msg.id, ok: true, result: v })).catch(e => send(sock, { id: msg.id, ok: false, error: String(e && e.message || e) }));
    else send(sock, { id: msg.id, ok: true, result: r });
  } catch (e) { send(sock, { id: msg.id, ok: false, error: String(e && e.message || e) }); }
}

// ── Event loop: broadcast levels (~10 Hz) + deck state (~4 Hz) for metered stations ──
let tick = 0;
const eventTimer = setInterval(() => {
  if (clients.size === 0 || stations.size === 0) return;
  tick++;
  for (const sid of stations) {
    try { broadcast({ event: "levels", stationId: sid, ...JSON.parse(A.audioGetLevels(sid)) }); } catch {}
    // Engine-owned stations emit their own per-deck `deck` events from poll(); only emit the
    // generic full-state deck snapshot for stations WITHOUT an automation engine.
    if (tick % 3 === 0 && !engines.has(sid)) { // ~4 Hz
      try { broadcast({ event: "deck", stationId: sid, state: JSON.parse(A.audioGetState(sid)) }); } catch {}
    }
  }
}, 100);

// ── Named-pipe server ─────────────────────────────────────────────────────────
const server = net.createServer((sock) => {
  clients.add(sock);
  log("client connected (" + clients.size + " total)");
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) handleLine(sock, line); }
  });
  sock.on("close", () => {
    clients.delete(sock);
    log("client disconnected (" + clients.size + " left)");
    // Dev: when the last client (the app) goes away, self-terminate so we don't zombie across a
    // restart. Short grace so a transient pipe blip + reconnect (client.scheduleReconnect, ~1s)
    // doesn't kill a daemon the app is about to re-attach to.
    if (DEV_REAP && clients.size === 0) {
      setTimeout(() => { if (clients.size === 0) { log("dev: no clients for 3s — exiting (no zombie)"); shutdown(); } }, 3000);
    }
  });
  sock.on("error", () => { clients.delete(sock); });
});

function startListen() { server.listen(PIPE, () => log("listening on " + PIPE + " (node " + process.version + ")")); }

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    if (isFileSocket) {
      // A Unix-socket file can linger after a crash. Probe it: if a daemon answers, one is
      // already running (single-instance → exit); if not, the file is stale → unlink + retry.
      const probe = net.connect(PIPE);
      probe.once("connect", () => { try { probe.destroy(); } catch {} log("endpoint in use — another ether-audiod is running. Exiting."); process.exit(0); });
      probe.once("error", () => { try { probe.destroy(); } catch {} try { require("fs").unlinkSync(PIPE); } catch {} log("removed stale socket " + PIPE + " — retrying listen"); setTimeout(startListen, 200); });
      return;
    }
    log("pipe in use — another ether-audiod is already running. Exiting."); process.exit(0);
  }
  log("server error:", e.message); process.exit(1);
});

startListen();

function shutdown() {
  log("shutting down — stopping streams + engines + decks + closing pipe");
  clearInterval(eventTimer);
  for (const s of streams.values()) { try { s.stop(); } catch {} }
  // dispose(), not stop(): stop() no longer tears down timers (MANUAL keeps the poll alive), so the
  // shutdown path must clear them explicitly or every station leaks a 250ms interval on exit.
  for (const e of engines.values()) { try { e.dispose(); } catch {} }
  for (const sid of stations) { try { A.audioStop("A", sid); A.audioStop("B", sid); A.audioStop("C", sid); } catch {} }
  try { if (_db) _db.close(); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
