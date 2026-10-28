// electron/account-session.js — WHERE THE ACCOUNT SIGN-IN IS KEPT (docs/account-sign-in-plan-2026-10-26.md, Phase 0).
//
// Jeff, 2026-10-28: "Phase 0 first: the sign-in token out of the database and backups."
// The sign-in token used to live in install_config_kv.account_jwt, plain text inside openair.db — and so inside every
// local and cloud backup (whole-database copies). It now lives ONLY in <profile>\auth.bin, encrypted with Electron's
// safeStorage (Windows: DPAPI, bound to this Windows user; macOS: Keychain): outside the database, in no backup, and
// useless if the profile folder is copied to another computer or Windows user. Never a plaintext fallback: with no
// safeStorage the token is kept in memory for this run only.
//
// Every reader and writer goes through here. The database can no longer hold the key: migrate() moves an existing row
// out and deletes it (secure_delete, so the bytes are overwritten, not left in free pages); scrubDb() does the same for a
// restored database; the install_config_kv writer refuses the key (SECRET_INSTALL_KEYS); the backup worker scrubs every
// copy it makes.
"use strict";
const path = require("path");

/** install_config_kv keys that must never be in a database or a backup. */
const SECRET_INSTALL_KEYS = ["account_jwt"];
const FILE = "auth.bin";

/**
 * @param {object} o
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} o.safeStorage
 * @param {() => string} o.dir   the active profile's folder (the folder openair.db is in) — read at every call, so a
 *                               profile switch reads that profile's sign-in
 * @param {object} [o.fs]
 * @param {(event: string, detail?: object) => void} [o.note]  health ledger
 */
function createAccountSession({ safeStorage, dir, fs = require("fs"), note = () => {} }) {
  const mem = new Map();   // profile dir → token: this run's copy (and the only copy when safeStorage is unavailable)
  const file = () => path.join(dir(), FILE);
  const canEncrypt = () => { try { return !!safeStorage && safeStorage.isEncryptionAvailable(); } catch { return false; } };

  function get() {
    const d = dir();
    if (mem.has(d)) return mem.get(d);
    let token = null;
    try {
      if (canEncrypt() && fs.existsSync(file())) token = safeStorage.decryptString(fs.readFileSync(file())) || null;
    } catch (e) { note("account-session-unreadable", { reason: String(e && e.message || e) }); token = null; }
    mem.set(d, token);
    return token;
  }

  function set(token) {
    const t = token ? String(token) : null;
    if (!t) return clear();
    mem.set(dir(), t);
    if (!canEncrypt()) { note("account-session-memory-only", { reason: "this computer's protected storage is unavailable" }); return { ok: true, stored: "memory" }; }
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(t));
    fs.renameSync(tmp, file());
    return { ok: true, stored: "protected" };
  }

  function clear() {
    mem.set(dir(), null);
    try { fs.rmSync(file(), { force: true }); } catch { /* nothing to remove */ }
    return { ok: true };
  }

  /** Remove the secret keys from a database, overwriting their bytes. Returns how many rows went. */
  function scrubDb(db) {
    let n = 0;
    try {
      db.pragma("secure_delete = ON");
      for (const k of SECRET_INSTALL_KEYS) n += db.prepare("DELETE FROM install_config_kv WHERE key = ?").run(k).changes;
    } catch { /* no install_config_kv: nothing to scrub */ }
    return n;
  }

  /** First start of this build: move an existing database token to auth.bin, then remove it from the database. */
  function migrate(db) {
    let row = null;
    try { row = db.prepare("SELECT value FROM install_config_kv WHERE key = 'account_jwt' AND deleted_at IS NULL").get(); } catch { row = null; }
    const had = !!(row && row.value);
    if (had && !get()) set(row.value);
    const removed = scrubDb(db);
    if (had || removed) note("account-session-moved-out-of-database", { removed, stored: canEncrypt() ? "protected" : "memory" });
    return { moved: had, removed };
  }

  return { get, set, clear, has: () => !!get(), migrate, scrubDb, file, canEncrypt };
}

module.exports = { createAccountSession, SECRET_INSTALL_KEYS, FILE };
