// publicPages — every public page Ether's account and stations have, at its real public address (2026-10-27).
//
// Jeff: "a "Links" menu that lists every page available to the user (for example the lobby screen, the Park page, and
// every other page). They are all served from Cloudflare, so each link must be the real public Cloudflare address for
// this account and station, not a local address. For each one: its name, its address, a button to open it, and a button
// to copy the address." … "this should be in preferences" … "its own menu title on the left sidebar links then a menu for
// each type".
//
// The ROUTES below are each site's own routing, read from its code (ether-listener src/App.tsx + src/api.ts,
// ether-park src/api.ts, ether-signup src/App.tsx; the others are single pages). publicPages.test.ts reads those sites'
// routing code and FAILS when a route there is not here, so a page added to a site cannot be missing from Links.
// The VALUES come from this account at run time: its stations and their public slugs and its handle from the backend
// (electron/main.js links:account — only this account's stations), and each station's jukebox slug from its own
// setting (jukebox_request_url). Nothing per-station is typed in here.
//
// Every ether-cast.com address also answers on ether-technologies.com (the old names redirect); the canonical one is used.

export type PageType = "station" | "embed" | "account" | "jukebox" | "park" | "signup" | "apps" | "website";
export const PAGE_TYPES: { type: PageType; title: string; description: string }[] = [
  { type: "station", title: "Station player", description: "Each station's public listening page" },
  { type: "embed", title: "Embed player", description: "The player without the page around it, for putting on a station's own website" },
  { type: "account", title: "Account page", description: "Your account's page listing its stations, and one station on it" },
  { type: "jukebox", title: "Jukebox and lobby", description: "The request page the jukebox QR opens, and the lobby screen" },
  { type: "park", title: "Park page", description: "Park staff's page for each station" },
  { type: "signup", title: "Sign-up and account", description: "Sign up, log in and account pages" },
  { type: "apps", title: "Apps", description: "The web apps" },
  { type: "website", title: "Website and downloads", description: "The Ether website and the installers" },
];

export const SITES = {
  listener: "https://listen.ether-cast.com",
  park: "https://park.ether-cast.com",
  signup: "https://signup.ether-cast.com",
  dashboard: "https://app.ether-cast.com",
  platform: "https://platform.ether-cast.com",
  health: "https://health.ether-cast.com",
  hub: "https://ethercast.ether-cast.com",
  website: "https://ether-technologies.com",
  downloads: "https://ether-backend-production.up.railway.app",
} as const;
export type Site = keyof typeof SITES;

/** One route. `:station` = the station's public slug, `:handle` = the account handle, `:jukebox` = the jukebox slug. */
export interface Route { site: Site; type: PageType; name: string; path: string }
export const ROUTES: Route[] = [
  { site: "listener", type: "station", name: "Station player", path: "/:station" },
  { site: "listener", type: "embed", name: "Embed player", path: "/embed/:station" },
  { site: "listener", type: "account", name: "Account page", path: "/@:handle" },
  { site: "listener", type: "account", name: "Station on the account page", path: "/@:handle/:station" },
  { site: "listener", type: "jukebox", name: "Jukebox request page", path: "/jukebox/:jukebox" },
  { site: "listener", type: "jukebox", name: "Lobby screen", path: "/jukebox/:jukebox/lobby" },
  { site: "listener", type: "website", name: "Listener home", path: "/" },
  { site: "park", type: "park", name: "Park page", path: "/:station" },
  { site: "signup", type: "signup", name: "Sign up", path: "/" },
  { site: "signup", type: "signup", name: "Log in", path: "/login" },
  { site: "signup", type: "signup", name: "Forgot password", path: "/forgot" },
  { site: "signup", type: "signup", name: "Reset password", path: "/reset" },
  { site: "signup", type: "signup", name: "Verify email", path: "/verify" },
  { site: "signup", type: "signup", name: "Support", path: "/support" },
  { site: "signup", type: "signup", name: "Privacy", path: "/privacy" },
  { site: "signup", type: "signup", name: "Terms", path: "/terms" },
  { site: "signup", type: "signup", name: "Unsubscribe", path: "/unsubscribe" },
  { site: "dashboard", type: "apps", name: "Dashboard", path: "/" },
  { site: "platform", type: "apps", name: "Platform (admin)", path: "/" },
  { site: "health", type: "apps", name: "Health", path: "/" },
  { site: "hub", type: "apps", name: "Station hub", path: "/" },
  { site: "website", type: "website", name: "Website", path: "/" },
  { site: "website", type: "website", name: "Website — account", path: "/account" },
  { site: "downloads", type: "website", name: "Download for Windows", path: "/download/windows" },
  { site: "downloads", type: "website", name: "Download for Mac", path: "/download/mac" },
];

export interface AccountLinksData {
  handle: string | null;
  stations: { uuid: string; name: string; slug: string | null }[];
  /** station uuid → its jukebox slug (jukebox_request_url), when one is set. */
  jukeboxSlugs: Record<string, string>;
}
/** One line in Links: a name, the real address (or why there is none yet), and the station it belongs to. */
export interface PageLink { type: PageType; name: string; station: string | null; url: string | null; missing?: string }

const enc = (s: string) => encodeURIComponent(s);

/** Every route, filled in for this account: one line per station for per-station routes. */
export function pageLinks(d: AccountLinksData): PageLink[] {
  const out: PageLink[] = [];
  for (const r of ROUTES) {
    const base = SITES[r.site];
    const needsStation = r.path.includes(":station"), needsHandle = r.path.includes(":handle"), needsJukebox = r.path.includes(":jukebox");
    const fill = (station: string | null, jukebox: string | null) =>
      base + (r.path === "/" ? "/" : r.path.replace(":station", enc(station || "")).replace(":handle", enc(d.handle || "")).replace(":jukebox", enc(jukebox || "")));
    if (!needsStation && !needsJukebox) {
      if (needsHandle && !d.handle) out.push({ type: r.type, name: r.name, station: null, url: null, missing: "no account handle set yet (the account page's address)" });
      else out.push({ type: r.type, name: r.name, station: null, url: fill(null, null) });
      continue;
    }
    for (const s of d.stations) {
      if (needsHandle && !d.handle) { out.push({ type: r.type, name: r.name, station: s.name, url: null, missing: "no account handle set yet" }); continue; }
      if (needsJukebox) {
        const j = d.jukeboxSlugs[s.uuid];
        if (!j) { out.push({ type: r.type, name: r.name, station: s.name, url: null, missing: "no jukebox set up on this station (Jukebox → its public address)" }); continue; }
        out.push({ type: r.type, name: r.name, station: s.name, url: fill(s.slug, j) });
        continue;
      }
      if (!s.slug) { out.push({ type: r.type, name: r.name, station: s.name, url: null, missing: "this station has no public page address yet" }); continue; }
      out.push({ type: r.type, name: r.name, station: s.name, url: fill(s.slug, null) });
    }
  }
  return out;
}
