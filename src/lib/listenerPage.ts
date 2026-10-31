// The station's public "listen live" page — ONE place that turns a station's public-page metadata into its address
// (Jeff, 2026-10-31: "add the listen live link to that stream manager page — they shouldn't have to hunt for it").
// Settings → Broadcast → "Your listener page" and Tools → Stream Manager both read it, so the two never disagree.

// Where the listener PWA is served (Cloudflare Pages → listen.ether-technologies.com).
export const LISTENER_BASE_URL = "https://listen.ether-technologies.com";

/** The page's address when it is published (turned on AND has an address), otherwise null. */
export function listenerPageUrl(meta: { public_enabled?: unknown; slug?: string | null } | null | undefined): string | null {
  const slug = (meta?.slug || "").trim();
  return meta?.public_enabled && slug ? `${LISTENER_BASE_URL}/${slug}` : null;
}
