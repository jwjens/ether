// electron/audio-daemon-client.js — main-process client to ether-audiod (Item 10, Phase 2
// Step 1). Behind the ETHER_AUDIO_DAEMON flag (default OFF):
//   • when ENABLED, the main process does NOT own the audio engine — it spawns the daemon
//     (detached, so it outlives the app for gapless updates) and FORWARDS the audio:*
//     command surface over the named pipe, and re-broadcasts the daemon's levels/deck/
//     queue/playstart events to renderer windows.
//   • when DISABLED (default), this module is inert — the live in-process audio path in
//     main.js is completely unchanged. This is the rollback guarantee.
//
// Runtime: the daemon is spawned via the app's OWN Electron binary as node
// (ELECTRON_RUN_AS_NODE=1 process.execPath) — proven in the Step-0 gate (Electron 41 ships
// Node 24 with node:sqlite). Detached + unref so a UI/app restart leaves it running.

const net = require("net");
const path = require("path");
const cp = require("child_process");

const PIPE = process.env.ETHER_AUDIOD_PIPE || "\\\\.\\pipe\\ether-audiod";

// Daemon entry. In a packaged build the app dir is inside app.asar, but ELECTRON_RUN_AS_NODE
// has no asar support, so the daemon files must be asarUnpack'd — mirror the ffmpeg-static
// fixup (main.js) and point at app.asar.unpacked. (Packaging TODO: asarUnpack "audiod/**"
// and "native/ether-audio.node".)
let DAEMON_SCRIPT = path.join(__dirname, "..", "audiod", "ether-audiod.js");
if (DAEMON_SCRIPT.includes("app.asar") && !DAEMON_SCRIPT.includes("app.asar.unpacked")) {
  DAEMON_SCRIPT = DAEMON_SCRIPT.replace("app.asar", "app.asar.unpacked");
}

// Default ON — the out-of-process daemon is the shipped default. ETHER_AUDIO_DAEMON=0 forces
// the legacy in-process engine (rollback). main.js falls back to in-process if it can't connect.
function isEnabled() { return process.env.ETHER_AUDIO_DAEMON !== "0"; }

let sock = null, connected = false, buf = "", nextId = 1;
const pending = new Map();
let onEvent = () => {};            // main sets this → forwards events to windows
let reconnectTimer = null;
let stopped = false;
let lastSpawnAt = 0;               // debounce — never spawn more than once per 2s (storm guard)

function setEventHandler(fn) { onEvent = typeof fn === "function" ? fn : (() => {}); }

function spawnDaemon() {
  // Storm guard: even if ensure()/probe is called rapidly, spawn at most once per 2s. A
  // genuinely unstartable daemon (→ in-process fallback) must not spawn dozens of processes.
  const now = Date.now();
  if (now - lastSpawnAt < 2000) return;
  lastSpawnAt = now;
  try {
    const child = cp.spawn(process.execPath, [DAEMON_SCRIPT], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true, stdio: "ignore",
    });
    child.unref();
    console.log("[audiod-client] spawned daemon (detached) pid", child.pid);
  } catch (e) { console.error("[audiod-client] spawn failed:", e.message); }
}

function attach(s) {
  sock = s; buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.event) { try { onEvent(m); } catch {} }
      else if (m.id != null && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || "daemon error"));
      }
    }
  });
  const drop = () => {
    if (sock !== s) return;
    connected = false; sock = null;
    for (const [, p] of pending) p.reject(new Error("daemon disconnected"));
    pending.clear();
    if (!stopped) scheduleReconnect();
  };
  sock.on("close", drop);
  sock.on("error", () => { /* close follows */ });
}

function scheduleReconnect() {
  if (reconnectTimer || stopped) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; ensure(); }, 1000);
}

// Ensure the daemon is running + connected. Probe the pipe; if it's not answering, spawn the
// daemon then connect. Safe to call repeatedly (no-op once connected).
function ensure() {
  if (connected || sock || stopped) return;
  const probe = net.connect(PIPE);
  probe.once("connect", () => { connected = true; attach(probe); console.log("[audiod-client] connected to daemon"); });
  probe.once("error", () => {
    try { probe.destroy(); } catch {}
    spawnDaemon();
    setTimeout(() => {
      if (connected || sock || stopped) return;
      const s2 = net.connect(PIPE);
      s2.once("connect", () => { connected = true; attach(s2); console.log("[audiod-client] connected to daemon (after spawn)"); });
      s2.once("error", () => { try { s2.destroy(); } catch {} scheduleReconnect(); });
    }, 800);
  });
}

function cmd(name, args = {}) {
  return new Promise((resolve, reject) => {
    if (!connected || !sock) { reject(new Error("daemon not connected")); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try { sock.write(JSON.stringify({ id, cmd: name, ...args }) + "\n"); }
    catch (e) { pending.delete(id); reject(e); return; }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("daemon cmd timeout: " + name)); } }, 5000);
  });
}

function isConnected() { return connected; }
function stop() { stopped = true; if (reconnectTimer) clearTimeout(reconnectTimer); try { if (sock) sock.end(); } catch {} }

module.exports = { isEnabled, ensure, cmd, setEventHandler, isConnected, stop };
