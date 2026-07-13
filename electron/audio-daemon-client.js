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
const os = require("os");
const cp = require("child_process");
const fs = require("fs");   // v4.4.46: open the daemon's log as an append fd for native stderr capture

// Cross-platform endpoint (must match ether-audiod.js + watchdog): Windows named pipe;
// macOS/Linux per-user Unix domain socket in the temp dir. Override with ETHER_AUDIOD_PIPE.
function audiodEndpoint() {
  if (process.env.ETHER_AUDIOD_PIPE) return process.env.ETHER_AUDIOD_PIPE;
  if (process.platform === "win32") return "\\\\.\\pipe\\ether-audiod";
  const uid = (process.getuid && process.getuid()) || 0;
  return path.join(os.tmpdir(), `ether-audiod-${uid}.sock`);
}
const PIPE = audiodEndpoint();

// Daemon entry. In a packaged build the app dir is inside app.asar, but ELECTRON_RUN_AS_NODE
// has no asar support, so the daemon files must be asarUnpack'd — mirror the ffmpeg-static
// fixup (main.js) and point at app.asar.unpacked. (Packaging TODO: asarUnpack "audiod/**"
// and "native/ether-audio.node".)
let DAEMON_SCRIPT = path.join(__dirname, "..", "audiod", "ether-audiod.js");
if (DAEMON_SCRIPT.includes("app.asar") && !DAEMON_SCRIPT.includes("app.asar.unpacked")) {
  DAEMON_SCRIPT = DAEMON_SCRIPT.replace("app.asar", "app.asar.unpacked");
}

// Update-survival staging (Item 10): an app UPDATE kills every Ether.exe and replaces the
// install folder, so a daemon spawned as Ether.exe FROM that folder dies mid-install (the
// "music stopped during install" gap). stage-engine copies the runtime to an external, renamed
// ether-engine.exe under %LOCALAPPDATA% the installer can't touch; we spawn THAT. Best-effort:
// stageEngine returns null off-Windows / in dev / on failure → fall back to the in-dir engine.
let stageEngine;
try { ({ stageEngine } = require("../audiod/stage-engine")); } catch { stageEngine = () => null; }
let UNPACKED_ROOT = path.join(__dirname, "..");
if (UNPACKED_ROOT.includes("app.asar") && !UNPACKED_ROOT.includes("app.asar.unpacked")) {
  UNPACKED_ROOT = UNPACKED_ROOT.replace("app.asar", "app.asar.unpacked");
}
const SRC_ROOT = path.dirname(process.execPath);   // holds Ether.exe + icu/snapshot runtime data
function appVersion() {
  try { return require("electron").app.getVersion(); } catch {}
  try { return require(path.join(UNPACKED_ROOT, "package.json")).version; } catch {}
  return "0";
}

// DEFAULT ON — the out-of-process daemon (gapless updates) is the shipped default. Crackle,
// lifecycle (close-stops), and missing-file fixes are in. ETHER_AUDIO_DAEMON=0 forces the legacy
// in-process engine (rollback); main.js falls back to in-process if the daemon can't connect.
function isEnabled() { return process.env.ETHER_AUDIO_DAEMON !== "0"; }

// Packaged build vs dev. The whole "survive a gapless update" machinery — staging a renamed
// external ether-engine.exe + spawning it detached so it outlives the app — only makes sense for
// an INSTALLED build. In dev (unpackaged) there is no Ether.exe to stage and no installer to dodge,
// so staging just reuses a stale leftover packaged binary, and detaching leaves a zombie daemon
// behind on every restart (the dev "two versions playing" / "daemon not connected" mess). Dev runs
// the in-dir engine from repo source and lets the daemon die with the app instead. Default TRUE if
// undeterminable — always safer to behave like production.
function isPackagedApp() { try { return require("electron").app.isPackaged; } catch { return true; } }

let sock = null, connected = false, buf = "", nextId = 1;
const pending = new Map();
let onEvent = () => {};            // main sets this → forwards events to windows
let onConnected = () => {};        // main sets this → fired on every fresh attach (auto-resume replay)
let reconnectTimer = null;
let stopped = false;
let lastSpawnAt = 0;               // debounce — never spawn more than once per 2s (storm guard)
let spawnAttempts = 0;            // consecutive spawn-without-successful-connect cycles
const MAX_SPAWN_ATTEMPTS = 5;     // after this, give up — in-process fallback is terminal (no PID storm)

function setEventHandler(fn) { onEvent = typeof fn === "function" ? fn : (() => {}); }
function setConnectedHandler(fn) { onConnected = typeof fn === "function" ? fn : (() => {}); }

function spawnDaemon() {
  // Storm guard: even if ensure()/probe is called rapidly, spawn at most once per 2s. A
  // genuinely unstartable daemon (→ in-process fallback) must not spawn dozens of processes.
  const now = Date.now();
  if (now - lastSpawnAt < 2000) return;
  lastSpawnAt = now;
  // Hard cap: if the daemon keeps being spawned but never becomes reachable (e.g. it crashes on its
  // own DB open on a broken/redirected profile), give up so the in-process fallback is terminal
  // rather than an unbounded PID storm. Reset to 0 on a successful connect (attach()).
  if (spawnAttempts >= MAX_SPAWN_ATTEMPTS) {
    if (!stopped) { stopped = true; console.warn(`[audiod-client] daemon unreachable after ${MAX_SPAWN_ATTEMPTS} spawns — giving up; in-process fallback is terminal this session`); }
    return;
  }
  spawnAttempts++;
  try {
    const dev = !isPackagedApp();
    let exe = process.execPath, script = DAEMON_SCRIPT, tag = "in-dir engine";
    // Packaged only: stage a renamed, update-proof engine. Dev runs the in-dir repo source (above)
    // so daemon edits actually take effect and no stale packaged binary is reused.
    const staged = dev ? null : stageEngine({ srcRoot: SRC_ROOT, unpacked: UNPACKED_ROOT, version: appVersion() });
    if (staged) { exe = staged.exe; script = staged.script; tag = "staged engine (update-proof)"; }
    // Durable daemon log: the daemon is detached/stdio:"ignore" so its console is otherwise lost.
    // We know app userData here (the ELECTRON_RUN_AS_NODE daemon doesn't), so pass the path in.
    // (The daemon derives the same path as a fallback if this env is absent — never blind.)
    let logFile;
    try { logFile = path.join(require("electron").app.getPath("userData"), "logs", "ether-audiod.log"); } catch {}
    // v4.4.46 observability (native stderr capture): hand the daemon child an APPEND fd to its own
    // log as stderr, so the Rust addon's eprintln! diagnostics — [cpal] output errors, "Deck N
    // finished (source exhausted)", "source=None, path empty — skipping", "reload failed — skipping"
    // — previously discarded by stdio:"ignore", land in ether-audiod.log alongside the JS lines.
    // WHY an inherited FILE fd and not a parent-held pipe: a detached child's pipe write end BREAKS
    // (EPIPE) the instant this app process exits, and Rust eprintln! PANICS on a failed stderr write
    // → poisoned mutex → dead air on every app exit / gapless update. An inherited file handle keeps
    // writing across app exit with zero error. Both proven empirically — see
    // docs/v4446-observability-build.md §"Windows detached-stderr survival test" (A=EPIPE, B=ok).
    // The child gets its OWN duplicated handle at spawn, so we close our copy immediately. Best-effort:
    // any open failure falls back to the previous "ignore" so a spawn is never blocked by logging.
    let errStdio = "ignore", errFd = null;
    if (logFile) { try { errFd = fs.openSync(logFile, "a"); errStdio = errFd; } catch { errStdio = "ignore"; errFd = null; } }
    const child = cp.spawn(exe, [script], {
      // ETHER_DAEMON_VERSION lets the daemon report (via the `version` cmd) which app version
      // spawned it, so a stale daemon left running across an update can be detected + reloaded.
      // ETHER_DAEMON_DEV (dev only) tells the daemon to self-terminate when its last client (this
      // app) disconnects, so it never lingers as a zombie across restarts. Packaged OMITS it — the
      // daemon must outlive the app during a gapless update.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_DAEMON_VERSION: appVersion(), ...(dev ? { ETHER_DAEMON_DEV: "1" } : {}), ...(logFile ? { ETHER_AUDIOD_LOG: logFile } : {}) },
      // Packaged: detached + unref so an app/UI restart leaves the engine playing (gapless updates).
      // Dev: attached, so a graceful app exit reaps it too (the self-terminate above is the backstop
      // for a hard kill, where the OS closes the socket → the daemon sees its last client leave).
      // stdio: stdin/stdout ignored; stderr → the daemon's own append log (native eprintln capture).
      detached: !dev, stdio: ["ignore", "ignore", errStdio],
    });
    if (errFd != null) { try { fs.closeSync(errFd); } catch {} }  // child owns its inherited handle now
    child.unref();
    console.log(`[audiod-client] spawned daemon (${dev ? "dev, dies-with-app" : "detached"}) pid`, child.pid, "—", tag, errFd != null ? "(+native stderr→log)" : "");
  } catch (e) { console.error("[audiod-client] spawn failed:", e.message); }
}

function attach(s) {
  spawnAttempts = 0;   // reached a live daemon — reset the give-up counter
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
  // Fired on EVERY fresh attach — both ensure() connect handlers (initial probe AND the post-spawn
  // s2) funnel through attach(), as does every respawn/reconnect. Main uses it to replay
  // automationStart for on-air stations so a respawned daemon resumes instead of dead air. Deferred
  // a tick so the connect handler finishes and `connected`/`sock` are fully settled before any
  // replayed cmd() writes. Never throws into the socket path.
  setImmediate(() => { if (sock === s && connected) { try { onConnected(); } catch {} } });
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

// Reload a stale daemon (closes the dead-air-on-update gotcha). Tell the running daemon to shut
// down; its socket close → drop() → scheduleReconnect() → ensure() finds the pipe dead → spawnDaemon()
// brings up a FRESH, re-staged daemon at the current app version, and onConnected replays
// automationStart. One brief gap, then current code — vs. a zombie/wedged daemon causing dead air.
function reloadDaemon() {
  try { if (connected && sock) sock.write(JSON.stringify({ cmd: "shutdown" }) + "\n"); } catch {}
}

module.exports = { isEnabled, ensure, cmd, setEventHandler, setConnectedHandler, isConnected, stop, reloadDaemon };
