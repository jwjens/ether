# Account vs. License station ownership — architecture analysis (v4.5 territory)

> Status: **analysis only — not started.** Captured 2026-06-19 from a live investigation.
> When we tackle this, design end-to-end first (tables → endpoints → migration → client
> refactor), then implement in one push. Do NOT start piecemeal.

## The problem in one sentence

Stations are owned by **licenses**, not **accounts** — so a person signing into their
account on a machine seated on a *different* license sees the machine's license's stations,
not their own. "The account is the root of everything" (CLAUDE.md) is not actually true at
the station-ownership layer; the *license* is.

## Concrete repro (the test fixture)

- This dev box is seated on **DJ Deniro's** license `ETHER-OWNER-2026` (account_name "Dj Deniro").
- The cloud registry (`POST /account/connect` with that license) returns **only US Phenomenon**.
- **Opportunity Village** and **DJ Deniro** are intentionally **separate accounts, separate
  licenses, separate stations.**
- A stale local `stations` row for OV (id=1, `owner_license_key=ETHER-OWNER-2026`,
  `deleted_at=null`) is **left in place on purpose** as the reconciliation test fixture.
  Do not delete it.

## Two disagreeing station-list sources, neither keyed on the account

| Source | Layer | Keyed on | Returns on this box |
|---|---|---|---|
| `POST /account/connect` | backend (cloud) | `license_key` → `license_key_id` | USPH only (authoritative) |
| `ether.stations.list()` (`stations:list`) | local SQLite | **nothing** (all non-deleted rows) | OV + USPH |

The account email is used exactly once — at `desktop-activate` — only to *resolve a
license_key*. After that, every station lookup (client and backend) is by license.

## Client surfaces traced

- **(a) UserLogin / profile flow** — 100% local, fetches no station list. Uses
  `stations.getActive()` only to stamp a `station_id` on profiles.
- **(b) OnboardingFlow `/account/connect`** — cloud, license-keyed. Body is always
  `{license_key, machine_id, machine_name}`; the account email is never sent.
  - `OnboardingFlow.tsx:424` (sign-in) uses the license resolved by `desktop-activate`.
  - `:340` (resume) / `:699` (manual key) use the stored/typed license (here, DJ Deniro's).
- **(c) Station picker after sign-in** — renders `connectStations` from (b). Reconciliation
  (soft-delete local rows whose uuid ∉ `connectStations`) exists at `OnboardingFlow.tsx:484-487`
  and `:841-846` but **only runs inside the onboarding cloudSync flow** — never on a normal
  launch. That's why the stale OV row never gets pruned.
- **Local `stations:list` is unscoped** — `electron/main.js:5350` is
  `SELECT * FROM stations WHERE deleted_at IS NULL` with **no** `owner_license_key` filter,
  despite the (now-corrected) comment that claimed license-scoping. Every consumer
  (`ActiveStationBadge`, `AudioRoutingPanel`, `NowPlayingStationPicker`, SettingsPanel station
  manager, the onboarding prune itself) sees all local non-deleted stations regardless of account.

## Backend model (C:\ether-backend\src\index.js)

Stations are license-owned; account identity is split across two tables, **both under a license**:

- `stations.license_key_id INTEGER NOT NULL REFERENCES licenses(id)` (`:401-413`) — the only
  ownership column. Every station query is `WHERE license_key_id = $1`:
  - `/account/connect` → `:2861`
  - `/api/account/stations` (JWT `lk`) → `:1893`
  - `/api/platform/accounts/:id/stations` → `:999`
- `users` (email/password signup): `users.license_key_id` — nullable, **one** license per user (`:304-318`).
- `account_users` (dashboard PIN operators): `account_users.license_key_id` — license-scoped;
  all operators see all that license's stations; no per-station ACL (`:484-506`).
- `desktop-activate` (`:1634-1713`) takes email+password, resolves to a **single** license_key
  (the user's `license_key_id`, else a trial license matched by `email`), returns
  `{license_key, plan, email}` — no stations, no account id distinct from the license.

### Does the backend support "stations for this account" separate from "for this license"?

**No.** The only account→stations path is the single-hop chain
`users.email → users.license_key_id → licenses.id → stations.license_key_id`.
There is no `account_id` on `stations`, no account↔multiple-license mapping, no per-station
ownership/ACL, and no endpoint keyed on email/account that aggregates stations across licenses.

## What a fix requires (end-to-end — design before building)

1. **Backend (biggest piece):** a first-class account identity that *owns stations* (or an
   account↔license aggregation). New/changed tables (e.g. `accounts`, `account_id` on
   `stations` or an `account_licenses` join), new lookup endpoint keyed on the authenticated
   account, and a data migration backfilling ownership from today's `license_key_id`.
2. **Client cloud path (b/c):** stop keying station fetch on the seated machine `license_key`;
   key on the authenticated account (the client already stores `installConfigKv.account_email`
   at `OnboardingFlow.tsx:381` — currently used only for switch detection, not station scoping).
3. **Client local path:** decide the contract for `stations:list` (scoped vs. unscoped) and make
   the code match it; add continuous local↔cloud reconciliation (not just in onboarding) so
   stale rows like the OV fixture get pruned on normal launches.

## Blast radius if we instead just scope `stations:list` today (why we did NOT)

Adding `WHERE owner_license_key = <signed-in license>` to `stations:list` would change behavior
for every consumer above, and there is **no clean "currently signed-in license" source** in
`main.js` to filter on. The onboarding prune (`OnboardingFlow.tsx:484/:842`) specifically relies
on `stations:list` returning *all* local rows to sweep cross-license ghosts — scoping it would
break that sweep. It also touches the exact account/license layer being deferred here. So for the
v4.4.0 follow-up we only corrected the misleading comment; the scope itself belongs to this work.
