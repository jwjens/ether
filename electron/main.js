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
// The 'multistation_insert_audit_complete' tripwire was REMOVED 2026-07-05 (gate + flag-set + renderer
// message). The audit is long complete and Phase 3/4 shipped callsite mapping, empty-state handling,
// and a demonstrated zero-station boot. Multi-station creation is unconditional.
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

// ── RESTORE GATE ────────────────────────────────────────────────────────────────────────────────
// A database cannot be replaced while anything still holds it open. The app is the main offender: the
// renderer polls several times a second during onboarding, and ANY db-touching IPC landing after the
// swap closes the connection makes getDb() lazily reopen it — which instantly recreates -wal/-shm and
// re-locks the very files the swap must remove. The restore then either corrupts the result or (since
// 4.4.164) correctly refuses. Neither is acceptable when the app is fighting itself.
//
// While this gate is set: getDb() will NOT reopen, and every IPC except an explicit allowlist returns
// a clean "restore in progress" answer without touching the database. That makes the app go quiet for
// the duration of the swap, by construction rather than by timing.
let _restoreGate = null;                       // reason string while a restore is in flight
function restoreGateActive() { return _restoreGate !== null; }
function setRestoreGate(reason) { _restoreGate = reason || "restore in progress"; try { restoreLog(`gate SET — ${_restoreGate}; the app will not reopen the database until it clears`); } catch {} }
function clearRestoreGate() { const had = _restoreGate; _restoreGate = null; if (had) { try { restoreLog("gate CLEARED — normal database access resumed"); } catch {} } }

// Channels that must keep working while gated — the restore itself, and anything that cannot touch
// the station database.
const _RESTORE_SAFE_CHANNELS = new Set([
  "station:install-from-cloud", "db:restore", "restore_db", "station:cloud-install-available",
  "restore:begin", "restore:end", "app:relaunch", "system:getAppDataDir", "get_local_ip",
  "app:getVersion", "app:version", "system:factoryReset",
]);
{
  const _origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => _origHandle(channel, async (...args) => {
    if (restoreGateActive() && !_RESTORE_SAFE_CHANNELS.has(channel)) {
      // Uniform, harmless shape: the common readers (.rows / .data / .error) all resolve safely.
      return { ok: false, restoreInProgress: true, error: "restore in progress", data: null, rows: [] };
    }
    return listener(...args);
  });
}

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
// SMOKE_ISOLATED: an isolated health/CI smoke may run ALONGSIDE the live app. It skips the single-instance
// lock (and the :3400 bind, far below) so it never fights the live app. Guarded by BOTH ETHER_SMOKE=1 AND an
// explicit --user-data-dir — never either alone — so a stray env var on a live box can NEVER spawn an
// unlocked second instance. Loudly self-identifying (window title + [SMOKE] logs).
const SMOKE_ISOLATED = process.env.ETHER_SMOKE === '1' && app.commandLine.hasSwitch('user-data-dir');
if (SMOKE_ISOLATED) {
  console.log('[SMOKE] ISOLATED MODE — single-instance lock + :3400 bind BYPASSED (ETHER_SMOKE=1 + explicit --user-data-dir). This is NOT the live app.');
} else {
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
}

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
let _health = null;                 // v4.4.50: Health Monitor state — module scope so BOTH the daemon and the in-process paths feed it
// Log-Reader Flip Phase 3 — §2.7 boundary-shadow rolling summary, per station id. Fed by the daemon's
// `logreader-shadow` event (what the flipped reader WOULD air vs what legacy aired, at each go-live).
// A live "sense" the Health Monitor reads (logreader-shadow:get); the full history is the JSONL ledger.
const _logReaderShadow = new Map();  // stationId → { boundaries, agrees, behind, ahead, onTime, exhausted, maxDriftSec, lastDriftSec, maxMissed, last }
let _inProcessFallback = false;     // v4.4.50: true after a boot-time fallback to the in-process engine (daemon not attached)
let _handoverWatch = null;          // v4.4.50: song-boundary watcher for a safe in-process → daemon handover
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
    audioSetMuted: () => true,
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
const _daemonEngineState = new Map();    // stationId → last daemon enginestate (live|stalled|off); corroborates the silent-wedge watchdog in the reload-reason log
// Auto-resume (Item 10): per-station automation intent. Set when the app issues automationStart,
// cleared ONLY by an explicit automationStop. A daemon disconnect/respawn must NEVER clear it —
// that's exactly the state we need to replay so a respawned (idle, _started=false) daemon resumes
// playout instead of dead air. stationId → the automationStart args, so the replay is faithful.
const _automationIntent = new Map();
// Phase D (4.4.43): stream intent — stationId → startStream args. Set on startStream, cleared on
// stopStream (and on automationStop — no automation means nothing to air). Replayed on daemon
// (re)connect alongside automationStart so a reload restores the Icecast stream, not just playout.
const _streamIntent = new Map();
const { replayIntents: _replayIntentsRaw } = require('./daemon-auto-resume');
// BOOT-SEQUENCE SENSE (permanent, 2026-08-03). Main's auto-resume is a SENDER of automationStart that
// the renderer never sees — the halloVeen start on the 4.4.124 launch came from here, and a
// renderer-side guard could not have caught it. Every replay now announces itself WITH the intent set
// and whether this launch is watchdog-spawned, so this sender is never anonymous again.
const replayIntents = (client, autoIntent, streamIntent, opts) => {
  try {
    logStartup(`[BOOTSEQ] replayIntents FIRING — automation intent=[${[...autoIntent.keys()].join(',')}] `
      + `stream intent=[${[...streamIntent.keys()].join(',')}] `
      + `watchdogSpawned=${!!process.env.ETHER_WATCHDOG_PID}`);
  } catch { /* never break resume to log */ }
  return _replayIntentsRaw(client, autoIntent, streamIntent, opts);
};

// DURABLE on-air intent (2026-07-15 silent-while-playing fix). _automationIntent is IN-MEMORY, so an app
// RELAUNCH (every version update) resets it to empty — then only the renderer's boot auto-start (the active
// station) is in the map, and a daemon reload replays just THAT one station while the others sit silent
// (the incident: 4.4.59 update → reload → only Open Format resumed). Persist the exact on-air set to disk on
// every automationStart/Stop, and SEED it back on boot BEFORE the first command, so replayIntents resumes
// EVERY station that was intentionally airing — no privileged/active station, no inference.
function _automationIntentPath() { try { return path.join(app.getPath("userData"), "automation-intent.json"); } catch { return null; } }
function _persistAutomationIntent() {
  const p = _automationIntentPath(); if (!p) return;
  try { fs.writeFileSync(p, JSON.stringify([..._automationIntent.keys()])); } catch (e) { /* best-effort */ }
}
let _intentSeeded = false;
function _seedAutomationIntentFromDisk() {
  if (_intentSeeded) return; _intentSeeded = true;
  // BOOT AUDIO POLICY (2026-07-24): auto-resume is CRASH-ONLY. Only seed the persisted on-air set (→ replay →
  // daemon resumes playout on connect) when THIS launch is a watchdog/crash respawn of a station that was
  // genuinely streaming (_wasOnAir = .ether-on-air marker + ETHER_WATCHDOG_PID). A clean/manual cold launch
  // resumes NOTHING — the daemon stays idle and silent until the operator explicitly enables AUTO. A mid-session
  // daemon respawn is unaffected: _automationIntent is already in memory, so replayIntents resumes without this seed.
  if (!_wasOnAir()) { logStartup("[AUDIO] clean launch — boot auto-resume SUPPRESSED (not a crash respawn); stations idle until AUTO"); return; }
  const p = _automationIntentPath(); if (!p) return;
  try {
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(arr)) {
      for (const sid of arr) if (typeof sid === "number" && !_automationIntent.has(sid)) _automationIntent.set(sid, { stationId: sid });
      if (arr.length) logStartup(`[AUDIO] auto-resume: seeded persisted on-air intent — stations [${arr.join(",")}]`);
    }
  } catch { /* no file yet / unreadable → empty intent, unchanged behavior */ }
}

// Stale-daemon auto-reload (Item 10 follow-up — closes the dead-air-on-update gotcha). The daemon
// is detached so it survives an app update gaplessly; the downside is a daemon left running OLD
// code (or wedged) after the app updates — the renderer is new, the daemon is a zombie, and that
// caused real dead air on the 4.3.27 update. On each fresh connect we ask the daemon its version
// (the app version it was spawned with); if it's older than this app, we reload it — at the next
// song boundary while audio is flowing, or promptly if there's NO audio (wedged/idle), which
// bounds dead-air. The fresh daemon is re-staged to the current version and auto-resume replays.
let _daemonReloadArmed = false;
let _daemonReloadTimer = null;
// Per-station audio-liveness clock (DESIGN-TRUTH §2): last time EACH station produced
// non-silent output, keyed by stationId. No single shared scalar — a wedged station goes
// stale here even while siblings keep airing (the global scalar this replaced masked that,
// hiding halloVeen + Magical Forest on 2026-07-10). Helpers below read/write per station.
const _lastDaemonAudioAt = new Map();
let _armGraceAt = 0;   // whole-daemon armed-reload grace anchor (version/stale REPLACEMENT only)
function _noteStationAudio(sid) { if (sid != null) _lastDaemonAudioAt.set(sid, Date.now()); }
function _stationAudioAgeMs(sid) { const t = _lastDaemonAudioAt.get(sid); return t == null ? Infinity : Date.now() - t; }
function _anyDaemonAudioAgeMs() { let best = Infinity; for (const t of _lastDaemonAudioAt.values()) best = Math.min(best, Date.now() - t); return best; }
function disarmDaemonReload() {
  _daemonReloadArmed = false;
  if (_daemonReloadTimer) { clearInterval(_daemonReloadTimer); _daemonReloadTimer = null; }
}
// (b) UNIVERSAL RELOAD GUARD (4.4.44): a daemon whose engine reports itself LIVE is functioning — it
// must NEVER be reloaded, no matter which path wants to (silent-wedge, armed song-boundary, no-audio
// timer). Proven 2026-07-10 on jensj: the VU-levels signal stalled at a deck-C→A segue while
// daemon-enginestate stayed [live,live,live], the daemon's own wraps kept succeeding and its stall
// watchdog self-recovered — yet the app reloaded and the reload's shutdown is what cut all air. The
// engine's own truth (a deck is actually playing) overrides the unreliable levels signal.
function anyOnAirEngineLive() {
  for (const sid of _automationIntent.keys()) { if (_daemonEngineState.get(sid) === "live") return true; }
  return false;
}
function fireDaemonReload(why) {
  if (!_daemonReloadArmed) return;
  // Never kill a healthy daemon mid-wrap. Stay ARMED (don't disarm) so a genuinely stale daemon still
  // reloads later at a moment when no engine is live (e.g. off-air) — a working daemon is never disrupted.
  if (anyOnAirEngineLive()) { logStartup(`[AUDIO] RELOAD SUPPRESSED (${why}) — on-air engine reports live; daemon healthy, staying armed`); return; }
  disarmDaemonReload();
  // Reload reasons are PERMANENTLY tee'd to the startup log (not console-only) — a console-only
  // reason once cost us the diagnosis of the 3-station reload loop (2026-07-09).
  logStartup(`[AUDIO] RELOAD daemon — reason: stale/${why} (armed reload fired)`);
  try { audiodClient.reloadDaemon(); } catch {}
}
function armDaemonReload() {
  if (_daemonReloadArmed) return;
  _daemonReloadArmed = true;
  _armGraceAt = Date.now();   // grace: don't fire before we've seen whether audio is flowing
  // A daemon that isn't actually producing sound (wedged or idle) is safe to reload at once; a
  // healthy one keeps the per-station clocks fresh from levels events and instead waits for a boundary.
  // Whole-daemon replacement (version/stale): fire only if NO station has produced audio recently.
  _daemonReloadTimer = setInterval(() => {
    if (Date.now() - _armGraceAt > 4500 && _anyDaemonAudioAgeMs() > 4500) fireDaemonReload("no audio");
  }, 1500);
}
// ── Daemon version mismatch — the operator's problem, so tell the operator ───────────────────────
//
// The daemon does NOT reload on auto-update (CLAUDE.md), so an app can run against a daemon built
// before a field or command existed. Until now that was known only to this log line, and it degraded
// into a silently WRONG UI rather than an honest one: on 2026-08-03 the stale-daemon hypothesis
// burned a full diagnostic round and could be neither confirmed nor ruled out from the screen.
//
// The state is published so the UI can say so, and so anything whose data the running daemon cannot
// supply renders UNKNOWN instead of a confident default. Two genuinely different cases:
//   · mismatch  — versions known and different
//   · unknown   — the daemon predates the `version` command, so its build CANNOT be determined.
//     "Unknown" is reported as unknown; guessing a number here would be the same class of lie.
const { decideDaemonVersion } = require("./daemon-version");
let _daemonVersionState = { stale: false, reason: null, daemonVersion: null, appVersion: null };
function _publishDaemonVersion(next) {
  const changed = next.stale !== _daemonVersionState.stale || next.reason !== _daemonVersionState.reason;
  _daemonVersionState = next;
  try { sendToAllWindows("audio:daemon-version", next); } catch {}
  if (!changed) return;                       // transition only — never a repeating event
  try {
    require("fs").appendFileSync(path.join(app.getPath("userData"), "health-events.jsonl"),
      JSON.stringify({ t: new Date().toISOString(), kind: "daemon-version", ...next }) + "\n");
  } catch {}
}
async function checkStaleDaemon() {
  const appV = (() => { try { return require("electron").app.getVersion(); } catch { return "0"; } })();
  let dv, err;
  try { dv = await audiodClient.cmd("version", {}); } catch (e) { err = e; }

  // The rule itself lives in electron/daemon-version.js and is unit-tested — including that a daemon
  // predating the `version` command reports UNKNOWN rather than a guessed build number.
  const verdict = decideDaemonVersion({ daemonVersion: dv, appVersion: appV, error: err });
  if (!verdict) return;                       // plain connection error — no conclusion, say nothing

  if (verdict.stale) {
    logStartup(verdict.reason === "unknown"
      ? "[AUDIO] stale-check: daemon predates the version command — arming reload"
      : `[AUDIO] stale-check: daemon v${verdict.daemonVersion} != app v${appV} — arming reload`);
  }
  _publishDaemonVersion(verdict);
  if (verdict.stale) armDaemonReload();
}
// Late-joining windows (popouts, a reopened main window) ask rather than wait for the next check —
// otherwise the banner would be missing exactly where a mismatch is hardest to spot.
try { ipcMain.handle("daemon:version-state", () => _daemonVersionState); } catch {}

// Audio-liveness watchdog (Item 10 follow-up — the recurring SILENT-WEDGE recovery). Distinct from
// the daemon's own stall watchdog (which only catches "no deck playing"): here the daemon's logic
// keeps rotating but its cpal output stream has died (device change/disconnect), so a deck reports
// "playing" while output is silent — levels frozen at ~0 — and nothing recovers it. This is dead
// air the operator hears. We detect it from the renderer side (where the levels feed already lives)
// and auto-reload the daemon: the exact kill→respawn recovery, automated. Conservative to avoid
// false reloads — only fires when audio has been silent a while AND getState CONFIRMS a deck is
// supposed to be playing, with a cooldown so a still-broken device can't induce a tight loop.
let _audioWatchdogTimer = null;
let _lastAudioReloadAt = 0;              // retained for other callers; whole-daemon reload cooldown
const _wedgeAt = new Map();              // per-station wedge start ms (absent = healthy)
const _lastReopenAt = new Map();         // per-station reopen cooldown
// Per-station output-liveness watchdog (DESIGN-TRUTH §2). Each station is judged and, if wedged,
// recovered INDEPENDENTLY — one station's dead output never triggers action on another. Recovery is
// a per-station stream reopen (reopenOutput), NOT a whole-daemon reload. Signal precedence: the
// station's OWN cpal output-callback stamp (authoritative) over the VU-levels hint; enginestate=live
// (rotation bookkeeping, not PCM proof) may suppress only up to a persistence ceiling (jensj's diff),
// then we stop believing it and reopen the card.
function startAudioLivenessWatchdog() {
  if (_audioWatchdogTimer) return;
  const WEDGE_CEILING_MS   = 12000;   // enginestate=live is trusted only this long into a wedge
  const REOPEN_COOLDOWN_MS = 30000;   // per-station: don't re-reopen a still-recovering card in a tight loop
  _audioWatchdogTimer = setInterval(async () => {
    try {
      if (!audiodClient.isConnected()) return;
      const sids = _automationIntent.size > 0 ? [..._automationIntent.keys()] : [1];
      for (const sid of sids) {
        // Wedge candidate only if THIS station's levels have been silent a while.
        if (_stationAudioAgeMs(sid) < 6000) { _wedgeAt.delete(sid); continue; }
        const st = await audiodClient.cmd("getState", { stationId: sid }).catch(() => null);
        const playing = st && [st.deckA, st.deckB, st.deckC].some((d) => d && d.status === "playing");
        if (!playing) { _wedgeAt.delete(sid); continue; }   // genuinely idle/off-air — not a wedge

        const silentMs = _stationAudioAgeMs(sid);
        const esSnap = [...sids].map(s => `${s}:${_daemonEngineState.get(s) || "?"}`).join(",");

        // AUTHORITATIVE per-station signal: this station's OWN cpal output-callback stamp, independent
        // of the VU pipeline and of every sibling. Fresh → output genuinely alive → false positive.
        let cbStaleMs = null;
        try { const cb = Number(await audiodClient.cmd("lastCallbackMs", { stationId: sid })); if (cb > 0) cbStaleMs = Date.now() - cb; } catch {}
        if (cbStaleMs !== null && cbStaleMs < 3000) {
          logStartup(`[AUDIO] wedge SUPPRESSED — station ${sid} cpal callback FRESH (${cbStaleMs}ms) despite levels stale ${silentMs}ms (enginestate=[${esSnap}])`);
          _noteStationAudio(sid); _wedgeAt.delete(sid);
          continue;
        }

        // Per-station output stale/unknown = a real wedge. Anchor it (jensj's persistence ceiling) so
        // enginestate="live" can suppress only briefly, then we escalate regardless of its lie.
        if (!_wedgeAt.has(sid)) _wedgeAt.set(sid, Date.now());
        const wedgeMs = Date.now() - _wedgeAt.get(sid);
        const engineLive = _daemonEngineState.get(sid) === "live";
        if (engineLive && wedgeMs < WEDGE_CEILING_MS) {
          logStartup(`[AUDIO] wedge SUPPRESSED — station ${sid} enginestate=live, wedge ${wedgeMs}ms < ceiling (cpal-stale ${cbStaleMs == null ? "unknown" : cbStaleMs + "ms"}, levels ${silentMs}ms; [${esSnap}])`);
          continue;   // hold — but keep the anchor so it grows and we escalate
        }

        // Escalate: recover THIS station only (reopen its own cpal stream). Never touches siblings.
        if (Date.now() - (_lastReopenAt.get(sid) || 0) < REOPEN_COOLDOWN_MS) continue;
        _lastReopenAt.set(sid, Date.now());
        _wedgeAt.delete(sid);
        logStartup(`[AUDIO] REOPEN station ${sid} output — per-station wedge ${wedgeMs}ms (cpal-stale ${cbStaleMs == null ? "unknown" : cbStaleMs + "ms"}, levels ${silentMs}ms, enginestate=${engineLive ? "live(lying)" : (_daemonEngineState.get(sid) || "?")}; on-air=[${[...sids].join(",")}])`);
        try { await audiodClient.cmd("reopenOutput", { stationId: sid }); }
        catch (e) { logStartup(`[AUDIO] reopenOutput station ${sid} failed: ${e && e.message}`); }
        // no break: each station is judged and recovered independently
      }
    } catch {}
  }, 2000);
}

// VU levels station-scoping (v4.5 levels-slice; docs/vu-meter-crosstalk-2026-07-08.md). Resolve the
// daemon's integer stationId → station UUID (cached; NOT the sync getter, NOT gated by uuidIdentity) so
// the levels frame carries UUID identity and the renderer renders each station's meters only.
const { scopeLevelsFrame } = require('./levels-scope');
const _uuidByIdCache = new Map();
function _stationUuidById(id) {
  if (id == null) return null;
  if (_uuidByIdCache.has(id)) return _uuidByIdCache.get(id);
  let uuid = null;
  try { uuid = getDb().prepare('SELECT uuid FROM stations WHERE id = ?').get(id)?.uuid || null; } catch { /* db not ready */ }
  if (uuid) _uuidByIdCache.set(id, uuid);
  return uuid;
}

if (AUDIO_DAEMON_DESIRED) {
  // ── Health Monitor (display + event-logging ONLY; pure consumer of existing signals) ──────────
  // One source of truth. Reads the daemon event stream below + a read-only ping RTT; never mutates
  // audio state, never triggers recovery. Two display-only signals the daemon emits only to its log
  // (per-station drain B/s, daemon pid) are read from a cheap tail of ether-audiod.log.
  const { createHealthMonitor } = require("./audio-health");
  const _healthLogDir = path.join(app.getPath("userData"), "logs");
  const _healthDaemonLog = path.join(_healthLogDir, "ether-audiod.log");
  let _healthTail = { at: 0, drain: {}, pid: null };
  function _readLastBytes(p, n) {
    try { const st = fs.statSync(p); const start = Math.max(0, st.size - n); const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd); return buf.toString("utf8"); } catch { return ""; }
  }
  function _healthReadTail() {
    const now = Date.now();
    if (now - _healthTail.at < 900) return _healthTail;
    try {
      // v4.4.51: after a daemon-log rotation, Rust stderr (the inherited fd) keeps writing to the
      // RENAMED .1 file while daemon-log.js writes JS to the fresh .log — so drain-rate tailing went
      // blind. Read BOTH tails. Order .1 then .log; the last match per station wins: post-rotation the
      // fresh [RUST] drain is in .1 (.log has none), pre-rotation it's in .log. (Daemon re-opening its
      // own fd 2 on rotation isn't feasible in pure Node on Windows — no dup2 — so this is the safe one.)
      const text = _readLastBytes(_healthDaemonLog + ".1", 65536) + "\n" + _readLastBytes(_healthDaemonLog, 65536);
      const drain = {}; let pid = _healthTail.pid;
      let m2; const dre = /Station (\d+) drain: real=([\d.]+)/g;
      while ((m2 = dre.exec(text))) drain[m2[1]] = Math.round(parseFloat(m2[2]));
      const pids = text.match(/sink open .*\(pid (\d+)/g);
      if (pids && pids.length) { const pm = /\(pid (\d+)/.exec(pids[pids.length - 1]); if (pm) pid = parseInt(pm[1], 10); }
      _healthTail = { at: now, drain, pid };
    } catch {}
    return _healthTail;
  }
  let _daemonPingInfo = { pid: null, startedAt: null };   // v4.4.51: from the daemon's ping reply
  const _healthPing = async () => {
    const t0 = Date.now();
    try {
      const r = await Promise.race([ audiodClient.cmd("ping"), new Promise((_, rej) => setTimeout(() => rej(new Error("t")), 2000)) ]);
      if (r && typeof r === "object" && r.pid) _daemonPingInfo = { pid: r.pid, startedAt: r.startedAt || null };
      return Date.now() - t0;
    } catch { return null; }
  };
  const _healthNameCache = new Map();
  const _healthStationName = (id) => {
    if (_healthNameCache.has(id)) return _healthNameCache.get(id);
    let n = "";
    try { n = getDb().prepare("SELECT name FROM stations WHERE id = ?").get(id)?.name || ""; } catch {}
    if (n) _healthNameCache.set(id, n);
    return n;
  };
  _health = createHealthMonitor({
    logDir: _healthLogDir,
    broadcast: sendToAllWindows,
    ping: _healthPing,
    drainRate: (id) => { const d = _healthReadTail().drain[String(id)]; return typeof d === "number" ? d : null; },
    // v4.4.51: when connected, take the pid/uptime straight from the daemon's ping reply (robust to log
    // rotation); fall back to the log-tail scrape only in in-process fallback mode. Restart detection
    // (pid change) comes along free — the module bumps restartCount when the reported pid changes.
    enginePidProvider: () => (AUDIO_DAEMON && _daemonPingInfo.pid) ? _daemonPingInfo.pid : _healthReadTail().pid,
    engineStartedAtProvider: () => (AUDIO_DAEMON && _daemonPingInfo.startedAt) ? _daemonPingInfo.startedAt : null,
    uuidOf: _stationUuidById,
    stationName: _healthStationName,
    modeProvider: () => AUDIO_DAEMON ? "daemon" : "in-process",   // v4.4.50: playout mode → RED banner in fallback
  });
  _health.start();
  try { ipcMain.handle("health:snapshot", () => { try { return _health.getSnapshot(); } catch { return null; } }); } catch {}

  // Renderer → the honest health ledger. The daemon has had this since the log-reader work; the
  // RENDERER has not, so anything it noticed could only ever reach a console nobody reads. Same
  // file, same shape as the daemon's events, so one ledger holds the whole story.
  //
  // Callers must report STATE TRANSITIONS, not occurrences. A condition that repeats on a timer —
  // a cloud reconcile failing every 20s while a station is offline — writes ONE event when it
  // starts and ONE when it clears. The console spam this replaces reached 1,767 lines and ~95% of
  // ether-startup.log, which actively slowed a freeze diagnosis (backlog 2026-08-03).
  try {
    ipcMain.handle("health:record", (_e, kind, data) => {
      try {
        if (typeof kind !== "string" || !kind) return false;
        const row = { t: new Date().toISOString(), kind, ...(data && typeof data === "object" ? data : {}) };
        require("fs").appendFileSync(path.join(app.getPath("userData"), "health-events.jsonl"), JSON.stringify(row) + "\n");
        return true;
      } catch { return false; }   // the ledger must never be able to break its caller
    });
  } catch {}

  // ── Library & rotation SENSES (Log-reader Slice A) — R2 prefetch + deterministic senses → JSONL ──
  // Background: materializes upcoming R2-only rows to their file_path (so the "half the library never
  // airs" gate can't recur), and computes materialization / pool-health / rotation-eligibility /
  // prefetch-lag / skipped-at-load into health-events.jsonl + a snapshot for the Health Monitor.
  // Declared in the enclosing scope so the daemon event handler (below) can feed noteSkip (Slice B).
  let _libHealth = null;
  try {
    _libHealth = require("./library-health").createLibraryHealth({
      getDb: () => db,
      backendUrl: ETHER_BACKEND_URL,
      licenseKeyFn: () => { try { return accountLicenseKey(); } catch { return null; } },
      broadcast: sendToAllWindows,
      userDataDir: app.getPath("userData"),
    });
    _libHealth.start();
    ipcMain.handle("library-health:get", () => { try { return _libHealth.snapshot(); } catch { return null; } });
    ipcMain.handle("library-health:eligibility", (_e, stationId) => { try { return _libHealth.eligibilityRows(stationId); } catch { return []; } });
    ipcMain.handle("library-health:queue-lint", (_e, stationId) => { try { return _libHealth.lintRows(stationId); } catch { return []; } });
    // ── PHASE C — the advisor, on demand (2026-08-10) ───────────────────────────────────────────
    // SAME goalCheck the Station Health sense uses — one implementation, two cadences. The snapshot
    // above is recomputed on a 120s tick and polled at 30s, which is right for a background sense and
    // useless for "edit a clock, see the verdict change". This is an entry point to the same
    // function, not a copy of its logic: a second implementation would drift and the two surfaces
    // would quietly disagree about the same clock.
    // Called on mount and after committed mutations only — never per keystroke.
    // docs/schedule-manager-design-2026-08-10.md §3.3
    ipcMain.handle("library-health:goals", (_e, stationId) => {
      try { return _libHealth.goalCheck(db, stationId || getActiveStationId()); } catch { return null; }
    });
  } catch (e) { console.error("[library-health] init failed:", e && e.message); }

  audiodClient.setEventHandler((m) => {
    try {
      if (m.event === "levels") {
        // Forward the whole frame with the station UUID (not the per-machine integer id).
        const lv = scopeLevelsFrame(m, _stationUuidById);
        sendToAllWindows("audio:levels", lv);
        // Per-station audio-liveness signal (DESIGN-TRUTH §2): real output keeps THIS station's clock
        // fresh; a wedged station (deck claims playing, output silent) stops updating its own clock
        // because its cpal callback stopped firing → its levels freeze at ~0 while siblings stay fresh.
        if (lv.master > 0.01 || lv.a > 0.01 || lv.b > 0.01 || lv.c > 0.01) _noteStationAudio(m.stationId);
        try { _health.noteLevels(m.stationId, m); } catch {}
      } else if (m.event === "procmeters") {
        // Audio Processing v1: dedicated per-station processing-meter frame (~15Hz, ONLY while a toggle
        // is on). Deliberately its OWN channel — the levels channel already runs ~90/s and is implicated
        // in a renderer OOM, so this stays separate and lower-rate. Observed at the taps; forward as-is.
        sendToAllWindows("audio:proc-meters", m);
      } else if (m.event === "deck") {
        // Per-deck state change from the daemon's poll → renderer proxy (Step 2).
        // Stage 0: forward deckReady (cued) so the renderer mirrors it instead of guessing.
        sendToAllWindows("audio:daemon-deck", { stationId: m.stationId, deck: m.deck, state: m.state, ready: m.ready });
        try { _health.noteDeck(m.stationId, m.deck, m.ready, m.state); } catch {}
      } else if (m.event === "loadskip") {
        // Slice B: a row was skipped/dropped as unresolvable → feed the library-health skipped-at-load
        // sense (+ health-events.jsonl). Never silent.
        try { _libHealth && _libHealth.noteSkip(m.stationId, m.title, m.reason); } catch {}
      } else if (m.event === "logreader-floor" || m.event === "logreader-missed" || m.event === "logreader-ahead" || m.event === "logreader-operator-write" || m.event === "fill-starved" || m.event === "separation-relaxed" || m.event === "position-authority") {
        // Log-Reader Flip (ACTIVATION): loud flip-time events — emergency floor (log exhausted), a
        // behind-anchor missed sweep, an ahead early-play beyond slack, or an operator deck-load written
        // to the log. Plus fill-starved: the refill ladder found NO playable song in ANY of the station's
        // OWN categories (2026-07-26) — surfaced loudly here instead of silently borrowing another
        // station's songs. Appended to the honest health ledger so the law-bending is visible, never silent.
        try {
          require('fs').appendFileSync(path.join(app.getPath('userData'), 'health-events.jsonl'),
            JSON.stringify({ t: new Date().toISOString(), kind: m.event, ...m }) + "\n");
        } catch { /* a lost ledger line is cosmetic */ }
      } else if (m.event === "logreader-shadow") {
        // Log-Reader Flip Phase 3 (§2.7): a go-live boundary — the daemon reports what the time-anchored
        // flip WOULD have aired vs what legacy aired. Append the honest JSONL ledger (the burn-in) AND
        // fold a per-station rolling summary the Health Monitor surfaces. Observation only.
        try {
          require('fs').appendFileSync(path.join(app.getPath('userData'), 'logreader-shadow.jsonl'),
            JSON.stringify({ t: new Date().toISOString(), ...m }) + "\n");
        } catch { /* a lost ledger line is cosmetic */ }
        try {
          const sid = m.stationId;
          const cur = _logReaderShadow.get(sid) || { boundaries: 0, agrees: 0, behind: 0, ahead: 0, onTime: 0, exhausted: 0, maxDriftSec: 0, lastDriftSec: 0, maxMissed: 0, last: null };
          cur.boundaries++;
          if (m.agrees) cur.agrees++;
          if (m.mode === "behind") cur.behind++;
          else if (m.mode === "ahead") cur.ahead++;
          else if (m.mode === "on-time") cur.onTime++;
          else if (m.mode === "exhausted") cur.exhausted++;
          const ad = Math.abs(m.driftSec || 0);
          if (ad > cur.maxDriftSec) cur.maxDriftSec = ad;
          cur.lastDriftSec = m.driftSec || 0;
          if ((m.missedCount || 0) > cur.maxMissed) cur.maxMissed = m.missedCount || 0;
          cur.last = { ts: m.ts, mode: m.mode, driftSec: m.driftSec, missedCount: m.missedCount, agrees: !!m.agrees, wouldAirTitle: m.wouldAirTitle || null };
          _logReaderShadow.set(sid, cur);
        } catch { /* summary is best-effort */ }
      } else if (m.event === "queue") {
        sendToAllWindows("audio:daemon-queue", { stationId: m.stationId, items: m.items, source: m.source });
        try { _health.noteQueue(m.stationId, m.items, m.source); } catch {}
      } else if (m.event === "enginestate") {
        // Honest engine-state truth layer (Slice 1): live | stalled | off from the daemon → renderer,
        // which folds it into the now-playing payload + silent keepalive so a stalled station reports
        // its real state instead of going quiet (→ "offline").
        // FORWARD THE DAEMON'S PAYLOAD INTACT (2026-08-03). This used to hand-list two fields:
        //   { stationId: m.stationId, state: m.state }
        // The daemon had been sending `started` (whether automation is engaged) since 4.4.124, and this
        // line silently DELETED it in transit. The renderer therefore saw started=undefined forever, so
        // observedAutomation returned null and the pill showed MANUAL over a station that was provably
        // automating — through three pill redesigns, an attach investigation, and two wrong theories.
        // Both ENDS were benched; the WIRE between them never was.
        // Spreading the payload kills the whole class: a field added at either end can no longer vanish
        // here. `event` is stripped only because the channel name already carries it.
        const { event: _evt, ...enginestatePayload } = m;
        sendToAllWindows("audio:daemon-enginestate", enginestatePayload);
        _daemonEngineState.set(m.stationId, m.state);   // corroborates the silent-wedge watchdog reload-reason log
        // DELETED 2026-08-03 — observation-derived intent. This registered + PERSISTED automation intent
        // for any station the daemon reported live, so automation-intent.json refilled itself from what
        // the daemon happened to be doing, and the next launch replayed automationStart for it. Receipt:
        // "[AUDIO] auto-resume: registered on-air intent for station 2 (observed live)" at 20:24:34,
        // which is how halloVeen came back automating on its own.
        // THE RULE (Jeff, 2026-08-03): the daemon airing is NEVER evidence of the operator's intent.
        // automation-intent.json is written ONLY by an operator press, and cleared by a clean quit.
        try { _health.noteEngineState(m.stationId, m.state); } catch {}
      } else if (m.event === "playstart") {
        sendToAllWindows("audio:daemon-playstart", { stationId: m.stationId, deck: m.deck, title: m.title, artist: m.artist, filePath: m.filePath });
        try { _health.notePlayStart(m.stationId, m.title, m.artist); } catch {}
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
        try { if (_health) _health.noteStreamStatus(m.stationId, m.state); } catch {}   // v4.4.51: Health Monitor streaming ▲ + drain B/s
      } else if (m.event === "error" && m.where === "play-skip") {
        try { _health.notePlaySkip(m.stationId); } catch {}
      } else if (m.event === "jingle") {
        // JINGLES overlay v1: daemon ARMED/FIRING/ARMED_CANCELLED/CLEARED → renderer (deck indicators +
        // seam chip) + the Health Monitor (jingle cell + ledger event). Observed states only.
        const _jingleUuid = _stationUuidById(m.stationId);
        sendToAllWindows("audio:daemon-jingle", { stationUuid: _jingleUuid, state: m.state, deck: m.deck, title: m.title, categoryId: m.categoryId, contentClass: m.contentClass, leadInSec: m.leadInSec, underlapSec: m.underlapSec, jinDurSec: m.jinDurSec, ts: m.ts });
        try { _health.noteJingle(m.stationId, m); } catch {}
      }
    } catch {}
  });

  // Auto-resume: on every fresh daemon (re)connect, replay automationStart for each station whose
  // intent is on-air. A respawned daemon comes up idle (_started=false) — this re-arms it (the
  // Trace-B dead-air path, now self-healing). A surviving, still-playing daemon hits the engine's
  // existing alreadyOnAir no-op (audibly silent) — we deliberately lean on that single idempotency
  // path rather than adding a second. The very first connect replays nothing (intent is empty).
  // v4.4.50: in-process → daemon handover (only used after a boot-time fallback). Never mid-song: wait
  // for the current in-process song to END (a boundary), then prime the daemon, flip routing, and stop
  // the (already-ended) in-process decks. HIGHEST-RISK code in this release — activates ONLY in the
  // fallback-then-reattach path (no effect in normal daemon mode). See the build report for the soak plan.
  function _doInProcessToDaemonHandover(sid) {
    if (AUDIO_DAEMON) return;
    try {
      logStartup("[AUDIO] HANDOVER (song boundary): in-process → daemon for station " + sid);
      // DELETED 2026-08-03 — the handover no longer PRIMES automation. This sent automationStart with no
      // operator anywhere near it, every time the cold-stage race forced an in-process fallback that later
      // reattached. Receipt: "[AUDIO] HANDOVER (song boundary): in-process -> daemon for station 2" at
      // 20:24:33.573, the launch where halloVeen came up automating. The handover may reattach and OBSERVE;
      // it never engages automation. If automation was genuinely engaged before the fallback, the operator's
      // press is what re-engages it — or the watchdog path, which is untouched.
      // THE RULE (Jeff, 2026-08-03): the AUTO button is the only thing that starts automation.
      AUDIO_DAEMON = true; _inProcessFallback = false;                                             // route audio IPC to the daemon
      for (const d of ["A", "B", "C"]) { try { audio.audioStop(d, sid); } catch {} }               // release the (already-ended) in-process decks
      try { replayIntents(audiodClient, _automationIntent, _streamIntent, { log: (m) => logStartup(`[AUDIO] ${m}`) }); } catch {}
      if (_handoverWatch) { clearInterval(_handoverWatch); _handoverWatch = null; }
      logStartup("[AUDIO] HANDOVER complete — playout on daemon (AUDIO_DAEMON=true)");
    } catch (e) { logStartup("[AUDIO] handover error: " + (e && e.message)); }
  }
  function _armInProcessHandover() {
    if (_handoverWatch) return;
    logStartup("[AUDIO] daemon attached after in-process fallback — handover ARMED; switching at the next song boundary");
    let prevPlaying = true;
    _handoverWatch = setInterval(() => {
      try {
        if (AUDIO_DAEMON || !_inProcessFallback) { clearInterval(_handoverWatch); _handoverWatch = null; return; }
        if (!audiodClient.isConnected()) return;   // daemon dropped again → wait for re-attach
        const sid = getActiveStationId();
        let st; try { st = JSON.parse(audio.audioGetState(sid)); } catch { return; }
        const playing = ["deckA", "deckB", "deckC"].some(d => st && st[d] && st[d].status === "playing");
        if (prevPlaying && !playing) { _doInProcessToDaemonHandover(sid); return; }
        prevPlaying = playing;
      } catch {}
    }, 500);
  }

  audiodClient.setConnectedHandler(() => {
    // A fresh connection supersedes any pending reload (this connect may BE the reloaded daemon).
    disarmDaemonReload();
    checkStaleDaemon();
    _seedAutomationIntentFromDisk();   // ensure the persisted on-air set is loaded before we replay intents (boot + respawn)
    // v4.4.50: if we FELL BACK to in-process at boot and the daemon has now attached, do NOT drive the
    // daemon here (that would double up with the live in-process audio). Arm a song-boundary handover.
    if (_inProcessFallback && !AUDIO_DAEMON) { _armInProcessHandover(); return; }
    // Phase D: replay BOTH automation AND stream intent so a reload restores playout AND the Icecast stream.
    replayIntents(audiodClient, _automationIntent, _streamIntent, { log: (m) => logStartup(`[AUDIO] ${m}`) });
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
      try { audiodClient.setLog(logStartup); } catch {}   // v4.4.50: daemon-client decisions → ether-startup.log (was console-only → hid the silent fallback)
      logStartup("[AUDIO] backend decision: daemon desired — ensure() called, waiting up to 5s for connect");
      audiodClient.ensure();   // spawns + connects; the client self-retries on failure (debounced)
      const t0 = Date.now();
      while (!audiodClient.isConnected() && Date.now() - t0 < 5000) { await napSleep(150); }
      if (audiodClient.isConnected()) {
        AUDIO_DAEMON = true;
        console.log("[AUDIO] daemon ACTIVE — out-of-process engine (ether-audiod)");
        logStartup("[AUDIO] daemon ACTIVE — out-of-process engine (connected in " + (Date.now() - t0) + "ms)");
      } else {
        AUDIO_DAEMON = false;
        _inProcessFallback = true;
        console.warn("[AUDIO] daemon unreachable in the boot window — FALLING BACK to the in-process engine (no dead air)");
        logStartup("[AUDIO] daemon UNREACHABLE in the boot window — in-process fallback; client KEPT RECONNECTING (v4.4.50 non-terminal). Will hand playout to the daemon at a song boundary once it attaches.");
        // v4.4.50: do NOT stop the client. It is now non-terminal — probe-only after the spawn cap (its
        // own MAX_SPAWN_ATTEMPTS storm-guard already prevents a PID storm), so a late/externally-started
        // daemon is picked up and setConnectedHandler arms the song-boundary handover. The old terminal
        // audiodClient.stop() is what stranded the app in-process for the whole session (docs/inprocess-*).
        try { audio.initAudioEngine(); } catch (e) { console.error("[AUDIO] in-process init failed:", e.message); logStartup("[AUDIO] in-process init failed: " + e.message); }
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

// ── Stable machine identity (survives every wipe) ───────────────────────────────────────────────
// The machine's id must OUTLIVE any wipe so the server recognizes a returning machine and reuses its
// activation slot (root fix for ghost activations / lockout). Stored in a LOCAL dir that is a SIBLING
// of the Ether data dir — never inside any path the wipe deletes (LocalAppData\Ether, Roaming\Ether,
// Roaming\com.ether.radio, Roaming\openair). Local (not Roaming) so it's never network-redirected on
// managed boxes like OV.
function _machineIdDir() {
  const localRoot = (process.platform === "win32" && process.env.LOCALAPPDATA)
    ? process.env.LOCALAPPDATA
    : path.dirname(app.getPath("userData"));   // mac/linux: parent of the app's userData
  return path.join(localRoot, "EtherMachine");
}
function getStableMachineId() {
  const fs = require("fs");
  const dir = _machineIdDir();
  const file = path.join(dir, "machine-id");
  // 1. An existing stable id ALWAYS wins — this is the whole point (survives wipes/factory-reset).
  try { if (fs.existsSync(file)) { const id = String(fs.readFileSync(file, "utf8")).trim(); if (id) return id; } } catch {}
  // 2. First time on this machine: adopt the current client_identity id if present (an existing install
  //    keeps its identity — no re-registration), else mint a fresh UUID. Then persist it for good.
  let id = null;
  try { id = db && db.prepare("SELECT client_id FROM client_identity LIMIT 1").get()?.client_id || null; } catch {}
  if (!id) id = require("crypto").randomUUID();
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, id, "utf8"); }
  catch (e) { console.error("[machine-id] persist:", e.message); }
  return id;
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

// THE SIGN-OUT INVARIANT (2026-07-05): sign-out clears EVERY store the ACCOUNT/station/library/session
// touches so the next sign-in/signup starts from absolute zero with no residual. The music library
// (~/Music/ether music library) is NOT touched — it re-bootstraps from the account on next sign-in.
//
// opts.spareProfiles=true (SIGN-OUT / switch / clean-room): PRESERVE operator profiles (the `users`
//   table). Profiles are in-app, machine-local, NOT account identity (CLAUDE.md) — signing out must not
//   delete them. Done via an IN-PLACE clear (keep openair.db, wipe every table except users) so the
//   file that holds profiles survives; session + legacy dirs + keyed copies + markers still cleared.
// opts.spareProfiles falsy (FACTORY RESET): TOTAL file wipe, including profiles.
async function _wipeLocalIdentityAndData(opts = {}) {
  // NOTE (2026-07-05): reverted to a TOTAL FILE WIPE for ALL callers. The profile-sparing in-place clear
  // ("DELETE all tables except a keep-list") corrupted INFRASTRUCTURE — it wiped system_state (the
  // hlc_last mutation clock → NO row could be created afterward), client_identity, and FTS shadow tables.
  // A fresh DB is bulletproof: correct infra every time. Profile-sparing (keep operators/users across
  // sign-out) is DEFERRED to a safe stash+restore implementation, not a live-DB table sweep. opts kept
  // for call-site compatibility; ignored for now.
  void opts;
  // PRE-WIPE: release THIS machine's server activation FIRST, so the wipe never strands a seat (tonight's
  // 5-of-5 lockout was one box registering a new device per wipe). Read license + machine_id BEFORE the
  // wipe. Best-effort (offline is fine).
  try {
    const lk = accountLicenseKey();
    const mid = db.prepare('SELECT client_id FROM client_identity LIMIT 1').get()?.client_id || null;
    if (lk && mid) {
      const { default: fetchFn } = await import('node-fetch').catch(() => ({ default: global.fetch }));
      await fetchFn(`${ETHER_BACKEND_URL}/account/deauthorize-seat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: lk, machine_id: mid }),
      }).catch(() => {});
      console.log('[wipe] released server activation for machine', mid.slice(0, 8));
    }
  } catch (e) { console.error("[wipe] pre-wipe seat release:", e.message); }
  try {
    const { session } = require("electron");
    await session.defaultSession.clearStorageData();   // cookies + all web storage, all origins
    await session.defaultSession.clearCache();
  } catch (e) { console.error("[wipe] clearStorageData:", e.message); }
  const rm = (p) => { try { if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {} };

  // TOTAL file wipe (fresh DB on next launch = correct infrastructure, no residue, no corruption).
  try { db.close(); } catch {}
  rm(path.dirname(_etherDir()));                              // %LOCALAPPDATA%\Ether (DB, WAL, keyed copies, engine staging)
  rm(path.join(app.getPath("appData"), "com.ether.radio"));  // legacy Roaming DB
  rm(path.join(app.getPath("appData"), "openair"));          // pre-rename Roaming userData
  try { rm(app.getPath("sessionData")); } catch {}           // Chromium session store on disk
  for (const m of [".ether-on-air", ".ether-keep-session"]) {
    try { fs.rmSync(path.join(app.getPath("userData"), m), { force: true }); } catch {}
  }
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
async function accountSignOut(switching) {
  try {
    const { dialog } = require("electron");
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question", noLink: true, defaultId: 1, cancelId: 0,
      buttons: ["Cancel", switching ? "Switch Account" : "Sign Out"],
      title: switching ? "Switch Account" : "Sign Out",
      message: switching ? "Switch to a different account?" : "Sign out of this account?",
      detail: "Signs out COMPLETELY — this account and ALL its local data are removed from this computer. The next sign-in starts fresh and pulls only that account's stations and library. Nothing is left behind.",
    });
    if (choice !== 1) return;
    // TOTAL sign-out invariant: clear every identity store (same as factory-reset). Nothing residual.
    try { await _wipeLocalIdentityAndData({ spareProfiles: true }); }  // sign-out spares operator profiles (in-app, not account)
    catch (e) { console.error("[account] sign-out wipe:", e.message); }
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

// ── DB connection lifecycle ────────────────────────────────────────────────────────────────────
// Single shared better-sqlite3 handle (`let db`). Opening is resilient to a TRANSIENT lock (AV /
// Search-indexer touching the freshly-written file): openDb() retries with backoff before throwing
// a real error. getDb() self-heals a closed handle on demand so a one-off failure can't brick every
// later call forever. Distinction baked in per the guardrails:
//   • initDb()  = open + MIGRATE + SEED — used at startup and after a restore (a restored file may be
//                 an older schema). runMigrations()/seedDeckConfigs() are schema_version-gated/
//                 idempotent, so re-running them is safe.
//   • getDb()   = REOPEN ONLY (via openDb) — no migrations, no seeds, NO sidecar drop. Mid-session the
//                 schema is already current and the file healthy; we only lost the handle.
//   • swapDatabaseFile() = the ONLY path that drops -wal/-shm (the swapped-in file is self-contained).

function sleepSync(ms) {
  // Synchronous backoff for the open-retry loop (better-sqlite3 + initDb are synchronous). The app
  // can do nothing useful without the DB, so briefly blocking the main thread here is acceptable.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* busy-wait fallback */ } }
}

// Open (or reopen) the shared connection ONLY — pragmas, no migrations/seeds. Retries a transient lock.
function openDb() {
  const dbPath = getDbPath();
  // Defensive: guarantee the parent folder exists (covers an ETHER_DB_PATH override + fresh install;
  // SQLite throws SQLITE_CANTOPEN on a missing parent dir).
  try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {}
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try { db = new Database(dbPath); break; }
    catch (e) {
      const txt = `${e && e.code ? e.code + " " : ""}${e && e.message ? e.message : e}`;
      const transient = /SQLITE_BUSY|SQLITE_CANTOPEN|EBUSY|EPERM|EACCES|database is locked|locked/i.test(txt);
      if (attempt < MAX_ATTEMPTS && transient) {
        const wait = 100 * Math.pow(2, attempt - 1); // 100, 200, 400, 800 ms
        console.warn(`[DB] open attempt ${attempt}/${MAX_ATTEMPTS} failed (${txt}); retrying in ${wait}ms`);
        sleepSync(wait);
        continue;
      }
      throw new Error(`Cannot open database ${dbPath} after ${attempt} attempt(s): ${txt}`);
    }
  }
  db.pragma("journal_mode = WAL");   // WAL is safe now that the DB is guaranteed local disk
  db.pragma("foreign_keys = ON");
  return db;
}

// Full startup/restore init: open (with retry) + migrate + seed.
// ── SELF-REPAIR ───────────────────────────────────────────────────────────────
// Known-bad database states this build can fix by itself, silently, on launch. The operator is a DJ:
// they double-click Ether and their station comes up. They never see a schema, a dialog, or a choice.
// docs/migration-safety-and-customer-recovery-2026-08-06.md §4
//
// Runs BEFORE the baseline, the ALTERs and the migration chain, so nothing downstream can trip over a
// shape it does not expect. Every branch is idempotent and safe to run on a healthy database.
function repairSchema(conn) {
  let repaired = 0;
  // 4.4.151-156 left `songs` as a VIEW over `songs_all`. Older builds ALTER `songs` at boot and die.
  try {
    const obj = conn.prepare("SELECT type FROM sqlite_master WHERE name='songs'").get();
    const hasAll = !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='songs_all'").get();
    if (obj && obj.type === 'view' && hasAll) {
      console.log('[DB] self-repair: songs is a view — restoring the real table');
      conn.exec(`
        DROP TRIGGER IF EXISTS trg_songs_fts_insert;
        DROP TRIGGER IF EXISTS trg_songs_fts_update;
        DROP TRIGGER IF EXISTS trg_songs_fts_delete;
        DROP VIEW songs;
        ALTER TABLE songs_all RENAME TO songs;
      `);
      repaired++;
    }
    // Half-finished rename (crash mid-migration): songs_all exists but songs does not.
    if (!obj && hasAll) {
      console.log('[DB] self-repair: songs missing, songs_all present — completing the rename');
      conn.exec("ALTER TABLE songs_all RENAME TO songs");
      repaired++;
    }
  } catch (e) { console.error('[DB] self-repair (songs) failed:', (e && e.message) || e); }
  if (repaired) {
    console.log(`[DB] self-repair applied ${repaired} fix(es) — opening normally`);
    try { splashStatus("Repairing station database…"); } catch {}
    try { bootReport.push({ label: "Repaired station database", ms: 0, ok: true, repair: true }); } catch {}
  }
  return repaired;
}

// ── BOOT STATUS ───────────────────────────────────────────────────────────────
// A pause with no explanation reads as a freeze. Even a fast repair, done silently, looks like the app
// hung — the same panic the Generate progress bar fixed. So every startup step that could stall says
// what it is doing, on the splash, while it does it; and what happened is reported into the app
// afterwards so an engineer can see "Repaired station database — 0.3s" instead of guessing.
// Informational only: never a decision, never blocking.
const bootReport = [];
function bootStep(label, fn) {
  const t0 = Date.now();
  try { splashStatus(label); } catch { /* splash not up yet */ }
  try {
    const out = fn();
    const ms = Date.now() - t0;
    bootReport.push({ label, ms, ok: true });
    if (ms > 150) console.log(`[BOOT] ${label} — ${ms}ms`);
    return out;
  } catch (e) {
    bootReport.push({ label, ms: Date.now() - t0, ok: false, error: String((e && e.message) || e) });
    throw e;
  }
}

function initDb() {
  const dbPath = getDbPath();
  console.log("[DB] Path:", dbPath);
  bootStep("Opening station database…", () => openDb());
  console.log("[DB] Connected:", dbPath);
  bootStep("Checking station database…", () => repairSchema(db));   // in-place, offline, before anything else
  bootStep("Updating station database…", () => runMigrations());
  bootStep("Preparing decks…", () => seedDeckConfigs());
  setTimeout(() => { try { console.log("[DB] Song count:", db.prepare("SELECT COUNT(*) as c FROM songs").get()); } catch(e) { console.log("[DB] Song count error:", e.message); } }, 500);
}

// Closed-handle guard / self-heal. Returns the live connection, REOPENING it (open-only) if it was
// left closed — e.g. a transient failure during a restore reopen — so a one-off failure recovers on
// the next call instead of throwing "database connection is not open" forever. All db-holding
// sub-modules resolve through this so the heal holds app-wide.
function getDb() {
  if (!db || !db.open) {
    // While a restore holds the gate, this self-heal is exactly the bug: reopening here recreates
    // -wal/-shm and re-locks the files the swap is trying to remove, so the sync could never succeed
    // from a running station. Refuse, loudly and catchably, until the swap is done.
    if (restoreGateActive()) {
      throw new Error("RESTORE_IN_PROGRESS: the station database is being replaced — not reopening it mid-swap");
    }
    console.warn("[DB] connection not open — reopening (self-heal)");
    openDb();
  }
  return db;
}

// Atomically swap the live DB file with `srcPath` (restore / cloud-install). Backs up the current DB
// FIRST so a failed reopen ROLLS BACK instead of leaving the app bricked; verifies the new handle
// with a trivial read before declaring success; NEVER swallows — throws a real error to the caller.
// This is the only path that drops WAL sidecars (the swapped-in file is a fresh, self-contained DB).
// Is this file a usable Ether database? Answered BEFORE the live DB is touched.
// A torn backup (main file read without its WAL) throws "malformed database schema (<object>)" the
// moment SQLite parses sqlite_master — which, without this gate, happened only AFTER the live DB had
// been closed and overwritten, so the operator saw a failed restore + rollback instead of a refusal.
// Probing here costs one read-only open and turns a dead-end into "that backup is bad, yours is intact."
// LIMIT: this proves the file opens and its schema + core tables are readable. It is not a full-page
// integrity_check — that scans hundreds of MB and would stall the restore for minutes.
function validateDatabaseFile(srcPath) {
  let conn = null;
  try {
    conn = new Database(srcPath, { readonly: true, fileMustExist: true });
    // Forces the schema parse — this is exactly where a torn file throws "malformed database schema".
    const objs = conn.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()?.n ?? 0;
    if (objs < 20) throw new Error(`schema looks truncated (${objs} objects)`);
    conn.prepare("SELECT COUNT(*) AS n FROM system_state").get();   // the table the restore verifies
    const songs = conn.prepare("SELECT COUNT(*) AS n FROM songs").get()?.n ?? 0;
    return { ok: true, objects: objs, songs };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { if (conn) conn.close(); } catch {}
  }
}

// Verify a database file WITHOUT blocking the main thread — the restore's heavy reads (schema parse,
// integrity_check on hundreds of MB) are what made the window go "Not Responding" mid-restore.
// Falls back to the in-process check if a worker can't start, so verification is never skipped.
function verifyDatabaseFileAsync(dbFile, { deep = false, onProgress } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const { Worker } = require("worker_threads");
      const w = new Worker(path.join(__dirname, "db-verify-worker.js"), { workerData: { dbFile, deep } });
      w.on("message", (m) => {
        if (m && m.progress && onProgress) { try { onProgress(m.progress); } catch {} return; }
        if (m && m.result) { done(m.result); try { w.terminate(); } catch {} }
      });
      w.on("error", (e) => {
        restoreLog(`verification worker failed (${e.message}) — falling back to in-process check`);
        done(validateDatabaseFile(dbFile));
      });
      w.on("exit", () => done({ ok: false, reason: "verification ended without a result" }));
    } catch (e) {
      restoreLog(`verification worker unavailable (${e.message}) — using in-process check`);
      done(validateDatabaseFile(dbFile));
    }
  });
}

// Append a timestamped line to the restore log. Every branch of the restore writes here — the absence
// of any record of a database-open failure is what made this take days to diagnose.
function restoreLog(line) {
  const stamp = new Date().toISOString();
  try { console.log(`[RESTORE] ${line}`); } catch {}
  try {
    fs.appendFileSync(path.join(path.dirname(getDbPath()), "restore-failures.log"),
      `${stamp}  ${line}\n`, "utf8");
  } catch { /* the log must never be the thing that breaks a restore */ }
}

// "malformed database schema (<name>)" — read what SQLite is actually objecting to.
// SQLite still permits raw sqlite_master reads when the normal schema parse fails, so the definition
// can be recovered and LOGGED even though the database will not open normally.
//
// MEASURED, 2026-08-07, before writing this: the name SQLite reports on OV
// (429310a3-7544-4bc1-8460-c4ab621e07ba) does NOT exist in sqlite_master on any database we hold. It
// exists only as DATA, in metadata_definitions.uuid. The real schema carries 0 UUID-named objects and
// 0 double-quoted string literals across 180 definitions, and better-sqlite3 has never been bumped
// (^12.8.0 throughout, lockfile 12.8.0) — so the SQLITE_DQS=0 explanation has no candidate here.
// That means the parser is reading a DATA page where a schema page belongs, and "dropping the object"
// would be deleting something that isn't there. So: always capture and log; only remove when the
// object genuinely EXISTS and is a view/trigger/index. Never touch tables. Never delete blind.
function inspectMalformedSchema(dbFile, objectName) {
  let conn = null;
  try {
    conn = new Database(dbFile, { fileMustExist: true });
    conn.pragma("writable_schema=ON");
    const row = conn.prepare("SELECT type, name, sql FROM sqlite_master WHERE name = ?").get(objectName);
    if (!row) {
      restoreLog(`self-heal: SQLite reported "${objectName}" but NO SUCH OBJECT exists in sqlite_master — ` +
                 `the schema page is being misread (this name appears in this product as row DATA, not a definition). Nothing to drop.`);
      try { conn.pragma("writable_schema=OFF"); } catch {}
      return { found: false, removed: false };
    }
    restoreLog(`self-heal: offending object → type=${row.type} name=${row.name}`);
    restoreLog(`self-heal: its SQL → ${String(row.sql ?? "(null)").replace(/\s+/g, " ").slice(0, 1000)}`);
    if (row.type === "table") {
      restoreLog(`self-heal: object is a TABLE — refusing to remove it; rolling back instead.`);
      try { conn.pragma("writable_schema=OFF"); } catch {}
      return { found: true, removed: false, type: row.type };
    }
    conn.prepare("DELETE FROM sqlite_master WHERE name = ?").run(objectName);
    conn.pragma("writable_schema=OFF");
    restoreLog(`self-heal: removed ${row.type} "${row.name}" from the schema; the app recreates its own ${row.type}s on startup.`);
    return { found: true, removed: true, type: row.type };
  } catch (e) {
    restoreLog(`self-heal: could not inspect "${objectName}": ${e.message}`);
    return { found: false, removed: false, error: e.message };
  } finally {
    try { if (conn) conn.close(); } catch {}
  }
}

// Open the copied database, self-healing removable schema objects SQLite rejects. Returns the
// validation result. Bounded at 20 passes so a pathological file can never spin.
async function openWithSchemaSelfHeal(dbFile, onProgress) {
  const MALFORMED = /malformed database schema \((.+?)\)/;
  for (let pass = 0; pass < 20; pass++) {
    const res = await verifyDatabaseFileAsync(dbFile, { onProgress });
    if (res.ok) {
      if (pass > 0) restoreLog(`self-heal: database opens after ${pass} repair pass(es)`);
      return res;
    }
    const m = MALFORMED.exec(res.reason || "");
    if (!m) return res;                                   // a different failure — caller rolls back
    restoreLog(`self-heal: pass ${pass + 1} — SQLite rejects schema object "${m[1]}"`);
    const fixed = inspectMalformedSchema(dbFile, m[1]);
    if (!fixed.removed) return { ...res, selfHeal: fixed };   // nothing safely removable → give up
  }
  restoreLog(`self-heal: gave up after 20 passes`);
  return { ok: false, reason: "the database schema could not be repaired after 20 passes" };
}

// ASYNC: the copies and verification are the parts that used to freeze the window. fs.promises.copyFile
// runs on libuv's threadpool and the verification runs in a worker, so the main thread keeps painting
// through a restore instead of going "Not Responding" for the length of a 450 MB copy.
// Public entry: holds the restore gate for the WHOLE operation so nothing in this app can reopen the
// database mid-swap, and always releases it — success, failure or throw.
async function swapDatabaseFile(srcPath, onProgress) {
  setRestoreGate("replacing the station database");
  try {
    return await _swapDatabaseFileGated(srcPath, onProgress);
  } finally {
    clearRestoreGate();
    // Whatever happened, this app must end with a usable connection.
    try { if (!db || !db.open) { initDb(); restoreLog("post-restore: database reopened"); } } catch (e) { restoreLog(`post-restore reopen failed: ${e.message}`); }
  }
}

async function _swapDatabaseFileGated(srcPath, onProgress) {
  const say = (m) => { restoreLog(m); try { onProgress?.(m); } catch {} };
  const fsp = fs.promises;
  const dbPath = getDbPath();
  const preRestore = dbPath + ".pre-restore";
  if (!fs.existsSync(srcPath)) throw new Error(`swapDatabaseFile: source not found: ${srcPath}`);
  // 0. Refuse a damaged source OUTRIGHT — live DB never closed, never overwritten, nothing to roll back.
  say("checking the backup file");
  const check = await verifyDatabaseFileAsync(srcPath);
  if (!check.ok) {
    console.error("[DB] refused a damaged restore source (live DB untouched):", check.reason);
    throw new Error(`That backup file is damaged and was not used — your current station is untouched and still running. (${check.reason})`);
  }
  console.log(`[DB] restore source verified: ${check.objects} schema objects, ${check.songs} songs`);

  // 0b. FREE SPACE — a restore transiently needs the source twice over on the database's own volume
  // (the copied-in file + the .pre-restore rollback copy) on top of what is already there. Running out
  // mid-copy produces a truncated database, which fails at open and reads exactly like a corrupt
  // backup. Check first and say so plainly, rather than discovering it as corruption.
  const srcBytes = (() => { try { return fs.statSync(srcPath).size; } catch { return 0; } })();
  try {
    const st = fs.statfsSync(path.dirname(dbPath));
    const freeBytes = st.bavail * st.bsize;
    const needBytes = srcBytes * 2 + 64 * 1024 * 1024;        // both copies + headroom
    const mb = (n) => `${Math.round(n / 1048576).toLocaleString()} MB`;
    console.log(`[DB] restore space check: need ~${mb(needBytes)}, free ${mb(freeBytes)} on ${path.dirname(dbPath)}`);
    if (freeBytes < needBytes) {
      throw new Error(`not enough free space to restore safely — this needs about ${mb(needBytes)} free on the drive holding your station, and there is ${mb(freeBytes)}. Free some space and try again. Your current station is untouched and still running.`);
    }
  } catch (e) {
    if (/not enough free space/.test(e.message)) throw e;
    console.warn("[DB] restore space check skipped:", e.message);   // statfs unsupported — proceed
  }

  // 1. Back up the current live DB BEFORE closing — the rollback point. Abort untouched if this fails.
  say("saving a rollback copy of your current station");
  try { if (fs.existsSync(dbPath)) await fsp.copyFile(dbPath, preRestore); }
  catch (e) { throw new Error(`pre-restore backup failed (aborted, live DB untouched): ${e.message}`); }
  // Clearing the previous database's journal files is NOT optional, and failing to clear them used to
  // be swallowed silently. SQLite replays a leftover -wal over whatever main file is at this path — so
  // a stale journal from the OLD database, replayed over the NEWLY copied one, yields old schema pages
  // in a new file: "malformed database schema (<object>)", deterministically, with the copied file
  // byte-identical to a source that opens perfectly. On Windows a delete fails while ANOTHER PROCESS
  // (the out-of-process audio daemon opens this same database) holds the file. Report, retry, verify.
  const dropSidecars = () => {
    const remaining = [];
    for (const s of ["-wal", "-shm", "-journal"]) {
      const p = dbPath + s;
      try { fs.rmSync(p, { force: true }); } catch { /* checked below — never assumed */ }
      try { if (fs.existsSync(p)) remaining.push(path.basename(p)); } catch {}
    }
    return remaining;
  };
  // Retry briefly: a daemon that is mid-write releases within a moment; a daemon that is holding the
  // database open will not, and that must surface as itself rather than as corruption.
  const dropSidecarsInsisting = () => {
    let left = dropSidecars();
    for (let i = 0; i < 10 && left.length; i++) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); left = dropSidecars(); }
    return left;
  };
  // ── QUIESCE ───────────────────────────────────────────────────────────────────────────────────
  // Two processes hold this database open: THIS one, and the audio daemon (ether-audiod opens it
  // read-write for the scheduler). Both must let go before the file can be replaced — and this app
  // re-acquires constantly, because the renderer polls several times a second and any db-touching
  // IPC makes getDb() reopen. Telling the operator to "close Ether" was a dead end: syncing from a
  // running station could never succeed. So the app quiesces ITSELF instead.
  //
  // Playback stops. That is inherent — the station's database is being replaced underneath it.

  // 1. Daemon: stop engines/streams and close its handle. Wait for the reply; never hang on it.
  say("stopping the audio engine");
  try {
    const release = audiodClient.cmd("releaseDb", {});
    const outcome = await Promise.race([
      Promise.resolve(release).then(r => ({ ok: true, r })),
      new Promise(res => setTimeout(() => res({ ok: false, timeout: true }), 8000)),
    ]);
    if (outcome.timeout) restoreLog("quiesce: audio engine did not confirm within 8s — continuing; the journal check below is the real gate");
    else restoreLog(`quiesce: audio engine released the database (${JSON.stringify(outcome.r)})`);
  } catch (e) {
    restoreLog(`quiesce: audio engine release failed (${e.message}) — continuing; the journal check below is the real gate`);
  }

  // 2. Fold the WAL back into the main file so there is nothing left to remove, then close ours.
  try { db.pragma("wal_checkpoint(TRUNCATE)"); restoreLog("quiesce: WAL checkpointed into the database"); }
  catch (e) { restoreLog(`quiesce: WAL checkpoint skipped (${e.message})`); }
  try { db.close(); restoreLog("quiesce: this app closed its database connection"); } catch (e) { restoreLog(`quiesce: close reported ${e.message}`); }

  // 3. The journals must be GONE and unlocked. With the gate set, nothing in this app can recreate
  //    them; if they survive, something outside this app still holds the file.
  {
    const stuck = dropSidecarsInsisting();
    if (stuck.length) {
      restoreLog(`quiesce FAILED — still locked after stopping the engine and closing the database: ${stuck.join(", ")}`);
      try { initDb(); restoreLog("quiesce: station reopened; nothing was changed"); }
      catch (e) { restoreLog(`quiesce: reopen after aborted restore failed: ${e.message}`); }
      throw new Error(`Sync couldn't start: ${stuck.join(" and ")} could not be released, even after stopping the audio engine and closing the station database. Something outside Ether is holding those files (antivirus or backup software is the usual cause). Your current station is untouched and still running.`);
    }
    restoreLog("quiesce: journal files removed and unlocked — safe to replace the database");
  }
  // Which stage failed. The rollback used to collapse every cause into one identical sentence, so a
  // truncated copy, a bad file and a failing migration were indistinguishable from the outside — on a
  // machine nobody can inspect, that is the difference between a diagnosis and a guessing game.
  let step = "copying the backup into place";
  try {
    // 2. copy fresh file in + drop any journal that reappeared, then 3. reopen with full init.
    say("installing the restored station");
    await fsp.copyFile(srcPath, dbPath);
    step = "clearing the previous database's journal files";
    const reappeared = dropSidecarsInsisting();
    if (reappeared.length) {
      // Something recreated them between the pre-flight and now — i.e. another process is actively
      // using this database. Opening now would replay the old journal over the new file.
      throw new Error(`${reappeared.join(", ")} came back while the station was being replaced — another part of Ether (most likely the audio engine) still has the database open. Fully close Ether and try again`);
    }

    // 2b. VERIFY THE DESTINATION, not just the source. A short write here (full disk, interrupted
    // volume) yields a truncated database that opens as "malformed database schema" during init —
    // indistinguishable from a corrupt download unless it is checked at the point it happens.
    step = "verifying the copied database";
    const destBytes = fs.statSync(dbPath).size;
    if (srcBytes && destBytes !== srcBytes) {
      throw new Error(`the copy is incomplete — ${destBytes.toLocaleString()} of ${srcBytes.toLocaleString()} bytes landed on disk (the drive may be full)`);
    }
    // Self-heal removable schema objects rather than failing outright; every pass is logged.
    say("checking the installed station");
    const destCheck = await openWithSchemaSelfHeal(dbPath, onProgress);
    if (!destCheck.ok) {
      restoreLog(`FAILED at "${step}": ${destCheck.reason}`);
      throw new Error(`the copied database will not open: ${destCheck.reason}`);
    }
    restoreLog(`copied database verified: ${destCheck.objects} schema objects, ${destCheck.songs} songs`);
    // Deep integrity check — in the worker, so a multi-hundred-MB scan never freezes the window.
    const deep = await verifyDatabaseFileAsync(dbPath, { deep: true, onProgress });
    restoreLog(`integrity_check: ${deep.integrity ?? "(not run)"}`);
    if (deep.ok && deep.integrity && deep.integrity !== "ok") {
      throw new Error(`the restored database failed its integrity check: ${deep.integrity}`);
    }

    step = "upgrading the restored database";     // repairSchema + the migration chain run in here
    initDb();
    // 4. verify the new handle with a trivial read before declaring success.
    step = "reading the restored database";
    getDb().prepare("SELECT COUNT(*) AS n FROM system_state").get();
    if (!db.open) throw new Error("handle reports not-open after reopen");
  } catch (swapErr) {
    swapErr.message = `${step}: ${swapErr.message}`;
    // 5. roll back to the pre-restore DB and re-init; surface a real error either way.
    console.error("[DB] restore reopen failed — rolling back:", swapErr.message);
    // Record what actually happened, on LOCAL disk next to the database, before anything else can
    // fail. A failed restore happens on machines no one can look at; a message that scrolls past in a
    // dialog is not evidence. This file is the receipt — step, real error, sizes and free space.
    try {
      let freeTxt = "unknown";
      try { const s = fs.statfsSync(path.dirname(dbPath)); freeTxt = `${Math.round((s.bavail * s.bsize) / 1048576).toLocaleString()} MB`; } catch {}
      let destTxt = "n/a";
      try { destTxt = `${fs.statSync(dbPath).size.toLocaleString()} bytes`; } catch {}
      // Journals present at the moment of failure — a leftover -wal replayed over the new file is the
      // difference between "the backup is corrupt" and "something still had the database open".
      let sidecarTxt = "none";
      try {
        const present = ["-wal", "-shm", "-journal"].filter(s => fs.existsSync(dbPath + s))
          .map(s => `${path.basename(dbPath + s)} (${fs.statSync(dbPath + s).size.toLocaleString()} b)`);
        sidecarTxt = present.length ? present.join(", ") : "none";
      } catch {}
      // Do the source and destination actually hold the same bytes? Settles copy-corruption vs open-time
      // corruption without anyone having to reproduce it.
      let sameTxt = "not compared";
      try {
        const crypto = require("crypto");
        const hash = (p) => crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
        sameTxt = hash(srcPath) === hash(dbPath) ? "identical" : "DIFFERENT — the copy altered the file";
      } catch (e) { sameTxt = `not compared (${e.message})`; }
      fs.appendFileSync(path.join(path.dirname(dbPath), "restore-failures.log"),
        `${new Date().toISOString()}  v${app.getVersion()}\n` +
        `  failed while: ${step}\n` +
        `  error       : ${swapErr.message}\n` +
        `  source      : ${srcPath} (${srcBytes.toLocaleString()} bytes)\n` +
        `  destination : ${destTxt}\n` +
        `  src vs dest : ${sameTxt}\n` +
        `  journals    : ${sidecarTxt}\n` +
        `  free space  : ${freeTxt}\n\n`, "utf8");
    } catch (logErr) { console.warn("[DB] could not write restore-failures.log:", logErr.message); }
    try {
      try { if (db && db.open) db.close(); } catch {}
      if (fs.existsSync(preRestore)) await fsp.copyFile(preRestore, dbPath);
      dropSidecars();
      initDb();
      getDb().prepare("SELECT COUNT(*) AS n FROM system_state").get();
    } catch (rollbackErr) {
      // Rollback ALSO failed — KEEP .pre-restore as the only good copy for manual recovery.
      throw new Error(`restore failed AND rollback failed — DB may need manual recovery (kept ${preRestore}): ${swapErr.message} | rollback: ${rollbackErr.message}`);
    }
    // Rollback succeeded → live DB is good again; the .pre-restore copy is now redundant.
    try { fs.rmSync(preRestore, { force: true }); } catch {}
    throw new Error(`restore failed; rolled back to the previous database: ${swapErr.message}`);
  }
  try { fs.rmSync(preRestore, { force: true }); } catch {}   // success — drop the rollback copy
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
    // FAIL SOFT. An unguarded statement in here is what turned a schema difference into a dead app on
    // a customer machine: these scripts run raw `ALTER TABLE songs ADD COLUMN`, and against an
    // unexpected schema the throw escaped initDb() and the operator got a fatal dialog. A migration
    // that cannot apply is a logged skip — never a station that will not start.
    // docs/migration-safety-and-customer-recovery-2026-08-06.md
    try {
      require(path.join(scriptsDir, file)).applyMigration(db);
    } catch (e) {
      console.error(`[DB] migration ${file} skipped (non-fatal):`, (e && e.message) || e);
    }
  }
}

function runMigrations() {
  const schemaVersionExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();
  const isFreshInstall = !schemaVersionExists ||
    !db.prepare("SELECT 1 FROM schema_version LIMIT 1").get();

  require('../scripts/schema-v0-baseline')(db);

  // ── A DELETE IS A DELETE — the SAFE shape (2026-08-06, revised after a customer machine went down) ──
  //
  // Jeff's law stands: "a delete should be a delete from the foundation up — nothing downstream needs
  // to filter deleted, because nothing deleted is left to encounter."
  //
  // 4.4.151 achieved that by renaming `songs` to `songs_all` and making `songs` a VIEW. It worked, and
  // it STRANDED A CUSTOMER: builds already in the field run `runMigrationChain()` at boot, which
  // executes raw `ALTER TABLE songs ADD COLUMN` from scripts/migrate-*-phase-sync-*.js. Against a view
  // SQLite answers "Cannot add a column to a view", the exception escapes initDb(), and the operator
  // gets a fatal dialog with one button: Quit. A machine that cannot launch, with no way back.
  //
  // THE RULE THAT SHAPE BROKE: a migration that reaches customers must leave the database openable by
  // the PREVIOUS build. So `songs` stays a real TABLE forever, and deleted rows LEAVE it:
  //   • `songs`         — live rows only. Old builds open it and see exactly what they expect.
  //   • `songs_deleted` — the graveyard, same columns. A delete MOVES the row here.
  // Deleted songs are unreachable to every selector because they are not in the table — the same
  // guarantee the view gave, with nothing to remember and nothing to strand.
  //
  // docs/migration-safety-and-customer-recovery-2026-08-06.md
  //
  // Idempotent and self-healing. Runs on every boot; does nothing when already correct.
  {
    const obj = db.prepare("SELECT type FROM sqlite_master WHERE name='songs'").get();
    const hasSongsAll = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='songs_all'").get();

    // REPAIR: a database migrated by 4.4.151–4.4.156 (songs = VIEW over songs_all). This is the branch
    // that un-bricks a machine that cannot currently launch. One transaction; no data is discarded.
    if (obj && obj.type === 'view' && hasSongsAll) {
      console.log('[DB] REPAIR: songs is a view (4.4.151-156 schema) — restoring a real table so every build can open this database');
      db.exec(`
        DROP TRIGGER IF EXISTS trg_songs_fts_insert;
        DROP TRIGGER IF EXISTS trg_songs_fts_update;
        DROP TRIGGER IF EXISTS trg_songs_fts_delete;
        DROP VIEW songs;
        ALTER TABLE songs_all RENAME TO songs;
      `);
      console.log('[DB] REPAIR: songs is a table again');
    }

    // NO GRAVEYARD. Moving deleted rows out of `songs` was tried and REJECTED by proof on a real
    // database: generated_schedule.song_id, scheduled_log.song_id and song_metadata_values.song_id all
    // reference songs(id) with NO ACTION, station_programming with RESTRICT, and pinned_songs with
    // CASCADE. The preserved history we deliberately keep IS what holds those references — so removing
    // the row fails with FOREIGN KEY constraint failed, and the CASCADE would silently delete pins.
    // The row therefore STAYS in `songs`, tombstoned; unreachability is achieved in DATA (see
    // handlers/songs.js songsDelete). docs/migration-safety-and-customer-recovery-2026-08-06.md
  }

  // play_log(file_path, station_id, played_at) — the index the least-recently-played lookups need.
  // Without it every LRP query does a FULL SCAN of play_log per candidate row: measured 1015ms for one
  // 52-candidate jingle pool on a 36,900-row play_log, which is what froze Generate for minutes
  // (docs/generate-freeze-and-calendar-history-2026-08-06.md §8). With it: 0.16ms. Also serves the
  // daemon's loggen LRP ordering and buildRestMaps. Cheap to build (~80ms), idempotent.
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_play_log_file_station ON play_log(file_path, station_id, played_at)"); } catch {}

  // Add any missing columns via ALTER TABLE (safe to re-run)
  // NOTE: these target `songs`, which is and stays a real TABLE. It was briefly a view (4.4.151-156)
  // and that is exactly what stranded a customer — an older build's migration chain ran ALTER against
  // it and died. Never point schema changes at a view.
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

  // ── PHASE 3 — per-station scheduler mode (2026-08-10) ──────────────────────────────────────────
  // 'clock' (default, today's behaviour) | 'goal' (rotation goals choose the category).
  // Deliberately NOT added to electron/sync/synced-tables.js: this is a per-INSTALL rollout decision,
  // like the log-reader flip canary, and syncing it would flip another machine's scheduler as a side
  // effect of sync. The column exists on `stations` as specified; it simply does not travel.
  // docs/phase3-wiring-plan-2026-08-10.md · docs/goal-driven-scheduler-redesign-2026-08-10.md
  alterSafe("ALTER TABLE stations ADD COLUMN scheduler_mode TEXT DEFAULT 'clock'");

  // ── PHASE 4 — why this row was chosen (2026-08-10) ────────────────────────────────────────────
  // Compact JSON per music row: category, pool size, veto counts, rules relaxed, and (in goal mode)
  // the target/paced/placed figures. Reasons CANNOT be reconstructed after the fact — the vetoed and
  // losing candidates exist only during the pick — so this has to be written as the log is built.
  // The design doc (§5.3) chose a column over a side table so the reason travels with the row through
  // regenerate, delete and sync, and because the natural query is "why this row?", not an aggregate.
  alterSafe("ALTER TABLE generated_schedule ADD COLUMN pick_reason TEXT");

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
  // NOTE: orphan owner self-heal moved to the renderer reconcile (src/lib/ccData.ts) which has the
  // AUTHORITATIVE signed-in account license. An earlier version here picked the lowest station's
  // per-station license_key KV (ORDER BY station_id LIMIT 1) — which on a build carrying a stale
  // license (e.g. djdeniro's) mis-tagged new stations to the WRONG account. The reconcile owns this
  // now: it stamps every station with the account's real license and registers any unregistered
  // station with the cloud (POST /account/register-station).

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

  // (Removed 2026-07-29) A blanket "UPDATE deck_configs SET enabled=1 WHERE slot IN
  // ('D','E','F')" used to run here. It hardcoded a specific slot set, and it overrode
  // the operator's own choice on every startup. Which decks are enabled is data the
  // operator owns — the seeder supplies defaults for a station that has none and never
  // touches a station that already has rows.

  // v2 (station-provisioning): the default "Station 1" seed is REMOVED. A fresh install starts with
  // ZERO stations; onboarding/sign-in provisioning is the only creator of the first station, which
  // seeds its own per-station config (spec §8). Migrations that loop over stations no-op on 0 rows.

  runMigrationChain(db);

  if (isFreshInstall) seedFreshInstall();

  // STABLE MACHINE IDENTITY (root fix, 2026-07-05): the machine's id lives OUTSIDE every wiped store
  // (getStableMachineId → LocalAppData\EtherMachine\machine-id). A wipe erases the machine's world but
  // NEVER its identity. Force client_identity to that stable id on every boot — all machine_id plumbing
  // (identity:get, /account/connect, activation, station_attachments.surface_id, sync:devices) reads
  // client_identity.client_id, so a returning machine is recognized and the server REUSES its slot.
  // Ghost activations become structurally impossible, not cleaned up.
  try {
    const stableId = getStableMachineId();
    const row = db.prepare("SELECT client_id FROM client_identity LIMIT 1").get();
    if (!row) {
      db.prepare("INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, NULL)")
        .run(stableId, new Date().toISOString());
    } else if (row.client_id !== stableId) {
      db.prepare("UPDATE client_identity SET client_id = ?").run(stableId);
    }
    console.log("[DB] machine identity (stable):", String(stableId).slice(0, 8));
  } catch (e) { console.error("[DB] stable machine identity:", e.message); }

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


  // v2: no default station seeded here. The first station comes from onboarding/provisioning
  // (spec §8), which also seeds its icecast + per-station config in one transaction.

  // v2: per-station config (separation_rules etc.) is seeded at STATION CREATION (spec §8), not here.
  // Guarded on a real active station so a zero-station fresh install seeds nothing (no null station_id write).
  const sid = getActiveStationId();
  const ruleCount = db.prepare("SELECT COUNT(*) as c FROM separation_rules").get();
  if (sid != null && ruleCount.c === 0) {
    const insertRule = db.prepare(
      "INSERT INTO separation_rules (station_id, rule_type, scope, value, is_hard, is_active, description) VALUES (?,?,?,?,?,?,?)"
    );
    const seedRules = db.transaction(() => {
      insertRule.run(sid, 'artist_separation_min', 'global', 60,  1, 1, 'Minimum minutes between songs by the same artist');
      insertRule.run(sid, 'song_separation_min',   'global', 180, 1, 1, 'Minimum minutes before a song can repeat');
      insertRule.run(sid, 'title_separation_min',  'global', 120, 1, 1, 'Minimum minutes between songs with the same title');
      insertRule.run(sid, 'max_same_category',      'global', 3,   0, 1, 'Max consecutive songs from the same category');
    });
    seedRules();
    console.log("[DB] Seeded default separation rules for station", sid);
  }

  // Migration (2026-07-24): remove max_same_gender everywhere — never enforced, not wanted. separation_rules
  // is a synced soft-delete table, so TOMBSTONE (deleted_at + bumped updated_at) so the removal propagates to
  // every install rather than a hard delete a peer could resurrect. Idempotent (only touches live rows).
  try {
    const nowIso = new Date().toISOString();
    const res = db.prepare(
      "UPDATE separation_rules SET deleted_at = ?, updated_at = ?, is_active = 0 WHERE rule_type = 'max_same_gender' AND deleted_at IS NULL"
    ).run(nowIso, nowIso);
    if (res.changes > 0) console.log(`[DB] Tombstoned ${res.changes} max_same_gender separation rule(s)`);
  } catch (e) { console.error('[DB] max_same_gender cleanup failed:', e.message); }
}

// ── Active station helper ─────────────────────────────────────
function getActiveStationId() {
  // v2: returns null when NO active station exists (fresh install, pre-onboarding). Boot-path callers
  // guard on null; user-triggered IPC handlers only run once a station exists. (Was `?? 1`, a phantom
  // that targeted a non-existent station and would FK-violate station_programming/pinned_songs/metadata.)
  try {
    const row = getDb().prepare("SELECT id FROM stations WHERE is_active=1 LIMIT 1").get();
    return row?.id ?? null;
  } catch { return null; }
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
// ── Deck config seeding ───────────────────────────────────────────────────────
// A station is a data binding, not a variant: EVERY station gets the same default deck
// set, seeded for its own station_id. Before v35 the table's PK was `slot` alone, so
// only one station's decks could exist at all (all of them landing on station 1 by the
// station_id column default) and every other station read zero rows.
//
// DEFAULT_DECKS is the single source of the default set. Nothing counts it, nothing
// assumes six, nothing pattern-matches the letters — adding a slot here (or inserting a
// row later) is all that is needed.
const DEFAULT_DECKS = [
  { slot: "A", type: "music", label: "Deck A", color: "#34d399", enabled: 1 },
  { slot: "B", type: "music", label: "Deck B", color: "#38bdf8", enabled: 1 },
  { slot: "C", type: "music", label: "Deck C", color: "#a78bfa", enabled: 1 },
  { slot: "D", type: "music", label: "Deck D", color: "#f97316", enabled: 0 },
  { slot: "E", type: "music", label: "Deck E", color: "#ef4444", enabled: 0 },
  { slot: "F", type: "guest", label: "Guest 2", color: "#a78bfa", enabled: 0 },
];

/**
 * Seed the default deck set for one station. Existing rows are NEVER overwritten —
 * INSERT OR IGNORE against the (station_id, slot) PK — so an operator's drifted layout
 * survives every startup. Mints a uuid per row (the UNIQUE uuid index, and the sync
 * mutation log, both key on it) and copies the station's uuid into station_uuid, without
 * which the row is invisible to peer sync.
 */
function seedDeckConfigsForStation(stationId) {
  const stationUuid = (() => {
    try { return db.prepare("SELECT uuid FROM stations WHERE id = ?").get(stationId)?.uuid ?? null; }
    catch { return null; }
  })();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO deck_configs
       (station_id, slot, type, label, color, enabled, purpose, uuid, station_uuid, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, NULL)`
  );
  let added = 0;
  const seed = db.transaction((decks) => {
    for (const d of decks) {
      const r = insert.run(stationId, d.slot, d.type, d.label, d.color, d.enabled,
                           require("crypto").randomUUID(), stationUuid, now, now);
      added += r.changes;
    }
  });
  seed(DEFAULT_DECKS);
  return added;
}

/**
 * Startup guard: every station that has no deck rows gets the default set. Idempotent —
 * a station that already has rows (even a partial or heavily customised set) is left
 * exactly as it is.
 */
function seedDeckConfigs() {
  let stations = [];
  try { stations = db.prepare("SELECT id, name FROM stations ORDER BY id").all(); }
  catch { stations = []; }
  if (!stations.length) {
    console.log("[DeckGuard] no stations yet — deck seeding deferred to stations:create");
    return;
  }
  const report = [];
  for (const s of stations) {
    const have = db.prepare("SELECT COUNT(*) c FROM deck_configs WHERE station_id = ? AND deleted_at IS NULL").get(s.id).c;
    const added = have === 0 ? seedDeckConfigsForStation(s.id) : 0;
    const total = db.prepare("SELECT COUNT(*) c FROM deck_configs WHERE station_id = ? AND deleted_at IS NULL").get(s.id).c;
    report.push(`${s.id}:${total}${added ? ` (+${added} seeded)` : ""}`);
  }
  console.log(`[DeckGuard] ✓ deck_configs per station — ${report.join("  ")}`);
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
    title: SMOKE_ISOLATED ? "EtherCast — SMOKE (isolated test — NOT the live app)" : "EtherCast",
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

  // Renderer console → main log (warnings + errors). Closes the gap where a renderer exception was
  // invisible to the main process — the reason a white screen couldn't be diagnosed from logs. Cheap.
  let _rendererSawError = false;
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) { // 2 = warning, 3 = error
      if (level >= 3) _rendererSawError = true;
      logStartup(`[renderer:${level >= 3 ? 'error' : 'warn'}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    _rendererSawError = true;
    logStartup(`render-process-gone: reason=${details?.reason} exitCode=${details?.exitCode}`);
  });

  // SMOKE MODE (ETHER_SMOKE=1): boot the REAL window, assert React mounted (#root has children) and no
  // renderer console exception, print a verdict, exit. Guards the render/module-load layer (the white-
  // screen / packaged blank-screen class) in dev AND packaged. Never runs in normal use.
  if (process.env.ETHER_SMOKE === '1') {
    let _smokeDone = false;
    const finishSmoke = (ok, why) => {
      if (_smokeDone) return; _smokeDone = true;
      logStartup(`[SMOKE] ${ok ? 'PASS' : 'FAIL'} — ${why}`);
      console.log(`[SMOKE] ${ok ? 'PASS' : 'FAIL'} ${why}`);
      setTimeout(() => app.exit(ok ? 0 : 1), 300);
    };
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, 2500)); // let React mount after load
        const rootKids = await mainWindow.webContents.executeJavaScript(
          "((document.getElementById('root')||{}).childElementCount)||0", true).catch(() => 0);
        // DAEMON-START GATE (regression guard for 4.4.37–4.4.40): a staged daemon missing a runtime file
        // (e.g. daemon-log.js) crashes on startup → never connects → AUDIO_DAEMON silently falls back to
        // in-process (single-station, looked "fine"). The packaged smoke must prove the OUT-OF-PROCESS
        // daemon actually reached ready, and that daemon-log.js landed in the staged engine dir.
        await audioBackendReady;
        const daemonDesired = AUDIO_DAEMON_DESIRED;
        const daemonStarted = AUDIO_DAEMON === true;
        let daemonLogStaged = false;
        // Staged engine lives at %LOCALAPPDATA%\Ether\engine (stage-engine.js engineBaseDir), NOT userData
        // (which is Roaming) — check the real staged path or this reads false on a healthy build.
        // Staged engine lives at %LOCALAPPDATA%\Ether\engine (stage-engine engineBaseDir). _etherDir()
        // returns …\Ether\com.ether.radio (the DB dir), so its PARENT (…\Ether) + engine is the stage root.
        try { daemonLogStaged = require("fs").existsSync(path.join(path.dirname(_etherDir()), "engine", "audiod", "daemon-log.js")); } catch { /* ignore */ }
        const daemonOk = !daemonDesired || (daemonStarted && daemonLogStaged);
        // MANDATORY air-isolation: a smoke must run against an EMPTY DB (0 stations → no automationStart →
        // no encoder → no Icecast). If the DB has stations, REFUSE to pass regardless of everything else.
        let stationCount = -1;
        try { stationCount = getDb().prepare("SELECT COUNT(*) AS c FROM stations WHERE deleted_at IS NULL").get().c; } catch { /* db not ready */ }
        const airIsolated = stationCount === 0;
        // air_isolated (0 stations) is MANDATORY only for an ISOLATED smoke running alongside the live app.
        // A sole-instance real-profile smoke (SMOKE_ISOLATED=false, live app closed) legitimately has
        // stations — there it gates on daemon_started + daemon_log_staged; station_count is informational.
        finishSmoke(rootKids > 0 && !_rendererSawError && daemonOk && (!SMOKE_ISOLATED || airIsolated),
          `react_mounted=${rootKids > 0} root_children=${rootKids} renderer_error=${_rendererSawError} daemon_desired=${daemonDesired} daemon_started=${daemonStarted} daemon_log_staged=${daemonLogStaged} station_count=${stationCount} air_isolated=${airIsolated}`);
      } catch (e) { finishSmoke(false, `harness_error=${e.message}`); }
    });
    setTimeout(() => finishSmoke(false, 'timeout — no did-finish-load within 30s'), 30000);
  }

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
      // NATIVE TITLE BAR (2026-08-05). This was frameless, so the window had no minimize/maximize/close
      // of its own — the 4.4.142 traffic-light overlay was briefly its only control, and removing that
      // in 4.4.143 left it with NO way to close or minimise. Native chrome is the fix: every window the
      // app opens gets real OS controls, and no in-app dots are needed anywhere.
      title: tag, frame: true, transparent: false,
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
      { label: "Library", click: () => send("nav:library") },
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
      // 2026-08-10: added HERE, in the NATIVE menubar. Phase 4 first put Rotation Analytics into the
      // React <Menu> blocks in App.tsx — which are not what this app renders. The visible menubar is
      // this Electron template, so the item existed in the code and nowhere the operator could reach
      // it. Exactly the "doors before rooms" failure: it's in the code is not shipped.
      { label: "Rotation Analytics", click: () => send("nav:rotation") },
      { label: "Schedule Manager",   click: () => send("nav:schedulehub") },
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
  // Splash FIRST — before the database is touched. Startup work (repair, migration, seeding) can pause
  // for a moment, and a pause on a blank screen reads as a frozen app. The splash says what is
  // happening while it happens. It costs nothing and it is the difference between "working" and "hung".
  createSplash();
  logStartup('createSplash() done — startup work is now visible');

  // ── OPEN THE STATION, DO NOT INTERVIEW THE OPERATOR ─────────────────────────────────────────────
  // The operator is a DJ. They double-click Ether and their station comes up. They do not close
  // daemons, run scripts, read schemas, or answer dialogs about databases. So: try, self-repair, retry
  // — silently — and only speak if the app genuinely cannot continue.
  //
  // A customer's station was down behind a dialog whose only button was Quit, for a schema this build
  // can fix in milliseconds. That must never happen again.
  // docs/migration-safety-and-customer-recovery-2026-08-06.md §4
  const OPEN_ATTEMPTS = 5;
  let dbOpened = false, lastErr = null;
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS && !dbOpened; attempt++) {
    try {
      initDb();                       // repairSchema() runs inside, before any migration
      dbOpened = true;
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      console.error(`[DB] open attempt ${attempt}/${OPEN_ATTEMPTS} failed —`, msg);

      // Schema we recognise → repair on a bare connection and try again immediately. No dialog.
      try {
        const Database = require('better-sqlite3');
        const conn = new Database(getDbPath());
        const fixed = repairSchema(conn);
        try { conn.close(); } catch {}
        if (fixed) { console.log('[DB] self-repair done — retrying open'); continue; }
      } catch (re) { console.error('[DB] self-repair pass failed:', (re && re.message) || re); }

      // Transient: a lock, a drive still mounting, antivirus holding the file. Wait briefly and retry.
      if (attempt < OPEN_ATTEMPTS) {
        const waitMs = 400 * attempt;
        console.log(`[DB] retrying in ${waitMs}ms`);
        const until = Date.now() + waitMs;
        while (Date.now() < until) { /* short, bounded backoff before the window exists */ }
      }
    }
  }

  if (!dbOpened) {
    // LAST RESORT ONLY — everything above has failed. Plain language, no jargon, no decisions about
    // schemas. The technical detail is there for support, not for the operator to act on.
    let dbPath = "(could not resolve)";
    try { dbPath = getDbPath(); } catch {}
    const msg = String((lastErr && lastErr.message) || lastErr);
    console.error("[DB] FATAL after self-repair and retries —", (lastErr && lastErr.stack) || lastErr);
    let choice = 2;
    try {
      choice = dialog.showMessageBoxSync({
        type: "error",
        title: "Ether",
        message: "Ether could not start.",
        detail: [
          "Your music, schedule and airplay history are safe — nothing has been lost.",
          "",
          "Ether tried to repair itself and could not. Restarting the computer clears this most of the",
          "time. If it keeps happening, send this screen to support and they will sort it out.",
          "",
          "Details for support: " + msg,
          dbPath,
        ].join("\n"),
        buttons: ["Try again", "Quit"],
        noLink: true,
        cancelId: 1,
      });
    } catch (dlgErr) { console.error("[DB] error dialog failed:", dlgErr && dlgErr.message); }
    if (choice === 0) { try { app.relaunch(); } catch {} }
    app.isQuitting = true;
    app.quit();
    return;
  }
  try { _backfillAccountMarker(); } catch {}
  processInviteFile(); // VIP invite seeding — runs after DB is ready

  // Cloud backup must init AFTER initDb() so db is not undefined
  try {
    const { installCloudBackup, triggerUpload, getR2Config } = require("./cloud-backup.js");
    installCloudBackup(ipcMain, getDb, { dbPath: getDbPath() });   // getDb (function) so backups always use the live handle after a reopen
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
    installStationMetadata(ipcMain, getDb);   // getDb (function) → resolves the live handle after a reopen
    const { installNowPlayingArt } = require("./now-playing-art.js");
    installNowPlayingArt(ipcMain, getDb);   // getDb (function) → resolves the live handle after a reopen
  } catch (e) {
    console.warn("[STATION-METADATA] install failed:", e.message);
  }

  // GPIO engine (broadcast hardware I/O) — db-dependent, so it installs HERE (after initDb), not at
  // module load where `db` was still undefined (the "[GPIO] table init: …undefined…'exec'" error).
  // The onGpiEvent callback's mainWindow use is guarded; GPI events only arrive after the window exists.
  try {
    const { installGpioEngine } = require("./gpio-engine.js");
    installGpioEngine(ipcMain, getDb, {   // getDb (function) → resolves the live handle after a reopen
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
    installSiteReplication(ipcMain, getDb);   // getDb (function) → resolves the live handle after a reopen
  } catch (e) {
    console.warn("[REPL] installSiteReplication failed:", e.message);
  }

  // sync IPC handlers — all 30 typed handler sets via aggregator
  // (stations:* excluded from installAll — registered manually below with custom logic)
  console.log('[sync/handlers] ▶ installAll starting (phase-3.5)');
  try {
    const { installAll } = require('./sync/handlers/index');
    installAll(ipcMain, getDb);   // getDb (function) → every typed handler resolves the live handle after a reopen
    console.log('[sync/handlers] ✓ installAll complete');
  } catch (e) {
    console.error("[sync/handlers] ✗ install failed:", e.message);
    console.error(e.stack);
  }

  // ── v2 library bootstrap + tail (spec §4) — ALWAYS ON, independent of the opt-in mutation sync
  // (sync_enabled). Runs only when a real account session exists (account_jwt) AND a license resolves:
  // on a fresh install it fills songs_v2 from GET /library/snapshot; thereafter it tails
  // GET /library/changes. Guarded so failures never affect the app. Metadata read-path only —
  // nothing reads songs_v2 into the UI yet (that's the separate read-cutover).
  const runLibrarySync = async () => {
    try {
      const d = getDb();
      const jwt = d.prepare("SELECT value FROM install_config_kv WHERE key='account_jwt' AND deleted_at IS NULL").get()?.value;
      const licenseKey = accountLicenseKey();
      if (!jwt || !licenseKey) return;                       // no signed-in account yet → wait
      const { bootstrapLibrary, tailChanges, getStoredVersion } = require('./sync/library-client');
      const opts = { backendUrl: ETHER_BACKEND_URL, licenseKey, musicDir: getMusicDir() };
      if (getStoredVersion(d) == null) await bootstrapLibrary(d, opts);   // fresh install → snapshot
      else await tailChanges(d, opts);                                    // steady state → changes
    } catch (e) { console.error('[library-sync]', e.message); }
  };
  setTimeout(runLibrarySync, 4000);        // shortly after startup (or right after a sign-in this session)
  setInterval(runLibrarySync, 30000);      // tail on cadence; also picks up a sign-in that lands later

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
      const transport = new HttpTransport(getDb, { baseUrl });   // getDb (function) → resolves the live handle after a reopen
      // UUID-identity (Tier-2): scope/route station programming by stable station UUID instead of the
      // per-machine local integer, so edits sync both ways across machines whose local ids differ.
      // OFF by default (shadow-first); set sync_uuid_identity='true' in station_config_kv to enable.
      // NOT enabled for v4.4.24 — cross-machine uuid sync is proven in the harness but not yet
      // validated on the real two machines, so this build ships it disabled.
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
      const scheduler = new SyncScheduler(getDb, transport, {   // getDb (function) → rebuilds its engine if the connection reopens
        // Read active station on every pull so mid-session station switches are handled
        // correctly. main.js owns getActiveStationId(); SyncEngine stores only the getter.
        getStationId:   () => String(getActiveStationId()),
        // The active station's stable UUID — used for UUID-identity scoping when enabled.
        getStationUuid: () => db.prepare('SELECT uuid FROM stations WHERE id = ?').get(getActiveStationId())?.uuid ?? null,
        uuidIdentity,
        // Owner push excludes member stations (their edits go up under the member token, not the license).
        getPushExcludeStationIds: () => memberOperate ? memberStationLocalIds() : [],
        // On-air predicate (Tier-2 re-baseline safety): gates ONLY the heavy one-shot corrective re-pull,
        // never the normal incremental sync. _wasOnAir() reads the HA marker file (Icecast liveCount>0),
        // so the full-history re-pull burst defers to a quiet window and never fights the audio daemon.
        isOnAir: () => { try { return _wasOnAir(); } catch (_) { return false; } },
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
        const mt = new HttpTransport(getDb, { baseUrl, memberToken: token, cursorKey: 'sync_server_seq_member_' + uuid });
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
  try { logStartup(`sessionData: ${app.getPath('sessionData')}`); } catch (e) { logStartup(`sessionData: (unavailable) ${e.message}`); }

  // Show native splash first; main window stays hidden behind it
  // createSplash() moved earlier — see the boot block above. Startup work must be VISIBLE.
  splashStatus("Starting EtherCast…");
  // Let the renderer report its own real load steps (DB migrations, station, audio).
  ipcMain.handle("splash:status", (_e, msg) => { splashStatus(String(msg || "")); return true; });
  logStartup('createSplash() done');
  splashStatus("Loading interface…");
  createWindow();
  // Report what startup actually did — dismissable in-app, informational only. An engineer sees
  // "Repaired station database — 0.3s"; an operator who does not care closes it. The work is done
  // either way; this screen is never a decision.
  try {
    const send = () => { try { sendToAllWindows('boot:report', { steps: bootReport, at: Date.now() }); } catch {} };
    if (mainWindow && mainWindow.webContents) {
      if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', () => setTimeout(send, 800));
      else setTimeout(send, 800);
    }
  } catch (e) { console.warn('[BOOT] report send failed:', e.message); }
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
      // ONE-WRITER-WINS (2026-07-15 health double-count fix): this interval is CREATED at boot when
      // AUDIO_DAEMON is false (in-process fallback). After the in-process→daemon handover AUDIO_DAEMON
      // flips true and the daemon forward starts feeding _health.noteLevels — but this interval keeps
      // running and ALSO fed noteLevels for the active station, so its frames/s read ~2×. Bail the moment
      // the daemon is authoritative: the daemon forward (event handler above) is the sole levels writer.
      if (AUDIO_DAEMON) return;
      try {
        // In-process fallback (single active engine). Tag with the ACTIVE station's uuid so the renderer's
        // uuid filter renders it — otherwise uuid-scoped meters go dark when the daemon isn't connected.
        // scopeLevelsFrame computes master (post-EQ, else max-of-decks) and swaps the integer id for uuid.
        const sid = getActiveStationId();
        const raw = JSON.parse(audio.audioGetLevels(sid));
        try { if (_health) _health.noteLevels(sid, raw); } catch {}   // v4.4.50: feed the health monitor in in-process mode too (same addon → same frames_total/decks telemetry)
        const levels = scopeLevelsFrame({ ...raw, stationId: sid }, _stationUuidById);
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

// Main event-loop lag sense (2026-07-22): a 1s self-timer measures its own scheduling drift. When the
// main thread is blocked (a synchronous DB sweep, a big Generate), this timer fires late by the block
// duration — that late-by-ms IS the event-loop lag. Canonical and daemon-independent (unlike the ping
// RTT). Surfaced on the Health Monitor so a UI freeze (e.g. the 2026-07-21 ~17s stall) is an observed
// fact on the panel, not reconstructed from a log. `peak` holds the worst lag in a rolling ~60s window
// so a brief freeze stays visible past the single tick that caught it.
let _mainLoopLagMs = 0, _mainLoopLagPeakMs = 0, _mainLoopLagPeakAt = 0;
{
  const PERIOD = 1000;
  let _expected = Date.now() + PERIOD;
  const _t = setInterval(() => {
    const nowT = Date.now();
    const lag = Math.max(0, nowT - _expected);
    _expected = nowT + PERIOD;
    _mainLoopLagMs = lag;
    if (lag >= _mainLoopLagPeakMs || (nowT - _mainLoopLagPeakAt) > 60000) { _mainLoopLagPeakMs = lag; _mainLoopLagPeakAt = nowT; }
  }, PERIOD);
  if (_t.unref) _t.unref();
}

// Single source of truth for the /health payload — shared by the GET /health
// route (the HA watchdog's poll) and the ha:dashboard IPC (the renderer's System
// Health panel). MUST stay lock-free: reads only Node-native values + the atomic
// audio-liveness getter; never calls audio.audioGetState() (that would lock the
// per-station Mutex and could stall during a write).
function buildHealthSnapshot() {
  const now = Date.now();
  let lastCb = 0;
  try { lastCb = Number(audio.audioLastCallbackMs?.(getActiveStationId())) || 0; } catch {}
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
    eventLoopLagMs: _mainLoopLagMs,          // (2026-07-22) current main event-loop lag
    eventLoopLagPeakMs: _mainLoopLagPeakMs,  // worst in the last ~60s
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

// activity:tail — FOLLOW ether-audiod.log from a byte offset (the Live Activity terminal in the
// Health Monitor). Display-only: this reads an existing log the daemon already writes; it adds no
// instrumentation, no new event channel, and never touches audio, the daemon or the engine.
//
// The RENDERER holds the cursor and passes it back each call, so main stays stateless and several
// windows (the health panel + its popout) can each tail independently without fighting over one
// offset. Efficiency: we read only [offset, size) — never the whole file — capped per call.
//
// Rotation/truncation: daemon-log.js rotates at 5 MB to `.log.1` and starts a fresh `.log`
// (audiod/daemon-log.js:23,51). After that the file is SMALLER than our cursor, so `offset > size`
// is the rotation signal — restart from the head of the new file and tell the caller (`reset`).
ipcMain.handle("activity:tail", (_e, fromOffset) => {
  const MAX_CHUNK = 256 * 1024;   // bound one call's work — a burst can never stall the UI
  try {
    const p = path.join(app.getPath("userData"), "logs", "ether-audiod.log");
    const size = fs.statSync(p).size;
    const prev = Number(fromOffset);
    const seeding = !Number.isFinite(prev) || prev < 0;      // first call → seed from the tail
    const rotated = !seeding && prev > size;                 // file shrank → rotated/truncated
    let start = seeding ? Math.max(0, size - MAX_CHUNK) : rotated ? 0 : prev;
    if (size - start > MAX_CHUNK) start = size - MAX_CHUNK;  // clamp a large catch-up
    if (start >= size) return { ok: true, offset: size, lines: [], reset: rotated };

    const len = size - start;
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const text = buf.toString("utf8");

    // Only consume up to the last complete line, so a line still being written is never split
    // across two polls. The remainder is picked up next call.
    const nl = text.lastIndexOf("\n");
    if (nl < 0) return { ok: true, offset: start, lines: [], reset: rotated };
    const complete = text.slice(0, nl + 1);
    const lines = complete.split(/\r?\n/).filter(Boolean);
    // If we did not begin at a known line boundary (seeded or clamped mid-line), drop the partial head.
    if (start !== prev && start > 0) lines.shift();
    return { ok: true, offset: start + Buffer.byteLength(complete, "utf8"), lines, reset: rotated };
  } catch (e) {
    return { ok: false, offset: 0, lines: [], reset: false, error: e.code === "ENOENT" ? "no daemon log yet" : e.message };
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
// Shared audio-file resolver — the SAME local-first → file_key → R2 sequence audio:load used to do
// inline (Phase 1.3k). Extracted so playback (audio:load) and the cue editor (audio:resolve-local-path)
// resolve identically and can never drift. Returns { ok:true, filePath } (a locally-loadable path) or
// { ok:false, error }. Never throws.
async function resolveLocalAudioPath(filePath) {
  // (1) Fast path — file exists locally.
  if (filePath && fs.existsSync(filePath)) {
    return { ok: true, filePath };
  }
  // (2) Local miss — look up file_key for this exact file_path (matches the synced songs row).
  let fileKey = null;
  if (filePath) {
    try {
      const row = db.prepare("SELECT file_key FROM songs WHERE file_path = ? LIMIT 1").get(filePath);
      fileKey = row?.file_key || null;
    } catch (e) {
      console.warn("[resolveLocalAudioPath] file_key lookup failed:", e.message);
    }
  }
  if (!fileKey) {
    return { ok: false, error: 'no local file, no file_key' };
  }
  // (3) Have a file_key — R2 fallback. Tier gate enforced inside fetchR2Track; returns { ok, filePath }.
  console.log(`[resolveLocalAudioPath] local miss, attempting R2 fallback for file_key=${fileKey}`);
  const fetched = await fetchR2Track(fileKey);
  if (!fetched.ok) console.warn(`[resolveLocalAudioPath] R2 fallback failed: ${fetched.error}`);
  else console.log(`[resolveLocalAudioPath] R2 fallback succeeded → ${fetched.filePath}`);
  return fetched;
}

ipcMain.handle("audio:load", async (_, deck, filePath, title, artist, gainDb, stationId) => {
  // Item 10 Phase 2 Step 1: the resolved load goes to the daemon when enabled (it owns the
  // engine); otherwise the in-process addon. File resolution (existsSync + R2 fetch) — which
  // needs main's DB + R2 — stays here; only the final load is forwarded.
  const doLoad = (fp) => AUDIO_DAEMON
    ? audiodClient.cmd("load", { deck, filePath: fp, title, artist, gainDb: gainDb ?? 0, stationId })
    : audio.audioLoad(deck, fp, title, artist, gainDb ?? 0, stationId);
  // Resolve exactly as before (local-first → file_key → R2). On any failure, soft-fall to the
  // original filePath so the Rust worker reports the error exactly as pre-refactor (no regression).
  const resolved = await resolveLocalAudioPath(filePath);
  return doLoad(resolved.ok ? resolved.filePath : filePath);
});

// Resolve a song's stored file_path to a locally-loadable path (used by the cue editor so it reads
// the SAME file playback does). Returns { ok, filePath, error } — never throws.
ipcMain.handle("audio:resolve-local-path", async (_, filePath) => resolveLocalAudioPath(filePath));

// Item 10 Phase 2 Step 1: deck control + state + levels route to the daemon when AUDIO_DAEMON
// (it owns the engine), else the in-process addon. getState/getLevels return parsed objects
// from both paths.
ipcMain.handle("audio:play", (_, deck, stationId) => AUDIO_DAEMON ? audiodClient.cmd("play", { deck, stationId }) : audio.audioPlay(deck, stationId));
ipcMain.handle("audio:pause", (_, deck, stationId) => AUDIO_DAEMON ? audiodClient.cmd("pause", { deck, stationId }) : audio.audioPause(deck, stationId));
ipcMain.handle("audio:stop", (_, deck, stationId) => AUDIO_DAEMON ? audiodClient.cmd("stop", { deck, stationId }) : audio.audioStop(deck, stationId));
ipcMain.handle("audio:setVolume", (_, deck, volume, stationId) => AUDIO_DAEMON ? audiodClient.cmd("setVolume", { deck, volume, stationId }) : audio.audioSetVolume(deck, volume, stationId));
// Console channel cut (CART/jingle channel today). Routed exactly like setVolume so it reaches whichever
// engine actually owns the audio — the daemon when AUDIO_DAEMON is on, the in-process addon otherwise.
ipcMain.handle("audio:setMuted", (_, deck, muted, stationId) => AUDIO_DAEMON ? audiodClient.cmd("setMuted", { deck, muted, stationId }) : audio.audioSetMuted(deck, muted, stationId));
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

// Per-station LOCAL monitor (speaker) gain — never touches the Icecast broadcast. Lets the
// operator blend/mute what they HEAR across stations while every station keeps airing.
ipcMain.handle("audio:setMonitorVolume", (_, stationId, volume) => {
  if (AUDIO_DAEMON) return audiodClient.cmd("setMonitorVolume", { stationId, volume });
  try {
    if (typeof audio.audioSetMonitorVolume !== "function") return false;
    return audio.audioSetMonitorVolume(stationId, volume);
  } catch { return false; }
});

// MASTER OUT — the broadcast gain for a station. Rides the program bus pre-meter in Rust, so it
// changes what listeners hear and the master VU follows. Mirrors setMonitorVolume's plumbing exactly.
// docs/master-monitor-faders-dead-2026-08-06.md
ipcMain.handle("audio:setMasterVolume", (_, stationId, volume) => {
  if (AUDIO_DAEMON) return audiodClient.cmd("setMasterVolume", { stationId, volume });
  try {
    if (typeof audio.audioSetMasterVolume !== "function") return false;
    return audio.audioSetMasterVolume(stationId, volume);
  } catch (e) { console.error("[audio:setMasterVolume]", e.message); return false; }
});

// MASTER MONITOR — the operator's ONE room level.
//
// The CONTROL is single; the STATE is per-station, because DESIGN-TRUTH §2 forbids shared mutable
// audio state below the engine layer ("each station acts like its own separate sound card"). So the
// fan-out lives HERE, in main, which knows the station list — not in the audio engine as a global.
// A global static was tried on 2026-08-06 and correctly rejected by the station-isolation guard.
//
// Applied to every station's own bus, multiplied with that station's monitor strip level, device
// branch only — so it can never reach air and one station's level can never gate another's.
ipcMain.handle("audio:setMasterMonitorVolume", (_, volume) => {
  let ids = [];
  try { ids = db.prepare("SELECT id FROM stations WHERE deleted_at IS NULL").all().map(r => r.id); }
  catch (e) { console.error("[audio:setMasterMonitorVolume] station list:", e.message); }
  let applied = 0;
  for (const stationId of ids) {
    try {
      if (AUDIO_DAEMON) { audiodClient.cmd("setMasterMonitorVolume", { stationId, volume }); applied++; }
      else if (typeof audio.audioSetMasterMonitorVolume === "function") {
        if (audio.audioSetMasterMonitorVolume(stationId, volume)) applied++;
      }
    } catch (e) { console.error("[audio:setMasterMonitorVolume] station", stationId, e.message); }
  }
  return { ok: applied > 0, stations: applied };
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
  _seedAutomationIntentFromDisk();   // seed BEFORE the first command so a boot automationStart can't clobber the persisted set
  // Track automation intent for auto-resume: set on automationStart, cleared ONLY on an explicit
  // automationStop (a deliberate operator stop is never auto-resumed). Disconnect/respawn never
  // touches this map — the whole point is that it survives a daemon death. Persisted to disk so it also
  // survives an APP relaunch (the update case that caused the silent-while-playing incident).
  try {
    const sid = args && args.stationId;
    if (sid != null) {
      if (cmd === "automationStart") { _automationIntent.set(sid, args); _persistAutomationIntent(); }
      else if (cmd === "automationStop") { _automationIntent.delete(sid); _streamIntent.delete(sid); _persistAutomationIntent(); }
      else if (cmd === "startStream") _streamIntent.set(sid, args);
      else if (cmd === "stopStream") _streamIntent.delete(sid);
    }
  } catch {}
  try { return { ok: true, result: await audiodClient.cmd(cmd, args || {}) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

// Database
ipcMain.handle("db:query", (_, sql, params) => {
  try {
    const stmt = getDb().prepare(sql);   // getDb() self-heals a closed handle (renderer data-layer seam)
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

    const stmt = getDb().prepare(sql);   // getDb() self-heals a closed handle (renderer data-layer seam)
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

// Rotation log — the renderer's own record of what IT decided (rotate/preload/end-detection, and the
// one line that says whether it is daemon-driven or running its own advance). Renderer sends
// fire-and-forget; main appends.
//
// REPAIRED 2026-07-30. This wrote to `__dirname/../tmp-userdata/rotation.log` — a dev-tree relative path
// that does not exist in a packaged install, inside a silent try/catch. Every [ROT] line this app has
// ever produced on a customer machine was discarded, including `[ROT] daemon-driven: local advance
// DISABLED` vs `[ROT] in-process engine (daemon not active)` — the single line that answers which engine
// is driving a station. It now lands beside the other userData logs, the same convention audio-health
// uses (_healthLogDir, :476). WHAT IS LOGGED IS UNCHANGED — only where it goes.
const _rotationLogDir = path.join(app.getPath("userData"), "logs");
const _rotationLogPath = path.join(_rotationLogDir, "rotation.log");
try { fs.mkdirSync(_rotationLogDir, { recursive: true }); } catch {}
let _rotationLogWarned = false;   // warn ONCE — this is a diagnostic channel; it must never spam or throw
ipcMain.on("log:rotation", (_, msg) => {
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
    fs.appendFileSync(_rotationLogPath, `[${ts}] ${msg}\n`);
  } catch (e) {
    if (!_rotationLogWarned) {
      _rotationLogWarned = true;
      console.warn(`[rotation-log] cannot write ${_rotationLogPath} — rotation logging disabled for this session: ${e.message}`);
    }
  }
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

ipcMain.handle("db:restore", async (_, backupName) => {
  try {
    const backupPath = path.join(app.getPath("userData"), "backups", backupName);
    if (!fs.existsSync(backupPath)) return { error: "Backup not found" };
    // close → copy → reopen(retry) → verify → rollback-on-failure; throws a real error (never bricks).
    await swapDatabaseFile(backupPath);
    return { data: "Restored successfully", error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

// Factory reset — wipe the local database (the live file AND the legacy migration source,
// else getDbPath copies it back) so the next launch is a clean first run: re-onboarding +
// first-user PIN setup. Closes the DB, deletes both copies + their WAL sidecars, then
// relaunches. Destructive — the renderer gates this behind a double-email confirmation.
ipcMain.handle("system:factoryReset", async () => {
  try {
    await _wipeLocalIdentityAndData();   // shared total clear (session + DB + legacy + sessionData + markers)
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
ipcMain.handle("account:switch-to", async () => {
  try {
    // Switch = sign-out (spares operator profiles) then a fresh sign-in as the other account. Nothing
    // of the old ACCOUNT (identity/stations/library/session) survives; in-app profiles persist.
    await _wipeLocalIdentityAndData({ spareProfiles: true });
    try { markHaExpectedRestart(); } catch {}
    app.relaunch();
    app.exit(0);
    return { ok: true, switched: true };
  } catch (e) { console.error("[account:switch-to]", e.message); return { ok: false, error: e.message }; }
});

// CLEAN-ROOM SIGN-IN guard (the invariant's sign-in clause): a FRESH sign-in/sign-up must start from
// absolute zero. If the local DB carries residual station/identity data (e.g. a DB contaminated before
// the total-sign-out invariant shipped, or any leftover from a prior account), the renderer calls this
// BEFORE establishing the new identity — total wipe (reuse the same clear) + relaunch, so the next
// sign-in provisions ONLY the account signed into. On a clean DB the renderer never calls it.
ipcMain.handle("account:cleanRoomReset", async () => {
  try {
    await _wipeLocalIdentityAndData({ spareProfiles: true });  // clean-room for a fresh sign-in; keep operator profiles
    try { markHaExpectedRestart(); } catch {}
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) { console.error("[account:cleanRoomReset]", e.message); return { ok: false, error: e.message }; }
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
ipcMain.handle("restore_db", async (_, { backupName } = {}) => {
  try {
    if (!backupName) throw new Error("backupName is required");
    const backupPath = path.join(app.getPath("userData"), "backups", backupName);
    if (!fs.existsSync(backupPath)) throw new Error("Backup not found: " + backupName);
    await swapDatabaseFile(backupPath);   // close → copy → reopen(retry) → verify → rollback-on-failure
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
    const licenseKey = accountLicenseKey();
    if (!licenseKey) return { ok: false, error: "No license key — sign in first." };

    // Resolve the latest cloud backup FIRST — we need its timestamp to warn the operator how old it
    // is BEFORE they agree to overwrite. A stale backup silently replacing NEWER local work was the
    // data-loss vector; surfacing the backup date (so they can cancel) is the guard.
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

    // Pull the backup timestamp out of the signed R2 key (…/backups/<ts>.db.gz, ts like
    // 2026-06-23T12-10-45Z) and rehydrate it to ISO so the UI can show the backup's age before
    // overwriting. No extra round-trip, no backend change.
    let backupTimestamp = null;
    try {
      const m = String(db_signed_url).match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z?\.db\.gz/i);
      if (m) backupTimestamp = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
    } catch {}

    let songCount = 0;
    try { songCount = db.prepare("SELECT COUNT(*) AS n FROM songs").get()?.n ?? 0; } catch {}
    if (songCount > 0 && !force) {
      return { ok: false, error: `This install already has ${songCount} songs. Installing from cloud replaces the local database.`, hasData: true, songs: songCount, backupTimestamp };
    }

    // Preserve this machine's identity (also its sync seat / machine_id) across the DB swap.
    let myClientId = null;
    try { myClientId = db.prepare("SELECT client_id FROM client_identity LIMIT 1").get()?.client_id || null; } catch {}

    // Preserve the SIGNED-IN ACCOUNT SESSION across the swap. The cloud backup is a snapshot of the
    // SOURCE machine and carries ITS (often empty) session markers; without re-stamping these, the
    // restore wipes the account_jwt the operator just signed in with → the app gates back to the
    // sign-in screen → infinite sign-in loop. Capture now, re-stamp after the swap. [loop fix]
    let myAccountJwt = null, myAccountEmail = null;
    try { myAccountJwt   = db.prepare("SELECT value FROM install_config_kv WHERE key='account_jwt' AND deleted_at IS NULL").get()?.value || null; } catch {}
    try { myAccountEmail = db.prepare("SELECT value FROM install_config_kv WHERE key='account_email' AND deleted_at IS NULL").get()?.value || null; } catch {}

    const dbRes = await fetchFn(db_signed_url);
    if (!dbRes.ok) return { ok: false, error: `Backup download failed (${dbRes.status}).` };
    const raw = require("zlib").gunzipSync(Buffer.from(await dbRes.arrayBuffer()));

    // Stage the downloaded database on LOCAL disk, next to the live DB — NOT under userData.
    // userData is %APPDATA%\Ether (ROAMING), and managed profiles (OV) redirect Roaming to a network
    // H:\ share. That is the same hazard getDbPath() exists to avoid: writing a multi-hundred-MB file
    // across a redirected share is where it arrives truncated, and a truncated file fails at open with
    // "malformed database schema". _etherDir() is %LOCALAPPDATA%\Ether\com.ether.radio on Windows —
    // machine-local, never redirected, and the same volume the file is about to be copied to anyway.
    const tmp = path.join(_etherDir(), "cloud-restore.db");
    fs.writeFileSync(tmp, raw);
    // Verify the staged file is the full download before it goes anywhere near the live database.
    // A short write (full disk, interrupted network share) is otherwise silent until SQLite chokes.
    try {
      const staged = fs.statSync(tmp).size;
      if (staged !== raw.length) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw new Error(`the downloaded backup didn't save completely (${staged.toLocaleString()} of ${raw.length.toLocaleString()} bytes) — check free disk space and try again`);
      }
    } catch (e) {
      if (/didn't save completely/.test(e.message)) return { ok: false, error: e.message };
      throw e;
    }
    // What this backup CLAIMS to contain — the yardstick the restored database must meet. Without it
    // there is nothing to compare against, and "0 songs" reads as success.
    let expectedSongs = 0;
    {
      const pre = await verifyDatabaseFileAsync(tmp);
      if (!pre.ok) {
        restoreLog(`install-from-cloud: downloaded backup will not open — ${pre.reason}`);
        return { ok: false, error: `The downloaded backup is not readable (${pre.reason}). Your current station is untouched.` };
      }
      expectedSongs = pre.songs || 0;
      restoreLog(`install-from-cloud: downloaded backup verified — ${pre.objects} schema objects, ${expectedSongs} songs`);
    }

    // Swap in via the shared helper: validates the source first (refuses a damaged file outright),
    // backs up the current DB, close → copy → drop sidecars → reopen (with retry) → verify →
    // ROLL BACK on failure, and throws a real error (never bricks).
    // Progress flows to the installing screen so a long verify never looks like a hang.
    await swapDatabaseFile(tmp, (msg) => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("restore:progress", { message: msg }); } catch {}
    });
    try { fs.rmSync(tmp, { force: true }); } catch {}

    // Re-stamp this machine's identity so it isn't the source machine's clone, and keep the
    // license key the operator signed in with. (getDb() = the live post-swap handle.)
    if (myClientId) { try { getDb().prepare("UPDATE client_identity SET client_id = ?").run(myClientId); } catch (e) { console.warn("[install-from-cloud] client_id restore:", e.message); } }
    try { getDb().prepare("UPDATE station_config_kv SET value = ? WHERE key = 'license_key'").run(licenseKey); } catch {}

    // Re-stamp the signed-in account session so the restore does NOT sign the operator out → no loop.
    {
      const nowIso = new Date().toISOString();
      const upsertInstall = (key, val) => {
        if (val == null) return;
        try {
          const ex = db.prepare("SELECT 1 FROM install_config_kv WHERE key=?").get(key);
          if (ex) db.prepare("UPDATE install_config_kv SET value=?, updated_at=?, deleted_at=NULL WHERE key=?").run(val, nowIso, key);
          else db.prepare("INSERT INTO install_config_kv (key,value,uuid,created_at,updated_at) VALUES (?,?,?,?,?)").run(key, val, require("crypto").randomUUID(), nowIso, nowIso);
        } catch (e) { console.warn("[install-from-cloud] preserve " + key + ":", e.message); }
      };
      upsertInstall("account_jwt", myAccountJwt);
      upsertInstall("account_email", myAccountEmail);
    }

    // Carry the signed-in session across the restore's re-gate / relaunch. THE LOGIN GATE READS THE
    // .ether-keep-session MARKER (account:resume-session), not account_jwt — without it the app
    // bounces to the sign-in screen right after a cloud install → the persistent sign-in loop. Every
    // other continuation path (reload @2829, relaunch @3186, update @3369) writes it; this one didn't.
    try { markKeepSession(); } catch (e) { console.warn("[install-from-cloud] markKeepSession:", e.message); }

    let newCount = 0, stationName = "", countErr = null;
    try { newCount = db.prepare("SELECT COUNT(*) AS n FROM songs").get()?.n ?? 0; } catch (e) { countErr = e.message; }
    try { stationName = db.prepare("SELECT value FROM station_config_kv WHERE key='station_name' LIMIT 1").get()?.value || ""; } catch {}

    // "Database installed — 0 songs" must never be reported as success. Every COUNT reads 0 when the
    // database did not really open, and the audio downloader then gets an empty work list and waits
    // forever at 0 Mbps. The backup we just verified told us how many songs it holds — if the restored
    // database does not agree, the restore FAILED, and it says so here instead of downstream.
    const expected = expectedSongs;         // from validateDatabaseFile() on the downloaded backup
    if (countErr) {
      restoreLog(`install-from-cloud: restored DB cannot be counted (${countErr}) — reporting failure`);
      return { ok: false, error: `The station was restored but its database cannot be read (${countErr}). Nothing was kept.` };
    }
    if (expected > 0 && newCount === 0) {
      restoreLog(`install-from-cloud: backup holds ${expected} songs but the restored DB reports 0 — reporting failure`);
      return { ok: false, error: `The restore did not complete: this backup contains ${expected.toLocaleString()} songs but the installed database reports none. Nothing usable was installed — please try again.` };
    }
    if (expected > 0 && newCount < expected) {
      restoreLog(`install-from-cloud: restored ${newCount} of ${expected} songs — incomplete`);
    }
    restoreLog(`install-from-cloud: restored DB — ${newCount} songs (backup said ${expected}), station="${stationName}", backup ${backupTimestamp || "?"}`);
    return { ok: true, songs: newCount, expectedSongs: expected, stationName, backupTimestamp };
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
    const licenseKey = accountLicenseKey();
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
  "studiopro":   { width: 1280, height: 800 },  // Show+ DAW — its own window, not a dashboard takeover
};

// ── Pop-out window bounds persistence (every pop-out remembers size + position) ──
const POPOUT_BOUNDS_FILE = path.join(app.getPath("userData"), "popout-bounds.json");
function loadPopoutBounds() {
  try { return JSON.parse(require("fs").readFileSync(POPOUT_BOUNDS_FILE, "utf8")); } catch { return {}; }
}
function savePopoutBounds(panel, bounds) {
  try {
    const all = loadPopoutBounds();
    all[panel] = bounds;
    require("fs").writeFileSync(POPOUT_BOUNDS_FILE, JSON.stringify(all));
  } catch { /* best-effort; a lost bounds write is cosmetic */ }
}
// Guard a restored rectangle against a monitor that went away — must overlap some display.
function boundsOnScreen(b) {
  try {
    const { screen } = require("electron");
    return screen.getAllDisplays().some(d => {
      const w = d.workArea;
      return b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y;
    });
  } catch { return false; }
}

// Factored so studio:push-track can open/reuse the exact same window.
function openPopoutWindow(panel) {
  const tag = `popout:${panel}`;
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === tag);
  if (existing) { existing.show(); existing.focus(); return existing; }

  const { screen } = require("electron");
  const size  = POPOUT_SIZES[panel] || { width: 640, height: 520 };
  const saved = loadPopoutBounds()[panel];
  let x, y, width = size.width, height = size.height;
  if (saved && boundsOnScreen(saved)) {
    x = saved.x; y = saved.y; width = saved.width; height = saved.height;   // remembered size + position
  } else {
    const primary   = screen.getPrimaryDisplay();
    const secondary = screen.getAllDisplays().find(d => d.id !== primary.id);
    x = secondary ? secondary.workArea.x + 60 : undefined;                  // secondary monitor if present
    y = secondary ? secondary.workArea.y + 60 : undefined;
  }

  const win = new BrowserWindow({
    width, height, minWidth: 320, minHeight: 200, x, y,
    title: tag,
    // NATIVE TITLE BAR — see the note above the other pop-out constructor. Frameless left this window
    // with no minimize/maximize/close once the traffic-light overlay was removed.
    frame: true,
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

  // Remember size + position (Windows fires these once at the end of a drag/resize).
  const persist = () => { try { savePopoutBounds(panel, win.getBounds()); } catch { /* ignore */ } };
  win.on("moved", persist);
  win.on("resized", persist);

  // Close-guard: the Show+ DAW holds an un-persisted editing session — warn before discarding
  // uncommitted regions. Guards Alt+F4 / OS close, not just the shell X. The renderer reports
  // dirty via 'studio:set-dirty' and confirms via 'studio:force-close'.
  if (panel === "studiopro") {
    win.on("close", (e) => {
      if (win._forceClose || !win._studioDirty) return;
      e.preventDefault();
      try { win.webContents.send("studio:confirm-close"); } catch { /* window gone */ }
    });
  }

  if (isDev) win.loadURL(VITE_DEV_URL + `#popout/${panel}`);
  else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: `popout/${panel}` });
  return win;
}

// NOTE: the win:minimize / win:close / win:toggleFullscreen / win:isFullscreen handlers added in
// 4.4.142 were REMOVED 2026-08-05 — the app uses NATIVE title bars only, so the renderer has no
// window controls to serve. Do not reintroduce them without asking.

ipcMain.handle("window:popout", async (_, panel) => { openPopoutWindow(panel); });

// ── Show+ DAW dirty-state + force-close (the close-guard back-channel) ──
ipcMain.on("studio:set-dirty", (evt, dirty) => {
  const w = BrowserWindow.fromWebContents(evt.sender);
  if (w) w._studioDirty = !!dirty;
});
ipcMain.on("studio:force-close", (evt) => {
  const w = BrowserWindow.fromWebContents(evt.sender);
  if (w) { w._forceClose = true; w.close(); }
});

// ── Send-to-Studio hand-off (single production surface) ──
// The main window's Library forwards a track here; we open/focus the Show+ DAW pop-out and
// deliver the track to THAT window — cold (on did-finish-load) or warm (immediately). No inline DAW.
ipcMain.handle("studio:push-track", (_evt, track) => {
  const win = openPopoutWindow("studiopro");
  if (!win) return;
  const deliver = () => { try { win.webContents.send("studio:load-track", track); } catch { /* window gone */ } };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", deliver);
  else deliver();
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
    // NATIVE TITLE BAR — same reason as the pop-out constructors above.
    frame: true,
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
  // When bundled in asar, the binary lives in app.asar.unpacked. NOTE: guard on "app.asar.unpacked"
  // exactly — NOT just "unpacked" — because the portable build folder is literally named
  // "win-unpacked", which false-matched the old guard and skipped this fixup (in-process ffmpeg ENOENT).
  if (ffmpegBin && ffmpegBin.includes("app.asar") && !ffmpegBin.includes("app.asar.unpacked")) {
    ffmpegBin = ffmpegBin.replace("app.asar", "app.asar.unpacked");
  }
  console.log("[FFMPEG] Binary:", ffmpegBin);
} catch (e) {
  console.warn("[FFMPEG] ffmpeg-static not available:", e.message);
}

// ── AI Voice Studio (TTS generation + segment library) ──────────────────────
try {
  const { installAIVoice } = require("./ai-voice.js");
  installAIVoice(ipcMain, getDb, { userDataPath: app.getPath("userData") });   // getDb (function) → resolves the live handle after a reopen
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

// Two-tier Iris grant — docs/iris-ether-contract.md is the law:
//  • SCHEDULING tier (Generate-layer) — AUTONOMOUS: Iris may run/adjust generation on her own
//    initiative (watchman role, calendar commands).
//  • TRANSPORT tier — COMMAND-EXECUTED ONLY: play/stop/skip/next/auto-on/auto-off execute immediately on
//    the operator's EXPLICIT instruction (voice/chat, relayed as source:'operator'), and NEVER from
//    Iris's own reasoning, watchman logic, or any autonomous loop. Her judgment moves the fader at the
//    planning layer; only the operator's moves it at the air layer. The deterministic floor stays fully
//    Iris-independent regardless.
const IRIS_TRANSPORT_VERBS = new Set(['play', 'stop', 'skip', 'next', 'auto-on', 'auto-off']);

async function routeIrisCommand(cmd) {
  const { action, payload = {} } = cmd;
  // Command-executed gate: a transport verb is honored ONLY with explicit operator provenance
  // (cmd.source === 'operator' = a verbatim relay of the operator's voice/chat instruction). Iris-
  // initiated transport (autonomous / watchman) is refused at the air layer, by contract.
  if (IRIS_TRANSPORT_VERBS.has(action) && cmd.source !== 'operator') {
    console.warn(`[iris] TRANSPORT '${action}' REFUSED — not operator-commanded (Iris may not initiate transport)`);
    return { ok: false, error: 'transport_requires_operator_command', action };
  }
  switch (action) {
    case 'play':
      audio.audioPlay('A');
      sendToAllWindows('iris:command-received', { action, label: 'Playing deck A' });
      return { ok: true };

    case 'stop':
      audio.audioStop('A');
      sendToAllWindows('iris:command-received', { action, label: 'Stopped deck A' });
      return { ok: true };

    case 'skip':
    case 'next': {
      // Pause current deck — the auto-advance engine in the renderer handles loading next
      audio.audioPause('A');
      sendToAllWindows('iris:command-received', { action, label: 'Skip requested' });
      sendToAllWindows('iris:next-track', {});
      return { ok: true };
    }

    case 'generate': {
      // SCHEDULING tier — autonomous-allowed (no operator gate). payload: { month:'YYYY-MM' } OR
      // { fromTs, toTs }, plus { stationId } or { stationName }. Runs the real Generate path
      // (LRP ladder + diagnostics) and returns count/relaxedPicks/runwayDays/throughDate/reasons.
      let stationId = payload.stationId;
      if (!stationId && payload.stationName) {
        const row = db.prepare("SELECT id FROM stations WHERE name = ? OR slug = ? LIMIT 1").get(payload.stationName, payload.stationName);
        stationId = row && row.id;
      }
      if (!stationId) stationId = getActiveStationId();
      let fromTs = payload.fromTs, toTs = payload.toTs;
      if (payload.month && /^\d{4}-\d{2}$/.test(payload.month)) {
        const [y, m] = payload.month.split('-').map(Number);
        fromTs = Math.floor(new Date(y, m - 1, 1, 0, 0, 0, 0).getTime() / 1000);
        toTs   = Math.floor(new Date(y, m,     1, 0, 0, 0, 0).getTime() / 1000);
      }
      if (!fromTs || !toTs) return { ok: false, error: "generate needs {month:'YYYY-MM'} or {fromTs,toTs}" };
      try {
        const r = await _generateRange(stationId, fromTs, toTs);
        sendToAllWindows('iris:command-received', { action: 'generate', label: `Generated ${r.count} for ${r.station}` });
        return r;
      } catch (e) { return { ok: false, error: e.message }; }
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

// ── Single now-playing poster (4.4.54) ───────────────────────────────────────
// The now-playing heartbeat used to POST /api/now-playing from EVERY renderer window
// (main + each popout), each off its own engine mirror → last-write-wins ping-pong on
// the single backend row, surfacing a ghost track that never aired. Now the renderer
// only FORWARDS its per-station payloads to main over 'nowplaying:state', and main is
// the ONE poster per machine: it accepts payloads from the ELECTED primary window only
// (mainWindow — popouts are ignored), accumulates the latest per station_uuid, and runs
// a single dedup + 20s keepalive POST loop. Payloads are renderer-built because the
// native/daemon engine has neither position nor queue (see iris live-wire above).
const nowPlayingByUuid = new Map();       // station_uuid -> latest forwarded payload
const _npLastSig = new Map();             // station_uuid -> last POSTed content signature
const _npLastPostAt = new Map();          // station_uuid -> last POST time (ms)
ipcMain.on("nowplaying:state", (evt, payload) => {
  // Accept ONLY from the elected primary window; popouts run the same effect but must not post.
  // Re-resolved live each event so a recreated mainWindow (new webContents) still wins.
  try {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents) return;
    if (evt.sender.id !== mainWindow.webContents.id) return;
  } catch { return; }
  if (!payload || !payload.station_uuid) return;
  nowPlayingByUuid.set(payload.station_uuid, payload);
});

// The single POST loop — the ONLY [NOWPLAY] source on the machine. Same dedup signature
// (position excluded — backend derives it from started_at) + 20s keepalive that used to
// live in the renderer: skip only when content is unchanged AND we POSTed within 20s;
// past that, re-POST to keep engine_heartbeat_at fresh (backend stamps it NOW() each report).
setInterval(() => {
  if (!nowPlayingByUuid.size) return;
  let licenseKey = null;
  try { licenseKey = accountLicenseKey(); } catch { /* db not ready */ }
  const nowMs = Date.now();
  const KEEPALIVE_MS = 20_000;
  for (const payload of nowPlayingByUuid.values()) {
    const uuid = payload.station_uuid;
    const sig = [
      payload.playing, payload.title, payload.artist, payload.deck, payload.station_uuid, payload.art_url,
      payload.engine_state, payload.source_machine_id, payload.last_error,
      (payload.queue || []).map(q => q && q.title).join(""),
    ].join("");
    if (sig === _npLastSig.get(uuid) && (nowMs - (_npLastPostAt.get(uuid) || 0)) < KEEPALIVE_MS) continue;
    _npLastSig.set(uuid, sig);
    _npLastPostAt.set(uuid, nowMs);
    console.log(`[NOWPLAY] POST ${payload.station_name || uuid} playing=${payload.playing} state=${payload.engine_state} title=${JSON.stringify(payload.title)} q=${(payload.queue || []).length}`);
    fetch(`${ETHER_BACKEND_URL}/api/now-playing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(licenseKey ? { "x-license-key": licenseKey } : {}),
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
}, 3000);

// ── Iris chat channel (operator ↔ Iris over the same :3400 link) ──────────────
// Prompt DOWN: the renderer's Iris panel sends operator text → pushed to Iris on the SSE as a `chat`
// event. Reply + speaking UP: Iris POSTs /iris/reply and /iris/speaking (in the HTTP server below) →
// relayed to the renderer. Keeps Iris a pure client (no inbound port on her side).
ipcMain.on("iris:chat-send", (_evt, msg) => {
  sseBroadcast("chat", { id: (msg && msg.id) || null, text: (msg && msg.text) || "" });
});
// Presence: flip the badge online/offline from the :3400 heartbeat freshness (ping / any POST refreshes
// irisLastSeen). Emitted to the renderer only on change so the badge has a definite state at all times.
setInterval(() => {
  const connected = (Date.now() - irisLastSeen) < 10000;
  if (connected !== irisConnected) { irisConnected = connected; sendToAllWindows("iris:connected", connected); }
}, 3000);

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
    req.on('end', async () => {
      // routeIrisCommand is async since 2026-08-03 (generate yields per hour) — this MUST await or the
      // response body becomes "{}" (a stringified Promise).
      try { const cmd = JSON.parse(body); irisConnected = true; irisLastSeen = Date.now(); res.end(JSON.stringify(await routeIrisCommand(cmd))); }
      catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); }
    }); return;
  }

  // ── Iris chat round-trip (Iris → Ether) ──
  // Reply → operator chat panel:  /api/captions/iris  (Iris already POSTs here) or /iris/reply  { text }
  // Speaking → badge glow on/off:  /api/iris/status  or /iris/speaking  { speaking: bool }
  if (req.method === 'POST' && (url === '/iris/reply' || url === '/api/captions/iris' || url === '/iris/speaking' || url === '/api/iris/status')) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      irisConnected = true; irisLastSeen = Date.now();
      try {
        const data = JSON.parse(body || '{}');
        const isSpeaking = (url === '/iris/speaking' || url === '/api/iris/status');
        if (isSpeaking) sendToAllWindows('iris:speaking', { speaking: !!data.speaking });
        else sendToAllWindows('iris:reply', { id: data.id ?? null, text: data.text || '' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); }
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
if (SMOKE_ISOLATED) console.log('[SMOKE] :3400 REST API NOT bound (isolated smoke — never contends with the live app).');
if (!SMOKE_ISOLATED) irisHttpServer.listen(3400, '0.0.0.0', () => {
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
const R2_CACHE_DIR    = path.join(app.getPath('userData'), 'r2-cache'); // hard fallback only
const MUSIC_DIR_FILE  = path.join(app.getPath('userData'), 'music-dir.txt');
// The designated library folder. Default = <user's Music>\ether music library (per-user, so it's
// the same relative location on every machine without hardcoding a username) — this is where cloud
// downloads materialize AND where the uploader consolidates, so the folder is the single source of
// truth. An operator-chosen folder (music-dir.txt) overrides it; R2_CACHE_DIR is the last resort.
function defaultLibraryDir() {
  try { const m = app.getPath('music'); if (m) return path.join(m, 'ether music library'); } catch {}
  return R2_CACHE_DIR;
}
function getMusicDir() {
  let dir = defaultLibraryDir();
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

// Per-station music folders + Test-sync / Re-sync / Relocate (DESIGN-TRUTH §2 — stations independent).
try {
  const { songsUpdateById } = require('./sync/handlers/songs');
  const { stationConfigKvUpsertByKey } = require('./sync/handlers/station_config_kv');
  require('./library-folders').register({
    ipcMain, dialog, getDb, getActiveStationId,
    getMainWindow: () => mainWindow,
    songsUpdateById, stationConfigKvUpsertByKey,
  });
} catch (e) { console.error('[library-folders] register failed:', e && e.message); }

// Resolve the license key for the signed-in ACCOUNT's cloud operations (DB backup/restore + audio
// up/download + device management). station_config_kv.license_key is keyed by (station_id, key), so a
// bare lookup grabs an ARBITRARY station's license — on a multi-license install that addresses the
// WRONG R2 prefix (backup lands under one license, restore reads another → they never meet). Prefer the
// ACTIVE station's owner license (the account context the operator is in); fall back to any non-deleted
// license_key (a clean single-account install has exactly one). UNIVERSAL — no IDs or paths baked in;
// it just reads whatever account/station this install actually has.
function accountLicenseKey() {
  try {
    const a = db.prepare("SELECT owner_license_key AS k FROM stations WHERE is_active = 1 AND deleted_at IS NULL AND owner_license_key IS NOT NULL AND owner_license_key != '' LIMIT 1").get();
    if (a?.k) return String(a.k).trim();
  } catch {}
  try {
    const b = db.prepare("SELECT value FROM station_config_kv WHERE key='license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL LIMIT 1").get();
    if (b?.value) return String(b.value).trim();
  } catch {}
  return null;
}

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
    licenseKey = accountLicenseKey();
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

// The picker lives in ./generate-core (Phase 1, 2026-08-11) - a pure move, connection-
// parameterised. _placeJingles and _commitDayRows stayed here, beside the write.
const { buildScheduleCtx, generateDayRows, resetGenSlice } = require('./generate-core');

// Ladder fallback for Generate (Tier 2/3): when no FULLY-compliant song exists for a slot, pick the
// LEAST-RECENTLY-PLAYED candidate (aired longest ago first) — never a random one. Tier 2 prefers songs
// not yet used this hour; Tier 3 allows reuse. Returns null ONLY when the category has no candidate at
// all (empty category / daypart) — which the runway + auto-extend + emergency layers cover. This is the
// "ladder into Generate": the generated log degrades gracefully instead of leaving a random/soft pick.

// JINGLES/SWEEPERS v2 (D1=A′ — SELECTION lives in the ONE scheduler; scheduler-rework #4 / ether-v2 §26).
// v2 supersedes v1 cadence with per-MUSIC-CATEGORY ASSIGNMENT: each music category names EITHER a specific
// overlay item OR a rotating pool, with its own lead-in/underlap + active hours. This runs AFTER the
// music/spot rows are laid down. v2 is LEADING imaging — the overlay introduces the song being placed, so
// the assignment is keyed on the INCOMING song's category and the placement's scheduled_at is that song's
// seam (unchanged placement-row shape). A placement carries content_class ('JIN'|'SWP') + channel='CART' +
// lead_in/underlap + jingle_category_id (the pool, or null for a specific item) + song_id. The daemon only
// READS these — no in-daemon selection. Fail-safe: pre-v32 DB / no assignment + no fallback → no placement
// (a clean dead segue is a deliberate programming choice, NEVER an error). Never throws into Generate.
function _placeJingles(db, stationId, rows) {
  if (!rows || !rows.length) return;
  // Station-level generic fallback pool for unassigned categories (optional). None set → clean dead segue.
  let fallbackCatId = null;
  try {
    const fb = db.prepare("SELECT value FROM station_config_kv WHERE key='overlay_fallback_category_id' AND station_id = ? AND deleted_at IS NULL").get(stationId);
    if (fb && fb.value) fallbackCatId = parseInt(fb.value, 10) || null;
  } catch {}
  // Prepared reads (defensive — a pre-v32 DB lacks the overlay columns → skip, byte-identical prior behavior).
  let stmtAssign, stmtItem, stmtPoolType, stmtPool;
  try {
    stmtAssign = db.prepare("SELECT overlay_kind, overlay_song_id, overlay_category_id, overlay_lead_in_sec, overlay_underlap_sec, overlay_active_hours FROM categories WHERE id = ?");
    stmtItem = db.prepare("SELECT s.id, s.title, a.name AS artist_name, s.file_path, s.duration_ms, s.content_class FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.id = ? AND s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive') AND s.content_class IN ('JIN','SWP')");
    stmtPoolType = db.prepare("SELECT type FROM jingle_categories WHERE id = ? AND deleted_at IS NULL");
    stmtPool = db.prepare(`SELECT s.id, s.title, a.name AS artist_name, s.file_path, s.duration_ms, s.content_class
       FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
      WHERE s.jingle_category_id = ? AND s.content_class = ? AND s.file_path IS NOT NULL
        AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
      ORDER BY COALESCE((SELECT MAX(pl.played_at) FROM play_log pl
               WHERE pl.file_path = s.file_path AND pl.station_id = ? AND pl.deleted_at IS NULL), 0) ASC, s.id ASC`);
  } catch { return; }
  const music = rows.filter(r => (r.content_class || 'MUSIC') === 'MUSIC' && r.song_id)
                    .slice().sort((a, b) => a.scheduled_at - b.scheduled_at);
  if (!music.length) return;
  const usedByPool = new Map();            // poolId → Set of overlay-song ids used this run (LRP anti-repeat)
  const DEFAULTS = { JIN: { lead: 5, under: 2 }, SWP: { lead: 2, under: 1 } };
  // THE GENERATE FREEZE (2026-08-06, 4.4.153). A CPU profile of the LIVE frozen main process put
  // 99.2% of 30s inside one native better-sqlite3 `.all()` under resolvePool. This query re-ran for
  // EVERY music row, and its correlated MAX(played_at) subquery scanned all ~36,900 play_log rows per
  // candidate — measured on Jeff's DB at 898ms per call, x452 music rows = 406 SECONDS per day of
  // one uninterruptible native call. No JS-level yield can break into that: execution never returns
  // to the event loop, which is why per-hour AND 60ms slicing both failed to stop the freeze.
  //
  // Resolved ONCE per run and cached. Correct because play_log is not written during a generate, so
  // the least-recently-played ordering cannot change mid-run; rotation within the run was already
  // handled by usedByPool, not by re-querying. Measured after: 0.29ms for the whole run.
  // Paired with idx_play_log_file_station (runMigrations), which takes the query itself 1015ms → 0.16ms.
  const poolCands = new Map();             // poolId → candidate rows, resolved once
  const itemCache = new Map();             // songId → specific overlay row, resolved once
  const resolvePool = (poolId) => {
    let cands = poolCands.get(poolId);
    if (cands === undefined) {
      let type = 'JIN'; try { const t = stmtPoolType.get(poolId); if (t && t.type) type = t.type; } catch {}
      try { cands = stmtPool.all(poolId, type, stationId); } catch { cands = []; }
      poolCands.set(poolId, cands);
    }
    if (!cands.length) return null;
    let used = usedByPool.get(poolId); if (!used) { used = new Set(); usedByPool.set(poolId, used); }
    let pick = cands.find(x => !used.has(x.id));
    if (!pick) { used.clear(); pick = cands[0]; }   // rotated through the pool → start over
    used.add(pick.id);
    return pick;
  };
  const jinRows = [];
  try {
    for (const incoming of music) {
      const catId = incoming.category_id;
      if (catId == null) continue;
      let a = null; try { a = stmtAssign.get(catId); } catch {}
      let kind = a && a.overlay_kind ? a.overlay_kind : null;
      let poolId = a ? a.overlay_category_id : null;
      const itemId = a ? a.overlay_song_id : null;
      let leadOverride = a ? a.overlay_lead_in_sec : null;
      let underOverride = a ? a.overlay_underlap_sec : null;
      let activeHours = (a && a.overlay_active_hours != null) ? a.overlay_active_hours : 16777215;
      // Unassigned → station fallback pool (no hours gate), else a clean dead segue (deliberate, not an error).
      if (!kind) {
        if (fallbackCatId) { kind = 'pool'; poolId = fallbackCatId; leadOverride = null; underOverride = null; activeHours = 16777215; }
        else continue;
      }
      // Active-hours gate — the seam's LOCAL hour must be enabled (keeps imaging out of hours it shouldn't be in).
      const seamHour = new Date(incoming.scheduled_at * 1000).getHours();
      if (((activeHours >> seamHour) & 1) !== 1) continue;
      // Resolve the overlay item: a specific song, or LRP rotation within the assigned pool.
      let pick = null;
      if (kind === 'item' && itemId != null) {
        if (itemCache.has(itemId)) pick = itemCache.get(itemId);
        else { try { pick = stmtItem.get(itemId); } catch { pick = null; } itemCache.set(itemId, pick); }
      }
      else if (kind === 'pool' && poolId != null) { pick = resolvePool(poolId); }
      if (!pick || !pick.file_path) continue;
      const cls = pick.content_class === 'SWP' ? 'SWP' : 'JIN';
      const def = DEFAULTS[cls];
      jinRows.push({
        scheduled_at: incoming.scheduled_at, song_id: pick.id,
        title: pick.title, artist: pick.artist_name || '',
        file_key: pick.file_path ? path.basename(pick.file_path) : '',
        duration_s: pick.duration_ms ? Math.round(pick.duration_ms / 1000) : 0,
        category_id: null, clock_id: incoming.clock_id ?? null,
        content_class: cls, channel: 'CART',
        lead_in_sec: leadOverride != null ? leadOverride : def.lead,
        underlap_sec: underOverride != null ? underOverride : def.under,
        jingle_category_id: kind === 'pool' ? poolId : null,
      });
    }
  } catch (e) { console.error('[schedule] overlay placement error (music unaffected):', e.message); return; }
  if (jinRows.length) { rows.push(...jinRows); console.log(`[schedule] placed ${jinRows.length} overlay(s) (jingles/sweepers) across ${music.length} music elements`); }
}

// Generate one day's 24 hours into ctx.generatedRows (same picking logic as schedule:generate).
// `onlyHour` (0-23) runs exactly ONE hour of the day and returns — the slice the chunked driver
// below uses to keep main's event loop alive. Omit it for the original all-24-hours behaviour.
// Equivalence: every per-hour accumulator (usedSongIds/usedArtistIds/usedTitles) is declared inside
// the loop, and every cross-hour accumulator (generatedRows, *LastTs, diag, relaxed) lives on ctx —
// so slicing changes scheduling not at all.

// ── PHASE 4 — Rotation Analytics IPC (2026-08-10). READ-ONLY: every handler is a SELECT. ─────────
ipcMain.handle('rotation:analytics', (_, stationId, fromTs, toTs) => {
  try {
    const ra = require('./rotation-analytics');
    const sid = stationId || getActiveStationId();
    const to = toTs || Math.floor(Date.now() / 1000);
    const from = fromTs || (to - ra.DAY);
    return { ok: true, data: ra.snapshot(db, sid, from, to) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('rotation:explain', (_, stationId, rowId) => {
  try {
    const ra = require('./rotation-analytics');
    return { ok: true, data: ra.explainRow(db, stationId || getActiveStationId(), rowId) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('rotation:csv', (_, stationId, kind, fromTs, toTs) => {
  try {
    const ra = require('./rotation-analytics');
    const sid = stationId || getActiveStationId();
    const to = toTs || Math.floor(Date.now() / 1000);
    const from = fromTs || (to - ra.DAY);
    return { ok: true, csv: ra.toCsv(kind, ra.snapshot(db, sid, from, to)) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── PHASE 3 — the parity + goal-shadow ledger (2026-08-10) ───────────────────────────────────────
// Parity is a FACT to be measured, never an assumption. Every Generate run appends what the engine
// and the legacy picker each decided, on the same candidates, plus (in goal mode) what goals WOULD
// have aired. Rides the same honest-ledger path the log-reader flip's shadow used, so a week of runs
// is queryable afterwards instead of scrolling past in a console.
// Exit criterion for deleting _legacyPickMusic: differ === 0 and errors === 0 across a full week.
function _noteSchedulerCore(stationId, ctx) {
  const d = ctx.coreDiff, g = ctx.goalShadow;
  if (!d) return;
  const compared = d.agree + d.differ;
  if (!compared && !d.skipped && !d.errors && !(g && g.hours)) return;
  const pct = compared ? Math.round((d.agree / compared) * 100) : null;
  console.log(`[sched-core s${stationId}] mode=${ctx.schedulerMode} compared=${compared}` +
              `${pct === null ? "" : ` agree=${pct}%`} differ=${d.differ} skipped=${d.skipped} errors=${d.errors}` +
              `${g && g.hours ? ` | goal-shadow: ${g.wouldDiffer}/${g.positions} positions would change` : ""}`);
  try {
    require('fs').appendFileSync(
      path.join(app.getPath('userData'), 'scheduler-core-shadow.jsonl'),
      JSON.stringify({ t: new Date().toISOString(), stationId, mode: ctx.schedulerMode, diff: d, goalShadow: g }) + "\n");
  } catch { /* a lost ledger line is cosmetic */ }
}

// Generate (or regenerate) a SINGLE day — clears just that day's rows, leaves the rest intact.
// Group a set of hour-numbers (0–23) into labeled ranges for the diagnostics panel:
// {2,3,4,5,6} → [{startHour:2, endHour:7, label:"2 AM–7 AM"}]. endHour is exclusive.
function _fmtHour(h) { const hh = ((h % 24) + 24) % 24; const am = hh < 12; const d = hh % 12 === 0 ? 12 : hh % 12; return `${d} ${am ? 'AM' : 'PM'}`; }
function _hourRanges(hourSet) {
  const hrs = [...hourSet].sort((a, b) => a - b);
  const out = [];
  for (const h of hrs) {
    const last = out[out.length - 1];
    if (last && h === last.endHour) last.endHour = h + 1;
    else out.push({ startHour: h, endHour: h + 1 });
  }
  return out.map(r => ({ startHour: r.startHour, endHour: r.endHour, label: `${_fmtHour(r.startHour)}–${_fmtHour(r.endHour)}` }));
}

// ── CHUNKED GENERATE (2026-08-03) ────────────────────────────────────────────────────────────────
// Generate ran synchronously on MAIN's thread. On 2026-08-03 a week generate froze the app: title bar
// "EtherCast (Not Responding)", main pid pegged >1 core for minutes, window ghosted. Main's event loop
// was dead, so every renderer IPC — deck state, meters, health — queued behind it.
// Design + mechanism reasoning: docs/generate-off-main-thread-design-2026-08-03.md
//
// MECHANISM: chunked-with-yields, NOT a utility process. The design doc first recommended a utility
// process; reading the code reversed that, and the reason is load-bearing: ctx carries LIVE
// better-sqlite3 prepared statements (stmtShows/stmtSlots/stmtCandidates/...) bound to main's handle.
// Those cannot cross a process boundary, so off-process would mean re-implementing the scheduler's
// whole data layer against a second SQLite binding and keeping two pickers in step — precisely the
// "never rebuild what exists" trap. The hour loop ALREADY existed inside _generateDayRows, so slicing
// it and yielding between hours is the surgical fix: identical picks, live event loop.
let _genCancel = false;
function _genEmit(payload) {
  try { BrowserWindow.getAllWindows().forEach(w => { try { w.webContents.send("schedule:generate-progress", payload); } catch {} }); } catch {}
}
// Persist the hour-slice distribution to the honest ledger.
//
// `hourMs` has been computed on every hour of every generate since chunking landed, and consumed by
// NOTHING — not the renderer (GenerateProgressBar never referenced it), not the ledger, not any log.
// So "does Generate block the UI?" could not be answered from history; Phase 0 had to answer it with
// a benchmark (docs/generate-phase0-measurement-2026-08-11.md), and the answer decided whether a
// whole worker thread got built. Next time it will be evidence.
//
// Failure here must never break Generate — this observes, it does not participate.
function _noteGenerateTiming(stationId, ctx, days) {
  try {
    const ms = (ctx && ctx.hourSlices) || [];
    if (!ms.length) return;
    const s = [...ms].sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    require('fs').appendFileSync(path.join(app.getPath('userData'), 'health-events.jsonl'),
      JSON.stringify({ t: new Date().toISOString(), kind: 'generate-timing', stationId, days,
                       hours: s.length, p50: at(0.50), p95: at(0.95), max: s[s.length - 1],
                       totalMs: s.reduce((a, b) => a + b, 0) }) + "\n");
  } catch { /* observation must never break Generate */ }
}
// Drive ONE day an hour at a time, yielding to the event loop between hours. The yield is the whole
// point: main pumps its message queue there, so the window keeps painting and decks keep animating.
async function _generateDayChunked(dayBase, ctx, effStart, meta) {
  resetGenSlice();
  for (let h = 0; h < 24; h++) {
    if (_genCancel) return { cancelled: true };
    const t0 = Date.now();
    await generateDayRows(dayBase, ctx, effStart, h);   // one hour, bounded (self-skips already-aired hours)
    const hourMs = Date.now() - t0;
    (ctx.hourSlices || (ctx.hourSlices = [])).push(hourMs);   // kept for the timing health event
    _genEmit({ phase: "hour", hour: h, hoursDone: h + 1, hoursTotal: 24, rows: ctx.generatedRows.length,
               hourMs, ...meta });
    await new Promise(r => setImmediate(r));       // ← the yield that keeps main alive
  }
  return { cancelled: false };
}
// Delete + insert as ONE transaction. Previously the DELETE committed in autocommit and the INSERT
// landed minutes later, so generated_schedule — the single playout source for flipped stations
// (docs/log-reader-single-source-playout-design-2026-07-20.md) — sat EMPTY for the whole pick. A
// reader now sees either the old day or the new one, never a hole.
// ── ONE post-run path for every Generate caller (2026-08-11) ────────────────────────────────────
//
// Three callers commit days: schedule:generateDay, schedule:generateDays, and _generateRange (Iris's
// SCHEDULING-tier command, which also backs auto-extend). Observation was added to them one at a
// time, and the count of instances where it landed in one and not the others reached FOUR:
//
//   1. parity ledger      — generateDay only, fixed 2026-08-10
//   2. noteGenerate       — generateDay only, fixed 2026-08-11
//   3. generate-timing    — avoided only because #2 was found while adding it
//   4. _generateRange     — had NONE of the three. Unattended auto-extend generated days for months
//                           with no parity record, no thinness report and no timing.
//
// Nothing ever errors when this goes wrong; the evidence is simply absent, on whichever path nobody
// was looking at. So the tail is one function now, and adding an observation here reaches every
// caller by construction rather than by remembering.
//
// Every call is individually guarded: observation must never break a generate that has already
// committed its rows.
function finishGenerateRun(stationId, ctx, days) {
  try { _noteSchedulerCore(stationId, ctx); } catch {}
  try { _libHealth && _libHealth.noteGenerate(stationId, { relaxed: ctx.relaxed, emptyCatIds: [...ctx.diag.emptyCats], breakDrift: ctx.breakDrift }); } catch {}
  try { _noteGenerateTiming(stationId, ctx, days); } catch {}
}
function _commitDayRows(stationId, effStart, dayEnd, rows) {
  const { generatedScheduleBulkCreate } = require('./sync/handlers/generated_schedule');
  db.transaction(() => {
    db.prepare("DELETE FROM generated_schedule WHERE station_id = ? AND scheduled_at >= ? AND scheduled_at < ?").run(stationId, effStart, dayEnd);
    generatedScheduleBulkCreate(db, stationId, rows);
  })();
}
ipcMain.handle('schedule:generateCancel', () => { _genCancel = true; return { ok: true }; });

// ONE call for a whole range — the week loop used to fire seven BLOCKING generateDay calls back to
// back, so progress moved only seven times and CANCEL could only break BETWEEN days. Now: hour-level
// progress across the range, cancel honoured at every hour boundary, and each day committed atomically
// as it completes (so a cancel leaves whole finished days, never a half day).
// One shared ctx across the range also carries separation + the LRP ladder ACROSS day boundaries —
// the seven-call loop rebuilt ctx per day and lost it.
ipcMain.handle('schedule:generateDays', async (_, dayTsList) => {
  try {
    _genCancel = false;
    const stationId = getActiveStationId();
    const days = Array.isArray(dayTsList) ? dayTsList : [];
    // start/end phases: the progress UI lives in its own always-mounted component, so it must not
    // depend on the calendar being open to know a run began or ended.
    _genEmit({ phase: "start", dayIdx: 0, dayTotal: days.length });
    const nowTs = Math.floor(Date.now() / 1000);
    const ctx = buildScheduleCtx(db, stationId);
    let total = 0, committed = 0, cancelled = false;
    for (let i = 0; i < days.length; i++) {
      if (_genCancel) { cancelled = true; break; }
      const dayBase = new Date(days[i] * 1000); dayBase.setHours(0, 0, 0, 0);
      const dayStart = Math.floor(dayBase.getTime() / 1000), dayEnd = dayStart + 86_400;
      const effStart = Math.max(dayStart, Math.ceil(nowTs / 3600) * 3600);
      if (effStart >= dayEnd) continue;                       // already aired — leave it
      const before = ctx.generatedRows.length;                // this day's slice starts here
      const run = await _generateDayChunked(dayBase, ctx, effStart, { day: dayBase.toDateString(), dayIdx: i, dayTotal: days.length });
      if (run.cancelled) { cancelled = true; break; }         // in-flight day discarded, never written
      const dayRows = ctx.generatedRows.slice(before);
      _placeJingles(db, stationId, dayRows);
      _commitDayRows(stationId, effStart, dayEnd, dayRows);   // atomic, per day
      committed++; total += dayRows.length;
      _genEmit({ phase: "day-committed", day: dayBase.toDateString(), dayIdx: i, dayTotal: days.length, rows: dayRows.length });
    }
    const d = ctx.diag, gaps = {
      noShow: _hourRanges(d.noShowHours), noClock: _hourRanges(d.noClock),
      emptyCats: [...d.emptyCats], emptyClocks: [...d.emptyClocks],
    };
    const station = (db.prepare("SELECT name FROM stations WHERE id = ?").get(stationId) || {}).name || ("station #" + stationId);
    // PHASE 3 DEFECT FIX (2026-08-10): the parity ledger was wired only into schedule:generateDay, so
    // the WEEK generate — which is the Calendar's main button, and therefore the common path — ran the
    // differential and threw the result away. The evidence mechanism for the whole phase was missing
    // from the path most likely to be used. Found because scheduler-core-shadow.jsonl did not exist
    // after a real regeneration.
    finishGenerateRun(stationId, ctx, committed);
    console.log(`[schedule:generateDays] ${committed}/${days.length} day(s), ${total} tracks${cancelled ? " — CANCELLED" : ""}`);
    _genEmit({ phase: "end", cancelled, daysCommitted: committed, count: total, dayTotal: days.length });
    return { ok: true, cancelled, daysCommitted: committed, count: total, station, gaps, relaxed: ctx.relaxed.length };
  } catch (e) {
    console.error('[schedule:generateDays]', e.message);
    _genEmit({ phase: "end", cancelled: false, error: e.message, dayTotal: (dayTsList || []).length });
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('schedule:generateDay', async (_, dayTs) => {
  try {
    _genCancel = false;
    const activeStationId = getActiveStationId();
    const dayBase = new Date(dayTs * 1000); dayBase.setHours(0, 0, 0, 0);
    const dayStart = Math.floor(dayBase.getTime() / 1000), dayEnd = dayStart + 86_400;
    const nowTs = Math.floor(Date.now() / 1000);
    const effStart = Math.max(dayStart, Math.ceil(nowTs / 3600) * 3600); // next top-of-hour; never the past
    if (effStart >= dayEnd) return { ok: true, count: 0, skipped: true }; // whole day already aired — leave it
    _genEmit({ phase: "start", dayIdx: 0, dayTotal: 1, day: dayBase.toDateString() });
    // Build ctx BEFORE any delete — it reads play_log/separation_rules/songs, never generated_schedule,
    // so moving the delete after the pick cannot change what gets picked.
    const ctx = buildScheduleCtx(db, activeStationId);
    const run = await _generateDayChunked(dayBase, ctx, effStart, { day: dayBase.toDateString(), dayIdx: 0, dayTotal: 1 });
    if (run.cancelled) { _genEmit({ phase: "end", cancelled: true, daysCommitted: 0, count: 0, dayTotal: 1 }); return { ok: true, cancelled: true, count: 0 }; }
    _placeJingles(db, activeStationId, ctx.generatedRows);
    _commitDayRows(activeStationId, effStart, dayEnd, ctx.generatedRows);
    // Item 2 — LOUD thinness: route this run's within-category relaxation + empty categories to the
    // Health Monitor (health events + a per-station summary), not just the calendar diagnostics panel.
    finishGenerateRun(activeStationId, ctx, 1);
    // Turn the "why nothing filled" diagnostics into operator-readable reasons (names, not ids) so the
    // calendar can tell the operator exactly what's missing instead of flickering silently.
    const d = ctx.diag, reasons = [];
    if (d.emptyCats.size) {
      const names = [...d.emptyCats].map(id => { const c = db.prepare("SELECT code, name FROM categories WHERE id = ?").get(id) || {}; return c.code ? (c.code + (c.name ? " — " + c.name : "")) : ("category #" + id); });
      reasons.push("No eligible songs to fill music from: " + names.join(", ") + " — the category is empty, or every song in it is filtered out by rotation status, dayparts, or separation rules.");
    }
    if (d.emptyClocks.size) {
      const names = [...d.emptyClocks].map(id => (db.prepare("SELECT name FROM clocks WHERE id = ?").get(id) || {}).name || ("clock #" + id));
      reasons.push("Clock has no elements: " + names.join(", ") + " — add segments to it on the Clocks page.");
    }
    if (d.noClock.size) reasons.push("A scheduled show has no clock assigned (" + d.noClock.size + " hour(s)) — pick a clock for the show on the Shows page.");
    if (d.noShowHours.size >= 24) reasons.push("No active show is scheduled for this day — create or enable a show that covers these hours on the Shows page.");
    else if (d.noShowHours.size) reasons.push(d.noShowHours.size + " hour(s) have no show scheduled — extend or add a show to cover them.");
    const station = (db.prepare("SELECT name FROM stations WHERE id = ?").get(activeStationId) || {}).name || ("station #" + activeStationId);
    // Structured, per-day diagnostics for the panel: named gaps (date + hour ranges) by TYPE, plus the
    // relaxed-pick list (song · category — a rule bent to avoid a gap). `reasons` kept for compatibility.
    const catName = (id) => { const c = db.prepare("SELECT code, name FROM categories WHERE id = ?").get(id) || {}; return c.code ? (c.name ? c.code + " — " + c.name : c.code) : ("category #" + id); };
    const date = dayBase.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const gaps = {
      noShow:      _hourRanges(d.noShowHours),
      noClock:     _hourRanges(d.noClock),
      emptyCats:   [...d.emptyCats].map(catName),
      emptyClocks: [...d.emptyClocks].map(id => (db.prepare("SELECT name FROM clocks WHERE id = ?").get(id) || {}).name || ("clock #" + id)),
    };
    const relaxed = ctx.relaxed.map(r => ({ hour: r.hour, hourLabel: _fmtHour(r.hour), title: r.title, artist: r.artist, category: catName(r.category_id) }));
    console.log(`[schedule:generateDay] ${ctx.generatedRows.length} tracks for ${dayBase.toDateString()}${reasons.length ? " · issues: " + reasons.length : ""}${relaxed.length ? " · relaxed: " + relaxed.length : ""}`);
    _genEmit({ phase: "end", cancelled: false, daysCommitted: 1, count: ctx.generatedRows.length, dayTotal: 1 });
    return { ok: true, count: ctx.generatedRows.length, station, date, dateTs: Math.floor(dayBase.getTime() / 1000), gaps, relaxed, reasons };
  } catch (e) {
    console.error('[schedule:generateDay]', e.message);
    _genEmit({ phase: "end", cancelled: false, error: e.message, dayTotal: 1 });
    return { ok: false, error: e.message };
  }
});

// Callable Generate over a date range — used by Iris's SCHEDULING-tier 'generate' command (autonomous-
// allowed). Generates each day in [fromTs, toTs), never regenerating already-aired hours; the shared ctx
// carries separation + the LRP ladder across days. Returns operator-readable diagnostics: count,
// relaxedPicks (Tier 2/3 fallback fills), throughDate, runwayDays (schedule tail − now), station, reasons.
async function _generateRange(stationId, fromTs, toTs) {
  const nowTs = Math.floor(Date.now() / 1000);
  const ctx = buildScheduleCtx(db, stationId);
  const start = new Date(Math.max(fromTs, nowTs) * 1000); start.setHours(0, 0, 0, 0);
  const endMs = toTs * 1000;
  let dayIdx = 0;
  for (let d = new Date(start); d.getTime() < endMs; d.setDate(d.getDate() + 1)) {
    const dayBase = new Date(d); dayBase.setHours(0, 0, 0, 0);
    const dayStart = Math.floor(dayBase.getTime() / 1000), dayEnd = dayStart + 86_400;
    const effStart = Math.max(dayStart, Math.ceil(nowTs / 3600) * 3600);
    if (effStart >= dayEnd) continue;
    // Chunked + yielding, exactly like the operator path: the unattended auto-extend must never be
    // able to freeze the window either. Each day commits atomically as it finishes, so the range no
    // longer leaves days deleted-and-unwritten while it works.
    const before = ctx.generatedRows.length;
    const run = await _generateDayChunked(dayBase, ctx, effStart, { day: dayBase.toDateString(), dayIdx: dayIdx++, dayTotal: 0 });
    if (run.cancelled) break;
    const dayRows = ctx.generatedRows.slice(before);
    _placeJingles(db, stationId, dayRows);
    _commitDayRows(stationId, effStart, dayEnd, dayRows);
  }
  // Instance 4: this path had NO observation at all — see finishGenerateRun. `dayIdx` is the number
  // of days it walked.
  finishGenerateRun(stationId, ctx, dayIdx);
  const dg = ctx.diag, reasons = [];
  if (dg.emptyCats.size) reasons.push("Empty/over-filtered categories: " + [...dg.emptyCats].map(id => (db.prepare("SELECT code FROM categories WHERE id = ?").get(id) || {}).code || ("#" + id)).join(", "));
  if (dg.emptyClocks.size) reasons.push(dg.emptyClocks.size + " clock(s) have no elements");
  if (dg.noClock.size) reasons.push(dg.noClock.size + " show-hour(s) have no clock assigned");
  if (dg.noShowHours.size) reasons.push(dg.noShowHours.size + " hour(s) have no show scheduled");
  const station = (db.prepare("SELECT name FROM stations WHERE id = ?").get(stationId) || {}).name || ("station #" + stationId);
  const tail = db.prepare("SELECT MAX(scheduled_at) m FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL").get(stationId) || {};
  const runwayDays = tail.m ? Math.max(0, Math.round((tail.m - nowTs) / 86_400)) : 0;
  const throughDate = tail.m ? new Date(tail.m * 1000).toDateString() : null;
  return { ok: true, count: ctx.generatedRows.length, relaxedPicks: ctx.relaxed.length, runwayDays, throughDate, station, reasons };
}

// ── Layer #2: runway + auto-extend ───────────────────────────────────────────────────────────
// Runway = how far ahead the generated log reaches for a station. Auto-extend keeps every station's
// runway above a threshold by running Generate ahead on its own initiative — so the log never runs out
// and the emergency floor stays theoretically unreachable. Runway + extend results are published on the
// :3400 SSE as telemetry the Phase-3 watchman consumes. Deterministic-floor-independent: this only makes
// the log deeper; it never touches playout.
const AUTO_EXTEND_THRESHOLD_H = Number(process.env.ETHER_RUNWAY_THRESHOLD_H || 48);   // extend when runway < this
const AUTO_EXTEND_TARGET_DAYS = Number(process.env.ETHER_RUNWAY_TARGET_DAYS || 14);   // top runway up to this depth
const AUTO_EXTEND_EVERY_MS    = 30 * 60 * 1000;                                       // re-check every 30 min

function _stationRunwaySec(stationId) {
  try {
    const nowTs = Math.floor(Date.now() / 1000);
    const r = db.prepare("SELECT MAX(scheduled_at) m FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL").get(stationId) || {};
    return r.m ? Math.max(0, r.m - nowTs) : 0;
  } catch { return 0; }
}

// Stations whose degraded (too-sparse) schedule we've already force-regenerated this session — so a
// clock that genuinely can't fill densely doesn't get hammered every tick.
const _sparseHealed = new Set();

// A real generated log is dense (tracks are ~3–4 min → ~12–18 rows/hour). A degraded log — e.g. a
// stale 1-row-per-hour artifact — is <2/hour but can still fill weeks of runway, so the runway check
// never flags it. Look at the NEXT 6 HOURS: fewer than 12 rows there (avg <2/hr) means the schedule
// isn't a real playout log. Returns true when the station's near-term schedule needs rebuilding.
function _scheduleIsSparse(stationId, nowTs) {
  try {
    const n = db.prepare(
      "SELECT COUNT(*) c FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL AND scheduled_at >= ? AND scheduled_at < ?"
    ).get(stationId, nowTs, nowTs + 6 * 3600) || { c: 0 };
    return n.c < 12;
  } catch { return false; }
}

async function _autoExtendTick() {
  if (!db) return;
  let stations = [];
  try { stations = db.prepare("SELECT id, name FROM stations WHERE deleted_at IS NULL").all(); } catch { return; }
  const nowTs = Math.floor(Date.now() / 1000);
  for (const st of stations) {
    // Only stations that actually schedule (an active show with a clock) — others have nothing to build.
    let hasShow = false;
    try { hasShow = !!db.prepare("SELECT 1 FROM shows WHERE station_id = ? AND is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL LIMIT 1").get(st.id); } catch {}
    if (!hasShow) continue;
    const runwaySec = _stationRunwaySec(st.id);
    try { sseBroadcast("runway", { stationId: st.id, station: st.name, runwaySec, runwayHours: Math.round(runwaySec / 360) / 10 }); } catch {}
    // Self-heal a degraded (too-sparse) schedule the runway check can't see: rebuild it once through
    // the real generator (LRP ladder + separation). This is the scheduler correcting a schedule that
    // "slid wrong" — not a playout patch.
    if (!_sparseHealed.has(st.id) && _scheduleIsSparse(st.id, nowTs)) {
      _sparseHealed.add(st.id);
      try {
        const r = await _generateRange(st.id, nowTs, nowTs + AUTO_EXTEND_TARGET_DAYS * 86_400);
        console.log(`[auto-extend] ${st.name}: sparse schedule detected (<2 rows/hr) → regenerated ${r.count} tracks (${r.relaxedPicks} relaxed)`);
        try { sseBroadcast("autoextend", { stationId: st.id, station: st.name, count: r.count, runwayDays: r.runwayDays, relaxedPicks: r.relaxedPicks, reasons: r.reasons, sparseHeal: true }); } catch {}
      } catch (e) { console.error(`[auto-extend] ${st.name} sparse-heal failed:`, e.message); }
      continue;
    }
    if (runwaySec >= AUTO_EXTEND_THRESHOLD_H * 3600) continue;
    try {
      const r = await _generateRange(st.id, nowTs, nowTs + AUTO_EXTEND_TARGET_DAYS * 86_400);
      console.log(`[auto-extend] ${st.name}: runway ${Math.round(runwaySec / 3600)}h < ${AUTO_EXTEND_THRESHOLD_H}h → +${r.count} tracks (runway now ${r.runwayDays}d, ${r.relaxedPicks} relaxed)`);
      try { sseBroadcast("autoextend", { stationId: st.id, station: st.name, count: r.count, runwayDays: r.runwayDays, relaxedPicks: r.relaxedPicks, reasons: r.reasons }); } catch {}
    } catch (e) { console.error(`[auto-extend] ${st.name} failed:`, e.message); }
  }
}

let _autoExtendTimer = null;
function startAutoExtend() {
  if (_autoExtendTimer) return;
  setTimeout(() => { try { _autoExtendTick(); } catch (e) { console.error('[auto-extend] first tick:', e.message); } }, 60_000);
  _autoExtendTimer = setInterval(() => { try { _autoExtendTick(); } catch (e) { console.error('[auto-extend] tick:', e.message); } }, AUTO_EXTEND_EVERY_MS);
  console.log(`[auto-extend] armed — keep runway ≥ ${AUTO_EXTEND_THRESHOLD_H}h, top up to ${AUTO_EXTEND_TARGET_DAYS}d, every ${AUTO_EXTEND_EVERY_MS / 60000}min`);
}
// Runway readout for the UI (visualizer gauge, #5) + Iris.
ipcMain.handle('schedule:runway', (_, stationId) => {
  const id = stationId || getActiveStationId();
  const sec = _stationRunwaySec(id);
  return { ok: true, stationId: id, runwaySec: sec, runwayHours: Math.round(sec / 360) / 10, runwayDays: Math.round(sec / 86_400) };
});

// Category health — how much room each category has before artist separation starts eliminating every
// candidate. The binding constraint on the ladder is DISTINCT ARTISTS (a 60-min artist separation locks
// out an artist's whole catalog after one spin), so distinct-artist count is the headroom metric; song
// count is raw depth. Status thresholds follow the pool math in the report (target 8–10+ distinct
// artists per hourly-called category). Powers the Scheduler Health panel's category gauge.
ipcMain.handle('schedule:categoryHealth', (_, stationId) => {
  try {
    const id = stationId || getActiveStationId();
    const sep = db.prepare("SELECT value FROM separation_rules WHERE rule_type='artist_separation_min' AND is_active=1 AND station_id=? LIMIT 1").get(id);
    const artistSepMin = sep ? sep.value : 60;
    // In-rotation categories: those an active show's clock actually calls (falls back to any category
    // that has active songs, so a station without clocks still gets a readout).
    let inRotation = [];
    try {
      inRotation = db.prepare(`SELECT DISTINCT cs.category_id FROM clock_slots cs
        WHERE cs.slot_type='music' AND cs.category_id IS NOT NULL AND cs.deleted_at IS NULL AND cs.station_id=?
          AND cs.clock_id IN (SELECT clock_id FROM shows WHERE is_active=1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id=?)`).all(id, id).map(r => r.category_id);
    } catch {}
    const inRot = new Set(inRotation);
    const cats = db.prepare(`
      SELECT c.id, c.code, c.name,
        (SELECT COUNT(*) FROM songs s WHERE s.category_id=c.id AND s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status!='inactive')) AS songs,
        (SELECT COUNT(DISTINCT s.artist_id) FROM songs s WHERE s.category_id=c.id AND s.artist_id IS NOT NULL AND s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status!='inactive')) AS artists
      FROM categories c WHERE (c.station_id=? OR c.station_id IS NULL) ORDER BY c.code`).all(id);
    const rows = cats.filter(c => c.songs > 0).map(c => {
      const status = c.artists >= 10 ? 'healthy' : c.artists >= 6 ? 'tight' : 'at_risk';
      return { id: c.id, code: c.code, name: c.name, songs: c.songs, artists: c.artists, status, inRotation: inRot.has(c.id) };
    });
    return { ok: true, stationId: id, artistSepMin, rows };
  } catch (e) { console.error('[schedule:categoryHealth]', e.message); return { ok: false, error: e.message, rows: [] }; }
});
startAutoExtend();

ipcMain.handle('schedule:get', (_, fromTs, toTs, stationId) => {
  try {
    // generated_schedule is per-station; without a station filter this returned EVERY station's rows
    // in the time range (Magical Forest's calendar showing another station's songs). Scope by station —
    // default to the ACTIVE station so a caller that passes no id still gets one station, not all.
    const sid = stationId ?? getActiveStationId();
    // Durable cross-station guard: a row's station_id says which station OWNS the slot, but the
    // song it points at can later be re-categorised into ANOTHER station's library (the per-station
    // category migration did exactly this — Christmas tracks generated under HalloVeen's category
    // were moved into OV's "Christmas" category, leaving stale rows that made HalloVeen's calendar
    // show Christmas). Never DISPLAY a row whose song now positively belongs to a different station.
    // Conservative by design — only drops rows we can prove are foreign: song-less rows (spots/talk),
    // songs with no category, or categories with no station_id all pass through unchanged.
    const rows = db.prepare(
      `SELECT g.id, g.scheduled_at, g.song_id, g.title, g.artist, g.file_key, g.duration_s, g.category_id
       FROM generated_schedule g
       WHERE g.station_id = ? AND g.scheduled_at >= ? AND g.scheduled_at < ? AND g.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM songs s JOIN categories c ON c.id = s.category_id
           WHERE s.id = g.song_id AND c.station_id IS NOT NULL AND c.station_id <> g.station_id
         )
       ORDER BY g.scheduled_at`
    ).all(sid, fromTs ?? 0, toTs ?? 9999999999);
    return { data: rows, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

// ── Log-Reader Flip Phase 2: the playhead view (rows ≥ playhead) ───────────────
// The SAME source the calendar reads (generated_schedule), shaped as "what's playing + what's next"
// so UpNext + the ▶ marker can render from the log instead of the in-memory queue. Music rows only
// (JIN/SWP are seam overlays, never deck tracks); same cross-station foreign-category guard as
// schedule:get. Ordered by scheduled_at (the calendar's order). READ-ONLY — changes no playout.
ipcMain.handle('schedule:playhead-view', (_e, stationId, limit) => {
  try {
    const sid = stationId ?? getActiveStationId();
    const n = Math.max(1, Math.min(200, limit ?? 12));
    const foreign = `AND NOT EXISTS (SELECT 1 FROM songs s JOIN categories c ON c.id=s.category_id
       WHERE s.id=g.song_id AND c.station_id IS NOT NULL AND c.station_id <> g.station_id)`;
    const cols = `g.id, g.scheduled_at, g.title, g.artist, g.duration_s, g.state, g.played_at, g.seq, g.content_class`;
    const playing = db.prepare(
      `SELECT ${cols} FROM generated_schedule g
        WHERE g.station_id=? AND g.state='playing' AND g.deleted_at IS NULL ${foreign}
        ORDER BY g.scheduled_at LIMIT 1`).get(sid) || null;
    const upNext = db.prepare(
      `SELECT ${cols} FROM generated_schedule g
        WHERE g.station_id=? AND g.state='pending' AND g.deleted_at IS NULL
          AND (g.content_class IS NULL OR g.content_class NOT IN ('JIN','SWP')) ${foreign}
        ORDER BY g.scheduled_at LIMIT ?`).all(sid, n);
    return { ok: true, playing, upNext };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Log-Reader Flip Phase 2: divergence ledger. The renderer shadow-compares the log-derived up-next
// against the live engine queue and reports mismatches here; we append them to an honest JSONL sense
// (userData/playhead-divergence.jsonl) so the read-path burn-in that gates Phase 3 is greppable.
ipcMain.on('health:playhead-divergence', (_e, record) => {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), ...(record || {}) }) + "\n";
    require('fs').appendFileSync(path.join(app.getPath('userData'), 'playhead-divergence.jsonl'), line);
  } catch { /* best-effort; a lost divergence line is cosmetic */ }
});

// Log-Reader Flip Phase 3 (§2.7): the boundary-shadow summary for the Health Monitor. Returns the
// per-station rolling tallies fed by the daemon's `logreader-shadow` events — the burn-in "sense" that
// gates the flip (agree rate + drift/miss extents). Read-only; [] before any boundary has fired.
ipcMain.handle('logreader-shadow:get', () => {
  try { return Array.from(_logReaderShadow.entries()).map(([stationId, s]) => ({ stationId, uuid: _stationUuidById(stationId), ...s })); }
  catch { return []; }
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
      // Surface the error but DON'T permanently disarm (parity with audiod/stream.js): keep armed and
      // retry on a long cooldown so a transient outage self-heals and a later "live" clears the banner.
      console.error(`[stream/${stationId}] ffmpeg failed ${state.failureCount}x in 10s — cooling down 30s (still armed)`);
      state.failureCount = 0;
      state.firstFailureTime = 0;
      state.statusState  = 'error';
      state.errorMsg     = 'Streaming failed after repeated ffmpeg restarts. Check Icecast server URL and credentials.';
      _emitDestStatus(`icecast:${stationId}`, state);
      _emitGlobal();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream:status', { stationId, live: false, error: state.errorMsg });
      }
      setTimeout(() => {
        if (state.armed) _spawnStream(stationId, args, label);
      }, 30000);
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
      const streamArgs = { stationId, config: { server, password: pw, mount, bitrate, sampleRate: 44100, icecastPort: 8000 } };
      try { await audiodClient.cmd('startStream', streamArgs); }
      catch (e) { return { ok: false, error: 'daemon startStream failed: ' + e.message }; }
      // Phase D (e): record stream intent HERE (this is the real start path — the audio:daemon bridge
      // is bypassed), so a daemon reload replays startStream and streams auto-restore instead of dead air.
      _streamIntent.set(stationId, streamArgs);
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
    _streamIntent.delete(stationId);   // Phase D (e): operator stopped the stream → don't auto-replay it
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
  getDb().prepare("SELECT * FROM stations WHERE deleted_at IS NULL ORDER BY id").all()
);

ipcMain.handle('stations:get-active', () =>
  getDb().prepare("SELECT * FROM stations WHERE is_active=1 AND deleted_at IS NULL LIMIT 1").get() ?? null
);

ipcMain.handle('stations:switch', (_, id) => {
  try {
    const { stationsUpdateById } = require('./sync/handlers/stations');
    const others = getDb().prepare("SELECT id FROM stations WHERE deleted_at IS NULL AND id != ?").all(id);
    for (const s of others) stationsUpdateById(getDb(), s.id, { is_active: 0 });
    stationsUpdateById(getDb(), id, { is_active: 1 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:create', (_, data) => {
  // Multi-station creation is unconditional. The Phase-3 INSERT-audit tripwire
  // (multistation_insert_audit_complete) was REMOVED 2026-07-05 — the audit is complete (Phase 3/4
  // mapped the station_id callsites, shipped empty-state handling, and demonstrated zero-station boot).
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
    // §8: seed this station's per-station config (5 separation rules + 47 metadata definitions + 35
    // vocabulary) in one transaction, the moment the station exists. Idempotent per station, so it's
    // safe for onboarding-created AND reconcile-materialized stations. Never blocks station creation.
    try { require('./seed-station-config').seedStationConfig(db, row.id); }
    catch (e) { console.error('[stations:create] seedStationConfig (§8) failed:', e.message); }
    // Decks are part of a station's shell, not a thing station 1 alone gets. Seed the
    // default set for the new station the moment it exists, so Configure Decks and the
    // live console have rows to read instead of falling back silently.
    try {
      const added = seedDeckConfigsForStation(row.id);
      console.log(`[stations:create] seeded ${added} deck slot(s) for station ${row.id}`);
    } catch (e) { console.error('[stations:create] seedDeckConfigsForStation failed:', e.message); }
    return { ok: true, id: row.id };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Stamp a station's account owner. Used by the reconcile self-heal to put every local station
// under the AUTHORITATIVE signed-in account license (owner_license_key drives publish/backup
// scope). Direct column write — owner_license_key is intentionally NOT in stations:update's
// patchable allow-list, so it can't be changed by ordinary station edits.
ipcMain.handle('stations:set-owner-license', (_, id, licenseKey) => {
  try {
    if (!id || !licenseKey) return { ok: false, error: 'id and licenseKey required' };
    db.prepare("UPDATE stations SET owner_license_key = ? WHERE id = ?").run(String(licenseKey), Number(id));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:update', (_, id, data) => {
  const allowed = [
    'name','callsign','frequency','city','state','country','website','is_active',
    'icecast_server_url','icecast_mount','icecast_password','icecast_bitrate','icecast_format',
  ];
  const patch = {};
  for (const k of allowed) { if (k in data) patch[k] = data[k]; }

  // PHASE 3 — scheduler_mode is written LOCALLY, outside the sync writer, and is deliberately absent
  // from `allowed` and from the stations PATCHABLE list. Which rotation engine an install runs is a
  // per-machine rollout decision: routing it through sync would switch another operator's scheduler
  // as a side effect of replication. Same reasoning as the log-reader flip canary's set-local path.
  let localApplied = false;
  if ('scheduler_mode' in data) {
    const mode = data.scheduler_mode === 'goal' ? 'goal' : 'clock';
    try { db.prepare("UPDATE stations SET scheduler_mode = ? WHERE id = ?").run(mode, id); localApplied = true; }
    catch (e) { return { ok: false, error: 'scheduler_mode: ' + e.message }; }
  }

  if (Object.keys(patch).length === 0) return localApplied ? { ok: true } : { ok: false, error: 'no valid fields' };
  try {
    const { stationsUpdateById } = require('./sync/handlers/stations');
    stationsUpdateById(db, id, patch);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:delete', async (_, id) => {
  try {
    const station = db.prepare("SELECT uuid FROM stations WHERE id=?").get(id);
    const { stationsDeleteById } = require('./sync/handlers/stations');
    stationsDeleteById(db, id);   // local soft-delete (deleted_at) + mutation = the tombstone

    // Propagate the delete to the CLOUD so the account reconcile can't resurrect it. Without this the
    // backend still holds the station and re-materializes it on every sync (the "delete that won't
    // stick" bug). License-scoped endpoint — only ever deletes a station THIS account owns.
    if (station?.uuid) {
      const licenseKey = accountLicenseKey();
      if (licenseKey) {
        try {
          const { default: fetchFn } = await import("node-fetch").catch(() => ({ default: global.fetch }));
          const r = await fetchFn(`${ETHER_BACKEND_URL}/account/delete-station`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ license_key: licenseKey, uuid: station.uuid }),
          });
          if (!r.ok) console.warn(`[stations:delete] cloud delete failed (${r.status}) — local tombstone still blocks resurrection on this machine`);
          else console.log(`[stations:delete] cloud delete ok for ${station.uuid}`);
        } catch (e) { console.warn("[stations:delete] cloud delete error:", e.message); }
      }
    }
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
    const licenseKey = accountLicenseKey();
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
    const licenseKey = accountLicenseKey();
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
// How much of the LIVE song library is actually in the cloud, counted from the database rather than
// claimed. "Your station is backed up" used to reflect the DB backup alone — so a station whose audio
// had never finished uploading still showed a green check, restored onto another machine looking
// complete, and then couldn't play the songs whose audio was never sent. This is the missing half.
ipcMain.handle('library:cloud-status', () => {
  try {
    const n = (sql) => db.prepare(sql).get()?.n ?? 0;
    const LIVE = "FROM songs WHERE deleted_at IS NULL AND file_path IS NOT NULL AND file_path != ''";
    const total    = n(`SELECT COUNT(*) AS n ${LIVE}`);
    const uploaded = n(`SELECT COUNT(*) AS n ${LIVE} AND r2_uploaded_at IS NOT NULL`);
    const last = db.prepare("SELECT MAX(r2_uploaded_at) AS t FROM songs WHERE deleted_at IS NULL").get()?.t || null;
    return { ok: true, total, uploaded, pending: Math.max(0, total - uploaded), lastUploadAt: last };
  } catch (e) { return { ok: false, error: e.message, total: 0, uploaded: 0, pending: 0 }; }
});

ipcMain.handle('library:sync-r2:upload', async (_evt, opts = {}) => {
  const force = !!(opts && opts.force);   // re-upload everything, ignoring the resume markers
  const TIER_RANK_LOCAL = { free: 0, pro: 1, pro_lifetime: 1, station: 2, station_lifetime: 2, operator: 3 };

  // Tier gate — Network+ only
  const planTier = (db.prepare("SELECT value FROM station_config_kv WHERE key='plan_tier' LIMIT 1").get())?.value || 'free';
  if ((TIER_RANK_LOCAL[planTier] || 0) < TIER_RANK_LOCAL.station) {
    return { ok: false, error: `Library sync to cloud requires Network (station) tier or higher — current: ${planTier}` };
  }

  // License key required — set during onboarding / SubscriptionPanel validate
  const licenseKey = accountLicenseKey();
  if (!licenseKey) return { ok: false, error: 'No license_key in station_config_kv' };

  // Every song that names a file. We DON'T trust the stored file_path blindly — after a library
  // reorg or a cloud restore it can point at a path that no longer exists (the file moved into a
  // genre subfolder, came from another machine, etc.). The DESIGNATED LIBRARY FOLDER is the source
  // of truth: we resolve each song to a real file on disk, consolidate it INTO that folder, then
  // upload. Universal — no machine-specific paths; works for any customer's library location.
  // deleted_at IS NULL — a delete is a delete from the foundation up, and the cloud is part of the
  // foundation. Deleted songs keep their file_path/file_key (the row is retained for play history), so
  // without this filter they were consolidated, uploaded, counted in the operator's progress total, and
  // handed back to any machine restoring from cloud. Live songs only.
  const songs = db.prepare(
    `SELECT id, file_path, file_key FROM songs
     WHERE deleted_at IS NULL
       AND ((file_path IS NOT NULL AND file_path != '') OR (file_key IS NOT NULL AND file_key != ''))`
  ).all();
  if (!songs.length) return { ok: false, error: 'No songs in the library yet.' };

  const libDir     = getMusicDir();             // the designated library folder (per-user, configurable)
  const searchRoot = path.dirname(libDir);      // its parent — covers the genre subfolders files were imported from
  try { fs.mkdirSync(libDir, { recursive: true }); } catch {}

  _libSyncAbort = false;

  // Fire-and-forget — returns immediately so the renderer isn't blocked
  (async () => {
    const { songsUpdateById } = require('./sync/handlers/songs');
    const AUDIO = new Set(['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg']);

    function contentType(fp) {
      const ext = path.extname(fp).toLowerCase();
      return ({ '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
                '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg' })[ext]
        || 'application/octet-stream';
    }

    // Build a basename → [fullpaths] index of the library tree ONCE, so resolving a stale path is a
    // map lookup rather than a filesystem walk per song.
    const index = new Map();
    (function walk(dir, depth) {
      if (depth > 8) return;
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (AUDIO.has(path.extname(e.name).toLowerCase())) {
          const k = e.name.toLowerCase();
          if (!index.has(k)) index.set(k, []);
          index.get(k).push(full);
        }
      }
    })(searchRoot, 0);

    const libLower = libDir.toLowerCase();
    function resolveFile(song) {
      if (song.file_path && fs.existsSync(song.file_path)) return song.file_path;     // stored path still valid
      const base = path.basename(song.file_path || song.file_key || '');
      if (!base) return null;
      const inLib = path.join(libDir, base);
      if (fs.existsSync(inLib)) return inLib;                                          // already in the library folder
      const cands = index.get(base.toLowerCase()) || [];
      const libCand = cands.find(p => p.toLowerCase().startsWith(libLower));           // prefer the copy in the library folder (disambiguates same-named files across genre folders)
      return libCand || cands[0] || null;
    }

    // ── Phase 1: CONSOLIDATE — copy every resolved file into the library folder and re-point
    //    file_path, so "everything lives in the library folder" becomes literally true. ──
    let consolidated = 0, notFound = 0, cdone = 0;
    const missing = [];
    for (const song of songs) {
      if (_libSyncAbort) break;
      cdone++;
      const label = path.basename(song.file_path || song.file_key || `song#${song.id}`);
      const src = resolveFile(song);
      if (!src) { notFound++; if (missing.length < 200) missing.push(label); continue; }
      const base = path.basename(src);
      const dest = path.join(libDir, base);
      try {
        if (path.resolve(src).toLowerCase() !== path.resolve(dest).toLowerCase() && !fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          consolidated++;
        }
      } catch (e) { console.warn(`[library:sync-r2] consolidate copy failed ${base}: ${e.message}`); }
      const finalPath = fs.existsSync(dest) ? dest : src;
      if (song.file_key !== base) { try { songsUpdateById(db, song.id, { file_key: base }); } catch {} }
      try { db.prepare('UPDATE songs SET file_path = ? WHERE id = ?').run(finalPath, song.id); } catch {}
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:sync-r2:upload:progress', {
          phase: 'consolidate', done: cdone, total: songs.length, errors: notFound, current: base,
        });
      }
    }

    // ── Phase 2: UPLOAD — push files not yet in the cloud (or all, when force). ──
    const toUpload = db.prepare(
      `SELECT id, file_path FROM songs
       WHERE deleted_at IS NULL
         AND file_path IS NOT NULL AND file_path != ''
         ${force ? '' : 'AND r2_uploaded_at IS NULL'}`
    ).all().filter(s => { try { return fs.existsSync(s.file_path); } catch { return false; } });

    const CONCURRENCY = 3;
    let done = 0, uploaded = 0, errors = 0;
    const failures = [];

    async function uploadOne(song) {
      if (_libSyncAbort) return;
      const fileKey = path.basename(song.file_path);
      // Retry transient signing/PUT failures so a single run never leaves stragglers — rapid-fire
      // concurrent uploads occasionally drop one to a network/rate-limit blip; the file is fine.
      const MAX_TRIES = 3;
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_TRIES && !_libSyncAbort; attempt++) {
        try {
          const urlRes = await fetch(`${ETHER_BACKEND_URL}/audio/upload-url`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ license_key: licenseKey, file_key: fileKey }),
          });
          const urlData = await urlRes.json().catch(() => ({}));
          if (!urlRes.ok || !urlData.signed_url) {
            throw new Error(urlData.error || urlData.detail || `signing failed (HTTP ${urlRes.status})`);
          }
          const data = fs.readFileSync(song.file_path);
          const putRes = await fetch(urlData.signed_url, {
            method:  'PUT',
            headers: { 'Content-Type': contentType(song.file_path), 'Content-Length': String(data.length) },
            body: data,
          });
          if (!putRes.ok) {
            const text = await putRes.text().catch(() => '');
            throw new Error(`R2 PUT failed: HTTP ${putRes.status} — ${text.slice(0, 200)}`);
          }
          songsUpdateById(db, song.id, { file_key: fileKey });
          db.prepare('UPDATE songs SET r2_uploaded_at = ? WHERE id = ?').run(new Date().toISOString(), song.id);
          uploaded++;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < MAX_TRIES && !_libSyncAbort) await new Promise(r => setTimeout(r, 500 * attempt));
        }
      }
      if (lastErr) {
        errors++;
        if (failures.length < 200) failures.push({ name: fileKey, reason: lastErr.message });
        console.warn(`[library:sync-r2] FAIL ${fileKey} after ${MAX_TRIES} tries: ${lastErr.message}`);
      }
      done++;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:sync-r2:upload:progress', {
          phase: 'upload', done, total: toUpload.length, errors, current: fileKey,
        });
      }
    }

    for (let i = 0; i < toUpload.length; i += CONCURRENCY) {
      if (_libSyncAbort) break;
      await Promise.all(toUpload.slice(i, i + CONCURRENCY).map(uploadOne));
    }

    const aborted = _libSyncAbort;
    _libSyncAbort = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:sync-r2:upload:done', {
        uploaded, total: toUpload.length, errors, aborted,
        consolidated, notFound, missing: missing.slice(0, 50), failures: failures.slice(0, 50), libDir,
      });
    }
    console.log(`[library:sync-r2] ${aborted ? 'Cancelled' : 'Done'} — consolidated ${consolidated}, uploaded ${uploaded}/${toUpload.length}, ${errors} upload errors, ${notFound} not found. libDir=${libDir}`);
  })().catch(e => {
    console.error('[library:sync-r2] fatal:', e.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:sync-r2:upload:done', { uploaded: 0, total: 0, errors: 1, aborted: false, fatal: e.message });
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
  const licenseKey = accountLicenseKey();
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
