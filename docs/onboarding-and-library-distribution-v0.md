# Onboarding & Library Distribution — Design Spec v0.1

Status: DRAFT — design locked in conversation, not yet implemented.
Updated 2026-05-18: pre-implementation investigation complete; confirmed
facts folded into spec below. The one genuine Open Decision still
standing is the R2 upload mechanism (see section below).
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

The CRDT sync backend (38/38 green, smoke-tested at 5,669 mutations)
carries metadata only. A mutation is a small change-record — text, IDs,
timestamps. It does not carry audio.

Consequence: after a clean metadata sync, a second client's database is
a perfect copy of OV's and the library panel shows every song — but
every song points at a file path that exists on OV's drive and not on
the second client's. Nothing plays until the audio files are also
distributed. Metadata sync and audio distribution are two milestones.

---

## Milestone A — Metadata sync (close; covered by existing tests)

A second client builds an empty DB (v1–v16, already validated) and
pulls the full mutation history from the sync backend, replaying it.

Result: library panel fully populated, database identical to OV's.
Songs are visible. Songs are NOT yet playable.

This is the plain "second client" test and is the correct immediate
next step. It de-risks everything below it. A second client with a
fully correct but unplayable library is a valid, useful test result —
it proves the sync engine end to end.

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

1. **Plain second-client metadata test** (Milestone A). No login screen,
   no audio. Just prove a fresh client pulls and replays OV's mutation
   history. Confirms the sync engine works in the real world.
2. **Settle the Open Decision** — how files reach R2.
3. **Milestone B** — R2 upload, R2 keys on song records, download
   manager, the two gates.
4. **Onboarding flow** — the New / Connect choice, the single-credential
   login, wiring 1–5 of the onboarding flow together.

Onboarding (4) sits on top of A and B. Do not start it before the plain
second-client test (1) proves the sync-pull mechanism.

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
