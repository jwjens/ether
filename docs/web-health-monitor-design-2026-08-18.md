# Web Health Monitor — design doc

**Status:** APPROVED 2026-08-18, **BUILT** (§10), **BACKEND DEPLOYED** (§11) and **PAGE DEPLOYED**
(§12) — both GO gates given 2026-08-19. Live at **https://ether-health.pages.dev**; the
`health.ether-technologies.com` custom domain still needs attaching in the Cloudflare dashboard.
**ROUND TRIP PROVEN 2026-08-19 (§13)** — live health rows are in production Postgres. The one thing
still unexercised is two machines reporting on the SAME station, which is the case §1.1 exists for.

Jeff's rulings on the four open decisions: (1) **Option B**, the health tombstone carve-out;
(2) **runway ships in the frame** — per-machine attribution satisfies the local-only ruling;
(3) **build `GET /api/account/health`**; (4) **the 5-minute auto-expiring watch window**. Custom
domain **health.ether-technologies.com**, used as the Function's explicit allowed origin.
**Date:** 2026-08-18 · **Rides into:** 4.4.229 · **No version bump in this doc's work.**

---

## 0 · What this is

A read-only web page, on the listener-page infrastructure (Cloudflare Pages + Functions via wrangler,
proxying Railway), that renders **an account's whole fleet**: per-station status, the designated
generator and its last check-in, schedule runway, the processing meter trio, deck/on-air state, stream
state, and recent activity.

**The governing constraint, from Jeff:** machines push health frames by **EXTENDING the existing
Control Center push — no second channel.**

This is the "BUILD THE SENSE, NOT THE SCAFFOLD" rule applied at fleet scale: the Health Monitor already
exists in-app and is honest about what it observes. This carries that same observed state to a screen
Jeff can open from anywhere, without inventing a parallel telemetry system.

---

## 1 · The existing channel, exactly as it is today

Receipts, because this design lives or dies on extending this and not building beside it:

| Leg | Where | Detail |
|---|---|---|
| Push (install → cloud) | `src/lib/ccData.ts:11` `pushCcData()` | `POST {ETHER_BACKEND_URL}/api/account/data/sync`, header **`x-license-key`**, body `{ station_uuid, table, rows }` |
| Backend write | `/c/ether-backend/src/index.js:2897` | validates the license, checks the station belongs to it, upserts each row into `station_cc_data` |
| Store | `/c/ether-backend/src/index.js:678` | `station_cc_data(station_uuid, table_name, row_uuid, payload JSONB, deleted_at, updated_at)`, PK `(station_uuid, table_name, row_uuid)` |
| Read (cloud → web) | `/c/ether-backend/src/index.js:2956` | `GET /api/account/station/:uuid/data?table=…`, **`requireAuth`** (account JWT), scoped by `req.auth.lk` |
| Cadence today | `src/App.tsx:948`, `:1319` | every CC `db:apply`, plus a 60s refresh |

`pushCcData` is already **generic over `table`** — it takes any table name and any row array. The `NS`
map at `src/lib/ccData.ts:215` only constrains `pushCcTable` (the helper that gathers rows from a typed
IPC namespace). **A health frame therefore needs no new endpoint, no new auth, and no new client
transport — it is a new `table` value on the channel that already runs.** That is the whole point.

### 1.1 · ⚠ The hazard this design had to solve — the tombstone sweep

`/c/ether-backend/src/index.js:2941-2949`: after upserting, the endpoint runs

```sql
UPDATE station_cc_data SET deleted_at = NOW() ...
 WHERE station_uuid = $1 AND table_name = $2 AND deleted_at IS NULL
   AND row_uuid <> ALL($3::text[])
```

**Every push tombstones every row of that `(station_uuid, table_name)` it did not just send.** That is
correct for a mirror of categories or clocks — one install owns the whole table. It is **wrong for
health frames**, because more than one machine can serve one station (that is precisely why a
*designated generator* exists). Machine A's push would tombstone machine B's frame, and the two boxes
would flap each other's rows out of existence roughly once a minute.

This is the one place where "extend the existing push" needs a deliberate decision rather than a reuse.

**Recommended — Option B: a `health` carve-out in the sync endpoint.** Skip the tombstone sweep when
`table === "health"`, and let health rows age out instead (a frame older than its own stated cadence is
already rendered as offline — §4). ~4 lines in `/c/ether-backend/src/index.js`, explicit and commented.

**Fallback — Option A: per-machine table names** (`health:<machine_id>`), which makes each machine the
sole owner of its own namespace and needs *zero* backend change. Rejected as the primary because the
read side (`?table=…`) takes one exact table name, so the page could not enumerate machines without a
new endpoint anyway — and if a backend change is needed regardless, Option B is the cleaner one.

**RULED 2026-08-18: Option B.** Built and deployed — see §11. (The paragraphs above are kept as written
so the reasoning behind the choice survives, not just the choice.)

### 1.2 · Identity — UUID, never a local integer

The frame is keyed by **`station_uuid`** and carries **`machine_id`**
(`%LOCALAPPDATA%\EtherMachine\machine-id`, the stable identity outside wiped paths). It must never
carry a local integer `station_id` as identity. This is the leak-guard ratchet: channels migrate
*toward* `stationUuid` and the baseline is never raised. `electron/audio-health.js:286` already emits
`uuid` alongside `stationId`, so the projection drops the integer rather than needing new plumbing.

---

## 2 · The frame — what one machine pushes for one station

One row per `(station, machine)`, `row_uuid = "<station_uuid>:<machine_id>"`. Everything below already
exists in-process; **this is a projection, not new measurement.**

| Field | Source (receipt) |
|---|---|
| `level`, `reason`, `levelSince` | `electron/audio-health.js:286` snapshot rows — the same GREEN/YELLOW/RED the in-app monitor shows, with its reason string |
| `mode` (`daemon` \| `in-process`) | `electron/audio-health.js:283` — the in-process banner condition |
| `engine` `{pid, uptimeSec, restartCount, pingMs}` | `electron/audio-health.js:284` |
| `framesPerSec`, `peak`, `activeDecks` | `electron/audio-health.js:287` |
| deck / on-air: `queueDepth`, `nextDeckReady`, `track`, `trackLeftSec`, `enginestate` | `electron/audio-health.js:288-290` |
| stream: `streaming`, `drainBps` | `electron/audio-health.js:290` (fed by `noteStreamStatus`, `electron/main.js:857`) |
| jingle overlay | `electron/audio-health.js:291` |
| processing trio: `inLufs`, `outLufs`, `rideGainDb`, `grDb`, `inPeakDb`, `outPeakDb`, `target`, `local`, `stream` | `audiod/engine.js:325-335` `procmeters` (its own ~15Hz channel, deliberately NOT the levels channel) — **sampled, not streamed**, see §3.3 |
| designated generator + last check-in | `designation:status` IPC, `electron/main.js:7994` |
| schedule runway (`runwayDays`, `throughDate`, `level`) | computed on demand, `electron/main.js:7875` |
| `observedAt` (machine clock), `cadence` (the machine's own current push interval) | new, per-frame — §4 depends on both |

**MEASURED size: 751–1,168 bytes per frame, 960 bytes average** (`node scripts/test-health-frame.js`,
which prints the exact wire JSON and its byte count). The pre-build estimate here was ~1.5 KB; the real
frame is smaller, and §3.2 below now carries the measured numbers rather than the guess.

### 2.1 · ⚠ Architecture check — runway

`electron/main.js:2027` marks `runway_history` **"LOCAL-ONLY BY CONSTRUCTION … deliberately absent from
synced-tables.js: runway is a per-machine observation of this machine's schedule … syncing it would
merge two machines' observations into one meaningless line."**

That ruling is about **the history table as a synced table**, where two machines' rows would merge into
one series. This design does **not** sync `runway_history`, and does not propose to. It pushes the
**current** runway value **inside a frame that is explicitly attributed to one machine**
(`row_uuid = station:machine`), so the two observations sit side by side and are never merged — which is
the exact failure the original ruling names.

I read that as respecting the ruling rather than contradicting it, **but it is adjacent enough that
Jeff should rule explicitly before I build it.** If he says runway stays off the wire entirely, the
field drops and the rest of the design is unaffected.

---

## 3 · (2) Push cadence and payload cost — honestly

### 3.1 · Two rates, and how the install learns which to use

- **Heartbeat (default): one frame per station per 60s.** Matches the CC refresh that already runs at
  60s (`src/App.tsx`), so the health push rides an interval the app is already keeping.
- **Watch mode: one frame per station per 5s**, for a 5-minute auto-expiring window.

The install cannot know a viewer is watching without being told. It is told over **the command bus that
already exists** — `POST /api/cmd` → SSE `/api/cmd-stream` → `execCmd` (CLAUDE.md, the proven
web→desktop rail). Opening the page posts a `health:watch` command for that license; installs raise
cadence and **let it lapse on its own** after 5 minutes. A closed tab, a crashed browser, or a dropped
SSE therefore returns to heartbeat by expiry rather than by needing a "stop" that might never arrive.

**No second channel is introduced in either direction:** frames go up the CC data push, the watch signal
comes down the command bus. Both already carry production traffic.

### 3.2 · What it actually costs

Per station, JSON at ~1.5 KB:

| Mode | Frames | Bytes |
|---|---|---|
| Heartbeat, one station, one day | 1,440 | **~1.38 MB/day** |
| Heartbeat, 4 stations (this account), one day | 5,760 | **~5.5 MB/day** |
| Watch, one station, 5-minute window | 60 | ~58 KB |
| Watch, 4 stations, 5-minute window | 240 | ~230 KB |

Measured at 960 bytes/frame, not estimated — see `scripts/test-health-frame.js`.

Each frame is one HTTPS POST and one Postgres upsert. At heartbeat that is 4 writes/minute for this
account — negligible against the library push (~5,600 rows, 1–1.5 MB in one shot, `src/lib/ccData.ts:56`).
**The honest caveat:** cost scales linearly with stations × machines, so a 40-station operator at
heartbeat is ~55 MB/day and 160 upserts/minute. If Ether ever sells at that scale the heartbeat drops to
5 minutes and watch mode carries the live view. Stated now so it is not a surprise later.

### 3.3 · The processing trio is SAMPLED, never streamed

`procmeters` runs at ~15 Hz. Pushing that to the cloud would be ~1.3M frames/day/station and is
categorically off the table. The frame carries a **1-second decimated sample** (last value plus the
window's peak) taken at push time. The web page therefore shows the trio's *current standing*, not a
live moving meter — **and it must say so on screen.** A bar that looks live but updates every 5s at best
is the same class of lie as a VU that moves on a stopped deck. The in-app Health Monitor remains the
place to watch the meters actually move.

---

## 4 · (3) Staleness — a dead machine must look dead

**The rule: staleness OVERRIDES the frame's own level. A stale GREEN never renders green.** This is the
whole point of the requirement, so it is enforced in one function, not sprinkled through the UI.

**Server time is the authority.** `station_cc_data.updated_at` is set by Postgres `NOW()` on every
upsert (`/c/ether-backend/src/index.js:2938`). Age is computed as `server_now − updated_at`, **never**
from the payload's `observedAt` — a machine with a wrong clock (or a deliberately skewed one) must not
be able to make itself look fresh. `observedAt` is still carried, and a large `observedAt`↔`updated_at`
gap is itself surfaced as a clock-skew warning.

Thresholds are relative to the machine's **own declared `cadence`**, so a heartbeat machine is not
called dead at 10 seconds:

| Age | State | Renders as |
|---|---|---|
| ≤ 2 × cadence | **LIVE** | the frame's own level (green/yellow/red) |
| 2–5 × cadence | **LAGGING** | amber, level dimmed, "last seen 3m 10s ago" |
| > 5 × cadence, or > 10 min absolute | **OFFLINE** | grey/struck-through, **level suppressed entirely**, "last seen 14m ago" |
| no frame ever | **NEVER REPORTED** | explicit — not silently omitted |

Every tile shows **"last seen Xs ago" as a permanent, prominent element** — not a tooltip, not on hover.
A station the account owns but which has never pushed is rendered as a tile saying so, because a missing
machine that simply vanishes from the page is indistinguishable from a healthy fleet.

---

## 5 · (1) AUTH — operational internals, not public

**Ruling applied: account login. No public mode, no share link, no read-only token, no soft option.**

- The page requires the **same account login the dashboard uses**: `POST /api/auth/owner-login`
  (email + password), which is the login that mints a token carrying the **`lk`** license claim
  (`/c/ether-backend/src/index.js:2344,2355`). Note this is NOT `/api/user/login` — that one signs
  `{uid, email, typ:"user"}` with **no `lk`** (`index.js:1902`) and would 401 against this read.
  Named precisely because picking the wrong one of the two looks identical until it fails.
  The read endpoint is already `requireAuth` and already scopes by `req.auth.lk`
  (`/c/ether-backend/src/index.js:2956,2963`), so a signed-in account can only ever read its own
  stations' rows. No new authorization surface is invented.
- The Pages Function **forwards the `Authorization` header** to Railway and returns the response. It
  performs no auth of its own and holds no secret.
- **⚠ Two rules the listener's Functions break, which this page must not inherit.** The listener proxy
  at `/c/ether-listener/functions/api/station/[slug].ts` sets `access-control-allow-origin: *` and
  `ctx.waitUntil(cache.put(...))` with a 60s edge TTL. That is correct for public station metadata and
  **catastrophic for authed fleet data** — edge-caching an authenticated response can serve one
  account's fleet to another. The health Function therefore sets **`cache-control: no-store`, no
  `caches.default` use, and an explicit origin** (not `*`). Called out because copying the neighbouring
  file is the obvious way to build this and is exactly the wrong move.
- The account JWT is unrelated to `x-license-key`: the license key authenticates **machines pushing up**,
  the JWT authenticates **a human reading down**. They stay separate.

---

## 6 · The fleet read

`GET /api/account/station/:uuid/data?table=health` already exists and needs no change — but it is
per-station, so a 4-station account is 4 round trips plus a station list.

**Recommended:** one new backend endpoint, `GET /api/account/health` (`requireAuth`), returning every
health row for every station of `req.auth.lk` in one query. ~20 lines, one indexed read
(`WHERE table_name = 'health'` joined to stations by license). **Zero-change fallback:** the page pulls
`/account/connect` for the station list and fans out to the existing per-station endpoint — more round
trips, no backend edit. Recommending the endpoint; the fallback keeps the page buildable if Jeff would
rather not touch the backend yet.

---

## 7 · (4) Wrangler config and the deploy command — fires only on GO

New Pages project **`ether-health`**, built like the listener (Vite + `functions/`). Note the listener
carries **no `wrangler.toml`** — it deploys by flags (see `C:\openair\ec-deploy.sh` for the ether-cast
equivalent). A config file is proposed here because this project needs pinned compatibility settings and
an explicit env var:

`wrangler.toml`
```toml
name                   = "ether-health"
pages_build_output_dir = "dist"
compatibility_date     = "2026-08-18"

[vars]
BACKEND = "https://ether-backend-production.up.railway.app"
```

`functions/api/fleet.ts` — forwards `Authorization` to `${BACKEND}/api/account/health`, returns JSON
with `cache-control: no-store` and an explicit allowed origin. No caching, no secrets, no auth logic.

**Deploy command — NOT run until Jeff says GO:**

```bash
cd /c/ether-health && npm run build && npx wrangler pages deploy dist --project-name ether-health
```

Custom domain (e.g. `health.ether-technologies.com`) is attached in the Cloudflare dashboard, matching
how the other Pages projects are wired.

---

## 8 · Build order, once approved

1. Backend: the `health` tombstone carve-out (§1.1) + `GET /api/account/health` (§6). **Deploy to
   Railway is itself a GO-gated step.**
2. Desktop: assemble the frame (§2) and push it as `table: "health"` through the **existing**
   `pushCcData`; heartbeat 60s; honour `health:watch` from the command bus for the 5s window.
3. Web: the Pages app + Function, staleness rule (§4) implemented in one place and unit-tested against
   fabricated ages **before** any live data is trusted.
4. Gates: `npx tsc --noEmit` **0 errors** (both trees), `npm run build`, `node --check` on touched
   main-process files.

**Dev-verifiable without deploying:** the frame is inspectable locally the moment step 2 lands — the
push is logged (`[CCPUSH] health sync → HTTP …`, `src/lib/ccData.ts:24`) and the stored row can be read
straight back through the existing authed per-station endpoint. The staleness rule is testable with no
cloud at all, by feeding it fabricated `updated_at` values.

---

## 9 · Open decisions for Jeff — build starts after these

1. **§1.1 — tombstone carve-out (Option B, recommended) vs per-machine table names (Option A).** This
   one is blocking: without a decision, two machines on one station erase each other.
2. **§2.1 — is pushing the current runway value inside a per-machine frame within the "runway is
   local-only" ruling, or does runway stay off the wire?**
3. **§6 — new fleet endpoint (recommended) vs fanning out to the existing per-station read.**
4. **§3.1 — is a 5-minute auto-expiring watch window the right trade**, or should the live view be
   viewer-driven SSE from the backend instead (more moving parts, no install change)?

**All four were ruled on 2026-08-18** — see the Status block at the top. Build followed; §10 records it.

---

## 10 · What was built (2026-08-18) — deployed nowhere

| Tree | File | What |
|---|---|---|
| ether-backend | `src/index.js` | the `table !== "health"` tombstone carve-out (§1.1, Option B) |
| ether-backend | `src/index.js` | `GET /api/account/health` — LEFT JOIN so a never-reporting station still returns; `age_sec` + `server_now` from the DB clock |
| openair | `electron/health-frame.js` **(new)** | the frame builder — pure, no Electron, no DB |
| openair | `electron/main.js` | `_procLast` 1s decimation of `procmeters` + the `health:frames` IPC |
| openair | `src/lib/ccData.ts` | `pushHealthFrames()` — one push per station, table `"health"` |
| openair | `src/App.tsx` | the 60s/5s push loop + the `health:watch` command case |
| openair | `scripts/test-health-frame.js` **(new)** | 12 tests; prints the wire JSON and measures payload size |
| ether-health | whole tree **(new)** | Vite/React page, `functions/api/fleet.ts`, `wrangler.toml`, `src/staleness.js` + 24 tests |

**Gates, all green:** `npx tsc --noEmit` 0 errors (openair **and** ether-health) · `npm run build` clean
(both) · `node --check` on `electron/main.js`, `electron/preload.js`, `electron/health-frame.js` and the
backend's `src/index.js` · `node scripts/test-health-frame.js` **12/12** ·
`node test/staleness.test.mjs` **24/24**.

**Two notes on what the build changed about the design:**

1. **The frame is smaller than estimated.** Measured 751–1,168 bytes, 960 average — §2 and §3.2 now
   carry the measured figures, not the pre-build guess.
2. **The login endpoint is named precisely now.** `/api/auth/owner-login`, not `/api/user/login` —
   only the former mints a token carrying `lk`, which is what the read scopes by. §5 records both.

**Still unverified end-to-end: no frame has made the full trip to Postgres.** Everything above is
proven at the unit level and by build — that is not the same thing as a round trip, and this line stays
until one has happened.

---

## 11 · Backend deploy — DONE 2026-08-19 (GO given)

`ether-backend` is **repo-connected on Railway** (`railway status` → `repo: jwjens/ether-backend`), so
a push to `main` IS the deploy. `railway up` was deliberately NOT used: it ships local bytes and would
leave production drifted from the repo.

| | |
|---|---|
| Commit | `f8bf988` — *feat(health): fleet health frames…* (only `src/index.js`; unrelated scratch scripts left unstaged) |
| Push | `bd80938..f8bf988` → `main` |
| Railway | project `brave-simplicity`, service `ether-backend`, env `production` |
| Deployment | `0f0043d1` → **`edcec51c`**, status ● Online |

**Verified on the live host, not assumed:**

| Probe | Before | After |
|---|---|---|
| `GET /api/account/health` (no token) | `404 Cannot GET` | **`401 {"error":"missing_token"}`** |
| `GET /api/account/health` (bad token) | — | **`401 {"error":"invalid_token"}`** |
| `GET /health` | 200 | **200** |
| `GET /api/account/station/:uuid/data` (no token) | 401 | **401 `missing_token`** |
| `POST /api/account/data/sync` (no key) | 401 | **401 `missing_license_key`** |

The 404 → 401 transition is the receipt that the new route is live and authed; the last two rows are
the receipt that the existing Control Center mirror is untouched.

**What is still NOT proven:** no health row has been written or read yet — that needs a desktop dev
restart so the push loop actually runs. The endpoint answering 401 proves it exists, not that a frame
survives the round trip.

---

## 12 · Pages deploy — DONE 2026-08-19 (GO given)

Cloudflare Pages project **`ether-health`** created as a **direct-upload** project (like `ether-cast`;
`ether-dashboard`/`ether-listener` are git-connected, this one is not), production branch `main`.

```
npx wrangler pages project create ether-health --production-branch main
npm run build && npx wrangler pages deploy          # uses pages_build_output_dir from wrangler.toml
```

Deployment `b6c5a7ed`, 2 assets + the Functions bundle ("Compiled Worker successfully").

**Verified on the live page, not assumed:**

| Probe | Result |
|---|---|
| `GET /` | **200**, and `<meta name="robots" content="noindex, nofollow">` is present |
| `GET /api/fleet` no token | **401 `{"error":"missing_token"}`** — the Function's own refusal, no upstream call |
| `GET /api/fleet` bad token | **401 `{"error":"invalid_token"}`** — this is the BACKEND's error string, so the Function reached Railway and returned its answer: the full Pages→Railway chain is proven |
| Response header | **`Cache-Control: no-store`** |
| Response header | **`Access-Control-Allow-Origin: https://health.ether-technologies.com`** — the fixed origin, never `*` |
| Response header | **`Vary: Origin, Authorization`** |

The last three are the §5 rules holding in production: an authenticated fleet response is never edge-
cached and never wildcard-origin, which is precisely where copying the listener's Function would have
gone wrong.

**Two things still outstanding:**

1. **Custom domain.** `health.ether-technologies.com` must be attached to the `ether-health` project in
   the Cloudflare dashboard — a console action, not a wrangler one. Until then the page answers on
   `ether-health.pages.dev`. The page fetches its own origin, so it works there today; the hardcoded
   allowed origin only matters once the custom domain is the one in use.
2. **The round trip is still unproven.** Signing in will show the account's stations, but every one of
   them will render as "No machine is reporting this station" until a desktop with the new push loop
   actually runs — which needs a dev restart. That empty state is the design working, not a fault.

> Note (incidental, not acted on): `wrangler pages project list` shows `ether-cast` serving
> **ethercast.ether-technologies.com** and `ether-listener` serving **listen.ether-technologies.com**,
> which settles the cast/listener domain caveat recorded in CLAUDE.md's project map.

---

## 13 · ROUND TRIP PROVEN — 2026-08-19

The line that stood through §10, §11 and §12 — *"no frame has made the full trip to Postgres"* — is now
retired. Read-only query against production (`railway run --service Postgres`, SELECT only):

```
station_cc_data by table:
      19  categories    newest 2026-08-19T11:42:02Z (18s ago)
       7  clocks        newest 2026-08-19T11:42:02Z (18s ago)
      99  clock_slots   newest 2026-08-19T11:42:02Z (18s ago)
       2  health        newest 2026-08-19T11:41:34Z (46s ago)
    3335  library       newest 2026-08-19T11:42:02Z (18s ago)
       5  shows         newest 2026-08-19T11:42:02Z (18s ago)
       5  spots         newest 2026-08-19T11:42:02Z (18s ago)

health rows: 2
  halloVeen    · GREEN · mode=daemon · cadence=60s · 1194B · 46s ago
     43889edc-203d-4743-9e4f-6ea311d6e035:8e8f6181-b68a-433f-a93d-8005787b641b
  Open Format  · GREEN · mode=daemon · cadence=60s · 1229B · 46s ago
     75532b61-fa0c-4bc5-a5f0-0298b94c0123:8e8f6181-b68a-433f-a93d-8005787b641b
```

**What this proves:** the install assembles the frame, pushes it as table `"health"` on the existing
Control Center channel, the backend accepts and stores it, `row_uuid` is `station:machine` as designed,
and `cadence` rides along for the staleness rule. The heartbeat rate (60s) is correct for "no viewer
connected". `mode=daemon` is honest — the daemon is up.

**What it also proves incidentally:** the carve-out broke nothing. Every other table pushed 18 seconds
before the query, so the reconcile sweep still runs normally for the tables that own themselves.

**What it does NOT prove — stated because the distinction is the whole reason §1.1 exists:** both rows
carry the SAME `machine_id` (`8e8f6181…`). Two machines coexisting on ONE station — the case the
tombstone carve-out was written for — has not been exercised. Different stations were never at risk
from each other: they are different `station_uuid` keys, so the sweep could not have touched them even
without the carve-out. **The carve-out remains unproven in the field until a second machine reports on
a station this one also reports on.**

### 13.1 · Correction to the payload figures

Real frames measure **1,194 and 1,229 bytes** — above the 751–1,168 / 960-average figures §2 and §3.2
carry, which came from `scripts/test-health-frame.js` with short synthetic station names and track
titles. Real station names, real track titles and a populated designation `text` add ~250 bytes.

**Corrected cost at the real size (~1.2 KB):** one station at heartbeat ≈ **1.73 MB/day**; four stations
≈ **6.9 MB/day**; a 40-station operator ≈ **69 MB/day**. Still small, and the shape of the §3.2
conclusion is unchanged — but the numbers there are the synthetic ones and these are the real ones.
