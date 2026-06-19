// Client mirror of the backend slug rules (ether-backend/src/slug.js) for instant
// UX feedback in the Public Page settings. The backend remains the gatekeeper on
// save — this only drives the red/green indicator before the network check.

// 2–32 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen. Allows 2-letter
// station codes like "ov" / "kj" (the old rule blocked exactly-2-char slugs).
export const STATION_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export const RESERVED_SLUGS = new Set([
  "admin", "api", "www", "public", "account", "accounts", "auth", "login", "logout",
  "signup", "register", "dashboard", "console", "emergency", "mobile", "companion",
  "health", "sync", "audio", "backup", "backups", "guest", "guests", "join", "invite",
  "station", "stations", "listen", "app", "apps", "assets", "static", "cdn", "img",
  "images", "logo", "logos", "about", "help", "support", "contact", "terms", "privacy",
  "settings", "billing", "stripe", "webhook", "root", "system", "status", "me", "user", "users",
]);

export type SlugValidation = { ok: true } | { ok: false; reason: "invalid" | "reserved" };

export function validateSlug(slug: string): SlugValidation {
  if (typeof slug !== "string" || !STATION_SLUG_RE.test(slug) || slug.includes("--")) {
    return { ok: false, reason: "invalid" };
  }
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

export function slugify(name: string): string {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}
