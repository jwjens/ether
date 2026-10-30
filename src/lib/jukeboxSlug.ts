// THE JUKEBOX REQUEST NAME (Jeff, 2026-10-30: "fix the "Request link (QR)" field so a full https:// address works and the
// song list reaches the phone page. Fix the cause, not just the input.")
//
// The setting holds what the operator typed: a short name ("party") or a full address
// ("https://listen.ether-technologies.com/jukebox/party"). The phone page, the song-list publish, the wall's request
// feed and Links all need the NAME. They used to read the raw text as the name, so a full address was published as
// "https://…" and refused. Every reader asks this one function. The main process has the same rule in
// electron/jukebox-slug.js (kept identical by src/lib/jukeboxSlug.test.ts).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;   // what the backend accepts (ether-backend /api/account/jukebox/pool)

/** The request name in what the operator typed, or null when there is none. */
export function jukeboxSlug(raw: string | null | undefined): string | null {
  let v = String(raw ?? "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    let parts: string[];
    try { parts = new URL(v).pathname.split("/").filter(Boolean); } catch { return null; }
    const i = parts.findIndex((p) => p.toLowerCase() === "jukebox");
    v = i >= 0 ? (parts[i + 1] ?? "") : (parts[parts.length - 1] ?? "");
    try { v = decodeURIComponent(v); } catch { return null; }
  }
  v = v.replace(/^\/+|\/+$/g, "").toLowerCase();
  return SLUG_RE.test(v) ? v : null;
}
