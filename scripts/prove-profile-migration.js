"use strict";
/**
 * PROVE THE PROFILE MIGRATION ON A COPY — never on the live directory.
 *
 * Builds a throwaway %LOCALAPPDATA% sandbox, copies the REAL openair.db (and its WAL/SHM sidecars)
 * into it, and runs the actual electron/profile-migrate.js against that copy. The live
 * %LOCALAPPDATA%\Ether is opened READ-ONLY (to copy bytes out) and is never written, renamed, or
 * deleted by this script.
 *
 * Run:  cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/prove-profile-migration.js
 *       (better-sqlite3 here is built for the Electron ABI, so plain `node` cannot load it)
 *
 * Scenarios proven:
 *   1. happy path        — legacy dir moves, bytes preserved, pointer written LAST, legacy dir gone
 *   2. locked database   — rename refused, NOTHING moved, no pointer, app can keep using the old path
 *   3. no license key    — refused (an unnameable profile is never invented)
 *   4. already migrated  — second run is a no-op, data untouched
 *   5. dangling pointer  — pointer naming a missing profile routes to sign-in, adopts nothing
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const REAL_LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const REAL_DATA_DIR = path.join(REAL_LOCALAPPDATA, "Ether", "com.ether.radio");
const SANDBOX_ROOT = path.join(os.tmpdir(), "ether-profile-migration-proof");

let Database;
try { Database = require("better-sqlite3"); }
catch (e) {
  console.error("FATAL: better-sqlite3 unavailable — run under electron:\n" +
                "  cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/prove-profile-migration.js\n" + e.message);
  process.exit(2);
}

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log("  PASS  " + m); };
const bad = (m) => { fail++; console.log("  FAIL  " + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/** Fresh module instances per scenario — profile-paths caches the active profile per process. */
function loadModules() {
  for (const m of ["../electron/profile-paths", "../electron/profile-migrate"]) {
    delete require.cache[require.resolve(m)];
  }
  return { P: require("../electron/profile-paths"), M: require("../electron/profile-migrate") };
}

/** Build a sandbox %LOCALAPPDATA% holding a copy of the real data dir. */
function buildSandbox(name, { withDb = true, realDb = true } = {}) {
  const root = path.join(SANDBOX_ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  const dataDir = path.join(root, "Ether", "com.ether.radio");
  fs.mkdirSync(dataDir, { recursive: true });

  if (withDb) {
    const src = path.join(REAL_DATA_DIR, "openair.db");
    if (realDb && fs.existsSync(src)) {
      // The real database, byte for byte. This is the point of the exercise.
      for (const sfx of ["", "-wal", "-shm"]) {
        if (fs.existsSync(src + sfx)) fs.copyFileSync(src + sfx, path.join(dataDir, "openair.db" + sfx));
      }
    } else {
      // A schema-shaped stand-in with no license key anywhere (scenario 3).
      const d = new Database(path.join(dataDir, "openair.db"));
      d.exec(`CREATE TABLE install_config_kv (key TEXT, value TEXT, deleted_at TEXT);
              CREATE TABLE stations (id INTEGER PRIMARY KEY, owner_license_key TEXT, is_active INT, deleted_at TEXT);
              CREATE TABLE station_config_kv (station_id INT, key TEXT, value TEXT);`);
      d.close();
    }
  }
  // Per-account artifacts that live under Roaming userData.
  const userData = path.join(root, "RoamingEther");
  fs.mkdirSync(path.join(userData, "logs"), { recursive: true });
  fs.writeFileSync(path.join(userData, "health-events.jsonl"), '{"e":"proof"}\n');
  fs.writeFileSync(path.join(userData, "logs", "app.log"), "proof\n");
  fs.writeFileSync(path.join(userData, ".ether-on-air"), String(Date.now()));

  process.env.LOCALAPPDATA = root;
  return { root, dataDir, userData };
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function scenario(title, fn) {
  console.log("\n" + title);
  try { fn(); } catch (e) { bad(`threw: ${e.stack || e.message}`); }
}

// ── Preflight ──────────────────────────────────────────────────────────────────────────────────
console.log("PROVING PROFILE MIGRATION ON A COPY");
console.log("  live data dir (read-only source): " + REAL_DATA_DIR);
console.log("  sandbox root:                     " + SANDBOX_ROOT);
if (!fs.existsSync(path.join(REAL_DATA_DIR, "openair.db"))) {
  console.error("FATAL: no live openair.db to copy from — nothing to prove against.");
  process.exit(2);
}
const LIVE_DB_BYTES = fs.statSync(path.join(REAL_DATA_DIR, "openair.db")).size;
console.log("  live openair.db:                  " + (LIVE_DB_BYTES / 1048576).toFixed(1) + " MB");

// ── 1. Happy path ──────────────────────────────────────────────────────────────────────────────
let happyKey = null;
scenario("1. HAPPY PATH — the real database moves into its profile", () => {
  const { dataDir, userData } = buildSandbox("happy");
  const { P, M } = loadModules();
  const beforeBytes = dirSize(dataDir);

  const res = M.migrateToProfiles({ Database, userDataDir: userData, log: () => {} });
  check(res.status === "migrated", `status is 'migrated' (got '${res.status}'${res.reason ? ": " + res.reason : ""})`);
  if (res.status !== "migrated") return;
  happyKey = res.key;

  check(/^ETH-/.test(res.key), `profile named from the license key: ${res.key}`);
  check(!fs.existsSync(dataDir), "legacy com.ether.radio is GONE (moved, not copied)");
  check(fs.existsSync(P.dbPath(res.key)), "openair.db is inside the profile");
  check(fs.statSync(P.dbPath(res.key)).size === LIVE_DB_BYTES,
        `database bytes preserved exactly (${LIVE_DB_BYTES})`);
  check(dirSize(P.profileDir(res.key)) >= beforeBytes, "no bytes lost in the move");
  check(P.readPointer() === res.key, `pointer names the profile (${P.readPointer()})`);
  check(M.readLicenseKeyFrom(Database, P.dbPath(res.key)) === res.key,
        "moved database re-reads the same license key");
  check(fs.existsSync(path.join(P.profileDir(res.key), "health-events.jsonl")), "health ledger folded into the profile");
  check(fs.existsSync(path.join(P.profileDir(res.key), "logs", "app.log")), "logs folded into the profile");
  check(fs.existsSync(path.join(P.profileDir(res.key), ".ether-on-air")), "session markers folded into the profile");
  check(!fs.existsSync(path.join(userData, "health-events.jsonl")), "Roaming copy of the health ledger is gone");
  check(P.resolveActive().pending === false, "resolveActive() opens the profile, not the scratch one");
});

// ── 2. Locked database — the normal Windows failure ────────────────────────────────────────────
scenario("2. LOCKED DATABASE — refuse loudly, move nothing", () => {
  const { dataDir, userData } = buildSandbox("locked");
  const { P, M } = loadModules();
  const beforeBytes = dirSize(dataDir);

  // Hold the database open the way the audio daemon does.
  const fd = fs.openSync(path.join(dataDir, "openair.db"), "r+");
  let res;
  try { res = M.migrateToProfiles({ Database, userDataDir: userData, log: () => {} }); }
  finally { fs.closeSync(fd); }

  if (res.status === "migrated" && process.platform !== "win32") {
    ok("(POSIX renames an open file by design — lock scenario is Windows-only; skipped)");
    return;
  }
  check(res.status === "refused", `status is 'refused' (got '${res.status}')`);
  check(typeof res.reason === "string" && res.reason.length > 0, "refusal states a reason");
  check(fs.existsSync(path.join(dataDir, "openair.db")), "legacy database STILL THERE — app keeps running on it");
  check(dirSize(dataDir) === beforeBytes, "not one byte moved");
  check(P.readPointer() === null, "NO pointer written — a failed migration never points anywhere");
  check(!fs.existsSync(P.profilesRoot()) || fs.readdirSync(P.profilesRoot()).filter((f) => f !== "active").length === 0,
        "no half-moved profile directory left behind");
});

// ── 3. No license key — unnameable profile ─────────────────────────────────────────────────────
scenario("3. NO LICENSE KEY — refuse rather than invent a name", () => {
  const { dataDir, userData } = buildSandbox("nokey", { realDb: false });
  const { P, M } = loadModules();
  const res = M.migrateToProfiles({ Database, userDataDir: userData, log: () => {} });
  check(res.status === "refused", `status is 'refused' (got '${res.status}')`);
  check(/no license key/i.test(res.reason || ""), "refusal names the missing key as the cause");
  check(fs.existsSync(path.join(dataDir, "openair.db")), "legacy database untouched");
  check(P.readPointer() === null, "no pointer written");
});

// ── 4. Already migrated — idempotent ───────────────────────────────────────────────────────────
scenario("4. ALREADY MIGRATED — second run is a no-op", () => {
  process.env.LOCALAPPDATA = path.join(SANDBOX_ROOT, "happy");
  const { P, M } = loadModules();
  if (!happyKey) { bad("scenario 1 did not migrate, cannot test idempotence"); return; }
  const before = dirSize(P.profileDir(happyKey));
  const res = M.migrateToProfiles({ Database, log: () => {} });
  check(res.status === "already-migrated", `status is 'already-migrated' (got '${res.status}')`);
  check(dirSize(P.profileDir(happyKey)) === before, "profile bytes unchanged by the second run");
  check(P.readPointer() === happyKey, "pointer still names the same profile");
});

// ── 5. Dangling pointer — route to sign-in, adopt nothing ──────────────────────────────────────
scenario("5. DANGLING POINTER — route to sign-in, never guess", () => {
  const { } = buildSandbox("dangling", { withDb: false });
  const { P } = loadModules();
  P.writePointer("ETH-STN-DEAD-BEEF-0000");
  const active = P.resolveActive({ freshPending: true });
  check(active.pending === true, "resolveActive() reports pending (the app must show sign-in)");
  check(active.key === P.PENDING, `active profile is the scratch one (${active.key})`);
  check(!P.profileExists("ETH-STN-DEAD-BEEF-0000"), "the named profile was NOT auto-created");
  check(P.listProfiles().length === 0, "no account profile invented from a stale pointer");
});

// ── Summary ────────────────────────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(70));
console.log(`${pass} passed, ${fail} failed`);
console.log("sandbox left at " + SANDBOX_ROOT + " for inspection (safe to delete)");
console.log("LIVE DIRECTORY WAS NEVER WRITTEN: " + REAL_DATA_DIR);
process.exit(fail === 0 ? 0 : 1);
