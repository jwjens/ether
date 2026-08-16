"use strict";
/**
 * PROFILE-PER-ACCOUNT — the ONE place any Ether data path is built.
 *
 * Model: Windows user profiles. Each account gets its own data directory and its own database;
 * sign-in selects the profile. Isolation is by DIRECTORY — there is no owner-column scoping and
 * no wipe. Signing in is a read: it changes which directory is open, it never deletes anything.
 *
 *   %LOCALAPPDATA%\Ether\
 *     profiles\
 *       active                      <- POINTER (plaintext license key) — machine-level
 *       ETH-STN-BAA8-E056-6FC8\     <- one account's whole world
 *         openair.db  (+ -wal/-shm) health-events.jsonl  logs\  automation-intent.json
 *         restore-failures.log      r2-deletion-report.jsonl
 *         .ether-on-air  .ether-keep-session
 *       _pending\                   <- scratch profile that carries a sign-in before its key is known
 *     engine\                       <- staged audio engine binaries — MACHINE-level, shared
 *
 * THE BOOT CIRCULARITY, AND WHY THE POINTER EXISTS.
 * The license key that names a profile lives INSIDE that profile's database (install_config_kv
 * .account_license_key -> stations.owner_license_key -> station_config_kv.license_key; see
 * electron/sync/transport-http.js _getLicenseKey). To read the key you must already have opened a
 * database; to know which database to open you must already have the key. main.js opens SQLite in
 * app.whenReady() BEFORE any window exists, so no sign-in has happened and no key can be known.
 * The pointer file breaks that loop: it is the only account fact readable before the first open.
 *
 * Written ONLY by a sign-in that genuinely produced a key (OnboardingFlow doSignIn / doSignUp /
 * manual key entry -> profile:adopt), and by the one-time migration as its FINAL step, after the
 * move has been verified. The identity-less resume doors (account:was-on-air, account:resume-session)
 * never write it — they resume whatever it already names.
 *
 * EDGE RULES (binding):
 *  1. No pointer, or a pointer naming a directory that is not there -> route to sign-in. Never guess,
 *     never auto-create a profile from a stale pointer.
 *  2. Migration writes the pointer LAST, only after the move verifiably succeeded, so a failed
 *     migration can never leave the pointer aimed at a half-moved directory.
 *  3. The pointer and %LOCALAPPDATA%\EtherMachine\machine-id are the ONLY things outside profiles.
 *
 * Pure Node — no electron require — because the out-of-process audio daemon (audiod/ether-audiod.js)
 * loads this too and must resolve the identical path.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Scratch profile used to carry a sign-in before the account's key is known. The leading
 *  underscore is rejected by sanitizeKey(), so it can never collide with a real license key. */
const PENDING = "_pending";

/** License keys look like ETH-STN-BAA8-E056-6FC8. Anything outside this alphabet is refused rather
 *  than escaped — a directory name is not the place to be clever, and `..` must never survive. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;

// ── Roots ──────────────────────────────────────────────────────────────────────────────────────
/** %LOCALAPPDATA%\Ether — machine-local, NEVER the redirected Roaming/SMB path. On managed boxes
 *  (OV) Roaming is redirected to a network share where SQLite's WAL -shm mmap is unsupported. */
function etherRoot() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Ether");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Ether");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "Ether");
}

function profilesRoot() { return path.join(etherRoot(), "profiles"); }
function pointerFile()  { return path.join(profilesRoot(), "active"); }

/** The legacy single data directory, pre-profiles. Only the migration should care about this. */
function legacyDataDir() { return path.join(etherRoot(), "com.ether.radio"); }

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────
/** Returns the canonical directory-safe key, or null if it is not one. Callers MUST treat null as
 *  "this is not a profile" — never as "use a default". */
function sanitizeKey(key) {
  const s = String(key == null ? "" : key).trim().toUpperCase();
  return KEY_RE.test(s) ? s : null;
}

// ── Per-profile paths ──────────────────────────────────────────────────────────────────────────
function profileDir(key) {
  const safe = key === PENDING ? PENDING : sanitizeKey(key);
  if (!safe) throw new Error(`profile-paths: refusing to build a path for an invalid profile key: ${JSON.stringify(key)}`);
  return path.join(profilesRoot(), safe);
}
function profileExists(key) {
  try { return fs.existsSync(path.join(profileDir(key), "openair.db")); } catch { return false; }
}
/** Create the directory if absent. Returns the path. */
function ensureProfileDir(key) {
  const dir = profileDir(key);
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { throw new Error(`Cannot create profile folder ${dir}: ${e.message}`); }
  return dir;
}

function dbPath(key)              { return path.join(profileDir(key), "openair.db"); }
function logsDir(key)             { return path.join(profileDir(key), "logs"); }
function healthEventsFile(key)    { return path.join(profileDir(key), "health-events.jsonl"); }
function automationIntentFile(key){ return path.join(profileDir(key), "automation-intent.json"); }
function restoreFailuresLog(key)  { return path.join(profileDir(key), "restore-failures.log"); }
function cloudRestoreTmp(key)     { return path.join(profileDir(key), "cloud-restore.db"); }
/** Session/HA markers (.ether-on-air, .ether-keep-session, .ether-expected-restart). */
function markerPath(key, name)    { return path.join(profileDir(key), name); }

// ── Machine-level paths (deliberately OUTSIDE any profile) ─────────────────────────────────────
/** Staged audio-engine binaries — a build for THIS machine/arch, shared by every profile. */
function engineStageDir() { return path.join(etherRoot(), "engine"); }

// ── The pointer ────────────────────────────────────────────────────────────────────────────────
/** The profile named by the pointer, or null. Does NOT check that it exists — callers pair this
 *  with profileExists() so edge rule 1 is applied at one place (resolveActive). */
function readPointer() {
  try {
    const raw = fs.readFileSync(pointerFile(), "utf8");
    return sanitizeKey(raw);
  } catch { return null; }
}

/** Write the pointer atomically (tmp + rename) so a crash mid-write can never leave a torn pointer
 *  that names half a key. Throws on failure — a silently unwritten pointer would strand the account
 *  on the next launch, which is exactly the failure this file exists to prevent. */
function writePointer(key) {
  const safe = sanitizeKey(key);
  if (!safe) throw new Error(`profile-paths: refusing to point at an invalid profile key: ${JSON.stringify(key)}`);
  const dir = profilesRoot();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = pointerFile() + ".tmp";
  fs.writeFileSync(tmp, safe, "utf8");
  fs.renameSync(tmp, pointerFile());
  return safe;
}

function clearPointer() {
  try { fs.rmSync(pointerFile(), { force: true }); return true; } catch { return false; }
}

// ── Active profile resolution ──────────────────────────────────────────────────────────────────
// Resolved ONCE per process and cached: every path builder in the app must agree on which profile
// is open, and re-reading the pointer mid-session would let a concurrent sign-in move the target
// under a running daemon.
let _active = null;      // { key, pending }

/**
 * Decide which profile this process runs against.
 *   pointer names an existing profile  -> that profile          (pending:false)
 *   no pointer / pointer is a dangling name -> the _pending scratch profile (pending:true)
 *
 * pending:true is the caller's signal to force sign-in (edge rule 1). It is NOT a fallback account:
 * nothing about a stale pointer is ever adopted, and the scratch profile starts empty.
 */
function resolveActive({ freshPending = false } = {}) {
  if (_active) return _active;
  const named = readPointer();
  if (named && profileExists(named)) {
    _active = { key: named, pending: false };
    return _active;
  }
  if (named) {
    console.warn(`[profiles] pointer names "${named}" but no database is there — routing to sign-in (no profile adopted)`);
  }
  // A scratch profile carries the sign-in until its account's key is known. Reset it on a cold
  // start so a half-finished prior sign-in can never be mistaken for an account's data.
  if (freshPending) {
    try { fs.rmSync(profileDir(PENDING), { recursive: true, force: true }); }
    catch (e) { console.warn("[profiles] could not reset the pending profile (using it as-is):", e.message); }
  }
  ensureProfileDir(PENDING);
  _active = { key: PENDING, pending: true };
  return _active;
}

/** The active profile key (may be PENDING). */
function activeKey()      { return resolveActive().key; }
/** True when no real profile is open — the app must show sign-in and the resume doors must refuse. */
function isPending()      { return resolveActive().pending; }

/** Re-point this process at `key` in memory. Used right after adopt/migration so subsequent path
 *  builds in the SAME process resolve to the new profile. Does not write the pointer. */
function setActive(key) {
  const safe = key === PENDING ? PENDING : sanitizeKey(key);
  if (!safe) throw new Error(`profile-paths: cannot activate an invalid profile key: ${JSON.stringify(key)}`);
  _active = { key: safe, pending: safe === PENDING };
  return _active;
}

/** Every profile on this machine (real accounts only — the scratch profile is not one). */
function listProfiles() {
  try {
    return fs.readdirSync(profilesRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && sanitizeKey(d.name))
      .map((d) => sanitizeKey(d.name));
  } catch { return []; }
}

module.exports = {
  PENDING,
  etherRoot, profilesRoot, pointerFile, legacyDataDir,
  sanitizeKey,
  profileDir, profileExists, ensureProfileDir,
  dbPath, logsDir, healthEventsFile, automationIntentFile,
  restoreFailuresLog, cloudRestoreTmp, markerPath,
  engineStageDir,
  readPointer, writePointer, clearPointer,
  resolveActive, activeKey, isPending, setActive, listProfiles,
};
