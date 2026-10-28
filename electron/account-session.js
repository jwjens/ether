// electron/account-session.js — WHERE THE ACCOUNT SIGN-IN IS KEPT (docs/account-sign-in-plan-2026-10-26.md, Phases 0-1).
//
// Jeff, 2026-10-28: "Phase 0 first: the sign-in token out of the database and backups."
// The sign-in token used to live in install_config_kv.account_jwt, plain text inside openair.db — and so inside every
// local and cloud backup (whole-database copies). It now lives ONLY in <profile>\auth.bin, encrypted with Electron's
// safeStorage (Windows: DPAPI, bound to this Windows user; macOS: Keychain): outside the database, in no backup, and
// useless if the profile folder is copied to another computer or Windows user. Never a plaintext fallback: with no
// safeStorage it is kept in memory for this run only.
//
// PHASE 1 (sessions): what is kept is the session's REFRESH token ({ v: 2, refresh } in auth.bin); the short PASS (access
// token) lives in memory only and is renewed by electron/account-renewer.js. A file from Phase 0 (one old 12 h pass) is
// still read, and is swapped once for a session while it is valid. "Remember me" off: the session is kept in memory only.
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

/** A JWT's expiry (ms), or null. */
function jwtExpiry(token) {
  try { const p = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")); return p.exp ? p.exp * 1000 : null; }
  catch { return null; }
}

/**
 * @param {object} o
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} o.safeStorage
 * @param {() => string} o.dir   the active profile's folder (the folder openair.db is in) — read at every call, so a
 *                               profile switch reads that profile's sign-in
 * @param {object} [o.fs]
 * @param {(event: string, detail?: object) => void} [o.note]  health ledger
 * @param {() => number} [o.now]
 */
function createAccountSession({ safeStorage, dir, fs = require("fs"), note = () => {}, now = () => Date.now() }) {
  // profile dir → { refresh, legacy, access, accessExp, persisted }
  const mem = new Map();
  const file = () => path.join(dir(), FILE);
  const canEncrypt = () => { try { return !!safeStorage && safeStorage.isEncryptionAvailable(); } catch { return false; } };

  function load() {
    const d = dir();
    if (mem.has(d)) return mem.get(d);
    const st = { refresh: null, legacy: null, access: null, accessExp: 0, persisted: false };
    try {
      if (canEncrypt() && fs.existsSync(file())) {
        const bytes = fs.readFileSync(file());
        const raw = bytes.length ? (safeStorage.decryptString(bytes) || "") : "";
        st.persisted = raw.length > 0;   // an empty file = signed out (a delete Windows refused)
        if (raw.startsWith("{")) { const j = JSON.parse(raw); if (j && j.v === 2) st.refresh = j.refresh || null; }
        else if (raw) st.legacy = raw;   // Phase 0: one old pass
      }
    } catch (e) { note("account-session-unreadable", { reason: String(e && e.message || e) }); }
    mem.set(d, st);
    return st;
  }
  function persist(st, remember) {
    if (!remember || !canEncrypt()) {
      if (remember && !canEncrypt()) note("account-session-memory-only", { reason: "this computer's protected storage is unavailable" });
      try { fs.rmSync(file(), { force: true }); } catch { try { fs.writeFileSync(file(), Buffer.alloc(0)); } catch {} }
      st.persisted = false;
      return remember && !canEncrypt() ? "memory" : (remember ? "protected" : "memory");
    }
    const body = st.refresh ? JSON.stringify({ v: 2, refresh: st.refresh }) : (st.legacy || "");
    const enc = safeStorage.encryptString(body);
    // Windows can refuse to replace a file someone holds for a moment (antivirus, the indexer): retry briefly, then write
    // in place. If it still cannot be saved, the sign-in stays in memory for this run — renewal is never stopped by a disk.
    const tmp = `${file()}.tmp`;
    try {
      fs.writeFileSync(tmp, enc);
      let done = false;
      for (let i = 0; i < 5 && !done; i++) {
        try { fs.renameSync(tmp, file()); done = true; }
        catch (e) { if (!/EPERM|EBUSY|EACCES/.test(String(e && e.code))) throw e; const until = Date.now() + 20; while (Date.now() < until) { /* brief wait */ } }
      }
      if (!done) { fs.writeFileSync(file(), enc); try { fs.rmSync(tmp, { force: true }); } catch {} }
    } catch (e) {
      note("account-session-not-saved", { reason: String(e && e.message || e) });
      st.persisted = false;
      return "memory";
    }
    st.persisted = true;
    return "protected";
  }

  /** A usable pass for an account request right now, or null (expired, or none). */
  function get() {
    const st = load();
    if (st.access && st.accessExp - now() > 30 * 1000) return st.access;
    if (st.legacy) { const exp = jwtExpiry(st.legacy); if (!exp || exp - now() > 30 * 1000) return st.legacy; }
    return null;
  }

  /** Phase 0 path: one pass (an older backend that returns no session). */
  function set(token, { remember = true } = {}) {
    const t = token ? String(token) : null;
    if (!t) return clear();
    const st = load();
    st.legacy = t; st.refresh = null; st.access = null; st.accessExp = 0;
    return { ok: true, stored: persist(st, remember) };
  }

  /** A session from sign-in, upgrade or renewal: the refresh token is kept, the pass held in memory. */
  function setSession(s, { remember } = {}) {
    if (!s || !s.refresh_token) return { ok: false, error: "no session" };
    const st = load();
    // A renewal keeps how the session was kept; a new sign-in is remembered unless the user unticked Remember me.
    const keep = remember !== undefined ? !!remember : ((st.refresh || st.legacy) ? st.persisted : true);
    st.refresh = String(s.refresh_token); st.legacy = null;
    st.access = s.access_token ? String(s.access_token) : null;
    st.accessExp = st.access ? (jwtExpiry(st.access) || now() + (Number(s.access_expires_in) || 900) * 1000) : 0;
    return { ok: true, stored: persist(st, keep) };
  }

  /** The session's refresh token (for renewal and Sign Out), or null. */
  function refreshToken() { return load().refresh; }
  /** An old pass waiting to be swapped for a session (Phase 0 file), if still valid. */
  function legacyToken() { const st = load(); if (!st.legacy) return null; const exp = jwtExpiry(st.legacy); return !exp || exp > now() ? st.legacy : null; }
  /** When the current pass expires (ms), 0 if none. */
  function accessExpiresAt() { return load().accessExp || 0; }

  /** Has this computer been signed in (a session or an old pass is kept, valid or not)? "Set up" for start-up. */
  function isSetUp() { const st = load(); return !!(st.refresh || st.legacy || st.persisted); }

  /** The session can no longer be renewed (password changed, offline limit…): keep "set up", drop what is dead. */
  function markDead() { const st = load(); st.access = null; st.accessExp = 0; st.legacy = null; return true; }

  function clear() {
    mem.set(dir(), { refresh: null, legacy: null, access: null, accessExp: 0, persisted: false });
    // Sign Out must not leave a sign-in on disk. Windows can refuse a delete for a moment (antivirus, the indexer):
    // retry, then overwrite the file with nothing (an empty auth.bin reads as "not signed in").
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(file(), { force: true }); return { ok: true }; }
      catch (e) { if (!/EPERM|EBUSY|EACCES/.test(String(e && e.code))) break; const until = Date.now() + 20; while (Date.now() < until) { /* brief wait */ } }
    }
    try { fs.writeFileSync(file(), Buffer.alloc(0)); } catch (e) { note("account-session-not-cleared", { reason: String(e && e.message || e) }); }
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
    if (had && !isSetUp()) set(row.value);
    const removed = scrubDb(db);
    if (had || removed) note("account-session-moved-out-of-database", { removed, stored: canEncrypt() ? "protected" : "memory" });
    return { moved: had, removed };
  }

  return { get, set, setSession, refreshToken, legacyToken, accessExpiresAt, isSetUp, markDead, clear,
           has: () => !!get(), migrate, scrubDb, file, canEncrypt };
}

module.exports = { createAccountSession, SECRET_INSTALL_KEYS, FILE, jwtExpiry };
