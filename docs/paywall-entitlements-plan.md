# Paywall & entitlements plan — EtherCast

**Date:** 2026-10-05 · **Type:** READ-ONLY audit + design. No code, schema, data, Stripe, R2 or Icecast change. No commits.
**Trees:**
- `C:\openair` @ `6b2dcba` (v4.6.57)
- `C:\ether-backend` @ `2081013` (deployed)
- dashboard, admin, signup, listener, cast and website repos as found on disk

**Method and receipts:**
- Three read-only search agents swept the desktop feature inventory, plan gating across repos, and Stripe usage. I re-verified the load-bearing claims myself; those are marked ✔.
- Prod facts come from read-only aggregate scripts (scratchpad `paywall-totals.js`, `licenses-cols.js`). They printed totals only and touched no account rows individually. Accounts 21 and 23 appear only inside totals.
- Anything not proven by code, schema or command output is marked **UNVERIFIED**.

**Pricing model (it must live in config, never in code).** Revised 2026-10-05: "Free" is replaced by a paid **Local** license, and every hosted plan includes Local. **Revised 2026-10-29 (Rulings, below): there is no free plan anywhere; every new account starts with a 15-day full trial, no card; Local is $9/mo or $90/yr.**

| Plan | Price | Hosted streams | Max bitrate | Concurrent listeners | Other |
|---|---|---|---|---|---|
| **Local** | **$9/mo or $90/yr** (annual = 10 months' price); **15-day full trial, no card** | 0 | — | — | the full desktop app (everything local, customer's own Icecast, the typed-address Remote Link) **plus updates**; no cloud features |
| Station | $25/mo per hosted stream (**includes Local**) | 1 per unit | 128 kbps | 50 per stream | cloud features |
| Pro | $49/mo per hosted stream (**includes Local**) | 1 per unit | 320 kbps | 150 per stream | cloud features, priority support |
| Unlimited | $79/mo (**includes Local**) | unlimited | (Pro: 320) | 250 **shared across the account** | cloud features |

> **LAPSE RULE (hard requirement).** When a trial ends or a payment fails, **playout, scheduling and on-air audio keep working with no interruption.**
> - **Allowed effects only:** (1) a reminder banner; (2) no new updates; (3) cloud features stop after the grace period.
> - **Never:** stop audio, block or alter a log, block startup, or show a blocking modal for billing reasons.
> - §4.8 designs the entitlement cache around this rule. Every phase in §6 carries a "lapse-safe" acceptance test.
| Add-on | +$10/mo | — | — | +50 per unit | stackable |

Discounts: 20% for 3+ stations; annual billing = 10 months' price.

**No free plan** (2026-10-29): no Free, no Solo, no $0 tier on any surface. Every new account starts on the 15-day full trial with no card.

---

## 0. Blockers found during the audit (must be fixed before any paid launch)

These aren't design questions. Billing is broken or bypassable today.

| # | Finding | Receipt | Effect |
|---|---|---|---|
| **B1** | **The prod `licenses` table has no `stripe_sub_id` column.** It has `stripe_subscription_id` and `stripe_customer_id` (a pre-existing table; `CREATE TABLE IF NOT EXISTS` at `index.js:280-290` was a no-op and nothing adds `stripe_sub_id`). Every statement using it fails | ✔ catalog dump of `licenses`; my own read-only query failed with `column "stripe_sub_id" does not exist`; code at `index.js:3684`, `:3707`, `:5007`, `:5015`, `:5051`, `:5067`, `:5085` | **The Stripe webhook can't issue, link, reactivate or deactivate any license.** `/api/account/billing` and `/billing/portal` fail. Runtime effect (5xx back to Stripe, followed by retries) is **UNVERIFIED** against the Stripe delivery log, but every one of those SQL statements will error |
| B2 | `invoice.payment_failed` deactivates `WHERE stripe_sub_id = event.data.object.id`. That id is the **invoice** id, so it can never match | `index.js:5083-5087` (✔ read) | Failed payments never revoke anything, even after B1 is fixed |
| B3 | `customer.subscription.updated` isn't handled | webhook branches `index.js:4955-5090` (✔) | A plan change made in the Stripe portal never changes `licenses.plan` |
| B4 | **Client-side tier grants ship in production builds.** `ADMIN_KEYS` maps five hardcoded strings to `station`/`pro` and writes `install_config_kv.plan_tier` with no server call. An owner key also unlocks the dev tier picker, up to `operator` | ✔ `openair/src/components/SubscriptionPanel.tsx:101-116`; `usePlan.tsx:76-82`; `src/lib/devAccess.ts:8-24` | Anyone who reads the bundle can unlock every UI-only gate |
| B5 | **The desktop UI and the desktop main process read the tier from different stores.** The UI reads `install_config_kv.plan_tier`; all four main-process R2 gates read `station_config_kv` (`… WHERE key='plan_tier' LIMIT 1`, no station filter) | ✔ `usePlan.tsx:71-73`; ✔ `electron/main.js:9396`, `:12325`, `:12582`, `:12948`; `electron/cloud-backup.js:416` | The UI and the enforcing code disagree after any tier change. The paid UI can show while main refuses, or the reverse |
| B6 | `userEntitlement` checks only `licenses.active`, never `expires_at` | ✔ `index.js:2017-2021` | A trial user who activated the desktop reads as "active/station" forever on the account page |
| B7 | **[DATA FIX CANCELLED — Rulings R3: code exemption, no data writes]** **6 of the 8 active licenses carry an `expires_at` already in the past**, including 2 `station_lifetime` | ✔ `paywall-totals.js`: `free 2/2 expired`, `station 2/2`, `station_lifetime 2 of 4` | `lookupLicense` rejects an expired row (`index.js:1043`), so those licenses fail every key-based cloud call today. Memory records the same class of bug ("paid licenses MUST have expires_at NULL"). Whether these specific rows should be lifetime is a Jeff decision (§5) |
| B8 | Lifetime purchase links in the desktop are placeholders (`buy.stripe.com/pro-lifetime`, `/station-lifetime`), and no lifetime price maps to a plan | `SubscriptionPanel.tsx:14-15`; `PLAN_BY_PRICE_ID` `index.js:914-919` | A lifetime purchase opens a broken URL, and even a working one would issue no license |
| B9 | Displayed prices and plan names are hardcoded in seven or more places and already disagree. The website source says $29/$99; everything else says $19/$79. Trial length is 14 days in some places and 15 in others. The dashboard says "Operator", everything else says "Enterprise" | Stripe sweep §1/§6: website `index.html:7-8`, `:447`; desktop `SubscriptionPanel.tsx:493-733`, `usePlan.tsx:146`, `NowPlaying.tsx:92-93`; signup `AccountView.tsx:13-16`; backend email `index.js:1005-1006`; dashboard `AccountInfo.tsx:8-9` | This violates the config-only requirement |

| **B10** | **The trial-end lock today is a full-screen overlay over the on-air UI** (`position:fixed; inset:0; zIndex:9999`, blurred backdrop). It fires on launch and on a 10-minute check, and downgrades the tier on the spot | ✔ `openair/src/components/TrialGate.tsx:31-35` (lock), `:47-52` (overlay) | Audio continues, but the operator can't reach a cart, a deck or the log until they dismiss it. **This violates the lapse rule** and must become a non-blocking banner |
| **B11** | **Updates are served from public GitHub Releases** (`jwjens/ether`), fetched on demand by electron-updater | ✔ `electron/main.js:7640-7665`; `electron-builder.json:112-117` | "No new updates on lapse" can only be a **client-side** gate unless the feed moves behind the backend. Anyone can download the installer from GitHub. See §4.8 |

Separately noted, one line each, not investigated:
- The desktop calls `POST /beta/apply` and `POST /feedback`, which don't exist on the backend (✔ no route in `index.js`), so they 404.
- The desktop "Downgrade to Free" button only changes local state and never cancels Stripe (`SubscriptionPanel.tsx:220-225`).

---

## 1. Feature inventory

Legend:
- **L** = local, works with no network.
- **C** = cloud.
- **M** = mixed.

"Resources" names what the feature costs Ether to run.

### 1a. Desktop app (`C:\openair`)

| Feature | L/C | Ether resources used | Receipts |
|---|---|---|---|
| Playout, decks, automation, log fill, scheduler | L | none (daemon + native engine + SQLite) | `audiod/engine.js`, `audiod/loggen.js:1-5`; menu `src/App.tsx:2724`, `:2985` |
| Library (browse, edit, cue, import) | M | local by default; R2 fetch on a missing file (`/audio/download-url`); `/library/snapshot` + `/changes` metadata pull while signed in | `electron/main.js:9386-9426`, `:3268-3282`; `electron/sync/library-client.js:72`, `:91` |
| R2 background prefetch / library health | C | R2 signed GET | `electron/library-health.js:888`, `:894` |
| Categories, clocks, shows, Schedule Manager, Program Log | L (also mirrored, see Control Center) | none | `src/App.tsx:2734-2736`, `:3162-3163`, `:3178` |
| Play log, affidavit CSV, rotation and listener analytics (desktop) | L | none (SQL over `play_log`) | `src/components/Logs.tsx:256-312`; `ListenerAnalytics.tsx:176-275` |
| Carts, sweepers, spots, announcements, imaging | L | none | `src/App.tsx:2729`, `:2737-2738` |
| Show+ DAW / StudioPro / editors | L | none (MusicBrainz is optional and third-party) | `StudioPro.tsx:1433`; `TrackEditor.tsx:797` |
| **Show+ remote guests** | C | Ether signaling `wss://guests.ether-technologies.com/signal` (Lightsail); invite email via `/invite/send` (Resend) | `ShowPlus.tsx:432`, `:1182`, `:1267` |
| Video Studio (RTMP to the user's own YouTube/Twitch) | L | none | `VideoEnginePanel.tsx:22-27`; `electron/video-engine.js:99` |
| PhoneDesk, broadcast delay, audio processing, meters | L | none | `PhoneDesk.tsx:495`; `electron/main.js:5551-5555`; `SettingsPanel.tsx:803` |
| **Icecast Go Live** | **L if the user's own server; C if Ether's box** | ffmpeg `icecast://source:<pw>@<server>:8000<mount>`. The default server is **Ether's Lightsail box `44.244.52.207`** with fallback password `hackme` | ✔ `audiod/stream.js:64-70`; `electron/main.js:11701-11750`, `:2060-2063`, `:11857-11859` |
| Stream bitrate | L (client config only) | the bitrate comes from station config, default 128; **nothing enforces it server-side** | ✔ `audiod/stream.js:69`; `electron/main.js:2063` |
| **Public listener page editor** | C | `/api/station/:uuid/metadata`, `/api/slugs/check`, logo upload to the public R2 bucket. The editor **forces** the stream URL to `https://stream.ether-technologies.com:8443/<mount>` | `electron/station-metadata.js:45-101`; `SettingsPanel.tsx:1641`, `:1836-1846` |
| Account hub handle + logo | C | `/api/user/account-slug`, logo upload to public R2 | `StationManager.tsx:38-109` |
| **Cloud backup (whole DB to R2)** | C | `/backup/upload-url` + R2 PUT; `/backup/download-url` (install-from-cloud); legacy list/download/delete | `electron/cloud-backup.js:90`; `electron/main.js:6730`, `:6880`; `CloudBackup.tsx:237`, `:292`, `:341` |
| **Catalogue / audio files to R2** | C | `/audio/upload-url`, `/audio/download-url`, `/audio/delete`, R2 storage (the largest Ether cost) | `electron/main.js:12455-12566`, `:11212`; `electron/audio-library-r2.js:47` |
| **Multi-device sync** | C (opt-in) | `/sync/mutations`, Postgres `mutations` (~215k rows) | `electron/main.js:3289-3330`; `electron/sync/transport-http.js:65-106` |
| LAN site replication | L (LAN peer) | none | `electron/site-replication.js:217` |
| **Control Center mirror** (categories, clocks, shows, spots, library, health, ops) | C | `/api/account/data/sync` every 60s, Postgres `station_cc_data` | `src/lib/ccData.ts:23`, `:226-244`; `src/App.tsx:1052-1068` |
| Health Monitor (desktop) | L | none | `src/components/HealthMonitor.tsx` |
| Fleet health frames (web) | C | same mirror endpoint, table `health` | `ccData.ts:41-53` |
| Play-history push (feeds web analytics) | C | `/api/account/play-history` | `ccData.ts:506` |
| Staged programming import | C | `/api/account/station/:uuid/staged/*` | `ccData.ts:674`, `:712` |
| Install users push | C | `/api/account/users/sync` | `src/lib/syncUsers.ts:26` |
| **Now-playing push** | C | `POST /api/now-playing` every 3s (20s keepalive); now-playing art to public R2 | `electron/main.js:8487-8528`; `electron/now-playing-art.js:61` |
| **Web remote / command bus** | C | SSE `/api/cmd-stream`, `/api/cmd/ack` | `src/App.tsx:1307`, `:1756`, `:1787` |
| Local REST / LAN remote / Iris bridge (:3400) | L/LAN | none | `electron/main.js:8551-8809` |
| Iris assistant | L + third party | LLM calls use the **user's own** Anthropic/OpenAI/Gemini key; no Ether cost | `electron/main.js:7751-7800`, `:8595-8602` |
| **Jukebox** (pool, lobby state, guest requests, donations onboarding) | C | `/api/account/jukebox/*`, public `/public/jukebox/*`, command bus, Stripe Connect (phase 2 only) | `ccData.ts:113`, `:159-213`; `Jukebox.tsx:75`, `:727` |
| **Park Ops** | C | `/api/ops/token`, mirror tables, public `/public/ops/*`, command bus | `ccData.ts:252-365` |
| **Remote Link pairing** | M | the feed is direct UDP machine-to-machine (no Ether cost); pairing uses `/api/link/*`; an offline paste fallback exists | `audiod/link.js:1-40`; `electron/link-pairing-client.js:32-81` |
| HA watchdog, GPIO, live captions (local Whisper) | L | none | `watchdog/watchdog.js:1-41`; `electron/gpio-engine.js`; `electron/whisper-engine.js` |
| AI voice, artwork/lyrics/weather lookups | third party, user keys | none | `electron/ai-voice.js:111-154`; `electron/artwork-cache.js:136` |
| Sign-in / onboarding / license / seats / memberships | C (14-day offline grace in the license guard) | `/account/*`, `/api/user/*`, `/validate`, `/api/me/*` | `OnboardingFlow.tsx:232-1113`; `src/lib/licenseGuard.ts:14-15`, `:140` |
| Local operator profiles | L | none | `UserLogin.tsx` |
| Auto-update | C (GitHub Releases, not Ether's backend) | GitHub | `electron-builder.json:112-117` |
| Stream metadata fan-out; Ether2Go mobile | **UNVERIFIED** (the modules look unwired) | — | `electron/metadata-dispatcher.js`; `electron/mobile-app.js` |

### 1b. Web surfaces and backend-hosted features (all **cloud**)

| Surface | What it does | Backend routes / resources | Receipts |
|---|---|---|---|
| Control Center dashboard (`app.ether-technologies.com`) | station list, mirrored data view and edit, analytics, affidavit, listeners, health, billing card, user management | `/api/account/*`, `/api/auth/*`, `/api/cmd` | `index.js:2504-2700`, `:3068-3175`, `:3484-3676`, `:3682-3723` |
| Web remote (in dashboard) | station controls aimed at the sourcing machine | `/api/cmd`, `/api/cmd/ack/:id` | `index.js:6513-6579`; `src/lib/station-commands.js` |
| Listener pages (`listen.ether-technologies.com`, `ether-cast`) | public directory, station page, account hub, SSE now-playing, recent plays, embeds | `/public/*` (`index.js:5225-5805`); listener sessions and samples in Postgres; Icecast `status-json.xsl` polling every 60s | `index.js:6852-6877` |
| Managed Icecast (`stream.ether-technologies.com:8443`, Lightsail) | hosted streams `/ov`, `/usph`; 5 public stations today | Lightsail box | `paywall-totals.js`: `public_pages=5 on_managed_host=5 licenses_on_managed=2` |
| `/mobile`, `/companion`, `/dashboard`, `/emergency`, `/console` pages | OV companion pages reading the **global** now-playing slot (audit H1) | `index.js:3727-3732`, `:5185-5202` | — |
| Jukebox phone pages / lobby | public requests, pool and state | `/public/jukebox/*` | `index.js:6088-6476` |
| Park Ops page (`park.ether-cast.com`) | closing time, carts | `/public/ops/*` | `index.js:5450-5714` |
| Platform console (`ether-admin`) | cross-account admin, licenses, rollups | `/api/platform/*` | `index.js:1268-1960` |
| Signup app | signup, trial, checkout | `/api/user/*` | `index.js:2044-2361` |
| Members / RBAC | multi-user accounts | `/api/accounts/:id/*`, `/api/me/*` | `index.js:2773-2993` |

**Prod usage footprint today** (count of active licenses using each cloud feature, from `paywall-totals.js`):
- sync: 1
- Control Center mirror: 3
- now-playing (last 30 days): 1
- play history: 1
- jukebox: 1
- Park Ops: 1
- library v2: 1
- RBAC memberships: 0
- link keys published: 1
- Connect accounts: 0

**Listener load:** max per-stream peak over 30 days = **3**; max concurrent across all mounts = **15**; no stream ever exceeded 50.

---

## 2. Current gating — every plan/tier/status check

### 2a. Server-enforced (backend)

| Gate | Where | Required | Receipt |
|---|---|---|---|
| `requireLicense` → `PAID_PLANS` (pro, pro_lifetime, station, station_lifetime, operator) | `/sync/*`, `/library/*` (via `requireLicenseOrMember`), `/api/pending-cmds`, legacy `/backup/*` | any paid tier | ✔ `index.js:941`, `:1078-1087`, `:6626`, `:6662-6725`, `:6826`, `:6830` |
| Command bus | `/api/cmd` (license path), `/api/cmd-stream` | paid | ✔ `index.js:6524`, `:6588` |
| Multi-device devices list | `POST /account/devices` | station, station_lifetime, operator | ✔ `index.js:4883-4884` |
| Station count cap | `/account/add-station`, `/account/register-station` | free 1, paid 5, operator unlimited | ✔ `index.js:929-936`, `:4227`, `:4349` |
| Seat/machine caps | `/validate`, desktop-activate (free 1, others 5); `/account/*` SEATS_MAX 5 | — | ✔ `index.js:269`, `:276`, `:2299`, `:4045` |
| Expiry | `lookupLicense` treats a past `expires_at` as no license, which fails every key-based call | — | ✔ `index.js:1038-1043` |
| Account-page entitlement | `userEntitlement` (active, else trial, else expired); **ignores `expires_at`** (B6) | — | ✔ `index.js:2017-2027` |

**Not gated by plan on the server (any valid license, including `free`, passes):**
- R2 audio signing: `/audio/upload-url`, `/audio/download-url`, `/audio/list`, `/audio/delete` (`index.js:4496-4742`)
- R2 DB backup signing: `/backup/upload-url`, `/backup/download-url` (`:4770-4871`)
- Control Center mirror push: `/api/account/data/sync` (`:2998`)
- now-playing, play history, users sync
- public page metadata and logo upload (`:5858-6028`)
- jukebox and payouts (`:6050-6349`)
- Park Ops token (`:5532`)
- Remote Link pairing (`requireUser` only)
- all dashboard JWT routes (`/api/account/*`)

The paid boundary for the largest cost (R2 storage) is enforced **only in the desktop main process** (2b), and that copy has B4 and B5.

### 2b. Desktop (`C:\openair`)

| Gate | Tier | Enforcement | Receipt |
|---|---|---|---|
| Listener Analytics panel (`PlanGate`) | pro+ | UI only | `src/App.tsx:3198-3202` |
| Cloud Log Backup panel | pro+ | UI, plus main `cloud-backup.js` (tier_insufficient) | `App.tsx:3203-3207`; `electron/cloud-backup.js:71-77`, `:207-209`, `:268-276` |
| Multi-output audio routing | pro+ | **UI only** | `App.tsx:3208-3212` |
| Multi-station console | station+ | UI, plus the backend station cap | `App.tsx:3213-3217`; `StationManager.tsx:185` |
| Pop-out windows for the three panels above | pro+ | as above | `PopoutRenderer.tsx:311-317` |
| NexGen / ENCO import | station+ | **UI only** | `App.tsx:4913`, `:5617-5619` |
| PDF traffic report | pro+ | **UI only** | `ProgramLog.tsx:336`, `:850-860` |
| Station switcher badge / New Station | station+ | UI, plus the backend cap | `ActiveStationBadge.tsx:20`, `:76`, `:177` |
| Onboarding "From the cloud" | station+ | UI, plus main `_catalogueR2Gate` | `OnboardingFlow.tsx:2399-2572`; `main.js:12580` |
| R2 track fetch / library upload and download / catalogue backup | station+ | main process (reads `station_config_kv`, B5) | ✔ `main.js:9386-9399`, `:12321-12328`, `:12580-12588`, `:12938-12951` |
| End-of-trial lock (TrialGate) | trial → free | client, every 10 min; can be overwritten by the `/account/connect` reconcile | `TrialGate.tsx:8-41`; `ccData.ts:862-881` |
| License re-validation | — | writes `license_state`, which nothing reads; never downgrades | `licenseGuard.ts:88-165` |
| Client tier grants (`ADMIN_KEYS`, owner dev picker) | any | **client only (B4)** | ✔ `SubscriptionPanel.tsx:101-116`; `usePlan.tsx:76-82` |

**Upgrade UI today:** `UpgradePrompt` / `PlanGate` (`usePlan.tsx:140-241`) fire `ether:open-subscription`, which opens the Subscription panel (`App.tsx:1269-1274`). Other locks are inline 🔒 buttons (`App.tsx:5619`, `ProgramLog.tsx:860`).

### 2c. Web repos
- dashboard, admin and signup: display only (plan labels, billing card, tier mint/change in admin, checkout in signup).
- ether-listener, ether-cast: no gating. The listener has a "paywall that comes next" comment at `src/api.ts:225`.

---

## 3. Stripe today

- **Prices:** `PRICE_PRO`, `PRICE_STATION` (env, `env.example:1-5`), mapped to `pro` and `station` in `PLAN_BY_PRICE_ID` (`index.js:914-919`). The actual amounts are **UNVERIFIED** (not in code). `GET /api/platform/diag` (`:1280-1305`) would list them.
- **Lifetime and operator:** no Stripe products; admin-issued only (`index.js:911-913`).

**Checkout paths:**
1. **Signup app:** `POST /api/user/checkout` (subscription, `client_reference_id = user.id`, `metadata.plan`; `index.js:2339-2361`). It sells pro or station.
2. **Desktop:** opens `buy.stripe.com` payment links with no customer reference (`SubscriptionPanel.tsx:12-13`, `:83-98`). The customer pastes the emailed key. The lifetime links are placeholders (B8).
3. **Portal:** `/api/account/billing/portal` (broken by B1).

**Webhook `POST /webhook/stripe`** (`index.js:4955-5090`):
- It verifies the signature and ignores connected-account events (`:4992-4995`).
- **Branch A** (checkout with a client reference): upserts the license by `stripe_sub_id`, then links `users.license_key_id`.
- **Branch B** (session or `invoice.payment_succeeded` with no reference): maps the price id to a plan, inserts the license, and emails the key transactionally.
- **Revoke:** on `customer.subscription.deleted` or `invoice.payment_failed`, it sets `active=false` (B2 bug). **No grace period in code.** Dunning length is whatever Stripe retries do (**UNVERIFIED**).

All branches are broken by B1. In prod, **0 active licenses are Stripe-linked** (`stripe_subscription_id` is null on all 8), so no live subscription has to be migrated.

**Jukebox donations:**
- Stripe Connect Standard onboarding, own webhook (`/webhook/stripe/jukebox`, handles only `account.updated`).
- Nothing charges (`index.js:6198-6204`).
- 0 connected accounts in prod.

---

## 4. Proposed entitlements design

### 4.1 Principles (non-negotiable)
1. **The server is the source of truth for cloud entitlements.** The desktop never decides a cloud entitlement on its own, and every cloud endpoint enforces on the server.
2. **Local features never stop working because of billing.**
   - Local is a paid license ($9/mo or $90/yr, 15-day trial), but per the **lapse rule** an expired trial or a failed payment never stops playout, scheduling, logging, on-air audio or startup.
   - The Local entitlement controls exactly two things: **updates** (§4.8) and a **reminder banner**. No local code path reads the entitlement to decide whether to run.
   - The existing UI-only gates on local features are removed. While Local is current, every local feature is available: multi-output routing, NexGen/ENCO import, PDF report, desktop analytics, multi-station console.
3. **One entitlement record, one store, one reader** on the desktop. Main and renderer read the same cached object, which closes B5.
4. **Prices and limits live in config**, served by the backend. No price, plan name, cap or bitrate appears in desktop, dashboard, signup or website code (closes B9).
5. **Nothing destructive happens without notice.** Losing an entitlement stops cloud *service*. It never deletes data without a dated notice and an export path.

### 4.2 Plan catalog (config)
- **Source:** backend `config/plans.json`, checked in, loaded at boot and validated.
- **Served by:** `GET /public/plans`, which every UI renders from. Website, signup, desktop Subscription panel and dashboard all fetch it, so one edit changes every surface.
- **Shape** (illustrative):
```json
{
  "version": 1,
  "currency": "usd",
  "plans": {
    "local":     { "label": "Local",     "price_monthly": 9, "price_annual": 90, "trial_days": 15, "trial_requires_card": false,
                   "hosted_streams": 0, "cloud": false, "includes_updates": true },
    "station":   { "label": "Station",   "price_monthly": 25, "per": "stream", "includes": ["local"], "max_bitrate_kbps": 128, "listeners_per_stream": 50,  "cloud": true },
    "pro":       { "label": "Pro",       "price_monthly": 49, "per": "stream", "includes": ["local"], "max_bitrate_kbps": 320, "listeners_per_stream": 150, "cloud": true, "priority_support": true },
    "unlimited": { "label": "Unlimited", "price_monthly": 79, "includes": ["local"], "hosted_streams": "unlimited", "max_bitrate_kbps": 320, "listener_pool": 250, "cloud": true }
  },
  "lapse":     { "banner": true, "updates_stop": true, "never_stop_audio": true },
  "addons":    { "listeners_50": { "label": "+50 listeners", "price_monthly": 10, "listeners": 50 } },
  "discounts": { "multi_stream": { "min_streams": 3, "percent": 20 }, "annual_months_charged": 10 },
  "grace":     { "past_due_days": 7, "suspended_days": 30, "retention_days": 90 },
  "stripe_prices": { "station_monthly": "price_…", "station_annual": "price_…", "…": "…" }
}
```
- Stripe price ids map to catalog entries **in config**, replacing the hardcoded `PLAN_BY_PRICE_ID` (`index.js:914`).
- **Open for Jeff:** the Unlimited bitrate cap (assumed Pro's 320); whether "3+ stations" means 3+ hosted streams on one subscription; whether add-ons are allowed on Station/Pro (per stream) or only on Unlimited (pool).

### 4.3 Entitlement model (backend)
- **Table `subscriptions`:**

  ```
  (id, license_key_id FK, stripe_customer_id, stripe_subscription_id, plan_key, status,
   quantity_streams, addon_listener_units, current_period_end, cancel_at_period_end,
   grace_until, updated_at)
  ```
  - `status` ∈ trialing | active | past_due | suspended | canceled.
  - Replaces the overloaded `licenses.plan` + `active` + `expires_at` trio.
  - `licenses.plan` stays as the legacy/grandfather marker during migration.
- **Pure function `entitlementsFor(license, subscription, catalog, now)`.** Example output:

  ```
  { plan, status, cloud: bool, hosted_streams: n|"unlimited", max_bitrate_kbps,
    listeners: { mode: "per_stream"|"pool", per_stream, pool },
    features: { sync, cloud_backup, r2_library, control_center, web_remote, public_page, jukebox,
                park_ops, link_pairing, show_guests, analytics_web, members },
    valid_until, grace_until, issued_at, catalog_version }
  ```
  - It's unit-testable like `mutation-retention.js`.
- **`GET /api/entitlements`:** license key or JWT, returns the object above, **signed with Ed25519** (private key on the backend only; public key bundled in the desktop). The desktop can verify a cached copy offline without being able to forge one (§4.8 A).
- **One middleware, `requireFeature("sync")`, on every cloud route:**
  - It replaces `PAID_PLANS` / `requireLicense` tier checks.
  - It covers the currently ungated R2 signing, mirror, public page, jukebox, Park Ops and pairing routes (§2a).
  - It returns a uniform **402** `{ error: "plan_required", feature, required_plan, upgrade_url }` that every client maps to an upgrade prompt.
- **`expires_at` semantics:** null for anything paid or grandfathered (closes B6/B7). Trials are a `subscriptions.status = 'trialing'` row with `current_period_end`, not an `expires_at` on the license.

### 4.4 Cloud feature → plan mapping

| Cloud feature | Local (trial or paid) | Station | Pro | Unlimited | Notes |
|---|---|---|---|---|---|
| Hosted stream (managed Icecast) | ✗ | 1 per unit, ≤128 kbps, 50 listeners | 1 per unit, ≤320 kbps, 150 listeners | unlimited, ≤320 (TBC), pool 250 | +50 listeners per add-on unit |
| Public listener page, account hub, embeds | ✗ | ✓ | ✓ | ✓ | **Decision:** include a listener page for Local users streaming to their own server? The pricing says no cloud on Local, so ✗ is assumed |
| Now-playing push / listener SSE | ✗ | ✓ | ✓ | ✓ | |
| Control Center (web dashboard, mirror) | ✗ | ✓ | ✓ | ✓ | |
| Web remote / command bus | ✗ | ✓ | ✓ | ✓ | |
| Web analytics, affidavit, listenership | ✗ | ✓ | ✓ | ✓ | desktop analytics stay local (included in Local) |
| Multi-device sync | ✗ | ✓ | ✓ | ✓ | |
| Cloud DB backup (R2) | ✗ | ✓ | ✓ | ✓ | |
| R2 library storage / fetch / catalogue | ✗ | ✓ (quota TBD) | ✓ (quota TBD) | ✓ (quota TBD) | **R2 storage is the largest uncapped cost; the pricing has no storage quota.** Jeff decision: quota per plan or fair use |
| Jukebox (public requests) | ✗ | ✓ | ✓ | ✓ | Connect donations: no Ether fee by design |
| Park Ops | ✗ | ✓ | ✓ | ✓ | |
| Remote Link pairing (backend) | ✗ (the offline paste fallback still works on Local) | ✓ | ✓ | ✓ | The UDP feed itself is direct and costs Ether nothing |
| **Remote Link relay** (backend-signed relay sessions, `/api/link/relay`) | ✗ | ✓ | ✓ | ✓ | **2026-10-29.** The relay carries the audio through Ether's server, so it is cloud. The **typed-address direct link** (no backend) stays on Local |
| Show+ remote guests (Ether signaling, invite email) | ✗ | ✓ | ✓ | ✓ | |
| Members / RBAC (multi-user accounts) | ✗ | ✓ | ✓ | ✓ | |
| Priority support | ✗ | ✗ | ✓ | ✓ (assumed) | |
| **Everything local** (playout, library, scheduling, logs, carts, DAW, video RTMP to own destinations, PhoneDesk, delay, processing, Iris with own key, **Icecast to the customer's own server**, LAN replication, GPIO, captions) | ✓ | ✓ | ✓ | ✓ | **never stops on lapse** (§4.8); Local gates only updates and the banner |
| Account sign-in, seats, station registration | ✓ | ✓ | ✓ | ✓ | the account is the root (CLAUDE.md); every license signs in once, then runs offline from the cache (§4.8). **Decision:** the station cap for Local (today free = 1, `index.js:930`) |

### 4.5 Hosted streams (Icecast)
Today all hosted streams run on one Lightsail box, and the source-password scope there is **UNVERIFIED** (audit §Streaming). Target design:
1. **Server-allocated mounts.**
   - New table `hosted_streams (id, license_key_id, station_uuid, mount, source_secret_hash, max_bitrate_kbps, listener_cap, pool_id, status, created_at)`.
   - Mounts are allocated by the backend on purchase or assignment, never typed.
   - The public page's `stream_url` is **derived** from the allocated mount, never accepted from the client. That also closes audit M2.
2. **One source password per mount.**
   - Icecast `<authentication type="url">` with `stream_auth` calling a backend endpoint (`POST /icecast/source-auth`).
   - The backend checks mount ↔ license ↔ secret ↔ entitlement status (active or within grace) and returns allow/deny.
   - The desktop fetches its mount's source secret via an authenticated call. It's stored local-only, like today's `icecast_password` (`synced-tables.js:1088`).
   - Feature support depends on the Icecast version: **UNVERIFIED** until the prod build is checked (`icecast -v`).
3. **Listener caps.**
   - **Station/Pro:** a per-mount `max-listeners` written from `listener_cap` (50/150 + add-ons).
   - **Unlimited (shared pool):** a static per-mount cap can't express a pool. Use `listener_add` / `listener_remove` URL auth hooks to the backend. They keep a per-account concurrent count in memory or Redis, refuse when it reaches `listener_pool`, and decrement on remove.
   - Fallback if hooks prove unreliable: soft enforcement from the 60s `status-json.xsl` poll (`index.js:6865-6877`), with overage alerts and no hard kick.
4. **Bitrate enforcement.** Icecast doesn't cap bitrate per mount natively, and the desktop picks the bitrate client-side (`audiod/stream.js:69`). So:
   - **source-auth time:** the desktop sends `ice-bitrate` / `ice-audio-info`, and the backend refuses a declared bitrate above the cap
   - **monitor:** the status poll compares the observed bitrate with the cap, raises a health event, and after a grace window kills the source via the admin API (admin credentials held only by the backend)
   - **desktop UX:** the encoder bitrate picker is clamped to `entitlements.max_bitrate_kbps` for hosted mounts. An own-server stream is never clamped.
5. **Observability** (CLAUDE.md "build the sense"): per-mount health events (source connected, refused and why, at cap, over-bitrate) go to the ledger, the web Health Monitor and the station badge. No temporary watchers.
6. **The admin password never leaves the backend.** Today `StreamManager.tsx:68-70` sends `admin:<station password>`. That legacy panel should be retired or switched to per-mount source credentials.

### 4.6 Lifecycle: downgrade, failed payment, cancel

| Event | Cloud features | Hosted stream | Data | Desktop |
|---|---|---|---|---|
| `invoice.payment_failed` → **past_due** (`grace.past_due_days`, default 7) | keep working | keeps working | untouched | dismissible banner: "Payment failed — update card" |
| Grace ends → **suspended** (`suspended_days`, default 30) | **stop**: 402 on cloud routes; sync, backup and mirror pause on the desktop, which keeps a local queue | source-auth refuses; listener page shows "off air" | **retained** read-only; export (backup download, R2 audio list) still allowed | banner + upgrade prompt; **all local features unaffected** |
| Suspended ends, or **canceled** | stopped | mount released | retained `retention_days` (default 90). Dated emails at T-30, T-7, T-1 before any deletion. Deletion only of cloud copies, **never local data** | same |
| **Downgrade** (Unlimited → Station, or fewer streams) | per new plan | extra mounts: the customer picks which to keep; the others are suspended (not deleted) at period end | retained | prompt to choose the mounts to keep |
| `cancel_at_period_end` | full until period end | full until period end | — | "ends on <date>" banner |
| Reactivation (pay / resubscribe) | restored immediately, sync resumes from the local queue | mount re-enabled with the same mount name if still within retention | — | — |
| **Local trial ends** (no purchase) | n/a (Local has none) | n/a | untouched | **playout, scheduling, logs and audio unchanged.** Non-blocking reminder banner. Updates released after the lapse date are not offered (§4.8). Nothing else |
| **Local payment fails / Local canceled** | n/a | n/a | untouched | same as trial end: banner + updates pause. **Never** stops audio, a log or startup |
| **Hosted plan lapses** (it includes Local) | the cloud rows above apply after grace | as above | as above | Local lapses on the same date: banner + updates pause. Local features keep running |

- **Webhook set:** `checkout.session.completed`, `customer.subscription.created`, `.updated` and `.deleted`, `invoice.paid`, and `invoice.payment_failed` resolved through `invoice.subscription`. All write the `subscriptions` row. This fixes B2 and B3.
- **Idempotency:** a `stripe_events (id PK)` table.

### 4.7 Desktop: caching, offline, upgrade prompts
- **Cache:** the signed entitlement object (§4.8) lives in one `install_config_kv` key (`entitlements`). The main-process gates and `usePlan` both read it, which retires the four `station_config_kv` reads (B5). `ADMIN_KEYS` and the owner dev picker are removed from production builds; dev overrides become a DEV-build-only flag (B4).
- **Offline:** see §4.8. Local features never read the cache to decide whether to run. Cloud features use it until `grace_until`.
- **Refresh:** on sign-in, on every `/account/connect` reconcile (already periodic, `ccData.ts:862-881`), and on a 402 from any cloud call.
- **Upgrade prompts:**
  - Reuse `PlanGate` / `UpgradePrompt` (`usePlan.tsx:140-241`), with the required plan and price taken from the catalog (no hardcoded $19/$79).
  - Every cloud entry point (Go Live on a hosted mount, public page editor, sync toggle, cloud backup, Control Center, jukebox, Park Ops, Link pairing, Show+ guests) shows a one-line "This uses Ether Cloud — Station plan, $25/mo per stream (includes Local)" card with a button to the signup checkout. The price comes from `/public/plans`.
  - A lapsed or trial Local user gets the same banner component (§4.8 B) with "Renew Local", its price read from `/public/plans` (today $9/mo or $90/yr). It never takes the form of a gate on a local control.
  - The 402 response carries the same fields, so a stale UI still prompts correctly.
- **Doors before rooms:** cloud features stay visible to Local users, never hidden. Each has a door, an empty state and a help entry (`docs/help-*.md`).

### 4.8 Local license, the offline entitlement cache, and the lapse rule

**What the Local entitlement controls (exhaustive):**
1. the **reminder banner**
2. **which updates are offered**
3. through the hosted plans, whether **cloud** features run

It controls nothing in playout, scheduling, logging, audio, the daemon or startup.

**A. The cached entitlement (signed, offline-verifiable)**
- **Issued by:** `GET /api/entitlements` (§4.3).
- **Content:**

  ```
  { license_id, account_id, plan,
    local: { status: "trial"|"active"|"lapsed", trial_ends_at, paid_through, updates_until },
    cloud: { status, grace_until, features{…}, hosted_streams, … },
    issued_at, refresh_after, catalog_version }
  ```
- **Signing:** **Ed25519 (asymmetric).** The private key lives only on the backend; the public key is bundled in the app.
  - The desktop verifies the cache offline but can't forge one.
  - (Earlier drafts said HMAC/JWS. An HMAC key would have to ship in the client, which defeats the purpose, hence asymmetric.)
- **Store:** one key, `install_config_kv.entitlements`, plus `entitlements_meta` (`max_seen_time`, `last_refresh_ok`).

**B. Evaluation is pure and can't block**
- `localState(cache, now)` returns `current | trial | lapsed | unknown`.
- Effects are a fixed table:

| State | Banner | Updates | Playout / scheduling / logs / audio / startup |
|---|---|---|---|
| current / trial | none (trial: "N days left", dismissible) | all | **unaffected** |
| lapsed | non-blocking banner: "Your Local license ended on <date> — renew to keep getting updates" | only versions **released on or before** `updates_until` | **unaffected** |
| unknown (missing, corrupt or unverifiable cache; never signed in on this profile) | non-blocking banner: "Couldn't verify your license — sign in when online" | paused | **unaffected** |

**C. Structural guarantees** (these are what make the lapse rule enforceable rather than hopeful):
1. **Playout startup never awaits entitlement work.**
   - Entitlement load and evaluation run asynchronously *after* the engine, daemon and automation are up. Any failure is swallowed and becomes `unknown`.
   - A **wiring test** fails the build if `audiod/`, the engine bootstrap, the scheduler, log generation or the automation path imports the entitlement module or reads `entitlements` / `plan_tier`. Same pattern as the source-check tests in `ether-backend` (`src/lib/*-test.js` "wired" cases).
2. **No billing modal.** `TrialGate`'s full-screen overlay (B10) is replaced by the banner component. The banner is `position: sticky` inside the header row, never over the decks or the log, never stealing focus, and dismissible for 24h.
3. **No downgrade write.** `TrialGate`'s `plan_tier = "free"` write (`TrialGate.tsx:32-33`) is removed. Lapse changes the banner and the updater, never feature state.
4. **Clock tampering gains nothing that matters.**
   - `max_seen_time` = max(local wall clock, last verified `issued_at`), persisted.
   - Evaluation uses `max(now, max_seen_time)`, so rolling the clock back can't un-lapse.
   - The only thing at stake is updates, so this deliberately stops there.
5. **The server stays authoritative for cloud.** Every cloud route enforces via `requireFeature` (§4.3). A tampered cache can't unlock cloud.

**D. Updates gate (the one Local-specific restriction)**
- **Where:** in `updater:check` (`electron/main.js:7652-7665`).
- **Rule:** offer a release only when `releaseDate` (from `latest.yml`) ≤ `updates_until`, or the state is current/trial.
- A lapsed customer keeps every version they already have, and can install any version released before their lapse date.
- **Limitation (B11):** installers are public on GitHub Releases, so this is a client-side courtesy gate.
- **Optional hardening** (Jeff decision; not required for launch):
  - move the update feed behind `GET /updates/latest.yml?license=…`, which returns an entitlement-checked, short-lived signed URL to an R2-hosted installer
  - make GitHub Releases private
  - note: this changes the release process in `reference_release_process` (CI publishes to GitHub today)

**E. Trial tracking: one trial per account and per machine, reinstall-proof**
- **Server record:** new `trials` table:

  ```
  (id, user_id, email_norm, machine_id, hw_fp_hash, started_at, ends_at, plan_key='local', source)
  ```
  - `UNIQUE(email_norm)`; index on `machine_id` and on `hw_fp_hash`.
  - `ends_at` is set **by the server** (`started_at + catalog.trial_days`, 15). It reuses the existing 15-day server trial clock (`TRIAL_DAYS`, `index.js:2000`; `users.trial_ends_at` set at signup, `:2057`).
- **Machine identity:** `getStableMachineId()` persists a UUID at `%LOCALAPPDATA%\EtherMachine\machine-id` (macOS/Linux: next to userData). It lives **outside the profile**, so it survives reinstall, profile wipe and factory reset (✔ `electron/main.js:1141-1155`; `electron/profile-paths.js:37`). It is already sent as `machine_id` on activation and connect (`index.js:2300-2316`, `:4026`).
- **Second, harder signal:** `hw_fp_hash` = SHA-256(server salt + OS machine GUID).
  - Windows: `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. macOS: `IOPlatformUUID`.
  - Only the salted hash is stored, never the raw id.
  - Deleting `EtherMachine\` therefore doesn't reset the trial.
- **Start rule:** a trial starts **only** if `email_norm` has no trial **and** neither `machine_id` nor `hw_fp_hash` has one.
  - `email_norm` = lowercased, Gmail dots/`+tag` stripped.
  - Otherwise the account starts in Local `lapsed` with a purchase prompt. That still means **full playout**: lapse never stops audio, so a "refused trial" only means the banner and no updates.
  - The platform console can grant a fresh trial (support override, audited).
- **Residual risk, accepted:** cloned VMs and a new email on new hardware. At $9/mo, with lapse costing only updates, stronger DRM isn't worth the operator-hostile failure modes.
- **No card:** the trial is created at signup or desktop activation with no Stripe involvement. Stripe Checkout is first touched at purchase.

**F. Offline when the trial ends**
- The cached signed entitlement carries `trial_ends_at`. When `max(now, max_seen_time)` passes it, the desktop switches to `lapsed` on its own, with no network needed: banner on, updates paused.
- **Playout, scheduling, logs and audio continue exactly as before**, indefinitely, offline.
- On the next successful refresh:
  - if the customer bought Local (or a hosted plan), the new cache says `active` and the banner clears;
  - if not, nothing further happens.
- The existing 14-day offline grace in `licenseGuard.ts` (`GRACE_DAYS`, `:39`) stays sign-in-only bookkeeping. It must never trigger anything beyond a banner. Today it only writes `license_state`, which nothing reads (`licenseGuard.ts:164`).

**G. Lapse-safe acceptance test** (required in every phase that touches the desktop; a runtime receipt per CLAUDE.md, not a unit test alone)

Run the packaged build with each of these states injected:
1. expired trial, offline
2. Local payment failed
3. corrupt or missing entitlement cache
4. system clock +1 year
5. backend returning 402 and 500 on every route

Each must show all of the following:
- cold start to an on-air automation run of at least 30 minutes with no operator input
- `play_log` rows written for every play
- carts firing and the log advancing across a top-of-hour
- the banner visible and **no modal**
- updates withheld (in states 1, 2 and 4)

Receipts: screenshots plus a `play_log` row count before and after.

---

## 5. Migration of the 8 active licenses (totals only)

Source: `paywall-totals.js`, read-only.

| Today (plan) | Active | Stripe-linked | With past `expires_at` | Stations per license | Proposed |
|---|---|---|---|---|---|
| free | 2 | 0 | 2 | (in histogram) | → **Local**. **Recommended: grandfather existing free users as Local at no charge** ("Founding Local"), because they adopted when it was free. The alternative is Local `lapsed` with a renewal banner. **Either way their playout is unaffected** (lapse rule). Clear the stale `expires_at` so key-based sign-in works |
| station | 2 | 0 | 2 | — | These look like **expired Network trials**. → **Local, trial already used** (a `trials` row is back-filled from their history so a new trial can't start), shown as `lapsed` with an offer: renew Local, or a one-time Station/Pro trial. Jeff decision |
| station_lifetime | 4 | 0 | 2 | — | **WITHDRAWN (Rulings R1): never modified, migrated or re-mapped.** Original proposal: → **Grandfathered "Legacy Lifetime"** (recommended). Entitlements equal to **Unlimited** (all cloud features, unlimited hosted streams, a 250-listener pool), no charge, `expires_at` NULL. The 2 with a past expiry are almost certainly the trial-clock bug. **Jeff must confirm each before migration**; I didn't single them out |

- **Stations per active license:** 1 has 0, 4 have 1, 1 has 2, 1 has 3, 1 has 5. Only 2 licenses use managed hosted streams (5 public stations, all on `stream.ether-technologies.com`).
- **No Stripe migration is needed:** no active license has a Stripe subscription, so nothing has to be re-priced in Stripe.
- **Recommendation:**
  - Grandfather all lifetime holders permanently. "Legacy Lifetime" includes Local forever: updates never stop, and there's no banner.
  - Map free users to Local (grandfathered or lapsed, your call) and expired trials to Local lapsed with an offer.
  - **No migration path can interrupt playout**, because the lapse rule applies to every outcome. The legacy keys keep working (the key → license lookup is unchanged). Only the entitlement source changes.
- **Accounts 21 and 23** are included in these totals only and are not singled out. Their migration is "map plan → entitlement" exactly like every other row, with no data change beyond the entitlement mapping, and only on your GO.

---

## 6. Order of work

Each phase ships on its own and is gated by tests plus a post-deploy receipt, like H2 and H3.

| Phase | Work | Blast radius | Must precede |
|---|---|---|---|
| **P0 — Billing blockers** | B1 (use `stripe_subscription_id` / `stripe_customer_id`); B2; B3; B6; B8 (remove broken lifetime links); ~~B7 data fix~~ (**CANCELLED** — Rulings R3: code exemption instead, no data writes) | Backend webhook, billing routes, `userEntitlement`. 0 live Stripe subscriptions, so a low risk of disturbing anyone. B7 is a data write and needs its own GO | any paid sale |
| **P0b — Lapse-rule safety (desktop, can ship immediately)** | B10: replace `TrialGate`'s full-screen overlay and `plan_tier=free` write with a non-blocking banner; add the startup/playout **wiring test** (§4.8 C1) | Desktop release. It **only removes** a blocking surface, so it can't interrupt audio. Lapse-safe acceptance test §4.8 G (states 1 and 3) | P3 |
| **P1 — Multitenancy fixes for anything public or hosted** | **H1** (retire the global now-playing slot; repoint the OV companion pages to the per-station row); **H4** (jukebox slug ownership); **H5 + M1** (Link pairing account = license/membership only; `link_keys` keyed by license and machine); **M2** (`stream_url` server-derived); **Icecast per-mount source passwords** (verify the prod config first) | H1 touches OV's `/mobile`, `/console` and `/emergency` pages, so it needs an OV-safe cutover. H4 touches jukebox publish. H5/M1 touch Remote Link pairing. Icecast touches every live mount, so it needs a maintenance window and both OV and USPH re-keyed | **hosted streams sold** (H1, H4, H5, Icecast are mandatory) |
| P2 — Entitlements core (backend) | `config/plans.json` + `/public/plans`; `subscriptions` table; `entitlementsFor()` + signed `/api/entitlements`; `requireFeature()` on every cloud route (incl. the ungated R2/mirror/public/jukebox/ops/pairing routes); uniform 402 | Every cloud route. **Ship first in shadow mode** (compute and log the would-be 402, still allow, like RBAC_SHADOW `index.js:1161`), then enforce once grandfathering is applied | P3, P4 |
| P3 — Desktop entitlement client | one cached **Ed25519-signed** entitlement; main + `usePlan` read it (B5); `localState()` + banner + **updates gate** (§4.8 D); `max_seen_time` clock guard; remove `ADMIN_KEYS`/owner picker from prod (B4); remove UI-only gates on local features; upgrade cards from the catalog | Desktop release (version bump, installer). Old desktops keep working because the server enforces cloud. **Lapse-safe acceptance test, all five states (§4.8 G), on the packaged build before ship** | P4 launch |
| P3b — Trial service | `trials` table; `email_norm` + `machine_id` + `hw_fp_hash` start rule; desktop sends `hw_fp_hash` on activation; back-fill from existing `users.trial_ends_at` and trial licenses; platform "grant trial" override (audited) | Backend + desktop activation. No effect on running installs | Local sales |
| P4 — Stripe billing v2 | products and prices from the catalog: **Local monthly $9 / annual $90**; Station and Pro per-stream (volume tier for 3+, annual = 10×); Unlimited; listener add-on. Hosted plans carry the Local entitlement. Checkout from signup + desktop with a client reference; portal; full webhook set + `stripe_events`; dunning → grace state machine | Stripe config (test mode first), webhook, signup, dashboard billing card | paid launch |
| P5 — Hosted stream provisioning | `hosted_streams` table; mount allocation; Icecast URL auth (source + listener hooks); per-mount caps; pooled counter for Unlimited; bitrate checks; health events; admin password backend-only | The Lightsail Icecast box (all live mounts). Staged: new mounts first, then migrate `/ov`, `/usph` in a window | hosted-stream sales |
| P6 — Migration & launch | grandfather mapping (§5); enable enforcement; publish pricing from `/public/plans` on all surfaces (B9) | All 8 licenses; protected accounts get entitlement mapping only | — |

**Also required before selling hosted streams** (from `docs/multitenancy-audit.md`, beyond those listed above): M5 (license key out of URLs: `cmd-stream ?key=`), M6 (plaintext keys at rest), M7 (platform login rate limit and audit). H2 and H3 are done (deployed `2081013`, `a01339a`).

---

## Decisions (Jeff, 2026-10-05)

These supersede the matching assumptions above. Values go in `config/plans.json`, never in code.

1. **R2 storage quota:** Station **100 GB**, Pro **250 GB**, Unlimited **500 GB** (config values).
2. **Listener page for Local users streaming to their own server:** **included**, with a "Powered by EtherCast" mark. (This replaces the ✗ in the §4.4 "Public listener page" row for Local.)
3. **Local pricing:** ~~$3.99/mo per station ($39/yr per station)~~ → **$9/mo per station ($90/yr per station)** (Rulings 2026-10-29). The catalog prices `local` per station; hosted plans include Local for their stations.
4. **Unlimited:** **320 kbps**, priority support **included**.
5. **Listener add-ons:** **per stream** on Station and Pro; **added to the shared pool** on Unlimited.
6. **The 2 free licenses:** **Founding Local, no charge**.
7. **The 2 expired station trials:** **Local lapsed + a one-time hosted trial offer**.
8. ~~**Lifetime licenses with a past expiry:** PENDING~~ — **SUPERSEDED by Rulings R1/R3 below: never modified; code ignores `expires_at` for them.** (Original text:) **PENDING Jeff's confirmation. Do not touch.** Neither data nor behaviour changes for them. P0's B6 fix exempts lifetime/operator plans from `expires_at` so their entitlement reads exactly as it does today.
9. **Grace 7/30/90:** accepted.
10. **Update gate:** client-side only for now (B11 accepted).
11. **Trial anti-reset:** `machine_id` + hashed hardware ID.

## Rulings (Jeff, 2026-10-05, second set) — these SUPERSEDE decision 8, the §5 lifetime row, and the B7 data fix

**R1. Lifetime licenses are never modified, migrated, or re-mapped.** No "Legacy Lifetime" mapping (the §5
`station_lifetime` row is withdrawn), no data change, no entitlement mapping.

**R2. Licenses created in the platform app stay outside the new tier system.** No entitlement mapping, no trial, no
lapse, no banner. They keep working exactly as they do today, indefinitely.

**R3. The B7 data fix is CANCELLED.** No row in `licenses` is written. Instead, the code is changed so that lifetime
and platform-created licenses ignore `expires_at` (proposal below, **plan only, not built**).

**R4. Remote Screens domain:** `app.ether-cast.com` (`docs/ether-screens-plan.md`, decision 1).

### Proposal (plan only): exempt licenses ignore `expires_at` — code change, no data writes

**What the code does today (receipts, `ether-backend` `21156d3`):**
- `lookupLicense` (`src/index.js:1041-1058`) skips any row whose `expires_at` is past (`:1050`). It is the key check
  for ~40 routes (`:2374` … `:6504`, plus `routes/attachments` via `:6752`), so an expired row fails every key-based
  cloud call.
- `lookupLicenseDetailed` (`:1064-1083`, used only by `/account/connect` `:4018`) does the same and reports
  `trial_expired` (`:1079`, `:4019-4021`).
- `entitlement.js` already exempts **lifetime/operator by plan** (`NEVER_EXPIRES`, `src/lib/entitlement.js:14-20`).
  The two lookups above do not.
- The desktop banner already ignores lifetime/operator by plan (`neverTrials`, `src/lib/trialBanner.ts` on
  `fix/p0b-trial-banner`). It has no notion of "platform-created".

**The gap: the database does not record which app created a license.** `/api/platform/licenses`
(`src/index.js:1660-1670`) and `/admin/issue` (`:4932-4947`) insert `(email, plan, key_prefix, key_hash)` — the same
shape the Stripe webhook writes minus the Stripe ids. Then the first desktop activation mints a plaintext key into the
row (`:2283-2290`), which makes it look like a self-signup trial row (`:2275`). So "platform-created" cannot be derived
reliably from the existing columns. Two honest ways to identify them:

| Option | How | Data write? | Recommendation |
|---|---|---|---|
| **A. Allowlist in config** | `TIER_EXEMPT_LICENSE_IDS` (Railway env var, comma-separated ids). Jeff names the rows from the platform Licenses screen | **None** — config only | **Recommended for existing rows** |
| **B. `origin` column for new rows** | `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS origin TEXT` (existing rows stay NULL — no backfill); `/api/platform/licenses` and `/admin/issue` insert `origin = 'platform'` | Schema change only; no existing row is written. **Needs Jeff's OK** as it is a schema change | **Recommended for new rows**, together with A |

**The code change (one helper, used everywhere expiry is checked):**
- `src/lib/entitlement.js`: add `tierExempt(row)` = `NEVER_EXPIRES(row.plan) || row.origin === 'platform' ||
  EXEMPT_IDS.has(row.id)`. `licenseExpired(row)` returns false when `tierExempt(row)`.
- `lookupLicense` `:1050` and `lookupLicenseDetailed` `:1079`: replace the inline expiry test with
  `licenseExpired(row)`. This is the one-line change at the `index.js:1043` lookup you named; every one of its ~40
  callers inherits it.
- `/account/connect`: return `tier_exempt: true` for these licenses. The desktop banner (`trialBannerState`) returns
  null when `tier_exempt` is true — **no banner**. P2/P3 entitlements (`entitlementsFor`, `requireFeature`, the update
  gate) short-circuit to "today's behaviour" for an exempt license — **no mapping, no trial, no lapse**.
- **Not changed:** `active = false` still disables a license (that is an explicit operator action, not a lapse).

**Blast radius:** every key-based cloud route, in one direction only — a currently-rejected exempt license starts being
accepted. No currently-accepted license can become rejected (the change only removes a rejection reason). The four
`station_lifetime` licenses and any platform-created licenses with a stale `expires_at` regain cloud access (sync,
backup, connect). Tests: lookup accepts an expired lifetime / allowlisted / `origin='platform'` row; still rejects an
expired self-signup trial; `active=false` still rejected.

**Conflicts to settle (flagged, not decided):**
- Decisions 6 and 7 map the 2 `free` and 2 expired `station` licenses into the tier system. **If any of them were
  created in the platform app, R2 overrides decisions 6/7 for that row** — it stays outside the tier system. Which of
  the 8 were platform-created is not knowable from the data (above); only Jeff can say, via the allowlist.
- Decision 8 is superseded by R1.

## Rulings (Jeff, 2026-10-29) — pricing, no free plan, Remote Link relay

**Jeff (verbatim):** "Update docs/paywall-entitlements-plan.md: there is no free plan anywhere. Every new account starts
with a 15-day full trial, no card. Local is $9/mo, or $90/yr under the plan's annual rule (10 months' price): everything
local, no cloud features. Everything else stays as the doc has it: Station $25/mo per hosted stream, Pro $49/mo per hosted
stream, Unlimited $79/mo, the +$10 listener add-on, 20% off for 3+ stations, the lapse rule, the grace periods, and
lifetime licenses at Unlimited-level forever. Add the Remote Link relay to the cloud features (Station and up); the
typed-address direct link stays on Local."

Applied above: the price table, §4.1, §4.2 catalog, §4.4 (new Remote Link relay row), §4.7, §4.8 E, §6 P4, Decision 3.
Unchanged: Station $25 / Pro $49 per hosted stream, Unlimited $79, +$10 listener add-on, 20% off 3+, lapse rule, grace
7/30/90, Rulings R1–R3.

**Conflicts to settle (flagged, not decided):**
- **"Lifetime licenses at Unlimited-level forever" vs R1** ("never modified, migrated, or re-mapped … no entitlement
  mapping"). Read together as: lifetime licenses are never written; the *code* treats a lifetime plan as Unlimited-level
  (as `entitlement.js` `NEVER_EXPIRES` already exempts them). No row changes. Built that way unless Jeff says otherwise.
- **"No free plan anywhere" vs Decision 6** (the 2 existing `free` licenses become "Founding Local, no charge"). A
  no-charge grandfathered Local is not a plan anyone can choose, so the two can stand together, but only Jeff can say.
  Until then those rows are not touched.
- **Per station:** Decision 3 priced Local *per station*; the 2026-10-29 ruling says "$9/mo" without repeating it.
  "Everything else stays as the doc has it" keeps per station.

## Implementation record — P0 (backend) and P0b (desktop), GO 2026-10-05, LOCAL COMMITS ONLY

**Backend:** `ether-backend` `21156d3` on `fix/p0-billing-blockers` (from `origin/main` `2081013`). **Not pushed, not deployed.**
- **Fixed:** B1 (real `stripe_subscription_id`/`stripe_customer_id` everywhere); B2 (failed payment resolves its subscription and keeps grace; revocation only on Stripe cancel/unpaid); B3 (`customer.subscription.updated`: plan + status mapping); B6 (`userEntitlement` honours `expires_at`, with lifetime/operator exempt, so decision-8 accounts read exactly as before).
- **New modules:** `src/lib/stripe-webhook.js`, `src/lib/entitlement.js`.
- **Tests:** 23 new; suite **93/93**. pg-mem ignores ROLLBACK on adapter clients (probed), so the rollback test asserts the BEGIN/INSERT/ROLLBACK protocol.
- **Not in it:** B7 (data, pending decision 8). B8 is desktop (below).

**Backend P0 DEPLOYED 2026-10-06 ~01:27 UTC (Jeff's GO):**
- `main` fast-forwarded `2081013..21156d3` and pushed.
- Railway deployment `eb776440` (commit `21156d3dccf5`) reached **SUCCESS**, and `366576af` was removed.
- `GET /health` returned 200. Startup logged `[DB] Schema ready` and `[Ether] API live → port 8080`, with no errors.
- **Not yet verified:** the webhook paths have no live Stripe event to exercise them (0 Stripe-linked licenses). They are proven by unit tests only, until a Stripe test-mode event or a real purchase arrives.
- **Rollback point:** `2081013`.

**Desktop:** `openair` branch `fix/p0b-trial-banner` (from `6b2dcba` = v4.6.57). **Not tagged, released or pushed; no version bump; no installer built.**
- `2c79267` **P0b:** `TrialBanner` (in-flow reminder strip) replaces `TrialGate` (full-screen overlay + `plan_tier=free` write). Adds the §4.8 C1 wiring test (every non-test file in `audiod/` and `src/audio/` must not read billing state).
- `21197b1` **B8:** lifetime purchase links removed; lifetime buttons become "not available to buy right now"; owners keep the "Lifetime Active" badge.
- **Gates:** `tsc --noEmit` **0 errors**; vitest **86 files / 792 tests** pass; `smoke-undefined-calls` PASS; the pre-commit transformer-chain hook passed on both commits.
- **Behaviour change to know:** an expired trial no longer flips the local tier to free. Cloud features still stop, because the server rejects an expired trial key.

### How Jeff runs lapse-safe acceptance states 1 and 3 on a local build (P0b scope)
The full §4.8 G test needs the P3 entitlement cache, which doesn't exist yet. For P0b the same states are driven through the two values the banner reads, station 1's `plan_tier` and `trial_ends_at`. They're written **through the app's own IPC writer while it runs**, never by an external script against `openair.db`.

1. **Run the branch locally** (dev mode; a dev build is blocked from writing to production by `canWriteProduction()`, `electron/lib/etherBackend.js:40-45`):
   `cd C:\openair` → `git switch fix/p0b-trial-banner` → `npm run electron:dev`.
   To test the packaged form instead: `npx tsc --noEmit && npm run build && npm run electron:build:win -- --publish never`, then install the resulting `dist-electron\Ether Setup 4.6.57.exe`. Note it carries the same version number as the shipped 4.6.57, so bump first if it will sit beside a real install.
2. **Record the current values:** press **F12** (Toggle DevTools, `electron/main.js:2864`) → Console →
   `(await window.ether.stationConfigKv.list(1)).rows.filter(r => ["plan_tier","trial_ends_at"].includes(r.key))`. Keep the output to restore later.
3. **Baseline:** start automation on air. Then:
   `(r => r.rows ?? r)(await window.ether.db.query("SELECT COUNT(*) AS n FROM play_log", []))` (note the count).
4. **State 1 — expired trial, offline:**
   - `await window.ether.stationConfigKv.upsertByKey(1, "plan_tier", "station")`
   - `await window.ether.stationConfigKv.upsertByKey(1, "trial_ends_at", "2026-09-01T00:00:00Z")`
   - Disconnect the network (Wi-Fi off / unplug). Quit Ether **completely** (tray icon too), relaunch, leave automation running ≥30 min across a top-of-hour.
   - **Pass if:**
     - the app starts straight to the on-air UI with no modal
     - a thin "Your trial ended on Sep 1, 2026 … on air keeps running" strip sits **above** the header
     - decks, carts and the log are clickable at all times
     - audio never stops
     - the log advances across the hour
     - the `play_log` count has risen by every play
     - ✕ hides the strip, "See plans" opens Subscription
5. **State 3 — corrupt / missing value:**
   - (a) `await window.ether.stationConfigKv.upsertByKey(1, "trial_ends_at", "not-a-date")`, relaunch.
   - (b) `await window.ether.stationConfigKv.removeByKey(1, "trial_ends_at")`, relaunch.
   - **Pass if:** in both cases there's **no banner, no modal, no error**, and the same ≥30-minute on-air run with `play_log` growing.
6. **Restore:** reconnect the network. Put back the values recorded in step 2 with `upsertByKey` (or `removeByKey` if a key wasn't there). The next `/account/connect` reconcile also rewrites the account tier on its own (`ccData.ts:862-881`).
7. **Receipts:** a screenshot of the strip over a live deck in state 1, a screenshot of state 3a, and the before/after `play_log` counts.

## Open decisions for Jeff (original list — items 1–11 now answered in Decisions)
1. R2 storage quota per plan (the largest uncapped cost).
2. Public listener page for Local users streaming to their own server: included or hosted-plan only?
3. The Local station cap (today free = 1, `index.js:930`).
4. The Unlimited bitrate cap and whether priority support is included.
5. Add-ons per stream versus pool only.
6. The 2 existing free licenses: grandfather as "Founding Local" (recommended), or Local lapsed.
7. The 2 expired `station` licenses: Local lapsed with a renew offer, or a one-time hosted trial.
8. Confirm that the 2 `station_lifetime` licenses with a past `expires_at` are real lifetime holders (trial-clock bug).
9. Grace and retention defaults: 7 / 30 / 90 days (cloud only; Local lapse has no grace because it stops nothing but updates).
10. Updates gate: client-side only (accept B11), or move the update feed behind the backend and make GitHub Releases private.
11. Trial anti-reset strength: `machine_id` + hashed hardware GUID (recommended), or `machine_id` only.

---

**Temporary tooling:** read-only scripts in the session scratchpad (`paywall-totals.js`, `licenses-cols.js`), each run once. Nothing persistent.

**Stop.** Awaiting Jeff's review and GO.
