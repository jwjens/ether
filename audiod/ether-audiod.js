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
require("./daemon-log").install();

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
  // Resolve the DB path the SAME way the main app does (electron/main.js _etherDir): prefer the
  // explicit ETHER_DB_PATH the app sets, then the machine-local %LOCALAPPDATA%\Ether path. The old
  // Roaming location is kept only as a last-resort legacy fallback. Without this unification the
  // daemon could open a DIFFERENT, empty DB (Roaming) if ETHER_DB_PATH were ever missing.
  const dbPath = process.env.ETHER_DB_PATH || (
    (process.platform === "win32" && process.env.LOCALAPPDATA)
      ? path.join(process.env.LOCALAPPDATA, "Ether", "com.ether.radio", "openair.db")
      : path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db")
  );
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
const handlers = {
  init:               (m) => { A.initAudioEngine(m.stationId); stations.add(m.stationId); return true; },
  load:               (m) => { stations.add(m.stationId); const r = A.audioLoad(m.deck, m.filePath, m.title || "", m.artist || "", m.gainDb ?? 0, m.stationId); const e = engines.get(m.stationId); if (e) e.noteManualCue(m.deck); return r; },
  play:               (m) => A.audioPlay(m.deck, m.stationId),
  pause:              (m) => A.audioPause(m.deck, m.stationId),
  stop:               (m) => A.audioStop(m.deck, m.stationId),
  setVolume:          (m) => A.audioSetVolume(m.deck, m.volume, m.stationId),
  setEq:              (m) => A.audioSetEq(m.stationId, JSON.stringify(m.bands || [])),
  getState:           (m) => JSON.parse(A.audioGetState(m.stationId)),
  getLevels:          (m) => JSON.parse(A.audioGetLevels(m.stationId)),
  getSpectrum:        (m) => JSON.parse(A.audioGetSpectrum(m.stationId)),
  getFileDuration:    (m) => A.getFileDuration(m.filePath),
  listOutputDevices:  ()  => JSON.parse(A.audioListOutputDevices()),
  setOutputDevice:    (m) => A.audioSetOutputDevice(m.stationId, m.device),
  setMonitorVolume:   (m) => A.audioSetMonitorVolume(m.stationId, m.volume),
  getProgramBusPort:  (m) => A.audioGetProgramBusPort(m.stationId),
  setBroadcastDelay:  (m) => A.audioSetBroadcastDelay(m.seconds, m.stationId),
  dump:               (m) => A.audioDump(m.stationId),
  broadcastDelayState:(m) => JSON.parse(A.audioBroadcastDelayState(m.stationId)),
  watchdogSet:        (m) => A.watchdogSet(m.active, m.thresholdSec, m.stationId),
  ping:               ()  => "pong",
  // The app version this daemon was spawned with (passed via env). Lets the app detect a stale
  // daemon left running across an update and reload it (the dead-air-on-update gotcha).
  version:            ()  => process.env.ETHER_DAEMON_VERSION || "0",
  // Graceful remote stop (the HA watchdog sends this on a clean user-quit, so the daemon
  // doesn't outlive the station; an update/relaunch leaves the daemon running instead).
  shutdown:           ()  => { setTimeout(shutdown, 50); return "bye"; },

  // ── autonomous playout engine (Phase 1 step 3): queue + advance + scheduler ──
  // Additive — the live app does not drive these yet (Phase-2 cutover does).
  automationStart:    (m) => getEngine(m.stationId).start(),                  // fill (if empty) + play + preload
  automationStop:     (m) => { const e = engines.get(m.stationId); if (e) e.stop(); return true; },
  skip:               (m) => getEngine(m.stationId).skip(),                    // force-advance to next track
  // Step 5 — streaming (ffmpeg → Icecast) inside the daemon, off the daemon's program bus.
  startStream:        (m) => getStream(m.stationId).start(m.config || {}),
  stopStream:         (m) => { const s = streams.get(m.stationId); return s ? s.stop() : { ok: true }; },
  streamStatus:       (m) => { const s = streams.get(m.stationId); return s ? s.status() : { stationId: m.stationId, state: "idle" }; },

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
  "queue:enqueue":    (m) => getEngine(m.stationId).intentEnqueue(m.items || []),
  "queue:remove":     (m) => getEngine(m.stationId).intentRemove(m.qid),
  "queue:reorder":    (m) => getEngine(m.stationId).intentReorder(m.qid, m.toIndex),
  "queue:move":       (m) => getEngine(m.stationId).intentMove(m.qid, m.where),
  "queue:clear":      (m) => getEngine(m.stationId).intentClearPending(),
  "deck:cue":         (m) => getEngine(m.stationId).intentCueDeck(m.deck, m.songRef || {}),
  "deck:crossfade":   (m) => getEngine(m.stationId).intentCrossfade(m.from, m.to),
  setAutoAdvance:     (m) => { getEngine(m.stationId).autoAdvance = !!m.value; return true; },
  setContinuous:      (m) => { getEngine(m.stationId).continuous = !!m.value; return true; },
  setShuffle:         (m) => { getEngine(m.stationId).shuffle = !!m.value; return true; },
};

function send(sock, obj) { try { sock.write(JSON.stringify(obj) + "\n"); } catch { /* client gone */ } }

// Commands worth a log line on receipt — the lifecycle/automation surface (NOT the high-rate
// pollers like getState/getLevels/getQueue, which would drown the log). automationStart/Stop
// receipts are the anchor for verifying the auto-resume fix (Commit 2).
const LOGGED_CMDS = new Set(["automationStart", "automationStop", "skip", "fill", "init", "shutdown", "startStream", "stopStream"]);

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
  for (const e of engines.values()) { try { e.stop(); } catch {} }
  for (const sid of stations) { try { A.audioStop("A", sid); A.audioStop("B", sid); A.audioStop("C", sid); } catch {} }
  try { if (_db) _db.close(); } catch {}
  try { server.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
