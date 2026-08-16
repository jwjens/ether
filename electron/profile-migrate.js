"use strict";
/**
 * ONE-TIME, NON-DESTRUCTIVE MIGRATION into profile-per-account.
 *
 * Moves the single legacy data directory into profiles/<licenseKey>/ on first launch.
 *
 *   MOVE, never copy. The library on a real install is hundreds of megabytes (jensj's is ~726MB);
 *   a copy would duplicate it on a disk that may not have room, and would leave two divergent
 *   databases where the operator can only see one. A same-volume rename is atomic and instant.
 *
 *   REFUSE LOUDLY, never half-migrate. Windows fails a directory rename while ANY process holds a
 *   file inside it open — and the audio daemon holds openair.db open on any machine that has played
 *   audio, which is every machine. That is the NORMAL failure, not a corner case. When it happens
 *   the app keeps running on the legacy path exactly as before and says so. Nothing is moved back,
 *   because nothing was moved.
 *
 *   THE POINTER IS WRITTEN LAST (edge rule 2). Only after the moved database has been reopened and
 *   re-read for the same license key does profiles/active start naming it. A migration that dies at
 *   any earlier step leaves no pointer, so the next launch simply tries again on the legacy path.
 *
 * The license key is read from the legacy database in the SAME order of trust the sync transport
 * uses (electron/sync/transport-http.js _getLicenseKey): the install-scope account anchor, then the
 * owner of this install's stations, then the legacy per-station slot. If none of the three yields a
 * key the profile has no name, so the migration refuses — an unnameable profile is exactly the STOP
 * condition this design was gated on.
 */

const fs = require("fs");
const path = require("path");
const P = require("./profile-paths");

/** Per-account artifacts that live under Electron's userData (Roaming\Ether) rather than the data
 *  dir. They are account state, so they belong in the profile — the Roaming split folds in here.
 *
 *  DELIBERATELY ABSENT — these are machine-level and must stay in Roaming\Ether because the WATCHDOG
 *  resolves that path independently and knows nothing about accounts:
 *    .ether-expected-restart, .ether-ha-alarm, ha-config.json, watchdog.log, .ether-watchdog.pid
 *  (watchdog/watchdog.js EXPECTED_RESTART / ALARM_MARKER, watchdog/platform/win32.js). */
const USERDATA_ITEMS = [
  "health-events.jsonl",
  "logs",
  "automation-intent.json",
  "backups",
  "clips",
  "r2-cache",
  "music-dir.txt",
  "ai-config.json",
  ".ether-on-air",
  ".ether-keep-session",
  // Append-only ledgers. These carry a RECEIPT TRAIL — r2-deletion-report.jsonl in particular is the
  // evidence of what was released from R2 and why — so losing their history is not the same as
  // losing a log file. They belong with the database they describe.
  "logreader-shadow.jsonl",
  "playhead-divergence.jsonl",
  "scheduler-core-shadow.jsonl",
  "r2-deletion-report.jsonl",
];

/** Read the account's license key out of a database file, in the transport's order of trust. */
function readLicenseKeyFrom(Database, dbFile) {
  let conn = null;
  try {
    conn = new Database(dbFile, { readonly: true, fileMustExist: true });
    const one = (sql) => { try { return conn.prepare(sql).get()?.value || null; } catch { return null; } };
    const key =
      one("SELECT value FROM install_config_kv WHERE key = 'account_license_key' AND value IS NOT NULL AND value != '' AND deleted_at IS NULL LIMIT 1")
      || one("SELECT owner_license_key AS value FROM stations WHERE owner_license_key IS NOT NULL AND owner_license_key != '' AND deleted_at IS NULL ORDER BY is_active DESC, id ASC LIMIT 1")
      || one("SELECT value FROM station_config_kv WHERE key = 'license_key' LIMIT 1");
    return key ? String(key).trim() : null;
  } catch {
    return null;
  } finally {
    try { if (conn) conn.close(); } catch {}
  }
}

/**
 * @param {object}   opts
 * @param {Function} opts.Database   better-sqlite3 constructor (injected so this is provable off-app)
 * @param {string}  [opts.userDataDir] Electron userData dir, for the Roaming per-account artifacts
 * @param {Function}[opts.log]
 * @returns {{status:string, key?:string, reason?:string, from?:string, to?:string, moved?:string[]}}
 *   status: 'already-migrated' | 'nothing-to-migrate' | 'migrated' | 'refused'
 */
function migrateToProfiles(opts = {}) {
  const { Database, userDataDir = null } = opts;
  const log = opts.log || ((...a) => console.log("[profile-migrate]", ...a));

  // 1. A pointer means this machine is already on profiles. Never run twice.
  const existing = P.readPointer();
  if (existing && P.profileExists(existing)) return { status: "already-migrated", key: existing };

  // 2. Nothing to move?
  const legacyDir = P.legacyDataDir();
  const legacyDb = path.join(legacyDir, "openair.db");
  if (!fs.existsSync(legacyDb)) return { status: "nothing-to-migrate" };

  // 3. Name the profile. No key -> no name -> refuse (never invent one).
  const rawKey = readLicenseKeyFrom(Database, legacyDb);
  const key = P.sanitizeKey(rawKey);
  if (!key) {
    const reason = rawKey
      ? `the license key in the existing database (${JSON.stringify(rawKey)}) is not a usable directory name`
      : "the existing database carries no license key (no account anchor, no station owner, no per-station slot)";
    log("REFUSED —", reason, "; continuing on the legacy path, nothing was moved");
    return { status: "refused", reason };
  }

  const target = P.profileDir(key);
  if (fs.existsSync(target)) {
    const reason = `a profile for ${key} already exists at ${target}; refusing to merge two databases`;
    log("REFUSED —", reason);
    return { status: "refused", reason, key };
  }

  // 4. THE MOVE. Same volume -> atomic rename, no duplicate bytes. A failure here means a file in
  //    the directory is held open (the daemon). Refuse; do NOT fall back to a copy.
  try { fs.mkdirSync(P.profilesRoot(), { recursive: true }); }
  catch (e) { return { status: "refused", reason: `cannot create ${P.profilesRoot()}: ${e.message}`, key }; }

  try {
    fs.renameSync(legacyDir, target);
  } catch (e) {
    const reason =
      `could not move ${legacyDir} -> ${target}: ${e.message}. ` +
      "On Windows this means a process still holds the database open (usually the audio daemon). " +
      "Nothing was moved; the app continues on the legacy path.";
    log("REFUSED —", reason);
    return { status: "refused", reason, key };
  }

  // 5. VERIFY the moved database before anything starts trusting it.
  const movedDb = P.dbPath(key);
  if (!fs.existsSync(movedDb)) {
    return { status: "refused", reason: `move reported success but ${movedDb} is not there — pointer NOT written`, key };
  }
  const verifyKey = P.sanitizeKey(readLicenseKeyFrom(Database, movedDb));
  if (verifyKey !== key) {
    return {
      status: "refused",
      key,
      reason: `moved database re-read as ${verifyKey || "no key"} (expected ${key}) — pointer NOT written; ` +
              `the data is at ${target} and can be moved back to ${legacyDir} by hand`,
    };
  }

  // 6. Fold in the per-account artifacts that lived under Roaming userData. Best-effort BY DESIGN:
  //    these are logs and markers, not the database. The migration is already a success without
  //    them, and refusing here would strand a verified database behind a log file.
  const moved = [];
  if (userDataDir) {
    for (const item of USERDATA_ITEMS) {
      const src = path.join(userDataDir, item);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(target, item);
      try {
        if (fs.existsSync(dst)) {
          // NEVER delete the source just because something is already at the destination — that
          // silently discards whichever copy is older, and for the append-only ledgers above the
          // older copy is the entire history. Leave it where it is and say so; a human can merge.
          log(`${item} already exists in the profile — leaving the copy at ${src} untouched (merge by hand if you want one file)`);
          continue;
        }
        fs.renameSync(src, dst);
        moved.push(item);
      } catch (e) {
        try { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); moved.push(item); }
        catch (e2) { log(`could not move ${item} into the profile (leaving it): ${e2.message}`); }
      }
    }
  }

  // 7. POINTER LAST — only now is the profile real (edge rule 2).
  try {
    P.writePointer(key);
  } catch (e) {
    return {
      status: "refused",
      key,
      reason: `data moved to ${target} but the pointer could not be written: ${e.message}. ` +
              `The next launch will route to sign-in; the data is intact at ${target}.`,
    };
  }
  P.setActive(key);
  log(`migrated ${legacyDir} -> ${target}${moved.length ? ` (+ ${moved.join(", ")})` : ""}; pointer -> ${key}`);
  return { status: "migrated", key, from: legacyDir, to: target, moved };
}

module.exports = { migrateToProfiles, readLicenseKeyFrom, USERDATA_ITEMS };
