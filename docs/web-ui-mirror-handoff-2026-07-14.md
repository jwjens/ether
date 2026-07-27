# Handoff — Web-UI categories/programming mirror regression (2026-07-14, rev 2)

**Purpose:** context transfer for a fresh Claude session. Self-contained. Read top to bottom.
**Status:** read-only diagnosis complete; root cause identified **and refined** (the earlier "duplicate user" idea is FALSIFIED — see §5); fix proposed; **NO changes made, awaiting Jeff's GO.**

---

## 0. Ground rules (Jeff's, permanent)
- Receipts (file:line / log-line / command output) for every claim. Read-only diagnosis before any change.
- No commit / tag / push / install / deploy without Jeff's **literal GO**. STOP means stop.
- Never touch customer accounts `netgeak` / `cristianmalliani`.
- **Scope lock for THIS task:** fix ONLY **categories and programming**. No auth *changes*, no button work, no badge work, no backlog drains beyond these two data types. Library sync **works both directions** — do not touch it. (Note: the fix here is fundamentally about auth *identity*; flag it explicitly to Jeff since it brushes the "no auth work" lock.)
- Never start/stop/modify any airing/streaming station without an explicit instruction naming the station.

## 1. Machine / project map (verified 2026-07-14; also in C:\openair\CLAUDE.md)
- `C:\openair` → **EtherCast desktop app**, repo `github.com/jwjens/ether`. Installed build **v4.4.52**. Releases via GitHub Actions `build.yml`.
- `C:\ether-dashboard` → **web "Ether Control Center"**, repo `jwjens/ether-dashboard` → Cloudflare Pages project **`ether-dashboard`** → **app.ether-technologies.com**. **This is the web programming tool** (has `ProgrammingPanel`/`CategoriesPanel`). Deploy: `cd /c/ether-dashboard && npx wrangler pages deploy dist --project-name ether-dashboard`.
- `C:\ether-admin` → platform console (god-mode). No programming editors.
- `C:\ether-bridge` → dead March-2026 Liquidsoap prototype; data in local JSON/folders, never the backend. Not relevant.
- **Backend:** `ether-backend` on **Railway** = `https://ether-backend-production.up.railway.app` (`C:\openair\electron\lib\etherBackend.js:17`). **Stays — no migration.** Source at `C:\ether-backend\src\index.js`. No local `.env`/`DATABASE_URL` on this machine → cannot query Postgres directly.

## 2. Live box state
- v4.4.52; **3 stations airing + streaming** (Open Format / halloVeen / Magical Forest). Do not disturb.
- Local DB (READ-ONLY only): `C:\Users\jensj\AppData\Local\Ether\com.ether.radio\openair.db`. Use `sqlite3 -readonly`.
- Station uuids: **Open Format = `75532b61-fa0c-4bc5-a5f0-0298b94c0123`**, halloVeen `43889edc-…`, Magical Forest `dfbc68ac-…`. Match the now-playing heartbeat — no local uuid split.
- Install token (READ-ONLY): `SELECT value FROM install_config_kv WHERE key='account_jwt'`. Account: `jensj@opportunityvillage.org`. License: `ETH-STN-BAA8-E056-6FC8`.

## 3. The problem
Categories & programming edited in the web UI (ether-dashboard) stopped mirroring to/from the install. Library still works both ways. Jeff logs into the dashboard with **email + password** (never sees license keys) and it shows the stations + library.

## 4. Channels: what works vs. fails (receipts)

| Channel | Keyed by | Works? | Receipt |
|---|---|---|---|
| now-playing heartbeat | **license key** (header) | ✅ | `GET /api/now-playing` → Open Format `engine_state:"live"` |
| command bus (buttons) | license | ✅ | Jeff's deck-B test loaded on desktop; `POST /api/cmd :5321`, `/api/cmd-stream :5359` |
| desktop library pull | **license key** header `x-license-key` | ✅ | `electron/sync/library-client.js:72` |
| dashboard station list/badge | **token `lk` (license_key_id)** | ❌ empty | see §5 |
| dashboard station DATA (categories/programming/staged) | **token `lk`** | ❌ 404/empty | see §5 |

**Sync table set is NOT the problem:** `electron/sync/synced-tables.js:14-25` `SYNCED_TABLES` includes `categories, spot_categories, clocks, clock_slots, format_clocks, generated_schedule`; backend `STAGEABLE_TABLES = {categories, clocks, clock_slots, shows}` → `staged_programming` (`ether-backend/src/index.js:2838`). Tables are wired both directions.

## 5. Root cause (refined — receipts)

The backend has **two parallel identity systems** (`ether-backend/src/index.js:1746-1748`):

- **`/api/auth/*` — email+password → resolves license server-side → mints a token WITH `lk` = `license_key_id`** (`signAccountToken :975`; owner-login `:2209` `{uid, lk:u.license_key_id, typ:"owner"}`). **This is what the dashboard uses.** Jeff never types a license key; the backend links email→license.
- **`/api/user/*` — customer email+password "free signup → 15-day trial"** → `signUserToken` mints **`{uid, email, typ:"user"}` with NO `lk`** (`:1753-1754`).

**License scoping:** `GET /api/account/stations` filters `WHERE s.license_key_id = $1` using **`[req.auth.lk]`** (`:2269-2271`). Stations are owned by **`license_key_id`** (`stations.license_key_id NOT NULL`, `:432`), not by a uid.

**The install holds an `lk`-LESS `typ:"user"` token.** Decoded install JWT = `{uid:25, email:"jensj@opportunityvillage.org", typ:"user", iat, exp}` — no `lk`. `/api/user/me` shows uid 25 as a **trial account** (`email_verified:false, trial_ends_at:2026-07-20, plan:"station"`). So `req.auth.lk` is null → every license-scoped account/station/staged query returns empty/404. **Library survives because it passes the license KEY in a header** (`x-license-key: ETH-STN-BAA8-E056-6FC8`), bypassing the token.

**Earlier "duplicate user" hypothesis is FALSIFIED:** `users.email` is `NOT NULL UNIQUE` (`:329`) → exactly one row for the email (uid 25). It's **not** two users — it's **one user reached through the wrong auth system**: the dashboard hits the `lk`-bearing `/api/auth/*` login; the install got signed into the `lk`-less `/api/user/*` trial funnel (a Jul-13 re-provision regression).

### Answers to the three original questions
1. **How many user rows for the email?** One (email UNIQUE).
2. **Which uid owns 75532b61?** None — owned by `license_key_id`; access needs an `lk` token.
3. **Dashboard vs install identity?** Same uid, **different token type**: dashboard = `lk`-bearing (`/api/auth/*`); install = `lk`-less `typ:"user"` (`/api/user/*`).

## 6. Proposed minimal fix (needs GO)
Get the install back onto an **`lk`-bearing license identity** for `ETH-STN-BAA8-E056-6FC8` — i.e., re-authenticate the desktop through the **`/api/auth/*` (email+password → server-side license) path**, the same one the dashboard uses, instead of the `/api/user/*` trial funnel. Then the existing `staged_programming` pulls and the mutation push both light up. **No** user merge, **no** table change, **no** touching library sync, the license key, or airing stations.

**Load-bearing caution (Jeff's):** a plain desktop re-sign-in through the **same trial funnel** just re-mints another `lk`-less token. The fix must **change which auth endpoint the install uses** (route it to the `lk`-bearing login). Since the dashboard's email+password login already works (shows stations), uid 25's `users.license_key_id` is **probably intact** → likely a **desktop-login-routing fix, not backend data surgery**. Confirm before executing (below).

## 7. Verification needed before executing (one gap)
Confirm whether the fix is **desktop-login-routing only** vs **needs backend linkage repair first**:
- **Read the dashboard's browser token `lk`** (read-only: app.ether-technologies.com localStorage → decode JWT). If it has `lk` set and shows the stations, uid 25's license link is intact → desktop-routing fix only.
- OR one backend/admin query: `SELECT id, email, license_key_id FROM users WHERE email='jensj@opportunityvillage.org'` and `SELECT license_key_id FROM stations WHERE uuid='75532b61-…'` → they should match; if uid 25's `license_key_id` is null/mismatched, repair it backend-side first.

## 8. Out-of-scope notes (do not re-derive; don't action here)
- ether-dashboard was deployed today (commit `a138e1c`): June operator buttons + a stale-alert clear-on-recovery fix. **The buttons' command names are wrong** (invented `stop_all`/`restart`/`play_now`); Jeff's curated set = AUTO, ON-AIR/OFF-AIR, crossfade. Separate task.
- `station_config_kv.sync_enabled` is absent → desktop→web mutation push is also gated off (53,944 pending mutations). Same identity root; **do not drain** as part of this task.
- Prior detail: `C:\openair\docs\mirror-regression-diagnosis-2026-07-14.md`, `C:\openair\docs\backlog.md`.
