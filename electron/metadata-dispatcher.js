// electron/metadata-dispatcher.js — Stream metadata fan-out engine.
//
// When a song starts on any deck, fans the "now playing" metadata out to
// every enabled row in the `stream_metadata_targets` table in parallel.
// Lives in the main process so it keeps pushing even when no renderer
// window is open — important for unattended automation.
//
// Supported target types:
//   - icecast:  Icecast 2 admin API (POST /admin/metadata?mount=...&song=...)
//               Optionally with cover art URL via x-icecast metadata extensions.
//   - shoutcast: Shoutcast v1 admin.cgi or v2 endpoints
//   - tunein:   TuneIn AIR API (POST to TuneIn's per-station feed URL)
//   - rds:      Serial port to RDS encoder (Inovonics, Audemat, Deva).
//               Lazy-loads `serialport` so non-RDS users don't need it.
//   - webhook:  Generic POST { title, artist, ... } to a URL — for stations
//               with custom in-house tooling.
//
// Each target's last_status / last_error / last_pushed_at / push_count is
// written back to the row so the Settings UI can show health at a glance.

const http  = require("http");
const https = require("https");
const { URL } = require("url");

let getDb = () => null;   // resolves the LIVE connection (set in install); survives a reopen
let ipcMain = null;
let serialPortModule = null; // lazy-loaded if any RDS target is configured

// ── DB helpers ────────────────────────────────────────────────
function listTargets(enabledOnly = true) {
  if (!getDb()) return [];
  try {
    const sql = enabledOnly
      ? "SELECT * FROM stream_metadata_targets WHERE enabled = 1 ORDER BY id"
      : "SELECT * FROM stream_metadata_targets ORDER BY id";
    return getDb().prepare(sql).all();
  } catch (e) {
    console.error("[METADATA] listTargets failed:", e.message);
    return [];
  }
}

function recordResult(id, status, errorMsg = "") {
  if (!getDb()) return;
  try {
    getDb().prepare(
      "UPDATE stream_metadata_targets SET last_status = ?, last_error = ?, last_pushed_at = ?, push_count = push_count + 1 WHERE id = ?"
    ).run(status, errorMsg, Math.floor(Date.now() / 1000), id);
  } catch (e) {
    console.error("[METADATA] recordResult failed:", e.message);
  }
}

// ── HTTP helper — small, no extra dep ─────────────────────────
// Supports basic auth, custom headers, GET/POST. Resolves to status code
// or rejects on network error / non-2xx response.
function httpRequest(urlString, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlString); } catch (e) { return reject(new Error("bad URL")); }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const headers = { ...(opts.headers || {}) };
    if (opts.auth) {
      headers["Authorization"] = "Basic " + Buffer.from(opts.auth).toString("base64");
    }
    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (opts.body) {
      headers["Content-Length"] = Buffer.byteLength(opts.body);
    }

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method || "GET",
      headers,
      timeout: opts.timeout || 8000,
    }, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ status: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("request timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Per-type push handlers ────────────────────────────────────

// Icecast 2 admin API. Config: { host, port, mount, adminUser, adminPass, useHttps }
async function pushIcecast(cfg, payload) {
  const protocol = cfg.useHttps ? "https" : "http";
  const port = cfg.port || 8000;
  const mount = cfg.mount?.startsWith("/") ? cfg.mount : "/" + (cfg.mount || "stream");
  const song = `${payload.artist || ""} - ${payload.title || ""}`.trim().replace(/^- /, "");
  const url = `${protocol}://${cfg.host}:${port}/admin/metadata?mount=${encodeURIComponent(mount)}&mode=updinfo&song=${encodeURIComponent(song)}`;
  await httpRequest(url, {
    method: "GET",
    auth: `${cfg.adminUser || "admin"}:${cfg.adminPass || ""}`,
  });
}

// Shoutcast v1 (sid=1, admin.cgi). Config: { host, port, password, sid, version }
// Version 2 uses a different endpoint but the metadata mode is similar.
async function pushShoutcast(cfg, payload) {
  const port = cfg.port || 8000;
  const sid  = cfg.sid  || 1;
  const song = `${payload.artist || ""} - ${payload.title || ""}`.trim().replace(/^- /, "");
  let url;
  if ((cfg.version || 1) >= 2) {
    // v2: /admin.cgi?sid=&mode=updinfo
    url = `http://${cfg.host}:${port}/admin.cgi?sid=${sid}&mode=updinfo&song=${encodeURIComponent(song)}`;
  } else {
    // v1: /admin.cgi?pass=&mode=updinfo
    url = `http://${cfg.host}:${port}/admin.cgi?pass=${encodeURIComponent(cfg.password || "")}&mode=updinfo&song=${encodeURIComponent(song)}`;
  }
  const headers = (cfg.version || 1) >= 2 ? { "Authorization": "Basic " + Buffer.from(`admin:${cfg.password || ""}`).toString("base64") } : {};
  await httpRequest(url, { method: "GET", headers });
}

// TuneIn AIR — partner API. Config: { partnerId, partnerKey, stationId }
// https://help.tunein.com/contact/contact-broadcasters-aIRBcsP49
async function pushTuneIn(cfg, payload) {
  if (!cfg.partnerId || !cfg.partnerKey || !cfg.stationId) {
    throw new Error("missing partnerId/partnerKey/stationId");
  }
  const params = new URLSearchParams({
    partnerId: cfg.partnerId,
    partnerKey: cfg.partnerKey,
    id: cfg.stationId,
    title: payload.title || "",
    artist: payload.artist || "",
  });
  if (payload.album) params.set("album", payload.album);
  const url = `https://air.radiotime.com/Playing.ashx?${params.toString()}`;
  await httpRequest(url, { method: "GET" });
}

// RDS encoder over serial. Config: { port, baud, encoderType, ps, pty }
// encoderType determines the command format:
//   - "inovonics": "TEXT=<radiotext>\r\nDPS=<dynPS>\r\n"
//   - "audemat":   "DRTPS=<text>\r\n"
//   - "deva":      "RT1=<text>\r\n"
//   - "generic":   plain text + \r\n
async function pushRds(cfg, payload) {
  if (!serialPortModule) {
    try {
      serialPortModule = require("serialport");
    } catch (e) {
      throw new Error("serialport package not installed — run `npm install serialport` to enable RDS output");
    }
  }
  const { SerialPort } = serialPortModule;
  const port = new SerialPort({
    path: cfg.port,        // e.g. "COM3" on Windows, "/dev/ttyUSB0" on Linux
    baudRate: cfg.baud || 9600,
    autoOpen: false,
  });
  await new Promise((res, rej) => port.open(err => err ? rej(err) : res()));

  const text = `${payload.artist || ""} - ${payload.title || ""}`.trim().replace(/^- /, "").slice(0, 64);
  let cmd;
  switch (cfg.encoderType) {
    case "inovonics": cmd = `TEXT=${text}\r\nDPS=${text.slice(0, 8)}\r\n`; break;
    case "audemat":   cmd = `DRTPS=${text}\r\n`; break;
    case "deva":      cmd = `RT1=${text}\r\n`; break;
    default:          cmd = `${text}\r\n`;
  }
  await new Promise((res, rej) => port.write(cmd, err => err ? rej(err) : res()));
  await new Promise(res => port.close(() => res()));
}

// Generic webhook — POST JSON to a URL. Config: { url, method, headers, basicUser, basicPass }
async function pushWebhook(cfg, payload) {
  if (!cfg.url) throw new Error("missing webhook URL");
  const body = JSON.stringify({
    title: payload.title || "",
    artist: payload.artist || "",
    album: payload.album || "",
    duration: payload.duration || 0,
    timestamp: Math.floor(Date.now() / 1000),
  });
  await httpRequest(cfg.url, {
    method: cfg.method || "POST",
    headers: { "Content-Type": "application/json", ...(cfg.headers || {}) },
    body,
    auth: cfg.basicUser ? `${cfg.basicUser}:${cfg.basicPass || ""}` : undefined,
  });
}

// ── Dispatcher — fan out to all enabled targets ───────────────
async function dispatch(payload) {
  const targets = listTargets(true);
  if (targets.length === 0) return;

  // Fire all in parallel — one slow target shouldn't block others.
  await Promise.all(targets.map(async t => {
    let cfg = {};
    try { cfg = JSON.parse(t.config_json || "{}"); } catch {}
    try {
      switch (t.type) {
        case "icecast":   await pushIcecast(cfg, payload);   break;
        case "shoutcast": await pushShoutcast(cfg, payload); break;
        case "tunein":    await pushTuneIn(cfg, payload);    break;
        case "rds":       await pushRds(cfg, payload);       break;
        case "webhook":   await pushWebhook(cfg, payload);   break;
        default: throw new Error(`unknown target type: ${t.type}`);
      }
      recordResult(t.id, "ok", "");
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn(`[METADATA] ${t.type} push to "${t.name}" failed:`, msg);
      recordResult(t.id, "error", msg);
    }
  }));
}

// ── Test push — manually fire a target with sample data, used by Settings ──
async function testPush(targetId) {
  if (!getDb()) return { ok: false, error: "no db" };
  try {
    const t = getDb().prepare("SELECT * FROM stream_metadata_targets WHERE id = ?").get(targetId);
    if (!t) return { ok: false, error: "target not found" };
    let cfg = {};
    try { cfg = JSON.parse(t.config_json || "{}"); } catch {}
    const payload = { title: "Test Track (Ether)", artist: "Ether Test", album: "", duration: 180 };
    switch (t.type) {
      case "icecast":   await pushIcecast(cfg, payload);   break;
      case "shoutcast": await pushShoutcast(cfg, payload); break;
      case "tunein":    await pushTuneIn(cfg, payload);    break;
      case "rds":       await pushRds(cfg, payload);       break;
      case "webhook":   await pushWebhook(cfg, payload);   break;
      default: throw new Error(`unknown target type: ${t.type}`);
    }
    recordResult(targetId, "ok", "");
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e);
    recordResult(targetId, "error", msg);
    return { ok: false, error: msg };
  }
}

// ── Install — wire IPC handlers and a now-playing listener ────
function installMetadataDispatcher(_ipcMain, database) {
  getDb = (typeof database === "function") ? database : () => database;
  ipcMain = _ipcMain;

  ipcMain.handle("metadata:list-targets", () => listTargets(false));
  ipcMain.handle("metadata:add-target", (_, { name, type, enabled = 1, config }) => {
    getDb().prepare("INSERT INTO stream_metadata_targets (name, type, enabled, config_json) VALUES (?, ?, ?, ?)")
      .run(name, type, enabled ? 1 : 0, JSON.stringify(config || {}));
    return { ok: true };
  });
  ipcMain.handle("metadata:update-target", (_, { id, name, type, enabled, config }) => {
    getDb().prepare("UPDATE stream_metadata_targets SET name = ?, type = ?, enabled = ?, config_json = ? WHERE id = ?")
      .run(name, type, enabled ? 1 : 0, JSON.stringify(config || {}), id);
    return { ok: true };
  });
  ipcMain.handle("metadata:delete-target", (_, { id }) => {
    getDb().prepare("DELETE FROM stream_metadata_targets WHERE id = ?").run(id);
    return { ok: true };
  });
  ipcMain.handle("metadata:test-target", (_, { id }) => testPush(id));

  // Hook into the existing now-playing pipe — main.js relays
  // "now-playing-update" to all renderer windows; we also dispatch out to
  // metadata targets here. This way the dispatch happens regardless of
  // which renderer window is open (or even if no window is open during
  // unattended automation).
  ipcMain.on("now-playing-update", (_, payload) => {
    if (payload && (payload.title || payload.artist)) dispatch(payload).catch(() => {});
  });

  // One-time migration — if user has an old single-row stream_settings
  // configured, seed it as the first metadata target so the existing
  // Icecast push keeps working after upgrade.
  try {
    const count = getDb().prepare("SELECT COUNT(*) as n FROM stream_metadata_targets").get().n;
    if (count === 0) {
      const old = getDb().prepare("SELECT * FROM stream_settings WHERE id = 1").get();
      if (old && old.host) {
        getDb().prepare("INSERT INTO stream_metadata_targets (name, type, enabled, config_json) VALUES (?, ?, ?, ?)")
          .run("Main Icecast (migrated)", "icecast", old.is_active ? 1 : 0, JSON.stringify({
            host: old.host, port: old.port || 8000, mount: old.mount || "/stream",
            adminUser: old.username || "admin", adminPass: old.password || "",
          }));
        console.log("[METADATA] Migrated existing Icecast settings to stream_metadata_targets");
      }
    }
  } catch (e) {
    console.warn("[METADATA] migration check failed:", e.message);
  }

  console.log("[METADATA] Dispatcher installed");
}

module.exports = { installMetadataDispatcher, dispatch, testPush };
