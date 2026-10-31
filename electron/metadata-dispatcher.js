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
// Per station, local to this computer (v69, scripts/migrate-stream-metadata-targets-phase-sync-69.js).
function listTargets(stationId, enabledOnly = true) {
  if (!getDb()) return [];
  try {
    return getDb().prepare(`SELECT * FROM stream_metadata_targets WHERE station_id = ?${enabledOnly ? " AND enabled = 1" : ""} ORDER BY id`).all(stationId);
  } catch (e) {
    console.error("[METADATA] listTargets failed:", e.message);
    return [];
  }
}

function recordResult(id, status, errorMsg = "", sent = "") {
  if (!getDb()) return;
  try {
    getDb().prepare(
      "UPDATE stream_metadata_targets SET last_status = ?, last_error = ?, last_pushed_at = ?, last_sent = ?, push_count = push_count + 1 WHERE id = ?"
    ).run(status, errorMsg, Math.floor(Date.now() / 1000), sent, id);
  } catch (e) {
    console.error("[METADATA] recordResult failed:", e.message);
  }
}

// "Artist - Title" (just the title when there is no artist) — what every output is sent.
function songText(payload) {
  const artist = String(payload?.artist || "").trim(), title = String(payload?.title || "").trim();
  return artist && title ? `${artist} - ${title}` : (title || artist);
}

// An Icecast output can use THIS station's own stream (the server, mount and source password Stream Manager / ON AIR
// use): Icecast accepts a metadata update for a mount from that mount's source login.
function resolveIcecast(cfg, station) {
  if (!cfg.useStationStream) return cfg;
  if (!station || !String(station.icecast_server_url || "").trim()) throw new Error("this station has no stream server set (Stream Manager)");
  const sp = require("../audiod/stream").serverAndPort(station.icecast_server_url, station.icecast_port);   // the station's own port
  if (!sp.port) throw new Error("this station has no port set (Stream Manager)");
  return { host: sp.host, port: sp.port, mount: station.icecast_mount || "/stream",
           adminUser: "source", adminPass: station.icecast_password || "", useHttps: false };
}
function stationRow(stationId) {
  try { return getDb()?.prepare("SELECT icecast_server_url, icecast_port, icecast_mount, icecast_password FROM stations WHERE id = ?").get(stationId) || null; }
  catch { return null; }
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
  const port = cfg.port;
  if (!port) throw new Error("no port set for this output");
  const mount = cfg.mount?.startsWith("/") ? cfg.mount : "/" + (cfg.mount || "stream");
  const song = songText(payload);
  const url = `${protocol}://${cfg.host}:${port}/admin/metadata?mount=${encodeURIComponent(mount)}&mode=updinfo&song=${encodeURIComponent(song)}`;
  await httpRequest(url, {
    method: "GET",
    auth: `${cfg.adminUser || "admin"}:${cfg.adminPass || ""}`,
  });
}

// Shoutcast v1 (sid=1, admin.cgi). Config: { host, port, password, sid, version }
// Version 2 uses a different endpoint but the metadata mode is similar.
async function pushShoutcast(cfg, payload) {
  const port = cfg.port;
  if (!port) throw new Error("no port set for this output");
  const sid  = cfg.sid  || 1;
  const song = songText(payload);
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

  const text = songText(payload).slice(0, 64);
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

// ── Dispatcher — fan out to the station's enabled targets ─────
async function pushOne(t, payload) {
  let cfg = {};
  try { cfg = JSON.parse(t.config_json || "{}"); } catch {}
  switch (t.type) {
    case "icecast":   return pushIcecast(resolveIcecast(cfg, stationRow(t.station_id)), payload);
    case "shoutcast": return pushShoutcast(cfg, payload);
    case "tunein":    return pushTuneIn(cfg, payload);
    case "rds":       return pushRds(cfg, payload);
    case "webhook":   return pushWebhook(cfg, payload);
    default: throw new Error(`unknown output type: ${t.type}`);
  }
}

const lastSong = new Map();   // stationId → the last song that started (Test sends it)

async function dispatch(stationId, payload) {
  if (!payload || !(payload.title || payload.artist)) return;
  lastSong.set(stationId, payload);
  const targets = listTargets(stationId, true);
  // All in parallel — one slow output never holds up another.
  await Promise.all(targets.map(async t => {
    const sent = songText(payload);
    try { await pushOne(t, payload); recordResult(t.id, "ok", "", sent); }
    catch (e) {
      const msg = e?.message || String(e);
      console.warn(`[METADATA] ${t.type} output "${t.name}" failed:`, msg);
      recordResult(t.id, "error", msg, sent);
    }
  }));
}

// Test: send the station's current song to one output now (a labelled test line when nothing has played yet).
async function testPush(targetId) {
  if (!getDb()) return { ok: false, error: "no db" };
  const t = getDb().prepare("SELECT * FROM stream_metadata_targets WHERE id = ?").get(targetId);
  if (!t) return { ok: false, error: "output not found" };
  const payload = lastSong.get(t.station_id) || { title: "Test from Ether", artist: "Ether" };
  const sent = songText(payload);
  try { await pushOne(t, payload); recordResult(targetId, "ok", "", sent); return { ok: true, sent }; }
  catch (e) { const msg = e?.message || String(e); recordResult(targetId, "error", msg, sent); return { ok: false, error: msg, sent }; }
}

// ── Install — the Settings screen's IPC. main.js calls dispatch() when a song starts (the daemon's playstart). ──
// No seed from the old stream_settings row (Jeff, 2026-10-30: it would create a surprise output from a stale row).
function installMetadataDispatcher(_ipcMain, database) {
  getDb = (typeof database === "function") ? database : () => database;
  ipcMain = _ipcMain;
  const sid = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error("no station"); return n; };

  ipcMain.handle("metadata:list-targets", (_, stationId) => listTargets(sid(stationId), false));
  ipcMain.handle("metadata:add-target", (_, { stationId, name, type, enabled = 1, config }) => {
    getDb().prepare("INSERT INTO stream_metadata_targets (station_id, name, type, enabled, config_json) VALUES (?, ?, ?, ?, ?)")
      .run(sid(stationId), name || "", type, enabled ? 1 : 0, JSON.stringify(config || {}));
    return { ok: true };
  });
  ipcMain.handle("metadata:update-target", (_, { id, name, type, enabled, config }) => {
    getDb().prepare("UPDATE stream_metadata_targets SET name = ?, type = ?, enabled = ?, config_json = ? WHERE id = ?")
      .run(name || "", type, enabled ? 1 : 0, JSON.stringify(config || {}), id);
    return { ok: true };
  });
  ipcMain.handle("metadata:delete-target", (_, { id }) => {
    getDb().prepare("DELETE FROM stream_metadata_targets WHERE id = ?").run(id);
    return { ok: true };
  });
  ipcMain.handle("metadata:test-target", (_, { id }) => testPush(id));
  ipcMain.handle("metadata:serial-ports", async () => {
    try { const { SerialPort } = require("serialport"); return { ok: true, ports: (await SerialPort.list()).map(p => ({ path: p.path, name: p.friendlyName || p.manufacturer || "" })) }; }
    catch (e) { return { ok: false, error: e?.message || String(e) }; }
  });
  console.log("[METADATA] Dispatcher installed");
}

module.exports = { installMetadataDispatcher, dispatch, testPush, songText, resolveIcecast, pushIcecast, pushWebhook, _setDb: (fn) => { getDb = fn; } };
