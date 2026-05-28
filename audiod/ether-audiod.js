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

const PIPE = process.env.ETHER_AUDIOD_PIPE || "\\\\.\\pipe\\ether-audiod";
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
  const dbPath = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db");
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
  load:               (m) => { stations.add(m.stationId); return A.audioLoad(m.deck, m.filePath, m.title || "", m.artist || "", m.gainDb ?? 0, m.stationId); },
  play:               (m) => A.audioPlay(m.deck, m.stationId),
  pause:              (m) => A.audioPause(m.deck, m.stationId),
  stop:               (m) => A.audioStop(m.deck, m.stationId),
  setVolume:          (m) => A.audioSetVolume(m.deck, m.volume, m.stationId),
  setEq:              (m) => A.audioSetEq(m.stationId, JSON.stringify(m.bands || [])),
  getState:           (m) => JSON.parse(A.audioGetState(m.stationId)),
  getLevels:          (m) => JSON.parse(A.audioGetLevels(m.stationId)),
  getFileDuration:    (m) => A.getFileDuration(m.filePath),
  listOutputDevices:  ()  => JSON.parse(A.audioListOutputDevices()),
  setOutputDevice:    (m) => A.audioSetOutputDevice(m.stationId, m.device),
  getProgramBusPort:  (m) => A.audioGetProgramBusPort(m.stationId),
  setBroadcastDelay:  (m) => A.audioSetBroadcastDelay(m.seconds, m.stationId),
  dump:               (m) => A.audioDump(m.stationId),
  broadcastDelayState:(m) => JSON.parse(A.audioBroadcastDelayState(m.stationId)),
  watchdogSet:        (m) => A.watchdogSet(m.active, m.thresholdSec, m.stationId),
  ping:               ()  => "pong",
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
  enqueue:            (m) => { getEngine(m.stationId).addToQueue(m.items || []); return true; },
  replaceQueue:       (m) => { getEngine(m.stationId).replaceQueue(m.items || []); return true; },
  clearQueue:         (m) => { const e = engines.get(m.stationId); if (e) e.clearQueue(); return true; },
  setAutoAdvance:     (m) => { getEngine(m.stationId).autoAdvance = !!m.value; return true; },
  setContinuous:      (m) => { getEngine(m.stationId).continuous = !!m.value; return true; },
  setShuffle:         (m) => { getEngine(m.stationId).shuffle = !!m.value; return true; },
};

function send(sock, obj) { try { sock.write(JSON.stringify(obj) + "\n"); } catch { /* client gone */ } }

function handleLine(sock, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const fn = handlers[msg.cmd];
  if (!fn) { send(sock, { id: msg.id, ok: false, error: "unknown cmd: " + msg.cmd }); return; }
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
  sock.on("close", () => { clients.delete(sock); log("client disconnected (" + clients.size + " left)"); });
  sock.on("error", () => { clients.delete(sock); });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { log("pipe in use — another ether-audiod is already running. Exiting."); process.exit(0); }
  log("server error:", e.message); process.exit(1);
});

server.listen(PIPE, () => log("listening on " + PIPE + " (node " + process.version + ")"));

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
