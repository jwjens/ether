// THE JUKEBOX REQUEST NAME — the main process's copy of src/lib/jukeboxSlug.ts (same rule; kept identical by
// src/lib/jukeboxSlug.test.ts). The setting holds a short name or a full https:// address; readers need the name.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function jukeboxSlug(raw) {
  let v = String(raw == null ? "" : raw).trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    let parts;
    try { parts = new URL(v).pathname.split("/").filter(Boolean); } catch { return null; }
    const i = parts.findIndex((p) => p.toLowerCase() === "jukebox");
    v = i >= 0 ? (parts[i + 1] || "") : (parts[parts.length - 1] || "");
    try { v = decodeURIComponent(v); } catch { return null; }
  }
  v = v.replace(/^\/+|\/+$/g, "").toLowerCase();
  return SLUG_RE.test(v) ? v : null;
}

module.exports = { jukeboxSlug };
