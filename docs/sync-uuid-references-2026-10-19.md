---
feature: sync
title: References travel by UUID — the category-one-off fix, every other integer channel, and the one-time repair
summary: A song's category (and 11 other row references) synced as the sender's local integer; since Aug 13 the two machines number categories differently, so assignments land one off in both directions. Design, inventory with receipts, and the build plan.
audience: programmer
status: BUILDING on sync/uuid-refs (from b02a58b = the build on OVEVENTS)
---

# References travel by UUID (2026-10-19)

## Jeff's report and ruling (verbatim)

> "Correction: OV received all 102 songs; the schema-66 theory is wrong. Real cause (found on OV): a song's category
> syncs as the local integer category id, not the category's UUID. Since Aug 13 the two machines number categories
> differently ("Early tracks" created twice), so every category assignment for Kids, HV Adult, Movie & TV, Disney
> Halloween, Movie Soundtrack lands one off on the other machine, both directions."
>
> "Build the fix and the repair, so I don't re-file anything by hand:
> 1. Sync: every reference between rows (song→category and any other) travels by UUID and is looked up on arrival.
>    Find every other place that syncs a local integer id and fix it the same way.
> 2. One-time repair, runs on each machine at upgrade: for every song's category assignment, look up which machine
>    made it and resolve that machine's integer to the category UUID through that machine's numbering, then set the
>    right local category. Report every song it moved.
> 3. Test on the test stations with deliberately mismatched numbering in both directions, including edits made on
>    each side.
> 4. Installer for both machines."

## Why it happens (receipts, on b02a58b)

The mechanism exists: a table's `refs` map (column → referenced table) makes the sender attach the parent's UUID
(`ref_uuids`, `sync-engine.js _enrichWire`) and the receiver write its own local id for it (`merge-engine.js
_remapRefs`). The backend stores and relays `ref_uuids` on every mutation (`ether-backend src/routes/sync.js:129-152`).
Four things keep it from covering the case:

1. **`songs.category_id` is not declared** — songs (and artists/albums/library_asset/asset_sweeper_meta) became
   install-scoped in Phase 4 and have no `refs`.
2. **Both halves skip non-station tables**: `if (entry.scope !== 'station') return` in `_enrichWire` and `_remapRefs`.
3. **The sender only attaches uuids when the per-station flag `sync_uuid_identity` is on** (`if (!this._uuidIdentity)
   return wire`). OVEVENTS: on for stations 1, 2; off for 3, 4; default off.
4. **An unresolvable uuid keeps the sender's integer** ("left as-is and logged") — writes a wrong id rather than none.

### Every reference column that travels as a raw integer (registry audit, all synced tables)

| Table (scope) | Column → table | Status |
|---|---|---|
| songs (install) | category_id → categories, jingle_category_id → jingle_categories, artist_id → artists, album_id → albums | **raw** |
| albums (install) | artist_id → artists | **raw** |
| library_asset (install) | artist_id → artists, album_id → albums | **raw** |
| asset_sweeper_meta (install) | sweeper_category_id → jingle_categories (v50 migration filled it from songs.jingle_category_id) | **raw** |
| categories (station) | overlay_song_id → songs, overlay_category_id → categories | **raw** |
| published_episodes (station) | show_id → shows | **raw** |
| every other station-scoped declared ref (clock_slots.category_id, shows.clock_id, …) | | translated **only when the sender's flag is on** |

Not references, deliberately left: `play_log.deck_id` / `session_id` (physical values — the registry says never
remapped), `play_log.scheduled_log_id` / `programming_row_id` (always written NULL, `audiod/playlog.js:63`; the aired
row travels as `row_uuid`, v63). `generated_schedule` does not sync at all (ruling A). `monitor_routing` is local-only.
Every mutation's `row_id` is already a uuid (measured: 150,711 mutations on OVEVENTS, 0 integer row_ids).

### Other channels that carry local integers (agent inventory, receipts in the agent report)

| Channel | Integers | Status / plan |
|---|---|---|
| Dashboard → desktop `db:apply` / `library:addSong` (license-wide fan-out) | clock_slots.clock_id/category_id, shows.clock_id, station_programming.song_id/category_id, songs.category_id | Ints come from the mirror (whichever machine pushed last). **Desktop: accept `<ref>_uuid`, resolve locally; create honours a sent `uuid` and never duplicates an existing one. Dashboard: send uuids — prepared, deploy is Jeff's call.** |
| Dashboard create with no `uuid` (categories, clocks, clock_slots) | — | Every desktop creates its own row with its own uuid → duplicates that then sync. Plausible origin of "Early tracks created twice". Same fix as above. |
| Desktop → dashboard mirror `pushCcTable` / `pushLibrary` | raw ids | **Desktop: add `<ref>_uuid` beside each ref so the dashboard can send uuids back.** |
| `station_config_kv` values `jukebox_categories` (JSON array of category ids), `overlay_fallback_category_id` (jingle_categories id) | opaque ints inside a synced value | **Store uuids; readers accept both; repair rewrites old values.** |
| deck:load / queue:enqueue `resolveSong` (song_id first) | song_id | **Prefer song uuid / file_key when given.** |
| Staged programming import, backend clone endpoints, borrowed-library | uuid-mapped or owner ints | Dashboard writer dead (`staged={false}`); left, recorded. |
| Site replication (`electron/site-replication.js`) | raw ints, INSERT OR REPLACE | Pull side dormant (nothing calls it). Left, recorded — must not be switched on as it stands. |
| Member sync, cloud restore, catalogue download, now-playing, play history | — | OK (same engine / whole-DB / no row ids). |

## Design

1. **Every declared reference travels with its parent's uuid, always.** `_enrichWire` attaches `ref_uuids` for every
   synced table (install and station), whatever `sync_uuid_identity` says. The flag keeps its one other job — setting
   `station_uuid` (backend scoping) for station rows — unchanged, so backend delivery is untouched. Install rows never
   get a `station_uuid` (the backend would re-scope them).
2. **On arrival every declared reference is looked up by uuid**, for every table. If the uuid is not on this install
   (parent not arrived) the column is **not written** — an update keeps this install's value, an insert leaves it
   empty — never the sender's integer. Counted, logged, and reported to the health ledger.
3. **A mutation with no uuid for a reference** (a sender on an older build, or one already in flight) is translated
   through **the sender's published numbering** when it has one; otherwise today's behaviour (the integer) and a
   health count. `station_id` without a uuid keeps today's behaviour (station scoping is its own project — memory:
   peer-sync station identity).
4. **Each machine publishes its numbering**: `install_config_kv` key `id_numbering:<client_id>` = `{id → uuid}` for
   categories, jingle_categories, artists, albums, songs, shows, clocks (deleted rows included). Journalled with the
   sanctioned writer, install-scoped, so every machine on the account receives every other machine's map. Republished
   when it changes.
5. **The one-time repair** (per machine, at the first launch of this build): for each song and each reference
   (category — Jeff's ask — plus jingle category, artist, album, which carry the same defect): the latest mutation in
   the log that *set* that reference (an insert with a value, or an update whose before ≠ after) names the machine
   that made the assignment and its integer. Own machine → resolved through its own table. Another machine → through
   that machine's published numbering. The uuid → this machine's local id. If it differs from the current value, the
   song is re-filed (a local write — every machine repairs itself from the same history, nothing is re-broadcast).
   Same for the two KV values. A machine whose peer has not published yet stays **pending** and retries until it has.
   **Every move is reported**: a report file in the profile folder, one health-ledger line per run, an alert in the app.
6. **Dashboard channel**: desktop accepts uuids now (additive, safe with today's dashboard); the dashboard change is
   prepared and waits for Jeff's go to deploy.

## Tests

- Unit (sync suite, Electron): registry ⇄ audit; enrich attaches uuids for install + station tables with the flag off;
  remap resolves; unresolved leaves the column alone; legacy translated through published numbering.
- **Two-machine gate on test stations**: two blank databases with the real schema (structure only, from an installed
  DB opened read-only), the same test stations built on both with numbering deliberately offset **in both
  directions**, two real sync engines through an in-memory backend: create on each side, assign on each side, edit on
  each side, rename; every assignment lands on the same category uuid on both. Then pre-fix history (legacy sends)
  → wrong categories → the repair on each machine re-files exactly those songs and reports them.

Nothing touches the air machine: every test runs on blank databases in the scratchpad.

## Results (2026-10-19)

**Two-machine gate** (`npm run test:uuid-refs`, `scripts/test-uuid-refs-gate.js`) — **20/20 PASS**. Real schema
(structure only, from the installed DB opened read-only), two machines, stations + categories + artists numbered out of
step **both directions** (A: KIDS=2 HVADULT=3 MOVIETV=4 DISNEY=7 MOVIESDTK=5 · B: KIDS=4 HVADULT=5 MOVIETV=6 DISNEY=2
MOVIESDTK=7). Phase 1 reproduces the defect (A 3 wrong, B 6 wrong of 8). Phase 2: A alone fixes its own and waits on
B's 4; B resolves everything (10 moves); A completes (4 moves); every song right on both; every move reported;
idempotent; jukebox setting rewritten as uuids; an old-wire message from an upgraded machine read through its
numbering. Phase 3: edits on each side converge; a song whose category has not arrived is never filed under another.

**Other gates:** `tsc --noEmit` 0 errors · vitest 118 files / 1,027 tests · `test:sync` 55/55 · station-identity leak
guard holds at baseline 13.

**Preview on OVEVENTS' real data** (read-only online-backup snapshot to the scratchpad, `apply: false`): 625 songs
checked · **0 to move on OVEVENTS** (everything OVEVENTS assigned is right here) · **104 waiting** — all assigned on OV
(`041ceb96…`); they re-file the moment OV runs this build · 4 settings rewritten (jukebox_categories st1/st2,
overlay_fallback_category_id st2/st4) · 0 unplaceable · 0 without history.

### Finding, recorded not fixed — row-level last-writer-wins

Two edits to the **same song** inside one sync round (e.g. a re-file on A and a cue edit on B) are resolved by the
protocol's row-level LWW: the whole row travels, so the later edit wins even for the column it did not touch, on both
machines. Independent of numbering and pre-existing (sync-protocol-v0 §LWW). Seen in the gate when two such edits shared
a round; with a sync between them both survive. A field-level merge is its own design question — Jeff's call.

### Not built here (Jeff's call)

- **Dashboard sends uuids** (ether-dashboard: ClockEditor, ProgrammingPanel, LibraryPanel, CategoriesPanel creates).
  The desktop now accepts `<column>_uuid` / `category_uuid` / `song_uuid` / `programming_uuid` and a create `uuid`,
  and the mirror carries the uuids — the dashboard change is the remaining half; deploying it is outward-facing.
- Site replication (dormant) and the staged-programming import (dead writer) — left, recorded above.

## Addendum — artists, and "all metadata must sync" (2026-10-19, same day)

Jeff (verbatim): "This includes song→artist: today's new songs arrived on OV without artist names. Artists travel by
UUID, and missing artists are created on arrival. The repair also fixes every song's artist on both machines, and the
report lists every song whose artist it changed." · "all metadata must sync" · restated spec adds "Nothing on the air
machine."

**Missing parents (electron/sync/parent-rows.js).** The sender attaches a small label of each parent (`ref_uuids
"<column>@"` — older receivers read only registry columns and never see it). On arrival, a parent that is not here:
- **artists / albums → created with the SAME uuid** (never matched by name: "Kids Bop" and "Santana" each exist twice on
  OVEVENTS). The artist's own row, when it arrives, lands on the same row.
- **categories / jingle / spot categories / clocks / shows → the row with the same name in the same station**, only when
  exactly one matches. (Spot categories were seeded per station on each machine — "Sponsors" has a different uuid on
  each — so without this a spot from the other machine would arrive without its category.)
- otherwise nothing is written (never a wrong row).
The published numbering carries the same labels, so the **repair creates a missing artist** from the assigning
machine's label (or the row's own last mutation in the log), and **reports every song whose artist changed** — including
a song whose created artist took the very number it already held ("Lost Song: (none) → Lost Artist").

**All metadata (registry audit vs the real schema).** Columns that existed but were never listed — so never synced —
now sync: `songs.cart_id`, `clock_slots.song_id` (a slot pinned to a song — Generate plays it, generate-core.js:314;
travels as a song uuid) and `clock_slots.chain_type`. Recorded, deliberately NOT synced (machine state, not metadata):
`deck_configs.channel_on` (a board's ON/OFF must not switch the other machine's air), `stations.scheduler_mode`,
`stations.owner_license_key`, `announcement_schedule.skipped_at` (runtime), the `station_uuid` copies (each machine
derives its own), the legacy seconds cue columns (superseded by the `_ms` columns, which sync). Unsynced tables are all
machine-local or runtime (mutation log, FTS, crash recovery, GPIO/MIDI, studio sessions, jukebox requests). No schema
change — the columns already exist; only their registry entries were missing.

**Gate now 26/26**: adds — an artist whose row never reaches B (P1.4 reproduces "no artist name"; P2.4a the repair
creates it on B under the same uuid and the song shows its name; P2.4b the report lists every artist and category
change); a song arriving before its new artist (P3.6 created on arrival; P3.7 no duplicate when the row arrives);
P3.8 every song field arrives (genre, bpm, energy, cue, intro, cart number).
**Preview on OVEVENTS' data**: 0 to move here; 107 waiting on OV (categories + artists); 4 settings.

## Correction (2026-10-19, later)

`categories.overlay_category_id` was declared as a reference to **categories**; it is a sweeper **pool** (`jingle_categories`). Fixed in `electron/sync/synced-tables.js`, covered by the gate's SW.0–SW.3. Found while tracing the sweeper assignments report: docs/sweepers-assignments-2026-10-19.md.
