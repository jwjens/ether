# Park page: one page for the whole cluster (2026-11-02) — DEPLOYED (Jeff: "Park cluster page looks good. Deploy it.")

**Jeff (verbatim):** "Park page: one page for the whole cluster, not one per station.
- Address: park.ether-cast.com/<cluster slug>, e.g. park.ether-cast.com/ov. The slug comes from the cluster's name, which
  the user sets in Ether. It's editable, unique across accounts, and nothing is baked in.
- Sign in once with name + PIN, then a station selector at the top lists that cluster's stations. Everything on the page
  follows the selected station: volume (that station's Monitor level, never Master), closing time, announcements, program
  log. Remember the last station picked per login.
- Roles still apply per station.
- Old per-station Park links keep working: they redirect to the cluster page with that station already selected.
Own commits with tests. Show me screenshots before deploying. Don't change any license."

## Commits (local, not pushed)

| Repo | Branch | Commit |
|---|---|---|
| `C:\ether-backend-deploy` | `feat/park-cluster` | `e71bbf2` |
| `C:\ether-park` | `feat/park-cluster` | `336264c` |

The desktop app is unchanged.

## What the cluster is (existing, reused)

The cluster is the account's **handle**, `licenses.account_slug`, set in Ether → Station Manager (the account name and
handle editor, `src/components/StationManager.tsx` HubEditor). It was already:
- unique across accounts;
- editable, with a 30-day cooldown;
- recorded in `account_slug_history`, so old handles redirect.

The cluster's stations are that account's published stations.

New rule: a handle that another account's published station already uses as its station slug is refused, because
the cluster address shares its first path segment with the old per-station links.

## How it works

- **The address.** `GET /public/park/:name` says what a name is:
  - the cluster (its name and stations);
  - a renamed cluster;
  - an old per-station link, which becomes `/<cluster>?station=<slug>` with that station selected;
  - a station whose account has no handle yet. That station keeps its own page, exactly as before. The same happens
    when the server can't answer, for example in the offline copy inside the desktop app.
- **Sign in once** (`POST /public/park/:name/login`). It uses the same username + PIN users and the same lockout rule
  as before.
  - The session has no station (`park_sessions.station_uuid` NULL). Every station request still goes through that
    station's own `/public/ops/<slug>/…` route, and `park-auth.sessionVerdict` checks the login against that
    station's account each time. Another account's station is refused.
  - Log out, a PIN change or a removed user end the session.
  - Old per-station logins keep working on their own station.
- **Everything follows the selected station.** The page below the selector is the per-station page:
  - sound (`ops:set-level` = that station's **MONITOR**, never Master);
  - MUTE;
  - closing time;
  - announcements;
  - now playing;
  - carts;
  - Listen and Talk.
- **Last station per login:** `park_user_prefs`, set by `PUT /public/park/:name/last-station`. The server returns it
  at sign-in and from `/me`, so another phone that signs in as the same person opens on that station too. This phone
  also remembers it locally. A station chosen by an old link wins.

## Roles per station: what exists

Per-station Park access for PIN users was never built. Jeff's 2026-10-13 ruling (`src/lib/park-auth.js` header): any
user of the account, any role, may use the account's Park pages. The cluster page keeps exactly that rule, and checks it
station by station on every request (`sessionVerdict`). A per-station rule, if added later, goes in that one check.

## "Program log"

The Park page has no program log. It shows **now playing** and **today's announcements**, and both follow the selected
station. A program log on the Park page would be a new feature, so it was not added.

## Tests

- **Backend:**
  - `src/lib/park-cluster.test.js` (4 tests): the address rules, which station opens, the handle clash, and the
    cluster-login verdict, including PIN change, removal, log out, another account, and old station logins.
  - `test/park-cluster.test.js` (7 tests, real server, test database).
  - Stranger tests for the 4 new account routes. They include another account's cluster login aimed at this
    account's stations.
  - Route inventory: 203 routes.
  - **Full suite: 601/601.**
- **Park page:** `src/cluster.test.ts` (`npm test`: which station opens, and the address); tsc 0; vite build OK.

## Screenshots

Taken with the real backend branch on the test database: a made-up cluster "ovpark", three stations with different
levels, closing times and announcements, and a made-up user Steve/1234. Production was not touched.
- In the scratchpad folder `park-shots`:
  - `1-cluster-view-only`;
  - `2-old-link-forest` (address `/ovpark?station=forest`);
  - `3-login`;
  - `4-logged-in-forest`;
  - `5-switched-to-halloveen` (−3.0 dB vs −9.1 dB, 9:00 PM vs 10:30 PM);
  - `6-reopen-remembers-halloveen`;
  - `6b-server-remembers-for-this-login` (this phone's memory wiped; the server's per-login memory opened HalloVeen);
  - `7-phone`.
- "Station offline" and "stopped reporting" appear because no station is connected in the test.

## Before deploying (on Jeff's go)

1. Check production read-only for handles that equal another account's station slug. Such an old link would open the
   other cluster. The new check only stops new ones.
2. Deploy the backend first (Railway, push `main`). It adds `park_user_prefs` and makes `park_sessions.station_uuid`
   nullable. Then deploy the Park page (`npm run deploy`). The page falls back to per-station mode against an older
   backend, so the order is safe either way.
3. On the live server, with a test account (not a customer's), check the cluster page, an old link redirecting, and
   sign-in on two stations.

## Jeff's answers (2026-11-02)
"Park page: no program log needed, and the roles rule as it stands is fine."

## Deploy (2026-11-02)
1. Production read-only check (public DB URL, READ ONLY session): handles equal to another account's station slug: **none**.
   Accounts with a handle: only license 24, `opportunity-viilage` (4 published stations), so that is the one live cluster.
2. Backend: `main` fast-forwarded to `e71bbf2`, pushed; Railway deployment `85ab02b3` **SUCCESS** (2026-11-02 21:20 PT).
   Live `GET /public/park/opportunity-viilage` → cluster "Opportunity Village", stations Christmas In July, HalloVeen,
   Magical Forest, Open Format.
3. Park page: `npm run deploy` from `feat/park-cluster` `336264c` (it contains every other local branch; the repo has no
   remote) → Pages deployment `ad9c4234`; live bundle `index-CBxOPQzd.js` calls the production backend.
4. Live, view only (no login): `park.ether-cast.com/opportunity-viilage` opens with the selector (first station);
   `park.ether-cast.com/halloween` → `/opportunity-viilage?station=halloween`, HalloVeen selected, its own carts, closing
   time and sound. Sign-in on the live page was not tried: no PIN of that account is known here and setting a handle on the
   test account would write its license row. **UNVERIFIED live: sign-in and switching stations while signed in** (proved on
   the test database only).
