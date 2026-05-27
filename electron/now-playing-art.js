// electron/now-playing-art.js — Embedded album art → R2 public, for the listener page.
//
// The on-air file's embedded cover is the PRIMARY artwork source for the public listener
// page (iTunes is the listener's fallback). We extract it in MAIN (music-metadata is
// ESM-only → dynamic import), upload to the public R2 bucket via a backend-signed PUT
// (so no browser CORS — same pattern as station-metadata.js logo upload), and the
// renderer attaches the returned art_url to the now-playing payload. Best-effort: any
// failure resolves to null and the listener falls back to iTunes → station logo.

const crypto = require("crypto");
const { ETHER_BACKEND_URL } = require("./lib/etherBackend");

let db = null;
function licenseKey() {
  try { return db.prepare("SELECT value FROM station_config_kv WHERE key = ?").get("license_key")?.value || null; }
  catch { return null; }
}
async function getFetch() {
  if (typeof global.fetch === "function") return global.fetch;
  const mod = await import("node-fetch").catch(() => null);
  return mod ? mod.default : null;
}

const _hashToUrl = new Map();                       // art content hash → public_url (skip re-upload)
let _current = { filePath: null, artUrl: null };    // newest on-air file + its resolved art_url

async function extractArt(filePath) {
  try {
    const mm = await import("music-metadata");
    const meta = await mm.parseFile(filePath, { duration: false });
    const pic = meta.common && meta.common.picture && meta.common.picture[0];
    if (pic && pic.data && pic.data.length) {
      return { buffer: Buffer.from(pic.data), format: String(pic.format || "image/jpeg") };
    }
  } catch { /* unreadable / no tags / missing file */ }
  return null;
}

function extFor(format) {
  const f = format.toLowerCase();
  if (f.includes("png")) return "png";
  if (f.includes("webp")) return "webp";
  if (f.includes("gif")) return "gif";
  return "jpg";
}
function ctypeFor(ext) {
  return ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
}

async function uploadArt(uuid, filePath) {
  const art = await extractArt(filePath);
  if (!art) return null;
  const hash = crypto.createHash("sha1").update(art.buffer).digest("hex").slice(0, 32);
  if (_hashToUrl.has(hash)) return _hashToUrl.get(hash); // identical cover already on R2
  const key = licenseKey();
  if (!key) return null;
  const fetch = await getFetch();
  if (!fetch) return null;
  const ext = extFor(art.format);
  try {
    const signRes = await fetch(`${ETHER_BACKEND_URL}/api/station/${encodeURIComponent(uuid)}/now-playing-art-upload-url`, {
      method: "POST",
      headers: { "x-license-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ ext, hash }),
    });
    const sign = await signRes.json().catch(() => ({}));
    if (!signRes.ok || !sign.signed_url) return null;
    const putRes = await fetch(sign.signed_url, { method: "PUT", headers: { "Content-Type": ctypeFor(ext) }, body: art.buffer });
    if (!putRes.ok) return null;
    _hashToUrl.set(hash, sign.public_url);
    return sign.public_url;
  } catch { return null; }
}

// Returns the cached art_url for the current on-air file immediately (null while an
// upload is in flight, or if the file has no embedded art). When the file changes, kicks
// off a background upload; the URL becomes available on a subsequent call (next heartbeat).
function ensureNowPlayingArt(uuid, filePath) {
  if (!uuid || !filePath) return null;
  if (filePath === _current.filePath) return _current.artUrl;
  _current = { filePath, artUrl: null };
  uploadArt(uuid, filePath).then(url => {
    if (_current.filePath === filePath) _current.artUrl = url; // ignore a stale late upload
  }).catch(() => {});
  return null;
}

function installNowPlayingArt(ipcMain, database) {
  db = database;
  ipcMain.handle("nowPlayingArt:ensure", (_, uuid, filePath) => ensureNowPlayingArt(uuid, filePath));
}

module.exports = { installNowPlayingArt };
