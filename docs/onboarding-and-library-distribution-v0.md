# Onboarding & Library Distribution — Design Spec v0.1

Status: DRAFT — design locked in conversation, not yet implemented.
Updated 2026-05-18: pre-implementation investigation complete AND
scratch-client sync test complete. Confirmed facts folded into spec
below. Two findings added: (1) plain second-client sync test PASSED —
sync engine proven correct end-to-end; (2) Layer 1 pre-sync data gap
CONFIRMED and quantified — mutation backfill is required before
Milestone A delivers a usable second client. The one genuine Open
Decision still standing is the R2 upload mechanism (see section below).
Sits after the plain second-client sync test on the roadmap.
Related: docs/sync-protocol-v0.md, docs/roadmap.md.

---

## Open decision (settle before implementation)

**How do a station's audio files get into R2 in the first place?**

Today OV's audio files live only on OV's local drive. Something has to
upload them to R2 before any second client can pull them. Two options,
and the answer shapes Milestone B:

- **One-time migration.** A script run once for OV (and once per future
  station at onboarding) that walks the library and uploads every file.
  Simpler; but leaves a gap — files imported *after* the migration are
  not in R2 until something else handles them.
- **Standing background uploader.** Ether uploads every imported audio
  file to R2 automatically, from import onward, as ongoing behavior.
  More work; but R2 is always current and there is no gap.

Recommendation: the standing uploader is the correct end state, because
without it every new import creates an un-syncable song. A one-time
migration may still be needed as a *backfill* for OV's existing library.
Likely answer: build both — backfill script + ongoing uploader.

This decision is NOT yet made. Everything below assumes files reach R2
somehow; the mechanism is TBD.

---

## The core distinction

"The library" is two separate things. Sync only handles one of them.

1. **Library metadata** — the database records: song titles, artists,
   durations, categories, format clocks, programming rows, separation
   rules. This is what mutations carry. This replays onto an empty DB.

2. **Audio files** — the multi-megabyte WAV/MP3 files the engine reads
   samples from to produce sound.

The CRDT sync backend (38/38 green, live-tested at 5,720 mutations)
carries metadata only. A mutation is a small change-record — text, IDs,
timestamps. It does not carry audio.

Consequence: after a clean metadata sync, a second client's database is
a perfect copy of OV's and the library panel shows every song — but
every song points at a file path that exists on OV's drive and not on
the second client's. Nothing plays until the audio files are also
distributed. Metadata sync and audio distribution are two milestones.

---

## Milestone A — Metadata sync

A second client builds an empty DB (v1–v16, already validated) and
pulls the full mutation history from the sync backend, replaying it.

Result: library panel fully populated, database identical to OV's.
Songs are visible. Songs are NOT yet playable.

**Status: sync engine proven correct (2026-05-18 scratch-client test).**
A fresh scratch client pulled 5,720 mutations across multiple rounds,
applied all 5,720 with zero errors (0 rejected, 0 conflicted, 0 held),
and songs converged to an exact match (417/417). The push cursor is
fully caught up (all mutations sync_status='synced'). The apparent
"station-scoped gap" during the test was a test artifact — the scratch
client used getStationId()=null, so the backend correctly withheld
station-scoped mutations. A real second-client with a valid station_id
receives all mutations. The sync engine itself is not a blocker.

**Remaining blocker for Milestone A: the Layer 1 pre-sync data gap.**
See the "Confirmed: Pre-sync Data Gap" section below. 3,999 rows
across 11 synced tables have no mutations. A second client that pulls
the full mutation history will receive a correct but incomplete library —
specifically, an empty rotation grid (station_programming: 355 rows,
100% invisible). The station cannot broadcast without format. Mutation
backfill is required before Milestone A is operationally complete.

Confirmed: the sync backend stores the mutation log in Railway Postgres
(BIGSERIAL `server_seq` column; clients use this as the pull cursor).
R2 is not in the metadata-sync path at all — R2's only role is future
Milestone B audio file distribution. The client talks to the Railway
HTTP endpoint for all metadata sync; it never touches R2 for metadata.

---

## Milestone B — Audio file distribution (not built; real work)

Makes a synced library actually playable.

Pieces required:

1. Audio files uploaded to R2 (object storage — a job R2 is well
   suited to). Mechanism per the Open Decision above.
2. Each song record carries an R2 object key, not just a local path.
3. A download manager on the client that pulls missing files from R2
   to local disk, with visible progress.
4. The file-present gate (see Gate Model below).

### Pull timing — bulk first, lazy as backstop

- **Bulk pull on first sync.** After metadata sync, walk the library,
  download every file not present locally, before the station is
  considered ready. One-time cost (potentially many GB), paid up front,
  visible, while the user expects to wait.
- **Lazy pull as a backstop only.** For anything that slips through —
  e.g. a song added at OV after the bulk pull. Never lazy *alone*.

Rationale: a broadcast engine must never race a download against the
clock. A song scheduled to air in 30 seconds that is not yet on disk is
dead air. Files must be confirmed on local disk before they are needed.

### Playback rule

The engine always reads from a local file. R2 is delivery, not
playback. The "engine runs locally, never streams from cloud"
architecture principle holds — files are cached down, never streamed
on demand.

---

## Gate model — two layers, do not conflate

### Layer 1 — Station-open gate (FRESH INSTALL ONLY)

On first-time setup of a new client, the station does not open into the
live broadcast UI until both:

- **Sync ✓** — metadata replay complete and caught up (Milestone A).
- **Files ✓** — every song confirmed present on local disk
  (Milestone B bulk pull finished).

This gate applies ONLY to a fresh install. Keyed off the existing
`isFreshInstall` signal (the sqlite_master check, commit 4637727).

**Critical:** an already-established station (existing DB with content)
must open immediately on its existing local data. Sync/file status
shows as live indicators, NOT as a gate. If the station-open gate
applied to an established station, a slow sync or network blip on
startup would hold a working broadcaster off the air over a check that
was always going to pass. That must not happen.

  - Fresh install  → blocking setup screen, two checks, then open.
  - Established     → open immediately; sync/files are status lights
                      (connected / syncing / offline; complete / N
                      downloading).

### Layer 2 — Per-song air-eligibility gate (ALWAYS ON, EVERY STATION)

A song is never eligible to air until its audio file is confirmed on
local disk. "Metadata exists" and "file present" are two separate
gates. A song that is synced but not downloaded shows as not-ready in
the UI (greyed / cloud icon) and the engine refuses to load it.

This gate never switches off. It is what catches a file that goes
missing, or a song added after the bulk pull. A missing file is always
a visible UI state, never a silent failure at air time.

Summary: the station-level gate is passed once, at first setup. The
song-level gate runs forever, on every station.

---

## Onboarding flow (the user-facing feature)

A fresh install presents two choices:

- **New station** — start empty, this client is the origin.
- **Connect to existing station** — join an existing station's library.

The "Connect to existing station" path:

1. User enters ONE credential — their station login (email + password,
   or a license key). Nothing more.
2. Client authenticates to the sync backend, identifies which station's
   mutation history it belongs to.
3. Metadata sync (Milestone A) — pull and replay the full history.
4. Bulk audio pull (Milestone B) — download all files from R2.
5. Both green → station opens.

### What the user must NOT see

R2, Railway, and Lightsail credentials are infrastructure — the
developer's accounts and secrets. The user never enters them. The
backend already knows its own R2/Railway/Lightsail credentials (baked
into the build or held server-side). The user enters one station
credential; all infrastructure plumbing stays invisible. If customers
typed in R2 keys, every customer would have access to the storage
account.

### Identity note

`client_id` (per-device, e.g. f0df7a2b-… on OV) and library identity
are different things. Each PC must have its own unique `client_id` —
confirmed: migration 3 generates it locally via `crypto.randomUUID()`
with no server contact. Never copy OV's `client_id` to a second PC.

Confirmed: there is no separate account/library/tenant/organization ID
concept in the current system. The **license key is the library
boundary**. The backend filters the mutation log by `license_key_id`
(the integer PK of the resolved license row): same license key = shared
mutation pool = shared library; different license keys = completely
isolated. Building any org/tenant layer beyond this is part of this
onboarding milestone, not something already built.

---

## Build order

1. ~~**Plain second-client metadata test** (Milestone A sync engine proof)~~
   DONE 2026-05-18. Sync engine proven correct.
2. **Mutation backfill** — walk the 11 affected tables, generate insert
   mutations for all pre-sync rows, push to backend. Without this, a
   second client receives an empty rotation grid and cannot broadcast.
   This is a prerequisite for Milestone A being operationally usable,
   not a nice-to-have. Design proposal in spec below.
3. **Settle the Open Decision** — how files reach R2.
4. **Milestone B** — R2 upload, R2 keys on song records, download
   manager, the two gates.
5. **Onboarding flow** — the New / Connect choice, the single-credential
   login, wiring 1–5 of the onboarding flow together.

Onboarding (5) sits on top of A and B. The mutation backfill (2) is
a prerequisite of A being useful, not a separate milestone.

---

## Investigation — completed 2026-05-18

All pre-implementation questions answered against the live system.
Findings folded into spec above. Summary for reference:

- `client_identity`: singleton table (CHECK id=1), columns: id, client_id, created_at, label. One row per install.
- No account/library/tenant/org concept anywhere — license key is the library boundary (see Identity note above).
- Push: `POST {baseUrl}/sync/mutations` with `x-license-key` header, body `{client_id, station_id, batch[]}`. Pull: `GET /sync/mutations?client_id=…&since_seq=…[&station_id=…]` with same header.
- Backend filters by `license_key_id` — same license = shared pool, different license = isolated.
- Sync base URL: read from `station_config_kv['sync_backend_url']`, falling back to `process.env.ETHER_SYNC_URL`. Not hardcoded.
- `client_id`: confirmed locally generated via `crypto.randomUUID()` at migration 3, no server contact.
- Mutation storage: Railway Postgres, `BIGSERIAL server_seq`. R2 not involved in metadata sync.

---

## Confirmed: Pre-sync Data Gap (Layer 1)

Established 2026-05-18 via live DB investigation against OV's production
database. This supersedes the earlier "backfill may be needed" note —
it is now proven necessary and fully quantified.

### What was measured

Mutations are generated exclusively by `withMutation()` / `logMutation()`
calls in per-table handler files (`electron/sync/handlers/`). No SQLite
triggers exist. Rows written before those handlers were installed in
each code path have no mutations and will never have them unless
explicitly backfilled. The sync engine has no way to discover these rows.

### Table-by-table breakdown (OV production DB, 2026-05-18)

| Table | Scope | Rows | Mutations | Invisible | % |
|---|---|---|---|---|---|
| station_programming | station | 355 | 0 | **355** | **100%** |
| play_log | station | 3,782 | 591 | 3,191 | 84% |
| artists | install | 310 | 28 | 282 | 91% |
| metadata_definitions | station | 99 | 7 | 92 | 93% |
| metadata_vocabulary | station | 87 | 44 | 43 | 49% |
| categories | station | 15 | 1 | 14 | 93% |
| clocks | station | 13 | 4 | 9 | 69% |
| separation_rules | station | 5 | 0 | 5 | 100% |
| install_config_kv | install | 5 | 0 | 5 | 100% |
| operators | station | 2 | 0 | 2 | 100% |
| albums | install | 1 | 0 | 1 | 100% |
| **TOTAL** | | 6,263 | 5,720 | **3,999** | **64%** |

Tables with zero invisible rows (all post-sync, fully covered):
songs (417/417), stations (2/2), clock_slots (191 rows, 294 mutations),
deck_configs (6 rows, 588 mutations), station_config_kv (62 rows, 1,032
mutations), scheduled_log (864 rows, 992 mutations), shows, song_metadata_values.
Mutations > rows on several tables reflects updates (multiple mutations per
row) and soft-deleted rows still present as tombstones.

### Operational severity

`station_programming` is the most severe: 355 rows, 100% invisible.
This table is the rotation grid — it maps songs to stations and holds
per-song rotation state (category, energy, last_played_at, play_count,
etc.). Without it, a synced client has a full song library in the `songs`
table but no format. The scheduler has nothing to schedule. The station
cannot broadcast.

`play_log` invisibility (3,191 rows) does not block broadcasting but
breaks historical reporting (ASCAP logs, play history). `metadata_definitions`
and `metadata_vocabulary` invisibility means most of OV's custom
metadata schema is absent on a fresh client.

### No existing backfill mechanism

The three existing `scripts/backfill-*.js` scripts (backfill-uuids,
backfill-duration, backfill-vocab-fks) write directly to tables without
calling `logMutation()` — they are schema-repair tools, not sync-aware.
No code path currently generates mutations for pre-existing rows.
`docs/onboarding-and-library-distribution-v0.md` previously listed
"backfill may be needed" as an open question. It is now a confirmed,
quantified requirement.

---

## Mutation-Backfill — Design Proposal

Design only. Not yet implemented.

### Goal

Walk every pre-sync row in the 11 affected tables and generate a valid
`insert` mutation for each row that has none. The generated mutations
must go through the real `logMutation()` path — not direct INSERT into
the mutations table — so they carry correct HLC timestamps, client_id,
schema_version, and sync_status='pending', and will be picked up by the
normal push cycle.

### Scope of use

This is a **reusable onboarding step**, not a one-off for OV.
The problem recurs for any station that was running Ether before sync
was enabled (i.e., any station that imported its library before the
`withMutation()` handlers were installed in each code path). That
includes OV today and any other station onboarded in the pre-sync era.
The script should accept a DB path argument and work against any
station's DB. It should not hardcode OV paths.

### How it avoids double-generating mutations for already-covered rows

The check is simple: for each row, query `SELECT COUNT(*) FROM mutations
WHERE table_name = ? AND (payload_after->>'id' = ? OR ...)`. If any
mutation already exists for that row's primary key, skip it. In practice
the join is: for each table, find row PKs that have NO entry in mutations
with matching table_name. This is a `NOT EXISTS` or `LEFT JOIN ... WHERE
mutations.id IS NULL` query. Run it per-table, iterate only the gap
rows, generate exactly one `insert` mutation per gap row.

Alternatively, the check can use the existing UUID: each row has a `uuid`
column (backfilled by `backfill-uuids.js`). The mutations table stores
the mutation payload including the uuid field. A faster check: find rows
whose `uuid` does not appear in any mutation's payload_after. But a
per-table PK check against `mutations.table_name + payload_after->>'id'`
is more reliable and does not require JSON extraction on the full mutation
payload.

### Relationship to the push cycle

After the backfill script runs, the newly generated mutations have
`sync_status = 'pending'`. The normal `SyncScheduler` (5-second tick,
`syncCycle()` → `push()` then `pull()`) picks them up in the next
cycle and pushes them in batches of 500 (`MAX_PUSH_BATCH`). For OV's
3,999 gap rows, that is 8 batches — roughly 40 seconds of normal sync
cycles. No special trigger or manual push is needed. The script does not
need to run before a specific window; it can run while OV is live and
the scheduler is running.

### Ordering and FK dependencies

`logMutation()` generates one mutation per row. The causal order queue
(`CausalOrderQueue`) handles FK dependencies during replay on the
receiving client — the receiver's merge engine will hold a row whose
FK target hasn't arrived yet and release it once the parent arrives.
The backfill script does not need to emit mutations in FK order (e.g.,
artists before songs before station_programming). The standard causal
queue on the receiving side handles it.

One exception: `station_programming` rows reference `song_id`,
`category_id`, and `station_id`. If categories and artists are also
being backfilled, the receiving client may temporarily hold
station_programming rows until the FK targets arrive. This resolves
automatically as the pull progresses. Not a bug; the causal queue is
exactly the mechanism built for this.

### The `play_log` question

`play_log` has 3,191 invisible rows (historical playout records).
Backfilling play_log is optional — it does not affect broadcasting
ability, only historical reporting. The decision to include or exclude
it is a product call. Including it adds 3,191 mutations to the push
batch but has no other side effects. A flag or config option in the
script (`--skip-play-log`) lets the operator decide. Recommendation:
include it by default; exclude it only if the push volume is a concern.

### What the script does NOT do

- It does not write directly to the mutations table. All writes go
  through `logMutation()`.
- It does not call `push()` — the normal scheduler handles that.
- It does not modify any application table row. It is purely additive
  to the mutations table.
- It does not run migrations or alter schema.
- It does not touch audio files. This is metadata only.

### Suggested implementation shape

```
scripts/backfill-sync-mutations.js
  --db <path>          default: APPDATA/com.ether.radio/openair.db
  --dry-run            print what would be generated; write nothing
  --skip-play-log      exclude play_log from backfill
  --tables a,b,c       restrict to specific tables (default: all 11)

Run via:  npx electron --no-sandbox scripts/backfill-sync-mutations.js
```

The script must require the real Electron runtime (not bare Node) because
`logMutation()` depends on `better-sqlite3` compiled for Electron's Node
ABI, and the HLC clock state (`hlc_last` in `system_state`) must be read
and updated correctly in the running DB's context.

Output: per-table counts of rows found, rows skipped (already have
mutations), mutations generated, errors. Ends with a summary line and
the next step reminder ("sync_status=pending — scheduler will push in
the next cycle").

### Decision required before implementation

Is `play_log` backfill in or out by default? Everything else can proceed
without a decision — the 10 non-play_log tables are unambiguously needed.
