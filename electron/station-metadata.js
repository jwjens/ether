// electron/station-metadata.js — Public Listener Page config (Phase 2).
//
// Thin main-process client over the ether-backend station-metadata endpoints,
// plus logo upload (sign via backend → PUT to R2 from MAIN, so no browser CORS).
// The license key comes from station_config_kv (same source as cloud-backup.js).
// Renderer reaches these via ether.station.metadata.* (preload).

const { ETHER_BACKEND_URL } = require('./lib/etherBackend');

let getDb = () => null;   // resolves the LIVE connection (set in install); survives a reopen

function getConfigValue(key) {
  try {
    const row = getDb().prepare("SELECT value FROM station_config_kv WHERE key = ?").get(key);
    return row?.value || null;
  } catch { return null; }
}

async function getFetch() {
  if (typeof global.fetch === "function") return global.fetch;
  const mod = await import("node-fetch").catch(() => null);
  return mod ? mod.default : null;
}

function licenseHeaders(uuid) {
  // Send the license that OWNS the station being published — NOT whatever license_key happens to be
  // first in station_config_kv. Publishing is ownership-checked on the backend (stations.uuid +
  // license_key_id), so sending the install-level (or another station's) license gets rejected as
  // not-owned → "This station isn't linked to your account." Resolve from stations.owner_license_key;
  // fall back to the install license only when the station has no owner recorded.
  let key = null;
  try {
    if (uuid) key = getDb().prepare("SELECT owner_license_key FROM stations WHERE uuid = ? AND deleted_at IS NULL").get(uuid)?.owner_license_key || null;
  } catch { /* fall through to install license */ }
  if (!key) key = getConfigValue("license_key");
  return key ? { "x-license-key": key } : null;
}

// GET /api/station/:uuid/metadata → { ok, metadata } | { ok:false, error }
async function getMetadata(uuid) {
  const headers = licenseHeaders(uuid);
  if (!headers) return { ok: false, error: "no_license" };
  const fetch = await getFetch();
  try {
    const res = await fetch(`${ETHER_BACKEND_URL}/api/station/${encodeURIComponent(uuid)}/metadata`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `http_${res.status}` };
    return { ok: true, metadata: data };
  } catch { return { ok: false, error: "network" }; }
}

// POST /api/station/:uuid/metadata → { ok, metadata } | { ok:false, error }
async function saveMetadata(uuid, metadata) {
  const headers = licenseHeaders(uuid);
  if (!headers) return { ok: false, error: "no_license" };
  const fetch = await getFetch();
  try {
    const res = await fetch(`${ETHER_BACKEND_URL}/api/station/${encodeURIComponent(uuid)}/metadata`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(metadata || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `http_${res.status}` };
    return { ok: true, metadata: data };
  } catch { return { ok: false, error: "network" }; }
}

// GET /api/slugs/check?slug=&uuid= → { ok, available, reason } | { ok:false, error }
async function checkSlug(slug, uuid) {
  const headers = licenseHeaders(uuid);
  if (!headers) return { ok: false, error: "no_license" };
  const fetch = await getFetch();
  try {
    const qs = new URLSearchParams({ slug: String(slug || "") });
    if (uuid) qs.set("uuid", uuid);
    const res = await fetch(`${ETHER_BACKEND_URL}/api/slugs/check?${qs.toString()}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `http_${res.status}` };
    return { ok: true, available: !!data.available, reason: data.reason || null };
  } catch { return { ok: false, error: "network" }; }
}

// Sign + PUT a (renderer-resized) logo to R2. `bytes` is a Uint8Array/Buffer.
async function uploadLogo(uuid, bytes, ext) {
  const headers = licenseHeaders(uuid);
  if (!headers) return { ok: false, error: "no_license" };
  const fetch = await getFetch();
  const cleanExt = String(ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  try {
    const signRes = await fetch(`${ETHER_BACKEND_URL}/api/station/${encodeURIComponent(uuid)}/logo-upload-url`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ext: cleanExt }),
    });
    const sign = await signRes.json().catch(() => ({}));
    if (!signRes.ok) return { ok: false, error: sign.error || `http_${signRes.status}` };

    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const ctype = cleanExt === "png" ? "image/png" : cleanExt === "webp" ? "image/webp" : "image/jpeg";
    const putRes = await fetch(sign.signed_url, { method: "PUT", headers: { "Content-Type": ctype }, body });
    if (!putRes.ok) return { ok: false, error: `r2_put_${putRes.status}` };
    return { ok: true, public_url: sign.public_url };
  } catch { return { ok: false, error: "network" }; }
}

function installStationMetadata(ipcMain, database) {
  getDb = (typeof database === 'function') ? database : () => database;
  ipcMain.handle("station:metadata:get",        (_, uuid)             => getMetadata(uuid));
  ipcMain.handle("station:metadata:save",       (_, uuid, m)          => saveMetadata(uuid, m));
  ipcMain.handle("station:metadata:check-slug", (_, slug, uuid)       => checkSlug(slug, uuid));
  ipcMain.handle("station:metadata:upload-logo",(_, uuid, bytes, ext) => uploadLogo(uuid, bytes, ext));
}

module.exports = { installStationMetadata };
