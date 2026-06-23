// electron/main.js
// Ether Electron main process
// Replaces src-tauri entirely — Chromium rendering, Node.js backend, NAPI audio

// ─── PHASE A INSERT AUDIT — COMPLETE 2026-05-14 ──────────────────────────────
// The original concern: ~40 renderer INSERT callsites might write rows without
// an explicit station_id, breaking multi-station isolation. That concern was
// resolved during Phase F (sync engine work) before any callsite was broken in
// production. INSERT audit confirmed zero broken callsites (commit 08f75da).
//
// Phase A schema migrations (non-synced local tables):
//   eas_tests         station_id added — schema v13 (commit 433e7a0, 2026-05-14)
//   midi_mappings     station_id added — schema v14 (commit bcc9f66, 2026-05-14)
//   ai_voice_segments station_id added — schema v15 (commit 1c0fc88, 2026-05-14)
//
// Gate flag 'multistation_insert_audit_complete' = 'true':
//   Existing installs — flag already present in station_config_kv
//   Fresh installs    — seeded via INSERT OR IGNORE in runMigrations() (this file)
//   Guard location    — stations:create handler ~line 3935
//
// Multi-station station creation is now permitted.
//
// ── Original callsite inventory (audit history — not a live to-do list) ──────
// Table               File                               INSERT location
// categories          src/App.tsx                        ~line 3269
// categories          src/components/CreateShowWizard    ~line 164
// categories          src/components/ImportDialog.tsx    ~line 40
// categories          src/components/LibraryImport.tsx   ~line 387
// categories          src/components/Scheduler.tsx       ~line 295
// play_log            src/db/client.ts                   ~line 128
// play_log            src/audio/showClock.ts             ~line 121
// artists             src/components/ImportDialog.tsx    ~line 110
// artists             src/components/LibraryImport.tsx   ~line 373
// artists             src/components/NexGenImport.tsx    ~line 112
// songs               src/components/ImportDialog.tsx    ~line 116
// songs               src/components/LibraryImport.tsx   ~line 396
// songs               src/components/NexGenImport.tsx    ~line 123
// clock_slots         src/components/GSelectorImport.tsx ~line 234
// clock_slots         src/components/Scheduler.tsx       ~line 773
// clock_slots         src/components/Scheduler.tsx       ~line 788
// clock_slots         src/components/Scheduler.tsx       ~line 805
// scheduled_log       src/components/ProgramLog.tsx      ~line 222
// scheduled_log       src/components/ProgramLog.tsx      ~line 289
// scheduled_log       src/components/ProgramLog.tsx      ~line 297
// scheduled_log       src/components/ProgramLog.tsx      ~line 338
// shows               src/components/CreateShowWizard    ~line 182
// shows               src/components/ProgramLog.tsx      ~line 1473
// shows               src/components/Scheduler.tsx       ~line 116
// clocks              src/components/CreateShowWizard    ~line 146
// clocks              src/components/Scheduler.tsx       ~line 741
// voice_tracks        src/components/BroadcastEditor.tsx ~line 1304
// voice_tracks        src/components/VoiceTracker.tsx    ~line 558
// operators           src/components/OnShiftScreen.tsx   ~line 212
// operator_notes      src/components/OnShiftScreen.tsx   ~line 199
// spots               src/components/Spots.tsx           ~line 48
// spots               src/components/Spots.tsx           ~line 67
// spots               src/components/Spots.tsx           ~line 157
// cart_slots          src/components/CartWall.tsx        ~line 69
// announcements       src/components/Announcements.tsx   ~line 102
// macros              src/components/MacroEngine.tsx     ~line 207
// liner_cards         src/components/ShowPrep.tsx        ~line 274
// prep_notes          src/components/ShowPrep.tsx        ~line 391
// format_clocks       src/components/ClockEditor.tsx     ~line 168
// published_episodes  src/components/PublishEpisode.tsx  ~line 428
// ─────────────────────────────────────────────────────────────────────────────

// ── HA watchdog self-dispatch (Phase 3) ──────────────────────────────────────
// When launched as `Ether.exe --ether-watchdog` (the Scheduled Task at logon and
// the Phase 2.5 relaunch both use this form), run the watchdog supervisor
// instead of the app. MUST be the very first thing to execute — before the
// single-instance lock, Sentry, DB, and window creation — so the watchdog never
// contends the app's lock and stays a lean windowless background process.
// watchdog.js uses only Node builtins (no electron `app`). Top-level `return` is
// valid here (CommonJS module wrapper).
if (process.argv.includes('--ether-watchdog')) {
  require('../watchdog/watchdog.js');
  return;
}

// ── HA bootstrap CLI flags (Phase 3) ─────────────────────────────────────────
// `--enable-ha`  : register the per-user logon Scheduled Task + bring up a
//                  watchdog that ADOPTS this process, then continue normal boot.
// `--disable-ha` : unregister the task + kill the running watchdog (PID from
//                  .ether-watchdog.pid), then continue boot. Smoke/manual cleanup.
// Detected here near the top (per spec), but EXECUTED once /health is listening
// (see handleHaBootstrapFlags, called from the :3400 listen callback): a watchdog
// spawned before /health is up would fail to adopt, spawn a 2nd Ether, lose the
// single-instance race, and look like a crash → respawn storm.
const _haEnableHaFlag  = process.argv.includes('--enable-ha');
const _haDisableHaFlag = process.argv.includes('--disable-ha');

// ── DIAGNOSTIC — writes to %TEMP%\ether-diag.txt to pinpoint early crash ─────
// Remove after the no-window bug is diagnosed.
(function() {
  try {
    const _fs = require('fs'), _os = require('os'), _p = require('path');
    const _log = (msg) => _fs.appendFileSync(_p.join(_os.tmpdir(), 'ether-diag.txt'),
      new Date().toISOString() + ' ' + msg + '\n');
    _log('POINT-1: main.js started  pid=' + process.pid + '  argv=' + process.argv.slice(1).join(' '));
    process.on('uncaughtException', (e) => _log('UNCAUGHT: ' + e.message + '\n' + (e.stack||'')));
    process.on('unhandledRejection', (r) => _log('UNHANDLED_REJECTION: ' + r));
    global.__etherDiag = _log;
  } catch(e) { /* silently skip if fs not available */ }
})();

// ── Load .env before anything else so process.env is populated for all modules ──
try { require("dotenv").config(); } catch (e) { /* dotenv optional in packaged build */ }

// Suppress dev-mode security warnings (webSecurity/CSP/eval needed for Vite HMR;
// all flags are stripped in the packaged build automatically).
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, safeStorage, powerMonitor } = require("electron");

// ── Sentry (main process) ─────────────────────────────────────
try {
  const Sentry = require("@sentry/electron/main");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: app.isPackaged,
    release: "ether@" + app.getVersion(),
    tracesSampleRate: 0.1,
  });
} catch (e) {
  console.log("[SENTRY] Not initialized:", e.message);
}
const path = require("path");
const fs = require("fs");
const semver = require("semver");
const { ETHER_BACKEND_URL } = require('./lib/etherBackend');

// Stop leaving a Roaming\openair folder behind: store this app's userData under an "Ether" folder
// instead of the legacy "openair" app-name default. We redirect the userData PATH only (not the
// Electron app name) so the updater, single-instance lock, and watchdog identity are untouched.
// One-time move-over: if a computer already has the old openair userData and no Ether one yet, copy
// it across so markers/backups/settings carry over. The station database is NOT here (it lives in
// %LOCALAPPDATA%\Ether\com.ether.radio), so this never risks the library/stations. Best-effort:
// any failure just falls through to the default location. MUST run before any getPath('userData').
try {
  const _appData = app.getPath("appData");
  const _newUserData = path.join(_appData, "Ether");
  const _oldUserData = path.join(_appData, "openair");
  try {
    if (!fs.existsSync(_newUserData) && fs.existsSync(_oldUserData)) {
      // Prefer an instant rename (same drive, no copy); fall back to copy+delete if that fails
      // (e.g. cross-device or locked). Either way the old openair folder is gone afterward.
      try { fs.renameSync(_oldUserData, _newUserData); }
      catch { fs.cpSync(_oldUserData, _newUserData, { recursive: true }); try { fs.rmSync(_oldUserData, { recursive: true, force: true }); } catch {} }
    }
  } catch (e) { console.warn("[userData] migrate openair→Ether skipped:", e.message); }
  app.setPath("userData", _newUserData);
} catch (e) { console.warn("[userData] redirect to Ether folder skipped:", e.message); }
if (global.__etherDiag) global.__etherDiag('POINT-1b: path/fs loaded OK');
let Database;
try { Database = require("better-sqlite3"); if (global.__etherDiag) global.__etherDiag('POINT-1c: better-sqlite3 loaded OK'); }
catch(e) { if (global.__etherDiag) global.__etherDiag('POINT-1c: better-sqlite3 FAILED: ' + e.message); throw e; }
let SYNCED_TABLES, SYNCED_TABLES_SET;
try {
  ({ SYNCED_TABLES } = require('./sync/synced-tables'));
  SYNCED_TABLES_SET = new Set(SYNCED_TABLES);
  if (global.__etherDiag) global.__etherDiag('POINT-1d: synced-tables loaded OK  count=' + SYNCED_TABLES.length);
} catch(e) { if (global.__etherDiag) global.__etherDiag('POINT-1d: synced-tables FAILED: ' + e.message); throw e; }
console.log(`[db:execute guard] active — ${SYNCED_TABLES.length} synced tables locked from direct writes`);

// ── Startup diagnostics log ────────────────────────────────────
// Written to userData/ether-startup.log so packaged builds can be diagnosed
// without a terminal attached.
let _startupLogPath = null;
function logStartup(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(`[STARTUP] ${msg}\n`);
  if (_startupLogPath) {
    try { fs.appendFileSync(_startupLogPath, line); } catch {}
  }
}

// ── App identity ──────────────────────────────────────────────
app.setAppUserModelId("ether");

// ── Fix DPI scaling on Windows ────────────────────────────────
if (process.platform === "win32") {
  app.commandLine.appendSwitch("high-dpi-support", "1");
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
}

// ── Single-instance lock ──────────────────────────────────────
// Without this, every additional Electron instance tries to bind port 3400
// and crashes with EADDRINUSE. The second instance focuses the running window
// and exits; the first instance never sees the conflict.
if (global.__etherDiag) global.__etherDiag('POINT-2: before requestSingleInstanceLock');
if (!app.requestSingleInstanceLock()) {
  if (global.__etherDiag) global.__etherDiag('POINT-2b: lock NOT acquired — exiting (another instance running)');
  app.quit();
  process.exit(0);
}
if (global.__etherDiag) global.__etherDiag('POINT-3: lock acquired OK');
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Environment ───────────────────────────────────────────────
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const VITE_DEV_URL = "http://127.0.0.1:1420";

// ── Load native audio addon ───────────────────────────────────
// Item 10 Phase 2: when the out-of-process daemon (ether-audiod) is DESIRED it owns the live
// engine and main forwards deck control to it — so audio survives a UI/app restart. Crucially
// the daemon is a graceful ENHANCEMENT: if it can't be brought up at startup, main falls back
// to the in-process engine (today's behavior), so the daemon can NEVER cause dead air.
//   AUDIO_DAEMON_DESIRED — the flag (do we WANT the daemon).
//   AUDIO_DAEMON         — the EFFECTIVE mode; true only once the daemon is confirmed reachable
//                          (decided in setupAudioBackend() below). All audio:* handlers branch
//                          on this, so a fallback transparently uses the in-process engine.
// Main always loads the addon — for stateless utilities AND the in-process fallback path. The
// engine is NOT inited here; setupAudioBackend() inits it only when NOT on the daemon.
// DEFAULT ON — the out-of-process daemon (gapless updates) is the shipped default. The earlier
// live-stream crackle (program-bus drain zero-fill) and on-air-status regression are FIXED.
// ETHER_AUDIO_DAEMON=0 forces the legacy in-process engine. Safe to default on: setupAudioBackend
// falls back to the in-process engine automatically if the daemon can't connect (no dead air).
const AUDIO_DAEMON_DESIRED = process.env.ETHER_AUDIO_DAEMON !== "0";
let AUDIO_DAEMON = false;
let audio;
try {
  audio = require("../native/ether-audio.node");
  console.log("[AUDIO] native addon loaded" + (AUDIO_DAEMON_DESIRED ? " — daemon desired (in-process fallback armed)" : ""));
} catch (e) {
  console.error("[AUDIO] Failed to load native addon:", e.message);
  // Fallback stub so app doesn't crash during development
  audio = {
    initAudioEngine: () => true,
    audioLoad: () => true,
    audioPlay: () => true,
    audioPause: () => true,
    audioStop: () => true,
    audioSetVolume: () => true,
    audioGetState: () => JSON.stringify({ deckA: {}, deckB: {}, deckC: {} }),
    audioGetLevels: () => JSON.stringify({ a: 0, b: 0, c: 0 }),
    getFileDuration: () => 0,
    getLocalIp: () => "localhost",
    analyzeFile: () => -14,
    openUrl: () => true,
    openSoundSettings: () => true,
    watchdogSet: () => true,
    audioLastCallbackMs: () => 0,
  };
}

// Item 10 Phase 2 Step 1 — out-of-process audio daemon client. Inert unless the daemon is
// desired. When desired, re-broadcast the daemon's events to windows (levels → the renderer's
// VU feed; deck/queue/playstart → the renderer proxy; stream → the on-air status).
const audiodClient = require("./audio-daemon-client");
const _daemonStreamStates = new Map();   // stationId → last stream state, for stream:status:global
// Auto-resume (Item 10): per-station automation intent. Set when the app issues automationStart,
// cleared ONLY by an explicit automationStop. A daemon disconnect/respawn must NEVER clear it —
// that's exactly the state we need to replay so a respawned (idle, _started=false) daemon resumes
// playout instead of dead air. stationId → the automationStart args, so the replay is faithful.
const _automationIntent = new Map();

// Stale-daemon auto-reload (Item 10 follow-up — closes the dead-air-on-update gotcha). The daemon
// is detached so it survives an app update gaplessly; the downside is a daemon left running OLD
// code (or wedged) after the app updates — the renderer is new, the daemon is a zombie, and that
// caused real dead air on the 4.3.27 update. On each fresh connect we ask the daemon its version
// (the app version it was spawned with); if it's older than this app, we reload it — at the next
// song boundary while audio is flowing, or promptly if there's NO audio (wedged/idle), which
// bounds dead-air. The fresh daemon is re-staged to the current version and auto-resume replays.
let _daemonReloadArmed = false;
let _daemonReloadTimer = null;
let _lastDaemonAudioAt = 0;
function disarmDaemonReload() {
  _daemonReloadArmed = false;
  if (_daemonReloadTimer) { clearInterval(_daemonReloadTimer); _daemonReloadTimer = null; }
}
function fireDaemonReload(why) {
  if (!_daemonReloadArmed) return;
  disarmDaemonReload();
  console.warn(`[AUDIO] stale daemon → reloading (${why})`);
  try { audiodClient.reloadDaemon(); } catch {}
}
function armDaemonReload() {
  if (_daemonReloadArmed) return;
  _daemonReloadArmed = true;
  _lastDaemonAudioAt = Date.now();   // grace: don't fire before we've seen whether audio is flowing
  // A daemon that isn't actually producing sound (wedged or idle) is safe to reload at once; a
  // healthy one keeps _lastDaemonAudioAt fresh from levels events and instead waits for a boundary.
  _daemonReloadTimer = setInterval(() => {
    if (Date.now() - _lastDaemonAudioAt > 4500) fireDaemonReload("no audio");
  }, 1500);
}
async function checkStaleDaemon() {
  let dv;
  try {
    dv = await audiodClient.cmd("version", {});
  } catch (e) {
    // A daemon too old to even know the `version` command is, by definition, stale — reload it.
    // (This is what lets the FIRST update after this ships self-heal: the running daemon predates
    // the command.) A plain connection error is NOT this — only treat "unknown cmd" as stale.
    if (e && /unknown cmd/.test(String(e.message || e))) {
      console.warn("[AUDIO] daemon predates the version command — arming reload");
      armDaemonReload();
    }
    return;
  }
  const appV = (() => { try { return require("electron").app.getVersion(); } catch { return "0"; } })();
  if (dv && dv !== "0" && dv !== appV) {
    console.warn(`[AUDIO] daemon v${dv} is older than app v${appV} — arming reload`);
    armDaemonReload();
  }
}

// Audio-liveness watchdog (Item 10 follow-up — the recurring SILENT-WEDGE recovery). Distinct from
// the daemon's own stall watchdog (which only catches "no deck playing"): here the daemon's logic
// keeps rotating but its cpal output stream has died (device change/disconnect), so a deck reports
// "playing" while output is silent — levels frozen at ~0 — and nothing recovers it. This is dead
// air the operator hears. We detect it from the renderer side (where the levels feed already lives)
// and auto-reload the daemon: the exact kill→respawn recovery, automated. Conservative to avoid
// false reloads — only fires when audio has been silent a while AND getState CONFIRMS a deck is
// supposed to be playing, with a cooldown so a still-broken device can't induce a tight loop.
let _audioWatchdogTimer = null;
let _lastAudioReloadAt = 0;
function startAudioLivenessWatchdog() {
  if (_audioWatchdogTimer) return;
  _audioWatchdogTimer = setInterval(async () => {
    try {
      if (!audiodClient.isConnected()) return;
      if (Date.now() - _lastDaemonAudioAt < 6000) return;     // audio is (or just was) flowing — healthy
      if (Date.now() - _lastAudioReloadAt < 60000) return;    // cooldown — never loop on a still-dead device
      // Output has been silent ≥6s. Confirm a deck is actually SUPPOSED to be playing before we act,
      // so genuine idle/off-air silence never triggers a reload. Check the on-air stations (or s1).
      const sids = _automationIntent.size > 0 ? [..._automationIntent.keys()] : [1];
      for (const sid of sids) {
        const st = await audiodClient.cmd("getState", { stationId: sid }).catch(() => null);
        const playing = st && [st.deckA, st.deckB, st.deckC].some((d) => d && d.status === "playing");
        if (playing) {
          _lastAudioReloadAt = Date.now();
          console.warn(`[AUDIO] liveness watchdog: station ${sid} deck reports playing but output silent ≥6s — reloading daemon (silent-wedge recovery)`);
          try { audiodClient.reloadDaemon(); } catch {}
          break;
        }
      }
    } catch {}
  }, 2000);
}

if (AUDIO_DAEMON_DESIRED) {
  audiodClient.setEventHandler((m) => {
    try {
      if (m.event === "levels") {
        const lv = { a: m.a || 0, b: m.b || 0, c: m.c || 0 };
        lv.master = typeof m.master === "number" ? m.master : Math.max(lv.a, lv.b, lv.c);
        sendToAllWindows("audio:levels", lv);
        // Audio-liveness signal (feeds BOTH the stale-daemon reload and the silent-wedge watchdog):
        // real output keeps this fresh; a wedged daemon (deck claims playing, output silent) stops
        // updating it because its audio callback has stopped firing → levels freeze at ~0.
        if (lv.master > 0.01 || lv.a > 0.01 || lv.b > 0.01 || lv.c > 0.01) _lastDaemonAudioAt = Date.now();
      } else if (m.event === "deck") {
        // Per-deck state change from the daemon's poll → renderer proxy (Step 2).
        // Stage 0: forward deckReady (cued) so the renderer mirrors it instead of guessing.
        sendToAllWindows("audio:daemon-deck", { stationId: m.stationId, deck: m.deck, state: m.state, ready: m.ready });
      } else if (m.event === "queue") {
        sendToAllWindows("audio:daemon-queue", { stationId: m.stationId, items: m.items, source: m.source });
      } else if (m.event === "playstart") {
        sendToAllWindows("audio:daemon-playstart", { stationId: m.stationId, deck: m.deck, title: m.title, artist: m.artist, filePath: m.filePath });
        // Song boundary: the cleanest moment to swap out a stale-but-healthy daemon (current song
        // just ended). The no-audio timer covers wedged/idle daemons that never reach here.
        if (_daemonReloadArmed) fireDaemonReload("song boundary");
      } else if (m.event === "stream") {
        // Step 5: daemon Icecast status → the renderer's existing stream channels. The on-air
        // badge reads global.anyLive, which ONLY updates from stream:status:global — so the
        // daemon path MUST emit it too (the in-process path does via _emitGlobal). Without this
        // the badge could never latch ON AIR in daemon mode (the original on-air-stuck-off bug).
        sendToAllWindows("stream:status", { stationId: m.stationId, live: m.state === "live", error: m.errorMsg || undefined });
        sendToAllWindows("stream:status:dest", { destId: `icecast:${m.stationId}`, label: `Icecast (${m.stationId})`, state: m.state, speed: m.speed, bitrate: m.bitrate, uptimeSec: m.uptimeSec, errorMsg: m.errorMsg, speedHistory: [] });
        _daemonStreamStates.set(m.stationId, m.state);
        let liveCount = 0; for (const s of _daemonStreamStates.values()) if (s === "live") liveCount++;
        sendToAllWindows("stream:status:global", { anyLive: liveCount > 0, liveCount });
        _persistOnAir(liveCount > 0);
        sseAirstate(liveCount > 0, liveCount);
      }
    } catch {}
  });

  // Auto-resume: on every fresh daemon (re)connect, replay automationStart for each station whose
  // intent is on-air. A respawned daemon comes up idle (_started=false) — this re-arms it (the
  // Trace-B dead-air path, now self-healing). A surviving, still-playing daemon hits the engine's
  // existing alreadyOnAir no-op (audibly silent) — we deliberately lean on that single idempotency
  // path rather than adding a second. The very first connect replays nothing (intent is empty).
  audiodClient.setConnectedHandler(() => {
    // A fresh connection supersedes any pending reload (this connect may BE the reloaded daemon).
    // Disarm first, then re-evaluate the daemon we're now talking to.
    disarmDaemonReload();
    checkStaleDaemon();
    if (_automationIntent.size === 0) return;
    for (const [sid, args] of _automationIntent) {
      audiodClient.cmd("automationStart", args || { stationId: sid })
        .then(() => console.log(`[AUDIO] auto-resume: replayed automationStart for station ${sid} on daemon (re)connect`))
        .catch((e) => console.warn(`[AUDIO] auto-resume: replay failed for station ${sid}: ${e && e.message || e}`));
    }
  });

  // Safety net for the recurring silent-wedge (cpal output death) — auto-recovers dead air.
  startAudioLivenessWatchdog();
}

// ── Audio backend decision (daemon vs in-process fallback) ────────────────────
// Decide ONCE at startup: if the daemon is desired, try to bring it up within a timeout; if it
// connects, run on the daemon (AUDIO_DAEMON=true). If it can't be reached, or isn't desired,
// init the in-process engine (today's behavior). audioBackendReady resolves when decided, and
// audio:daemonEnabled awaits it so the renderer never races the choice. This is the safety net
// that makes default-on safe: a broken/missing daemon degrades to the in-process engine rather
// than dead air.
let _resolveBackend;
const audioBackendReady = new Promise((r) => { _resolveBackend = r; });
async function setupAudioBackend() {
  const napSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    if (AUDIO_DAEMON_DESIRED) {
      audiodClient.ensure();   // spawns + connects; the client self-retries on failure (debounced)
      const t0 = Date.now();
      while (!audiodClient.isConnected() && Date.now() - t0 < 5000) { await napSleep(150); }
      if (audiodClient.isConnected()) {
        AUDIO_DAEMON = true;
        console.log("[AUDIO] daemon ACTIVE — out-of-process engine (ether-audiod)");
      } else {
        AUDIO_DAEMON = false;
        console.warn("[AUDIO] daemon unreachable after 5s — FALLING BACK to the in-process engine (no dead air)");
        // Terminal fallback: stop the client's spawn/reconnect loop so it doesn't keep respawning
        // detached daemons in the background (the PID storm) after we've committed to in-process.
        try { audiodClient.stop(); } catch {}
        try { audio.initAudioEngine(); } catch (e) { console.error("[AUDIO] in-process init failed:", e.message); }
      }
    } else {
      try { audio.initAudioEngine(); console.log("[AUDIO] in-process engine (daemon not enabled)"); }
      catch (e) { console.error("[AUDIO] init failed:", e.message); }
    }
  } finally { _resolveBackend(); }
}
// Resolve the canonical DB path ONCE, up front, and publish it to any spawned daemon via env so the
// app and the out-of-process engine ALWAYS open the same database. Critical now that the DB lives on
// local disk: without this the daemon falls back to its legacy Roaming default (ether-audiod.js) and
// diverges from the app. Spawned daemons inherit it through {...process.env} in spawnDaemon().
try { process.env.ETHER_DB_PATH = getDbPath(); }
catch (e) { console.error("[DB] early path resolve failed (initDb will surface it):", e.message); }
setupAudioBackend();

// ── Database ──────────────────────────────────────────────────
let db;
let cloudBackupTrigger = null; // set when cloud-backup module loads

// The local data folder (machine-local; never the redirected Roaming/SMB path — see getDbPath).
function _etherDir() {
  const fs = require("fs");
  let baseDir;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    baseDir = path.join(process.env.LOCALAPPDATA, "Ether");
  } else {
    baseDir = app.getPath("userData");
  }
  const etherDir = path.join(baseDir, "com.ether.radio");
  try { fs.mkdirSync(etherDir, { recursive: true }); }
  catch (e) { throw new Error(`Cannot create local data folder ${etherDir}: ${e.message}`); }
  return etherDir;
}

// ── Account session keys ───────────────────────────────────────────────────────────────────────
// Sign Out / Switch Account clear these so App re-runs the sign-in gate. (The per-account DB-swap
// that used to back "Switch Account" was removed — it made sign-out unreliable. There is ONE
// database per install now; switching accounts = sign out + sign back in on the same DB.)
const ACCOUNT_SESSION_KEYS = [
  "license_key", "license_email", "plan_tier", "account_name", "first_run_complete",
  "onboarding_account_joined", "onboarding_license_entered", "onboarding_library_pulled",
  "onboarding_library_source", "trial_ends_at",
];
// Clear the VALUE (not just a tombstone) across ALL stations — App.tsx's first-run check reads
// get('first_run_complete')==="1" off the value, so a value left in place keeps showing the
// profile/PIN screen instead of the account sign-in screen.
function _clearAccountSessionKeys() {
  const now = new Date().toISOString();
  const del = db.prepare("UPDATE station_config_kv SET value = NULL, deleted_at = ?, updated_at = ? WHERE key = ?");
  for (const k of ACCOUNT_SESSION_KEYS) { try { del.run(now, now, k); } catch {} }
}

// Which account's data this DB holds, kept at install level so it SURVIVES the per-station
// account-key clears that File ▸ Switch Account / sign-out do (license_email gets wiped; this
// doesn't). SELF-HEALING: on every startup, set the marker to the CURRENT license_email so it
// can never go stale (e.g. djdeniro left over after signing into jensj on an old build). When
// license_email is absent (just signed out), leave the marker as the last account so the next
// sign-in can still detect a switch.
function _backfillAccountMarker() {
  try {
    const lic = db.prepare("SELECT value FROM station_config_kv WHERE key='license_email' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL LIMIT 1").get();
    if (lic && lic.value) {
      const email = String(lic.value).trim().toLowerCase();
      const cur = db.prepare("SELECT value FROM install_config_kv WHERE key='account_email' AND deleted_at IS NULL").get();
      if (cur && cur.value === email) return; // already correct
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO install_config_kv (key, value, uuid, created_at, updated_at) VALUES ('account_email', ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, deleted_at=NULL"
      ).run(email, require("crypto").randomUUID(), now, now);
      console.log("[account] synced account_email marker →", email);
    }
  } catch (e) { console.error("[account] backfill marker:", e.message); }
}

// File ▸ Sign Out / Switch Account — run ENTIRELY in the main process (native dialog + relaunch).
// The renderer's window.confirm silently no-ops in this packaged build (Electron 41), which is why
// the menu items "did nothing". Clears the per-station account/onboarding keys so App re-runs the
// sign-in gate; leaves the install-level account marker + local station data intact (the per-account
// detection relies on the marker). `switching` only changes the wording.
function accountSignOut(switching) {
  try {
    const { dialog } = require("electron");
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question", noLink: true, defaultId: 1, cancelId: 0,
      buttons: ["Cancel", switching ? "Switch Account" : "Sign Out"],
      title: switching ? "Switch Account" : "Sign Out",
      message: switching ? "Switch to a different account?" : "Sign out of this account?",
      detail: "Returns to the sign-in screen, where you can sign in as a different account. This computer's local station data is left in place.",
    });
    if (choice !== 1) return;
    try { _clearAccountSessionKeys(); }
    catch (e) { console.error("[account] sign-out clear:", e.message); }
    try { _persistOnAir(false); } catch {}  // explicit sign-out → next launch requires sign-in
    try { markHaExpectedRestart(); } catch {}
    app.relaunch();
    app.exit(0);
  } catch (e) { console.error("[accountSignOut]", e.message); }
}

function getDbPath() {
  // The DB MUST live on LOCAL disk. Managed/OV profiles redirect Roaming AppData (the legacy
  // app.getPath("appData") location) to a network H:\ share, where SQLite's WAL shared-memory
  // (-shm mmap) is unsupported → new Database()/WAL throws and the app dies before its window.
  // %LOCALAPPDATA% is machine-local and not part of the usual folder-redirection set.
  const fs = require("fs");
  const etherDir = _etherDir();
  // ONE database per install. The per-account DB-swap experiment was removed (it made sign-out
  // unreliable — it cleared the login flag in one DB but reopened another). Safety net: if a prior
  // build stranded the active data in a keyed openair__<hash>.db and there's no default file, reclaim
  // the newest keyed file as the single DB so no data is lost, and drop the stale account pointer.
  const localDb = path.join(etherDir, "openair.db");
  try {
    if (!fs.existsSync(localDb)) {
      const keyed = fs.readdirSync(etherDir)
        .filter((f) => /^openair__[0-9a-f]+\.db$/.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(etherDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (keyed.length) {
        const src = path.join(etherDir, keyed[0].f);
        for (const sfx of ["", "-wal", "-shm", "-journal"]) {
          if (fs.existsSync(src + sfx)) fs.renameSync(src + sfx, localDb + sfx);
        }
        console.log("[DB] reclaimed per-account DB → single DB:", keyed[0].f);
      }
    }
    fs.rmSync(path.join(etherDir, "active-account"), { force: true });
  } catch (e) { console.warn("[DB] per-account reclaim skipped:", e.message); }

  // One-time migration from the legacy Roaming location (the redirected/SMB path on managed
  // profiles) so existing installs keep their library/config. Crash-safe: copy the WAL sidecars
  // first, then the main file LAST via temp+rename, so a partial copy never leaves a half-migrated
  // DB that the existsSync() guard would treat as complete. Copy (not move) — the legacy file stays
  // as a backup. Best-effort: any failure just falls through to a fresh local DB.
  try {
    if (!fs.existsSync(localDb)) {
      const legacyDb = path.join(app.getPath("appData"), "com.ether.radio", "openair.db");
      if (legacyDb !== localDb && fs.existsSync(legacyDb)) {
        for (const suffix of ["-wal", "-journal"]) {
          const src = legacyDb + suffix;
          if (fs.existsSync(src)) fs.copyFileSync(src, localDb + suffix);
        }
        const tmp = localDb + ".migrating";
        fs.copyFileSync(legacyDb, tmp);
        fs.renameSync(tmp, localDb);
        console.log("[DB] migrated legacy Roaming DB → local disk:", legacyDb, "→", localDb);
      }
    }
  } catch (e) { console.warn("[DB] legacy DB migration skipped (using fresh local DB):", e.message); }

  return localDb;
}

function initDb() {
  const dbPath = getDbPath();
  console.log("[DB] Path:", dbPath);
  // Defensive: guarantee the parent folder exists at the open site too. getDbPath()/_etherDir()
  // already creates it, but this also covers an ETHER_DB_PATH override pointing elsewhere. SQLite
  // throws SQLITE_CANTOPEN if the directory is missing (fresh-install crash).
  try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {}
  try { db = new Database(dbPath); }
  catch (e) { throw new Error(`Cannot open database ${dbPath}: ${e.message}`); }
  db.pragma("journal_mode = WAL");   // WAL is safe now that the DB is guaranteed local disk
  db.pragma("foreign_keys = ON");
  console.log("[DB] Connected:", dbPath);
  runMigrations();
  seedDeckConfigs();
  setTimeout(() => { try { console.log("[DB] Song count:", db.prepare("SELECT COUNT(*) as c FROM songs").get()); } catch(e) { console.log("[DB] Song count error:", e.message); } }, 500);
}

function runMigrationChain(db) {
  const applied = new Set(
    db.prepare("SELECT version FROM schema_version").all().map(r => r.version)
  );
  const MIGRATION_RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const scriptsDir = path.join(__dirname, '..', 'scripts');
  const scripts = [];
  for (const f of require('fs').readdirSync(scriptsDir)) {
    const m = MIGRATION_RE.exec(f);
    if (m) scripts.push({ v: parseInt(m[1], 10), file: f });
  }
  scripts.sort((a, b) => a.v - b.v);
  for (const { v, file } of scripts) {
    if (applied.has(v)) continue;
    require(path.join(scriptsDir, file)).applyMigration(db);
  }
}

function runMigrations() {
  const schemaVersionExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();
  const isFreshInstall = !schemaVersionExists ||
    !db.prepare("SELECT 1 FROM schema_version LIMIT 1").get();

  require('../scripts/schema-v0-baseline')(db);

  // Add any missing columns via ALTER TABLE (safe to re-run)
  const alterSafe = (sql) => { try { db.exec(sql); } catch(e) { /* column already exists */ } };
  alterSafe("ALTER TABLE songs ADD COLUMN is_explicit INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE songs ADD COLUMN raw_metadata TEXT");
  // Fix songs that aren't eligible to play in any (daytime) hour: daypart_mask = 127 is the old
  // default (only hours 0-6), and NULL (e.g. from a cloud-restored/synced library) means eligible
  // for NO hours at all — both make the scheduler generate nothing during the day. Normalize both
  // to 16777215 (all 24 hours) so Generate always has candidates. See _generateDayRows.
  db.exec("UPDATE songs SET daypart_mask = 16777215 WHERE daypart_mask = 127 OR daypart_mask IS NULL");
  alterSafe("ALTER TABLE songs ADD COLUMN daypart_mask INTEGER DEFAULT 127");
  alterSafe("ALTER TABLE songs ADD COLUMN no_repeat_hours INTEGER DEFAULT 2");
  alterSafe("ALTER TABLE songs ADD COLUMN rotation_status TEXT DEFAULT 'active'");
  alterSafe("ALTER TABLE songs ADD COLUMN intro_version_path TEXT");
  alterSafe("ALTER TABLE songs ADD COLUMN has_intro INTEGER DEFAULT 0");
  // These three live in the v0 baseline but had NO alterSafe — so a DB created by an older baseline
  // (or carried forward from an old install) lacked them, and migrate-library-phase-sync-4 (v4) does
  // `SELECT energy, last_played_at, play_count FROM songs` → "no such column: energy" on init (OV, 4.3.33).
  alterSafe("ALTER TABLE songs ADD COLUMN energy REAL");
  alterSafe("ALTER TABLE songs ADD COLUMN last_played_at INTEGER");
  alterSafe("ALTER TABLE songs ADD COLUMN play_count INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE clocks ADD COLUMN show_id INTEGER");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN chain_type TEXT DEFAULT 'segue'");
  alterSafe("ALTER TABLE clock_slots ADD COLUMN chain_type TEXT DEFAULT 'segue'");
  alterSafe("ALTER TABLE clock_slots ADD COLUMN spot_type TEXT");   // spot_break slots pull from spots WHERE spot_type = this (NULL = any active spot)
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN overflow INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN fade_out_at_ms INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN fade_duration_ms INTEGER DEFAULT 8000");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN category_code TEXT");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN slot_type TEXT");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN song_title TEXT");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN song_artist TEXT");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN category_color TEXT");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN label TEXT");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN status TEXT");
  alterSafe("ALTER TABLE spots ADD COLUMN isci_code TEXT");
  alterSafe("ALTER TABLE spots ADD COLUMN cart_number TEXT");
  alterSafe("ALTER TABLE spots ADD COLUMN agency TEXT");
  alterSafe("ALTER TABLE spots ADD COLUMN length_sec INTEGER");
  alterSafe("ALTER TABLE play_log ADD COLUMN scheduled_log_id INTEGER");
  alterSafe("ALTER TABLE play_log ADD COLUMN show_name TEXT");
  alterSafe("ALTER TABLE play_log ADD COLUMN category_code TEXT");
  alterSafe("ALTER TABLE play_log ADD COLUMN programming_row_id INTEGER");
  alterSafe("ALTER TABLE clocks ADD COLUMN description TEXT");
  alterSafe("ALTER TABLE clocks ADD COLUMN color TEXT");
  alterSafe("ALTER TABLE shows ADD COLUMN clock_id INTEGER REFERENCES clocks(id)");
  alterSafe("ALTER TABLE play_log ADD COLUMN deck_id TEXT");
  alterSafe("ALTER TABLE play_log ADD COLUMN session_id TEXT");
  alterSafe("ALTER TABLE play_log ADD COLUMN file_path TEXT");   // v19: affidavit join key
  alterSafe("ALTER TABLE generated_schedule ADD COLUMN file_path TEXT");   // voice-track placement: direct file for non-song elements
  alterSafe("ALTER TABLE artists ADD COLUMN gender TEXT DEFAULT 'unknown'");

  // Part 1 — deck purpose (controls mode-based visibility)
  alterSafe("ALTER TABLE deck_configs ADD COLUMN purpose TEXT DEFAULT ''");
  // Part 7 — per-operator theme + station logo
  alterSafe("ALTER TABLE operators ADD COLUMN theme TEXT DEFAULT NULL");
  // Part 8 — Spotify URI on songs
  alterSafe("ALTER TABLE songs ADD COLUMN spotify_uri TEXT DEFAULT NULL");
  // Format clock columns missing from early migration (slots → slots_json + daypart)
  alterSafe("ALTER TABLE format_clocks ADD COLUMN daypart TEXT NOT NULL DEFAULT 'Morning Drive'");
  alterSafe("ALTER TABLE format_clocks ADD COLUMN slots_json TEXT NOT NULL DEFAULT '[]'");
  // crash_recovery columns added after initial schema
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN queue_json TEXT DEFAULT '[]'");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_path TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_title TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_artist TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_position INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN was_playing INTEGER DEFAULT 0");
  // eas_tests: add station_id for existing installs (fresh installs get it from CREATE TABLE above)
  alterSafe("ALTER TABLE eas_tests ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1");
  // midi_mappings: add station_id for existing installs
  alterSafe("ALTER TABLE midi_mappings ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1");
  // ai_voice_segments: add station_id for existing installs
  alterSafe("ALTER TABLE ai_voice_segments ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1");
  // users (console profiles): scope per-station — account ⊃ station ⊃ profile.
  // Existing profiles backfill to station 1 (the owner's original station); a
  // newly-created station starts with an empty roster → UserLogin shows setup.
  alterSafe("ALTER TABLE users ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1");

  // EQ settings stored in station_config_kv with keys eq_deck_A, eq_deck_B, eq_deck_C, eq_deck_mic, eq_master
  // operators and operator_notes are in schema-v0-baseline.js (moved in Step 6)

  // ── Phase 1: Multi-station schema ────────────────────────────
  // Add Icecast columns to stations table
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_server_url TEXT DEFAULT '44.244.52.207'");
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_mount TEXT DEFAULT '/live'");
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_password TEXT DEFAULT 'hackme'");
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_bitrate INTEGER DEFAULT 128");
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_format TEXT DEFAULT 'mp3'");

  // Account ownership: each station records the license_key of the account that created it.
  // NOTE: this column is recorded but NOT currently enforced at the list layer — `stations:list`
  // and `:get-active` (see handlers below) return ALL local non-deleted rows regardless of
  // owner_license_key / the signed-in account. License-scoped visibility is intentionally
  // deferred to the v4.5 account-vs-license rework (stations are license-owned, not
  // account-owned, in both client and backend today). See docs/account-license-architecture-v4.5.md.
  // Nullable + backfilled below; orphan rows (no owner) are NOT deleted.
  alterSafe("ALTER TABLE stations ADD COLUMN owner_license_key TEXT");
  // One-time idempotent backfill: adopt the per-station KV license_key that older builds wrote.
  // Only fills NULLs, so it is safe to re-run on every startup. Stations with no per-station
  // license_key remain NULL (orphan → hidden).
  try {
    db.exec(`
      UPDATE stations SET owner_license_key = (
        SELECT k.value FROM station_config_kv k
        WHERE k.station_id = stations.id AND k.key='license_key'
          AND k.deleted_at IS NULL AND k.value IS NOT NULL AND k.value != ''
      )
      WHERE owner_license_key IS NULL
        AND EXISTS (
          SELECT 1 FROM station_config_kv k
          WHERE k.station_id = stations.id AND k.key='license_key'
            AND k.deleted_at IS NULL AND k.value IS NOT NULL AND k.value != ''
        )
    `);
  } catch (e) { console.error("[account] station owner backfill:", e.message); }

  // Ensure station 1 Icecast columns are filled if they were just added and are empty
  {
    const s1 = db.prepare("SELECT * FROM stations WHERE id=1").get();
    if (s1 && !s1.icecast_server_url) {
      const serverKv = db.prepare("SELECT value FROM station_config_kv WHERE key='playout_server'").get();
      const pwKv     = db.prepare("SELECT value FROM station_config_kv WHERE key='icecast_source_password'").get();
      db.prepare(
        "UPDATE stations SET icecast_server_url=?, icecast_mount='/live', icecast_password=? WHERE id=1"
      ).run(serverKv?.value?.trim() || '44.244.52.207', pwKv?.value?.trim() || 'hackme');
    }
  }

  // Phase 3.5 Commit 1: add uuid + timestamp columns to ONLY
  // the synced tables this commit's INSERTs actually touch.
  // The remaining synced tables get the same treatment in
  // a dedicated Commit 2 ("Phase Sync-1: complete sync
  // column rollout"), aligned with the v8 plan's intent.
  const uuidNeededNow = [
    'announcements', 'artists', 'cart_slots', 'categories',
    'clocks', 'liner_cards', 'macros', 'operators',
    'pinned_songs', 'play_log', 'prep_notes', 'scheduled_log',
    'spots',
  ];
  for (const tbl of uuidNeededNow) {
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN uuid TEXT`);
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN created_at TEXT`);
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN updated_at TEXT`);
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN deleted_at TEXT`);
  }

  // Add station_id to all station-scoped tables (songs excluded — install-scoped, column dropped in v12)
  const stationTables = [
    'artists', 'albums', 'categories', 'separation_rules',
    'clocks', 'clock_slots', 'shows', 'play_log', 'scheduled_log',
    'spots', 'cart_slots', 'announcements', 'voice_tracks',
    'smart_schedule_rules', 'liner_cards', 'prep_notes',
    'published_episodes', 'format_clocks', 'generated_schedule',
    'operators', 'operator_notes', 'deck_configs',
    'macros', 'rtmp_destinations',
  ];
  for (const tbl of stationTables) {
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1`);
  }

  // Recreate station_config_kv with composite PK (station_id, key) — idempotent
  const kvcols = db.prepare("PRAGMA table_info(station_config_kv)").all();
  const kvHasStationId = kvcols.some(c => c.name === 'station_id');
  if (!kvHasStationId) {
    const oldRows = db.prepare("SELECT key, value FROM station_config_kv").all();
    db.exec(`
      ALTER TABLE station_config_kv RENAME TO _station_config_kv_old;
      CREATE TABLE station_config_kv (
        station_id INTEGER NOT NULL DEFAULT 0,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (station_id, key)
      );
    `);
    const ins = db.prepare("INSERT OR IGNORE INTO station_config_kv (station_id, key, value) VALUES (?, ?, ?)");
    const migrate = db.transaction(() => {
      for (const row of oldRows) ins.run(0, row.key, row.value);
    });
    migrate();
    db.exec("DROP TABLE _station_config_kv_old");
    console.log("[DB] Migrated station_config_kv to composite PK (station_id, key)");
  }

  // station_config_kv uuid + timestamp columns — must run AFTER the recreation block
  // above, since that block creates a fresh table without these columns.
  alterSafe('ALTER TABLE station_config_kv ADD COLUMN uuid TEXT');
  alterSafe('ALTER TABLE station_config_kv ADD COLUMN created_at TEXT');
  alterSafe('ALTER TABLE station_config_kv ADD COLUMN updated_at TEXT');
  alterSafe('ALTER TABLE station_config_kv ADD COLUMN deleted_at TEXT');

  // Station-scope index for eas_tests (idempotent)
  db.exec("CREATE INDEX IF NOT EXISTS idx_eas_tests_station_id ON eas_tests(station_id)");
  // Station-scope index for midi_mappings (idempotent)
  db.exec("CREATE INDEX IF NOT EXISTS idx_midi_mappings_station_id ON midi_mappings(station_id)");
  // Station-scope index for ai_voice_segments (idempotent)
  db.exec("CREATE INDEX IF NOT EXISTS idx_ai_voice_segments_station_id ON ai_voice_segments(station_id)");

  // FTS index for song search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(title, artist);
    CREATE TRIGGER IF NOT EXISTS trg_songs_fts_insert AFTER INSERT ON songs BEGIN
      INSERT INTO songs_fts(rowid, title, artist) SELECT NEW.id, NEW.title, a.name FROM artists a WHERE a.id = NEW.artist_id;
    END;
  `);
  // Migrate delete trigger to fire on soft-delete (UPDATE deleted_at NULL→non-NULL)
  // rather than hard DELETE, because songsDelete uses UPDATE. The DROP+CREATE is
  // idempotent — safe to run on every startup to pick up the new form.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_songs_fts_delete;
    CREATE TRIGGER trg_songs_fts_delete
      AFTER UPDATE OF deleted_at ON songs
      WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    BEGIN
      DELETE FROM songs_fts WHERE rowid = OLD.id;
    END;
  `);

  // FTS update trigger: keep search index in sync when title or artist changes.
  // DROP+CREATE is idempotent — safe every boot.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_songs_fts_update;
    CREATE TRIGGER trg_songs_fts_update
      AFTER UPDATE OF title, artist_id ON songs
      WHEN NEW.deleted_at IS NULL
    BEGIN
      DELETE FROM songs_fts WHERE rowid = OLD.id;
      INSERT INTO songs_fts(rowid, title, artist)
        SELECT NEW.id, NEW.title, a.name FROM artists a WHERE a.id = NEW.artist_id;
    END;
  `);

  // Phase 3.5 FTS fix: convert songs_fts from external-content to standalone if needed.
  // External-content mode (content='songs') caused FTS5 to auto-generate
  // SELECT T.title, T.artist FROM songs AS T on DELETE, failing because songs has
  // artist_id not artist — rolling back every songsDelete transaction silently.
  // Idempotent: only rebuilds when the current definition still contains content='songs'.
  {
    const ftsRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='songs_fts'"
    ).get();
    if (ftsRow && ftsRow.sql && ftsRow.sql.includes("content='songs'")) {
      console.log("[DB] Migrating songs_fts: external-content → standalone (phase-3.5 fix)");
      db.exec(`
        DROP TABLE IF EXISTS songs_fts;
        CREATE VIRTUAL TABLE songs_fts USING fts5(title, artist);
        INSERT INTO songs_fts(rowid, title, artist)
          SELECT s.id, s.title, COALESCE(a.name, '')
          FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
          WHERE s.deleted_at IS NULL;
      `);
      const { c } = db.prepare("SELECT COUNT(*) as c FROM songs_fts").get();
      console.log("[DB] songs_fts rebuilt as standalone —", c, "rows indexed");
    }
  }

  // Enable all 6 deck slots — Apply Layout was broken in Phase 3b, so existing
  // installs may have D/E/F stuck at disabled. Re-enable them so all 6 show.
  db.exec("UPDATE deck_configs SET enabled=1 WHERE slot IN ('D','E','F')");

  // Seed bare station 1 before chain so migration-6's seeding loop has a station to bind to
  if (isFreshInstall) {
    const stationCount = db.prepare("SELECT COUNT(*) as c FROM stations").get().c;
    if (stationCount === 0) {
      db.prepare("INSERT INTO stations (name) VALUES (?)").run('Station 1');
    }
  }

  runMigrationChain(db);

  if (isFreshInstall) seedFreshInstall();

  console.log("[DB] Schema ready");

  const maxVer = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  if (maxVer?.v) {
    db.prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('schema_version', ?, unixepoch())").run(String(maxVer.v));
  }
}

// ── Fresh-install seeder ──────────────────────────────────────
// Business data only — no schema. All blocks are count-guarded so this is
// safe to call unconditionally (no-ops on existing installs).
// Called from runMigrations(); conditional guard (isFreshInstall) added in Step 6.
function seedFreshInstall() {
  db.exec("INSERT OR IGNORE INTO crash_recovery (id) VALUES (1)");

  // No default users are seeded anymore. A fresh install starts with 0 users so the
  // first-run PIN/profile setup (UserLogin) lets the first person name their profile and
  // set their own PIN — instead of preset Admin/Jock/MD profiles with a shared default PIN.

  db.prepare("INSERT OR IGNORE INTO station_config_kv (key, value) VALUES ('multistation_insert_audit_complete', 'true')").run();

  const stationCount = db.prepare("SELECT COUNT(*) as c FROM stations").get();
  if (stationCount.c === 0) {
    const serverKv = db.prepare("SELECT value FROM station_config_kv WHERE key='playout_server'").get();
    const pwKv     = db.prepare("SELECT value FROM station_config_kv WHERE key='icecast_source_password'").get();
    const nameKv   = db.prepare("SELECT value FROM station_config_kv WHERE key='station_name'").get();
    db.prepare(
      "INSERT INTO stations (id, name, callsign, is_active, icecast_server_url, icecast_mount, icecast_password, icecast_bitrate, icecast_format) VALUES (1, ?, '', 1, ?, '/live', ?, 128, 'mp3')"
    ).run(nameKv?.value || 'Station 1', serverKv?.value?.trim() || '44.244.52.207', pwKv?.value?.trim() || 'hackme');
    console.log("[DB] Seeded station 1");
  }

  const ruleCount = db.prepare("SELECT COUNT(*) as c FROM separation_rules").get();
  if (ruleCount.c === 0) {
    const sid = getActiveStationId();
    const insertRule = db.prepare(
      "INSERT INTO separation_rules (station_id, rule_type, scope, value, is_hard, is_active, description) VALUES (?,?,?,?,?,?,?)"
    );
    const seedRules = db.transaction(() => {
      insertRule.run(sid, 'artist_separation_min', 'global', 60,  1, 1, 'Minimum minutes between songs by the same artist');
      insertRule.run(sid, 'song_separation_min',   'global', 180, 1, 1, 'Minimum minutes before a song can repeat');
      insertRule.run(sid, 'title_separation_min',  'global', 120, 1, 1, 'Minimum minutes between songs with the same title');
      insertRule.run(sid, 'max_same_gender',        'global', 3,   0, 1, 'Max consecutive songs of the same gender');
      insertRule.run(sid, 'max_same_category',      'global', 3,   0, 1, 'Max consecutive songs from the same category');
    });
    seedRules();
    console.log("[DB] Seeded default separation rules for station", sid);
  }
}

// ── Active station helper ─────────────────────────────────────
function getActiveStationId() {
  try {
    const row = db.prepare("SELECT id FROM stations WHERE is_active=1 LIMIT 1").get();
    return row?.id ?? 1;
  } catch { return 1; }
}

// ── Account-scoped station ownership ───────────────────────────
// Mirror of src/lib/slug.ts slugify — turns a station name into a URL-safe slug used as the default
// Icecast mount (e.g. "OV" → "ov", "All Day Safe Park Music" → "all-day-safe-park-music"). Each
// station's mount must be unique on the shared Icecast server; deriving it from the name auto-fills
// a sensible per-station mount instead of the old shared '/live' placeholder.
function _slugifyName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}


// ── Deck config seeder ────────────────────────────────────────
// Deck slots A-F are defined HERE, in the database, on every startup.
// Do NOT hardcode deck slot lists in any React component or UI file.
// UI code reads from this table; it never defines which slots exist.
function seedDeckConfigs() {
  const defaults = [
    { slot: "A", type: "music", label: "Deck A", color: "#34d399", enabled: 1 },
    { slot: "B", type: "music", label: "Deck B", color: "#38bdf8", enabled: 1 },
    { slot: "C", type: "music", label: "Deck C", color: "#a78bfa", enabled: 1 },
    { slot: "D", type: "music", label: "Deck D", color: "#f97316", enabled: 0 },
    { slot: "E", type: "music", label: "Deck E", color: "#ef4444", enabled: 0 },
    { slot: "F", type: "guest", label: "Guest 2", color: "#a78bfa", enabled: 0 },
  ];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO deck_configs (slot, type, label, color, enabled) VALUES (?, ?, ?, ?, ?)"
  );
  const seed = db.transaction((decks) => {
    for (const d of decks) insert.run(d.slot, d.type, d.label, d.color, d.enabled);
  });
  seed(defaults);
  // Fix any D/E/F rows incorrectly seeded as enabled=1 by pre-AUX code
  db.prepare("UPDATE deck_configs SET enabled=0 WHERE slot IN ('D','E','F') AND enabled=1").run();
  const { c } = db.prepare("SELECT COUNT(*) as c FROM deck_configs").get();
  console.log(`[DeckGuard] ✓ deck_configs: ${c}/6 slots present — A B C D E F guaranteed in database`);
}

// ── Window ────────────────────────────────────────────────────
let mainWindow;
let splashWindow;
let tray;

const ICON_PNG   = path.join(__dirname, "assets/icon.png");
const ICON_ICO   = path.join(__dirname, "assets/icon.ico");
// Windows needs a multi-size .ico for the taskbar button (a PNG is honored for the title bar
// but the taskbar falls back to electron.exe's icon → the Electron logo in dev). Other platforms
// use the PNG.
const WINDOW_ICON = process.platform === "win32" ? ICON_ICO : ICON_PNG;
const TRAY_PNG   = path.join(__dirname, "assets/tray-icon.png");

// Push a REAL load-status line to the splash window (no-op once it's gone).
function splashStatus(msg) {
  try {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send("splash:status", msg);
    }
  } catch { /* splash already closed */ }
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width:         820,
    height:        480,
    frame:         false,
    transparent:   true,
    alwaysOnTop:   true,
    center:        true,
    resizable:      false,
    skipTaskbar:    true,
    roundedCorners: true,
    show:           false,       // hidden until centered
    webPreferences: {
      preload:          path.join(__dirname, "splash-preload.js"),
      nodeIntegration:  false,
      contextIsolation: true,
      webSecurity:      false,   // allow file:// assets (svg, png) in local HTML
    },
  });

  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.once("ready-to-show", () => {
    splashWindow.center();
    splashWindow.show();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "EtherCast",
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // Allow localhost in dev
    },
    show: false,
  });

  // Allow localhost connections
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"]
      }
    });
  });

  // Load app with retry for dev server
  if (isDev) {
    const tryLoad = () => {
      const net = require("net");
      const client = new net.Socket();
      client.setTimeout(1000);
      client.connect(1420, "127.0.0.1", () => {
        client.destroy();
        mainWindow.loadURL(VITE_DEV_URL);
        if (!app.isPackaged) {
          mainWindow.webContents.openDevTools();
        }
      });
      client.on("error", () => {
        client.destroy();
        console.log("[ELECTRON] Vite not ready, retrying in 1s...");
        setTimeout(tryLoad, 1000);
      });
      client.on("timeout", () => {
        client.destroy();
        setTimeout(tryLoad, 1000);
      });
    };
    setTimeout(tryLoad, 500);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Do NOT show here — startup timing is controlled in app.whenReady()
  // mainWindow stays hidden (show: false) until the splash finishes.

  // If the renderer fails to load, force-show so the user sees something instead of nothing
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logStartup(`did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.setOpacity(1);
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Closing the window is a DECISION, not a silent tray-hide. The old behavior (vanish to tray,
  // keep running + on air) left operators thinking Ether had quit while it kept eating resources
  // and there was no obvious way to actually stop it. Make the choice explicit.
  mainWindow.on("close", (e) => {
    if (app.isQuitting) return;   // a real quit is already in progress → let it close
    e.preventDefault();
    const onAir = _isOnAir();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: "question",
      buttons: ["Keep Playing in Tray", "Stop & Quit Ether", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: "Close Ether",
      message: onAir ? "Ether is on air." : "Close Ether?",
      detail:
        "Keep Playing in Tray — close this window; audio keeps streaming in the background (find Ether in the system tray).\n\n" +
        "Stop & Quit Ether — stop automation and the stream, shut the audio engine down, and exit completely. It won't auto-restart.",
    });
    if (choice === 0) mainWindow.hide();
    else if (choice === 1) fullStopAndQuit();
    // choice === 2 (Cancel) → stay open, do nothing
  });

  // Grant mic/camera permissions — both layers required for packaged (file://) builds.
  // setPermissionCheckHandler is the synchronous pre-check Chromium calls before
  // setPermissionRequestHandler; without it, getUserMedia fails on file:// origins
  // (packaged exe) because Chromium has no built-in trust rule for non-http origins.
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === "media" || permission === "microphone" || permission === "camera" ||
        permission === "audioCapture" || permission === "videoCapture") {
      return true;
    }
    return true; // allow everything else too
  });

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "microphone" || permission === "audioCapture") {
      callback(true); // Always grant
    } else {
      callback(true);
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_PNG).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: "Show Ether", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" },
    { label: "Stop Keeping On Air…", click: () => {
        const c = dialog.showMessageBoxSync({
          type: "warning", buttons: ["Stop Keeping On Air", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
          title: "Stop Keeping On Air",
          message: "Stop auto-restart for this session?",
          detail: "The on-air watchdog will be stopped, so Ether won't relaunch if it closes or is force-killed — useful when you need to fully shut down (e.g. the system is under load). Re-opening Ether restores it.",
        });
        if (c === 0) pauseKeepOnAir();
      } },
    { label: "Quit Ether", click: () => fullStopAndQuit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip("Ether — On Air");
  tray.on("click", () => {
    if (mainWindow.isVisible()) { mainWindow.hide(); }
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

// ── App lifecycle ─────────────────────────────────────────────
function buildMenu() {
  const send = (cmd) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win) win.webContents.send("menu-action", cmd);
  };
  const popout = (panel) => {
    // Re-use the same handler logic as the IPC "window:popout" handler
    const tag = `popout:${panel}`;
    const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === tag);
    if (existing) { existing.show(); existing.focus(); return; }
    const { screen } = require("electron");
    const size = POPOUT_SIZES[panel] || { width: 640, height: 520 };
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const secondary = displays.find(d => d.id !== primary.id);
    const x = secondary ? secondary.workArea.x + 60 : undefined;
    const y = secondary ? secondary.workArea.y + 60 : undefined;
    const win = new BrowserWindow({
      width: size.width, height: size.height,
      minWidth: 320, minHeight: 200, x, y,
      title: tag, frame: false, transparent: false,
      backgroundColor: "#0e0e14", resizable: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, nodeIntegration: false, webSecurity: false,
      },
    });
    if (isDev) win.loadURL(VITE_DEV_URL + `#popout/${panel}`);
    else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: `popout/${panel}` });
  };
  // Cloud account actions need an account — the free/solo tier has none, so Switch Account
  // is greyed there. Read the live plan at build time; menu:rebuild refreshes it on change.
  let planTier = 'free';
  try { planTier = (db.prepare("SELECT value FROM station_config_kv WHERE key='plan_tier' LIMIT 1").get())?.value || 'free'; } catch {}
  const hasAccount = planTier !== 'free';
  const template = [
    { label: "File", submenu: [
      { label: "New Session", accelerator: "CmdOrCtrl+N", click: () => send("file:new-session") },
      { label: "Save Layout", accelerator: "CmdOrCtrl+S", click: () => send("file:save") },
      { type: "separator" },
      { label: "Import Music...", click: () => send("file:import") },
      { label: "Preferences", click: () => send("file:preferences") },
      { type: "separator" },
      { label: "Sign Out", click: () => accountSignOut(false) },
      { label: "Switch Account…", click: () => accountSignOut(true) },
      { type: "separator" },
      { label: "Quit Ether", accelerator: "CmdOrCtrl+Q", click: () => fullStopAndQuit() },
    ]},
    { label: "View", submenu: [
      { label: "Play Queue", click: () => send("view:queue") },
      { label: "Deck A", click: () => send("view:deckA") },
      { label: "Deck B", click: () => send("view:deckB") },
      { label: "Deck C", click: () => send("view:deckC") },
      { label: "Mic Deck", click: () => send("view:mic") },
      { type: "separator" },
      { label: "Configure Decks...", click: () => send("view:configure-decks") },
      { label: "Reset to Default", click: () => send("view:reset") },
      { type: "separator" },
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.webContents.reload() },
      { label: "Toggle DevTools", accelerator: "F12", click: () => mainWindow?.webContents.toggleDevTools() },
    ]},
    { label: "Library", submenu: [
      { label: "Song Library", click: () => send("nav:library") },
      { label: "Spots & Promos", click: () => send("nav:spots") },
      { label: "Voice Tracker", click: () => send("nav:voicetrack") },
      { type: "separator" },
      { label: "Import from Folder...", click: () => send("file:import") },
      { label: "Cue Editor", click: () => send("nav:trackedit") },
    ]},
    { label: "Schedule", submenu: [
      { label: "Clocks",           click: () => { send("nav:clocks"); send("nav:scheduler-tab:clocks"); } },
      { label: "Shows & Dayparts", click: () => { send("nav:clocks"); send("nav:scheduler-tab:shows"); } },
      { label: "Categories",       click: () => { send("nav:clocks"); send("nav:scheduler-tab:categories"); } },
      { type: "separator" },
      { label: "Program Log",      click: () => send("nav:programlog") },
      { label: "Play Log",         click: () => send("nav:logs") },
      { label: "Announcements",    click: () => send("nav:announce") },
      { label: "EAS Logbook",     click: () => send("nav:eas") },
    ]},
    { label: "Tools", submenu: [
      { label: "Voice Tracker", click: () => send("nav:voicetrack") },
      { label: "Show+ DAW", click: () => send("nav:studio") },
      { label: "Show+",  click: () => send("nav:videostudio") },
      { label: "Cue Editor", click: () => send("nav:trackedit") },
      { label: "Clip Editor", click: () => send("nav:clipeditor") },
      { type: "separator" },
      { label: "Import Library...", click: () => send("nav:importlibrary") },
      { type: "separator" },
      { label: "Stream Manager", click: () => send("nav:streaming") },
      { label: "Smart Scheduler", click: () => send("nav:smartschedule") },
      { label: "Listener Analytics", click: () => send("nav:analytics") },
      { label: "Cloud Log Backup",   click: () => send("nav:cloudbackup") },
      { label: "Audio Routing", click: () => send("nav:multioutput") },
      { label: "Station Manager", click: () => send("nav:stationmanager") },
      { type: "separator" },
      { label: "System Health", click: () => send("nav:health") },
      { type: "separator" },
      { label: "Monitors", submenu: [
        { label: "Decks",          click: () => popout("decks") },
        { label: "Show+",   click: () => popout("videostudio") },
        { label: "Camera",         click: () => popout("camera") },
        { label: "Queue / Up Next",click: () => popout("upnext") },
        { label: "Station Health", click: () => popout("health") },
        { type: "separator" },
        { label: "Mic",            click: () => popout("mic") },
        { label: "Master Output",  click: () => popout("master") },
        { label: "Phone Desk",     click: () => popout("phone") },
        { label: "Voice Tracker",  click: () => popout("voicetrack") },
      ]},
    ]},
    { label: "Help", submenu: [
      { label: "Keyboard Shortcuts", click: () => send("help:shortcuts") },
      { label: "Documentation", click: () => shell.openExternal("https://github.com/jwjens/ether") },
      { type: "separator" },
      { label: "Check for Updates", click: () => send("help:check-updates") },
      { label: "About Ether", click: () => send("nav:about") },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Rebuild the native menu (e.g. after the plan tier changes) so Switch Account's
// enabled/greyed state stays correct without an app restart.
ipcMain.handle('menu:rebuild', () => { try { buildMenu(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

// ── VIP invite file detection ─────────────────────────────────
// Checks for ether-invite.json in the exe dir or resources path.
// Runs once after DB is ready. Deletes the file after reading so it never fires twice.
let _inviteUsed = false;
let _invitedBy = "";

function processInviteFile() {
  const searchPaths = [
    path.join(path.dirname(app.getPath("exe")), "ether-invite.json"),
    path.join(process.resourcesPath || "", "ether-invite.json"),
    path.join(app.getAppPath(), "ether-invite.json"),
  ];

  let invitePath = null;
  for (const p of searchPaths) {
    try { if (fs.existsSync(p)) { invitePath = p; break; } } catch {}
  }
  if (!invitePath) return;

  let invite;
  try {
    invite = JSON.parse(fs.readFileSync(invitePath, "utf8"));
  } catch (e) {
    console.error("[Invite] Failed to parse invite file:", e.message);
    return;
  }

  try {
    // Check if first run is already complete
    const inviteStationId = getActiveStationId();
    const existing = db.prepare(
      "SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'first_run_complete' AND deleted_at IS NULL"
    ).get(inviteStationId);
    if (existing && existing.value === "1") {
      console.log("[Invite] First run already complete — skipping invite processing");
      fs.renameSync(invitePath, invitePath + ".used");
      return;
    }

    // Create operator
    const { operatorsEnsureByName } = require('./sync/handlers/operators');
    const { operatorNotesUpsertByOperatorId } = require('./sync/handlers/operator_notes');
    const name = invite.operator_name || "Operator";
    const initials = invite.operator_initials || name.charAt(0);
    const op = operatorsEnsureByName(db, inviteStationId, name, initials);

    if (op && invite.personal_note) {
      operatorNotesUpsertByOperatorId(db, op.id, inviteStationId, invite.personal_note);
    }

    // Pre-seed the experience mode + invite metadata, but DO NOT mark first_run_complete.
    // Account sign-in / sign-up is required for everyone (commit 70ec7f4); writing
    // first_run_complete here skipped OnboardingFlow's auth screen and dropped the operator
    // straight onto the profile/PIN screen. Leaving it unset lets onboarding show sign-in first;
    // the pre-seeded experience_mode still skips that bolted step afterward.
    const { stationConfigKvUpsertByKey } = require('./sync/handlers/station_config_kv');
    const mode = invite.experience_mode || "standard";
    stationConfigKvUpsertByKey(db, inviteStationId, 'experience_mode', mode);
    stationConfigKvUpsertByKey(db, inviteStationId, 'invite_used', '1');
    stationConfigKvUpsertByKey(db, inviteStationId, 'invited_by', invite.invited_by || "Deniro");

    _inviteUsed = true;
    _invitedBy = invite.invited_by || "Deniro";

    console.log(`[Invite] ✓ Processed invite for ${name} (invited by ${_invitedBy})`);

    // Rename so it never runs again
    fs.renameSync(invitePath, invitePath + ".used");
  } catch (e) {
    console.error("[Invite] Error processing invite:", e.message);
  }
}

// Module-level handle so before-quit can clear it
let levelPushId = null;

app.whenReady().then(() => {
  // initDb() opens SQLite (better-sqlite3, synchronous) + runs migrations. On a managed/OV profile
  // with redirected (network/SMB) AppData this can THROW — WAL's shared-memory (-shm mmap) is
  // unsupported on SMB, and open/mkdir can be denied. An uncaught throw here aborts this ENTIRE
  // whenReady callback BEFORE createWindow(), so the app runs windowless and looks hung (the exact
  // OV failure). Guard it: surface a visible error and exit cleanly — never vanish silently.
  try {
    initDb(); // runMigrations() + seedDeckConfigs() run here before window loads
    try { _backfillAccountMarker(); } catch {}
  } catch (e) {
    let dbPath = "(could not resolve)";
    try { dbPath = getDbPath(); } catch {}
    console.error("[DB] FATAL: initDb failed —", (e && e.stack) || e);
    try {
      dialog.showMessageBoxSync({
        type: "error",
        title: "Ether — Database Error",
        message: "Ether could not open its database and has to close.",
        detail: `Database path:\n${dbPath}\n\n${(e && e.message) || e}\n\nThis usually means the data folder is on a redirected or network drive. Ether needs a local data folder — please send this message to support.`,
        buttons: ["Quit"],
        noLink: true,
      });
    } catch (dlgErr) { console.error("[DB] error dialog failed:", dlgErr && dlgErr.message); }
    app.isQuitting = true;
    app.quit();
    return; // do NOT continue to createWindow() with an unusable / undefined db
  }
  processInviteFile(); // VIP invite seeding — runs after DB is ready

  // Cloud backup must init AFTER initDb() so db is not undefined
  try {
    const { installCloudBackup, triggerUpload, getR2Config } = require("./cloud-backup.js");
    installCloudBackup(ipcMain, db, { dbPath: getDbPath() });
    cloudBackupTrigger = triggerUpload;
    app._getR2Config = getR2Config;

    // Auto-push R2 credentials to cloud playout server every startup.
    // Runs after a short delay so it doesn't block the app launching.
    setTimeout(async () => {
      try {
        const r2 = getR2Config();
        if (!r2.accessKeyId || !r2.secretAccessKey) {
          console.log('[PLAYOUT] Startup R2 push skipped — credentials not configured');
          return;
        }
        const row = db.prepare("SELECT value FROM station_config_kv WHERE key='playout_server'").get();
        const server = row?.value?.trim() || '44.244.52.207';
        const url = `http://${server}:3500/api/playout/r2config`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId:       r2.accountId,
            accessKeyId:     r2.accessKeyId,
            secretAccessKey: r2.secretAccessKey,
            bucket:          r2.bucket,
            endpoint:        r2.endpoint,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) console.log(`[PLAYOUT] R2 credentials auto-pushed to ${server} on startup`);
        else        console.warn(`[PLAYOUT] Startup R2 push returned ${res.status} from ${server}`);
      } catch (e) {
        console.warn('[PLAYOUT] Startup R2 push failed (server may be offline):', e.message);
      }
    }, 6000);
  } catch (e) {
    console.warn("[CLOUD-BACKUP] installCloudBackup failed:", e.message);
  }

  // Station metadata (public listener page config — Phase 2). After initDb().
  try {
    const { installStationMetadata } = require("./station-metadata.js");
    installStationMetadata(ipcMain, db);
    const { installNowPlayingArt } = require("./now-playing-art.js");
    installNowPlayingArt(ipcMain, db);
  } catch (e) {
    console.warn("[STATION-METADATA] install failed:", e.message);
  }

  // GPIO engine (broadcast hardware I/O) — db-dependent, so it installs HERE (after initDb), not at
  // module load where `db` was still undefined (the "[GPIO] table init: …undefined…'exec'" error).
  // The onGpiEvent callback's mainWindow use is guarded; GPI events only arrive after the window exists.
  try {
    const { installGpioEngine } = require("./gpio-engine.js");
    installGpioEngine(ipcMain, db, {
      onGpiEvent: (actionType, actionValue, info) => {
        console.log(`[GPIO] action: ${actionType} = ${actionValue}`, info);
        if (mainWindow) mainWindow.webContents.send("gpio:event", { actionType, actionValue, ...info });
      },
    });
  } catch (e) {
    console.warn("[GPIO] installGpioEngine failed:", e.message);
  }

  // Site Replication (multi-station sync) — also db-dependent; same reason it lives here now.
  try {
    const { installSiteReplication } = require("./site-replication.js");
    installSiteReplication(ipcMain, db);
  } catch (e) {
    console.warn("[REPL] installSiteReplication failed:", e.message);
  }

  // sync IPC handlers — all 30 typed handler sets via aggregator
  // (stations:* excluded from installAll — registered manually below with custom logic)
  console.log('[sync/handlers] ▶ installAll starting (phase-3.5)');
  try {
    const { installAll } = require('./sync/handlers/index');
    installAll(ipcMain, db);
    console.log('[sync/handlers] ✓ installAll complete');
  } catch (e) {
    console.error("[sync/handlers] ✗ install failed:", e.message);
    console.error(e.stack);
  }

  // ── Sync scheduler — Phase F Stage 4 ──────────────────────────
  // Off by default. Users opt in via Settings → System → Multi-Device Sync.
  try {
    const enabledRow = db.prepare(
      "SELECT value FROM station_config_kv WHERE key = 'sync_enabled' LIMIT 1"
    ).get();
    if (enabledRow?.value !== 'true') {
      console.log('[SYNC] disabled (set sync_enabled=true in station_config_kv to activate)');
    } else {
      const { HttpTransport }   = require('./sync/transport-http');
      const { SyncScheduler }   = require('./sync/sync-scheduler');
      const urlRow  = db.prepare("SELECT value FROM station_config_kv WHERE key = 'sync_backend_url' LIMIT 1").get();
      const baseUrl = urlRow?.value || process.env.ETHER_SYNC_URL || '';
      const transport = new HttpTransport(db, { baseUrl });
      // UUID-identity (Tier-2): scope/route station programming by stable station UUID instead of the
      // per-machine local integer, so edits sync both ways across machines whose local ids differ.
      // Off by default (shadow-first); set sync_uuid_identity=true in station_config_kv to enable.
      const uuidIdentity = db.prepare(
        "SELECT value FROM station_config_kv WHERE key = 'sync_uuid_identity' LIMIT 1"
      ).get()?.value === 'true';
      // member-operate (default off): when on, a member-accessed station (e.g. OV) is operated as a
      // FULL switchable station and its edits push BACK under the member token (bidirectional). When
      // off, member stations stay pull-only (v4.4.7 behavior) — safe until the harness proof is green.
      const memberOperate = db.prepare(
        "SELECT value FROM station_config_kv WHERE key = 'member_operate' LIMIT 1"
      ).get()?.value === 'true';
      // The local ids of member stations the operator chose — the owner sync must NOT push their edits
      // under THIS install's license key (each member station pushes its own edits under its member
      // token, per-context isolation). Resolved live so newly-chosen stations are picked up.
      const memberStationLocalIds = () => {
        try {
          const chosen = JSON.parse(db.prepare("SELECT value FROM install_config_kv WHERE key = 'member_stations'").get()?.value || '[]');
          return chosen.map(c => db.prepare('SELECT id FROM stations WHERE uuid = ?').get(c.station_uuid)?.id).filter(v => v != null).map(String);
        } catch (_) { return []; }
      };
      const scheduler = new SyncScheduler(db, transport, {
        // Read active station on every pull so mid-session station switches are handled
        // correctly. main.js owns getActiveStationId(); SyncEngine stores only the getter.
        getStationId:   () => String(getActiveStationId()),
        // The active station's stable UUID — used for UUID-identity scoping when enabled.
        getStationUuid: () => db.prepare('SELECT uuid FROM stations WHERE id = ?').get(getActiveStationId())?.uuid ?? null,
        uuidIdentity,
        // Owner push excludes member stations (their edits go up under the member token, not the license).
        getPushExcludeStationIds: () => memberOperate ? memberStationLocalIds() : [],
      });
      if (uuidIdentity) console.log('[SYNC] UUID-identity scoping ENABLED (station programming syncs by station UUID)');
      // Do NOT start sync here. Sync must never run off a license_key that's merely sitting in the
      // database — it runs ONLY after an operator has actually signed in. The renderer calls
      // "sync:set-active" with true on sign-in and false on sign-out. This is what stops Ether from
      // assuming a license and pushing/pulling data before anyone has signed in. [account-isolation]
      app._syncScheduler = scheduler;

      // ── Member peer-sync — OPT-IN PER COMPUTER (the operator CHOOSES, nothing is auto-pulled) ──────
      // Member stations the operator picks on the sync screen are persisted in install_config_kv
      // 'member_stations' (JSON [{account_id, station_uuid, name}]). We pull-ONLY those — never all
      // memberships, never on a guess. Each runs a pull-only SyncEngine with member Bearer auth
      // (switch-account token) + per-context cursor keys, scoped by station UUID (Tier-2). Pull-only +
      // per-context cursors mean a member sync cannot disturb the owner sync.
      const _memberTimers = new Map();   // station_uuid -> intervalId
      const stopMemberSync = () => { for (const t of _memberTimers.values()) clearInterval(t); _memberTimers.clear(); };
      const getChosenMemberStations = () => { try { return JSON.parse(db.prepare("SELECT value FROM install_config_kv WHERE key = 'member_stations'").get()?.value || '[]'); } catch (_) { return []; } };
      const saveChosenMemberStations = (list) => {
        const now = new Date().toISOString();
        const exists = db.prepare("SELECT 1 FROM install_config_kv WHERE key = 'member_stations'").get();
        if (exists) db.prepare("UPDATE install_config_kv SET value = ?, updated_at = ? WHERE key = 'member_stations'").run(JSON.stringify(list), now);
        else db.prepare("INSERT INTO install_config_kv (key, value, uuid, created_at, updated_at) VALUES ('member_stations', ?, ?, ?, ?)").run(JSON.stringify(list), require('crypto').randomUUID(), now, now);
      };
      const pullMemberStation = async (accountId, uuid, name) => {
        if (_memberTimers.has(uuid)) return;
        const jwt = db.prepare("SELECT value FROM install_config_kv WHERE key = 'account_jwt'").get()?.value;
        if (!jwt) { console.warn('[SYNC] member-sync: no account_jwt'); return; }
        let token = null;
        try { const s = await fetch(`${baseUrl}/api/me/switch-account/${accountId}`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` } }); if (s.ok) token = (await s.json())?.token || null; }
        catch (e) { console.warn('[SYNC] member-sync: switch-account ' + accountId + ': ' + e.message); }
        if (!token) { console.warn('[SYNC] member-sync: no token for account ' + accountId + ' — skip ' + uuid); return; }
        // Hold the member token so fetchR2Track can address this station's audio under the operated
        // account's R2 prefix while it's the active station (in-memory; re-minted each session).
        app._memberTokens = app._memberTokens || new Map();
        app._memberTokens.set(uuid, token);
        const { SyncEngine } = require('./sync/sync-engine');
        const mt = new HttpTransport(db, { baseUrl, memberToken: token, cursorKey: 'sync_server_seq_member_' + uuid });
        // Resolve OV's LOCAL station id on THIS install (created at provision time). Used both to pull
        // OV's programming into the right local rows and to push ONLY OV's edits back (push isolation).
        const localId = () => { const r = db.prepare('SELECT id FROM stations WHERE uuid = ?').get(uuid); return r ? String(r.id) : null; };
        const me = new SyncEngine(db, mt, {
          uuidIdentity: true,
          // Bidirectional when member-operate is on; pull-only otherwise (safe default).
          pullOnly: !memberOperate,
          cursorKey: 'sync_cursor_member_' + uuid,
          getStationId:   localId,
          getStationUuid: () => uuid,
          // Push ONLY OV's mutations, under the member token — never the owner's or another station's.
          getPushOnlyStationId: localId,
        });
        // push (if bidirectional) + pull each tick.
        const tick = () => me.syncCycle()
          .then(r => { const ap = r.pull?.applied || 0, ps = r.push?.accepted || 0; if (ap > 0 || ps > 0) console.log('[SYNC] member "' + (name || uuid) + '": pulled-applied ' + ap + ', pushed ' + ps); })
          .catch(e => console.error('[SYNC] member "' + (name || uuid) + '" sync: ' + e.message));
        tick();
        _memberTimers.set(uuid, setInterval(tick, 8000));
        console.log('[SYNC] member-sync STARTED (chosen, ' + (memberOperate ? 'BIDIRECTIONAL' : 'pull-only') + ') "' + (name || uuid) + '" (' + uuid + ') acct ' + accountId);
      };
      const startChosenMemberSync = () => { for (const c of getChosenMemberStations()) pullMemberStation(c.account_id, c.station_uuid, c.name).catch(e => console.error('[SYNC] member-sync start: ' + e.message)); };

      // List membership-accessible stations for the sync screen so it can offer them as CHOICES.
      ipcMain.handle('member-sync:available', async () => {
        try {
          const jwt = db.prepare("SELECT value FROM install_config_kv WHERE key = 'account_jwt'").get()?.value;
          if (!jwt) return { ok: true, stations: [], chosen: [] };
          const res = await fetch(`${baseUrl}/api/me/memberships`, { headers: { Authorization: `Bearer ${jwt}` } });
          if (!res.ok) return { ok: false, error: 'memberships HTTP ' + res.status, stations: [], chosen: [] };
          const memberships = (await res.json())?.memberships || [];
          const seated = String(db.prepare("SELECT value FROM install_config_kv WHERE key = 'account_email'").get()?.value || '').toLowerCase();
          const stations = [];
          for (const m of memberships) {
            if (m.status !== 'active' || (m.account_email || '').toLowerCase() === seated) continue;
            for (const st of (m.stations || [])) stations.push({ account_id: m.account_id, account_name: m.account_name || m.account_email, position: m.position, station_uuid: st.uuid, name: st.name, can_edit: st.can_edit });
          }
          return { ok: true, stations, chosen: getChosenMemberStations().map(c => c.station_uuid) };
        } catch (e) { return { ok: false, error: e.message, stations: [], chosen: [] }; }
      });
      // The operator CHOSE a member station for THIS computer → persist + start pulling it.
      ipcMain.handle('member-sync:choose', async (_e, { account_id, station_uuid, name }) => {
        try {
          const list = getChosenMemberStations();
          if (!list.find(c => c.station_uuid === station_uuid)) { list.push({ account_id, station_uuid, name }); saveChosenMemberStations(list); }
          await pullMemberStation(account_id, station_uuid, name);
          return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
      });
      // Remove a member station from THIS computer (stops its sync; local data is left in place).
      ipcMain.handle('member-sync:unchoose', (_e, { station_uuid }) => {
        try {
          saveChosenMemberStations(getChosenMemberStations().filter(c => c.station_uuid !== station_uuid));
          const t = _memberTimers.get(station_uuid); if (t) { clearInterval(t); _memberTimers.delete(station_uuid); }
          return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
      });

      ipcMain.handle("sync:set-active", (_e, active) => {
        try {
          if (active) { scheduler.start(); startChosenMemberSync(); }   // pull ONLY the stations the operator chose
          else { scheduler.stop(); stopMemberSync(); }
        }
        catch (e) { console.error("[sync:set-active]", e.message); }
        return { ok: true };
      });

      powerMonitor.on('suspend',       () => scheduler.pause());
      powerMonitor.on('lock-screen',   () => scheduler.pause());
      powerMonitor.on('resume',        () => scheduler.resume());
      powerMonitor.on('unlock-screen', () => scheduler.resume());
    }
  } catch (e) {
    console.error('[SYNC] scheduler init failed:', e.message);
    console.error(e.stack);
  }

  if (global.__etherDiag) global.__etherDiag('POINT-4: app.whenReady() fired');
  // Initialize startup log — written to userData so it survives packaged builds with no terminal
  _startupLogPath = path.join(app.getPath('userData'), 'ether-startup.log');
  logStartup('=== SESSION START ===');
  logStartup(`version: ${app.getVersion()}  packaged: ${app.isPackaged}  pid: ${process.pid}`);
  logStartup(`userData: ${app.getPath('userData')}`);

  // Show native splash first; main window stays hidden behind it
  createSplash();
  splashStatus("Starting EtherCast…");
  // Let the renderer report its own real load steps (DB migrations, station, audio).
  ipcMain.handle("splash:status", (_e, msg) => { splashStatus(String(msg || "")); return true; });
  logStartup('createSplash() done');
  splashStatus("Loading interface…");
  createWindow();
  logStartup('createWindow() done — mainWindow hidden, waiting for ready-to-show');
  createTray();
  buildMenu();

  // ── Startup sequence ─────────────────────────────────────────
  // Splash shows for 10s, then:
  //   1. Splash fades out over 500ms
  //   2. Splash window closes
  //   3. Main window fades in over 500ms
  //   4. Main window focuses (login screen appears naturally inside it)
  //
  // The splash closes once the app is genuinely ready, but stays up for a brief
  // minimum (~2.5s) so the real status is actually readable on fast loads. This is
  // NOT theater — the lines are real milestones; we just don't blink past them.
  let mainReady   = false;
  let minElapsed  = false;

  function tryShowMain() {
    if (!mainReady || !minElapsed) return;

    // Step 1 — fade out splash over 500ms
    const doFadeIn = () => {
      // Step 2 — close splash
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();

      // Step 3 — fade main window in: start at opacity 0, ramp to 1 over 500ms
      mainWindow.setOpacity(0);
      mainWindow.show();

      let opacity = 0;
      const STEPS    = 20;           // 20 steps × 25ms = 500ms
      const STEP_AMT = 1 / STEPS;

      const fadeIn = setInterval(() => {
        opacity = Math.min(1, opacity + STEP_AMT);
        if (!mainWindow.isDestroyed()) mainWindow.setOpacity(opacity);
        if (opacity >= 1) {
          clearInterval(fadeIn);
          mainWindow.focus();        // Step 4 — focus; login appears inside the app
        }
      }, 25);
    };

    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents
        .executeJavaScript(
          'document.body.style.transition="opacity 0.5s ease";' +
          'document.body.style.opacity="0";'
        )
        .then(() => setTimeout(doFadeIn, 500))
        .catch(doFadeIn); // if JS inject fails, proceed anyway
    } else {
      doFadeIn();
    }
  }

  mainWindow.once("ready-to-show", () => {
    logStartup('ready-to-show fired');
    mainReady = true;
    tryShowMain();
  });

  // ready-to-show has a known Electron bug where it doesn't fire for file:// loads
  // (packaged builds). did-finish-load is a reliable fallback — fires when the page
  // navigation completes. Both set mainReady; whichever fires first wins.
  mainWindow.webContents.once("did-finish-load", () => {
    logStartup('did-finish-load fired');
    splashStatus("Ready.");
    mainReady = true;
    tryShowMain();
  });

  // Minimum visible time so the real status lines are readable on fast loads.
  setTimeout(() => { minElapsed = true; tryShowMain(); }, 10000);

  // Hard fallback — if ready-to-show never fires in a packaged build (renderer crash,
  // preload error, or other packaged-only issue), force-show after 15s so the user
  // is not staring at a blank screen.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      logStartup('WARN: force-showing main window — ready-to-show did not fire within 15s');
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      mainWindow.setOpacity(1);
      mainWindow.show();
      mainWindow.focus();
    } else {
      logStartup('15s fallback check — window already visible, no action needed');
    }
  }, 15000);

  // Start 30fps real-time audio level push to renderer.
  // When AUDIO_DAEMON is on the daemon broadcasts levels and audiodClient re-emits them as
  // audio:levels (see the event handler above), so skip the local poll (main isn't metering).
  mainWindow.webContents.on("did-finish-load", () => {
    if (levelPushId) clearInterval(levelPushId);
    if (!AUDIO_DAEMON) levelPushId = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const levels = JSON.parse(audio.audioGetLevels());
        // Real program peak from the engine (post-EQ master). Fall back to max-of-decks
        // only if the native master field is absent (older addon).
        if (typeof levels.master !== "number") levels.master = Math.max(levels.a || 0, levels.b || 0, levels.c || 0);
        sendToAllWindows("audio:levels", levels);
      } catch {}
    }, 33);
    // Write session header to rotation.log so every capture is clearly delimited
    try {
      const { execSync } = require("child_process");
      let commit = "unknown";
      try { commit = execSync("git rev-parse --short HEAD", { cwd: path.join(__dirname, ".."), timeout: 2000 }).toString().trim(); } catch {}
      const ts = new Date().toISOString();
      const sep = "========================================";
      fs.appendFileSync(_rotationLogPath, `\n${sep}\nSESSION START ${ts}\ncommit: ${commit}\n${sep}\n`);
    } catch {}
  });
});

// ── HA watchdog handshake (Phase 2) ───────────────────────────
// The watchdog (separate process) reads these sentinels in userData on our exit
// to decide whether to respawn us. Intentional quit → .ether-clean-exit (stand
// down). Update/relaunch → .ether-expected-restart (wait for self-relaunch,
// only respawn if it never returns). userData is the same dir the watchdog
// computes independently — keep them in sync.
let _haExpectedRestart = false;
// Set ONLY by a deliberate full quit (the X/Quit dialog's "Stop & Quit", File/tray Quit). Tells
// before-quit to tear the daemon down + stop the client so nothing resurrects — vs. close-to-tray
// (keeps the daemon playing) or an update relaunch (_haExpectedRestart).
let _userFullQuit = false;
function writeHaSentinel(name) {
  try { fs.writeFileSync(path.join(app.getPath("userData"), name), String(Date.now())); }
  catch (e) { console.error("[HA] sentinel write failed:", name, e.message); }
}
function markHaExpectedRestart() { _haExpectedRestart = true; writeHaSentinel(".ether-expected-restart"); }

// On-air marker: written while ANY Icecast stream is live, removed when all streams stop or on an
// explicit sign-out. The launch gate reads it (account:was-on-air): if a stream was live, a crash /
// reboot / watchdog respawn must come straight back on air WITHOUT a sign-in (no human is there to
// enter a PIN on an unattended box). If nothing was on air, the launch requires sign-in.
function _onAirMarkerFile() { return path.join(app.getPath("userData"), ".ether-on-air"); }
function _persistOnAir(anyLive) {
  try {
    if (anyLive) fs.writeFileSync(_onAirMarkerFile(), String(Date.now()));
    else fs.rmSync(_onAirMarkerFile(), { force: true });
  } catch (e) { console.error("[HA] on-air marker:", e.message); }
}
function _wasOnAir() {
  try {
    if (!fs.existsSync(_onAirMarkerFile())) return false;
    // The marker alone is not enough to skip sign-in: it can be stranded by an unclean prior
    // run (crash, force-kill, dev taskkill). Only HONOR it as on-air recovery when THIS launch
    // is actually a watchdog/crash respawn — the watchdog brands every app instance it spawns
    // with ETHER_WATCHDOG_PID (watchdog.js). A plain cold/manual launch has no such env var, so
    // a stale marker is ignored and sign-in shows normally (CLAUDE.md: the ONLY sign-in-skip
    // exception is the watchdog auto-restart while a station was streaming live).
    return !!process.env.ETHER_WATCHDOG_PID;
  } catch { return false; }
}
ipcMain.handle("account:was-on-air", () => _wasOnAir());

// Keep-session marker: written immediately before a CONTINUATION self-relaunch (cloud-install DB
// reload, generic reload, update install) so the next launch carries the signed-in session instead
// of forcing sign-in again — that self-relaunch-resets-the-flag bug caused a sign-in loop. NOT
// written by sign-out / switch / factory-reset (those must land on the sign-in screen). Consumed on
// read and only honored if recent (<2min), so a later cold start or reboot still requires sign-in.
function markKeepSession() {
  try { fs.writeFileSync(path.join(app.getPath("userData"), ".ether-keep-session"), String(Date.now())); }
  catch (e) { console.error("[HA] keep-session write:", e.message); }
}
function _consumeRecentKeepSession() {
  try {
    const f = path.join(app.getPath("userData"), ".ether-keep-session");
    if (!fs.existsSync(f)) return false;
    const ts = parseInt(fs.readFileSync(f, "utf8").trim(), 10) || 0;
    fs.rmSync(f, { force: true });
    return (Date.now() - ts) < 120000;
  } catch { return false; }
}
ipcMain.handle("account:resume-session", () => _consumeRecentKeepSession());

app.on("window-all-closed", () => {
  // Keep running on Windows/Linux (app lives in tray)
  if (process.platform === "darwin") app.quit();
});

app.on("before-quit", () => {
  if (levelPushId) { clearInterval(levelPushId); levelPushId = null; }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow.show();
});

app.on("before-quit", () => {
  if (levelPushId) { clearInterval(levelPushId); levelPushId = null; }
  if (app._syncScheduler) { app._syncScheduler.stop(); app._syncScheduler = null; }
  app.isQuitting = true;
  stopWatchdogMonitor(); // don't relaunch a watchdog while we're shutting down
  // HA: signal an intentional quit so the watchdog stands down — UNLESS we're
  // intentionally relaunching (update), in which case the expected-restart
  // sentinel is already written and we must NOT also write clean-exit.
  if (!_haExpectedRestart) {
    writeHaSentinel(".ether-clean-exit");
    // Clean, user-initiated quit (NOT an update/continuation relaunch): clear the on-air
    // marker so the NEXT cold launch requires sign-in. A crash / power-loss / force-kill
    // never runs before-quit, so the marker survives those → genuine watchdog on-air
    // recovery is preserved. Without this, a marker stranded by an unclean prior run would
    // make a normal launch falsely skip sign-in (the stale-marker bug).
    try { _persistOnAir(false); } catch {}
  }

  // Deliberate close → STOP the broadcast. The out-of-process daemon is detached and outlives
  // the app, so we must tell it to shut down. Previously only the HA watchdog did this (reading
  // the clean-exit sentinel above); with HA OFF nothing read it, so the daemon kept playing after
  // the user closed Ether. Gated: skip on an update relaunch (_haExpectedRestart → keep the daemon
  // for gapless), and when a watchdog is supervising (_haWatchdogPid → leave its tested clean-exit
  // handshake to it, avoiding a double-shutdown/respawn race). A crash never runs before-quit, so
  // the daemon survives a crash (audio continues) as intended.
  if (_userFullQuit) {
    // Deliberate FULL quit (driven by fullStopAndQuit, which already sent the daemon shutdown and
    // stood the watchdog down): stop the client so it cannot reconnect/respawn the daemon as we
    // exit. This overrides the watchdog-handshake gate below — the user asked for everything off.
    try { audiodClient.stop(); } catch {}
  } else if (!_haExpectedRestart && AUDIO_DAEMON && !_haWatchdogPid) {
    try { audiodClient.cmd("shutdown").catch(() => {}); } catch {}
  }
});

// ── HA mutual supervision (Phase 2.5) ─────────────────────────
// The watchdog passes us its PID via ETHER_WATCHDOG_PID when it spawns or adopts
// us. We watch that PID and relaunch the watchdog if it dies — closing the "who
// watches the watchdog" gap so the keep-alive is bi-directional. The relaunched
// watchdog is told to ADOPT us (ETHER_ADOPT_PID=our pid) instead of spawning a
// second Ether, which would lose the single-instance race, quit, and look to the
// watchdog like a crash → respawn storm. A storm guard caps relaunches/window.
const HA_MONITOR_INTERVAL_MS = 10000;
const HA_RELAUNCH_WINDOW_MS  = 5 * 60 * 1000;
const HA_MAX_RELAUNCHES      = 3;
let _haWatchdogPid  = Number(process.env.ETHER_WATCHDOG_PID) || 0;
let _haMonitorTimer = null;
let _haMonitorOff   = false; // set on intentional quit / ha:disable
const _haRelaunchTimes = [];

function _haIsAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Mirror of the watchdog's own dev/packaged spawn logic, inverted — WE launch
// the watchdog. Packaged: execPath is Ether.exe → `Ether.exe --ether-watchdog`.
// Dev: execPath is electron.exe → `electron <appRoot> --ether-watchdog`. Either
// way the launched process self-dispatches into watchdog.js (main.js top).
function _haWatchdogSpawnSpec() {
  const isDev = /node_modules[\\/]electron/i.test(process.execPath);
  const appRoot = path.resolve(__dirname, "..");
  const args = isDev ? [appRoot, "--ether-watchdog"] : ["--ether-watchdog"];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;           // launch as the app (it self-dispatches)
  env.ETHER_ADOPT_PID = String(process.pid); // adopt us; do NOT spawn a 2nd Ether
  return { cmd: process.execPath, args, env };
}

function _haRelaunchesInWindow() {
  const cutoff = Date.now() - HA_RELAUNCH_WINDOW_MS;
  while (_haRelaunchTimes.length && _haRelaunchTimes[0] < cutoff) _haRelaunchTimes.shift();
  return _haRelaunchTimes.length;
}

// Spawn a fresh, DETACHED watchdog (it's our supervisor — it must outlive us, so
// it can respawn the app if we crash next). Returns the new pid, or 0 on failure
// / storm-guard trip.
function relaunchWatchdog() {
  if (_haMonitorOff || app.isQuitting) return 0;
  if (_haRelaunchesInWindow() >= HA_MAX_RELAUNCHES) {
    console.error(`[HA] watchdog relaunch storm guard tripped (>=${HA_MAX_RELAUNCHES} in ${HA_RELAUNCH_WINDOW_MS / 1000}s) — giving up until next launch`);
    _haMonitorOff = true;
    return 0;
  }
  try {
    const { spawn } = require("child_process");
    const { cmd, args, env } = _haWatchdogSpawnSpec();
    _haRelaunchTimes.push(Date.now());
    const child = spawn(cmd, args, { env, stdio: "ignore", detached: true });
    child.unref(); // don't keep us alive for it, and don't let our exit kill it
    _haWatchdogPid = child.pid;
    console.log(`[HA] relaunched watchdog pid ${child.pid} (adopt ${process.pid})`);
    return child.pid;
  } catch (e) {
    console.error("[HA] watchdog relaunch failed:", e.message);
    return 0;
  }
}

// Begin watching the watchdog PID. Called once /health is listening (so an
// adopt-relaunch can succeed) and from ha:enable. No-op if we have no watchdog
// PID (app launched directly, not under HA) — we never spawn an unsolicited one.
function startWatchdogMonitor(pid) {
  if (pid) _haWatchdogPid = pid;
  _haMonitorOff = false;
  if (!_haWatchdogPid || _haMonitorTimer) return;
  console.log(`[HA] mutual supervision active — monitoring watchdog pid ${_haWatchdogPid}`);
  _haMonitorTimer = setInterval(() => {
    if (_haMonitorOff || app.isQuitting) return;
    if (!_haIsAlive(_haWatchdogPid)) {
      console.warn(`[HA] watchdog pid ${_haWatchdogPid} is gone — relaunching`);
      relaunchWatchdog();
    }
  }, HA_MONITOR_INTERVAL_MS);
  if (_haMonitorTimer.unref) _haMonitorTimer.unref();
}

function stopWatchdogMonitor() {
  _haMonitorOff = true;
  if (_haMonitorTimer) { clearInterval(_haMonitorTimer); _haMonitorTimer = null; }
}

// ── HA control surface (Phase 3/4 Settings + IPC) ─────────────
// Loads the per-OS watchdog platform module (register/unregister/status of the
// logon Scheduled Task). null on an unsupported platform → handlers degrade.
function loadHaPlatform() {
  try { return require(`../watchdog/platform/${process.platform}`); } catch { return null; }
}
function _haConfigPath() { return path.join(app.getPath("userData"), "ha-config.json"); }
function readHaConfigFile() {
  try { return JSON.parse(fs.readFileSync(_haConfigPath(), "utf8")); } catch { return { enabled: true }; }
}
function _haAlarmActive() {
  try { return fs.existsSync(path.join(app.getPath("userData"), ".ether-ha-alarm")); } catch { return false; }
}

// schtasks /Query is a subprocess — cache its result so the 5s ha:dashboard poll
// (and the footer dot) don't spawn it 12×/min. Task registration is a deliberate,
// rare action, so a 30s TTL stays plenty fresh. ha:status + ha:dashboard share it.
let _haStartupCache = { at: 0, val: null };
function cachedStartupStatus() {
  const now = Date.now();
  if (_haStartupCache.val && (now - _haStartupCache.at) < 30000) return _haStartupCache.val;
  const plat = loadHaPlatform();
  const val = plat && plat.startupStatus ? plat.startupStatus() : { registered: false };
  _haStartupCache = { at: now, val };
  return val;
}

// Single source of truth for the /health payload — shared by the GET /health
// route (the HA watchdog's poll) and the ha:dashboard IPC (the renderer's System
// Health panel). MUST stay lock-free: reads only Node-native values + the atomic
// audio-liveness getter; never calls audio.audioGetState() (that would lock the
// per-station Mutex and could stall during a write).
function buildHealthSnapshot() {
  const now = Date.now();
  let lastCb = 0;
  try { lastCb = Number(audio.audioLastCallbackMs?.()) || 0; } catch {}
  const staleMs = lastCb > 0 ? now - lastCb : null;
  let sync = null;
  try {
    const sch = app._syncScheduler;
    if (sch) {
      const s = sch.getProgressState();
      sync = { running: true, initialComplete: !!s.initialComplete, appliedTotal: s.appliedTotal || 0 };
    }
  } catch {}
  let activeId = null;
  try { activeId = getActiveStationId(); } catch {}
  let memRssMb = null;
  try { memRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024)); } catch {}
  return {
    ok: true,
    ts: now,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    audio: { lastCallbackMs: lastCb, staleMs, alive: staleMs !== null && staleMs < 2000 },
    sync,
    station: { activeId },
    memRssMb,
  };
}

ipcMain.handle("ha:status", () => {
  const plat = loadHaPlatform();
  return {
    platform: process.platform,
    supported: !!(plat && plat.registerStartup && process.platform === "win32"),
    config: readHaConfigFile(),
    startup: cachedStartupStatus(),
    watchdog: { pid: _haWatchdogPid || null, alive: _haIsAlive(_haWatchdogPid), monitoring: !!_haMonitorTimer },
    alarm: _haAlarmActive(),
  };
});

// ha:dashboard — combined health + HA control-plane snapshot for the System
// Health panel's 5s poll. One round-trip. `startup` (schtasks) is cached 30s.
// `active` distinguishes "HA running" from "app launched directly" so the UI can
// show a neutral "HA Inactive" instead of a scary red when HA was never enabled.
ipcMain.handle("ha:dashboard", () => {
  const plat = loadHaPlatform();
  return {
    health: buildHealthSnapshot(),
    ha: {
      platform: process.platform,
      supported: !!(plat && plat.registerStartup && process.platform === "win32"),
      active: !!_haWatchdogPid,
      config: readHaConfigFile(),
      startup: cachedStartupStatus(),
      watchdog: { pid: _haWatchdogPid || null, alive: _haIsAlive(_haWatchdogPid), monitoring: !!_haMonitorTimer },
      alarm: _haAlarmActive(),
      // Current logged-in account (env, no subprocess) — the Settings auto-logon
      // form shows it as the account that will be configured. config.user holds
      // the account actually configured (once enabled).
      currentUser: `${process.env.USERDOMAIN || "."}\\${process.env.USERNAME || ""}`,
    },
  };
});

// ha:alarmStatus — minimal alarm-only check for the footer NOMINAL dot. A single
// fs.existsSync; no subprocess, no risk of the dot holding stale dashboard state.
ipcMain.handle("ha:alarmStatus", () => ({ alarm: _haAlarmActive() }));

// ha:readLog — last N lines of watchdog.log (on-demand, not polled). Main owns
// the userData path; the renderer just asks for a tail.
ipcMain.handle("ha:readLog", (_e, lines) => {
  const n = Math.max(1, Math.min(Number(lines) || 40, 500));
  try {
    const p = path.join(app.getPath("userData"), "watchdog.log");
    const all = fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
    return { ok: true, lines: all.slice(-n) };
  } catch (e) {
    return { ok: false, error: e.code === "ENOENT" ? "no log yet" : e.message, lines: [] };
  }
});

// ── Phase 4: auto-logon installer (ha:enable / ha:disable / ha:repair) ─────────
// The customer-facing Settings toggle lands here. Two things need admin — the
// HKLM Winlogon values and the LSA "DefaultPassword" secret — so they're done by
// an elevated native helper (native/ha-setup → ha-setup.exe) launched via one UAC
// prompt. Everything else (the per-user Scheduled Task, ha-config.json, the live
// watchdog) is done here, unelevated. The password reaches the helper over a
// named pipe — never an argument, never on disk.
const { buildElevatePs } = require("./ha-elevate");

function haSetupExePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "ha-setup.exe")
    : path.join(__dirname, "..", "native", "ha-setup", "target", "release", "ha-setup.exe");
}

function writeHaConfigFile(cfg) {
  try { fs.writeFileSync(_haConfigPath(), JSON.stringify(cfg, null, 2)); }
  catch (e) { console.error("[HA] write ha-config.json:", e.message); }
}

// Launch the elevated helper for `verb`. If `password` is provided (enable), open
// a one-shot named pipe and hand the password over once the helper connects.
// Returns the helper's structured result JSON ({ ok, step, error }) + exit code.
function runHaSetup(verb, password) {
  return new Promise((resolve) => {
    const net = require("net");
    const crypto = require("crypto");
    const os = require("os");
    const { spawn } = require("child_process");

    const pipeName = `\\\\.\\pipe\\ether-ha-${crypto.randomBytes(8).toString("hex")}`;
    const resultPath = path.join(os.tmpdir(), `ether-ha-result-${process.pid}-${Date.now()}.json`);
    const user = (loadHaPlatform()?.currentUserId?.() ) || `${process.env.USERDOMAIN || "."}\\${process.env.USERNAME || ""}`;

    let server = null;
    const cleanup = () => { try { if (server) server.close(); } catch {} };

    const finish = (code) => {
      cleanup();
      let result = { ok: code === 0, step: "spawn", error: code === 0 ? null : `helper exit ${code}` };
      try { result = JSON.parse(fs.readFileSync(resultPath, "utf8")); } catch {}
      try { fs.unlinkSync(resultPath); } catch {}
      resolve({ ...result, exitCode: code });
    };

    const launch = () => {
      const args = [verb, "--result", resultPath, "--user", user];
      if (password != null) args.push("--pipe", pipeName);
      const ps = buildElevatePs(haSetupExePath(), args);
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
      child.on("exit", (code) => finish(code == null ? -1 : code));
      child.on("error", (e) => { console.error("[HA] helper spawn error:", e.message); finish(-1); });
    };

    if (password != null) {
      // Pipe server delivers the password to the elevated helper, then closes.
      server = net.createServer((sock) => { sock.end(password + "\n"); });
      server.on("error", (e) => { console.error("[HA] pipe error:", e.message); finish(-1); });
      server.listen(pipeName, () => launch());
    } else {
      launch();
    }
  });
}

// Full enable: per-user task (no elevation) → elevated auto-logon (one UAC) →
// persist config → bring supervision up for this session. ha:repair re-runs this
// (re-prompts for the password), which fixes any partial/legacy state in one go.
async function haEnable(password) {
  if (process.platform !== "win32") return { ok: false, error: "Auto-recovery is only supported on Windows." };
  if (!password) return { ok: false, error: "A Windows password is required to set up automatic logon." };
  const plat = loadHaPlatform();
  if (!plat || !plat.registerStartup) return { ok: false, error: "HA platform support unavailable." };

  // a. Per-user logon Scheduled Task (Phase 3) — no elevation.
  let reg;
  try { reg = plat.registerStartup(); } catch (e) { reg = { ok: false, error: e.message }; }
  if (!reg.ok) return { ok: false, step: "task", error: reg.stderr || reg.error || "could not register startup task" };

  // b. Elevated auto-logon (registry + LSA secret) — one UAC prompt.
  const r = await runHaSetup("enable", password);
  if (!r.ok) {
    try { plat.unregisterStartup(); } catch {}   // roll the task back so we don't leave a half-enabled state
    return { ok: false, step: r.step || "autologon", error: r.error || `helper exit ${r.exitCode}` };
  }

  // c. Persist the configured state.
  const user = (plat.currentUserId && plat.currentUserId()) || null;
  writeHaConfigFile({ enabled: true, autologon: true, user });

  // d. Bring a watchdog up for this session (adopts us) if none is supervising.
  if (!_haIsAlive(_haWatchdogPid)) {
    _haMonitorOff = false; _haRelaunchTimes.length = 0;
    relaunchWatchdog();
  }
  _haStartupCache = { at: 0, val: null };   // bust the schtasks cache so status reflects the new task
  return { ok: true };
}

ipcMain.handle("ha:enable", (_e, password) => haEnable(password));
ipcMain.handle("ha:repair", (_e, password) => haEnable(password));

ipcMain.handle("ha:disable", async () => {
  if (process.platform !== "win32") return { ok: false, error: "Auto-recovery is only supported on Windows." };
  stopWatchdogMonitor();   // FIRST — don't relaunch the watchdog we're about to kill
  const plat = loadHaPlatform();

  // a. Clear auto-logon (registry + LSA secret) — one UAC prompt.
  const r = await runHaSetup("disable", null);

  // b. Remove the per-user task and kill the live watchdog.
  let unreg = { ok: false, error: "platform unsupported" };
  if (plat && plat.unregisterStartup) { try { unreg = plat.unregisterStartup(); } catch (e) { unreg = { ok: false, error: e.message }; } }
  const pid = _haWatchdogPid || readWatchdogPidFile();
  _haKillWatchdog(pid);
  removeWatchdogPidFile();
  _haWatchdogPid = 0;

  // c. Persist the off state.
  writeHaConfigFile({ enabled: false, autologon: false, user: null });
  _haStartupCache = { at: 0, val: null };
  return { ok: r.ok && unreg.ok, autologon: r, task: unreg };
});

// Lightweight "pause keep-on-air" (no UAC): stop the live watchdog for THIS session so a force-kill
// stays dead. Distinct from ha:disable, which fully removes auto-logon (UAC) and persists off. Used
// by the tray "Stop Keeping On Air…" item and (optionally) a Settings button.
ipcMain.handle("ha:pauseKeepOnAir", () => { try { pauseKeepOnAir(); return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } });

function _haWatchdogPidFile() { return path.join(app.getPath("userData"), ".ether-watchdog.pid"); }
function readWatchdogPidFile() {
  try { return Number(fs.readFileSync(_haWatchdogPidFile(), "utf8").trim()) || 0; } catch { return 0; }
}
function removeWatchdogPidFile() { try { fs.unlinkSync(_haWatchdogPidFile()); } catch { /* none */ } }
function _haKillWatchdog(pid) {
  if (!pid) return;
  // NO /T: the watchdog may have spawned US as its child, and /T takes the whole
  // tree — which would kill this app. Kill only the watchdog process itself.
  try { require("child_process").spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* best effort */ }
}

// Is the station actually on air right now? (drives the close-dialog wording.)
function _isOnAir() {
  try {
    if (_automationIntent && _automationIntent.size > 0) return true;
    for (const s of _daemonStreamStates.values()) if (s === "live") return true;
  } catch {}
  return false;
}

// Emergency "stop keeping on air": stop relaunching + kill the live HA watchdog so a force-kill
// (Task Manager — or our own exit) STAYS dead for this session. Unelevated: it does NOT remove the
// auto-logon Scheduled Task (that needs UAC via Settings → disable), so keep-on-air re-arms on the
// next logon. This is the "I need to fully shut down NOW" lever for a system under load.
function pauseKeepOnAir() {
  try { stopWatchdogMonitor(); } catch {}
  const pid = _haWatchdogPid || readWatchdogPidFile();
  try { _haKillWatchdog(pid); } catch {}
  try { removeWatchdogPidFile(); } catch {}
  _haWatchdogPid = 0;
  try { writeHaSentinel(".ether-clean-exit"); } catch {}   // also tell any mid-cycle watchdog to stand down
  console.log("[HA] keep-on-air paused — watchdog stopped; a force-kill now stays dead this session");
}

// Deliberate FULL shutdown — the X/Quit dialog's "Stop & Quit", File→Quit, tray Quit. Tears the
// whole stack down so nothing resurrects: stand the watchdog down, tell the daemon to stop, stop
// the client so it can't respawn the daemon, then quit. The short delay lets the shutdown reach the
// daemon pipe before our process exits. before-quit also writes the clean-exit sentinel.
function fullStopAndQuit() {
  if (app.isQuitting) return;
  _userFullQuit = true;
  app.isQuitting = true;
  try { pauseKeepOnAir(); } catch {}                                  // watchdog can't relaunch us mid-exit
  try { if (AUDIO_DAEMON) audiodClient.cmd("shutdown").catch(() => {}); } catch {}  // stop the detached daemon
  setTimeout(() => { try { audiodClient.stop(); } catch {} app.quit(); }, 250);
}

// Executes the --enable-ha / --disable-ha CLI flags. Called from the :3400 listen
// callback so /health is already answering (the adopting spawn depends on it).
function handleHaBootstrapFlags() {
  const plat = loadHaPlatform();
  if (_haDisableHaFlag) {
    stopWatchdogMonitor(); // FIRST — don't relaunch the watchdog we're about to kill
    let unreg = { ok: false, error: "platform unsupported" };
    if (plat && plat.unregisterStartup) { try { unreg = plat.unregisterStartup(); } catch (e) { unreg = { ok: false, error: e.message }; } }
    const pid = _haWatchdogPid || readWatchdogPidFile();
    _haKillWatchdog(pid);
    removeWatchdogPidFile();
    _haWatchdogPid = 0;
    console.log(`[HA] --disable-ha: unregister ok=${unreg.ok}${unreg.error ? " err=" + unreg.error : ""}, killed watchdog pid ${pid || "none"}`);
    return;
  }
  if (_haEnableHaFlag) {
    let reg = { ok: false, error: "platform unsupported" };
    if (plat && plat.registerStartup) { try { reg = plat.registerStartup(); } catch (e) { reg = { ok: false, error: e.message }; } }
    console.log(`[HA] --enable-ha: registerStartup ok=${reg.ok}${reg.error ? " err=" + reg.error : ""}, task=${reg.taskName || "?"}`);
    // Bring a watchdog up for THIS session (adopting us) if none is supervising.
    if (!_haIsAlive(_haWatchdogPid)) {
      _haMonitorOff = false; _haRelaunchTimes.length = 0;
      const pid = relaunchWatchdog();
      console.log(`[HA] --enable-ha: spawned adopting watchdog pid ${pid || "FAILED"} (adopt ${process.pid})`);
    }
  }
}

// ── IPC Handlers ──────────────────────────────────────────────
// These replace all Tauri invoke() calls

// Sync
ipcMain.handle('sync:getStats', () => {
  const scheduler = app._syncScheduler ?? null;
  const enabledRow = db.prepare(
    "SELECT value FROM station_config_kv WHERE key = 'sync_enabled' LIMIT 1"
  ).get();
  const enabled = enabledRow?.value === 'true';
  if (scheduler) {
    return { enabled, running: true, ...scheduler.getStats() };
  }
  return { enabled, running: false, lastSyncAt: null, pushedToday: 0, pulledToday: 0 };
});

// Audio
// Phase 1.3k: extended with R2 fallback for Connect-path customers whose
// library arrived via metadata sync but whose local file_path values point at
// the source machine's directories. If the local file is missing AND a
// file_key exists for this file_path in the songs table, fall through to
// fetchR2Track (which gates on Network+ tier and uses the same r2-cache as
// the auto-scheduler). If the fetch succeeds, audio.audioLoad is called with
// the cachePath; if it fails (tier insufficient, no license, network down,
// no such object), audio.audioLoad is called with the original file_path and
// fails the same way it would have today — Rust worker reports the error,
// deck enters error status, no regression vs pre-1.3k behavior.
//
// Per Option B: no songsUpdateById writeback. The r2-cache's existsSync
// short-circuit makes subsequent loads fast; writing file_path back would
// generate sync mutation noise for zero local benefit (each machine would
// propagate its own cachePath to others, who'd just rewrite to their own).
ipcMain.handle("audio:load", async (_, deck, filePath, title, artist, gainDb, stationId) => {
  // Item 10 Phase 2 Step 1: the resolved load goes to the daemon when enabled (it owns the
  // engine); otherwise the in-process addon. File resolution (existsSync + R2 fetch) — which
  // needs main's DB + R2 — stays here; only the final load is forwarded.
  const doLoad = (fp) => AUDIO_DAEMON
    ? audiodClient.cmd("load", { deck, filePath: fp, title, artist, gainDb: gainDb ?? 0, stationId })
    : audio.audioLoad(deck, fp, title, artist, gainDb ?? 0, stationId);
  // Fast path — file exists locally. Behave exactly as the pre-1.3k handler.
  if (filePath && fs.existsSync(filePath)) {
    return doLoad(filePath);
  }

  // File missing. Look up file_key for this file_path. Exact match on the
  // synced songs row — the renderer's loadToDeck calls pass next.filePath
  // straight from songs/queue/cart objects, so the path here matches the
  // row's file_path exactly.
  let fileKey = null;
  if (filePath) {
    try {
      const row = db.prepare("SELECT file_key FROM songs WHERE file_path = ? LIMIT 1").get(filePath);
      fileKey = row?.file_key || null;
    } catch (e) {
      console.warn("[audio:load] file_key lookup failed:", e.message);
    }
  }

  if (!fileKey) {
    // No file_key registered. Fall through to legacy — the Rust audio worker
    // will fail with "File not found" same as before 1.3k.
    return doLoad(filePath);
  }

  // Have a file_key — try the R2 fallback. Tier gate enforced inside fetchR2Track.
  console.log(`[audio:load] local miss, attempting R2 fallback for file_key=${fileKey}`);
  const fetched = await fetchR2Track(fileKey);
  if (!fetched.ok) {
    console.warn(`[audio:load] R2 fallback failed: ${fetched.error} — falling through to legacy path`);
    return doLoad(filePath);
  }

  console.log(`[audio:load] R2 fallback succeeded → ${fetched.filePath}`);
  return doLoad(fetched.filePath);
});

// Item 10 Phase 2 Step 1: deck control + state + levels route to the daemon when AUDIO_DAEMON
// (it owns the engine), else the in-process addon. getState/getLevels return parsed objects
// from both paths.
ipcMain.handle("audio:play", (_, deck, stationId) => AUDIO_DAEMON ? audiodClient.cmd("play", { deck, stationId }) : audio.audioPlay(deck, stationId));
ipcMain.handle("audio:pause", (_, deck, stationId) => AUDIO_DAEMON ? audiodClient.cmd("pause", { deck, stationId }) : audio.audioPause(deck, stationId));
ipcMain.handle("audio:stop", (_, deck, stationId) => AUDIO_DAEMON ? audiodClient.cmd("stop", { deck, stationId }) : audio.audioStop(deck, stationId));
ipcMain.handle("audio:setVolume", (_, deck, volume, stationId) => AUDIO_DAEMON ? audiodClient.cmd("setVolume", { deck, volume, stationId }) : audio.audioSetVolume(deck, volume, stationId));
ipcMain.handle("audio:getState", (_, stationId) => AUDIO_DAEMON ? audiodClient.cmd("getState", { stationId }) : JSON.parse(audio.audioGetState(stationId)));
ipcMain.handle("audio:getLevels", (_, stationId) => AUDIO_DAEMON ? audiodClient.cmd("getLevels", { stationId }) : JSON.parse(audio.audioGetLevels(stationId)));
// 10-band post-EQ master spectrum for the Master EQ rack's live FFT display. Routes to the
// daemon when it owns playout (it has the live audio), else the in-process addon.
ipcMain.handle("audio:getSpectrum", (_, stationId) => AUDIO_DAEMON ? audiodClient.cmd("getSpectrum", { stationId }) : JSON.parse(audio.audioGetSpectrum(stationId)));
ipcMain.handle("audio:getFileDuration", (_, filePath) => audio.getFileDuration(filePath));
// Embedded cover art straight from the audio file (local-first artwork — primary source;
// iTunes is the caller's fallback). music-metadata is ESM-only (v11), so it's loaded via
// dynamic import. Returns a data: URL of the first embedded picture, or null. Cached by
// filePath (bounded FIFO) so repeated requests / replays don't re-parse the file.
const _embeddedArtCache = new Map();
const _EMBEDDED_ART_CACHE_MAX = 150;
ipcMain.handle("audio:embeddedArt", async (_, filePath) => {
  if (!filePath || typeof filePath !== "string") return null;
  if (_embeddedArtCache.has(filePath)) return _embeddedArtCache.get(filePath);
  let result = null;
  try {
    const mm = await import("music-metadata");
    const meta = await mm.parseFile(filePath, { duration: false });
    const pic = meta.common && meta.common.picture && meta.common.picture[0];
    if (pic && pic.data && pic.data.length) {
      result = `data:${pic.format || "image/jpeg"};base64,${Buffer.from(pic.data).toString("base64")}`;
    }
  } catch (e) { /* unreadable/missing/no-tags → null, caller falls back to iTunes */ }
  if (_embeddedArtCache.size >= _EMBEDDED_ART_CACHE_MAX) {
    _embeddedArtCache.delete(_embeddedArtCache.keys().next().value);
  }
  _embeddedArtCache.set(filePath, result);
  return result;
});
ipcMain.handle("audio:watchdogSet", (_, active, thresholdSec, stationId) => AUDIO_DAEMON ? audiodClient.cmd("watchdogSet", { active, thresholdSec, stationId }) : audio.watchdogSet(active, thresholdSec, stationId));
// Broadcast (profanity) delay + dump — delay lives on the stream path only.
ipcMain.handle("audio:setBroadcastDelay", (_, seconds, stationId) => AUDIO_DAEMON ? audiodClient.cmd("setBroadcastDelay", { seconds, stationId }) : audio.audioSetBroadcastDelay(seconds, stationId));
ipcMain.handle("audio:dump", (_, stationId) => AUDIO_DAEMON ? audiodClient.cmd("dump", { stationId }) : audio.audioDump(stationId));
ipcMain.handle("audio:broadcastDelayState", async (_, stationId) => {
  if (AUDIO_DAEMON) { try { return await audiodClient.cmd("broadcastDelayState", { stationId }); } catch { return { armed: false, delaySec: 0, bufferedSec: 0, fillPct: 0 }; } }
  try { return JSON.parse(audio.audioBroadcastDelayState(stationId)); } catch { return { armed: false, delaySec: 0, bufferedSec: 0, fillPct: 0 }; }
});
// EQ — sends 10 band gains (f32[]) to the station's EQ chain in the BusMixer.
ipcMain.handle("audio:setEq", (_, deck, bands, stationId) => {
  if (AUDIO_DAEMON) return audiodClient.cmd("setEq", { stationId: stationId ?? 1, bands });
  try { if (typeof audio.audioSetEq === "function") return audio.audioSetEq(stationId ?? 1, JSON.stringify(bands)); }
  catch(e) { console.warn("[EQ] audioSetEq error:", e.message); }
  return true;
});

ipcMain.handle("audio:listOutputDevices", async () => {
  if (AUDIO_DAEMON) { try { return await audiodClient.cmd("listOutputDevices"); } catch { return []; } }
  try {
    if (typeof audio.audioListOutputDevices !== "function") return [];
    return JSON.parse(audio.audioListOutputDevices());
  } catch { return []; }
});
ipcMain.handle("audio:setOutputDevice", (_, stationId, deviceName) => {
  if (AUDIO_DAEMON) return audiodClient.cmd("setOutputDevice", { stationId, device: deviceName });
  try {
    if (typeof audio.audioSetOutputDevice !== "function") return false;
    return audio.audioSetOutputDevice(stationId, deviceName);
  } catch { return false; }
});

// Item 10 Phase 2 Step 2 — the renderer proxy queries this to learn whether the daemon owns
// playout. When true it stops driving advance locally and subscribes to the daemon's
// audio:daemon-deck / -queue / -playstart events instead.
ipcMain.handle("audio:daemonEnabled", async () => { await audioBackendReady; return AUDIO_DAEMON; });
// Generic bridge for the daemon's queue + automation commands (automationStart/automationStop/
// fill/getQueue/enqueue/replaceQueue/clearQueue/setContinuous/setShuffle/setAutoAdvance).
// Only meaningful when AUDIO_DAEMON; the in-process engine owns the queue otherwise.
ipcMain.handle("audio:daemon", async (_, cmd, args) => {
  if (!AUDIO_DAEMON) return { ok: false, error: "audio daemon disabled" };
  // Track automation intent for auto-resume: set on automationStart, cleared ONLY on an explicit
  // automationStop (a deliberate operator stop is never auto-resumed). Disconnect/respawn never
  // touches this map — the whole point is that it survives a daemon death.
  try {
    const sid = args && args.stationId;
    if (sid != null) {
      if (cmd === "automationStart") _automationIntent.set(sid, args);
      else if (cmd === "automationStop") _automationIntent.delete(sid);
    }
  } catch {}
  try { return { ok: true, result: await audiodClient.cmd(cmd, args || {}) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

// Database
ipcMain.handle("db:query", (_, sql, params) => {
  try {
    const stmt = db.prepare(sql);
    return { data: stmt.all(...(params || [])), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

function detectSyncedWrite(sql) {
  // Strip leading whitespace then leading SQL comments (-- line and /* */ block).
  let s = sql.trimStart();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1).trimStart();
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2).trimStart();
    } else {
      break;
    }
  }

  const insertMatch  = s.match(/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([`"]?[\w.]+[`"]?)/i);
  const replaceMatch = s.match(/^REPLACE\s+INTO\s+([`"]?[\w.]+[`"]?)/i);
  const updateMatch  = s.match(/^UPDATE\s+(?:OR\s+\w+\s+)?([`"]?[\w.]+[`"]?)\s+SET/i);
  const deleteMatch  = s.match(/^DELETE\s+FROM\s+([`"]?[\w.]+[`"]?)/i);

  const m = insertMatch || replaceMatch || updateMatch || deleteMatch;
  if (!m) return null;

  const verb = insertMatch ? 'INSERT' : replaceMatch ? 'REPLACE' : updateMatch ? 'UPDATE' : 'DELETE';

  // Strip surrounding quotes and schema prefix (e.g. "songs", `songs`, main.songs → songs)
  let table = m[1];
  if ((table.startsWith('"') && table.endsWith('"')) ||
      (table.startsWith('`') && table.endsWith('`'))) {
    table = table.slice(1, -1);
  }
  if (table.includes('.')) {
    table = table.split('.').pop();
  }

  return { verb, table: table.toLowerCase() };
}

ipcMain.handle("db:execute", (_, sql, params) => {
  try {
    // Synced-table write guard (Phase 3.5). SELECTs bypass detection entirely.
    if (!/^\s*SELECT/i.test(sql)) {
      const detection = detectSyncedWrite(sql);
      if (detection && SYNCED_TABLES_SET.has(detection.table)) {
        const msg = `ERR_SYNCED_TABLE_WRITE: table '${detection.table}' has a typed handler ` +
          `(window.ether.${detection.table}.*); db:execute is locked against direct writes to ` +
          `synced tables. See docs/phase-3.5-status-audit.md for migration guidance.`;
        console.error("[db:execute LOCKED]", detection.verb, detection.table, "— SQL:", sql.slice(0, 120));
        return { data: null, error: msg };
      }
      // No write op parsed — warn and allow (handles PRAGMA, DDL, unusual forms).
      if (!detection) {
        console.warn("[db:execute] could not parse write op from non-SELECT SQL:", sql.slice(0, 120));
      }
    }

    const stmt = db.prepare(sql);
    const result = stmt.run(...(params || []));
    return { data: result, error: null };
  } catch (e) {
    console.error("[DB execute error]", sql.slice(0, 100), e.message);
    return { data: null, error: e.message };
  }
});

// File system
ipcMain.handle("fs:readFile", async (_, filePath) => {
  try {
    const fd = fs.openSync(filePath, "r");
    const size = Math.min(fs.fstatSync(fd).size, 256 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    return { data: Array.from(buf), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

ipcMain.handle("fs:readFileTail", async (_, filePath, n) => {
  try {
    const fd = fs.openSync(filePath, "r");
    const totalSize = fs.fstatSync(fd).size;
    const readSize = Math.min(n, totalSize);
    const offset = totalSize - readSize;
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, offset);
    fs.closeSync(fd);
    return { data: Array.from(buf), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

ipcMain.handle("fs:exists", (_, filePath) => fs.existsSync(filePath));

ipcMain.handle("fs:readDir", (_, dirPath) => {
  try {
    return fs.readdirSync(dirPath).map(name => ({
      name,
      path: path.join(dirPath, name),
      isDir: fs.statSync(path.join(dirPath, name)).isDirectory(),
    }));
  } catch { return []; }
});

// Rotation diagnostic log — renderer sends fire-and-forget, main appends to file
const _rotationLogPath = path.join(__dirname, "..", "tmp-userdata", "rotation.log");
ipcMain.on("log:rotation", (_, msg) => {
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
    fs.appendFileSync(_rotationLogPath, `[${ts}] ${msg}\n`);
  } catch {}
});

// Dialog
ipcMain.handle("dialog:openFile", async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", ...(options?.multiple ? ["multiSelections"] : [])],
    filters: options?.filters || [{ name: "Audio", extensions: ["mp3", "flac", "wav", "aac", "m4a", "ogg"] }],
  });
  return result.canceled ? null : result.filePaths;
});

ipcMain.handle("dialog:openDirectory", async () => {
  console.log("[DIALOG] openDirectory called");
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:saveFile", async (_, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options || {});
  return result.canceled ? null : result.filePath;
});

// Watermark verification — reads a WAV file and extracts/verifies the Ether LSB watermark
ipcMain.handle("watermark:verify", async (_, { filePath }) => {
  const crypto = require("crypto");
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
      return { found: false, valid: false, error: "Not a valid WAV file" };

    // Walk chunks to find 'data'
    let offset = 12, pcmOffset = -1, pcmLen = 0;
    while (offset < buf.length - 8) {
      const id  = buf.toString("ascii", offset, offset + 4);
      const len = buf.readUInt32LE(offset + 4);
      if (id === "data") { pcmOffset = offset + 8; pcmLen = len; break; }
      offset += 8 + len + (len & 1);
    }
    if (pcmOffset < 0) return { found: false, valid: false, error: "No PCM data found" };

    const numSamples = Math.floor(pcmLen / 2);
    if (numSamples < 96) return { found: false, valid: false, error: "Audio too short" };

    // Read i16 samples
    const samples = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++)
      samples[i] = buf.readInt16LE(pcmOffset + i * 2);

    // Extract `len` bytes from LSBs, MSB-first per byte (mirrors Rust extract_lsb)
    function extractLsb(off, len) {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++)
          byte = (byte << 1) | (samples[off + i * 8 + bit] & 1);
        out[i] = byte;
      }
      return out;
    }

    const MAGIC = Buffer.from("ETHRWM01");
    const magic = Buffer.from(extractLsb(0, 8));
    if (!magic.equals(MAGIC))
      return { found: false, valid: false, error: "No Ether watermark found" };

    const lb = extractLsb(64, 4);
    const payloadLen = lb[0] | (lb[1] << 8) | (lb[2] << 16) | (lb[3] << 24);
    const samplesNeeded = (8 + 4 + payloadLen) * 8;
    if (payloadLen > 8192 || numSamples < samplesNeeded)
      return { found: true, valid: false, error: `Invalid payload length: ${payloadLen}` };

    const payloadBytes = extractLsb(96, payloadLen);
    let payload;
    try { payload = JSON.parse(Buffer.from(payloadBytes).toString("utf8")); }
    catch { return { found: true, valid: false, error: "Watermark JSON parse error" }; }

    const { station_id, timestamp, ether_version, content_hash } = payload;

    // Recompute hash: clear LSBs of the watermarked region, keep rest
    const cleared = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const s = i < samplesNeeded ? (samples[i] & ~1) : samples[i];
      cleared.writeInt16LE(s < -32768 ? -32768 : s > 32767 ? 32767 : s, i * 2);
    }
    const computedHash = crypto.createHash("sha256").update(cleared).digest("hex");
    const valid = computedHash === content_hash;

    return { found: true, valid, stationId: station_id, timestamp, etherVersion: ether_version, contentHash: content_hash, computedHash, error: null };
  } catch (e) {
    return { found: false, valid: false, error: e.message };
  }
});

// System
ipcMain.handle("system:getLocalIp", () => audio.getLocalIp());
ipcMain.handle("system:openUrl", (_, url) => shell.openExternal(url));
ipcMain.handle("system:openSoundSettings", () => audio.openSoundSettings());
ipcMain.handle("system:getAppDataDir", () => app.getPath("userData"));
ipcMain.handle("system:getPlatform", () => process.platform);
ipcMain.handle("system:getVersion", () => app.getVersion());

// ── User / PIN security ──────────────────────────────────────
const crypto = require("crypto");
ipcMain.handle("user:hash-pin", (_evt, pin) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + pin).digest("hex");
  return salt + ":" + hash;
});
ipcMain.handle("user:verify-pin", (_evt, pin, stored) => {
  if (!stored) return false;
  // Support both legacy plaintext PINs and new salt:hash format
  if (!stored.includes(":")) return pin === stored;
  const [salt, hash] = stored.split(":");
  const attempt = crypto.createHash("sha256").update(salt + pin).digest("hex");
  return attempt === hash;
});

// Backup
ipcMain.handle("db:backup", () => {
  try {
    const dbPath = getDbPath();
    const backupDir = path.join(app.getPath("userData"), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const backupName = `openair-backup-${timestamp}.db`;
    const backupPath = path.join(backupDir, backupName);
    fs.copyFileSync(dbPath, backupPath);
    // Delete backups older than 7 days
    const cutoff = timestamp - 7 * 24 * 3600;
    fs.readdirSync(backupDir).forEach(name => {
      const match = name.match(/openair-backup-(\d+)\.db/);
      if (match && parseInt(match[1]) < cutoff) {
        fs.unlinkSync(path.join(backupDir, name));
      }
    });
    return { data: backupPath, error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

// Generate a VIP invite file and save it via save dialog
ipcMain.handle("invite:generate", async (_, { name, initials, note, mode, invitedBy }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save Invite File",
      defaultPath: "ether-invite.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!filePath) return { ok: false, reason: "cancelled" };
    const payload = {
      operator_name: name,
      operator_initials: initials,
      invited_by: invitedBy || "Deniro",
      personal_note: note,
      experience_mode: mode,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, filePath };
  } catch (e) { return { ok: false, reason: e.message }; }
});

// Reset deck configs to factory defaults and return fresh rows
ipcMain.handle("deck-configs:reset", () => {
  try {
    const { deckConfigsClearAll } = require('./sync/handlers/deck_configs');
    deckConfigsClearAll(db, getActiveStationId());
    seedDeckConfigs();
    return { data: db.prepare("SELECT * FROM deck_configs ORDER BY slot").all(), error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

ipcMain.handle("db:listBackups", () => {
  try {
    const backupDir = path.join(app.getPath("userData"), "backups");
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter(n => n.startsWith("openair-backup-"))
      .sort().reverse();
  } catch { return []; }
});

ipcMain.handle("db:restore", (_, backupName) => {
  try {
    const backupPath = path.join(app.getPath("userData"), "backups", backupName);
    const dbPath = getDbPath();
    if (!fs.existsSync(backupPath)) return { error: "Backup not found" };
    // Close DB before restore
    db.close();
    fs.copyFileSync(backupPath, dbPath);
    initDb(); // Reopen
    return { data: "Restored successfully", error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

// Factory reset — wipe the local database (the live file AND the legacy migration source,
// else getDbPath copies it back) so the next launch is a clean first run: re-onboarding +
// first-user PIN setup. Closes the DB, deletes both copies + their WAL sidecars, then
// relaunches. Destructive — the renderer gates this behind a double-email confirmation.
ipcMain.handle("system:factoryReset", () => {
  try {
    try { db.close(); } catch {}
    const rm = (p) => { try { if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {} };
    // Wipe EVERYTHING so a reset is truly clean. The old version only deleted openair.db and left
    // keyed copies (openair__*.db) + the legacy folder + userData markers behind, which let the old
    // install resurrect on the next launch. Nuke the whole local data folder + legacy + markers.
    rm(path.dirname(_etherDir()));                                  // %LOCALAPPDATA%\Ether (DB, WAL, keyed copies, engine staging)
    rm(path.join(app.getPath("appData"), "com.ether.radio"));      // legacy Roaming DB (redirected to network on managed boxes)
    rm(path.join(app.getPath("appData"), "openair"));              // old (pre-rename) Roaming userData, if any lingers
    for (const m of [".ether-on-air", ".ether-keep-session"]) {    // markers that skip sign-in / trigger resurrection
      try { fs.rmSync(path.join(app.getPath("userData"), m), { force: true }); } catch {}
    }
    markHaExpectedRestart();
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Clean relaunch — used after a cloud install (the DB was swapped under the app) so the
// renderer reloads against the new database. Mirrors the factory-reset relaunch. Carries the
// signed-in session across the reload (markKeepSession) so it doesn't bounce back to sign-in.
ipcMain.handle("app:relaunch", () => {
  try { markHaExpectedRestart(); markKeepSession(); } catch {}
  app.relaunch(); app.exit(0);
  return { ok: true };
});

// Switch Account — the per-account DB-swap was removed (one database per install). This now simply
// signs out: clear the account/onboarding session keys and relaunch, landing on the sign-in screen
// where the operator authenticates as whichever account they want. No file moves, no data mixing.
// (Account data isolation is handled by scoping what's shown to the signed-in account, not by
// juggling DB files.) The `email` arg is ignored — kept for call-site compatibility.
ipcMain.handle("account:switch-to", () => {
  try {
    _clearAccountSessionKeys();
    try { _persistOnAir(false); } catch {}  // explicit switch → next launch requires sign-in
    try { markHaExpectedRestart(); } catch {}
    app.relaunch();
    app.exit(0);
    return { ok: true, switched: true };
  } catch (e) { console.error("[account:switch-to]", e.message); return { ok: false, error: e.message }; }
});

// ── Legacy Tauri command aliases — called by SettingsPanel ────
ipcMain.handle("get_local_ip", () => audio.getLocalIp());
// These were Tauri commands in the original build. Now aliased here so
// the renderer doesn't need to change its invoke names.
ipcMain.handle("backup_db", async () => {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const backupDir = path.join(app.getPath("userData"), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupName = `openair-backup-${ts}.db`;
    fs.copyFileSync(getDbPath(), path.join(backupDir, backupName));
    // Prune backups older than 7 days
    const cutoff = ts - 7 * 24 * 3600;
    fs.readdirSync(backupDir).forEach(n => {
      const m = n.match(/openair-backup-(\d+)\.db/);
      if (m && parseInt(m[1]) < cutoff) try { fs.unlinkSync(path.join(backupDir, n)); } catch {}
    });
    // Fire R2 upload if configured — non-blocking so local backup always succeeds fast
    if (cloudBackupTrigger) {
      cloudBackupTrigger().then(r => {
        if (r && !r.skipped) console.log("[CLOUD-BACKUP] post-backup_db R2 upload:", r.ok ? "ok" : r.error);
      }).catch(e => console.warn("[CLOUD-BACKUP] post-backup_db R2 upload failed:", e.message));
    }
    return backupName;
  } catch (e) { throw new Error("Backup failed: " + e.message); }
});

ipcMain.handle("list_backups", () => {
  try {
    const backupDir = path.join(app.getPath("userData"), "backups");
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter(n => n.startsWith("openair-backup-") && n.endsWith(".db"))
      .sort().reverse();
  } catch { return []; }
});

// SettingsPanel passes { backupName } (object); db:restore takes a bare string.
ipcMain.handle("restore_db", (_, { backupName } = {}) => {
  try {
    if (!backupName) throw new Error("backupName is required");
    const backupPath = path.join(app.getPath("userData"), "backups", backupName);
    if (!fs.existsSync(backupPath)) throw new Error("Backup not found: " + backupName);
    db.close();
    fs.copyFileSync(backupPath, getDbPath());
    initDb();
    return "Restored from " + backupName + ". Restart Ether for all changes to take effect.";
  } catch (e) { throw new Error(e.message); }
});

// station:install-from-cloud — seed a NEW install from this account's latest cloud DB backup,
// then the renderer pulls the audio library. Restores the full openair.db (songs, clocks, shows,
// categories, schedule, config) but PRESERVES this machine's client_id (= its sync seat id) so it
// stays a distinct node, not a clone of the source machine. SAFE ONLY ON A FRESH INSTALL: refuses
// if the local DB already has songs unless force=true.
ipcMain.handle("station:install-from-cloud", async (_evt, { force } = {}) => {
  try {
    const lic = db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL").get();
    const licenseKey = lic?.value?.trim();
    if (!licenseKey) return { ok: false, error: "No license key — sign in first." };

    let songCount = 0;
    try { songCount = db.prepare("SELECT COUNT(*) AS n FROM songs").get()?.n ?? 0; } catch {}
    if (songCount > 0 && !force) {
      return { ok: false, error: `This install already has ${songCount} songs. Installing from cloud replaces the local database.`, hasData: true, songs: songCount };
    }

    // Preserve this machine's identity (also its sync seat / machine_id) across the DB swap.
    let myClientId = null;
    try { myClientId = db.prepare("SELECT client_id FROM client_identity LIMIT 1").get()?.client_id || null; } catch {}

    const { default: fetchFn } = await import("node-fetch").catch(() => ({ default: global.fetch }));
    const urlRes = await fetchFn(`${ETHER_BACKEND_URL}/backup/download-url`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    if (!urlRes.ok) {
      if (urlRes.status === 404) return { ok: false, error: "No cloud backup found for this account yet. Back up from the original machine first." };
      const t = await urlRes.text().catch(() => "");
      return { ok: false, error: `Couldn't get download URL (${urlRes.status}): ${t.slice(0, 160)}` };
    }
    const { db_signed_url } = await urlRes.json();
    if (!db_signed_url) return { ok: false, error: "Backend returned no download URL." };

    const dbRes = await fetchFn(db_signed_url);
    if (!dbRes.ok) return { ok: false, error: `Backup download failed (${dbRes.status}).` };
    const raw = require("zlib").gunzipSync(Buffer.from(await dbRes.arrayBuffer()));

    // Swap in (close → copy → reopen), like db:restore. Drop WAL sidecars so the fresh file is clean.
    const tmp = path.join(app.getPath("userData"), "cloud-restore.db");
    fs.writeFileSync(tmp, raw);
    db.close();
    fs.copyFileSync(tmp, getDbPath());
    try { fs.rmSync(tmp, { force: true }); } catch {}
    for (const suffix of ["-wal", "-shm", "-journal"]) { try { fs.rmSync(getDbPath() + suffix, { force: true }); } catch {} }
    initDb();

    // Re-stamp this machine's identity so it isn't the source machine's clone, and keep the
    // license key the operator signed in with.
    if (myClientId) { try { db.prepare("UPDATE client_identity SET client_id = ?").run(myClientId); } catch (e) { console.warn("[install-from-cloud] client_id restore:", e.message); } }
    try { db.prepare("UPDATE station_config_kv SET value = ? WHERE key = 'license_key'").run(licenseKey); } catch {}

    let newCount = 0, stationName = "";
    try { newCount = db.prepare("SELECT COUNT(*) AS n FROM songs").get()?.n ?? 0; } catch {}
    try { stationName = db.prepare("SELECT value FROM station_config_kv WHERE key='station_name' LIMIT 1").get()?.value || ""; } catch {}
    console.log(`[station:install-from-cloud] restored DB — ${newCount} songs, station="${stationName}"`);
    return { ok: true, songs: newCount, stationName };
  } catch (e) {
    console.error("[station:install-from-cloud]", e);
    return { ok: false, error: e.message };
  }
});

// station:cloud-install-available — lightweight check for the post-sign-in prompt: is this
// install fresh (no local library) AND does the account have a cloud DB backup to pull?
ipcMain.handle("station:cloud-install-available", async () => {
  try {
    let songCount = 0;
    try { songCount = db.prepare("SELECT COUNT(*) AS n FROM songs").get()?.n ?? 0; } catch {}
    if (songCount > 0) return { available: false, reason: "has_library" };
    const lic = db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL").get();
    const licenseKey = lic?.value?.trim();
    if (!licenseKey) return { available: false, reason: "no_license" };
    const { default: fetchFn } = await import("node-fetch").catch(() => ({ default: global.fetch }));
    const res = await fetchFn(`${ETHER_BACKEND_URL}/backup/download-url`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    if (res.status === 404) return { available: false, reason: "no_backup" };
    if (!res.ok) return { available: false, reason: `http_${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { available: true, timestamp: data.timestamp || null };
  } catch (e) { return { available: false, reason: e.message }; }
});

// ── Clean Filenames ───────────────────────────────────────────
ipcMain.handle("clean_filenames", async (_evt, { folderPath, commit, stringsToRemove }) => {
  try {
    const AUDIO_EXTS = new Set([".mp3", ".flac", ".wav", ".m4a", ".ogg"]);
    const userStrings = Array.isArray(stringsToRemove) && stringsToRemove.length > 0
      ? stringsToRemove
      : ["spotdown_org", "spotdown"];

    function cleanName(base) {
      let n = base;
      // Leading timestamp prefix: digits followed by underscore
      n = n.replace(/^\d+_/, "");
      // User-supplied strings — longest first to avoid partial matches
      const sorted = [...userStrings].sort((a, b) => b.length - a.length);
      for (const s of sorted) {
        const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        n = n.replace(new RegExp("_?" + escaped + "_?", "gi"), "_");
      }
      n = n.replace(/__+/g, "_");
      n = n.replace(/^_+|_+$/g, "");
      return n;
    }

    function walk(dir, results) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, results); continue; }
        const ext = path.extname(e.name).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;
        const base = path.basename(e.name, ext);
        const cleaned = cleanName(base);
        if (cleaned !== base) results.push({ dir, ext, before: e.name, after: cleaned + ext, fullPath: full });
      }
    }

    if (!folderPath || !fs.existsSync(folderPath)) return { ok: false, error: "Folder not found: " + folderPath };
    const renames = [];
    walk(folderPath, renames);

    if (commit) {
      let done = 0, errors = [];
      for (const r of renames) {
        try {
          fs.renameSync(r.fullPath, path.join(r.dir, r.after));
          done++;
        } catch (e) { errors.push(r.before + ": " + e.message); }
      }
      return { ok: true, renamed: done, renames, errors };
    }

    return { ok: true, renames, errors: [] };
  } catch (e) {
    console.error("[CLEAN-FILENAMES] error:", e.message, e.stack);
    return { ok: false, error: e.message };
  }
});

// Autostart
ipcMain.handle("autostart:enable", () => app.setLoginItemSettings({ openAtLogin: true }));
ipcMain.handle("autostart:disable", () => app.setLoginItemSettings({ openAtLogin: false }));
ipcMain.handle("autostart:isEnabled", () => app.getLoginItemSettings().openAtLogin);

// ── Generic invoke aliases (old Tauri command names) ─────────

ipcMain.handle("watchdog_set", (_, args) => {
  const { active, thresholdSec } = args || {};
  return audio.watchdogSet(active ?? false, thresholdSec ?? 30);
});

// -- Streaming stubs (Icecast client to be implemented) -------
let streamActive = false;
let streamStartTime = 0;

ipcMain.handle("stream_status", () => streamActive);

ipcMain.handle("stream_health", () => ({
  status: streamActive ? "live" : "disconnected",
  uptimeSecs: streamActive ? Math.floor((Date.now() - streamStartTime) / 1000) : 0,
  dropCount: 0,
  bufferSecs: 0,
}));

ipcMain.handle("stream_start", async (_, args) => {
  console.log("[STREAM] Start requested:", args?.config);
  streamActive = true;
  streamStartTime = Date.now();
  return true;
});

ipcMain.handle("stream_update_metadata", (_, args) => {
  console.log("[STREAM] Metadata:", args?.title, "-", args?.artist);
  return true;
});

ipcMain.handle("stream_start_if_configured", async () => {
  try { return audio.streamStart ? audio.streamStart() : true; } catch { return true; }
});

ipcMain.handle("stream_stop", async () => {
  try { return audio.streamStop ? audio.streamStop() : true; } catch { return true; }
});

ipcMain.handle("analyze_lufs", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return audio.analyzeLufs(filePath); } catch { return -14; }
});

ipcMain.handle("analyze_song", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return JSON.parse(audio.analyzeSong(filePath)); } catch { return null; }
});

ipcMain.handle("measure_song_loudness", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return JSON.parse(audio.measureSongLoudness(filePath)); } catch { return null; }
});

ipcMain.handle("detect_song_bpm", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return JSON.parse(audio.detectSongBpm(filePath)); } catch { return null; }
});

ipcMain.handle("detect_song_cue_points", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return JSON.parse(audio.detectSongCuePoints(filePath)); } catch { return null; }
});

ipcMain.handle("open_url", (_, args) => {
  const url = args?.url ?? args;
  return shell.openExternal(url);
});

ipcMain.handle("open_desk_window", async () => {
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle().includes("Producer Desk"));
  if (existing) { existing.show(); existing.focus(); return; }
  const { screen } = require("electron");
  const desk = new BrowserWindow({
    width: 900, height: 620, minWidth: 600, minHeight: 400,
    title: "Ether — Producer Desk",
    x: Math.round(screen.getPrimaryDisplay().workAreaSize.width * 0.55),
    y: 80,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  if (isDev) desk.loadURL(VITE_DEV_URL + "#desk");
  else desk.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "desk" });
});

// ── Event relay: ether.emit() in renderer → broadcast to all windows ──
// Relay now-playing-request to main window so it responds with current state
ipcMain.on("now-playing-request", (event) => {
  const sender = event.sender;
  BrowserWindow.getAllWindows().forEach(w => {
    if (w.webContents.id !== sender.id) {
      w.webContents.send("now-playing-request", {});
    }
  });
});

ipcMain.on("now-playing-update", (_, payload) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("now-playing-update", payload));
});
ipcMain.handle("set_now_playing", (_, args) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("now-playing-update", args));
  return true;
});

ipcMain.on("desk-send-to-queue", (_, payload) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("desk-send-to-queue", payload));
});

// ── Relaunch ──────────────────────────────────────────────────
ipcMain.handle("relaunch", () => { markHaExpectedRestart(); markKeepSession(); app.relaunch(); app.exit(0); });

// ── Multi-monitor pop-out windows — Tony Stark mode ──────────
// Each popped panel gets a frameless BrowserWindow loading #popout/<panel>
const POPOUT_SIZES = {
  "decks":       { width: 1320, height: 460 },  // all visible decks in a row
  "mic":         { width: 400,  height: 300 },
  "master":      { width: 800,  height: 600 },
  "upnext":      { width: 480,  height: 640 },
  "phone":       { width: 720,  height: 520 },
  "voicetrack":  { width: 860,  height: 540 },
  "videostudio": { width: 1024, height: 640 },
  "camera":      { width: 640,  height: 480 },
  "health":      { width: 720,  height: 540 },
};

ipcMain.handle("window:popout", async (_, panel) => {
  const tag = `popout:${panel}`;
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === tag);
  if (existing) { existing.show(); existing.focus(); return; }

  const { screen } = require("electron");
  const size = POPOUT_SIZES[panel] || { width: 640, height: 520 };
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  const secondary = displays.find(d => d.id !== primary.id);
  // Place on secondary monitor if available, else offset from center
  const x = secondary ? secondary.workArea.x + 60 : undefined;
  const y = secondary ? secondary.workArea.y + 60 : undefined;

  const win = new BrowserWindow({
    width:  size.width,
    height: size.height,
    minWidth:  320,
    minHeight: 200,
    x, y,
    title: tag,
    frame: false,
    transparent: false,
    backgroundColor: "#0e0e14",
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  if (isDev) win.loadURL(VITE_DEV_URL + `#popout/${panel}`);
  else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: `popout/${panel}` });
});

// ── Guest Editor pop-out window ───────────────────────────────
ipcMain.handle("window:guesteditor", async () => {
  const title = "Ether — Guest Editor";
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === title);
  if (existing) { existing.show(); existing.focus(); return; }

  const { screen } = require("electron");
  const displays  = screen.getAllDisplays();
  const primary   = screen.getPrimaryDisplay();
  const secondary = displays.find(d => d.id !== primary.id);
  const x = secondary ? secondary.workArea.x + 60 : undefined;
  const y = secondary ? secondary.workArea.y + 60 : undefined;

  const win = new BrowserWindow({
    width: 800, height: 600,
    minWidth: 400, minHeight: 300,
    x, y,
    title,
    frame: false,
    transparent: false,
    backgroundColor: "#0e0e14",
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  if (isDev) win.loadURL(VITE_DEV_URL + "#guesteditor");
  else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "guesteditor" });
});

// ── Cross-window broadcast relay ─────────────────────────────
// Renderer: ether.emit("ether:broadcast", { channel, data })
// All other windows receive: ether.on(channel, cb)
ipcMain.on("ether:broadcast", (event, { channel, data }) => {
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== event.sender.id) {
      win.webContents.send(channel, data);
    }
  });
});

ipcMain.handle("open_nowplaying_window", async () => {
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle().includes("Now Playing"));
  if (existing) { existing.show(); existing.focus(); return; }
  const { screen } = require("electron");
  const np = new BrowserWindow({
    width: 1280, height: 720,
    minWidth: 1280, minHeight: 720,
    title: "Ether - Now Playing",
    resizable: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  if (isDev) np.loadURL(VITE_DEV_URL + "#nowplaying");
  else np.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "nowplaying" });
});

// ── Auto-updater ──────────────────────────────────────────────
// Re-enabled after the load-bearing fixes that prompted the 2026-05-18
// disable (99574df):
//   - EP_DRAFT: false in build.yml — published releases reach
//     electron-updater (drafts are invisible to its feed)
//   - semver.gt compare in updater:check — a stale latest.yml can no
//     longer trigger a downgrade offer
//   - UpdateBanner mounted once in App.tsx with the dismissed flag
//     respected; clicking "Later" actually hides the banner
//
// Config matches pre-disable: autoDownload=false so the renderer's
// "Update Now" click is what triggers the download (vs autoDownload=true
// which would start downloading immediately on check); autoInstallOnAppQuit
// applies the staged update when the user next quits the app; logger=null
// suppresses electron-updater's chatty per-event console output.
//
// The IPC handlers below retain their `if (!autoUpdater)` guards as
// defense against the require() failing in sparse dev checkouts where
// electron-updater might not be installed. With normal installs the
// guards never fire and the handlers proceed to the real work.
let autoUpdater = null;
try {
  const { autoUpdater: au } = require("electron-updater");
  autoUpdater = au;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
} catch (e) {
  console.log("[UPDATER] electron-updater not available:", e.message);
}

ipcMain.handle("updater:check", async () => {
  if (!autoUpdater) return { available: false };
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.updateInfo) return { available: false };
    const current = app.getVersion();
    const latest = result.updateInfo.version;
    // Semver-aware comparison — `available: true` only when latest is STRICTLY
    // GREATER than current. Defense against a stale latest.yml on GitHub
    // Releases offering a downgrade (the bug that originally triggered the
    // auto-updater disable). semver is required from electron-updater's
    // transitive deps; it's the same module electron-updater uses internally.
    return {
      available: semver.gt(latest, current),
      version: latest,
      notes: result.updateInfo.releaseNotes ?? null,
      date: result.updateInfo.releaseDate ?? null,
    };
  } catch { return { available: false }; }
});

ipcMain.handle("updater:download", async () => {
  if (!autoUpdater) return;
  autoUpdater.on("download-progress", (progress) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send("updater:progress", progress));
  });
  await autoUpdater.downloadUpdate();
});

ipcMain.handle("updater:install", () => {
  markHaExpectedRestart(); // HA: the watchdog must expect us back, not respawn us
  markKeepSession();        // carry the signed-in session across the update relaunch
  if (!autoUpdater) { app.relaunch(); app.exit(0); return; }
  autoUpdater.quitAndInstall();
});

// ── AI key storage (safeStorage) ─────────────────────────────
function getAiConfigPath() {
  return path.join(app.getPath("userData"), "ai-config.json");
}
function readAiConfig() {
  try { return JSON.parse(fs.readFileSync(getAiConfigPath(), "utf8")); }
  catch { return { provider: "anthropic", keys: {} }; }
}
function writeAiConfig(cfg) {
  fs.writeFileSync(getAiConfigPath(), JSON.stringify(cfg, null, 2));
}
function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString("base64");
  }
  return Buffer.from(key).toString("base64") + ":plain";
}
function decryptKey(stored) {
  if (!stored) return null;
  if (stored.endsWith(":plain")) {
    return Buffer.from(stored.slice(0, -6), "base64").toString("utf8");
  }
  try { return safeStorage.decryptString(Buffer.from(stored, "base64")); }
  catch { return null; }
}

ipcMain.handle("ai:setKey", (_, { provider, key }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  if (key) cfg.keys[provider] = encryptKey(key);
  else delete cfg.keys[provider];
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("ai:getKeyStatus", () => {
  const cfg = readAiConfig();
  return {
    anthropic: !!(cfg.keys?.anthropic),
    openai:    !!(cfg.keys?.openai),
    google:    !!(cfg.keys?.google),
    weather:   !!(cfg.keys?.weather) || !!(process.env.OPENWEATHERMAP_API_KEY),
  };
});

ipcMain.handle("ai:setProvider", (_, provider) => {
  const cfg = readAiConfig();
  cfg.provider = provider;
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("ai:getProvider", () => readAiConfig().provider || "anthropic");

// ── AI assistant — multi-provider ─────────────────────────────
// Shared now-playing state updated by the main window
let _nowPlayingContext = { title: null, artist: null };
ipcMain.on("iris:nowplaying", (_, payload) => {
  if (payload && typeof payload === "object") {
    _nowPlayingContext = { title: payload.title || null, artist: payload.artist || null };
  }
});

ipcMain.handle("ai:ask", async (_, messages) => {
  const cfg = readAiConfig();
  const provider = cfg.provider || "anthropic";
  let apiKey = decryptKey(cfg.keys?.[provider]);
  if (!apiKey && provider === "anthropic") apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "__NO_KEY__";

  // Build station context string for Iris
  const nowPlayingLine = _nowPlayingContext.title
    ? `Station is currently playing: "${_nowPlayingContext.title}" by ${_nowPlayingContext.artist || "Unknown"}.`
    : "No song is currently playing.";

  const system = `You are Iris, the Executive Producer for ether radio. You are professional, sharp, and slightly witty. You have direct knowledge of the station's current state. Use radio terminology. Never break character. Be concise.\n\nCurrent station state: ${nowPlayingLine}`;

  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() || "No response.";

    } else if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 1000,
          messages: [{ role: "system", content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return data.choices?.[0]?.message?.content?.trim() || "No response.";

    } else if (provider === "google") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 1000 },
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "No response.";
    }
    return "Unknown provider.";
  } catch (e) {
    return `Request failed: ${e.message}`;
  }
});

let _rtmpProcess      = null;
let _recordStream     = null;

// ── RTMP destinations ─────────────────────────────────────────
ipcMain.handle("studio:rtmp:list", () => {
  try {
    return db.prepare("SELECT * FROM rtmp_destinations WHERE is_active = 1 ORDER BY name").all();
  } catch { return []; }
});

ipcMain.handle("studio:rtmp:save", (_, { id, name, url, key }) => {
  const { rtmpDestinationsCreate, rtmpDestinationsUpdateById } = require('./sync/handlers/rtmp_destinations');
  if (id) {
    rtmpDestinationsUpdateById(db, id, { name, url, stream_key: key || "" });
    return { id };
  } else {
    const row = rtmpDestinationsCreate(db, { station_id: getActiveStationId(), name, url, stream_key: key || "", is_active: 1 });
    return { id: row.id };
  }
});

ipcMain.handle("studio:rtmp:delete", (_, id) => {
  const { rtmpDestinationsUpdateById } = require('./sync/handlers/rtmp_destinations');
  rtmpDestinationsUpdateById(db, id, { is_active: 0 });
  return { ok: true };
});

// ── Audio I/O / FFmpeg ───────────────────────────────────────────
let ffmpegBin = null;
try {
  ffmpegBin = require("ffmpeg-static");
  // When bundled in asar, the binary lives in app.asar.unpacked
  if (ffmpegBin && ffmpegBin.includes("app.asar") && !ffmpegBin.includes("unpacked")) {
    ffmpegBin = ffmpegBin.replace("app.asar", "app.asar.unpacked");
  }
  console.log("[FFMPEG] Binary:", ffmpegBin);
} catch (e) {
  console.warn("[FFMPEG] ffmpeg-static not available:", e.message);
}

// ── AI Voice Studio (TTS generation + segment library) ──────────────────────
try {
  const { installAIVoice } = require("./ai-voice.js");
  installAIVoice(ipcMain, db, { userDataPath: app.getPath("userData") });
} catch (e) {
  console.warn("[AI-VOICE] installAIVoice failed:", e.message);
}

// ── Video engine (renderer composites; we run ffmpeg for RTMP/MP4) ─────────
try {
  const { installVideoEngine } = require("./video-engine.js");
  installVideoEngine(ipcMain, { ffmpegBin });
} catch (e) {
  console.warn("[video] installVideoEngine failed:", e.message);
}

// GPIO engine + Site Replication were here at MODULE LOAD, where `db` is still undefined (initDb()
// runs later, inside app.whenReady()) — so they installed against an undefined handle (db.exec →
// "Cannot read properties of undefined (reading 'exec')"). Moved into app.whenReady() AFTER initDb()
// (see the block after installStationMetadata) so they receive a real db.

// (Cloud backup installed in app.whenReady() after initDb())

// desktopCapturer source enumeration — needed by renderer to populate the
// screen/window picker. (renderer can't import desktopCapturer directly in
// modern Electron; it's main-only.)
ipcMain.handle("video:list-sources", async (_, kinds = ["screen", "window"]) => {
  try {
    const { desktopCapturer } = require("electron");
    const sources = await desktopCapturer.getSources({
      types: kinds,
      thumbnailSize: { width: 160, height: 90 },
      fetchWindowIcons: false,
    });
    return sources.map(s => ({
      id: s.id,                         // pass to setDesktopSource → handler picks this in callback
      name: s.name,
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : "",
    }));
  } catch (e) {
    console.error("[video] list-sources failed:", e);
    return [];
  }
});

// Modern Electron (>=22) replaces the legacy `chromeMediaSource: "desktop"`
// constraint with `navigator.mediaDevices.getDisplayMedia()` plus a main-side
// handler. The renderer pre-stores the picked source id below; the handler
// reads it and returns that source to the requesting page.
let pendingDesktopSourceId = null;
ipcMain.handle("video:set-desktop-source", (_, sourceId) => {
  pendingDesktopSourceId = sourceId || null;
  return true;
});

app.whenReady().then(() => {
  try {
    const { session, desktopCapturer } = require("electron");
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
        });
        const picked = pendingDesktopSourceId
          ? sources.find(s => s.id === pendingDesktopSourceId)
          : sources[0];
        pendingDesktopSourceId = null;
        if (!picked) { callback({ video: null }); return; }
        // Phase 4 audio: return system loopback when the renderer requested
        // audio: true. Windows-only — on macOS/Linux we omit the audio key.
        const wantsAudio = !!(request && request.audio);
        const isWin = process.platform === "win32";
        if (wantsAudio && isWin) {
          callback({ video: picked, audio: "loopback" });
        } else {
          callback({ video: picked });
        }
      } catch (e) {
        console.error("[video] display media handler error:", e);
        callback({ video: null });
      }
    }, { useSystemPicker: false });
    console.log("[video] setDisplayMediaRequestHandler installed");
  } catch (e) {
    console.warn("[video] failed to install display media handler:", e.message);
  }
});

function runFFmpeg(args) {
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => {
    if (!ffmpegBin) return reject(new Error("FFmpeg not bundled"));
    execFile(ffmpegBin, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(true);
    });
  });
}

// Write raw binary (Uint8Array / Buffer) to disk — used to persist recorded audio
ipcMain.handle("media:writeAudio", (_, { data, filePath }) => {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(data));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Encode a WAV/WebM/OGG source file to MP3 or WAV via FFmpeg
ipcMain.handle("ffmpeg:bounce-audio", async (_, { inputPath, outputPath, format }) => {
  const args = format === "mp3"
    ? ["-y", "-i", inputPath, "-codec:a", "libmp3lame", "-q:a", "2", outputPath]
    : ["-y", "-i", inputPath, "-codec:a", "pcm_s16le", outputPath];
  await runFFmpeg(args);
  return outputPath;
});

// Mix voice + music bed with per-track gain and music fade in/out
ipcMain.handle("ffmpeg:mix-audio", async (_, { voicePath, musicPath, voiceGain, musicGain, fadeDuration, outputPath }) => {
  const vg = Number(voiceGain) || 1;
  const mg = Number(musicGain) || 0.3;
  const fd = Number(fadeDuration) || 2;
  // Get voice duration for fade-out timing
  const { execFile } = require("child_process");
  let duration = 30;
  try {
    const probe = await new Promise((res) => {
      execFile(ffmpegBin, ["-i", voicePath], { maxBuffer: 1024 * 1024 }, (_, __, stderr) => {
        const m = stderr && stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        res(m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 30);
      });
    });
    duration = Number(probe) || 30;
  } catch {}
  const fadeOutStart = Math.max(0, duration - fd);
  const filter = [
    `[1:a]volume=${mg},afade=t=in:st=0:d=${fd},afade=t=out:st=${fadeOutStart}:d=${fd}[music]`,
    `[0:a]volume=${vg}[voice]`,
    `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[out]`,
  ].join(";");
  await runFFmpeg(["-y", "-i", voicePath, "-i", musicPath, "-filter_complex", filter, "-map", "[out]", "-codec:a", "libmp3lame", "-q:a", "2", outputPath]);
  return outputPath;
});

// Mux audio + video into MP4
ipcMain.handle("ffmpeg:bounce-video", async (_, { audioPath, videoPath, outputPath }) => {
  await runFFmpeg(["-y", "-i", videoPath, "-i", audioPath, "-c:v", "copy", "-c:a", "aac", "-shortest", outputPath]);
  return outputPath;
});

// Export: open save dialog and copy the rendered file there
ipcMain.handle("ffmpeg:export", async (_, { sourcePath, defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath("downloads"), defaultName || "clip-export"),
    filters: filters || [{ name: "Audio Files", extensions: ["mp3"] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.copyFileSync(sourcePath, result.filePath);
  return result.filePath;
});

// Return the clip auto-save directory path
ipcMain.handle("media:getSaveDir", () => {
  const dir = path.join(app.getPath("userData"), "clips");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});

// Return a temp directory path for intermediate files
ipcMain.handle("media:getTempDir", () => {
  const dir = path.join(app.getPath("temp"), "ether-clips");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});

// ── RTMP stream via ffmpeg ────────────────────────────────────
ipcMain.handle("studio:rtmp:start", (_, { url, key }) => {
  if (_rtmpProcess) return { ok: false, error: "Already streaming" };
  if (!key || !key.trim()) {
    return { ok: false, error: "Stream key required. Get it from your platform's live streaming settings (e.g. youtube.com/livestreaming)." };
  }
  const target = `${url}/${key.trim()}`;
  try {
    const { spawn } = require("child_process");
    _rtmpStreamStatus.statusState   = 'connecting';
    _rtmpStreamStatus.errorMsg      = null;
    _rtmpStreamStatus.speed         = null;
    _rtmpStreamStatus.bitrate       = null;
    _rtmpStreamStatus.startTime     = null;
    _rtmpStreamStatus.speedHistory  = [];
    _rtmpStreamStatus.destLabel     = _labelFromRtmpUrl(url);
    _emitDestStatus('rtmp:video', _rtmpStreamStatus);
    _emitGlobal();

    _rtmpProcess = spawn("ffmpeg", [
      "-re", "-f", "webm", "-i", "pipe:0",
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-c:a", "aac", "-ar", "44100", "-b:a", "128k",
      "-f", "flv", target,
    ], { stdio: ["pipe", "ignore", "pipe"] });

    _rtmpProcess.stderr.on("data", (d) => {
      const text = d.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.log("[STUDIO/ffmpeg]", trimmed.slice(0, 120));
        const parsed = _parseStreamLine(trimmed);
        if (parsed.errorMsg) {
          _rtmpStreamStatus.errorMsg = parsed.errorMsg;
          if (_rtmpStreamStatus.statusState === 'connecting') {
            _rtmpStreamStatus.statusState = 'error';
            _emitDestStatus('rtmp:video', _rtmpStreamStatus);
            _emitGlobal();
          }
        } else if (parsed.isLive && _rtmpStreamStatus.statusState === 'connecting') {
          _rtmpStreamStatus.statusState = 'live';
          _rtmpStreamStatus.startTime   = Date.now();
          _rtmpStreamStatus.errorMsg    = null;
          _emitDestStatus('rtmp:video', _rtmpStreamStatus);
          _emitGlobal();
        } else if (parsed.isProgress && _rtmpStreamStatus.statusState === 'live') {
          if (parsed.speed   !== null) { _rtmpStreamStatus.speed = parsed.speed; _rtmpStreamStatus.speedHistory = [..._rtmpStreamStatus.speedHistory.slice(-119), parsed.speed]; }
          if (parsed.bitrate !== null) _rtmpStreamStatus.bitrate = parsed.bitrate;
          _emitDestStatus('rtmp:video', _rtmpStreamStatus);
        }
      }
    });
    _rtmpProcess.on("error", (e) => {
      console.error("[STUDIO] ffmpeg error:", e.message);
      _rtmpProcess                  = null;
      _rtmpStreamStatus.statusState = 'error';
      _rtmpStreamStatus.errorMsg    = e.message;
      _emitDestStatus('rtmp:video', _rtmpStreamStatus);
      _emitGlobal();
      mainWindow?.webContents.send("studio:rtmp:stopped", { error: e.message });
    });
    _rtmpProcess.on("exit", (code) => {
      console.log("[STUDIO] ffmpeg exit:", code);
      _rtmpProcess                  = null;
      _rtmpStreamStatus.statusState = 'idle';
      _rtmpStreamStatus.speed       = null;
      _rtmpStreamStatus.bitrate     = null;
      _emitDestStatus('rtmp:video', _rtmpStreamStatus);
      _emitGlobal();
      mainWindow?.webContents.send("studio:rtmp:stopped", { code });
    });
    return { ok: true };
  } catch (e) {
    _rtmpStreamStatus.statusState = 'idle';
    _emitDestStatus('rtmp:video', _rtmpStreamStatus);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("studio:rtmp:chunk", (_, chunk) => {
  if (!_rtmpProcess) return;
  try { _rtmpProcess.stdin.write(Buffer.from(chunk)); } catch {}
});

ipcMain.handle("studio:rtmp:stop", () => {
  if (_rtmpProcess) {
    try { _rtmpProcess.stdin.end(); } catch {}
    _rtmpProcess = null;
  }
  _rtmpStreamStatus.statusState = 'idle';
  _rtmpStreamStatus.speed       = null;
  _rtmpStreamStatus.bitrate     = null;
  _emitDestStatus('rtmp:video', _rtmpStreamStatus);
  _emitGlobal();
  return { ok: true };
});

// ── Local recording via MediaRecorder chunks ──────────────────
ipcMain.handle("studio:record:start", (_, filePath) => {
  try {
    _recordStream = fs.createWriteStream(filePath, { flags: "w" });
    _recordStream.on("error", (e) => console.error("[STUDIO] Record write error:", e.message));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("studio:record:chunk", (_, chunk) => {
  if (!_recordStream) return;
  try { _recordStream.write(Buffer.from(chunk)); } catch {}
});

ipcMain.handle("studio:record:stop", () => {
  if (_recordStream) { _recordStream.end(); _recordStream = null; }
  return { ok: true };
});

ipcMain.handle("studio:record:saveClip", async (_, { path: filePath, data }) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(data));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Weather — OpenWeatherMap (Las Vegas) ──────────────────────
ipcMain.handle("weather:getLasVegas", async () => {
  const cfg = readAiConfig();
  const apiKey = decryptKey(cfg.keys?.weather) || process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Las+Vegas,US&appid=${apiKey}&units=imperial`);
    const data = await res.json();
    if (!res.ok) return null;
    return {
      temp:        Math.round(data.main.temp),
      feels_like:  Math.round(data.main.feels_like),
      description: data.weather?.[0]?.description || "",
      humidity:    data.main.humidity,
      wind_speed:  Math.round(data.wind?.speed || 0),
    };
  } catch { return null; }
});

// ── Iris bridge ───────────────────────────────────────────────
// Lets the Iris voice assistant control OpenAir via IPC or HTTP.

let irisConnected = false;
let irisLastSeen  = 0;

function sendToAllWindows(channel, payload) {
  BrowserWindow.getAllWindows().forEach(w => {
    try {
      if (!w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
        w.webContents.send(channel, payload);
      }
    } catch (e) {
      // Window or render frame was disposed mid-send — skip silently
    }
  });
}

function routeIrisCommand(cmd) {
  const { action, payload = {} } = cmd;
  switch (action) {
    case 'play':
      audio.audioPlay('A');
      sendToAllWindows('iris:command-received', { action, label: 'Playing deck A' });
      return { ok: true };

    case 'stop':
      audio.audioStop('A');
      sendToAllWindows('iris:command-received', { action, label: 'Stopped deck A' });
      return { ok: true };

    case 'next': {
      // Pause current deck — the auto-advance engine in the renderer handles loading next
      audio.audioPause('A');
      sendToAllWindows('iris:command-received', { action, label: 'Skip requested' });
      sendToAllWindows('iris:next-track', {});
      return { ok: true };
    }

    case 'getStatus': {
      let state = {};
      try { state = JSON.parse(audio.audioGetState()); } catch {}
      const deck = state.deckA ?? {};
      return {
        ok:     true,
        status: deck.status ?? 'unknown',
        title:  deck.title  ?? null,
        artist: deck.artist ?? null,
        queueLength: null   // renderer-side queue; not accessible from main
      };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// IPC: Iris electron app (same machine, future use)
ipcMain.handle('iris:command', (_, cmd) => routeIrisCommand(cmd));

// ── Browser Remote HTML (self-contained, no external deps) ──────
const REMOTE_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ether Remote</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Inter,system-ui,sans-serif;background:#0d0d0f;color:#e8e8f0;min-height:100vh;display:flex;flex-direction:column}
.header{padding:16px 20px;background:#111116;border-bottom:1px solid #1a1a22;display:flex;align-items:center;gap:12px}
.header h1{font-size:18px;font-weight:800;letter-spacing:-.03em}
.header .dot{width:8px;height:8px;border-radius:50%;background:#333}
.header .dot.live{background:#22c55e;box-shadow:0 0 8px #22c55e}
.np{padding:24px 20px;text-align:center;border-bottom:1px solid #1a1a22}
.np .title{font-size:22px;font-weight:700;margin-bottom:4px}
.np .artist{font-size:14px;color:#8878c0}
.np .status{font-size:11px;color:#6060a0;margin-top:8px;text-transform:uppercase;letter-spacing:.1em}
.controls{display:flex;justify-content:center;gap:12px;padding:24px 20px}
.btn{width:64px;height:64px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;transition:all .15s}
.btn.play{background:#22c55e;color:#000}.btn.play:active{background:#16a34a}
.btn.stop{background:#ef4444;color:#fff}.btn.stop:active{background:#dc2626}
.btn.skip{background:#141420;color:#8878c0;border:1px solid #1e1e2e}.btn.skip:active{background:#1e1e2e}
.btn.pause{background:#fbbf24;color:#000}.btn.pause:active{background:#f59e0b}
.decks{padding:16px 20px;display:flex;flex-direction:column;gap:8px}
.deck{padding:12px 16px;background:#111116;border:1px solid #1a1a22;display:flex;align-items:center;gap:12px}
.deck .id{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#000}
.deck .info{flex:1;min-width:0}
.deck .info .t{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deck .info .a{font-size:11px;color:#6060a0}
.deck .st{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px}
.log{padding:16px 20px;flex:1;overflow-y:auto}
.log h3{font-size:11px;font-weight:700;color:#6060a0;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px}
.log .entry{padding:6px 0;border-bottom:1px solid #111116;display:flex;gap:8px;font-size:12px}
.log .entry .time{color:#6060a0;font-family:'DM Mono',monospace;font-size:10px;flex-shrink:0;width:60px}
.refresh{text-align:center;padding:12px;font-size:10px;color:#6060a0}
</style></head>
<body>
<div class="header">
  <div class="dot" id="dot"></div>
  <h1>Ether Remote</h1>
  <span style="margin-left:auto;font-size:10px;color:#6060a0" id="conn">Connecting...</span>
</div>
<div class="np">
  <div class="title" id="title">—</div>
  <div class="artist" id="artist">Loading...</div>
  <div class="status" id="npstatus">—</div>
</div>
<div class="controls">
  <button class="btn play" onclick="api('transport/play')">&#9654;</button>
  <button class="btn pause" onclick="api('transport/pause')">&#10074;&#10074;</button>
  <button class="btn stop" onclick="api('transport/stop')">&#9632;</button>
  <button class="btn skip" onclick="api('transport/skip')">&#9197;</button>
</div>
<div class="decks" id="decks"></div>
<div class="log"><h3>Recent Plays</h3><div id="loglist"></div></div>
<div class="refresh" id="refresh"></div>
<script>
const BASE=location.origin;
async function api(path,method='POST'){try{const r=await fetch(BASE+'/api/'+path,{method});return await r.json()}catch{return{ok:false}}}
async function poll(){
  try{
    const s=await(await fetch(BASE+'/api/status')).json();
    const d=s.deckA||{};
    document.getElementById('title').textContent=d.title||'No Track';
    document.getElementById('artist').textContent=d.artist||'—';
    document.getElementById('npstatus').textContent=d.status||'stopped';
    document.getElementById('dot').className='dot'+(d.status==='playing'?' live':'');
    document.getElementById('conn').textContent='Connected';
    // Decks
    let html='';
    for(const[k,color] of [['deckA','#38bdf8'],['deckB','#34d399'],['deckC','#a78bfa']]){
      const dk=s[k]||{};
      const st=dk.status||'empty';
      const stColor=st==='playing'?'#22c55e':st==='paused'?'#fbbf24':'#333';
      html+='<div class="deck"><div class="id" style="background:'+color+'">'+k.slice(-1)+'</div><div class="info"><div class="t">'+(dk.title||'—')+'</div><div class="a">'+(dk.artist||'')+'</div></div><div class="st" style="color:'+stColor+'">'+st+'</div></div>';
    }
    document.getElementById('decks').innerHTML=html;
    // Log
    const log=await(await fetch(BASE+'/api/log')).json();
    let lhtml='';
    for(const e of (log.entries||[]).slice(0,15)){
      const t=new Date(e.played_at*1000);
      lhtml+='<div class="entry"><span class="time">'+t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span><span>'+e.title+'</span></div>';
    }
    document.getElementById('loglist').innerHTML=lhtml;
    document.getElementById('refresh').textContent='Last updated: '+new Date().toLocaleTimeString();
  }catch(e){document.getElementById('conn').textContent='Disconnected';document.getElementById('dot').className='dot'}
}
poll();setInterval(poll,2000);
</script></body></html>`;

// ── Iris live-wire SSE (L1) ──────────────────────────────────
// The renderer pushes consolidated state (now-playing + position + up-next) via the
// 'iris:state' IPC channel; we relay it to connected Iris clients over /api/stream as
// Server-Sent Events. The renderer is the only path-independent source of position and
// the queue (the native engine state has neither), so the feed is renderer-driven.
// Presence falls out of the connection: an open stream means Iris is connected.
const sseClients = new Set();
let latestIrisState = null;
let streamAnyLive = false, streamLiveCount = 0;
let _sseNpSig = "", _sseQSig = "";

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
}
function sseBroadcast(event, data) { for (const res of sseClients) sseWrite(res, event, data); }
function buildIrisSnapshot() {
  const base = latestIrisState || { playing: false, nowPlaying: null, decks: {}, upNext: [] };
  return { ...base, airLive: streamAnyLive, liveCount: streamLiveCount };
}
function sseAirstate(anyLive, liveCount) {
  streamAnyLive = !!anyLive; streamLiveCount = liveCount || 0;
  sseBroadcast("airstate", { live: streamAnyLive, liveCount: streamLiveCount });
}

ipcMain.on("iris:state", (_evt, s) => {
  latestIrisState = s;
  irisLastSeen = Date.now();
  if (!sseClients.size) return;
  const np = s && s.nowPlaying ? s.nowPlaying : null;
  // position — every tick, powers back-timing ("ending in N")
  if (np) sseBroadcast("position", {
    deck: np.deck, positionSec: np.positionSec || 0, durationSec: np.durationSec || 0,
    remainingSec: Math.max(0, (np.durationSec || 0) - (np.positionSec || 0)),
  });
  // nowplaying — on change only
  const npSig = np ? `${np.deck}|${np.title}|${np.artist}` : "none";
  if (npSig !== _sseNpSig) { _sseNpSig = npSig; sseBroadcast("nowplaying", np); }
  // queue — on change only
  const upNext = (s && s.upNext) || [];
  const qSig = upNext.map(q => q && q.title).join("|");
  if (qSig !== _sseQSig) { _sseQSig = qSig; sseBroadcast("queue", { upNext }); }
});

// Keepalive comment so idle SSE connections aren't dropped by proxies/clients.
setInterval(() => { for (const res of sseClients) { try { res.write(": keepalive\n\n"); } catch { /* gone */ } } }, 15000);

// HTTP: REST API on port 3400 — serves Iris commands + public API
// Accessible by external systems for automation, traffic integration, and monitoring.
const irisHttpServer = require('http').createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url = req.url?.split("?")[0] || "/";
  const qs = Object.fromEntries(new URL("http://x" + (req.url || "/")).searchParams);

  // ── Browser Remote Control (Zetta2GO equivalent) ──
  if (req.method === 'GET' && (url === '/remote' || url === '/remote/')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(REMOTE_HTML);
    return;
  }

  // ── Iris legacy ──
  if (req.method === 'GET' && url === '/ping') {
    irisConnected = true; irisLastSeen = Date.now();
    sendToAllWindows('iris:connected', true);
    res.end(JSON.stringify({ ok: true, pong: true })); return;
  }
  if (req.method === 'POST' && url === '/') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { const cmd = JSON.parse(body); irisConnected = true; irisLastSeen = Date.now(); res.end(JSON.stringify(routeIrisCommand(cmd))); }
      catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); }
    }); return;
  }

  // ── REST API ──────────────────────────────────────────────────
  // GET  /api/status          — full station status (decks, queue, on-air)
  // GET  /api/now-playing     — current track metadata
  // POST /api/transport/:action  — play/pause/stop/skip (deck=A default, ?deck=B)
  // GET  /api/queue           — current queue
  // GET  /api/log             — recent play log (last 50)
  // POST /api/macro/:id/run   — execute a macro by id
  // GET  /api/macros          — list all macros
  // GET  /api/gpio/status     — GPIO connection status

  // GET /health — HA supervisor heartbeat (Phase 1). MUST stay lock-free and
  // non-blocking: it reads only Node-native values + the atomic audio-liveness
  // getter. It deliberately does NOT call audio.audioGetState() (that locks the
  // per-station Mutex and could stall during a write). The watchdog's liveness
  // decision uses just two things: that this responds at all (main process not
  // hung) and audio.alive (engine thread still firing callbacks).
  if (req.method === 'GET' && url === '/health') {
    res.end(JSON.stringify(buildHealthSnapshot()));
    return;
  }

  if (req.method === 'GET' && url === '/api/status') {
    let state = {};
    try { state = JSON.parse(audio.audioGetState()); } catch {}
    res.end(JSON.stringify({ ok: true, ...state, timestamp: Date.now() })); return;
  }

  if (req.method === 'GET' && url === '/api/now-playing') {
    let state = {};
    try { state = JSON.parse(audio.audioGetState()); } catch {}
    const deck = state.deckA || {};
    res.end(JSON.stringify({
      ok: true, title: deck.title || null, artist: deck.artist || null,
      status: deck.status || "stopped", positionSec: deck.positionSec || 0,
      durationSec: deck.durationSec || 0,
    })); return;
  }

  if (req.method === 'POST' && url.startsWith('/api/transport/')) {
    const action = url.replace('/api/transport/', '');
    const deck = qs.deck || 'A';
    try {
      if (action === 'play')  audio.audioPlay(deck);
      else if (action === 'pause') audio.audioPause(deck);
      else if (action === 'stop')  audio.audioStop(deck);
      else if (action === 'skip')  { audio.audioPause('A'); sendToAllWindows('iris:next-track', {}); }
      else { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: `Unknown action: ${action}` })); return; }
      sendToAllWindows('iris:command-received', { action, label: `${action} deck ${deck}` });
      res.end(JSON.stringify({ ok: true, action, deck }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'GET' && url === '/api/log') {
    try {
      const rows = db.prepare("SELECT * FROM play_log ORDER BY played_at DESC LIMIT 50").all();
      res.end(JSON.stringify({ ok: true, entries: rows }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'GET' && url === '/api/macros') {
    try {
      const rows = db.prepare("SELECT id, name, description, trigger_type, hotkey, is_active FROM macros ORDER BY name").all();
      res.end(JSON.stringify({ ok: true, macros: rows }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/macro/') && url.endsWith('/run')) {
    const macroId = parseInt(url.replace('/api/macro/', '').replace('/run', ''));
    try {
      const row = db.prepare("SELECT * FROM macros WHERE id = ?").get(macroId);
      if (!row) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: "Macro not found" })); return; }
      // Send to renderer for execution (macros run in the renderer context)
      sendToAllWindows('macro:execute', { id: macroId, name: row.name });
      res.end(JSON.stringify({ ok: true, macro: row.name, status: "dispatched" }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'GET' && url === '/api/gpio/status') {
    try {
      const devices = db.prepare("SELECT id, name, protocol, host, port, is_active FROM gpio_devices").all();
      res.end(JSON.stringify({ ok: true, devices }));
    } catch (e) { res.end(JSON.stringify({ ok: true, devices: [] })); }
    return;
  }

  // Site replication — serve changes to peers
  if (req.method === 'GET' && url === '/api/repl/changes') {
    try {
      const tableName = qs.table || "songs";
      const since = parseInt(qs.since) || 0;
      // Use the repl:get-changes IPC to get data
      const siteIdRow = db.prepare("SELECT value FROM replication_config WHERE key = 'site_id'").get();
      const SYNC_TABLES = ["songs","shows","clocks","spots","macros","categories","separation_rules","smart_schedule_rules"];
      if (!SYNC_TABLES.includes(tableName)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "Unknown table" })); return; }
      const rows = db.prepare(`SELECT * FROM ${tableName} LIMIT 500`).all();
      res.end(JSON.stringify({ ok: true, siteId: siteIdRow?.value, table: tableName, rows, count: rows.length }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'GET' && url === '/api/repl/site-id') {
    try {
      const row = db.prepare("SELECT value FROM replication_config WHERE key = 'site_id'").get();
      res.end(JSON.stringify({ ok: true, siteId: row?.value }));
    } catch { res.end(JSON.stringify({ ok: true, siteId: null })); }
    return;
  }

  // POST /api/captions/iris — Iris app sends its spoken text here so it
  // appears in the captions overlay even before Whisper could transcribe it.
  if (req.method === 'POST' && req.url === '/api/captions/iris') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (text) {
          whisperEngine.addIrisLine(text);
          // whisperEngine already emits 'line' which is relayed to renderer below
        }
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  // GET /api/stream — Iris live-wire SSE (L1). An open connection = Iris present.
  if (req.method === 'GET' && url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    irisConnected = true; irisLastSeen = Date.now();
    sendToAllWindows('iris:connected', true);
    sseWrite(res, 'snapshot', buildIrisSnapshot());
    req.on('close', () => {
      sseClients.delete(res);
      if (sseClients.size === 0) { irisConnected = false; sendToAllWindows('iris:connected', false); }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'Not found. Endpoints: /api/status, /api/now-playing, /api/stream, /api/transport/:action, /api/log, /api/macros, /api/macro/:id/run, /api/gpio/status, /api/repl/changes, /api/repl/site-id, /api/captions/iris' }));
});

irisHttpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[API] Port 3400 already in use — REST API disabled. Is another Ether instance running?');
  } else {
    console.error('[API] HTTP server error:', err.message);
  }
});
irisHttpServer.listen(3400, '0.0.0.0', () => {
  console.log('[API] REST server listening on http://0.0.0.0:3400');
  // HA: /health can now answer, so a (re)spawned watchdog can adopt us instead of
  // racing into a fresh spawn. Run the --enable-ha/--disable-ha bootstrap here,
  // then begin mutual supervision (no-op unless launched under a watchdog).
  handleHaBootstrapFlags();
  startWatchdogMonitor();
});

// Mark Iris disconnected if no ping for 30 seconds. Skipped while an SSE stream is
// open — the /api/stream connection (and its close handler) is the authority on
// presence for live-wire clients; legacy /ping clients still rely on this timeout.
setInterval(() => {
  if (sseClients.size > 0) return;
  if (irisConnected && Date.now() - irisLastSeen > 30000) {
    irisConnected = false;
    sendToAllWindows('iris:connected', false);
  }
}, 5000);

// ── Part 8 — Spotify Library Integration ─────────────────────
// Credentials stored via safeStorage (same helper as AI keys).
// Spotify token cached in memory; refreshed automatically.

let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

function getSpotifyConfig() {
  const cfg = readAiConfig();
  return {
    clientId:     decryptKey(cfg.keys?.spotify_client_id)  || null,
    clientSecret: decryptKey(cfg.keys?.spotify_client_secret) || null,
  };
}

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;
  const { clientId, clientSecret } = getSpotifyConfig();
  if (!clientId || !clientSecret) return null;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) return null;
  const data = await res.json();
  _spotifyToken = data.access_token || null;
  _spotifyTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
  return _spotifyToken;
}

ipcMain.handle("spotify:setCredentials", (_, { clientId, clientSecret }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  if (clientId)     cfg.keys.spotify_client_id     = encryptKey(clientId);
  if (clientSecret) cfg.keys.spotify_client_secret = encryptKey(clientSecret);
  writeAiConfig(cfg);
  _spotifyToken = null; // force token refresh
  return true;
});

ipcMain.handle("spotify:getCredentialStatus", () => {
  const { clientId, clientSecret } = getSpotifyConfig();
  return { hasClientId: !!clientId, hasClientSecret: !!clientSecret };
});

ipcMain.handle("spotify:getRecommendations", async (_, { seeds, valence, energy, speechiness, limit }) => {
  try {
    const token = await getSpotifyToken();
    if (!token) return { ok: false, error: "No Spotify credentials — add Client ID and Secret in Settings > AI & Integrations" };

    const params = new URLSearchParams({
      limit: String(Math.min(limit || 100, 100)), // Spotify max per call is 100
      seed_genres: (seeds || ["pop"]).slice(0, 5).join(","), // Spotify max 5 seeds
      target_valence:    String(valence    ?? 0.7),
      min_valence:       String(Math.max(0, (valence ?? 0.7) - 0.2)),
      target_energy:     String(energy     ?? 0.7),
      min_energy:        String(Math.max(0, (energy  ?? 0.7) - 0.2)),
      max_speechiness:   String(speechiness ?? 0.05),
      target_popularity: "60",
    });

    const res = await fetch(`https://api.spotify.com/v1/recommendations?${params}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.error?.message || `Spotify API error ${res.status}` };
    }
    const data = await res.json();
    const tracks = (data.tracks || [])
      .filter(t => !t.explicit) // server-side explicit filter
      .map(t => ({
        title:       t.name,
        artist:      t.artists?.map(a => a.name).join(", ") || "Unknown",
        album:       t.album?.name || "",
        durationMs:  t.duration_ms,
        spotifyUri:  t.uri,
        spotifyId:   t.id,
        explicit:    t.explicit,
        previewUrl:  t.preview_url || null,
        imageUrl:    t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
        valence:     null, // available in audio features, not recommendations response
        energy:      null,
        speechiness: null,
      }));
    return { ok: true, tracks };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Musixmatch lyric scan — fetches lyrics then checks for red-flag terms
const LYRIC_FLAG_CATEGORIES = {
  violence:    ["kill", "murder", "shoot", "gun", "knife", "blood", "dead", "death", "violent", "stab", "assault", "rape", "bomb", "terrorist", "weapon", "slaughter"],
  sexual:      ["sex", "naked", "pussy", "dick", "cock", "fuck", "bitch", "ass", "booty", "twerk", "strip", "lust", "orgasm", "explicit", "erotic", "horny"],
  hate_speech: ["nigger", "nigga", "faggot", "spic", "kike", "slut", "whore", "retard", "cunt"],
  political:   ["trump", "biden", "democrat", "republican", "maga", "antifa", "blm", "protest", "revolution"],
};

ipcMain.handle("musixmatch:setKey", (_, { key }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  cfg.keys.musixmatch = encryptKey(key);
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("musixmatch:getKeyStatus", () => {
  const cfg = readAiConfig();
  return { hasKey: !!(cfg.keys?.musixmatch) };
});

ipcMain.handle("musixmatch:scanLyrics", async (_, { title, artist }) => {
  try {
    const cfg = readAiConfig();
    const apiKey = decryptKey(cfg.keys?.musixmatch);
    if (!apiKey) return { ok: false, error: "No Musixmatch API key — add it in Settings > AI & Integrations" };

    const searchUrl = `https://api.musixmatch.com/ws/1.1/matcher.lyrics.get?format=json&q_track=${encodeURIComponent(title)}&q_artist=${encodeURIComponent(artist)}&apikey=${apiKey}`;
    const res = await fetch(searchUrl);
    const data = await res.json();

    const statusCode = data?.message?.header?.status_code;
    if (statusCode !== 200) {
      // 404 = lyrics not found — treat as clean (no lyrics = can't scan)
      return { ok: true, found: false, flagged: false, matches: [] };
    }

    const lyrics = (data?.message?.body?.lyrics?.lyrics_body || "").toLowerCase();
    if (!lyrics) return { ok: true, found: false, flagged: false, matches: [] };

    const matches = [];
    for (const [category, terms] of Object.entries(LYRIC_FLAG_CATEGORIES)) {
      for (const term of terms) {
        if (lyrics.includes(term)) {
          matches.push({ category, term });
        }
      }
    }
    return { ok: true, found: true, flagged: matches.length > 0, matches };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Discogs metadata lookup ───────────────────────────────────

let _discogsLastCall = 0;

function getDiscogsConfig() {
  const cfg = readAiConfig();
  const key    = cfg.keys?.discogs_consumer_key    ? decryptKey(cfg.keys.discogs_consumer_key)    : null;
  const secret = cfg.keys?.discogs_consumer_secret ? decryptKey(cfg.keys.discogs_consumer_secret) : null;
  return { key, secret };
}

ipcMain.handle("discogs:setCredentials", (_, { consumerKey, consumerSecret }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  if (consumerKey)    cfg.keys.discogs_consumer_key    = encryptKey(consumerKey);
  if (consumerSecret) cfg.keys.discogs_consumer_secret = encryptKey(consumerSecret);
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("discogs:getCredentialStatus", () => {
  const { key, secret } = getDiscogsConfig();
  return { hasKey: !!key, hasSecret: !!secret };
});

ipcMain.handle("discogs:search", async (_, { title, artist }) => {
  try {
    const { key, secret } = getDiscogsConfig();
    if (!key) return { ok: false, error: "No Discogs credentials — add them in Settings > Integrations" };

    // Rate limit: 1 req/sec
    const now = Date.now();
    const wait = 1000 - (now - _discogsLastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _discogsLastCall = Date.now();

    const q = [title, artist].filter(Boolean).join(" ");
    const url = `https://api.discogs.com/database/search?type=release&q=${encodeURIComponent(q)}&per_page=5&key=${encodeURIComponent(key)}&secret=${encodeURIComponent(secret)}`;
    const res = await fetch(url, { headers: { "User-Agent": "Ether/1.0 +https://ether-technologies.com" } });
    if (!res.ok) return { ok: false, error: `Discogs returned ${res.status}` };
    const data = await res.json();

    const results = (data.results || []).slice(0, 5).map(r => ({
      id:        r.id,
      title:     r.title || "",
      artist:    Array.isArray(r.artists) ? r.artists.map(a => a.name).join(", ") : (r.title || "").split(" - ")[0] || "",
      album:     r.title || "",
      year:      r.year ? parseInt(r.year, 10) : null,
      genre:     (r.genre || r.style || []).slice(0, 1)[0] || null,
      thumb:     r.thumb || r.cover_image || null,
      format:    (r.format || []).join(", ") || null,
      label:     (r.label || []).join(", ") || null,
      catno:     r.catno || null,
    }));

    return { ok: true, results };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("discogs:updateTrack", (_, { id, title, artist, album, year, genre, bpm }) => {
  try {
    const { artistsFindOrCreateByName } = require('./sync/handlers/artists');
    const { albumsFindOrCreate } = require('./sync/handlers/albums');
    const { songsUpdateById } = require('./sync/handlers/songs');

    // Upsert artist
    const artistRow = artist ? artistsFindOrCreateByName(db, artist) : null;
    const artistId = artistRow?.id ?? null;

    // Upsert album + year
    let albumId = null;
    if (album) {
      const albumRow = albumsFindOrCreate(db, { title: album, artistId, year: year ?? null });
      albumId = albumRow?.id ?? null;
    }

    const patch = {};
    if (title    !== undefined) patch.title     = title;
    if (artistId !== undefined) patch.artist_id = artistId;
    if (albumId  !== undefined) patch.album_id  = albumId;
    if (genre    !== undefined) patch.genre     = genre;
    if (bpm      !== undefined) patch.bpm       = bpm;
    if (Object.keys(patch).length === 0) return { ok: true };
    songsUpdateById(db, id, patch);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Assign (or clear) a library element's cart number. Goes through songsUpdateById so the
// change is logged as a mutation and syncs like any other song edit. cart_id is a free-form
// operator handle (e.g. "1001", "J14", "TALK7"); empty string clears it.
ipcMain.handle("songs:set-cart-id", (_, { id, cartId }) => {
  try {
    const { songsUpdateById } = require('./sync/handlers/songs');
    const v = (cartId == null || String(cartId).trim() === "") ? null : String(cartId).trim();
    songsUpdateById(db, id, { cart_id: v });
    return { ok: true, cart_id: v };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Write a Spotify-imported track to the songs table
ipcMain.handle("library:writeTrack", (_, { title, artist, album, durationMs, spotifyUri }) => {
  try {
    const { artistsFindOrCreateByName } = require('./sync/handlers/artists');
    const { albumsFindOrCreate } = require('./sync/handlers/albums');
    const { songsCreate } = require('./sync/handlers/songs');

    // Upsert artist
    const artistRow = artistsFindOrCreateByName(db, artist || "Unknown");
    const artistId = artistRow?.id || null;

    // Upsert album
    let albumId = null;
    if (album && artistId) {
      const albumRow = albumsFindOrCreate(db, { title: album, artistId });
      albumId = albumRow?.id || null;
    }

    // Insert song — no file_path (stream-only via Spotify URI)
    const existing = db.prepare("SELECT id FROM songs WHERE title = ? AND artist_id = ?").get(title, artistId);
    if (existing) return { ok: true, id: existing.id, skipped: true };

    const row = songsCreate(db, {
      title, artist_id: artistId, album_id: albumId,
      duration_ms: durationMs || 0, is_explicit: 0,
      spotify_uri: spotifyUri || null, rotation_status: 'active', daypart_mask: 16777215,
    });
    return { ok: true, id: row.id, skipped: false };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Theme export / import (.ethertheme files) ─────────────────

ipcMain.handle("theme:export", async (_, { presetId, vars, font }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export Theme",
      defaultPath: `ether-theme-${presetId || "custom"}.ethertheme`,
      filters: [{ name: "Ether Theme", extensions: ["ethertheme"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const payload = { presetId, vars, font: font || null, version: 1 };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, filePath: result.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("theme:import", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Theme",
      properties: ["openFile"],
      filters: [{ name: "Ether Theme", extensions: ["ethertheme", "json"] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const raw = fs.readFileSync(result.filePaths[0], "utf8");
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Station logo (base64 stored in station_config_kv) ─────────

ipcMain.handle("station:uploadLogo", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose Station Logo",
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "svg", "webp"] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const filePath = result.filePaths[0];
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mime = ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg";
    const b64 = `data:${mime};base64,${buf.toString("base64")}`;
    return { ok: true, dataUrl: b64 };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Captions / Live Transcription (Whisper) ───────────────────
//
// Architecture:
//   1. Renderer opens a WASAPI loopback tap via getUserMedia with
//      chromeMediaSource:'desktop' and a ScriptProcessorNode.
//   2. Float32 16 kHz mono PCM chunks arrive via captions:audio-chunk IPC.
//   3. whisper-engine.js accumulates 5-second windows and runs inference.
//   4. Each result is emitted back to the renderer as captions:line.
//   5. Iris spoken text is injected directly via addIrisLine() so it
//      appears instantly without waiting for Whisper to hear it.

const whisperEngine = require('./whisper-engine');

// Relay transcription lines to all renderer windows
whisperEngine.on('line', (line) => {
  sendToAllWindows('captions:line', line);
});

whisperEngine.on('status', (status) => {
  sendToAllWindows('captions:status', status);
});

// Start / stop loopback capture
ipcMain.handle('captions:start', async () => {
  whisperEngine.start();
  return { ok: true };
});

ipcMain.handle('captions:stop', async () => {
  whisperEngine.stop();
  return { ok: true };
});

// PCM Float32 chunks from renderer ScriptProcessorNode (16 kHz mono)
ipcMain.on('captions:audio-chunk', (_evt, float32Array) => {
  whisperEngine.feedSamples(float32Array);
});

// Direct Iris injection — also callable from renderer (e.g. if Iris speaks
// via the local TTS fallback path)
ipcMain.handle('captions:iris-line', (_evt, text) => {
  whisperEngine.addIrisLine(text);
  return { ok: true };
});

// Return the full rolling 60-second transcript on demand
ipcMain.handle('captions:get-transcript', () => {
  return whisperEngine.getTranscript();
});

// Provide a desktopCapturer source ID to the renderer so getUserMedia
// can open WASAPI loopback without showing the OS picker dialog.
ipcMain.handle('captions:get-loopback-source', async () => {
  const { desktopCapturer } = require('electron');
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  // Return the first screen source — its ID is used to route audio loopback
  return sources[0]?.id || null;
});

// ── R2 track cache — download a file from R2 to a local temp dir ─────────────
// Used by the deck queue so local playback and cloud playback share the same
// R2 source. Once cached the file is reused without re-downloading.

// Where the music library is stored. Default = <userData>/r2-cache, but the operator can pick a
// folder during cloud sync (e.g. a big drive). Persisted in a FILE (not the DB) so it survives the
// install-from-cloud DB swap. getMusicDir() always returns an existing dir.
const R2_CACHE_DIR    = path.join(app.getPath('userData'), 'r2-cache'); // default / fallback
const MUSIC_DIR_FILE  = path.join(app.getPath('userData'), 'music-dir.txt');
function getMusicDir() {
  let dir = R2_CACHE_DIR;
  try { const p = fs.readFileSync(MUSIC_DIR_FILE, 'utf8').trim(); if (p) dir = p; } catch {}
  try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = R2_CACHE_DIR; try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
  return dir;
}
function setMusicDir(dir) {
  const d = String(dir || '').trim();
  if (!d) return { ok: false, error: 'empty path' };
  try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(MUSIC_DIR_FILE, d); return { ok: true, dir: d }; }
  catch (e) { return { ok: false, error: e.message }; }
}
fs.mkdirSync(R2_CACHE_DIR, { recursive: true });
ipcMain.handle('music:get-dir', () => ({ ok: true, dir: getMusicDir(), default: R2_CACHE_DIR }));
ipcMain.handle('music:set-dir', (_, dir) => setMusicDir(dir));

// Fetch a track from R2 via the backend-signed flow. Returns the same shape
// as the ipcMain.handle('r2:fetch-track') IPC contract — extracted as a
// standalone function in Phase 1.3k so audio:load can call it directly from
// main-process code without round-tripping through ipcMain. The IPC handler
// below is a thin wrapper.
//
// Tier gate (Network+) and license_key check live here, so callers (the
// 'r2:fetch-track' handler AND audio:load's fallback path) get a single
// source of truth for the gate. Cache layer unchanged — see OB7 for
// unbounded growth; see OB8 for concurrent-fetch dedup.
// The member token for the currently-active station, if it's a member-operated station (one station
// is active at a time, so the active station determines which credential addresses its R2 audio).
// Tokens are minted by pullMemberStation and held in app._memberTokens (uuid → token). Null for an
// owned active station → fetchR2Track uses this install's license key, unchanged.
function memberTokenForActiveStation() {
  try {
    if (!app._memberTokens || app._memberTokens.size === 0) return null;
    const uuid = db.prepare('SELECT uuid FROM stations WHERE is_active=1 AND deleted_at IS NULL LIMIT 1').get()?.uuid;
    return uuid ? (app._memberTokens.get(uuid) || null) : null;
  } catch (_) { return null; }
}

async function fetchR2Track(fileKey) {
  if (!fileKey) return { ok: false, error: 'No file_key' };

  // Member-operated active station: fetch its audio under the MEMBER token (the operated account's R2
  // prefix), bypassing this install's license/tier gate — the active membership IS the authorization.
  const memberToken = memberTokenForActiveStation();
  const TIER_RANK_LOCAL = { free: 0, pro: 1, pro_lifetime: 1, station: 2, station_lifetime: 2, operator: 3 };
  let licenseKey = null;
  if (!memberToken) {
    // Tier gate — Network+ only
    const planTier = (db.prepare("SELECT value FROM station_config_kv WHERE key='plan_tier' LIMIT 1").get())?.value || 'free';
    if ((TIER_RANK_LOCAL[planTier] || 0) < TIER_RANK_LOCAL.station) {
      return { ok: false, error: `Audio fetch from cloud requires Network (station) tier or higher — current: ${planTier}` };
    }
    // License key required
    licenseKey = (db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL LIMIT 1").get())?.value;
    if (!licenseKey) return { ok: false, error: 'No license_key in station_config_kv' };
  }

  const safeName  = path.basename(fileKey).replace(/[^a-zA-Z0-9._-]/g, '_');
  const cachePath = path.join(getMusicDir(), safeName);

  // Cache hit path — short-circuit
  if (fs.existsSync(cachePath)) return { ok: true, filePath: cachePath };

  try {
    // 1. Request signed GET URL from backend — member Bearer for an operated station, else license key.
    const urlRes = await fetch(`${ETHER_BACKEND_URL}/audio/download-url`, {
      method:  'POST',
      headers: memberToken
        ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + memberToken }
        : { 'Content-Type': 'application/json' },
      body:    JSON.stringify(memberToken ? { file_key: fileKey } : { license_key: licenseKey, file_key: fileKey }),
    });
    const urlData = await urlRes.json().catch(() => ({}));
    if (!urlRes.ok || !urlData.signed_url) {
      throw new Error(urlData.error || urlData.detail || `signing failed (HTTP ${urlRes.status})`);
    }

    // 2. GET the bytes from the signed URL
    const getRes = await fetch(urlData.signed_url);
    if (!getRes.ok) {
      const text = await getRes.text().catch(() => '');
      throw new Error(`R2 GET failed: HTTP ${getRes.status} — ${text.slice(0, 200)}`);
    }
    const buf = Buffer.from(await getRes.arrayBuffer());

    // 3. Atomic write via temp+rename so an interrupted fetch doesn't leave a
    //    partial file at cachePath.
    const tempPath = cachePath + '.tmp';
    fs.writeFileSync(tempPath, buf);
    fs.renameSync(tempPath, cachePath);

    console.log(`[fetchR2Track] cached ${safeName} (${(buf.length / 1e6).toFixed(1)} MB)`);
    return { ok: true, filePath: cachePath };
  } catch (e) {
    // Clean up any .tmp left from a failed write
    try { fs.unlinkSync(cachePath + '.tmp'); } catch {}
    return { ok: false, error: e.message };
  }
}

// IPC wrapper — preserves the contract for loggen.ts:439 and any future
// renderer callers. Logic lives in fetchR2Track above.
ipcMain.handle('r2:fetch-track', async (_, fileKey) => fetchR2Track(fileKey));

// ── Playout server config ─────────────────────────────────────────────────────
ipcMain.handle('playout:get-server', () => {
  try {
    const row = db.prepare("SELECT value FROM station_config_kv WHERE key='playout_server'").get();
    return row?.value?.trim() || '44.244.52.207';
  } catch { return '44.244.52.207'; }
});

ipcMain.handle('playout:set-server', (_, ip) => {
  try {
    const trimmed = String(ip).trim();
    const { stationConfigKvUpsertByKey } = require('./sync/handlers/station_config_kv');
    stationConfigKvUpsertByKey(db, getActiveStationId(), 'playout_server', trimmed);
    // Keep stations table in sync so stream:go-live reads the updated value
    const { stationsUpdateById } = require('./sync/handlers/stations');
    stationsUpdateById(db, getActiveStationId(), { icecast_server_url: trimmed });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Real-time cloud playout sync ──────────────────────────────────────────────
// Fired by the renderer whenever a deck starts playing a new track.
// POSTs to the cloud playout server so it mirrors the live deck in real time.

let _playoutLastPing = 0;  // epoch ms of last successful play POST

// ── Schedule Generator ────────────────────────────────────────────────────────
// Reads shows → clocks → clock_slots, picks songs per rotation rules, and
// writes a full week of timestamped entries to generated_schedule.
// Place a voice track into the playout log so it airs at a chosen transition.
// We slot it just before the upcoming scheduled row for the song the break sits in front of
// (matched by title/artist), giving it a direct file_path (it isn't a library song).
ipcMain.handle('schedule:insertVoiceTrack', (_, { stationId, hour, beforeTitle, beforeArtist, filePath, title, artist, durationMs }) => {
  try {
    const sid = stationId ?? getActiveStationId();
    const nowTs = Math.floor(Date.now() / 1000);
    let row = db.prepare(
      `SELECT id, scheduled_at FROM generated_schedule
       WHERE station_id = ? AND title = ? AND (artist = ? OR ? = '') AND scheduled_at >= ? - 300 AND deleted_at IS NULL
       ORDER BY scheduled_at LIMIT 1`
    ).get(sid, beforeTitle, beforeArtist || '', beforeArtist || '', nowTs);
    if (!row) row = db.prepare(
      `SELECT id, scheduled_at FROM generated_schedule
       WHERE station_id = ? AND title = ? AND scheduled_at >= ? - 300 AND deleted_at IS NULL
       ORDER BY scheduled_at LIMIT 1`
    ).get(sid, beforeTitle, nowTs);
    if (!row) return { ok: false, error: 'that song is not in the upcoming schedule yet' };
    const at = row.scheduled_at - 1;
    db.prepare(
      `INSERT INTO generated_schedule (scheduled_at, song_id, title, artist, file_path, duration_s, station_id, uuid, generated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, unixepoch())`
    ).run(at, title, artist || '', filePath, Math.round((durationMs || 0) / 1000), sid, require('crypto').randomUUID());
    return { ok: true, scheduledAt: at };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('schedule:generate', (_, days = 7) => {
  try {
    // Load separation rules (fall back to safe defaults)
    let artistSepMin = 60;
    let songRepeatMin = 180;
    let titleSepMin = 120;
    try {
      const ar = db.prepare("SELECT value FROM separation_rules WHERE rule_type='artist_separation_min' AND is_active=1 LIMIT 1").get();
      if (ar) artistSepMin = ar.value;
      const sr = db.prepare("SELECT value FROM separation_rules WHERE rule_type='song_separation_min' AND is_active=1 LIMIT 1").get();
      if (sr) songRepeatMin = sr.value;
      const tr = db.prepare("SELECT value FROM separation_rules WHERE rule_type='title_separation_min' AND is_active=1 LIMIT 1").get();
      if (tr) titleSepMin = tr.value;
    } catch {}

    const { generatedScheduleClearAll, generatedScheduleBulkCreate } = require('./sync/handlers/generated_schedule');
    const activeStationId = getActiveStationId();

    // Wipe previous run
    generatedScheduleClearAll(db, activeStationId);

    // Prepared statements (compiled once, reused in the loop)
    const stmtShows = db.prepare(
      `SELECT id, start_hour, end_hour, clock_id
       FROM shows
       WHERE instr(days, ?) > 0 AND is_active = 1 AND station_id = ?
       ORDER BY CASE
         WHEN end_hour = 0 AND start_hour > 0 THEN 24 - start_hour
         WHEN end_hour = 0 OR end_hour = start_hour THEN 24
         WHEN end_hour > start_hour              THEN end_hour - start_hour
         ELSE 24 - start_hour + end_hour
       END ASC`
    );
    const stmtSlots = db.prepare(
      `SELECT cs.position, cs.slot_type, cs.category_id, cs.spot_type, cs.duration_min
       FROM clock_slots cs
       WHERE cs.clock_id = ? ORDER BY cs.position`
    );
    const stmtSpots = db.prepare(SPOT_SELECT);
    const stmtCandidates = db.prepare(
      `SELECT s.id, s.title, a.name AS artist_name, s.artist_id,
              s.duration_ms, s.last_played_at, s.file_path
       FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
       WHERE s.category_id = ?
         AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
         AND (s.daypart_mask IS NULL OR ((s.daypart_mask >> ?) & 1) = 1)
       ORDER BY RANDOM()`
    );
    const generatedRows = [];

    // Per-generation tracking maps (survive across hours/days)
    const songLastTs   = new Map(); // songId        → unix ts last queued this run
    const artistLastTs = new Map(); // artistId      → unix ts last queued this run
    const titleLastTs  = new Map(); // norm. title   → unix ts last queued this run (covers covers/re-recordings)
    const spotLastTs   = new Map(); // spotId        → unix ts last queued this run (spot rotation)
    const spotPlaysToday = new Map(); // `${dayStr}|${spotId}` → plays this calendar day (max_plays_day cap)

    const now = new Date();
    now.setMinutes(0, 0, 0);

    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        const slotDate = new Date(now.getTime() + d * 86_400_000);
        slotDate.setHours(h, 0, 0, 0);
        const jsDay      = slotDate.getDay(); // 0=Sun
        const hourStartTs = Math.floor(slotDate.getTime() / 1000);

        // Find the show active at this hour on this weekday
        const shows = stmtShows.all(String(jsDay), activeStationId);
        const show  = shows.find(s => {
          if (s.end_hour === 0 || s.end_hour === s.start_hour) return h >= s.start_hour;
          if (s.end_hour > s.start_hour) return h >= s.start_hour && h < s.end_hour;
          return h >= s.start_hour || h < s.end_hour; // overnight
        });
        if (!show || !show.clock_id) continue;

        const slots = stmtSlots.all(show.clock_id);
        if (!slots.length) continue;

        // Per-hour sets to avoid same song, artist, or title within a single hour
        const usedSongIds   = new Set();
        const usedArtistIds = new Set();
        const usedTitles    = new Set();

        const hourEnd = hourStartTs + 3600;
        let currentTs = hourStartTs;

        // Fill the whole hour by TIME, not by slot count: cycle the clock's slots until we reach the
        // next :00. A clock whose slots sum to < 60 min would otherwise leave a gap at the end of the
        // hour (its "missing last song"). The last song starts before :00 and is cut off at :00.
        let slotIdx = 0, slotGuard = 0;
        while (currentTs < hourEnd && slots.length > 0 && slotGuard++ < 500) {
          const slot = slots[slotIdx % slots.length];
          slotIdx++;
          const slotDurationS = (slot.duration_min || 4) * 60;

          // Spot break: pull the least-recently-aired eligible spot from the spots library.
          if (slot.slot_type === 'spot_break') {
            const dayStr = _localDayStr(slotDate);
            const sp = _pickSpot(stmtSpots, slot, activeStationId, dayStr, spotLastTs, spotPlaysToday);
            if (sp) {
              spotLastTs.set(sp.id, currentTs);
              spotPlaysToday.set(dayStr + '|' + sp.id, (spotPlaysToday.get(dayStr + '|' + sp.id) || 0) + 1);
              const durationS = sp.length_sec || slotDurationS;
              generatedRows.push({ scheduled_at: currentTs, song_id: null, title: sp.title, artist: sp.advertiser || '', file_key: sp.file_path ? path.basename(sp.file_path) : '', file_path: sp.file_path, duration_s: durationS, category_id: null, clock_id: show.clock_id });
              currentTs += durationS;
              continue;
            }
            // no eligible spot → fall through and advance time (silent gap)
          }

          if (slot.slot_type !== 'music' || !slot.category_id) {
            currentTs += slotDurationS;
            continue;
          }

          const candidates = stmtCandidates.all(slot.category_id, h);

          let picked = null;
          let softFallback = null;

          for (const song of candidates) {
            if (usedSongIds.has(song.id)) continue;

            // Song repeat check — use generation-run timestamp if available, else DB value
            const lastSongTs  = songLastTs.get(song.id) ?? (song.last_played_at || 0);
            const songAgeSec  = currentTs - lastSongTs;
            if (songAgeSec < songRepeatMin * 60) continue;

            // Title separation — covers/re-recordings (same title, different recording/song_id)
            // must not stack inside the window. Strict within the hour, time-based across hours.
            const titleKey = (song.title || '').trim().toLowerCase();
            if (titleKey) {
              const lastTitleTs = titleLastTs.get(titleKey) ?? 0;
              if (usedTitles.has(titleKey) || (currentTs - lastTitleTs) < titleSepMin * 60) continue;
            }

            // Artist separation — strict within the hour, soft across hours
            const lastArtistTs = song.artist_id ? (artistLastTs.get(song.artist_id) || 0) : 0;
            const artistAgeSec = currentTs - lastArtistTs;
            const artistBlocked = usedArtistIds.has(song.artist_id)
              || (song.artist_id && artistAgeSec < artistSepMin * 60);

            if (!artistBlocked) { picked = song; break; }
            if (!softFallback)    softFallback = song; // same artist, but song+title repeat ok
          }

          // Soft fallback: violates artist sep but passes song+title repeat
          if (!picked) picked = softFallback;
          // Last resort: any unused song
          if (!picked) picked = candidates.find(s => !usedSongIds.has(s.id)) ?? candidates[0] ?? null;

          if (picked) {
            usedSongIds.add(picked.id);
            if (picked.artist_id) usedArtistIds.add(picked.artist_id);
            const pTitleKey = (picked.title || '').trim().toLowerCase();
            if (pTitleKey) { usedTitles.add(pTitleKey); titleLastTs.set(pTitleKey, currentTs); }
            songLastTs.set(picked.id, currentTs);
            if (picked.artist_id) artistLastTs.set(picked.artist_id, currentTs);

            const durationS = picked.duration_ms
              ? Math.round(picked.duration_ms / 1000)
              : slotDurationS;

            generatedRows.push({
              scheduled_at: currentTs, song_id: picked.id,
              title: picked.title, artist: picked.artist_name || '',
              file_key: picked.file_path ? path.basename(picked.file_path) : '',
              duration_s: durationS, category_id: slot.category_id, clock_id: show.clock_id,
            });
            currentTs += durationS;
          } else {
            currentTs += slotDurationS;
          }
        }
      }
    }

    generatedScheduleBulkCreate(db, activeStationId, generatedRows);
    console.log(`[schedule:generate] Generated ${generatedRows.length} tracks over ${days} days`);
    return { ok: true, count: generatedRows.length };
  } catch (e) {
    console.error('[schedule:generate]', e.message);
    return { ok: false, error: e.message };
  }
});

// ── Spot rotation (clock spot_break slots → spots library) ────────────────────
// A spot_break clock slot pulls from the spots table: active, inside its date window, and —
// if the slot names a spot_type — matching that type (NULL slot.spot_type = any active spot).
// Picks the least-recently-aired eligible spot, honoring max_plays_day within the generation run.
const SPOT_SELECT = `SELECT id, title, advertiser, file_path, length_sec, last_played_at, max_plays_day
   FROM spots
   WHERE station_id = ? AND deleted_at IS NULL AND is_active = 1 AND file_path IS NOT NULL
     AND (? IS NULL OR spot_type = ?)
     AND (start_date IS NULL OR start_date = '' OR start_date <= ?)
     AND (end_date   IS NULL OR end_date   = '' OR end_date   >= ?)`;

function _localDayStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Least-recently-aired eligible spot for this slot+day, or null if none. Caller records the play.
function _pickSpot(stmtSpots, slot, stationId, dayStr, spotLastTs, spotPlaysToday) {
  const st = slot.spot_type || null;
  const rows = stmtSpots.all(stationId, st, st, dayStr, dayStr);
  let best = null, bestTs = Infinity;
  for (const sp of rows) {
    if (sp.max_plays_day && (spotPlaysToday.get(dayStr + '|' + sp.id) || 0) >= sp.max_plays_day) continue;
    const lastTs = spotLastTs.get(sp.id) ?? (sp.last_played_at || 0);
    if (lastTs < bestTs) { best = sp; bestTs = lastTs; }
  }
  return best;
}

// Shared generation context (prepared statements + separation rules + tracking maps).
function _buildScheduleCtx(stationId) {
  let artistSepMin = 60, songRepeatMin = 180, titleSepMin = 120;
  try {
    const ar = db.prepare("SELECT value FROM separation_rules WHERE rule_type='artist_separation_min' AND is_active=1 LIMIT 1").get();
    if (ar) artistSepMin = ar.value;
    const sr = db.prepare("SELECT value FROM separation_rules WHERE rule_type='song_separation_min' AND is_active=1 LIMIT 1").get();
    if (sr) songRepeatMin = sr.value;
    const tr = db.prepare("SELECT value FROM separation_rules WHERE rule_type='title_separation_min' AND is_active=1 LIMIT 1").get();
    if (tr) titleSepMin = tr.value;
  } catch {}
  return {
    activeStationId: stationId, artistSepMin, songRepeatMin, titleSepMin,
    songLastTs: new Map(), artistLastTs: new Map(), titleLastTs: new Map(),
    spotLastTs: new Map(), spotPlaysToday: new Map(), generatedRows: [],
    stmtShows: db.prepare(`SELECT id, start_hour, end_hour, clock_id FROM shows WHERE instr(days, ?) > 0 AND is_active = 1 AND station_id = ? ORDER BY CASE WHEN end_hour = 0 AND start_hour > 0 THEN 24 - start_hour WHEN end_hour = 0 OR end_hour = start_hour THEN 24 WHEN end_hour > start_hour THEN end_hour - start_hour ELSE 24 - start_hour + end_hour END ASC`),
    stmtSlots: db.prepare(`SELECT cs.position, cs.slot_type, cs.category_id, cs.song_id, cs.spot_type, cs.duration_min FROM clock_slots cs WHERE cs.clock_id = ? ORDER BY cs.position`),
    stmtSpots: db.prepare(SPOT_SELECT),
    stmtCandidates: db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.last_played_at, s.file_path FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.category_id = ? AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive') AND (s.daypart_mask IS NULL OR ((s.daypart_mask >> ?) & 1) = 1) ORDER BY RANDOM()`),
    stmtSongById: db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.file_path FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.id = ?`),
  };
}

// Generate one day's 24 hours into ctx.generatedRows (same picking logic as schedule:generate).
function _generateDayRows(dayBaseDate, ctx, minTs = 0) {
  const { stmtShows, stmtSlots, stmtCandidates, stmtSongById, stmtSpots, songLastTs, artistLastTs, titleLastTs, spotLastTs, spotPlaysToday, artistSepMin, songRepeatMin, titleSepMin, activeStationId, generatedRows } = ctx;
  for (let h = 0; h < 24; h++) {
    const slotDate = new Date(dayBaseDate.getTime()); slotDate.setHours(h, 0, 0, 0);
    const jsDay = slotDate.getDay();
    const hourStartTs = Math.floor(slotDate.getTime() / 1000);
    if (hourStartTs < minTs) continue; // never regenerate an hour that has already aired
    const shows = stmtShows.all(String(jsDay), activeStationId);
    const show = shows.find(s => {
      if (s.end_hour === 0 || s.end_hour === s.start_hour) return h >= s.start_hour;
      if (s.end_hour > s.start_hour) return h >= s.start_hour && h < s.end_hour;
      return h >= s.start_hour || h < s.end_hour;
    });
    if (!show || !show.clock_id) continue;
    const slots = stmtSlots.all(show.clock_id);
    if (!slots.length) continue;
    const usedSongIds = new Set(), usedArtistIds = new Set(), usedTitles = new Set();
    const hourEnd = hourStartTs + 3600;
    let currentTs = hourStartTs;
    for (const slot of slots) {
      if (currentTs >= hourEnd) break; // hard top-of-hour: each hour starts fresh, no overflow past :00
      const slotDurationS = (slot.duration_min || 4) * 60;
      // Pinned element: this slot plays ONE specific song/jingle/talk break (set by cart # in the
      // scheduler). Place that exact element regardless of slot_type/category.
      if (slot.song_id) {
        const pinned = stmtSongById.get(slot.song_id);
        if (pinned && pinned.file_path) {
          const durationS = pinned.duration_ms ? Math.round(pinned.duration_ms / 1000) : slotDurationS;
          generatedRows.push({ scheduled_at: currentTs, song_id: pinned.id, title: pinned.title, artist: pinned.artist_name || '', file_key: pinned.file_path ? path.basename(pinned.file_path) : '', duration_s: durationS, category_id: slot.category_id, clock_id: show.clock_id });
          usedSongIds.add(pinned.id);
          if (pinned.artist_id) usedArtistIds.add(pinned.artist_id);
          songLastTs.set(pinned.id, currentTs);
          if (pinned.artist_id) artistLastTs.set(pinned.artist_id, currentTs);
          currentTs += durationS;
        } else { currentTs += slotDurationS; }
        continue;
      }
      // Spot break: pull the least-recently-aired eligible spot from the spots library.
      if (slot.slot_type === 'spot_break') {
        const dayStr = _localDayStr(slotDate);
        const sp = _pickSpot(stmtSpots, slot, activeStationId, dayStr, spotLastTs, spotPlaysToday);
        if (sp) {
          spotLastTs.set(sp.id, currentTs);
          spotPlaysToday.set(dayStr + '|' + sp.id, (spotPlaysToday.get(dayStr + '|' + sp.id) || 0) + 1);
          const durationS = sp.length_sec || slotDurationS;
          generatedRows.push({ scheduled_at: currentTs, song_id: null, title: sp.title, artist: sp.advertiser || '', file_key: sp.file_path ? path.basename(sp.file_path) : '', file_path: sp.file_path, duration_s: durationS, category_id: null, clock_id: show.clock_id });
          currentTs += durationS;
          continue;
        }
        // no eligible spot → fall through and advance time (silent gap)
      }
      if (slot.slot_type !== 'music' || !slot.category_id) { currentTs += slotDurationS; continue; }
      const candidates = stmtCandidates.all(slot.category_id, h);
      let picked = null, softFallback = null;
      for (const song of candidates) {
        if (usedSongIds.has(song.id)) continue;
        const lastSongTs = songLastTs.get(song.id) ?? (song.last_played_at || 0);
        if (currentTs - lastSongTs < songRepeatMin * 60) continue;
        const titleKey = (song.title || '').trim().toLowerCase();
        if (titleKey) {
          const lastTitleTs = titleLastTs.get(titleKey) ?? 0;
          if (usedTitles.has(titleKey) || (currentTs - lastTitleTs) < titleSepMin * 60) continue;
        }
        const lastArtistTs = song.artist_id ? (artistLastTs.get(song.artist_id) || 0) : 0;
        const artistBlocked = usedArtistIds.has(song.artist_id) || (song.artist_id && (currentTs - lastArtistTs) < artistSepMin * 60);
        if (!artistBlocked) { picked = song; break; }
        if (!softFallback) softFallback = song;
      }
      if (!picked) picked = softFallback;
      if (!picked) picked = candidates.find(s => !usedSongIds.has(s.id)) ?? candidates[0] ?? null;
      if (picked) {
        usedSongIds.add(picked.id);
        if (picked.artist_id) usedArtistIds.add(picked.artist_id);
        const pTitleKey = (picked.title || '').trim().toLowerCase();
        if (pTitleKey) { usedTitles.add(pTitleKey); titleLastTs.set(pTitleKey, currentTs); }
        songLastTs.set(picked.id, currentTs);
        if (picked.artist_id) artistLastTs.set(picked.artist_id, currentTs);
        const durationS = picked.duration_ms ? Math.round(picked.duration_ms / 1000) : slotDurationS;
        generatedRows.push({ scheduled_at: currentTs, song_id: picked.id, title: picked.title, artist: picked.artist_name || '', file_key: picked.file_path ? path.basename(picked.file_path) : '', duration_s: durationS, category_id: slot.category_id, clock_id: show.clock_id });
        currentTs += durationS;
      } else { currentTs += slotDurationS; }
    }
  }
}

// Generate (or regenerate) a SINGLE day — clears just that day's rows, leaves the rest intact.
ipcMain.handle('schedule:generateDay', (_, dayTs) => {
  try {
    const activeStationId = getActiveStationId();
    const { generatedScheduleBulkCreate } = require('./sync/handlers/generated_schedule');
    const dayBase = new Date(dayTs * 1000); dayBase.setHours(0, 0, 0, 0);
    const dayStart = Math.floor(dayBase.getTime() / 1000), dayEnd = dayStart + 86_400;
    const nowTs = Math.floor(Date.now() / 1000);
    const effStart = Math.max(dayStart, Math.ceil(nowTs / 3600) * 3600); // next top-of-hour; never the past
    if (effStart >= dayEnd) return { ok: true, count: 0, skipped: true }; // whole day already aired — leave it
    db.prepare("DELETE FROM generated_schedule WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ?").run(activeStationId, effStart, dayEnd);
    const ctx = _buildScheduleCtx(activeStationId);
    _generateDayRows(dayBase, ctx, effStart);
    generatedScheduleBulkCreate(db, activeStationId, ctx.generatedRows);
    console.log(`[schedule:generateDay] ${ctx.generatedRows.length} tracks for ${dayBase.toDateString()}`);
    return { ok: true, count: ctx.generatedRows.length };
  } catch (e) { console.error('[schedule:generateDay]', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('schedule:get', (_, fromTs, toTs) => {
  try {
    const rows = db.prepare(
      `SELECT id, scheduled_at, song_id, title, artist, file_key, duration_s, category_id
       FROM generated_schedule
       WHERE scheduled_at >= ? AND scheduled_at < ? AND deleted_at IS NULL
       ORDER BY scheduled_at`
    ).all(fromTs ?? 0, toTs ?? 9999999999);
    return { data: rows, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

// ── Library → R2 sync ─────────────────────────────────────────────────────────
// Uploads every local song file to R2. Runs async; progress sent via IPC push.
// Cancel by calling library:sync-r2:upload:cancel before the job finishes.

// ── Live stream to Icecast ────────────────────────────────────────────────────
// ffmpeg reads raw f32le stereo PCM from the Program Bus TCP socket exposed by
// the native BusMixer, encodes to MP3, and pushes to Icecast.
// No hardware capture device required — the mix is tapped inside the engine.

// Map<stationId, { armed, proc, url, failureCount, firstFailureTime, statusState, speed, bitrate, startTime, speedHistory, errorMsg, destLabel, ticker }>
const _stationStreams = new Map();

// ── Stream status helpers ─────────────────────────────────────────────────────

function _parseStreamLine(line) {
  const speedM   = line.match(/speed=\s*([\d.]+)x/);
  const bitrateM = line.match(/bitrate=\s*([\d.]+)kbits\/s/);
  return {
    speed:      speedM   ? parseFloat(speedM[1])   : null,
    bitrate:    bitrateM ? parseFloat(bitrateM[1]) : null,
    isProgress: !!(speedM || bitrateM),
    isLive:     /frame=\s*[1-9]\d*\s/.test(line) || /size=\s*[1-9]\d*kB/i.test(line),
    errorMsg:   /Connection refused/i.test(line)    ? 'Connection refused'
              : /401|Unauthorized/i.test(line)       ? 'Auth failed (401)'
              : /403|Forbidden/i.test(line)           ? 'Forbidden (403)'
              : /Connection timed out/i.test(line)    ? 'Connection timed out'
              : /Failed to connect/i.test(line)       ? 'Failed to connect'
              : null,
  };
}

function _labelFromRtmpUrl(url) {
  if (!url) return 'RTMP';
  if (/a\.rtmp\.youtube\.com/i.test(url))      return 'YouTube';
  if (/live\.twitch\.tv/i.test(url))            return 'Twitch';
  if (/live-api.*\.facebook\.com/i.test(url))   return 'Facebook';
  try { return new URL(url.replace(/^rtmp:\/\//i, 'https://')).hostname; } catch { return 'RTMP'; }
}

function _emitDestStatus(destId, statusObj) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const uptimeSec = statusObj.startTime ? Math.floor((Date.now() - statusObj.startTime) / 1000) : null;
  mainWindow.webContents.send('stream:status:dest', {
    destId,
    label:        statusObj.destLabel || destId,
    state:        statusObj.statusState,
    speed:        statusObj.speed,
    bitrate:      statusObj.bitrate,
    uptimeSec,
    errorMsg:     statusObj.errorMsg,
    speedHistory: [...statusObj.speedHistory],
  });
}

function _emitGlobal() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let liveCount = 0;
  for (const [, st] of _stationStreams.entries()) {
    if (st.statusState === 'live') liveCount++;
  }
  if (_rtmpStreamStatus.statusState === 'live') liveCount++;
  mainWindow.webContents.send('stream:status:global', { anyLive: liveCount > 0, liveCount });
  _persistOnAir(liveCount > 0);
  sseAirstate(liveCount > 0, liveCount);
}

// Per-process RTMP status (video studio pipeline; lives alongside _rtmpProcess)
const _rtmpStreamStatus = {
  statusState: 'idle', speed: null, bitrate: null,
  startTime: null, speedHistory: [], errorMsg: null,
  destLabel: 'RTMP', ticker: null,
};

function _getStreamState(stationId) {
  if (!_stationStreams.has(stationId)) {
    _stationStreams.set(stationId, {
      armed: false,
      proc: null,
      url: '',
      failureCount: 0,
      firstFailureTime: 0,
      statusState: 'idle',
      speed: null,
      bitrate: null,
      startTime: null,
      speedHistory: [],
      errorMsg: null,
      destLabel: '',
      ticker: null,
    });
  }
  return _stationStreams.get(stationId);
}

function _streamKillCurrent(stationId) {
  const state = _getStreamState(stationId);
  if (state.proc) {
    try { state.proc.kill('SIGTERM'); } catch {}
    state.proc = null;
  }
}

function _spawnStream(stationId, args, label) {
  _streamKillCurrent(stationId);
  const state = _getStreamState(stationId);
  const { spawn } = require('child_process');
  const bin = ffmpegBin || 'ffmpeg';
  console.log(`[stream/${stationId}] spawning ffmpeg: ${bin}`);
  console.log(`[stream/${stationId}] args: ${args.join(' ')}`);

  state.statusState = 'connecting';
  state.errorMsg    = null;
  state.speed       = null;
  state.bitrate     = null;
  _emitDestStatus(`icecast:${stationId}`, state);
  _emitGlobal();

  state.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  state.proc.stderr.on('data', d => {
    const text = d.toString();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.log(`[stream/${stationId}/ffmpeg] ${trimmed.slice(0, 120)}`);
      const parsed = _parseStreamLine(trimmed);
      if (parsed.errorMsg) {
        state.errorMsg = parsed.errorMsg;
        if (state.statusState === 'connecting') {
          // Error during connect phase is likely fatal — we haven't published yet.
          state.statusState = 'error';
          _emitDestStatus(`icecast:${stationId}`, state);
          _emitGlobal();
        }
        // While live, stash the message but don't change state.
        // The close handler is authoritative; sub-request errors leave the stream flowing.
      } else if (parsed.isLive && state.statusState === 'connecting') {
        state.statusState = 'live';
        state.startTime   = Date.now();
        state.errorMsg    = null;
        _emitDestStatus(`icecast:${stationId}`, state);
        _emitGlobal();
      } else if (parsed.isProgress && state.statusState === 'live') {
        if (parsed.speed   !== null) { state.speed = parsed.speed; state.speedHistory = [...state.speedHistory.slice(-119), parsed.speed]; }
        if (parsed.bitrate !== null) state.bitrate = parsed.bitrate;
        _emitDestStatus(`icecast:${stationId}`, state);
      }
    }
  });
  state.proc.on('error', e => {
    console.error(`[stream/${stationId}] spawn error: ${e.message}`);
    state.proc        = null;
    state.statusState = 'error';
    state.errorMsg    = e.message;
    _emitDestStatus(`icecast:${stationId}`, state);
    _emitGlobal();
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('stream:status', { stationId, live: false, error: e.message });
  });
  state.proc.on('close', code => {
    console.log(`[stream/${stationId}] ffmpeg closed (code ${code}) — ${label}`);
    state.proc = null;
    if (!state.armed) {
      state.statusState = 'idle';
      state.speed       = null;
      state.bitrate     = null;
      _emitDestStatus(`icecast:${stationId}`, state);
      _emitGlobal();
      return;
    }

    const now = Date.now();
    if (now - state.firstFailureTime > 10000) {
      state.failureCount    = 0;
      state.firstFailureTime = now;
    }
    if (state.failureCount === 0) state.firstFailureTime = now;
    state.failureCount++;

    if (state.failureCount >= 3) {
      console.error(`[stream/${stationId}] ffmpeg failed ${state.failureCount}x in 10s — giving up`);
      state.armed        = false;
      state.failureCount = 0;
      state.statusState  = 'error';
      state.errorMsg     = 'Streaming failed after repeated ffmpeg restarts. Check Icecast server URL and credentials.';
      _emitDestStatus(`icecast:${stationId}`, state);
      _emitGlobal();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream:status', { stationId, live: false, error: state.errorMsg });
      }
      return;
    }

    state.statusState = 'connecting';
    _emitDestStatus(`icecast:${stationId}`, state);
    console.log(`[stream/${stationId}] ffmpeg exited, respawning in 500ms (attempt ${state.failureCount}/3)`);
    setTimeout(() => {
      if (state.armed) _spawnStream(stationId, args, label);
    }, 500);
  });
  console.log(`[stream/${stationId}] → ${label}`);
}

ipcMain.handle('stream:go-live', async (_, args = {}) => {
  try {
    // Item 10 Phase 2 Step 5: when the daemon owns the engine, the program bus lives in the
    // daemon — so the encoder runs there too (and survives a UI restart). Resolve the Icecast
    // config from the DB here, then hand it to the daemon's startStream; status flows back as
    // `stream` events (forwarded below). The renderer's stream:* surface is unchanged.
    if (AUDIO_DAEMON) {
      const stationId = args.stationId ?? getActiveStationId();
      const station   = db.prepare("SELECT * FROM stations WHERE id=?").get(stationId);
      if (!station) return { ok: false, error: `station ${stationId} not found` };
      const server = station.icecast_server_url?.trim() || '44.244.52.207';
      const pw     = station.icecast_password?.trim()   || 'hackme';
      const mount  = station.icecast_mount?.trim()      || '/live';
      const bitrate = station.icecast_bitrate || 128;
      try { await audiodClient.cmd('startStream', { stationId, config: { server, password: pw, mount, bitrate, sampleRate: 44100, icecastPort: 8000 } }); }
      catch (e) { return { ok: false, error: 'daemon startStream failed: ' + e.message }; }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stream:status', { stationId, live: true, server, mount });
      return { ok: true, server, mount, stationId };
    }
    const stationId = args.stationId ?? getActiveStationId();
    const station   = db.prepare("SELECT * FROM stations WHERE id=?").get(stationId);
    if (!station) return { ok: false, error: `station ${stationId} not found` };

    const port   = audio.audioGetProgramBusPort(stationId);
    if (!port) return { ok: false, error: 'Audio engine not ready — no Program Bus port available.' };

    const server = station.icecast_server_url?.trim() || '44.244.52.207';
    const pw     = station.icecast_password?.trim()   || 'hackme';
    const mount  = station.icecast_mount?.trim()      || '/live';
    const state  = _getStreamState(stationId);
    state.url       = `icecast://source:${pw}@${server}:8000${mount}`;
    state.destLabel = `Icecast @ ${server}${mount}`;
    state.armed     = true;

    // Sample rate is negotiated by the native engine with the output device.
    // Default 44100 is safe; the engine always resamples to match before writing.
    const sampleRate = 44100;

    _spawnStream(stationId, [
      '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2',
      '-i', `tcp://127.0.0.1:${port}`,
      '-c:a', 'libmp3lame', '-b:a', '128k',
      '-f', 'mp3',
      '-content_type', 'audio/mpeg',
      state.url,
    ], `programbus:${port}→${mount}`);

    console.log(`[stream/${stationId}] ffmpeg started (programbus:${port}) → ${state.url}`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stream:status', { stationId, live: true, server, mount });
    }
    return { ok: true, server, mount, stationId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stream:stop-live', async (_, args = {}) => {
  const stationId = args.stationId ?? getActiveStationId();
  if (AUDIO_DAEMON) {
    try { await audiodClient.cmd('stopStream', { stationId }); } catch {}
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stream:status', { stationId, live: false });
    return { ok: true, stationId };
  }
  const state     = _getStreamState(stationId);
  state.armed = false;
  state.failureCount = 0;
  _streamKillCurrent(stationId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stream:status', { stationId, live: false });
  }
  return { ok: true, stationId };
});

ipcMain.handle('stream:get-status', (_, args = {}) => {
  if (args?.stationId != null) {
    const state = _getStreamState(args.stationId);
    return { stationId: args.stationId, live: state.armed };
  }
  const all = [];
  for (const [stationId, state] of _stationStreams.entries()) {
    all.push({ stationId, live: state.armed });
  }
  return { stations: all };
});

ipcMain.handle('stream:get-all-status', () => {
  const dests = [];
  for (const [stationId, st] of _stationStreams.entries()) {
    const uptimeSec = st.startTime ? Math.floor((Date.now() - st.startTime) / 1000) : null;
    dests.push({
      destId:       `icecast:${stationId}`,
      label:        st.destLabel || `Icecast (${stationId})`,
      state:        st.statusState,
      speed:        st.speed,
      bitrate:      st.bitrate,
      uptimeSec,
      errorMsg:     st.errorMsg,
      speedHistory: [...st.speedHistory],
    });
  }
  const rtmpUptime = _rtmpStreamStatus.startTime ? Math.floor((Date.now() - _rtmpStreamStatus.startTime) / 1000) : null;
  dests.push({
    destId:       'rtmp:video',
    label:        _rtmpStreamStatus.destLabel || 'RTMP',
    state:        _rtmpStreamStatus.statusState,
    speed:        _rtmpStreamStatus.speed,
    bitrate:      _rtmpStreamStatus.bitrate,
    uptimeSec:    rtmpUptime,
    errorMsg:     _rtmpStreamStatus.errorMsg,
    speedHistory: [..._rtmpStreamStatus.speedHistory],
  });
  const liveCount = dests.filter(d => d.state === 'live').length;
  return { dests, anyLive: liveCount > 0, liveCount };
});

// ── Stations CRUD ─────────────────────────────────────────────
ipcMain.handle('stations:list', () =>
  db.prepare("SELECT * FROM stations WHERE deleted_at IS NULL ORDER BY id").all()
);

ipcMain.handle('stations:get-active', () =>
  db.prepare("SELECT * FROM stations WHERE is_active=1 AND deleted_at IS NULL LIMIT 1").get() ?? null
);

ipcMain.handle('stations:switch', (_, id) => {
  try {
    const { stationsUpdateById } = require('./sync/handlers/stations');
    const others = db.prepare("SELECT id FROM stations WHERE deleted_at IS NULL AND id != ?").all(id);
    for (const s of others) stationsUpdateById(db, s.id, { is_active: 0 });
    stationsUpdateById(db, id, { is_active: 1 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:create', (_, data) => {
  // Safety gate: block second-station creation until Phase 3 INSERT audit is complete.
  // 40 renderer callsites still rely on DEFAULT station_id=1 — see checklist at top of file.
  // To unlock: INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('multistation_insert_audit_complete','true')
  const existingCount = db.prepare("SELECT COUNT(*) as c FROM stations").get().c;
  if (existingCount >= 1) {
    const auditRow = db.prepare("SELECT value FROM station_config_kv WHERE key='multistation_insert_audit_complete'").get();
    if (auditRow?.value !== 'true') {
      return {
        ok: false,
        error: "Cannot create additional stations: renderer INSERT audit incomplete. " +
          "40 callsites still rely on DEFAULT station_id=1 (see checklist at top of electron/main.js). " +
          "Set multistation_insert_audit_complete=true in station_config_kv after Phase 3 audit to enable.",
      };
    }
  }
  try {
    const { stationsCreate } = require('./sync/handlers/stations');
    const row = stationsCreate(db, {
      // Forward an explicit uuid when the caller supplies one — OnboardingFlow
      // passes the backend's station_uuid so peer sync treats the local row and
      // the backend row as identical (no duplicate-uuid drift). See OB18.
      // Other callers omit it → stationsCreate generates a fresh uuid.
      uuid: data.uuid,
      name: data.name || 'New Station', callsign: data.callsign || '',
      frequency: data.frequency || '', city: data.city || '',
      state: data.state || '', country: data.country || 'US', website: data.website || '',
      icecast_server_url: data.icecast_server_url || '44.244.52.207',
      icecast_mount: data.icecast_mount || ('/' + (_slugifyName(data.name) || 'live')),
      icecast_password: data.icecast_password || 'hackme',
      icecast_bitrate: data.icecast_bitrate || 128, icecast_format: data.icecast_format || 'mp3',
      is_active: 0,
    });
    return { ok: true, id: row.id };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:update', (_, id, data) => {
  const allowed = [
    'name','callsign','frequency','city','state','country','website','is_active',
    'icecast_server_url','icecast_mount','icecast_password','icecast_bitrate','icecast_format',
  ];
  const patch = {};
  for (const k of allowed) { if (k in data) patch[k] = data[k]; }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'no valid fields' };
  try {
    const { stationsUpdateById } = require('./sync/handlers/stations');
    stationsUpdateById(db, id, patch);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:delete', (_, id) => {
  try {
    const { stationsDeleteById } = require('./sync/handlers/stations');
    stationsDeleteById(db, id);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Sync progress state (for OnboardingFlow Screen 4) ─────────
// One-shot getter mirroring scheduler.getProgressState(). Renderer calls
// this on mount to catch up on events that may have fired before its
// subscription (event-fired-before-subscribe race). Returns a safe default
// if the scheduler doesn't exist (sync disabled via station_config_kv).
ipcMain.handle('sync:get-state', () => {
  try {
    const scheduler = app._syncScheduler;
    if (!scheduler) {
      return { initialComplete: false, appliedTotal: 0, byTable: {} };
    }
    return scheduler.getProgressState();
  } catch (e) {
    console.error('[sync:get-state]', e.message);
    return { initialComplete: false, appliedTotal: 0, byTable: {} };
  }
});

// ── Machine identity (for /account/* endpoints + Manage Devices) ─
// machine_id = client_identity.client_id (seeded by migrate-mutations-phase-sync-3.js,
// stable for the life of this install).
// machine_name = os.hostname() — best-effort device label for the seat list UI.
ipcMain.handle('identity:get', () => {
  try {
    const os  = require('os');
    const row = db.prepare('SELECT client_id FROM client_identity LIMIT 1').get();
    if (!row?.client_id) {
      return { ok: false, error: 'client_identity not seeded' };
    }
    return {
      ok: true,
      machine_id:   row.client_id,
      machine_name: os.hostname(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// sync:devices — list the machines on this account (backend /account/devices) and tag which
// row is THIS machine (machine_id = our client_id). Powers the Multi-Device Sync clarity panel.
ipcMain.handle('sync:devices', async () => {
  try {
    const lic = db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL").get();
    const licenseKey = lic?.value?.trim();
    if (!licenseKey) return { ok: false, error: 'No license key — sign in first.' };
    const { default: fetchFn } = await import('node-fetch').catch(() => ({ default: global.fetch }));
    const res = await fetchFn(`${ETHER_BACKEND_URL}/account/devices`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    if (!res.ok) return { ok: false, error: `devices ${res.status}` };
    const data = await res.json();
    const me = db.prepare('SELECT client_id FROM client_identity LIMIT 1').get()?.client_id || null;
    return { ok: true, devices: data.devices || [], limit: data.limit ?? null, plan: data.plan ?? null, thisMachineId: me };
  } catch (e) { return { ok: false, error: e.message }; }
});

// sync:removeDevice — deauthorize (soft-delete) another machine's seat on this account so it
// stops syncing and frees the seat. Mirrors Manage Devices' deauthorize. The UI blocks removing
// THIS machine (you can't deauthorize the device you're on from here).
ipcMain.handle('sync:removeDevice', async (_evt, machineId) => {
  try {
    const mid = (machineId || '').trim();
    if (!mid) return { ok: false, error: 'No device specified.' };
    const me = db.prepare('SELECT client_id FROM client_identity LIMIT 1').get()?.client_id || null;
    if (mid === me) return { ok: false, error: "Can't remove the device you're currently on." };
    const lic = db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL").get();
    const licenseKey = lic?.value?.trim();
    if (!licenseKey) return { ok: false, error: 'No license key — sign in first.' };
    const { default: fetchFn } = await import('node-fetch').catch(() => ({ default: global.fetch }));
    const res = await fetchFn(`${ETHER_BACKEND_URL}/account/deauthorize-seat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, machine_id: mid }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.detail || data.error || `remove ${res.status}` };
    return { ok: true, removed: data.removed ?? 0 };
  } catch (e) { return { ok: false, error: e.message }; }
});

let _libSyncAbort = false;
let _libDownloadAbort = false;   // mirror flag for the B.2 download handler

// Module-level snapshot of the current/last download run. Set synchronously
// at the top of the library:sync-r2:download handler (before the IIFE fires)
// so a getState() call between handler-return and the first progress event
// returns the correct in-progress flag — closes the mount-mid-download race
// that the B.4 progress bar otherwise hits when onboarding hands off mid-run.
// in_progress flips false in the terminal done/fatal branches; other fields
// retain their final values.
let _libDownloadState = {
  in_progress: false,
  done:        0,
  total:       0,
  errors:      0,
  started_at:  0,
};

// Phase 1.3g rewrite: customer no longer holds R2 credentials. Each song
// upload goes through /audio/upload-url to get a signed PUT URL, then PUTs
// the audio bytes directly to that URL. On success, file_key is written via
// songsUpdateById (mutation-logged so other clients on the same license can
// see it via sync) + r2_uploaded_at is written via raw UPDATE (local-only
// per Phase 1.1's REGISTRY shape — each machine tracks its own upload state).
//
// Resume support: SELECT filters on r2_uploaded_at IS NULL, so re-running the
// handler picks up where the previous run left off. Crucial for ~6k-song
// libraries where a single sync run might be interrupted.
//
// Tier gate: Network+ (station rank or higher). Studio (pro) doesn't get
// audio sync; Solo (free) doesn't get anything cloud-related.
//
// Event contract preserved exactly from the legacy handler: per-file progress
// on 'library:sync-r2:upload:progress', terminal 'library:sync-r2:upload:done'. Cancellation
// via _libSyncAbort flag (still set by 'library:sync-r2:upload:cancel' below).
ipcMain.handle('library:sync-r2:upload', async () => {
  const TIER_RANK_LOCAL = { free: 0, pro: 1, pro_lifetime: 1, station: 2, station_lifetime: 2, operator: 3 };

  // Tier gate — Network+ only
  const planTier = (db.prepare("SELECT value FROM station_config_kv WHERE key='plan_tier' LIMIT 1").get())?.value || 'free';
  if ((TIER_RANK_LOCAL[planTier] || 0) < TIER_RANK_LOCAL.station) {
    return { ok: false, error: `Library sync to cloud requires Network (station) tier or higher — current: ${planTier}` };
  }

  // License key required — set during onboarding / SubscriptionPanel validate
  const licenseKey = (db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL LIMIT 1").get())?.value;
  if (!licenseKey) return { ok: false, error: 'No license_key in station_config_kv' };

  // Resume-aware SELECT: skip songs already uploaded on this machine.
  // r2_uploaded_at is local-only (1.1), so each machine tracks its own
  // upload state independently — two operators can upload different subsets.
  const songs = db.prepare(
    `SELECT id, file_path FROM songs
     WHERE file_path IS NOT NULL AND file_path != ''
       AND r2_uploaded_at IS NULL`
  ).all();

  if (!songs.length) {
    return { ok: false, error: 'No songs to upload (all already synced from this machine, or no local audio files)' };
  }

  _libSyncAbort = false;

  // Fire-and-forget — returns immediately so the renderer isn't blocked
  (async () => {
    const { songsUpdateById } = require('./sync/handlers/songs');
    const CONCURRENCY = 3;
    let done = 0;
    let errors = 0;

    function contentType(fp) {
      const ext = path.extname(fp).toLowerCase();
      return ({ '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
                '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg' })[ext]
        || 'application/octet-stream';
    }

    async function uploadOne(song) {
      if (_libSyncAbort) return;
      const fileKey = path.basename(song.file_path);
      try {
        // 1. Request signed PUT URL from backend
        const urlRes = await fetch(`${ETHER_BACKEND_URL}/audio/upload-url`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ license_key: licenseKey, file_key: fileKey }),
        });
        const urlData = await urlRes.json().catch(() => ({}));
        if (!urlRes.ok || !urlData.signed_url) {
          throw new Error(urlData.error || urlData.detail || `signing failed (HTTP ${urlRes.status})`);
        }

        // 2. PUT audio bytes to the signed URL
        const data = fs.readFileSync(song.file_path);
        const putRes = await fetch(urlData.signed_url, {
          method:  'PUT',
          headers: {
            'Content-Type':   contentType(song.file_path),
            'Content-Length': String(data.length),
          },
          body: data,
        });
        if (!putRes.ok) {
          const text = await putRes.text().catch(() => '');
          throw new Error(`R2 PUT failed: HTTP ${putRes.status} — ${text.slice(0, 200)}`);
        }

        // 3. Mark success in DB:
        //    - file_key via songsUpdateById → mutation-logged, syncs to other clients
        //    - r2_uploaded_at via raw UPDATE → local-only marker (1.1 design)
        songsUpdateById(db, song.id, { file_key: fileKey });
        db.prepare('UPDATE songs SET r2_uploaded_at = ? WHERE id = ?')
          .run(new Date().toISOString(), song.id);
      } catch (e) {
        errors++;
        console.warn(`[library:sync-r2] SKIP ${fileKey}: ${e.message}`);
      }
      done++;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:sync-r2:upload:progress', {
          done, total: songs.length, errors, current: fileKey,
        });
      }
    }

    // Upload in batches of CONCURRENCY
    for (let i = 0; i < songs.length; i += CONCURRENCY) {
      if (_libSyncAbort) break;
      await Promise.all(songs.slice(i, i + CONCURRENCY).map(uploadOne));
    }

    const aborted = _libSyncAbort;
    _libSyncAbort = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:sync-r2:upload:done', {
        done, total: songs.length, errors, aborted,
      });
    }
    console.log(`[library:sync-r2] ${aborted ? 'Cancelled' : 'Done'} — ${done}/${songs.length} uploaded, ${errors} errors`);
  })().catch(e => {
    console.error('[library:sync-r2] fatal:', e.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:sync-r2:upload:done', { done: 0, total: songs.length, errors: 1, aborted: false });
    }
  });

  return { ok: true, total: songs.length };
});

ipcMain.handle('library:sync-r2:upload:cancel', () => {
  _libSyncAbort = true;
  return { ok: true };
});

// ── Library ← R2 download ─────────────────────────────────────────────────────
// Phase B.2: mirrors the upload handler with inverse direction. Used by Screen 4
// of onboarding ("From the cloud") to pre-warm <userData>/r2-cache/ on a fresh
// second machine that joined an existing license-sharing peer set.
//
// SELECT criterion: file_key IS NOT NULL AND file_key != ''. file_key is the
// cross-machine R2 marker (mutation-logged by the uploading machine in the
// upload handler above), so this catches every song R2 holds bytes for. We
// then JS-filter to skip songs whose file_path already exists on local disk.
//
// Why not gate on r2_uploaded_at: that field is local-only per Phase 1.1 (each
// machine tracks its own upload state), so it's always NULL on the fresh second
// machine this handler serves — gating on it would return zero rows.
//
// Per-song fetch: delegates to fetchR2Track() — already has tier + license
// checks, R2 cache short-circuit, and atomic temp+rename write. The handler-
// level tier/license checks here duplicate fetchR2Track's, but they fast-bail
// before iterating thousands of rows.
//
// Event contract: per-file progress on 'library:sync-r2:download:progress',
// terminal 'library:sync-r2:download:done'. Cancellation via _libDownloadAbort
// flag (set by 'library:sync-r2:download:cancel' below).
//
// Does NOT write file_path back on success. fetchR2Track populates the R2 cache
// at <userData>/r2-cache/; audio:load's 1.3k fallback resolves cache hits at
// play time. Writing file_path back would generate sync-log churn for every
// song downloaded — same reasoning as Option B in 1.3k.
ipcMain.handle('library:sync-r2:download', async (_evt, opts) => {
  // 2d-4: when materialize=true, write file_path back on each success so a cloud song
  // becomes a first-class LOCAL track (the automation picker requires file_path — see
  // loggen.ts). Default false preserves the onboarding pre-warm behavior (cache only,
  // no sync-log churn).
  const materialize = !!(opts && opts.materialize);
  const TIER_RANK_LOCAL = { free: 0, pro: 1, pro_lifetime: 1, station: 2, station_lifetime: 2, operator: 3 };

  // Tier gate — Network+ only (duplicates fetchR2Track's gate for fast-bail)
  const planTier = (db.prepare("SELECT value FROM station_config_kv WHERE key='plan_tier' LIMIT 1").get())?.value || 'free';
  if ((TIER_RANK_LOCAL[planTier] || 0) < TIER_RANK_LOCAL.station) {
    return { ok: false, error: `Library download from cloud requires Network (station) tier or higher — current: ${planTier}` };
  }

  // License key required
  const licenseKey = (db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL LIMIT 1").get())?.value;
  if (!licenseKey) return { ok: false, error: 'No license_key in station_config_kv' };

  const candidates = db.prepare(
    `SELECT id, file_key, file_path FROM songs
      WHERE file_key IS NOT NULL AND file_key != ''`
  ).all();
  const songs = candidates.filter(s => !(s.file_path && fs.existsSync(s.file_path)));

  if (!songs.length) {
    return { ok: false, error: 'Nothing to download (all R2 songs already present locally, or no songs in R2)' };
  }

  _libDownloadAbort = false;

  // SYNCHRONOUS state snapshot — set BEFORE the IIFE so getState() called
  // between handler-return and first progress event returns in_progress=true.
  _libDownloadState = {
    in_progress: true,
    done:        0,
    total:       songs.length,
    errors:      0,
    started_at:  Date.now(),
  };

  // Fire-and-forget — returns immediately so the renderer isn't blocked
  (async () => {
    const CONCURRENCY = 3;
    const { songsUpdateById } = require('./sync/handlers/songs');
    let done = 0;
    let errors = 0;

    async function downloadOne(song) {
      if (_libDownloadAbort) return;
      const res = await fetchR2Track(song.file_key);
      if (!res.ok) {
        errors++;
        console.warn(`[library:sync-r2] download SKIP ${song.file_key}: ${res.error}`);
      } else if (materialize && res.filePath) {
        // Write file_path (mutation-logged) so the automation picker treats this cloud
        // song as a rotation-eligible local track.
        try { songsUpdateById(db, song.id, { file_path: res.filePath }); }
        catch (e) { console.warn(`[library:sync-r2] materialize file_path failed ${song.file_key}: ${e.message}`); }
      }
      done++;
      // Mirror local counters to the module-level snapshot for getState() (B.4).
      _libDownloadState.done   = done;
      _libDownloadState.errors = errors;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:sync-r2:download:progress', {
          done, total: songs.length, errors, current: song.file_key,
        });
      }
    }

    // Download in batches of CONCURRENCY
    for (let i = 0; i < songs.length; i += CONCURRENCY) {
      if (_libDownloadAbort) break;
      await Promise.all(songs.slice(i, i + CONCURRENCY).map(downloadOne));
    }

    const aborted = _libDownloadAbort;
    _libDownloadAbort = false;
    _libDownloadState.in_progress = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:sync-r2:download:done', {
        done, total: songs.length, errors, aborted,
      });
    }
    console.log(`[library:sync-r2] download ${aborted ? 'Cancelled' : 'Done'} — ${done}/${songs.length} fetched, ${errors} errors`);
  })().catch(e => {
    console.error('[library:sync-r2] download fatal:', e.message);
    _libDownloadState.in_progress = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:sync-r2:download:done', { done: 0, total: songs.length, errors: 1, aborted: false });
    }
  });

  return { ok: true, total: songs.length };
});

ipcMain.handle('library:sync-r2:download:cancel', () => {
  _libDownloadAbort = true;
  return { ok: true };
});

// Phase B.4. Returns the current download snapshot so the persistent progress
// bar can render correct counts when it mounts mid-run. The race exists because
// B.3's "From the cloud" button fires download() then immediately hands off to
// the 'pulling' state — by the time App.tsx and the bar mount, the download is
// already in flight. _libDownloadState is set synchronously above before the
// IIFE, so any getState() call after handler-return sees in_progress=true.
ipcMain.handle('library:sync-r2:download:get-state', () => {
  return _libDownloadState;
});

// ── Local-only file_path setter ───────────────────────────────────────────────
// Phase B.3. Writes songs.file_path directly via db.prepare(), bypassing the
// mutation log. file_path is per-machine truth (peer A's path is invalid on
// peer B), so mutation-logging it would make every machine churn through
// other machines' paths on sync. Mirrors the r2_uploaded_at write pattern at
// the upload handler — narrow typed handler for local-only fields.
//
// Why this exists as a separate IPC: the db:execute guard above (~line 1272)
// rejects synced-table writes; songs is in synced-tables. The renderer can't
// run raw UPDATE songs through db:execute, so this main-process handler is
// the required path for B.3's "From this computer" basename-match flow.
ipcMain.handle('songs:set-local-file-path', (_, intId, filePath) => {
  try {
    const result = db.prepare(
      'UPDATE songs SET file_path = ? WHERE id = ?'
    ).run(filePath, intId);
    return { ok: true, changes: result.changes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
