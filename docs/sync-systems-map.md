# Sync Systems Map

**Read this before touching anything that moves data between machines or between a machine and the
cloud.** Ether has **seven** independent data-movement systems. They share tables, they trigger each
other, and none of them knows the others exist. Every multi-machine incident to date has been two of
these systems meeting at a table neither of them owns.

Status: 2026-08-17. Written after the 4.4.219→4.4.224 sync incidents.
Companion: `docs/freeze-inventory-2026-08-17.md` (the measured state that motivated this).

---

## The seven systems at a glance

| # | System | Direction | Trigger | Owns |
|---|---|---|---|---|
| 1 | **CRDT mutation sync** | ⇄ backend, peer-to-peer | scheduler, gated by `sync_enabled` + signed-in | `mutations`, 40 registry tables |
| 2 | **Control Center push** | → cloud dashboard | 60 s / 3 min timers | `station_cc_data` (server-side) |
| 3 | **Account/license sync** | ⇄ backend | 20 s poll + 6 h heartbeat | `install_config_kv`, `stations.owner_license_key` |
| 4 | **Cloud backup** | ⇄ R2 (whole DB) | 6 h timer, manual restore | the entire `openair.db` file |
| 5 | **R2 audio** | ← R2 (bytes) | 45 s prefetch tick | files on disk, `local_files` |
| 6 | **Site replication (LAN)** | ⇄ LAN peers | poll timer | `replication_*` — **dormant** |
| 7 | **Ether2Go mobile** | ← phone | on upload | `voice_tracks` + audio files |

**The rule that keeps these apart:** system 1 is the only one allowed to write *shared state*.
Everything else either writes machine-local state or pushes a read-only projection outward. Every
bug below is a violation of that rule.

---

## 1. CRDT mutation sync

The real multi-machine system. Everything else is a projection.

**Code** `electron/sync/` — `sync-scheduler.js` (timing) → `sync-engine.js` (push/pull batching) →
`merge-engine.js` (apply + conflict) → `mutation-writer.js` (serialize) · registry in
`synced-tables.js` · wire in `transport-http.js`

**What data** 40 tables in `REGISTRY` (`synced-tables.js`). Station-scoped: `stations`, `clocks`,
`clock_slots`, `categories`, `shows`, `spots`, `play_log`, `scheduled_log`, `station_config_kv`,
`station_programming`, `separation_rules`, … Install-scoped: `install_config_kv`, `operators`,
`songs`, `song_metadata_values`.

**Direction** Bidirectional. Push local `mutations` rows where `sync_status='pending'`; pull peers'
mutations by HLC cursor and apply.

**Trigger** `sync-scheduler.js`, gated two ways:
- `sync_enabled` — read via `syncFlagForActiveStation()` (`main.js:2217`) **for the ACTIVE station**
- an operator signed in — `sync:set-active` from `App.tsx:1033`

**State keys** (`system_state`)

| key | meaning |
|---|---|
| `hlc_last` | this machine's hybrid logical clock |
| `sync_cursor` | JSON: per-peer `client_id` → last applied HLC |
| `sync_server_seq` | last server sequence consumed |
| `baseline_hlc` | journal-wipe watermark — mutations at or below this are never re-sent |
| `sync_initial_drained` | first-sync completed |
| `rebaseline_started` / `rebaseline_done` | 4.4.219 baseline migration markers |

Identity: `client_identity.client_id` = `%LOCALAPPDATA%\EtherMachine\machine-id`, stable across
wipes (`main.js:992`).

**Exclusions — three separate mechanisms, do not confuse them**

1. **Whole table** — `syncExcluded: true` or `scope: 'local-only'` in the registry. Currently:
   `generated_schedule` (Ruling A), `install_secrets_kv`, `monitor_routing`. Collected into
   `EXCLUDED_TABLES` at `sync-engine.js:39`.
2. **Whole column** — `'local-only'` in a table's `columns` map. Dropped from payloads in both
   directions (`mutation-writer.js:456`). E.g. `generated_schedule.state/played_at/seq/source`,
   `rtmp_destinations.stream_key`, `stations.icecast_password`.
3. **Single KV key** — `LOCAL_ONLY_KEYS` / `LOCAL_ONLY_PREFIXES` in
   `handlers/station_config_kv.js:51`. Written only through `station_config_kv:set-local`, which
   bypasses `withMutation` entirely. Currently `log_reader_flip`, `auto_generate_enabled`,
   `kill_designation`, `schedule_layout_v1`, `sweep_last_run`, `grid_widths_*`.

**Where it conflicts**

- **With itself, over integer ids.** `station_id` is a local AUTOINCREMENT integer, not a uuid. The
  apply path (`merge-engine.js:193-256`) does `INSERT OR REPLACE`, and `uuid` is UNIQUE — so a
  REPLACE deletes the local row and re-inserts it. Whether the local integer id survives depends
  entirely on the `sync_uuid_identity` flag (`merge-engine.js:219-227`). **Flag off → the sender's
  integer id is written verbatim → every local child row is orphaned.** This has now happened
  twice; see "The station re-key" below.
- **With system 3.** License stamping writes `station_config_kv.license_key`, which is a synced
  table, so an account-layer refresh becomes CRDT traffic. See the loop in §3.
- **With system 5.** `file_path` is typed `blob-ref`, and in v0 a blob-ref *is the literal absolute
  path* (`mutation-writer.js:489`). Machine A's paths land in machine B's database. See §5.

---

## 2. Control Center push (cloud dashboard)

**Code** `src/lib/ccData.ts` — `pushCcTable`, `pushLibrary`, `pushPlayHistory`,
`importStagedProgramming`

**What data** A read-only projection of local tables into the server-side `station_cc_data` store
that backs the web dashboard — plus one inbound path, `importStagedProgramming`, which pulls
programming authored in the dashboard (categories/clocks/slots/shows).

**Direction** Mostly desktop → cloud. `importStagedProgramming` is cloud → desktop.

**Trigger** Timers in `App.tsx`:
- `setInterval(push, 60_000)` — `App.tsx:958`, CC table projection
- `setInterval(push, 3*60*1000)` — `App.tsx:968`, play history
- `setInterval(syncCloud, 20*1000)` — `App.tsx:993`, reconcile + staged import

**Where it conflicts** The 20 s timer is shared with system 3, and that is where the license loop
lives. `importStagedProgramming` writes real programming rows through the ordinary IPC handlers,
which means **cloud-authored programming becomes CRDT mutations** and propagates to peers. Two
machines both importing the same staged programming will both journal it.

---

## 3. Account / license sync

**Code** `src/lib/licenseGuard.ts` (decision + heartbeat) · `src/lib/ccData.ts:333`
(`stampLicenseEverywhere`) · `ccData.ts:391` (`reconcileAccountStations`) · backend
`/account/connect`

**What data** The account's license key, plan tier, and validation state.

**Three storage slots**, resolved in this priority order by `transport-http.js:127-129`:

1. `install_config_kv.account_license_key` — the anchor (install-scoped, syncs)
2. `stations.owner_license_key` — per station (syncs)
3. `station_config_kv.license_key` — legacy slot (syncs, station-scoped)

Plus install-local state: `license_state`, `license_last_validated_at`, `plan_tier`.

**Trigger**
- `startLicenseGuard()` — launch + 12 s, then every **6 h** (`licenseGuard.ts:187`)
- `reconcileAccountStations` on the **20 s** poll (`App.tsx:993`) — this is the hot path
- sign-in, onboarding, Subscription panel

**Where it conflicts** `stampLicenseEverywhere` writes slot 3 through
`stationConfigKv.upsertByKey` — a **mutation-logging** writer — once per station per call, with
**no value-equality guard** (`ccData.ts:345`; contrast line 342, which does guard
`owner_license_key`). `stationConfigKvUpsertByKey` also has no no-op guard
(`handlers/station_config_kv.js:236-246`). Result: `stations × every 20 s` no-op CRDT mutations,
forever, on both machines. Measured 2026-08-17: 2,312 `license_key` mutations, **100 % of them with
`payload_before.value == payload_after.value`.**

---

## 4. Cloud backup (whole-database)

**Code** `electron/cloud-backup.js` · restore + `station:install-from-cloud` at `main.js:4668`

**What data** The entire gzipped `openair.db`, plus a metadata JSON.

**Direction** Desktop → R2 (backup); R2 → desktop (restore/install).

**Trigger** Default every 6 h, tier-gated to pro+; manual restore; new-install seeding.

**Where it conflicts** This is the bluntest instrument in the product. A restore replaces
`mutations`, `system_state` (`hlc_last`, `sync_cursor`, `baseline_hlc`) and `client_identity`
wholesale with another machine's. The restore path re-stamps identity afterwards
(`main.js:4765-4766`) precisely because of this — but note that `main.js:4766` is
`UPDATE station_config_kv SET value = ? WHERE key = 'license_key'` with **no station scope**, so it
rewrites every station's row in one statement.

**Rule:** a cloud restore invalidates every peer's cursor for this machine. Treat a restored machine
as a new node.

---

## 5. R2 audio (the bytes)

**Code** `electron/library-health.js` (prefetch) · `electron/audio-resolver.js` (hash resolution) ·
`electron/deletion-sweep.js` (release) · `main.js` `/audio/download-url`

**What data** Audio files. Never rows.

**Trigger** `prefetchTick()` every **45 s** (`library-health.js:580`), plus one pass 8 s after boot.

**How it resolves a file — two competing designs, both live**

- **The correct one** (`audio-resolver.js`): identity is `content_hash`. `songs_v2` holds the
  identity, `local_files` maps hash → this machine's path, R2 is the fallback. **Neither
  `songs_v2` nor `local_files` is in the sync registry** — they are per-machine by construction.
  This design is machine-independent and correct.
- **The legacy one** (`library-health.js:506`): `SELECT COALESCE(g.file_path, s.file_path)`, then
  `fetchToPath()` does `fs.mkdirSync(path.dirname(targetPath))` at line 492. `s.file_path` comes
  from `songs`, which **syncs**.

**Where it conflicts** See §5 of the incident notes below — this is the music-path leak.

---

## 6. Site replication (LAN peer-to-peer) — dormant

**Code** `electron/site-replication.js` · tables `replication_config`, `replication_peers`,
`replication_log`

An older LAN-based station-to-station sync: HTTP polling, last-write-wins on `updated_at`, metadata
only. Overlaps system 1's table list almost exactly (`songs`, `shows`, `clocks`, `clock_slots`,
`spots`, `macros`, `categories`, `separation_rules`, `smart_schedule_rules`).

**Status: not running.** `replication_peers` is empty; only `replication_config.site_id` is set.

**Where it would conflict** Catastrophically. It writes the same tables as system 1 with a different
conflict rule (`updated_at` LWW vs HLC) and **no mutation journal**, so its writes would be
invisible to CRDT peers while overwriting their state. Do not enable it without deciding which
system owns those tables.

---

## 7. Ether2Go mobile companion

**Code** `electron/mobile-app.js` — PWA served at `/m`, bearer-token paired

**What data** Voice tracks recorded on a phone → `voice_tracks` rows + audio files.

**Where it conflicts** Low risk. It writes through the normal handlers, so its rows journal and sync
correctly. Note `voice_tracks.file_path` is a `blob-ref` and inherits the §5 path problem.

---

## The three cross-cutting hazards

### A. Integer station ids in a uuid world

`station_id` is a per-machine AUTOINCREMENT. OV numbers its stations 1–4; OVEVENTS numbered its
5–8. Every station-scoped row carries that integer. Sync ships it verbatim unless uuid-identity is
on.

Protection lives in exactly two places, **both gated on `this._uuidIdentity`**:
- `merge-engine.js:201` — `_remapRefs()` rewrites the sender's ids to local ids by uuid
- `merge-engine.js:219-227` — preserves the local integer id across `INSERT OR REPLACE`

The flag comes from `syncFlagForActiveStation(db, 'sync_uuid_identity')` (`main.js:3023`).
**Before 4.4.224 that read was unscoped** (`WHERE key = ? LIMIT 1`, no station filter, no ORDER BY)
and returned the lowest rowid — an orphan row from a station that no longer exists.

A partial `station_uuid` column exists on the child tables but is only ~4 % backfilled. It is not
yet a usable anchor.

### B. `blob-ref` is a lie in v0

`mutation-writer.js:483-493` wraps a `file_path` as
`{__blob_ref, __blob_size, __blob_origin}` — but `__blob_ref` is `String(val)`, the **original
absolute path**, with the comment "use original path as opaque ref in v0". `deserializePayload`
restores it verbatim. Eight tables carry a `blob-ref` path column: `songs` (also
`intro_version_path`), `play_log`, `scheduled_log`, `cart_slots`, `spots`, `voice_tracks`,
`announcements`, `published_episodes`.

So `C:\Users\jensj\...` lands in OV's database and `C:\Users\projector\...` lands in OVEVENTS's.

### C. Timers that write shared state

Any timer that writes a **synced** table generates CRDT traffic at that timer's frequency, times the
number of rows it touches. Current inventory:

| Timer | Period | Writes a synced table? |
|---|---|---|
| `syncCloud` → `stampLicenseEverywhere` (`App.tsx:993`) | 20 s | **YES** — `station_config_kv`, `stations` |
| `prefetchTick` (`library-health.js:580`) | 45 s | no (files only) |
| `pushCcTable` (`App.tsx:958`) | 60 s | no (outbound projection) |
| `pushPlayHistory` (`App.tsx:968`) | 3 min | no (outbound projection) |
| license heartbeat (`licenseGuard.ts:198`) | 6 h | **YES** (via the same stamp) |
| cloud backup | 6 h | no |

**Before adding a timer, check this table.** A 20 s timer that touches four station rows is 17,280
mutations a day, per machine.

---

## Checklist before changing anything in sync

1. **Which of the seven systems does this belong to?** If the answer is "two of them", stop.
2. **Does it write a table in `REGISTRY`?** Then it journals a mutation and every peer gets it.
3. **Does it write on a timer?** Add a value-equality guard, or it will loop.
4. **Does it carry a filesystem path?** Paths are machine-local. Use `content_hash` + `local_files`.
5. **Does it carry an integer `station_id`?** Confirm uuid-identity is on for the **active** station.
6. **Is it a whole-DB operation?** Then it invalidates peer cursors — say so.
