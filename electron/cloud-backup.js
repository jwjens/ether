// electron/cloud-backup.js — Automated cloud disaster recovery backup.
//
// Phase 1.3f rewrite: customer no longer holds R2 credentials. Backup goes
// through the backend's signed-URL flow:
//   1. POST /backup/upload-url → { db_signed_url, meta_signed_url, expires_at }
//   2. PUT gzipped openair.db to db_signed_url   (Content-Type: application/gzip)
//   3. PUT metadata JSON to meta_signed_url      (Content-Type: application/json)
// Both PUTs must succeed; partial success is recorded as "incomplete_backup"
// with the failed half.
//
// Tier-gated: backup runs only if plan_tier is pro+ (Studio+ in pricing copy).
// Free tier never backs up — no-ops with "tier_insufficient" status.
//
// Backup frequency is configurable (default: every 6 hours). The
// r2Config.{accountId,endpoint,bucket,accessKeyId,secretAccessKey} fields
// remain in the shape for SettingsPanel UI compatibility but are no longer
// populated, read, or used — Phase 1.3h removes them entirely.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { ETHER_BACKEND_URL } = require('./lib/etherBackend');

// Local copy of usePlan.tsx's TIER_RANK. Renderer can't be imported from
// electron-main; keep in sync if PlanTier ever changes.
const TIER_RANK_LOCAL = { free: 0, pro: 1, pro_lifetime: 1, station: 2, station_lifetime: 2, operator: 3 };

// Resolves the LIVE db connection on every use. main.js passes its getDb() function, so a self-heal/
// restore reopen is picked up automatically (this module caches no prepared statements). Accepts a
// raw Database too (back-compat) by wrapping it.
let getDb = () => { throw new Error("[CLOUD-BACKUP] getDb not initialized"); };
let backupInterval = null;
let config = { endpoint: "", method: "PUT", intervalHours: 6, enabled: false, lastBackup: 0, lastStatus: "never" };

// Settings panel still reads/writes this shape; the credential fields stay in
// the structure but are never populated post-1.3f (1.3h removes them + the UI).
// NO `enabled` HERE ANY MORE (2026-09-11). It used to read `enabled: true`, and that literal is what
// armed the gate on every install: nothing loaded a stored value, so r2Ready() came back true on
// every launch no matter what the switch said. Jeff, 2026-09-11: "that's the thing that's been
// arming the gate all along." The files half is no longer a flag of its own.
let r2Config = { accountId: "", endpoint: "", bucket: "ether-backups", accessKeyId: "", secretAccessKey: "", intervalHours: 6, lastBackup: 0, lastStatus: "never" };

// ── THE FILES HALF IS NOT A SECOND FLAG ─────────────────────────────────────────────────────────
// It reads sync_enabled for the active station — the SAME key "Keep my stuff synced" writes. One
// flag, one writer, and the two halves cannot disagree because there is only one of them.
//
// The second flag failed three ways at once and this deletes all three: it was written by three
// callers, every write threw NOT NULL (station_config_kv needs station_id + uuid and the hand-rolled
// INSERT gave neither), and nothing read it back — so the only value that ever decided anything was
// the hardcoded default above. Reading the live key also means there is nothing to seed: an install
// that has never touched the switch is already correct, which a stored flag never was.
function activeStationId() {
  try { return getDb().prepare("SELECT id FROM stations WHERE is_active=1 LIMIT 1").get()?.id ?? null; }
  catch { return null; }
}
function filesHalfEnabled() {
  const sid = activeStationId();
  if (sid == null) return false;           // no active station = nothing to send
  try {
    const row = getDb().prepare(
      "SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'sync_enabled' AND deleted_at IS NULL"
    ).get(sid);
    return row?.value === "true";          // absent = off. An unset switch sends nothing.
  } catch { return false; }
}

// Backup-ready: enabled flag is true AND a license_key is set in KV AND the
// plan tier is pro+. Replaces the legacy r2Ready() which checked customer-side
// credentials; this version trusts the backend with R2 access.
function r2Ready() {
  if (!filesHalfEnabled()) return false;
  const licenseKey = getBackupLicenseKey();
  if (!licenseKey) return false;
  const planTier = getConfigValue("plan_tier") || "free";
  return (TIER_RANK_LOCAL[planTier] || 0) >= TIER_RANK_LOCAL.pro;
}

// Filename-safe ISO timestamp matching the backend's regex:
//   /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?$/
// Example: 2026-05-20T15:30:45.123Z → 2026-05-20T15-30-45Z
function isoTimestampForBackup(date) {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
}

// POST /backup/upload-url. Returns { db_signed_url, meta_signed_url, expires_at }
// or throws on any non-200 response. Caller maps the error to a history row.
async function requestBackupUploadUrls(licenseKey, timestamp) {
  const { default: fetch } = await import("node-fetch").catch(() => ({ default: global.fetch }));
  const res = await fetch(`${ETHER_BACKEND_URL}/backup/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ license_key: licenseKey, timestamp }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.db_signed_url || !data.meta_signed_url) {
    throw new Error(data.error || data.detail || `HTTP ${res.status}`);
  }
  return data;
}

// PUT to a signed URL. Body is Buffer; contentType must match what the
// caller intends to upload. Throws on non-2xx; resolves on success.
async function uploadToSignedUrl(url, body, contentType) {
  const { default: fetch } = await import("node-fetch").catch(() => ({ default: global.fetch }));
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

function installCloudBackup(ipcMain, database, opts = {}) {
  getDb = (typeof database === 'function') ? database : () => database;
  console.log("[CLOUD-BACKUP] db resolver type:", typeof database);
  const dbPath = opts.dbPath || "";
  _dbPath = dbPath;

  // Ensure config table entry
  // Scoped to the active station, because that is where saveConfig() writes it. The old unscoped
  // read would have picked an arbitrary station's row once rows started existing.
  try {
    const sid0 = activeStationId();
    if (sid0 != null) {
      const existing = getDb().prepare(
        "SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'cloud_backup_config' AND deleted_at IS NULL"
      ).get(sid0);
      if (existing?.value) config = { ...config, ...JSON.parse(existing.value) };
    }
  } catch {}

  // CREDENTIALS STAY UNLOADED. 1.3f moved R2 access to the backend and stopped reading customer keys
  // out of KV; that decision stands and nothing here re-reads accountId / accessKeyId /
  // secretAccessKey / endpoint / bucket.
  //
  // THE INTERVAL IS THE ONLY THING LEFT TO RESTORE. There is no stored on/off any more —
  // filesHalfEnabled() reads sync_enabled live, so it can never be stale and never needs seeding.
  // The interval keeps its own key, written through the sanctioned writer.
  try {
    const sid = activeStationId();
    if (sid != null) {
      const row = getDb().prepare(
        "SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'cloud_backup_interval_hours' AND deleted_at IS NULL"
      ).get(sid);
      const h = Number(row?.value);
      if (Number.isFinite(h) && h > 0) r2Config.intervalHours = h;
    }
  } catch (e) {
    console.warn("[CLOUD-BACKUP] could not read cloud_backup_interval_hours, keeping default:", e.message);
  }
  console.log("[CLOUD-BACKUP] backend-signed mode — credentials not loaded from KV; files half:",
              filesHalfEnabled() ? "on" : "off", "· interval:", r2Config.intervalHours + "h");

  // ── IPC handlers ──────────────────────────────────────────────

  ipcMain.handle("cloud-backup:get-config", () => config);

  // R2 config — secret is never sent back to the renderer in full
  ipcMain.handle("cloud-backup:get-r2-config", () => ({
    accountId:    r2Config.accountId,
    endpoint:     r2Config.endpoint,
    bucket:       r2Config.bucket,
    accessKeyId:  r2Config.accessKeyId,
    hasSecret:    !!r2Config.secretAccessKey,
    secretLast4:  r2Config.secretAccessKey ? r2Config.secretAccessKey.slice(-4) : "",
    // Answers from sync_enabled, live. This is the value Jeff reads in DevTools to check the switch.
    enabled:      filesHalfEnabled(),
    intervalHours: r2Config.intervalHours,
    lastBackup:   r2Config.lastBackup || 0,
    lastStatus:   r2Config.lastStatus || "never",
  }));

  // 1.3f: only enabled / intervalHours are honored. Customer-supplied credential
  // fields (accountId, accessKeyId, secretAccessKey, bucket, endpoint) are
  // accepted in the payload for UI compatibility but ignored — backend holds
  // the only R2 credentials now. 1.3h removes the credential UI entirely.
  // Sets the INTERVAL and nothing else. `enabled` is deliberately NOT read out of the payload — the
  // files half is sync_enabled, and this handler must never become a second way to set it.
  // It always RE-EVALUATES the timer from filesHalfEnabled(), so the one switch calling this right
  // after it writes sync_enabled starts or stops the schedule in the same session rather than at the
  // next launch.
  ipcMain.handle("cloud-backup:set-r2-config", (_evt, incoming = {}) => {
    const h = Number(incoming.intervalHours);
    if (Number.isFinite(h) && h > 0 && h !== r2Config.intervalHours) {
      r2Config.intervalHours = h;
      saveIntervalHours();
    }
    const on = filesHalfEnabled();
    console.log("[CLOUD-BACKUP] set-r2-config — files half:", on ? "on" : "off",
                "· r2Ready():", r2Ready(), "· interval:", r2Config.intervalHours + "h");
    if (on && r2Ready()) startAutoBackup(dbPath);
    else if (!on && !config.enabled) stopAutoBackup();
    return { ok: true, ready: r2Ready() };
  });

  // 1.3f: tests the backend connection (POST /backup/upload-url with a dummy
  // timestamp) instead of doing a direct R2 PutObject. Same IPC channel name
  // + return shape so SettingsPanel's "Test connection" button still works.
  // The returned signed URLs are discarded — this is a reachability check only.
  ipcMain.handle("cloud-backup:test-r2", async () => {
    const licenseKey = getBackupLicenseKey();
    if (!licenseKey) return { ok: false, error: "No license_key in station_config_kv — validate your license in Subscription first." };
    const planTier = getConfigValue("plan_tier") || "free";
    if ((TIER_RANK_LOCAL[planTier] || 0) < TIER_RANK_LOCAL.pro) {
      return { ok: false, error: `Cloud backup requires Studio (pro) tier or higher — current: ${planTier}` };
    }
    try {
      const timestamp = isoTimestampForBackup(new Date());
      const urls = await requestBackupUploadUrls(licenseKey, timestamp);
      // Got valid URLs; signing layer is reachable. Don't actually PUT anything.
      void urls;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("cloud-backup:set-config", (_evt, newConfig) => {
    config = { ...config, ...newConfig };
    saveConfig();   // was a second copy of the same hand-rolled INSERT that threw NOT NULL
    if (config.enabled) startAutoBackup(dbPath);
    else stopAutoBackup();
    return config;
  });

  ipcMain.handle("cloud-backup:run-now", async () => {
    return await runBackup(dbPath);
  });

  ipcMain.handle("cloud-backup:get-history", () => {
    try {
      const rows = getDb().prepare("SELECT * FROM cloud_backup_history ORDER BY backed_up_at DESC LIMIT 20").all();
      return rows;
    } catch { return []; }
  });

  // Ensure history table
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS cloud_backup_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT,
        size_bytes INTEGER,
        checksum TEXT,
        status TEXT,
        duration_ms INTEGER,
        backed_up_at INTEGER DEFAULT (unixepoch())
      );
    `);
  } catch {}

  // Auto-start if enabled
  if (config.enabled) {
    setTimeout(() => startAutoBackup(dbPath), 10000); // delay 10s after startup
  }

  console.log("[CLOUD-BACKUP] installed", { enabled: config.enabled, intervalHours: config.intervalHours });
}

// ── Backup execution ─────────────────────────────────────────

async function runBackup(dbPath) {
  const startTime = Date.now();
  try {
    // 1. Tier gate — backup is a pro+ (Studio+) feature
    const planTier = getConfigValue("plan_tier") || "free";
    if ((TIER_RANK_LOCAL[planTier] || 0) < TIER_RANK_LOCAL.pro) {
      const msg = `backup requires Studio (pro) tier or higher — current: ${planTier}`;
      config.lastStatus = "skipped: " + msg;
      saveConfig();
      console.log(`[CLOUD-BACKUP] ${msg}`);
      return { ok: false, error: msg, tier_insufficient: true };
    }

    // 2. License key required (set during onboarding / SubscriptionPanel validate)
    const licenseKey = getBackupLicenseKey();
    if (!licenseKey) {
      const msg = "no license_key in station_config_kv";
      config.lastStatus = "skipped: " + msg;
      saveConfig();
      console.log(`[CLOUD-BACKUP] ${msg}`);
      return { ok: false, error: msg };
    }

    // 3. Snapshot the database — CONSISTENTLY.
    //
    // This used to be `fs.readFileSync(dbPath)`: a raw read of openair.db with no WAL checkpoint.
    // Ether runs SQLite in WAL mode, so committed transactions — including schema changes — live in
    // openair.db-wal until a checkpoint. Reading the main file alone therefore produced a backup that
    // was (a) ALWAYS missing whatever was in the WAL (18 MB on Jeff's install when this was measured),
    // and (b) intermittently structurally invalid, because sqlite_master could be captured mid-write.
    // That is what made a restore fail with "malformed database schema" and roll back.
    //
    // db.backup() is SQLite's ONLINE backup API: a consistent, self-contained snapshot taken safely
    // while the database is in use, WAL content included. No checkpoint race, nothing missing.
    // A checkpoint-then-read was considered and rejected — a write between the two reopens the tear.
    // docs/cloud-backup-torn-wal-2026-08-07.md
    if (!dbPath || !fs.existsSync(dbPath)) {
      throw new Error("Database file not found: " + dbPath);
    }
    const snapPath = dbPath + ".backup-snapshot";
    try { fs.rmSync(snapPath, { force: true }); } catch {}
    try {
      await getDb().backup(snapPath);
    } catch (e) {
      throw new Error(`consistent snapshot failed (backup aborted rather than upload a torn file): ${e.message}`);
    }
    // Verify the snapshot OPENS and reads before it is ever uploaded. A backup nobody can restore is
    // worse than no backup — it is a promise that fails on the day it matters.
    try {
      const Database = require('better-sqlite3');
      const probe = new Database(snapPath, { readonly: true, fileMustExist: true });
      const songs = probe.prepare("SELECT COUNT(*) AS n FROM songs").get().n;
      const integrity = probe.prepare("PRAGMA integrity_check").get().integrity_check;
      probe.close();
      if (integrity !== 'ok') throw new Error(`integrity_check said "${integrity}"`);
      console.log(`[CLOUD-BACKUP] snapshot verified — ${songs} songs, integrity ok`);
    } catch (e) {
      try { fs.rmSync(snapPath, { force: true }); } catch {}
      throw new Error(`snapshot failed verification, not uploading: ${e.message}`);
    }
    const dbData = fs.readFileSync(snapPath);
    try { fs.rmSync(snapPath, { force: true }); } catch {}

    // 4. Gzip the DB
    const gzippedDb = zlib.gzipSync(dbData, { level: 6 });
    const checksum  = crypto.createHash("sha256").update(gzippedDb).digest("hex").slice(0, 16);

    // 5. Build metadata sidecar
    const timestamp = isoTimestampForBackup(new Date());
    const metadata  = {
      stationName:      getConfigValue("station_name") || "Ether Station",
      backedUpAt:       new Date().toISOString(),
      timestamp,                              // matches the R2 key
      dbSizeBytes:      dbData.length,
      gzippedSizeBytes: gzippedDb.length,
      checksum,
      tables:           getTableStats(),
      version:          "2.0",                // bump from 1.0 — separate .db.gz + .meta.json instead of combined package
    };
    const metaJson = Buffer.from(JSON.stringify(metadata, null, 2), "utf8");

    // 6. Request the dual signed URLs (backend signs both atomically; see Phase 1.3e amendment d24bf11)
    let urls;
    try {
      urls = await requestBackupUploadUrls(licenseKey, timestamp);
    } catch (e) {
      throw new Error("Could not get backup upload URLs: " + e.message);
    }

    // 7. Upload both halves. Each PUT is independent; we attempt both even if
    //    one fails so the failure status can record exactly which half broke.
    let dbErr = null, metaErr = null;
    try { await uploadToSignedUrl(urls.db_signed_url,   gzippedDb, "application/gzip"); }
    catch (e) { dbErr = e.message; }
    try { await uploadToSignedUrl(urls.meta_signed_url, metaJson,  "application/json"); }
    catch (e) { metaErr = e.message; }

    const durationMs = Date.now() - startTime;

    // 8. Partial-success path
    if (dbErr || metaErr) {
      const failedHalves = [
        dbErr   ? `db PUT failed (${dbErr})`     : null,
        metaErr ? `meta PUT failed (${metaErr})` : null,
      ].filter(Boolean).join("; ");
      const status = "incomplete_backup: " + failedHalves;
      config.lastStatus = "error: " + status;
      saveConfig();
      try {
        getDb().prepare("INSERT INTO cloud_backup_history (endpoint, size_bytes, checksum, status, duration_ms) VALUES (?,?,?,?,?)")
          .run("r2 (backend-signed)", gzippedDb.length, checksum, status, durationMs);
      } catch {}
      console.error(`[CLOUD-BACKUP] ${status}`);
      return { ok: false, error: status, partial: true };
    }

    // 9. Both PUTs succeeded
    config.lastBackup   = Math.floor(Date.now() / 1000);
    config.lastStatus   = "success";
    r2Config.lastBackup = config.lastBackup;
    r2Config.lastStatus = "success";
    saveConfig();
    // saveR2Config() was here and threw ReferenceError on every SUCCESSFUL backup (OV, 4.6.24):
    // 873aab4 renamed it to saveIntervalHours() and updated the set-r2-config caller but not this
    // one. The throw landed in runBackup's outer catch, which recorded a FAILED history row for a
    // backup whose two PUTs had both succeeded, and made run-now return ok:false — so the caller
    // returned early and the AUDIO half never ran. Nothing replaces it: r2Config.lastBackup and
    // lastStatus are in-memory only under Option A, and saveConfig() above persists the record.
    try {
      getDb().prepare("INSERT INTO cloud_backup_history (endpoint, size_bytes, checksum, status, duration_ms) VALUES (?,?,?,?,?)")
        .run("r2 (backend-signed)", gzippedDb.length, checksum, "success", durationMs);
    } catch {}
    console.log(`[CLOUD-BACKUP] Success: ${(gzippedDb.length / 1024).toFixed(1)}KB + meta in ${durationMs}ms (ts=${timestamp}, ${checksum})`);
    return { ok: true, size: gzippedDb.length, checksum, durationMs };
  } catch (e) {
    config.lastStatus = "error: " + e.message;
    saveConfig();
    try {
      getDb().prepare("INSERT INTO cloud_backup_history (endpoint, size_bytes, checksum, status, duration_ms) VALUES (?,?,?,?,?)")
        .run("r2 (backend-signed)", 0, "", "error: " + e.message, Date.now() - startTime);
    } catch {}
    console.error("[CLOUD-BACKUP] Failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// ── Helpers ──────────────────────────────────────────────────

function getConfigValue(key) {
  try {
    const row = getDb().prepare("SELECT value FROM station_config_kv WHERE key = ?").get(key);
    return row?.value || null;
  } catch { return null; }
}

// The cloud backup is the whole DB, but it BELONGS to the signed-in ACCOUNT. station_config_kv is
// keyed by (station_id, key), so a bare `SELECT value ... WHERE key='license_key'` grabs an ARBITRARY
// station's license — on a multi-license install that can be the wrong one, and the backup then lands
// under an R2 prefix the operator never restores from (this is exactly what happened: backups went to
// license 2 while the account restores under license 19). Resolve the ACTIVE station's owner license —
// the account context the operator is actually working in — so backup and restore share one license.
// Universal: on a clean single-account install every station shares the same owner license, so this is
// identical to the old behavior; it only DISAMBIGUATES the multi-license case.
function getBackupLicenseKey() {
  try {
    const row = getDb().prepare(
      "SELECT owner_license_key AS k FROM stations WHERE is_active = 1 AND deleted_at IS NULL AND owner_license_key IS NOT NULL AND owner_license_key != '' LIMIT 1"
    ).get();
    if (row?.k) return String(row.k).trim();
  } catch {}
  return getConfigValue('license_key');   // single-quoted on purpose — see replace note below
}

function getTableStats() {
  const tables = ["songs", "artists", "shows", "clocks", "spots", "voice_tracks", "play_log", "macros"];
  const stats = {};
  for (const t of tables) {
    try {
      const row = getDb().prepare(`SELECT COUNT(*) as c FROM ${t}`).get();
      stats[t] = row?.c || 0;
    } catch { stats[t] = 0; }
  }
  return stats;
}

// cloud_backup_config is THIS MACHINE'S bookkeeping — lastBackup, lastStatus, the legacy endpoint.
// It goes through stationConfigKvSetLocal, not the synced writer: syncing "when I last backed up"
// would let one install overwrite another's record of its own work, which is the reason
// sweep_last_run is local-only too. The key is in LOCAL_ONLY_KEYS so the synced path refuses it.
//
// It also used to hand-roll the same INSERT that omitted station_id and uuid, so like the R2 row it
// threw on every call and the row never existed — which is why cloud_backup_config was missing on
// the live install alongside cloud_backup_r2.
function saveConfig() {
  try {
    const sid = activeStationId();
    if (sid == null) return;
    const { stationConfigKvSetLocal } = require('./sync/handlers/station_config_kv');
    stationConfigKvSetLocal(getDb(), sid, 'cloud_backup_config', JSON.stringify(config));
  } catch (e) { console.warn("[CLOUD-BACKUP] saveConfig failed:", e.message); }
}

// saveR2Config -> saveIntervalHours (2026-09-11). The old one hand-rolled
//   INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('cloud_backup_r2', ?)
// which omits station_id (INTEGER NOT NULL, PK) and uuid (TEXT NOT NULL). It threw
// SQLITE_CONSTRAINT_NOTNULL on every call, reported through console.error — discarded by a packaged
// build — so the row NEVER existed. Same defect as the designation upsert bug. The sanctioned writer
// generates the uuid and requires the station id, so it cannot be written wrong.
//
// There is no on/off to save any more: the files half is sync_enabled, written by the one switch.
function saveIntervalHours() {
  let _db = null;
  try { _db = getDb(); } catch { _db = null; }
  if (!_db || !_db.open) {
    console.warn("[CLOUD-BACKUP] db not ready, skipping interval save — will retry in 2s");
    setTimeout(() => saveIntervalHours(), 2000);
    return;
  }
  const sid = activeStationId();
  if (sid == null) { console.warn("[CLOUD-BACKUP] no active station — interval not saved"); return; }
  try {
    const { stationConfigKvUpsertByKey } = require('./sync/handlers/station_config_kv');
    stationConfigKvUpsertByKey(_db, sid, 'cloud_backup_interval_hours', String(r2Config.intervalHours));
    console.log("[CLOUD-BACKUP] interval saved —", r2Config.intervalHours + "h for station", sid);
  } catch (e) {
    console.error("[CLOUD-BACKUP] FAILED to save interval:", e.message);
  }
}

// ── Auto-backup ──────────────────────────────────────────────

function startAutoBackup(dbPath) {
  stopAutoBackup();
  const hours = r2Config.intervalHours || config.intervalHours || 6;
  console.log(`[CLOUD-BACKUP] Auto-backup every ${hours}h via backend-signed R2`);
  backupInterval = setInterval(() => runBackup(dbPath), hours * 3600 * 1000);
}

function stopAutoBackup() {
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null; }
}

// Called by main.js after a successful local backup_db copy. Fires a full
// backend-signed R2 upload if enabled + license_key set + tier >= pro.
// Returns a result object; never throws — caller can fire-and-forget.
async function triggerUpload() {
  console.log("[CLOUD-BACKUP:triggerUpload] called");
  console.log("[CLOUD-BACKUP:triggerUpload] files half (sync_enabled) =", filesHalfEnabled());
  console.log("[CLOUD-BACKUP:triggerUpload] r2Ready()        =", r2Ready(), "(enabled + license_key + tier>=pro)");
  console.log("[CLOUD-BACKUP:triggerUpload] _dbPath          =", _dbPath || "(empty)");
  if (!r2Ready()) {
    console.log("[CLOUD-BACKUP:triggerUpload] skipping — r2Ready() is false");
    return { skipped: true };
  }
  if (!_dbPath) {
    console.log("[CLOUD-BACKUP:triggerUpload] skipping — _dbPath not set");
    return { skipped: true };
  }
  return runBackup(_dbPath);
}

let _dbPath = "";

// Legacy export — consumed by main.js:3098 (r2:fetch-track) and main.js:3738
// (library:sync-r2:upload). Both are migrated in Phase 1.3i / 1.3g respectively.
// Post-1.3f the credential fields are always empty strings; the legacy callers
// already null-check and fall through to "R2 not configured" cleanly. Kept in
// shape (with the resolvedEndpoint field) so neither call site needs a coordinated
// change before its own migration commit.
function getR2Config() {
  return {
    accountId:       r2Config.accountId,
    endpoint:        r2Config.endpoint,
    bucket:          r2Config.bucket,
    accessKeyId:     r2Config.accessKeyId,
    secretAccessKey: r2Config.secretAccessKey,
    resolvedEndpoint: "",
  };
}

// filesHalfEnabled is exported so the catalogue PULL timer in main.js asks the same question this
// module asks — "is Keep my stuff synced on for the active station". A second copy of that test in
// main.js is how the files half grew three writers in the first place. One definition, two callers.
module.exports = { installCloudBackup, triggerUpload, getR2Config, filesHalfEnabled };
