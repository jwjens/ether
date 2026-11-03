# Tools → Links: what the Cloudflare sites actually route (2026-10-27) — question before building

**Jeff (verbatim, the second of two versions in the same message; the second is the one being followed):** "Add to
4.6.67, own commit with a test: in the Tools menu, add a "Links" menu that lists every page available to the user (for
example the lobby screen, the Park page, and every other page). They are all served from Cloudflare, so each link must be
the real public Cloudflare address for this account and station, not a local address. For each one: its name, its
address, a button to open it, and a button to copy the address. Build the list from the page routes in the deployed
Cloudflare site, not a hand-typed list, so a new page shows up automatically and a removed one disappears. The test fails
if any route in the site is missing from the menu. Don't change anything else."

## What exists (read-only; no code changed)

None of the sites has a route table. Each is a single-page app (`_redirects`: `/* /index.html 200`), and the page is
picked by hand-written path parsing in its own code. So the deployed site cannot be asked "what are your routes".

| Site (repo) | Public address in Ether today | Routes (from its code) | Per account / station |
|---|---|---|---|
| ether-listener | `listen.ether-technologies.com` (Ether's code) | `/<slug>` station player; `/embed/<slug>` widget; `/jukebox/<slug>` request page; **`/jukebox/<slug>/lobby` lobby screen**; `/@<handle>` account hub; `/@<handle>/<channel>`; `/` landing | station slug, jukebox slug, account handle |
| ether-park | `park.ether-cast.com` (`src/lib/ccData.ts:265`) | **`/<slug>` Park page** (+ `?k=` access token) | station slug, access token |
| ether-dashboard | `app.ether-cast.com` | no path routes (one page; screens by state) | — |
| ether-signup, ether-admin, ether-health | signup / admin / health | not per station | — |

Routing code:
- Listener: `src/App.tsx:17-34`, `src/api.ts` (`embedSlugFromPath`, `jukeboxSlugFromPath`, `jukeboxLobbySlugFromPath`,
  `accountFromPath`, `slugFromPath`).
- Park: `src/api.ts` `slugFromPath`, `accessToken`.

## The conflict

"Built from the page routes in the deployed Cloudflare site … the test fails if any route in the site is missing" needs
the sites to SAY their routes, which none does today. The ways to get there:

- **A (recommended):**
  - Each site gets one declared route table that its own router uses, and publishes it as `/routes.json` in its deploy.
    Each entry has a name, a path pattern, and which value it needs (station slug, jukebox slug, handle, park token).
  - Ether's Links menu fetches each site's `/routes.json` and fills in this account's and station's values.
  - Test: every route in the deployed `/routes.json` appears in the menu.
  - A new page then shows up automatically, and a removed one disappears.
  - **Needs changes to ether-listener and ether-park, and a Cloudflare deploy of each**, which is outside "don't change
    anything else" and needs your go-ahead to deploy.
- **B:** Ether's test reads the sibling repos' routing code on this computer. That is not the deployed site, it fails
  wherever the sibling repos are absent (CI), and the app itself still cannot know the routes at run time.
- **C:** a list typed into Ether. You ruled this out.

## Also open

- Domain: Ether's code uses `listen.ether-technologies.com`; CLAUDE.md says `ether-cast.com` is canonical and the old
  names 301. Which public address is real for the listener has not been checked.
- Which sites count as "every page available to the user": the listener and park (per station), plus app.ether-cast.com?
