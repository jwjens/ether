'use strict';
/**
 * Ether HA watchdog (Phase 2) — single-direction in-session process supervisor.
 *
 * Runs as a SEPARATE process via the bundled Electron-as-Node
 * (ELECTRON_RUN_AS_NODE=1 electron watchdog/watchdog.js), spawns Ether as its
 * child, and restarts it on crash or hang. Lives in the user's interactive
 * session (audio + the per-user profile are session-scoped — see the HA
 * architecture investigation; running Ether as a Windows Service is impossible).
 *
 * Restart triggers — conservative, biased AGAINST killing a healthy Ether:
 *   • CRASH: child process exits unexpectedly (no clean-exit sentinel present).
 *   • HANG:  GET /health fails maxConsecutiveMisses times in a row while the
 *            process is still alive (frozen-but-alive).
 *   NOT a trigger in v1: audio.alive === false. The output callback firing is
 *   logged, but audio-thread recovery belongs to the dead-air watchdog, not the
 *   process supervisor — killing the whole app for an audio blip is too blunt.
 *
 * Sentinel handshake with main.js (files in userData):
 *   • .ether-clean-exit       → user quit; stand down, do not respawn.
 *   • .ether-expected-restart → update/relaunch; wait for self-relaunch, only
 *                               respawn if it never comes back within the grace.
 *
 * KNOWN GAP (v1, documented in README): "who watches the watchdog" — if THIS
 * process dies, Ether keeps running unsupervised until the next logon restarts
 * the watchdog. Mutual supervision (Ether relaunches a dead watchdog) is the
 * Phase 2.5 follow-up. uncaughtException/unhandledRejection are trapped below so
 * an unexpected throw can't take the watchdog down.
 *
 * Test seams (used by watchdog/test, never in prod):
 *   WATCHDOG_USER_DATA  — override the userData dir (isolate sentinels/logs).
 *   WATCHDOG_TEST_CMD   — spawn this instead of Ether (a mock).
 *   WATCHDOG_TEST_ARGS  — space-separated args for the mock.
 */
const http  = require('http');
const net   = require('net');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { spawn } = require('child_process');
const { TUNABLES: T, readHaConfig } = require('./config');

// ── Platform layer ───────────────────────────────────────────────────────────
function loadPlatform() {
  switch (process.platform) {
    case 'win32':  return require('./platform/win32');
    case 'darwin': return require('./platform/darwin');
    case 'linux':  return require('./platform/linux');
    default: throw new Error(`watchdog: unsupported platform ${process.platform}`);
  }
}
const platform  = loadPlatform();
const USER_DATA = process.env.WATCHDOG_USER_DATA || platform.userDataDir();

// ── Paths ────────────────────────────────────────────────────────────────────
const CLEAN_EXIT        = path.join(USER_DATA, '.ether-clean-exit');
const EXPECTED_RESTART  = path.join(USER_DATA, '.ether-expected-restart');
const ALARM_MARKER      = path.join(USER_DATA, '.ether-ha-alarm');
const PID_FILE          = path.join(USER_DATA, '.ether-watchdog.pid'); // our pid, so `Ether --disable-ha` can find+kill us
const LOG_PATH          = path.join(USER_DATA, 'watchdog.log');
const SENTINEL_FRESH_MS = 30000;

// ── Logging (never throws) ─────────────────────────────────────────────────────
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    try { if (fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch { /* no log yet */ }
    fs.mkdirSync(USER_DATA, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + os.EOL);
  } catch { /* logging must never crash the watchdog */ }
}

// Returns true (and deletes the file) if a fresh sentinel is present.
function consumeSentinel(file) {
  try {
    if (!fs.existsSync(file)) return false;
    const ts = Number(fs.readFileSync(file, 'utf8').trim()) || fs.statSync(file).mtimeMs;
    fs.unlinkSync(file);
    return (Date.now() - ts) <= SENTINEL_FRESH_MS;
  } catch { return false; }
}

// ── Spawn target (dev vs packaged vs test) ─────────────────────────────────────
function etherSpawnSpec() {
  if (process.env.WATCHDOG_TEST_CMD) {
    return {
      cmd:  process.env.WATCHDOG_TEST_CMD,
      args: (process.env.WATCHDOG_TEST_ARGS || '').split(' ').filter(Boolean),
      env:  { ...process.env },
    };
  }
  // We run under the electron/Ether binary (ELECTRON_RUN_AS_NODE=1), so
  // process.execPath is that binary. The child must boot as the APP, so strip
  // ELECTRON_RUN_AS_NODE. Dev: electron lives in node_modules → `electron <root>`.
  // Packaged: execPath IS Ether.exe → spawn it with no args.
  const isDev = /node_modules[\\/]electron/i.test(process.execPath);
  const appRoot = path.resolve(__dirname, '..');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ETHER_ADOPT_PID;                    // our adopt hint must not leak to the app
  env.ETHER_WATCHDOG_PID = String(process.pid);  // Phase 2.5: the app monitors us via this
  return { cmd: process.execPath, args: isDev ? [appRoot] : [], env };
}

// ── Audio daemon (ether-audiod) supervision — Item 10 Phase 2 Step 6 ──────────
// Only active when the out-of-process audio engine is in use (ETHER_AUDIO_DAEMON=1). The app
// also (re)spawns the daemon via audio-daemon-client; the daemon single-instances on its pipe
// (EADDRINUSE → exit), so two supervisors are safe. This independent restarter is the win:
// the daemon survives even while the APP itself is mid-restart (crash/update), so audio +
// stream never drop. The watchdog dir is asarUnpack'd, so appRoot resolves to
// app.asar.unpacked (packaged) / repo root (dev) and audiod/ sits beside it — no asar fixup.
// Default ON, all desktop platforms; =0 rolls back to in-process. Disabled under the test
// harness (WATCHDOG_TEST_CMD) since the Ether-supervision tests don't exercise the daemon.
const DAEMON_ENABLED = process.env.ETHER_AUDIO_DAEMON !== '0' && !process.env.WATCHDOG_TEST_CMD;
// Same endpoint as ether-audiod.js + the client: Windows named pipe, else per-user Unix socket.
const DAEMON_PIPE    = process.env.ETHER_AUDIOD_PIPE
  || (process.platform === 'win32' ? '\\\\.\\pipe\\ether-audiod' : path.join(os.tmpdir(), `ether-audiod-${(process.getuid && process.getuid()) || 0}.sock`));
const DAEMON_SCRIPT  = path.join(path.resolve(__dirname, '..'), 'audiod', 'ether-audiod.js');
// Update-survival (Item 10): respawn from the externally-staged, update-proof engine
// (ether-engine.exe under %LOCALAPPDATA%) when the app client has staged one. The watchdog
// never STAGES (that's the client's job, version-gated) — it only REUSES a staged copy via
// stagedTarget(); null → fall back to the in-dir engine. Required defensively so a missing
// module can never crash the supervisor.
let stagedTarget;
try { ({ stagedTarget } = require(path.join(path.resolve(__dirname, '..'), 'audiod', 'stage-engine'))); } catch { stagedTarget = () => null; }
let daemonTimer = null;
let daemonSpawning = false;

function probeDaemon() {
  return new Promise((resolve) => {
    const s = net.connect(DAEMON_PIPE);
    let done = false;
    const finish = (alive) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(alive); };
    s.once('connect', () => finish(true));
    s.once('error',   () => finish(false));
    setTimeout(() => finish(false), 1500);
  });
}

function spawnDaemon(reason) {
  if (daemonSpawning || stopping || halted) return;
  daemonSpawning = true;
  try {
    let exe = process.execPath, script = DAEMON_SCRIPT, tag = 'in-dir engine';
    try { const staged = stagedTarget(); if (staged) { exe = staged.exe; script = staged.script; tag = 'staged engine'; } } catch { /* fall back to in-dir */ }
    // ETHER_OWNER_PID (2026-08-18, "no owner, no engine"): a daemon must never exist without a
    // named, living owner. THIS supervisor is the right owner for a daemon it spawned — its whole
    // job is to bring the app back — and when the app connects it takes ownership via `hello`.
    // Without this the watchdog was the one spawner that produced a permanently ownerless engine.
    const child2 = spawn(exe, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ETHER_OWNER_PID: String(process.pid) }, detached: true, stdio: 'ignore' });
    child2.unref();
    log(`ether-audiod not responding (${reason}) — (re)spawned daemon pid ${child2.pid} (${tag})`);
  } catch (e) { log(`ether-audiod spawn failed: ${e.message}`); }
  setTimeout(() => { daemonSpawning = false; }, 3000); // debounce overlapping spawns
}

async function superviseDaemon() {
  if (stopping || halted || !DAEMON_ENABLED) return;
  const alive = await probeDaemon();
  if (!alive && !stopping && !halted) spawnDaemon('pipe dead');
}

// Best-effort graceful daemon stop on a real user-quit (CLEAN_EXIT). An update/relaunch
// (EXPECTED_RESTART) deliberately leaves the daemon running so audio is gapless.
function stopDaemon() {
  try {
    const s = net.connect(DAEMON_PIPE);
    s.once('connect', () => { try { s.write(JSON.stringify({ id: 0, cmd: 'shutdown' }) + '\n'); } catch {} setTimeout(() => { try { s.destroy(); } catch {} }, 200); });
    s.once('error', () => {});
    setTimeout(() => { try { s.destroy(); } catch {} }, 800);
  } catch {}
}

// ── State ──────────────────────────────────────────────────────────────────────
let child = null;        // ChildProcess when WE spawned Ether; null when adopted
let trackedPid = null;   // the pid under supervision (spawned child OR adopted app)
let missCount = 0;
let pollTimer = null;
let halted = false;          // crash-loop tripped — quiescent
let stopping = false;        // intentional watchdog shutdown
let intentionalKill = false; // set when WE kill the child (hang); suppresses the
                             // exit handler's crash-respawn so the hang path is
                             // the sole respawner (avoids a double-spawn race)
const restartTimes = [];  // ms timestamps of recent (re)spawns, for the crash-loop window

function restartsInWindow() {
  const cutoff = Date.now() - T.crashWindowMs;
  while (restartTimes.length && restartTimes[0] < cutoff) restartTimes.shift();
  return restartTimes.length;
}

// ── Health polling ──────────────────────────────────────────────────────────────
function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(T.healthUrl, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve({ ok: false, reason: `http ${res.statusCode}` }); return; }
        let audioAlive = null;
        try { audioAlive = JSON.parse(body)?.audio?.alive ?? null; } catch { /* ignore */ }
        resolve({ ok: true, audioAlive });
      });
    });
    req.setTimeout(T.healthTimeoutMs, () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }));
  });
}

async function poll() {
  if (!trackedPid || stopping || halted) return;
  const h = await checkHealth();
  if (!trackedPid || stopping || halted) return;
  if (h.ok) {
    if (missCount > 0) log(`health recovered after ${missCount} miss(es)`);
    missCount = 0;
    if (h.audioAlive === false) log('WARN /health ok but audio.alive=false (engine thread not firing) — logged, NOT a v1 restart trigger');
    return;
  }
  missCount++;
  log(`health miss ${missCount}/${T.maxConsecutiveMisses} (${h.reason})`);
  if (missCount < T.maxConsecutiveMisses) return;

  if (platform.isProcessAlive(trackedPid)) {
    // Alive but unresponsive → hang. Applies to both spawned and adopted.
    log(`HANG declared — force-killing pid ${trackedPid}`);
    handleHang();
  } else if (child) {
    // Spawned child already gone — its 'exit' event owns the respawn; don't
    // double-handle here (that was the Phase 2 double-spawn bug).
    log(`tracked child pid ${trackedPid} gone — exit handler will respawn`);
  } else {
    // ADOPTED process died: no ChildProcess → no exit event, so handle here.
    log(`adopted pid ${trackedPid} gone (no exit event) → crash path`);
    stopPolling();
    trackedPid = null;
    scheduleCrashRespawn();
  }
}

function startPolling() { stopPolling(); pollTimer = setInterval(() => { poll().catch((e) => log(`poll error ${e}`)); }, T.pollIntervalMs); }
function stopPolling()  { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ── Spawn / respawn ──────────────────────────────────────────────────────────────
function spawnEther(reason) {
  if (halted || stopping) return;
  if (restartsInWindow() >= T.maxRestartsInWindow) { tripCrashLoop(); return; }
  const { cmd, args, env } = etherSpawnSpec();
  restartTimes.push(Date.now());
  missCount = 0;
  log(`spawning Ether (${reason}) — restarts in window: ${restartsInWindow()}/${T.maxRestartsInWindow}`);
  try {
    // detached: the app must OUTLIVE the watchdog. If the watchdog process dies,
    // a non-detached child would die with it (Windows job/parent teardown) —
    // then Ether's own Phase 2.5 monitor could never relaunch the watchdog. We
    // still keep the handle (no unref) so 'exit' fires for crash detection, and
    // killHard (taskkill /T) still tears the app down on a hang.
    child = spawn(cmd, args, { env, stdio: 'ignore', detached: true });
  } catch (e) {
    log(`spawn threw: ${e.message} — retrying after backoff`);
    scheduleCrashRespawn();
    return;
  }
  const myPid = child.pid;
  trackedPid = myPid;
  log(`Ether spawned pid ${myPid}`);
  child.on('exit', (code, signal) => onChildExit(myPid, code, signal));
  child.on('error', (e) => log(`child error: ${e.message}`));
  startPolling();
}

// Adopt an already-running Ether (Phase 2.5 relaunch, or Settings-enable while
// the app is already up) instead of spawning a new one — a fresh spawn would hit
// requestSingleInstanceLock, quit, and look like a crash → respawn storm.
// Adopted processes have no ChildProcess, so death is detected by the poll loop.
async function adoptEther(adoptPid) {
  const alive = platform.isProcessAlive(adoptPid);
  const h = alive ? await checkHealth() : { ok: false, reason: 'not alive' };
  if (alive && h.ok) {
    child = null;
    trackedPid = adoptPid;
    missCount = 0;
    log(`adopted existing Ether pid ${adoptPid} (healthy) — monitoring, not spawning`);
    startPolling();
    return true;
  }
  log(`adopt(${adoptPid}) declined (${alive ? 'unhealthy' : 'not alive'}) — spawning fresh`);
  return false;
}

function onChildExit(pid, code, signal) {
  stopPolling();
  if (stopping) return;
  child = null;
  trackedPid = null;
  if (intentionalKill) {
    intentionalKill = false;
    log(`Ether pid ${pid} killed by watchdog (hang) — respawn handled by the hang path`);
    return;
  }
  log(`Ether pid ${pid} exited (code=${code} signal=${signal})`);

  if (consumeSentinel(CLEAN_EXIT)) {
    log('clean-exit sentinel → intentional user quit. Watchdog standing down.');
    // Real quit → stop the daemon too (an update/relaunch leaves it running, below).
    if (DAEMON_ENABLED) {
      stopping = true;
      if (daemonTimer) { clearInterval(daemonTimer); daemonTimer = null; }
      log('user-quit → stopping ether-audiod');
      stopDaemon();
      setTimeout(() => shutdown(0), 400);  // let the shutdown command flush over the pipe
      return;
    }
    shutdown(0);
    return;
  }
  if (consumeSentinel(EXPECTED_RESTART)) {
    log('expected-restart sentinel → update/relaunch. Waiting for self-relaunch.');
    waitForSelfRelaunch();
    return;
  }
  log('unexpected exit → CRASH.');
  scheduleCrashRespawn();
}

function scheduleCrashRespawn() {
  const n = restartsInWindow();
  if (n >= T.maxRestartsInWindow) { tripCrashLoop(); return; }
  const delay = T.backoffMs[Math.min(n, T.backoffMs.length - 1)];
  log(`respawning after crash in ${delay}ms`);
  setTimeout(() => spawnEther('crash-restart'), delay);
}

function handleHang() {
  stopPolling();
  const pid = trackedPid;
  const wasSpawned = !!child; // only a spawned child fires onChildExit
  child = null;
  trackedPid = null;
  // Suppress the spawned child's exit→crash path (this kill owns the respawn).
  // For an ADOPTED process there's no ChildProcess/exit event, so arming the
  // flag would leak onto the NEXT spawned child's real crash — only arm it when
  // we actually had a child.
  intentionalKill = wasSpawned;
  platform.killHard(pid);
  // Respawn only once the old process is gone AND :3400 refuses, so the new
  // instance isn't bounced by requestSingleInstanceLock (main.js:144).
  const deadline = Date.now() + T.killConfirmTimeoutMs;
  (function confirm() {
    if (stopping || halted) return;
    const gone = !platform.isProcessAlive(pid);
    checkHealth().then((h) => {
      const portFree = !h.ok && h.reason !== 'timeout'; // refused/reset = nothing listening
      if ((gone && portFree) || Date.now() > deadline) {
        log(`kill confirmed (gone=${gone}, portFree=${portFree}, timedOut=${Date.now() > deadline}) — respawning after hang`);
        scheduleHangRespawn();
      } else {
        setTimeout(confirm, 500);
      }
    });
  })();
}

function scheduleHangRespawn() {
  const n = restartsInWindow();
  if (n >= T.maxRestartsInWindow) { tripCrashLoop(); return; }
  const delay = T.backoffMs[Math.min(n, T.backoffMs.length - 1)];
  log(`respawning after hang in ${delay}ms`);
  setTimeout(() => spawnEther('hang-restart'), delay);
}

function waitForSelfRelaunch() {
  const deadline = Date.now() + T.expectedRestartGraceMs;
  (function wait() {
    if (stopping || halted) return;
    checkHealth().then((h) => {
      if (h.ok) { log('app self-relaunched and healthy — resuming monitoring (no respawn)'); startPolling(); return; }
      if (Date.now() > deadline) { log('expected restart never returned within grace — respawning'); spawnEther('relaunch-timeout'); return; }
      setTimeout(wait, 2000);
    });
  })();
}

function tripCrashLoop() {
  halted = true;
  stopPolling();
  log(`CRASH LOOP: >=${T.maxRestartsInWindow} restarts within ${T.crashWindowMs / 1000}s — HALTING auto-restart. Manual intervention required.`);
  try { fs.writeFileSync(ALARM_MARKER, String(Date.now())); } catch { /* best effort */ }
  // Stay alive but quiescent (a no-op keep-alive) so a startup mechanism doesn't
  // immediately relaunch the watchdog into another loop. A human / Phase 4
  // Settings clears the alarm and restarts.
  setInterval(() => {}, 1 << 30);
}

function shutdown(code) {
  stopping = true;
  stopPolling();
  if (daemonTimer) { clearInterval(daemonTimer); daemonTimer = null; }
  try { fs.unlinkSync(PID_FILE); } catch { /* none */ }
  process.exit(code);
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const cfg = readHaConfig(USER_DATA);
  if (cfg.enabled === false) { log('HA disabled in ha-config.json — watchdog exiting.'); process.exit(0); }
  try { fs.unlinkSync(ALARM_MARKER); } catch { /* none */ }      // clear stale alarm on fresh start
  try { fs.unlinkSync(CLEAN_EXIT); } catch { /* none */ }        // don't let a stale sentinel mislead us
  try { fs.unlinkSync(EXPECTED_RESTART); } catch { /* none */ }
  try { fs.mkdirSync(USER_DATA, { recursive: true }); fs.writeFileSync(PID_FILE, String(process.pid)); } catch { /* best effort */ }
  log(`watchdog starting (platform=${process.platform}, userData=${USER_DATA}, pid=${process.pid})`);
  process.on('SIGINT',  () => { log('SIGINT — stopping');  shutdown(0); });
  process.on('SIGTERM', () => { log('SIGTERM — stopping'); shutdown(0); });
  process.on('uncaughtException',  (e) => { try { log(`uncaughtException ${e && e.stack || e}`); } catch {} });
  process.on('unhandledRejection', (e) => { try { log(`unhandledRejection ${e}`); } catch {} });

  // If launched with an adopt hint (Phase 2.5 relaunch / Settings-enable while
  // the app is already running), adopt that live instance instead of spawning a
  // second one. Otherwise cold-start a fresh Ether.
  const adoptPid = Number(process.env.ETHER_ADOPT_PID) || 0;
  if (adoptPid) {
    adoptEther(adoptPid).then((ok) => { if (!ok) spawnEther('initial'); }).catch(() => spawnEther('initial'));
  } else {
    spawnEther('initial');
  }

  // Independently supervise the audio daemon (restart it if its pipe goes dead), so audio +
  // stream survive even while the app is mid-restart. Only when the daemon path is in use.
  if (DAEMON_ENABLED) {
    log('audio daemon supervision ON (ETHER_AUDIO_DAEMON=1)');
    superviseDaemon().catch(() => {});
    daemonTimer = setInterval(() => { superviseDaemon().catch((e) => log(`daemon supervise error ${e}`)); }, 5000);
  }
}

try { main(); }
catch (e) { try { log(`FATAL ${e && e.stack || e}`); } catch {} process.exit(1); }
