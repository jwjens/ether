# Phase 4 — Library Architecture (Design Locked)

**Status:** DESIGN LOCKED — implementation pending schema-specifics session
**Locked:** April 26, 2026
**Predecessor:** Stub locked April 25, 2026 (preserved in section "Original commitments stub" below)
**Successor:** Phase 4 schema-specifics session (next), then Phase 4 implementation, then Phase 3.5 resumption

---

## Context

The April 25 stub committed to Direction C: shared install-scoped library, station-scoped programming layer, explicit join between them. The stub deliberately did not specify the join's shape, the assignment model, the tribute-scenario handling, or the UX. Those were Phase 4 design concerns and are settled here.

This doc supersedes the stub as the locked Phase 4 design. The stub's six original commitments are preserved verbatim in the final section for traceability; everything in between is the design that grew on top of them.

---

## Locked architectural commitments

### 1. The programming row is a first-class entity, not a thin join

The relationship between a song and a station's programming context is **the programming entity itself**, not a link table connecting two other entities. The song is reference data — file facts and canonical recording metadata. The programming row carries every per-station-per-song-per-category programming judgment.

This is the cluster-operator mental model: *"On WROK this song plays middays in Power Gold; on WPOP it's a recurrent."* Each of those is a programming row. The song is shared reference data; the row is what the rotation engine queries against.

Provisional name: `station_programming`. Final name is a schema-specifics concern.

#### Why the programming-entity framing wins over thin-join + sibling tables

A thin-join shape (`song_id, station_id, category_id` only) requires sibling tables for daypart masks, energy overrides, pin status, last-played-on-this-station, etc. — each keyed on the same triple. Five or six sibling tables describing different facets of one programming context. The programming-entity framing collapses those into one row per programming context.

Three concrete benefits:

- **Sync granularity.** Editing a song's daypart mask on WROK Power Gold is one mutation against one row, not three mutations across three tables. The mutations log gets dramatically cleaner; wire format stays small.
- **Rotation engine query cost.** The selector fires every 2–4 minutes per running deck per station. With the programming-entity framing, a selection cycle is one indexed lookup against `station_programming WHERE station_id=? AND category_id=? AND active=1`, then JOIN to `songs` for canonical metadata. The thin-join shape requires a 5–6 table JOIN every cycle.
- **Control Center "copy programming."** A locked roadmap item (item #5) is multi-tenant Control Center. The most-requested cluster-operator feature in any Control Center is "copy WROK's Power Gold programming to WROK-HD2." With programming-entity framing this is `INSERT INTO station_programming SELECT ... WHERE station_id='WROK' AND category_id='power_gold'` with the destination station_id swapped. With thin-join + siblings, it's a coordinated multi-table copy with referential-integrity headaches.

### 2. The "no canonical programming judgment" principle

There is no canonical energy, mood, category, daypart, rotation status, or any other programming attribute on a song. Those don't exist at install scope. They are programming judgments and they live exclusively on the programming row.

This is stronger than "songs have defaults that stations override." There is no default to override. Each station decides what the song is in its programming context, full stop. Prince's "1999" is a Power Gold on the oldies station, an old-school throwback on the hip-hop station, and absent entirely on the country station. None of those is more canonical than the others.

The principle prevents an entire class of future schema drift: every time someone proposes "let's just put a default energy on songs and stations can override," the answer is reflexively no, because no such default exists. The song is a recording. Energy is a programming judgment about the recording in a context.

#### The split

**`songs` (install-scoped, canonical reference data):**

- Identifying metadata: `title`, `artist`, `album`, `year`, `genre`, `ISRC`, `MusicBrainz ID`, `Discogs ID`, `spotify_uri`, `raw_metadata`
- File facts: `duration_ms`, `bpm` (measured from audio), `is_explicit` (does the recording contain explicit content), `file_path`, `intro_version_path`
- Audio analysis: `lufs_measured`, `peak_db`, `gain_db`, `cue_in_ms`, `cue_out_ms`, `intro_end_ms`, `outro_start_ms`, `has_intro`

These are facts about the recording and the file. They are the same regardless of which station is using the song. Fixing an artist name, recomputing LUFS, or correcting an ISRC happens once at install scope and every station benefits.

**`station_programming` (station-scoped, programming entity — provisional name):**

- Foreign keys: `song_id`, `station_id`, `category_id`
- Programming judgments: `energy`, `mood`, `daypart_mask`, `rotation_status` (active/inactive on this station), `no_repeat_hours`
- Programming history: `last_played_at` (on this station), `play_count` (on this station)
- Editorial controls: `pinned_at`, plus any other rotation/programming behavior

Every field on the programming row is *this station's call*. No field is inherited from the song.

#### Consequence: license compliance scope is clean

Per-station license reports (SoundExchange, ASCAP, BMI) join each station's `play_log` to `songs` for ISRC and recording metadata. License reporting needs file facts, not programming judgments. The split places everything license-relevant on the install-scoped side, where fixing an ISRC once retroactively corrects every station's reports going forward. The original stub's open question about per-station vs. install-scoped license compliance is resolved by the column split itself — no separate decision needed.

### 3. Explicit assignment — the warehouse model

Newly ingested songs land in the install-level library and are invisible to every station's rotation engine until that station's programmer creates a `station_programming` row. The library is the warehouse; stations curate from it.

There is no auto-discovery, no tag-based propagation, no "default category" applied at ingestion. A song with no programming row exists in the install pool and nowhere else. A new station starts empty: zero programming rows, nothing in any rotation, until its programmer explicitly adds songs.

#### Why not auto-generate empty rows on station creation

This was considered and rejected. Auto-generating one programming row per song at station creation (with all programming fields null) is superficially appealing — it gives every song-station pair a row, so queries are uniform. It loses on four counts:

1. **It's auto-discovery in disguise.** Every song appears on the new station from day one, even with empty programming fields. The hip-hop programmer opens their library and sees 7,000 country songs with empty checkboxes. That's the failure mode the warehouse model exists to prevent.
2. **It scales wrong.** With a 12-station cluster and 50,000 songs, the table holds 600,000 rows of which maybe 150,000 are real programming. The other 75% is empty placeholder rows. Not a performance problem — a *meaning* problem. The table no longer answers "what's programmed where" without a convention layered on top.
3. **It breaks mutations log semantics.** Station creation produces a flood of "empty row created" mutations, none of which are programming decisions. The mutations log fills with noise; the first sync to a new peer ships thousands of empty-row mutations before any real data flows.
4. **It conflates "exists" with "is programmed."** The warehouse model says: *the existence of a programming row means the song is programmed on the station in that category.* Empty rows force the meaning of "programmed" into a query filter (`WHERE category_id IS NOT NULL`) instead of into the table itself. Every developer, every report, every UI surface has to remember the convention. Forget once and the data lies.

The warehouse model says it more cleanly: **no row, no programming.** The presence of a row is the assertion.

### 4. UX commitment — unified search, scope-sectioned results

The warehouse model only works if programmers don't feel the install/station split during normal work. The load-bearing UX pattern:

- **Browse defaults to station scope.** When a programmer opens WROK's library, they see WROK's programmed library by default — songs with a `station_programming` row for `station_id='WROK'`. No noise from songs other stations have ingested but WROK hasn't programmed.
- **Search spans both scopes.** When the programmer searches, results render in two sections: "In WROK's library" and "In install library, not programmed on WROK." The programmer never explicitly switches modes; they search, they see what exists, they choose.
- **Adding from search is one click.** An "Add to WROK" affordance on each install-library result opens a small dialog: pick category, optionally set energy/mood/daypart_mask, save. That click creates the `station_programming` row.

The unified-search-with-scope-sections pattern is the same one that makes Slack and Linear feel cohesive across teams/channels. The user thinks "search for the thing." The system answers "here's where the thing exists, in scopes you have access to."

The data model's two-tier reality is exposed *only* in search-result layout, never in navigation.

### 5. Tribute scenario — Option A: ad-hoc play, no programming row

When a host wants to play a song that's not currently in any of the station's categories (Prince dies, the hip-hop station wants to play "Purple Rain" tonight), the flow is:

1. Library search surfaces the song from the install-library section.
2. Host drags it to the next deck slot or right-clicks → "Play now (ad-hoc)."
3. Audio engine plays it. A row is written to the station's `play_log` referencing `song_id` directly, with `programming_row_id = NULL` (or equivalent — schema specifics TBD).
4. **No `station_programming` row is created.** The song does not appear in the station's regular library after the play ends.

#### Promote-to-programming as an explicit second action

If a programmer later decides "we should add this to '80s Recurrent for two weeks," they perform the normal add-to-station flow described in section 4. The promotion is intentional. Pressing play on a tribute does not commit the station to programming the song.

A "Recently played ad-hoc on [station]" section in the search-results layout is a useful affordance for surfacing the promotion path without requiring the programmer to remember the song name. Not architecturally required — the basic install-library search already works.

#### Why not Option B (temporary programming rows with expiration)

Option B would create a programming row on ad-hoc play with a special category like "Ad-hoc" or an `expires_at` timestamp. Rejected because:

- Every ad-hoc play creates programming-row turnover. Four tribute songs in one shift = four rows. Mutations log gets noisy for editorial actions that aren't programming decisions.
- The "Ad-hoc" category becomes a real station-scoped artifact that needs to exist as a placeholder before the mechanism works. It conflates "I played this once" with "this is part of a category I program from."
- It re-introduces the conflation Option A explicitly avoids: the existence of a programming row should mean "this song is programmed in this category," not "this song was once played here."

#### Why not Option C (cross-station borrow)

Option C would have the host's station play the song by referencing another station's programming row read-only. Rejected because it directly violates the section 2 principle: the borrowing station is now playing a song under another station's programming context, which means another station's energy rating and category are de facto in effect. License reporting also gets ambiguous about which station's programming was responsible. The warehouse model exists precisely to prevent this kind of cross-contamination.

### 6. Separation-rules semantics — Position 2

**Ad-hoc plays log to `play_log` but do not affect rotation separation rules.**

The rotation engine queries `station_programming` exclusively when computing eligibility, not `play_log`. A song with no programming row on a station is invisible to that station's rotation engine — it cannot be selected, so the question of separation never arises. A song with a programming row uses `last_played_at` on the row, which is updated only by rotation-engine plays and by promote-to-programming actions when explicitly chosen.

This means: if the overnight host ad-hoc plays "Purple Rain" at 9:47pm and the morning host promotes it to programming at 9am the next day, the rotation engine starts treating it as eligible from that moment with a clean `last_played_at` history. The previous ad-hoc play sits in `play_log` for license reporting and "what did we play last night" queries but doesn't constrain rotation.

**The principle:** manual editorial decisions don't pollute the rotation calculus. Hosts and programmers can ad-hoc play songs without worrying about distorting future rotation behavior. Rotation is a property of programmed songs, computed against programmed history.

### 7. Synced-tables registry needs a `scope` column

Carried forward from the stub commitment #5. Each entry in `electron/sync/synced-tables.js` declares whether the table is `install` scope or `station` scope. The Phase 3.5 audit doc and triage table are rewritten with this lens during Phase 3.5 resumption. Some currently-registered tables move boundary in that pass (`songs`, `artists`, `albums` move to install; the programming-row table joins as station). Exact list is a Phase 3.5 concern, not Phase 4.

### 8. The `executeScopedInsert` wrapper splits or is replaced

Carried forward from the stub commitment #6. Today's wrapper auto-injects `station_id` into every INSERT. Under Direction C, install-scoped tables (`songs`, `artists`, `albums`) must NOT receive `station_id` injection. The wrapper either splits into install-scoped and station-scoped variants, or is replaced by Phase 3.5's typed handlers that derive scoping from the registry. The split-vs-replace choice is a Phase 3.5 sequencing concern (see "Phase 3.5 boundary" below).

---

## Considered and rejected alternatives

For traceability, so future sessions don't re-litigate.

**Station-isolated libraries (every station has its own copy of every song).** Rejected pre-Phase-4 by the stub. Creates 4× redundancy in storage, bandwidth, and metadata maintenance for a 4-station cluster, and conflicts with shipped cloud infrastructure (R2 backups, `library:sync-r2` IPC, Icecast cloud playout) which already assumes shared library.

**Thin join table + sibling tables for each programming attribute.** Rejected in section 1. Loses on sync granularity, rotation engine query cost, and Control Center "copy programming."

**Auto-generate one programming row per song at station creation, with empty programming fields.** Rejected in section 3. Re-introduces auto-discovery; conflates "exists" with "is programmed"; produces mutations log noise; scales wrong.

**Songs carry canonical energy/mood/category that stations override.** Rejected in section 2. There is no canonical programming judgment. Every programming attribute lives on the programming row; nothing inherits from the song.

**Option B for tribute scenario (temporary programming rows with expiration).** Rejected in section 5. Conflates editorial action with programming decision; pollutes mutations log.

**Option C for tribute scenario (cross-station borrow).** Rejected in section 5. Violates the per-station programming-judgment principle.

**Position 1 on separation rules (ad-hoc plays count toward rotation separation).** Rejected in section 6. Would require a parallel `last_played_at` lookup outside `station_programming`, complicates rotation engine queries, and conflicts with the principle that manual editorial decisions don't pollute the rotation calculus.

---

## Open questions for the schema-specifics session

These are deliberately deferred. The next Phase 4 session resolves them before implementation begins.

1. **Final name for the programming-entity table.** Provisional `station_programming`. Alternatives: `station_song_programming`, `programmed_songs`, others. Bikeshed is real — the name appears in queries throughout the rotation engine, the Control Center, and every report.
2. **Exact column list and types on the programming-entity table.** Section 2 lists the columns conceptually. Schema specifics: types, nullability, defaults, check constraints.
3. **Foreign key shape.** Cascade behavior on song deletion (probably soft-delete cascade), on station deletion (probably hard cascade — deleting a station cleans up its programming rows), on category deletion (probably restrict — can't delete a category that still has programming rows in it).
4. **Indexes for rotation engine performance.** Composite index on `(station_id, category_id, rotation_status)` is the obvious primary; secondary indexes on `last_played_at` for separation-rule queries, on `pinned_at` for pin lookups. Profile against realistic data volumes before locking.
5. **Migration plan.** Today's `songs.category_id` is a single value. The migration extracts that into one programming row per existing song with a category, on the single existing station. Songs with `category_id IS NULL` get zero programming rows — confirm with Jeff that no current library songs are in a "should-be-programmed-but-uncategorized" state before running.
6. **`play_log` schema change.** Needs to allow a row with `song_id` populated and `programming_row_id` null (ad-hoc plays). Backward compat for existing rows.
7. **`scope` column shape in `synced-tables.js`.** Enum (`'install' | 'station'`)? String? Boolean `is_install_scoped`? Affects how typed handlers consume the registry.
8. **Per-station-per-song attributes that aren't yet identified.** Section 2's column list is conceptually complete, but a walkthrough of the rotation engine, Format Clock executor, and scheduler may surface additional fields that should live on the programming row (e.g., per-station `intro_skip_ms`, per-station crossfade behavior). Worth a deliberate audit.
9. **Pinned songs table.** Currently a separate table per memory. Two options: absorb `pinned_at` into the programming row (cleanest), or keep `pinned_songs` as a sibling that references the programming row by ID. Recommend absorption — schema specifics session can confirm.
10. **Currently-registered tables that move install/station boundary.** A pass through the registry identifying which entries change scope. Phase 3.5 concern, but the list should be drafted in the schema-specifics session so it's ready when 3.5 resumes.

---

## Phase 3.5 boundary

Phase 3.5 remains paused. What survives from work already committed:

- `docs/sync-protocol-v0.md` (commit `33c3d6a`) — protocol rules are scope-agnostic
- Mutations table schema (17 fields) — operates per-row, scope-independent
- HLC clock generation (`nextClock`, monotonicity) — scope-independent
- Transformer harness + pre-commit hook — verifies migration chain, scope-independent
- Writer module API surface (`withMutation`, `serializePayload`, `deserializePayload`, `toWireFormat`) — scope-independent
- Smoke tests at commit `b917930` — exercise writer behavior, not registry scope decisions

What gets reworked when 3.5 resumes:

- The synced-tables registry — gains a `scope` column; some tables move boundary
- The `executeScopedInsert` wrapper — splits or is replaced by typed handlers
- The Phase 3.5 audit doc — rewrites with install/station as a first-class triage column
- The `multistation_insert_audit_complete` gate at `electron/main.js:3447` — semantics change because half the audited callsites should NOT have `station_id`
- The Phase 3.5 typed-handler code generator — generates handlers aware of install vs. station scope

What's not rebuilt: the foundation. Work committed at `b917930` (writer module + smoke tests) does not need to be redone.

### Sequencing

Phase 4 implementation lands the schema and the data-model split. Phase 3.5 then resumes, with its audit doc and code generator now operating against the corrected scope-aware registry. The split-vs-replace choice for `executeScopedInsert` resolves naturally: if Phase 4 implementation introduces typed handlers for the new `station_programming` table and the install-scoped songs/artists/albums tables, that establishes the typed-handler pattern, and Phase 3.5 extends it to the rest of the synced-tables surface. If Phase 4 implementation goes minimal (split the wrapper into `executeInstallInsert` / `executeStationInsert` only), Phase 3.5 does the typed-handler migration as originally planned.

The schema-specifics session is the right venue for that sequencing call.

---

## Original commitments stub (April 25, 2026)

Preserved verbatim for traceability. The April 26 design above subsumes these but does not contradict them.

> 1. **Library is install-scoped, shared across stations.** The `songs`, `artists`, and `albums` tables hold canonical metadata at the install level. A single source of truth: fix an artist name once, every station benefits. Storage and cloud bandwidth costs scale with library size, not with library size × station count.
>
> 2. **Programming layer is station-scoped.** The `categories`, `format_clocks`, `clock_slots`, `separation_rules`, `smart_schedule_rules`, `generated_schedule`, `scheduled_log`, `play_log`, and `voice_tracks` tables remain station-scoped. Each station has its own programming context (rotation rules, dayparts, format clocks, playout history) operating against the shared library.
>
> 3. **Song-to-category relationship requires a join table.** Direction C makes the same song eligible for membership in different categories at different stations. The current `category_id` column on `songs` cannot represent this; a join table is structurally required. Naming and exact shape are Phase 4 design concerns.
>
> 4. **Cloud infrastructure already assumes shared library.** R2 storage, `library:sync-r2` IPC handlers, `r2:fetch-track`, `cloud_backup_history`, and Icecast cloud playout were built around shared-library assumptions and are already shipping. The data model is being corrected to match the infrastructure, not the other way around.
>
> 5. **The synced-tables registry needs a `scope` column.** Each entry in `electron/sync/synced-tables.js` must explicitly declare whether the table is install-scoped or station-scoped.
>
> 6. **The `executeScopedInsert` wrapper at `src/db/stationScoped.ts` needs splitting or replacing.** Today it auto-injects `station_id` into every INSERT. In Direction C, install-scoped tables must NOT receive `station_id` injection.

---

## Next session

Phase 4 schema-specifics. Fresh head. References this design doc as the locked starting point. Resolves the open questions in section 10. Produces the actual `CREATE TABLE` statements, migration script, and registry diff that Phase 4 implementation runs against.
