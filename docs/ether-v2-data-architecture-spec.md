# Ether v2 Data Architecture Spec

## CORE ARCHITECTURAL VISION

**Stations are fully cloud-defined entities; machines and surfaces SUBSCRIBE to them. Playout responsibility is a CLAIM, not a binding.** Any authenticated surface can attach to a station: a desktop as playout engine, a phone as monitor, Iris as watchman, a future cloud renderer as playout with no desktop at all. This is why Iris is a client, why the dashboard and listener are independent surfaces, and why studio handoff exists. Never model stations as belonging to machines. Radio-as-cloud-service with attachable surfaces is the product.

**HARD REQUIREMENT — Playout is fully local: local DB, local content store, local engine.** Pulling the network mid-broadcast must NEVER interrupt audio. The cloud defines and coordinates; it is never in the playback path. Playout claims degrade safely offline: a surface holding a claim keeps operating without connectivity; claims can only be transferred through the server, and a transfer can never silently yank playout from an unreachable machine — that requires human confirmation (the dead-air-disclosure rule the handoff console already implements).

---

**Status:** In build — week 1 (schemas + endpoints) code-complete and proven on scratch; see `docs/v2-progress.md`.
**Clean slate (decided 2026-07-02):** All old data is abandoned — the old backend (every license, mutation, station, and station-scoped history) and all local DBs. The go-live target is a BRAND-NEW account created through the normal signup flow. Week 2 imports the library into it; week 3 is the full new-customer path signup→on-air with stations/clocks/programming authored fresh. Nothing is migrated or reseeded. This removes the reseed/truncate, `library_grants` scoping, and tombstone-cleanup work entirely.
**Scope:** Library identity, cloud truth, delete semantics, file storage, client bootstrap, and the fresh-account import. Everything above the data layer (Rust engine, daemon, decks, clocks, spots, operator console, UI) is explicitly out of scope and unchanged.
**Timebox:** 4 weeks, pre-launch. If work drifts into redesigning clocks, the daemon protocol, or UI systems, it is out of scope — stop and re-check this spec.
**Workflow:** Claude Code executes; Jeff approves each step with explicit go/no-go. Read-only diagnosis before every destructive step. All scripts are `.js` files run with node, never inline `-e`. Migrations verified on a DB copy first, never the live file.

---

## 1. The four foundation decisions

These are reversals of current design decisions, not patches. Every schema, endpoint, and flow below derives from them.

**D1 — Identity is the content hash.** A song's identity is the SHA-256 of its file bytes (`content_hash`, lowercase hex, 64 chars). It is the primary key locally, the R2 object key, and the reference used by programming, schedules, queues, and playback. `file_path` becomes display metadata only and is never used as identity. Consequence: duplicates are structurally impossible; renames and moves are no-ops; the same file imported from any folder under any name resolves to one row.

**D2 — Truth is the materialized snapshot on the backend.** The backend holds current library state per license (`library_songs` etc., actual rows). Clients bootstrap by downloading the snapshot, then tail the change stream for live updates. No client ever replays the mutation log from seq 0. The mutation log becomes transport, compacted aggressively.

**D3 — Delete means removed from the snapshot.** A delete removes the row from backend state and emits a tombstone that exists only long enough for online clients to hear about it; compaction removes it once every registered machine's cursor has passed. No immortal tombstones, no LWW resurrection. Factory reset = wipe local + pull snapshot, correct by construction.

**D4 — Files are hash-addressed.** Local content store keeps files as `<content_hash>.<ext>`. R2 objects are keyed by `<content_hash>.<ext>`. Playback and the cue editor resolve by hash: local store first, R2 on miss, cache into the store. Import assigns the hash at import time — a song is fully identified and playable-locally the moment it is imported, with no dependency on an upload step.

---

## 2. Schemas

### 2.1 Client (SQLite) — new library tables

```sql
-- One row per unique piece of audio content. install-scoped (shared across stations).
CREATE TABLE songs_v2 (
  content_hash   TEXT PRIMARY KEY,          -- sha256 hex of file bytes
  title          TEXT NOT NULL,
  artist         TEXT,
  album          TEXT,
  duration_ms    INTEGER,
  ext            TEXT NOT NULL,             -- 'mp3', 'wav', ...
  size_bytes     INTEGER NOT NULL,
  source_folder  TEXT,                      -- display metadata: 'Daytime', 'Halloween', 'Christmas', 'CS - Coffee Shop'
  original_name  TEXT,                      -- display metadata: filename at import time
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Where the bytes currently are on THIS machine. Never synced. Rebuilt by scanning the content store.
CREATE TABLE local_files (
  content_hash   TEXT PRIMARY KEY REFERENCES songs_v2(content_hash),
  local_path     TEXT NOT NULL,             -- <content-store>/<hash>.<ext>
  verified_at    TEXT NOT NULL              -- last time existence+size was confirmed
);
```

Rules:
- `songs_v2` is synced (snapshot + tail). `local_files` is machine-local, never synced — it is the answer to "is this song's file on this box right now."
- Station-scoped tables that referenced `songs.id` (station_programming, generated_schedule, queues, play_log, pinned_songs, etc.) get a `content_hash TEXT` column and are migrated to reference it. Integer `song_id` columns are retired after cutover.
- The old `songs` table is not cleaned. After cutover it is dead weight and is dropped in week 4.

### 2.2 Backend (Postgres) — materialized state

```sql
-- Current library state per license. THIS is the source of truth.
CREATE TABLE library_songs (
  license_key_id INT NOT NULL REFERENCES licenses(id),
  content_hash   TEXT NOT NULL,
  title          TEXT NOT NULL,
  artist         TEXT,
  album          TEXT,
  duration_ms    INTEGER,
  ext            TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL,
  source_folder  TEXT,
  original_name  TEXT,
  updated_at       TIMESTAMPTZ NOT NULL,
  updated_hlc      TEXT NOT NULL,           -- tie-break ordering within a version
  snapshot_version BIGINT NOT NULL,         -- version at which this row was last written; /library/changes filters snapshot_version > N (matches library_tombstones)
  PRIMARY KEY (license_key_id, content_hash)
);

-- Snapshot versioning: bumped on every write to library_songs for a license.
CREATE TABLE library_snapshot_version (
  license_key_id INT PRIMARY KEY REFERENCES licenses(id),
  version        BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL
);

-- Short-lived deletion notices for online clients. GC'd by compaction (§5).
CREATE TABLE library_tombstones (
  license_key_id INT NOT NULL REFERENCES licenses(id),
  content_hash   TEXT NOT NULL,
  deleted_at     TIMESTAMPTZ NOT NULL,
  snapshot_version BIGINT NOT NULL,         -- version at which the delete happened
  PRIMARY KEY (license_key_id, content_hash)
);
```

The existing `mutations` table, sync engine transport, HLC clocks, and `license_key_id` scoping are retained for the **change stream** (station-scoped tables and live library deltas). What changes: fresh clients never pull from seq 0; library truth lives in `library_songs`, not in log replay.

---

## 3. Endpoint contracts (ether-backend)

### 3.1 `GET /library/snapshot`
Auth: license token (same middleware as /sync). Query: none (license from auth).
Returns:
```json
{
  "version": 41,
  "songs": [ { "content_hash": "...", "title": "...", "artist": "...", "album": "...", "duration_ms": 213000, "ext": "mp3", "size_bytes": 5123456, "source_folder": "Daytime", "original_name": "Love On Top.mp3" }, ... ],
  "generated_at": "2026-07-08T00:00:00Z"
}
```
Semantics: full current state for the license. ~400 rows, one response (paginate at 5,000+ if ever needed). Honors `library_grants`: if the license reads another license's library, the snapshot is the grantor's state (same grant logic as the current pull's UNION).

### 3.2 `GET /library/changes?since_version=N`
Returns upserts from `library_songs` and deletes from `library_tombstones` with `snapshot_version > N`, plus the current `version`. If `N` is older than the oldest retained tombstone (client was offline past the GC horizon), return `410 Gone` — the client must re-bootstrap from `/library/snapshot`. This makes long-offline correctness explicit instead of accidental.

### 3.3 `POST /library/songs` (upsert) and `DELETE /library/songs/:content_hash`
Both scoped by license. Upsert writes `library_songs`, bumps `library_snapshot_version`. Delete removes the row, inserts a tombstone, bumps version. These are called by the client's library operations (import, edit metadata, delete) — the client is no longer pushing raw song mutations into the log for library state.

### 3.4 Reseed = publish a snapshot
There is no special reseed operation in v2. "Reseed" is: truncate `library_songs` + `library_tombstones` for a license, bulk-insert the new state, bump version. The genesis migration (§7) is exactly this, and it remains available forever as an admin script.

---

## 4. Client bootstrap and sync flow

**Fresh install / factory reset:**
1. Wipe local DB (existing reset already does this).
2. Sign in → `GET /library/snapshot` → insert all rows into `songs_v2`, store `snapshot_version`.
3. Scan the local content store, populate `local_files` for hashes present.
4. Tail: poll `GET /library/changes?since_version=` on the existing sync cadence.
5. Station-scoped data continues over the existing mutation stream unchanged.

**Steady state:** library edits call the REST endpoints (§3.3) and apply locally on success. Change-stream deltas from other machines apply as plain upsert/delete by `content_hash` — no LWW gymnastics needed for the library because the backend row is authoritative and versioned.

**Factory reset button:** re-pointed to exactly the fresh-install flow. This is the guarantee the old system could not make: reset always converges to backend state, and backend state contains no ghosts by construction.

---

## 5. Compaction and GC (backend job)

Nightly (or on-demand) per license:
1. Delete `library_tombstones` rows whose `snapshot_version` is older than the minimum `since_version` seen from that license's registered machines in the last 30 days (track last-seen version per client_id; the machines table / client registry already exists in spirit via `client_id` on mutations — add `last_snapshot_version` to it).
2. Existing `pruneSupersededMutations` continues to run for the mutation log (station-scoped data), now allowed to be aggressive since the library no longer depends on log replay.
3. A machine offline past the horizon gets `410` from `/library/changes` and re-bootstraps. Correct, explicit, cheap (~400 rows).

---

## 6. File store and resolution

**Local content store:** `<musicDir>/store/<content_hash>.<ext>`. The importer copies (not moves) originals into the store; the four source folders are never modified. `music-dir.txt` behavior unchanged.

**R2:** objects keyed `<content_hash>.<ext>`. Upload job iterates `songs_v2` where the hash is missing from R2 (HEAD check or a synced `r2_present` flag), uploads from the local store. Basename-as-key and `r2_uploaded_at`-on-old-schema are retired.

**Resolution (one shared function, replacing `resolveLocalAudioPath`):**
```
resolveByHash(content_hash) →
  1. local_files hit + file exists → local path
  2. R2 GET <hash>.<ext> → write to store, insert local_files, return path
  3. miss → { ok:false, reason:'not local, not in R2' }
```
Playback, cue editor, and waveform/mipmap all call this. The Library UI's presence indicator (§8) is `local_files` existence + optional `r2_present` — three honest states: local, cloud-only, unreachable.

---

## 7. Fresh account + library import (week 2)

**Full clean slate.** The old backend (all licenses, mutations, stations, and station-scoped history) and all local DBs are abandoned — nothing from them carries forward. Week 2 stands up a brand-new go-live account through the **normal signup flow** and imports the library into it. Because the account is new, there is no per-license reseed, no truncate-of-old-state, and no `library_grants` scoping to reason about — the target license starts with an empty log and an empty snapshot. (The step-zero OV/19 license/grant map is now historical only; it described the old data we are walking away from.)

Source of truth for audio: the four folders under `C:\Users\jensj\Music\ether music library` — `Daytime` (215), `Halloween` (58), `Christmas` (36), `CS - Coffee Shop` (43), plus anything added since. Loose root files are ignored entirely.

1. **Fresh signup:** create the go-live account via the normal signup flow (signup.ether-technologies.com / in-app trial activation), yielding a new license with no prior data.
2. **Importer run (OVEVENTS dev):** recursively scan ONLY the four folders. For each audio file: SHA-256, extract metadata (title/artist/album/duration via existing tagging path), copy into the content store, upsert `songs_v2` keyed by hash. Identical bytes in two folders → one row (`source_folder` keeps the first). Report: files scanned, unique hashes, duplicate groups collapsed, any unreadable files.
3. **Review gate (Jeff):** eyeball the deduped list — count should land near the real library size. Explicit go/no-go.
4. **Publish snapshot:** populate the fresh license's `library_songs` from the importer output via `POST /library/songs` (or the admin bulk-insert path), version rising from 0. No truncate needed — the account is empty.
5. **R2 upload by hash:** upload all store files to R2 keyed by `<content_hash>.<ext>` under the new license's prefix.
6. **Verify on dev:** wipe dev's local DB, bootstrap from the snapshot, confirm exactly one row per real song, all resolvable.

Nothing from the old backend is migrated. The old mutation log, old stations, and old library are simply left behind (see §10 for whether they're deleted or left dormant).

## 7.1 New-customer experience (week 3)

Week 3 is the full path a brand-new customer walks, end to end, with zero legacy data — signup to on-air:

1. **OVEVENTS:** wipe app data, fresh install, sign in to the new account, bootstrap library from the snapshot, verify library + playback + cue.
2. **jensj:** wipe app data, fresh install, sign in to the new account, bootstrap. All prior local-only data on jensj is intentionally discarded (Jeff's call, already made).
3. **Author programming FRESH:** create stations, clocks, spots, and programming from scratch against `content_hash` references. Nothing is migrated or regenerated from old data — it is authored new. Station creation seeds the 5 default `separation_rules` in one transaction (§8), so the never-seeded-rules gap can't recur.

Because every station/clock/programming row is created clean, the old bug classes — schedule rows referencing tombstoned songs, never-seeded `separation_rules`, ghost/duplicate library — cannot appear: there is no legacy state to carry them.

---

## 8. Week 4 — hardening and the items this unlocks

- **Station creation seeds config universally:** creating a station inserts the 5 default `separation_rules` rows (30/30/30 STRICT, gender 3 SOFT, category 1000 SOFT) and any other required per-station config, in one transaction. This closes the root cause of the HalloVeen/Magical Forest gap.
- **Library UI:** File Location column (from `local_files.local_path` / `source_folder`), sortable/filterable, with the three-state presence indicator (local / cloud-only / unreachable). Trivial now because presence is a table lookup, not an existsSync guess.
- **Silent-playback guard:** the generator and deck-load refuse `content_hash` values that fail `resolveByHash`, and surface them in the operator console instead of playing silence. (The old silent-VU bug class — rows with no key and dead paths — cannot exist in v2, but unreachable-content should still be loud, not silent.)
- **Old-schema removal:** drop `songs` (old), `file_key`/`file_path`-as-identity code paths, basename R2 objects.
- Buffer for whatever week 1–3 surfaced.

---

## 9. What is explicitly kept

- Rust NAPI audio engine, ether-audiod daemon model, deck/transport code.
- Electron + React app, all UI systems, clocks/spots/traffic (v4.4.29–30 work), operator console.
- The sync engine's transport, HLC, per-license scoping, and mutation stream — for station-scoped tables and library deltas. Only its role as *library truth via replay* is removed.
- Railway Postgres backend, auth/licensing, R2.

## 10. Risks and honest unknowns (clean-slate)

- **~~library_grants scoping~~ — NO LONGER APPLICABLE.** The target is a fresh signup account with no grants; the old OV/DJ grant entanglement is abandoned with the old data. The step-zero license map is retained only as history.
- **Old-data disposal — DECIDED (2026-07-02): leave dormant.** The old backend rows (licenses 2/19/20/21 + their mutations/stations) are license-scoped and don't interfere with the fresh account; they stay in place (deletable later via the platform delete-account route). No prod wipe.
- **Metadata quality:** unchanged — hashing dedups perfectly, but title/artist tags on the survivor come from the file. The §7 review gate is where bad tags get caught.
- **Same song, different encodings:** unchanged — two rips/bitrates are different hashes and both survive (correct; expect a few at the review gate).
- **Programming authored fresh (was: schedule regeneration):** week 3 creates all programming/schedules new against `content_hash`. Acceptable pre-launch (test mode); nothing is regenerated from old data. Post-launch this clean-slate style would not be available — exactly why it happens now.
