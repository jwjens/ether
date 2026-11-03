# Multi-tenant data isolation audit — EtherCast backend, storage, streaming

**Date:** 2026-10-05 · **Type:** READ-ONLY diagnosis. No code, schema, data, bucket, or Icecast change was made. No commits.
**Scope:** `C:\ether-backend` (HEAD `d160f2c`), the desktop callers in `C:\openair` (branch `fix/aux-monitor-recovery`, HEAD `6b2dcba`), the committed Icecast templates, and the prod Postgres **system catalogs** (no rows read).
**Receipts rule:** every finding cites file:line, a schema line from the catalog dump, or command output. Anything without one is marked **UNVERIFIED**. These are claims about the **source tree and schema**. Whether an attacker has actually used any of these paths is **UNVERIFIED**, and so is anything the running app does at runtime.

**What was actually run (all read-only):**
1. `railway run --service Postgres node <scratchpad>/mt-schema-audit.js` ran inside `BEGIN READ ONLY` and queried only `pg_class`, `pg_constraint`, `pg_indexes`, `information_schema` and `pg_roles`. It read **no application rows**, so accounts 21 and 23 were never touched. Output: scratchpad `mt-schema-out.txt`.
2. `railway variables --service ether-backend --kv`, filtered so that only variable **names**, lengths and the non-secret `RBAC_*` / `NODE_ENV` / `R2_BUCKET` values were printed.
3. Static reads of the source files cited below.
4. Not run: `wrangler r2 bucket …` (wrangler is not installed locally, `npx` refused to fetch it, and I did not install it), and anything on the Lightsail Icecast box.

---

## Summary table

| # | Area | Current isolation | Risk | Receipt |
|---|------|------------------|------|---------|
| H1 | `POST/GET /api/now-playing` global slot | **None.** Any caller overwrites one process-wide slot, and any caller reads it back | **HIGH** | `ether-backend/src/index.js:242`, `:5206-5223`; desktop poster `openair/electron/main.js:8508-8525` |
| H2 | Legacy DB backups (`/backup/upload`, `/backup/list`) | Filtered by a **client-supplied `station_id`**, not by license | **HIGH** | `index.js:6691`, `:6697-6701`, `:6719-6726`; caller `openair/src/components/CloudBackup.tsx:237` |
| H3 | Daily mutation-log prune | Groups by `(table_name,row_id)` **across all licenses** | **HIGH** | `index.js:1314-1328`, `:1378-1382` |
| H4 | Jukebox public slug | Slug **not owned**: `ON CONFLICT (slug)` re-points it to the caller's station | **HIGH** | `index.js:6091-6098`; `jukebox_pool_pkey PRIMARY KEY (slug)` |
| H5 | Remote Link key pairing | "Account" includes **every license whose email matches** the user's, and signup **never verifies** the email | **HIGH** | `src/lib/link-pairing.js:74-81`; `index.js:2065-2089` |
| M1 | `link_keys` keyed by `machine_id` only | Machine ids are client-chosen and can appear under two accounts | MED | `link_keys_pkey PRIMARY KEY (machine_id)`; `link-pairing.js:93-95`, `:138-165` |
| M2 | Station `stream_url` | Free text. Not tied to an owned mount, and the backend fetches it | MED | `index.js:5965-5967`, `:1873-1894`, `:6888-6898` |
| M3 | Database layer | **No RLS on any table.** The app connects as **superuser + BYPASSRLS**. Isolation is app code only | MED (structural) | catalog dump: every table `rls=false`, `policies=[]`, role `postgres rolsuper=true rolbypassrls=true` |
| M4 | RBAC per-station scope | Enforced only on the station **list**. Every other lk-scoped route sees all of the account's stations | MED (intra-account) | `index.js:1176-1187` (only caller `:2545`); `:2955`; `:3089-3097` |
| M5 | Credentials in URLs | License key in `?key=`. Admin secret in `?secret=`. Key in the `/licenses/:key/*` path | MED | `index.js:6605`, `:1090`, `:3855`, `:3879`; `openair/src/audio/cmd-routing.ts:84` |
| M6 | Plaintext license keys at rest + admin dump | Plaintext copies stored in `licenses` and `license_activations`. `/admin/licenses` returns them all | MED | `index.js:2296-2300`, `:2309-2316`, `:3939`, `:4048`, `:4947-4952` |
| M7 | Platform god-mode | One shared secret. No rate limit, MFA or audit log. Can reset any user's password | MED | `index.js:1268-1275`, `:1482-1521` |
| — | Icecast source password / mount auth / listener caps | **UNVERIFIED.** The production `icecast.xml` is not in any repo | UNVERIFIED (HIGH if global) | template `openair/scripts/playout-service/icecast.xml` (single global `<source-password>`, placeholder) |
| L1 | `/account/attach` | Does not check that `station_uuid` belongs to the caller | LOW | `src/routes/attachments.js:9-24`, `:47-58` |
| L2 | `source_machine_name` lookup | Joins `license_activations` on `machine_id` across **all** licenses | LOW | `index.js:2534-2535`, `:2978-2979` |
| L3 | Library-grant R2 boundary | Sync is whitelisted to songs/artists/albums. R2 grants cover the **whole** owner prefix | LOW | `src/routes/sync.js:66`; `index.js:4677-4683`, `:4743-4749` |
| L4 | Park Ops token compare | `!==` instead of a constant-time compare | LOW | `index.js:5601`, `:5705` |
| ✓ | Per-station mirror, staged, analytics, metadata, cmd bus, R2 audio/backup prefixes, v2 library, sync pull | Correctly scoped (see the last section) | — | see the last section |

---

## HIGH findings

### H1 — One global now-playing slot: every account's live state is overwritten and served publicly

**What's wrong.** `POST /api/now-playing` writes the **entire request body** into one in-memory object, `nowPlaying.data`, shared by the whole process. It does this **before and without** any authentication (`index.js:5206-5210`). `GET /api/now-playing` returns that object to any caller with no auth at all (`index.js:5221-5223`). The per-station upsert after it is properly license-scoped (`:5120-5128`). The global slot is not.

- Every packaged desktop on every account posts here every 3s / 20s keepalive (`openair/electron/main.js:8519-8525`). The body includes `station_uuid`, `station_name`, title/artist/queue, `engine_state`, **`source_machine_id`** and `last_error` (`main.js:8510-8513`, sig fields).
- The comment at `:5207` says OV's `/mobile`, `/dashboard` and `/console` pages read this slot.

**Receipt:** `index.js:242` (`const nowPlaying = { data: null }`), `:5209`, `:5222`.

**Blast radius.**
- **Read.** Anyone on the internet can poll `GET /api/now-playing` and see whichever account posted last. That includes a station's internal `source_machine_id`, which is the precondition for M1, plus its station UUID and last stream error.
- **Write.** Anyone, even with no license, can make OV's companion and emergency pages show arbitrary text.
- **Cross-tenant.** Once a second customer is on air, OV's pages will flicker between OV and that customer's now-playing.

**Recommended fix (described only).** Retire the global slot. Point `/mobile`, `/dashboard` and `/console` at the per-station `station_now_playing` row (by slug for public pages, by JWT for operator pages). If the slot has to stay for one release, require a license on the POST and key the slot per license.

---

### H2 — Legacy Postgres backups are filtered by a client-chosen `station_id`: list and delete other accounts' backups

**What's wrong.** `/backup/upload` and `/backup/list` (BYTEA backups in the `backups` table) use `requireLicense`, but they filter on `station_id` taken from the request:
- `/backup/list`: `const stationId = req.query.station_id || req.license.email` then `... FROM backups WHERE station_id=$1` (`index.js:6719-6722`). **No `license_key` filter.** If no `station_id` is passed, the fallback is the **license email**, which is guessable.
- `/backup/upload` on the `pro` plan: when a `station_id` reaches 30 backups it runs `DELETE FROM backups WHERE id=(SELECT id FROM backups WHERE station_id=$1 ORDER BY created_at ASC LIMIT 1)` (`index.js:6697-6701`). **Not scoped to the caller's license.**
- `download/:id` and `DELETE /backup/:id` *are* scoped by `license_key` (`:6736`, `:6750`).

**Still live in the desktop.** `CloudBackup.tsx:237` calls `/backup/list?station_id=${stationId}`, where `stationId` is a free-text field in that panel (`CloudBackup.tsx:105`, `:496`).

**Blast radius.**
- Any paid license can enumerate another account's backup metadata (filename, size, checksum, description, timestamps) by passing that account's email or station id.
- A `pro` license can upload junk under a victim's `station_id` until the count reaches 30. After that, each further upload **deletes the victim's oldest backup**.
- Side note, not a tenancy issue: bcrypt-only licenses have `license_key = NULL`, so the insert at `:6707` (`license_key NOT NULL`) fails for them.

**Recommended fix.** Add `AND license_key_id = req.license.id` (a new column, backfilled) to every `backups` query, and derive `station_id` server-side. Alternatively, since R2 backups (`/backup/upload-url`) superseded this path, remove the BYTEA route and the CloudBackup list UI that calls it.

---

### H3 — The daily mutation prune collapses rows across accounts, so one account's push can erase another account's sync history

**What's wrong.** `pruneSupersededMutations` keeps only the newest mutation per `(table_name, row_id)` **globally** and deletes every older one more than 2 days old:

```
DELETE FROM mutations m USING (SELECT table_name, row_id, MAX(server_seq) AS keep
  FROM mutations GROUP BY table_name, row_id) g
 WHERE m.table_name=g.table_name AND m.row_id=g.row_id AND m.server_seq < g.keep AND m.received_at < NOW() - …
```
(`index.js:1317-1326`). There is no `license_key_id` in the GROUP BY or the join. It runs every 24h (`:1378-1382`). The comment justifies this with "row_id is a UUID, so (table,row) is globally unique and this never crosses accounts" (`:1312-1313`). That assumption fails in three receipted ways:
1. **Push trusts the client's `row_id`.** `/sync/mutations` stores whatever `row_id` the client sends under the caller's license (`src/routes/sync.js:104`, `:139`). Any license can push an `update` whose `row_id` is another account's row UUID.
2. **Row UUIDs are public.** The jukebox pool publishes song `uuid`s on an unauthenticated endpoint (`index.js:6109-6149`, built by `openair/src/lib/ccData.ts:107-109`). Grantees also receive the owner's song, artist and album UUIDs by design.
3. **Legitimate UUID sharing across accounts.** `clone-programming` copies the owner's category, clock, show and slot UUIDs into the grantee's staging (`index.js:3351`, `:3360`, `:3367`, `:3378`). The importer keeps them (`openair/src/lib/ccData.ts:686`: `uuid: r.row_uuid`). The grantee's install then emits its own mutations with the **same `row_id`** as the owner's.
4. Checkpoints are written as `table_name='__checkpoint__', row_id=''` (`openair/electron/sync/mutation-writer.js:296-297`), so all accounts' checkpoints form a single group.

**Blast radius.** The prune can delete the **latest** mutation an account holds for a row: the one a fresh device or a re-sync needs. Account A's newer write wins the global `MAX(server_seq)`, which also beats B's single row. B's next sign-in on a new machine is then missing those rows. That breaks the "account is the root, pull everything down on any computer" guarantee in CLAUDE.md.

The grantee/clone path (point 3) needs no malice. Whether it has already deleted rows in prod is **UNVERIFIED**. Checking would need an aggregate over every license's rows, which I did not run because of the rule about accounts 21 and 23.

**Recommended fix.** Add `license_key_id` to both the GROUP BY and the join (`GROUP BY license_key_id, table_name, row_id … AND m.license_key_id = g.license_key_id`). Separately, leave checkpoints out of the prune.

---

### H4 — Jukebox slugs aren't owned: any license can take over another station's public jukebox

**What's wrong.** `POST /api/account/jukebox/pool` checks that `station_uuid` belongs to the caller (`index.js:6085-6087`). The `slug`, however, is free text (`:6079`, format check only at `:6083`), and the upsert is:

```
INSERT INTO jukebox_pool (slug, station_uuid, license_key_id, …) VALUES …
ON CONFLICT (slug) DO UPDATE SET station_uuid = EXCLUDED.station_uuid, license_key_id = EXCLUDED.license_key_id, songs = EXCLUDED.songs …
```
(`:6092-6098`). `slug` is the table's primary key (catalog: `jukebox_pool_pkey PRIMARY KEY (slug)`). Nothing checks it against `station_metadata.slug`, which *is* uniquely owned.

**Blast radius.**
- Account A publishes using B's slug. B's printed QR codes now show A's song list.
- `POST /public/jukebox/<slug>/request` delivers guests' requests, including names and requester tokens, to **A's** desktop. The request handler emits to `jb.license_key_id` (`:6470`).
- `/api/account/jukebox/state` then lets A write B's lobby display (`:6170-6177`), because the ownership check passes once A owns the row.
- The `station_payouts` join is by `station_uuid` (`:6117`). Today it only shapes the donation block, and nothing charges yet (`:6121-6123`). Once phase-3 charging exists, a hijacked slug would surface A's payee to B's guests.

**Recommended fix.** Derive the jukebox slug server-side from the caller's `station_metadata.slug` and refuse any other. At minimum, refuse an `ON CONFLICT` where the existing row's `license_key_id` differs from the caller's.

---

### H5 — Remote Link pairing trusts an unverified email: a stranger can read or replace a customer's on-air link keys

**What's wrong.** `/api/link/*` sits behind `requireUser` (any `typ:"user"` JWT). It defines "the account" as:

```
SELECT id, license_key FROM licenses WHERE active = true AND (id = $1 OR LOWER(email) = $2)
```
where `$2` is the signed-in user's email (`src/lib/link-pairing.js:74-81`). The account's machines are those licenses' active activations (`:83-92`).

`POST /api/user/signup` creates a user for any unused email and **returns a `typ:"user"` token immediately** (`index.js:2072-2087`). It sends a verification mail, but nothing anywhere reads `email_verified`. Many licenses exist with no `users` row: Stripe-issued, platform-minted and legacy keys. `/api/platform/account/create` exists precisely because of that gap (`index.js:1534-1537`).

**Attack shape.** Someone signs up with a customer's purchase email, provided that customer has no web login yet. They then call:
- `GET /api/link/machines` to list the customer's machines, names, OS and last-seen (`link-pairing.js:120-136`)
- `GET /api/link/key/:machineId` to get the customer's published **link key** (`:155-165`)
- `PUT /api/link/key` to **replace** that key (`:138-153`)

**Blast radius.** Per `docs/remote-link-design-2026-09-28.md:91-94`, the link key is the ChaCha20-Poly1305 key that authenticates audio packets into a station's **on-air Link fader**. With the key and network reach to the receiver, an attacker can inject audio into another station's air chain, or swap the key and break that station's remote. This is the most severe on-air outcome in this audit.

**Measured 2026-10-05 (read-only, totals only):** 0 of 8 active licenses are exposed. Every active license email already has a `users` row, and 0 published link keys are reachable this way (`docs/h3-prune-fix-plan.md`, Implementation record). The defect is latent: it arms for any future license issued without a web login.

**Recommended fix.** Define the account by `users.license_key_id` and active memberships only, never by a license's email. Separately, enforce email verification before any token that reaches account-linked data is issued.

---

## MEDIUM findings

### M1 — `link_keys` is keyed by `machine_id` alone, and machine ids cross accounts
- `link_keys` has `PRIMARY KEY (machine_id)` (catalog). `inAccount()` passes for any machine that has an active activation on the caller's account (`link-pairing.js:93-95`).
- Machine ids are client-supplied. Every seat route takes `machine_id` from the request body (`index.js:3770`, `:4026`, `:4112`).
- They are also **deliberately stable across account switches** (memory "Stable machine identity": `LocalAppData\EtherMachine\machine-id` survives wipes).
- They leak publicly via H1 (`source_machine_id` in the global slot).

**Blast radius.**
- A machine that moved from account A to account B (with A's seat never deauthorized) lets A's users read and overwrite the link key B's install publishes.
- Anyone who learns a machine id can register a seat with that id on their **own** license (`/account/bind-seat`, `index.js:4175-4186`, scoped only by license) and then fetch or replace that machine's link key.

**Fix.** Key `link_keys` by `(license_key_id, machine_id)`, or by station, which is what the design doc describes at `:91`. Resolve the caller's license from the token, never from machine membership alone.

### M2 — `stream_url` is unvalidated free text: impersonation, polluted royalty numbers, blind SSRF
- `POST /api/station/:uuid/metadata` stores `b.stream_url` verbatim (`index.js:5965-5967`).
- Every 60s the backend fetches `${protocol}//${host}/status-json.xsl` for each public station's `stream_url` (`:1873-1881`, `:6888-6898`) and records the listener count as that station's `station_stream_samples`, which feeds ATH in the platform royalty rollup (`:1909`, `:1920-1922`).

**Blast radius.**
- Account A can point its public page at B's mount. Listeners then hear B under A's branding.
- A's stream samples count **B's listeners**, which corrupts the ATH figures submitted to ASCAP, BMI and SoundExchange.
- The backend makes outbound requests to any host an account names. That is a blind SSRF; only a number is stored.

**Fix.**
- Allocate mounts server-side and store `mount`, not a URL.
- Reject any `stream_url` that isn't on the managed stream host and isn't a mount assigned to that station.
- Allow-list the status-poll host.

### M3 — No database-level isolation
The catalog dump shows `rls=false` on all 31 public tables and `policies = []`. The app role is `postgres` with `rolsuper=true, rolbypassrls=true`.

Tenant keys are inconsistent:
- `license_key_id` (int): `stations`, `mutations`, `library_*`, `station_attachments`, `jukebox_pool`, `station_payouts`, `account_users`
- `license_key` **text** (the raw key): `license_activations`, `backups`
- `station_uuid` only, scoped through a join to `stations`: `station_cc_data`, `staged_programming`, `station_*`, `listener_sessions`
- `machine_id` only, with no tenant key: `link_keys`, `link_pair_codes`
- `guest_presence` has none

Every isolation guarantee therefore depends on each query remembering its `WHERE`, and H2, H3 and H4 are exactly that failing.

**Fix (described).**
- Add a non-null `license_key_id` to every tenant table, with FKs.
- Run the API as a non-superuser role.
- Add RLS policies keyed on a per-request `SET LOCAL app.license_id`. Platform routes use a separate role.
- Replace the text `license_key` tenant columns with `license_key_id`.

### M4 — RBAC station scope is enforced on one route; everything else is account-wide (intra-account)
- `RBAC_MEMBERSHIP_ENFORCE=1`, `RBAC_MEMBERSHIP_SHADOW=1` and `RBAC_MEMBERSHIP_SYNC=1` are set on Railway (env output).
- `membershipStationFilter` is called only from `GET /api/account/stations` (`index.js:2545`; definition `:1176-1187`).
- After `POST /api/me/switch-account`, the token has `lk = accountId`, and `role` maps to `admin` for any position holding `manage_stations`, `manage_users` or `manage_account` (`:2955`).

So a station-scoped member, a PIN operator, or an Engineer/PD mapped to `admin`, can still:
- read any of the account's stations' mirror, health, analytics, affidavit and listeners (`:3089-3097`, `:3126-3143`, `:3505-3508` via `stationReadable` `:1259-1266`)
- issue `/api/cmd` to any of them (`:6549`)
- edit public metadata (`:5901`)
- create or delete stations and PIN users, and get R2 upload URLs (`requireAuthAdmin`, `:2588`, `:2641`, `:2677`, `:3426`)

This is **not cross-account**, but it does break the RBAC design's per-station promise (`docs/account-users-rbac.md`).

**Fix.** One `authorizeStation(req, uuid, perm)` helper that applies the membership scope and permission. Call it from every `/:uuid` route and from `stampStationCommand`.

### M5 — Credentials in URLs
- The desktop opens `/api/cmd-stream?key=<license>&machine_id=…` (`openair/src/audio/cmd-routing.ts:84`; server `index.js:6605`).
- `requireAdmin` accepts `?secret=` (`:1090`).
- `/licenses/:key/activations` and `/licenses/:key/deactivate` put the key in the path (`:3855`, `:3879`).

Query strings and paths land in Railway, Cloudflare and proxy access logs. A logged license key is a full credential for that account: sync, audio, backups and the command bus.

**Fix.** Use a short-lived per-connection SSE token minted by a POST, header-only admin auth, and keys in bodies or headers.

### M6 — Plaintext license keys at rest; `/admin/licenses` returns them
- Trial and desktop-activate keys are stored in plaintext in `licenses.license_key` alongside the hash (`index.js:2296-2300`, `:2309-2316`).
- For bcrypt licenses, `/account/create`, `/account/connect`, `/account/bind-seat`, `/account/add-station`, `/account/deauthorize-seat` and `/account/seats` use the raw key as `license_activations.license_key` (`:3939`, `:4048`, `:4125`, `:4229`, `:4448`, `:4483`).
- `/admin/licenses` returns `license_key` for up to 500 licenses behind one 16-character `ADMIN_SECRET` (`:4947-4952`; env: `ADMIN_SECRET (set, len=16)`), and that secret is accepted in the URL (M5).

A database read, or a leak of the admin secret, yields every tenant's credential.

**Fix.**
- Store only `key_prefix` + `key_hash`.
- Key activations by `license_key_id`.
- Remove plaintext from the admin listing.

### M7 — Platform god-mode is one shared secret
- `POST /api/platform/login` swaps `ETHER_PLATFORM_SECRET` for a 12h `{platform:true}` JWT (`index.js:1268-1275`).
- It has **no `authLimiter`**, unlike `/api/user/*` (`:1992-1996`).
- That token can reset any user's password and relink any email to any license (`:1482-1521`, `:1749-1773`), delete accounts (`:1445`), and read all play history (`:1961`).
- There is no per-operator identity, MFA or audit trail.

That is expected for the Track-2 console, but it is the single key to all tenants.

**Fix.**
- Per-person platform logins with MFA.
- An append-only audit table for platform writes.
- The auth limiter on `/api/platform/login`.

---

## Streaming (Icecast) — mostly UNVERIFIED

| Question | What the tree says | Status |
|---|---|---|
| One source password or one per station? | The only committed config, `openair/scripts/playout-service/icecast.xml` (the cloud-playout template), has a single global `<source-password>` (placeholder value, length 6, flagged as a placeholder by the check), one `/live` mount and no per-mount `<password>`. `scripts/server-setup.sh:377-380` is the same, with `hackme`. | **UNVERIFIED for production** (Lightsail `stream.ether-technologies.com:8443`, mounts `/ov` and `/usph`): the prod `icecast.xml` is not in any repo |
| Where the password is stored and who reads it | Per station, in the desktop's SQLite `stations.icecast_password`, typed by the operator (`openair/src/components/StationManager.tsx:355`), excluded from peer-sync (`openair/electron/sync/synced-tables.js:1088` `'local-only'`). It is **included** in the whole-DB R2 backups (`/backup/upload-url`, own license prefix `index.js:4817`). | Receipted |
| Admin credential on customer machines? | `StreamManager.tsx:68-70` sends `/admin/metadata` with `Basic admin:<station password>`, which means either the admin password equals the source password, or Icecast accepted per-mount source credentials | **UNVERIFIED**. If the admin password equals a password shared with customers, every customer can kill or relabel any mount |
| Slug → mount mapping enforced server-side? | **No.** The desktop prefixes `https://stream.ether-technologies.com:8443/` client-side (`SettingsPanel.tsx:1641`). The backend stores any `stream_url` (M2). Nothing in the backend provisions mounts. | Receipted (no server enforcement) |
| Listener limits per station | Template: global `<clients>100</clients>`, `/live` `<max-listeners>100`. Prod: unknown | **UNVERIFIED** |
| Can one account's config expose another's stream or credentials? | Stream: yes, via M2 (`stream_url` pointing at another mount). Credentials: no backend route returns `icecast_password` (grep found it only in desktop code). | Receipted |

**Risk if prod uses one global source password (common Icecast default):** any customer who has been given that password can connect a source to **any** mount. That means taking over OV's `/ov` mount, squatting unused mounts, or (if `admin` shares it) killing sources. Treat as **HIGH until verified**.

**The one check that settles it:** on the Lightsail box, `sudo grep -nE "<source-password>|<mount|<mount-name>|<password>|<username>|<max-listeners>|<admin-password>" /etc/icecast2/icecast.xml`. Redact the values; only whether each mount has its own `<password>` matters.

---

## R2 / storage

- **Key structure.** All private customer objects live under the integer license id in one bucket (`R2_BUCKET=ether-backups`, from the env output):
  - audio at `${license.id}/<basename>` (`index.js:4543`, `:4602`, `:4685`; dashboard uploads `:3438`)
  - backups at `${license.id}/backups/<ts>.db.gz|.meta.json` (`:4817-4818`)
  - the catalogue manifest at `${license.id}/_ether-catalogue-manifest.json` (`openair/electron/audio-library-r2.js:48`)

  The prefix comes from the **server-resolved license**, never from the request. `sanitizeFileKey` rejects `/`, `\`, dot-segments and NUL (`:133-144`), so a caller can't escape its prefix or reach `backups/`.
- **Serving.** Presigned PUT and GET URLs expire after 15 minutes (`:4544`, `:4686`, `:4819`, `:4876`). There is no proxy and no public URL for the private bucket in code. A presigned URL is a bearer credential for its key until it expires (inherent to S3-style signing); it cannot be widened to another key.
- **Listing.** Only server-side, under the caller's own prefix plus granted owners' prefixes (`/audio/list` `:4743-4749`; `/backup/download-url` `:4868-4870`). Clients hold no R2 credentials (`:78-82`). Whether the `ether-backups` bucket has a public r2.dev URL or custom domain enabled is **UNVERIFIED**. Memory says it "stays private", and settling it takes `wrangler r2 bucket dev-url get ether-backups` and `… domain list ether-backups`.
- **Public bucket** (`ether-public`, intentionally anonymous): `account-logos/<license_id>.<ext>` (`:2213`), `station-logos/<uuid>.<ext>` (`:6019`), `now-playing-art/<uuid>/<hash>.<ext>` (`:6041`). The keys are guessable by design and hold only public art. The one wrinkle: account logos expose the integer license id in a public URL.
- **Cross-account dedupe.** None. `library_songs` has `PRIMARY KEY (license_key_id, content_hash)` (catalog), and R2 keys are license-prefixed. Library data crosses accounts only through explicit, platform-gated `library_grants` (`index.js:1822-1842`).
- **L3 — the grant boundary is wider in R2 than in sync.**
  - Sync shares only `songs`, `artists` and `albums` (`sync.js:66`, `:216-218`).
  - `/audio/download-url` signs **any** top-level basename found under a granted owner's prefix (`index.js:4677-4683`), which includes `_ether-catalogue-manifest.json`.
  - `/audio/list` returns every key under the owner's prefix, **including `backups/<ts>.db.gz` names** (`:4744-4749`). The names are visible but can't be downloaded, because of the sanitizer.
  - Fix: limit grant resolution to keys that match the owner's synced `songs.file_key`, and filter `backups/` and `_`-prefixed keys out of listings.
- **Backup restore across accounts.** Not possible on the R2 path: `/backup/download-url` lists only `${license.id}/backups/` (`:4868`). The legacy BYTEA path is H2.

---

## Licensing & auth

- **The license row is the account.** `account_name`, `account_slug` and `onboarded_at` live on `licenses` (`index.js:424-432`), and stations hang off `stations.license_key_id` (FK, catalog).
- **Token types:**
  - license key (`x-license-key` header or body, via `lookupLicense` `:1034-1051`)
  - PIN-operator JWT `{uid, lk, role}` (`:1112-1117`)
  - owner JWT `{typ:"owner", lk, role:"admin"}` (`:2477-2482`)
  - user JWT `{typ:"user", uid, email}`, which has **no `lk`** (`:2024-2026`)
  - switch-account JWT `{lk:accountId, role, position}` (`:2956-2958`)
  - platform JWT `{platform:true}` (`:1273`)

  All are HS256 with `JWT_SECRET` (set, 64 characters, from the env output).
- **Can one account's license or JWT reach another's resources?** On every route I read, the tenant id is taken from the verified credential (`license.id` or `req.auth.lk`) and each per-station route re-checks `stations.uuid = $1 AND license_key_id = $2` before acting. The exceptions are exactly H1, H2, H4, H5, M1, L1 and L2. A user JWT carries no `lk`, so on `lk`-scoped routes its queries bind `undefined` and return nothing. The platform JWT is honoured only where `requireAuth` explicitly checks `req.auth.platform` (`requirePlatform` `:1252-1257`, `stationReadable` `:1260`).
- `/account/register-station` and `/account/delete-station` refuse a uuid owned by another license (`:4364-4366`, `:4405-4407`).
- `/api/accounts/:accountId/*` resolves membership for the path account and refuses cross-account station grants (`:2850-2851`).

---

## Background jobs & pipelines

| Job | Carries tenant? | Limited to it? | Receipt |
|---|---|---|---|
| Daily mutation prune | **No** | **No (H3)** | `index.js:1314-1328`, `:1378` |
| SSE listener sampler (60s) | Per slug → station_uuid | Yes | `:6873-6883` |
| Icecast stream sampler (60s) | Per station, from that station's own `stream_url` | URL not owned (M2) | `:6888-6898` |
| Stripe platform webhook | Signed; ignores connected-account events | Yes | `:4980`, `:5013-5016` |
| Stripe jukebox webhook | Signed, its own secret; updates by `stripe_account_id` (UNIQUE) | Yes | `:6395`, `:6408-6425` |
| Desktop R2 backup (`cloud-backup.js`) | License key → server prefix | Yes | `openair/electron/cloud-backup.js:90`; `index.js:4817` |
| Desktop audio delete sweep | License key → server prefix | Yes; a grantee can't delete an owner's object | `index.js:4602-4608` |
| Transcoding / analysis on the backend | None exist in `ether-backend` | — | route list (no such job) |

---

## Already correctly isolated (with receipts)

- **CC data mirror, desktop → web.** `/api/account/data/sync` checks that the station belongs to the license before upsert or reconcile (`index.js:3031-3034`). Reconcile is scoped to `(station_uuid, table_name)` (`:3075-3078`). A push from account A cannot write account B's rows. The reads (`/data` `:3094-3097`, `/health` `:3140`) are scoped by `lk`.
- **Staged programming** (deprecated, but live). Every dashboard and install route checks ownership (`:3182`, `:3202`, `:3222`, `:3242`, `:3263`). The clone routes read only the caller's **granted** owner (`:3284-3287`, `:3326-3329`).
- **Per-station now-playing upsert** (`:5124-5128`). **Play-history ingest** (`:3468-3471`). **Ops token mint** (`:5562-5565`).
- **Analytics, affidavit, listeners, listenership.** `stationReadable` requires `license_key_id = lk`, unless the caller holds a platform token (`:1259-1266`).
- **Public metadata.** `getOwnedStation` (`:5837-5857`). Slugs are globally unique (`station_metadata_slug_key`) and history-protected against squatting (`:5911-5918`). The public endpoints return only stations with `public_enabled = true` (`:5311`, `:5400`, `:5745`, `:5809`).
- **Command bus.** Delivery queues and SSE clients are keyed by license id (`index.js:238-239`; `cmd-bus.js:21-27`). Station commands are re-stamped server-side to the station's own source machine, after an ownership check (`index.js:6508-6511`; `station-commands.js:59-61`, `:79-84`). Acks are per license (`cmd-bus.js:91-104`; `index.js:6597`). Park Ops writes resolve the license from the station, never from the request (`:5638-5641`, `:5717-5723`).
- **Sync pull.** `license_key_id = $own` in all three branches (`sync.js:213`, `:225`, `:237`). Cross-license rows come only from active grants, whitelisted to `songs`, `artists` and `albums` (`:66`, `:216-218`). A push is always stored under the authenticated license (`sync.js:137`), so it can never surface in another account's pull. The H3 prune is the only place push data affects another tenant.
- **v2 library.** Every read and write is keyed by license, plus explicit grant owners (`routes/library.js:17-20`, `:59-69`, `:84-86`).
- **Seat and station onboarding.** `/account/bind-seat` refuses a station outside the license (`:4139-4149`). Seat counts are per activation key.
- **Members/positions RBAC (account boundary).** `requireMember` pins to the path account (`:1231-1244`). Station grants are re-checked against that account (`:2850`). There is a rank ceiling on assign, remove and create-position (`:2824`, `:2867`, `:2904-2906`).
- **Stripe donations.** The platform webhook ignores connected-account events (`:5013-5016`). The jukebox webhook requires one (`:6401-6404`).

---

## Open questions (could not answer read-only)

1. **Icecast production config.** Is there one global `source-password`, or one per mount for `/ov` and `/usph`? Does `admin-password` equal any password a customer has been given? Are there per-mount `max-listeners`? (Check: the grep above, on Lightsail.)
2. **Is the `ether-backups` bucket private?** Is r2.dev or a custom domain enabled, and what is its CORS policy? (Check: `wrangler r2 bucket dev-url get ether-backups`, `wrangler r2 bucket domain list ether-backups`.)
3. **Has H3 already deleted another account's latest rows?** Detecting it means grouping `mutations` by `(table_name,row_id)` with `COUNT(DISTINCT license_key_id) > 1`. That aggregate scans accounts 21 and 23, so I did not run it. Your call.
4. ~~How many active licenses lack a `users` row (H5)?~~ **Answered 2026-10-05:** 0 of 8 exposed.
5. **Does anything still read the global `/api/now-playing` slot** besides the three OV pages named in the comment (`index.js:5207`)? The listener PWAs and the dashboard live in other repos and weren't audited for this.
6. **Retention of Railway and Cloudflare access logs** containing `?key=` and `?secret=` (M5).
7. **Whether `CloudBackup.tsx`'s legacy backup list is still reachable** from a door in the shipped UI. The code calls it (`:237`). Runtime reachability is UNVERIFIED.

---

## Out of scope, noted in one line each (not investigated)
- `POST /invite/send` is unauthenticated: anyone can send Ether-branded email to any address (`index.js:6761`).
- `/api/platform/login` has no rate limiter (`index.js:1268`), already covered under M7.

**Architecture compliance:** this is a diagnosis only, and nothing was built. The governing docs consulted were CLAUDE.md ("account is the root", "Desktop app tenancy: stations scoped by owner_license_key"), `docs/account-users-rbac.md` (RBAC design, cited by M4), and `docs/remote-link-design-2026-09-28.md` (link key semantics, cited by H5 and M1). No temporary tooling persists: the one diag script is in the session scratchpad, ran once, and installed nothing.

**Stop.** Awaiting Jeff's review and an explicit GO before any change.
