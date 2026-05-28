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

const PIPE = process.env.ETHER_AUDIOD_PIPE || "\\\\.\\pipe\\ether-audiod";
const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));

// Stations we're metering (added on first init/load), so the event loop knows what to poll.
const stations = new Set();
const clients = new Set();

function log(...a) { console.log("[audiod]", ...a); }

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
};

function send(sock, obj) { try { sock.write(JSON.stringify(obj) + "\n"); } catch { /* client gone */ } }
function broadcast(obj) { const line = JSON.stringify(obj) + "\n"; for (const c of clients) { try { c.write(line); } catch {} } }

function handleLine(sock, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const fn = handlers[msg.cmd];
  if (!fn) { send(sock, { id: msg.id, ok: false, error: "unknown cmd: " + msg.cmd }); return; }
  try { send(sock, { id: msg.id, ok: true, result: fn(msg) }); }
  catch (e) { send(sock, { id: msg.id, ok: false, error: String(e && e.message || e) }); }
}

// ── Event loop: broadcast levels (~10 Hz) + deck state (~4 Hz) for metered stations ──
let tick = 0;
const eventTimer = setInterval(() => {
  if (clients.size === 0 || stations.size === 0) return;
  tick++;
  for (const sid of stations) {
    try { broadcast({ event: "levels", stationId: sid, ...JSON.parse(A.audioGetLevels(sid)) }); } catch {}
    if (tick % 3 === 0) { // ~4 Hz
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
  log("shutting down — stopping decks + closing pipe");
  clearInterval(eventTimer);
  for (const sid of stations) { try { A.audioStop("A", sid); A.audioStop("B", sid); A.audioStop("C", sid); } catch {} }
  try { server.close(); } catch {}
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
