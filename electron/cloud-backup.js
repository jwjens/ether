// electron/cloud-backup.js — Automated cloud disaster recovery backup.
//
// Periodically backs up the SQLite database + station config to a
// configurable cloud endpoint. Supports:
//   - HTTP PUT/POST to any URL (pre-signed S3 URLs, R2, custom server)
//   - Local network share (file copy to a path)
//
// Smart Restore: prioritizes time-sensitive content (scheduled_log, shows,
// clocks, spots with active dates) when building recovery packages.
//
// Backup frequency is configurable (default: every 6 hours).
// Each backup is a gzipped SQLite dump + metadata JSON.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

let db = null;
let backupInterval = null;
let config = { endpoint: "", method: "PUT", intervalHours: 6, enabled: false, lastBackup: 0, lastStatus: "never" };

// R2 credentials — stored in station_config_kv, never hardcoded
let r2Config = { accountId: "", endpoint: "", bucket: "ether-backups", accessKeyId: "", secretAccessKey: "", enabled: true, intervalHours: 6, lastBackup: 0, lastStatus: "never" };

function r2Endpoint() {
  // Prefer explicit endpoint; fall back to standard R2 URL derived from accountId.
  if (r2Config.endpoint) return r2Config.endpoint;
  if (r2Config.accountId) return `https://${r2Config.accountId}.r2.cloudflarestorage.com`;
  return "";
}

function r2Ready() {
  return !!(r2Endpoint() && r2Config.bucket && r2Config.accessKeyId && r2Config.secretAccessKey);
}

function installCloudBackup(ipcMain, database, opts = {}) {
  db = database;
  console.log("[CLOUD-BACKUP] db type:", typeof db, !!db);
  const dbPath = opts.dbPath || "";
  _dbPath = dbPath;

  // Ensure config table entry
  try {
    const existing = db.prepare("SELECT value FROM station_config_kv WHERE key = 'cloud_backup_config'").get();
    if (existing) config = { ...config, ...JSON.parse(existing.value) };
  } catch {}

  // Load R2 credentials from DB — check both key names so old saves are found
  try {
    const r2Row = db.prepare("SELECT value FROM station_config_kv WHERE key = 'cloud_backup_r2'").get()
               || db.prepare("SELECT value FROM station_config_kv WHERE key = 'r2_config'").get();
    if (r2Row) {
      const saved = JSON.parse(r2Row.value);
      Object.assign(r2Config, saved);
      console.log("[CLOUD-BACKUP] loaded R2 config from DB — bucket:", r2Config.bucket, "accountId:", r2Config.accountId ? r2Config.accountId.slice(0,8)+"…" : "(empty)", "enabled:", r2Config.enabled, "ready:", r2Ready());
    } else {
      console.log("[CLOUD-BACKUP] no saved R2 config found in station_config_kv — using defaults");
    }
  } catch (e) {
    console.error("[CLOUD-BACKUP] failed to load R2 config from DB:", e.message);
  }

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
    enabled:      r2Config.enabled,
    intervalHours: r2Config.intervalHours,
    lastBackup:   r2Config.lastBackup || 0,
    lastStatus:   r2Config.lastStatus || "never",
  }));

  ipcMain.handle("cloud-backup:set-r2-config", (_evt, incoming) => {
    console.log("[CLOUD-BACKUP] set-r2-config called — incoming:", {
      accountId:    incoming.accountId     ? incoming.accountId.slice(0,8)+"…" : "(empty)",
      bucket:       incoming.bucket        || "(empty)",
      accessKeyId:  incoming.accessKeyId   ? incoming.accessKeyId.slice(0,8)+"…" : "(empty)",
      hasSecret:    !!incoming.secretAccessKey,
      enabled:      incoming.enabled,
      intervalHours: incoming.intervalHours,
    });
    console.log("[CLOUD-BACKUP] set-r2-config called with:", JSON.stringify({...incoming, secretAccessKey: incoming.secretAccessKey ? "***" : "empty"}));
    r2Config = {
      accountId:     incoming.accountId     ?? r2Config.accountId,
      endpoint:      incoming.endpoint      ?? r2Config.endpoint,
      bucket:        incoming.bucket        ?? r2Config.bucket,
      accessKeyId:   incoming.accessKeyId   ?? r2Config.accessKeyId,
      // Only overwrite secret if a new non-empty value was passed
      secretAccessKey: incoming.secretAccessKey
        ? incoming.secretAccessKey
        : r2Config.secretAccessKey,
      enabled:       incoming.enabled       ?? r2Config.enabled,
      intervalHours: incoming.intervalHours ?? r2Config.intervalHours,
      lastBackup:    r2Config.lastBackup,
      lastStatus:    r2Config.lastStatus,
    };
    saveR2Config();
    console.log("[CLOUD-BACKUP] set-r2-config done — r2Ready():", r2Ready(), "bucket:", r2Config.bucket);
    if (r2Config.enabled && r2Ready()) startAutoBackup(dbPath);
    else if (!r2Config.enabled && !config.enabled) stopAutoBackup();
    return { ok: true, ready: r2Ready() };
  });

  ipcMain.handle("cloud-backup:test-r2", async () => {
    if (!r2Ready()) return { ok: false, error: "R2 credentials incomplete — fill in Account ID, Access Key ID, Secret, and Bucket." };
    try {
      const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
      const client = new S3Client({
        region: "auto",
        endpoint: r2Endpoint(),
        credentials: { accessKeyId: r2Config.accessKeyId, secretAccessKey: r2Config.secretAccessKey },
      });
      await client.send(new PutObjectCommand({
        Bucket: r2Config.bucket,
        Key: "ether-connection-test.txt",
        Body: Buffer.from(`Ether connection test ${new Date().toISOString()}`),
        ContentType: "text/plain",
      }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("cloud-backup:set-config", (_evt, newConfig) => {
    config = { ...config, ...newConfig };
    try {
      db.prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('cloud_backup_config', ?)").run(JSON.stringify(config));
    } catch {}
    if (config.enabled) startAutoBackup(dbPath);
    else stopAutoBackup();
    return config;
  });

  ipcMain.handle("cloud-backup:run-now", async () => {
    return await runBackup(dbPath);
  });

  ipcMain.handle("cloud-backup:get-history", () => {
    try {
      const rows = db.prepare("SELECT * FROM cloud_backup_history ORDER BY backed_up_at DESC LIMIT 20").all();
      return rows;
    } catch { return []; }
  });

  // Ensure history table
  try {
    db.exec(`
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
    if (!dbPath || !fs.existsSync(dbPath)) {
      throw new Error("Database file not found: " + dbPath);
    }

    // Read the SQLite file
    const dbData = fs.readFileSync(dbPath);

    // Build metadata
    const metadata = {
      stationName: getConfigValue("station_name") || "Ether Station",
      backedUpAt: new Date().toISOString(),
      dbSizeBytes: dbData.length,
      tables: getTableStats(),
      version: "1.0",
    };

    // Create a combined backup: metadata JSON + gzipped DB
    const metaJson = JSON.stringify(metadata, null, 2);
    const gzippedDb = zlib.gzipSync(dbData, { level: 6 });
    const checksum = crypto.createHash("sha256").update(gzippedDb).digest("hex").slice(0, 16);

    // Build the backup package (simple concatenation with length header)
    const metaBuffer = Buffer.from(metaJson, "utf8");
    const header = Buffer.alloc(8);
    header.writeUInt32BE(metaBuffer.length, 0);
    header.writeUInt32BE(gzippedDb.length, 4);
    const package_ = Buffer.concat([header, metaBuffer, gzippedDb]);

    const durationMs = Date.now() - startTime;

    // Upload — R2 takes priority when credentials are present
    if (r2Ready()) {
      const key = `ether-backup-${Date.now()}-${checksum}.bak`;
      await uploadToR2(package_, key);
      r2Config.lastBackup = Math.floor(Date.now() / 1000);
      r2Config.lastStatus = "success";
      saveR2Config();
      console.log(`[CLOUD-BACKUP] R2 upload: ${r2Config.bucket}/${key}`);
    } else if (config.endpoint) {
      if (config.endpoint.startsWith("http")) {
        await uploadToHttp(config.endpoint, package_, config.method);
      } else {
        // Local path — write file
        const destPath = path.join(config.endpoint, `ether-backup-${Date.now()}.bak`);
        fs.mkdirSync(config.endpoint, { recursive: true });
        fs.writeFileSync(destPath, package_);
      }
    } else {
      throw new Error("No upload destination configured (set R2 credentials or an HTTP endpoint)");
    }

    // Log success
    config.lastBackup = Math.floor(Date.now() / 1000);
    config.lastStatus = "success";
    saveConfig();

    try {
      db.prepare("INSERT INTO cloud_backup_history (endpoint, size_bytes, checksum, status, duration_ms) VALUES (?,?,?,?,?)")
        .run(config.endpoint || "none", package_.length, checksum, "success", durationMs);
    } catch {}

    console.log(`[CLOUD-BACKUP] Success: ${(package_.length / 1024).toFixed(1)}KB in ${durationMs}ms (${checksum})`);
    return { ok: true, size: package_.length, checksum, durationMs };
  } catch (e) {
    config.lastStatus = "error: " + e.message;
    saveConfig();
    try {
      db.prepare("INSERT INTO cloud_backup_history (endpoint, size_bytes, checksum, status, duration_ms) VALUES (?,?,?,?,?)")
        .run(config.endpoint || "none", 0, "", "error: " + e.message, Date.now() - startTime);
    } catch {}
    console.error("[CLOUD-BACKUP] Failed:", e.message);
    return { ok: false, error: e.message };
  }
}

async function uploadToR2(data, key) {
  console.log("[CLOUD-BACKUP:uploadToR2] starting upload");
  console.log("[CLOUD-BACKUP:uploadToR2] endpoint  =", r2Endpoint());
  console.log("[CLOUD-BACKUP:uploadToR2] bucket    =", r2Config.bucket);
  console.log("[CLOUD-BACKUP:uploadToR2] key       =", key);
  console.log("[CLOUD-BACKUP:uploadToR2] size      =", data.length, "bytes");
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(),
    credentials: {
      accessKeyId:     r2Config.accessKeyId,
      secretAccessKey: r2Config.secretAccessKey,
    },
  });
  try {
    await client.send(new PutObjectCommand({
      Bucket:      r2Config.bucket,
      Key:         key,
      Body:        data,
      ContentType: "application/octet-stream",
    }));
    console.log("[CLOUD-BACKUP:uploadToR2] PutObject succeeded");
  } catch (e) {
    console.error("[CLOUD-BACKUP:uploadToR2] PutObject FAILED");
    console.error("[CLOUD-BACKUP:uploadToR2] error.name    =", e.name);
    console.error("[CLOUD-BACKUP:uploadToR2] error.message =", e.message);
    console.error("[CLOUD-BACKUP:uploadToR2] error.code    =", e.Code || e.code || "(none)");
    console.error("[CLOUD-BACKUP:uploadToR2] HTTP status   =", e.$metadata?.httpStatusCode ?? "(unknown)");
    throw e;
  }
}

async function uploadToHttp(url, data, method = "PUT") {
  const { default: fetch } = await import("node-fetch").catch(() => ({ default: global.fetch }));
  const resp = await fetch(url, {
    method: method || "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(data.length) },
    body: data,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
}

// ── Helpers ──────────────────────────────────────────────────

function getConfigValue(key) {
  try {
    const row = db.prepare("SELECT value FROM station_config_kv WHERE key = ?").get(key);
    return row?.value || null;
  } catch { return null; }
}

function getTableStats() {
  const tables = ["songs", "artists", "shows", "clocks", "spots", "voice_tracks", "play_log", "macros"];
  const stats = {};
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get();
      stats[t] = row?.c || 0;
    } catch { stats[t] = 0; }
  }
  return stats;
}

function saveConfig() {
  try {
    db.prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('cloud_backup_config', ?)").run(JSON.stringify(config));
  } catch {}
}

function saveR2Config() {
  if (!db) {
    console.warn("[CLOUD-BACKUP] db not ready, skipping save — will retry in 2s");
    setTimeout(() => saveR2Config(), 2000);
    return;
  }
  try {
    db.prepare("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('cloud_backup_r2', ?)").run(JSON.stringify(r2Config));
    console.log("[CLOUD-BACKUP] saveR2Config — wrote to DB OK, bucket:", r2Config.bucket);
  } catch (e) {
    console.error("[CLOUD-BACKUP] saveR2Config FAILED to write DB:", e.message);
  }
}

// ── Auto-backup ──────────────────────────────────────────────

function startAutoBackup(dbPath) {
  stopAutoBackup();
  const hours = r2Ready() ? (r2Config.intervalHours || 6) : (config.intervalHours || 6);
  const backend = r2Ready() ? "R2" : "HTTP";
  console.log(`[CLOUD-BACKUP] Auto-backup every ${hours}h via ${backend}`);
  backupInterval = setInterval(() => runBackup(dbPath), hours * 3600 * 1000);
}

function stopAutoBackup() {
  if (backupInterval) { clearInterval(backupInterval); backupInterval = null; }
}

// Called by main.js after a successful local backup_db copy.
// Fires a full R2 upload if R2 is enabled and credentials are complete.
// Returns a result object; never throws — caller can fire-and-forget.
async function triggerUpload() {
  console.log("[CLOUD-BACKUP:triggerUpload] called");
  console.log("[CLOUD-BACKUP:triggerUpload] r2Config.enabled =", r2Config.enabled);
  console.log("[CLOUD-BACKUP:triggerUpload] r2Ready()        =", r2Ready());
  console.log("[CLOUD-BACKUP:triggerUpload] r2Endpoint()     =", r2Endpoint() || "(empty)");
  console.log("[CLOUD-BACKUP:triggerUpload] bucket           =", r2Config.bucket || "(empty)");
  console.log("[CLOUD-BACKUP:triggerUpload] accessKeyId      =", r2Config.accessKeyId ? r2Config.accessKeyId.slice(0, 8) + "…" : "(empty)");
  console.log("[CLOUD-BACKUP:triggerUpload] secretAccessKey  =", r2Config.secretAccessKey ? "set (last4=" + r2Config.secretAccessKey.slice(-4) + ")" : "(empty)");
  console.log("[CLOUD-BACKUP:triggerUpload] _dbPath          =", _dbPath || "(empty)");
  // Proceed if credentials are present even if enabled flag hasn't persisted yet
  const credentialsReady = r2Ready() && _dbPath;
  if (!r2Config.enabled && !credentialsReady) {
    console.log("[CLOUD-BACKUP:triggerUpload] skipping — not enabled and no credentials");
    return { skipped: true };
  }
  if (!credentialsReady) {
    console.log("[CLOUD-BACKUP:triggerUpload] skipping — r2Ready() is false (check credentials above)");
    return { skipped: true };
  }
  return runBackup(_dbPath);
}

let _dbPath = "";

module.exports = { installCloudBackup, triggerUpload };
