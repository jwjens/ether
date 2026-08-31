# Unified library — current state

**LIVING DOCUMENT. This is the fixed source of truth for the library work.**
Read this before touching `library_asset`, `songs`, `spots`, `announcements`, the Library grid, or
the panels.

Last verified against the live 4-station DB: **2026-08-27**, schema **v52** applied.
Branch `log-reader-flip` · **6 commits local, nothing pushed.**

---

## The goal (Jeff's, unchanged)

Spots, sweepers and announcements are entries in ONE typed library, and the UI panels are filtered
views over it — the RCS model: one library, everything typed, filter to see each type.

## What is NOT decided

**There is no ruling to drop `songs`.** Option 1 (below) was ruled and shipped: music stays in
`songs`, authoritative and untouched. A later request to make `library_asset` the sole source of
truth is currently **OPEN and unresolved** — see *The open decision* at the end. No code may assume
it either way.

---

## Live database, right now

```
schema_version MAX = 52

library_asset:  SWEEPER=64   ANNOUNCEMENT=5   SPOT=3          ← NO SONG rows (v51 removed 477)
songs:          MUSIC=444    SWP=64           SPOT=2          ← music lives here, authoritative
station_programming: 12 rows      announcements: 5      spots: 3
```

Two facts that constrain everything downstream:

- **`library_asset` holds no music.** Any design that reads it as the grid's only source shows
  72 items and zero songs.
- **`station_programming` has 12 rows against 444 songs.** It cannot carry per-station category yet;
  joining it for SONG detail returns empty for almost everything. This is the 4b blocker.

---

## Committed today (6 commits, local, unpushed)

| commit | what |
|---|---|
| `6c74910` | **Step 1 — type registry.** `shared/asset-types.json`, 8 types, two loaders, tests. A 9th type is one JSON object, no code edit. |
| `f725792` | **Step 2 — schema v50.** `library_asset` (install-scoped), `asset_spot_meta` (station-scoped), `asset_sweeper_meta`. `station_programming` + `song_metadata_values` **widened** with `asset_uuid`, not replaced. |
| `cb9f8c9` | **Step 3 — sync.** Handlers writing through `withMutation` with a no-op guard; registry entries; preload API. Also fixed a `refs` defect shipped in v4.4.231. |
| `93ba3f8` | **Step 4a — reader flip.** Rotation read asset fields from `library_asset`. **Later reverted** (see below). |
| `203f71b` | **Option 1 — non-music library.** v51: retired the 477 duplicated SONG rows, backfilled 5 announcements, re-keyed spots. Panels became filtered views. Announcement writer wired. 4a reverted. |
| `fb9332a` | **Jingles eradicated.** v52: `JIN → SWP` across 4 tables (62,807 rows). One sweeper type, one panel, one default. |

### Why 4a was reverted

`library_asset` had no writer outside the sync layer, so its SONG rows were a snapshot frozen at v50.
Rotation read `COALESCE(la.file_path, s.file_path)` — asset wins — while two live paths repoint
`songs.file_path` and never touched the asset row (`main.js:10247` R2 consolidate, `main.js:10499`
"From this computer" relink). A relink would have left rotation on a stale path. **This is the single
most important lesson in this arc: a reader must not be flipped onto a table nothing writes.**

### v52 — the sweeper rename

`JIN → SWP` in `jingle_categories.type` (4), `songs.content_class` (64), `generated_schedule`
(46,349), `play_log` (16,390). `SWP` was entirely unused beforehand, so it was a pure relabel.

- **Pools and songs moved atomically.** The overlay scheduler selects imaging with
  `WHERE s.jingle_category_id = ? AND s.content_class = ?` (`main.js:7887`), supplying the second
  parameter from the pool's type (`:7914`). Split them and `resolvePool()` matches nothing and
  imaging silently stops airing.
- **No journaling.** Migrations run everywhere; journaling would double-apply and add 62k mutations
  to a journal where `generated_schedule` already holds 27,886. A `payloadTransformer` rewrites
  `JIN → SWP` on inbound mutations so a v51 peer cannot reintroduce it.
- **Timing collapsed** to `SWEEPER_DEFAULT = { lead: 5, under: 2 }` — the old per-class defaults
  would have moved every new overlay from a 5s lead-in to 2s.
- **`JIN` survives as a READ, never a write** (`isSweeper()` / `LEGACY_SWEEPER` in
  `contentClass.tsx`). 16,390 play_log rows recorded what aired under that name.
- **`jingle_categories` table name kept** — it is synced, and the receiver dispatches on
  `REGISTRY[m.table_name]`, so renaming would make a peer's mutation land nowhere.
- **Shipped migrations v29-32 and v50 are FROZEN** — the chain replays them on fresh installs.

---

## Uncommitted: the Library grid (`src/App.tsx`)

The Library push-up now shows **all four types**, but through a hybrid source:

- **Music, spots and sweepers** come from `songs` — they were always there, tagged by
  `content_class` (`MUSIC` / `SPOT` / `SWP`). This is why spots and sweepers "already worked" and
  needed no move.
- **Announcements** are fetched separately from `library_asset` joined to `announcements`,
  station-scoped, and merged in. They have **never** been in `songs`, which is why the type chip
  showed `0 shown` before this.

Also in the working tree:

- Header reads **"Library"**, counts **items** (515 on halloVeen), not "tracks".
- `ClassFilter` chips (reused from the Play Log) filter the grid; empty set = everything.
- The `LIMIT 500` bug is fixed — all 510 songs load (10 were being cut off).
- Empty state names the right content and offers the right import button.
- **Row-action guards.** Announcement rows carry a synthetic **negative id** so they cannot collide
  with song ids in row keys or the selection Set. Every writer in the grid speaks `ether.songs.*`,
  so song-only actions (bulk category assign, inline title edit, per-row category, delete,
  mark-as-sweeper) are withheld on non-song rows via `isSongRow(row)`.

---

## ⚠ THE OPEN DECISION — Jeff to rule

A later instruction asked the grid to read `library_asset` as its sole source of truth, showing all
types including SONG. **That cannot be built against the current data**: `library_asset` has no SONG
rows, so the Library would show 72 items and no music. It also contradicts the Option 1 ruling that
shipped this morning.

The phrase "true RCS model" is load-bearing here: **RCS genuinely does have one physical library
including songs.** Option 1 deliberately diverged from that. So the request is coherent — it reverses
an earlier ruling, which may not have been the intent.

### (a) Make `library_asset` truly the one table
Re-backfill SONG rows; the grid reads it alone. Actual RCS.
**Cost:** re-creates the exact defect removed today — `library_asset` has no writer for songs.
Doing it safely requires a **mirror writer on every path that touches `songs`**: import, cue editor,
metadata edits, and both R2 relink paths. This is the medium-high-risk "Option 2" from this morning;
a missed writer is silent drift.

### (b) Keep Option 1; the grid unions the two sources
`songs` for music, `library_asset` for the rest, merged into one grid with type filters and
type-aware actions.
**Result:** every acceptance item passes — all four types by default, toggles filter correctly,
halloVeen sees its 5 announcements and other stations 0, actions work per type. One library on
screen, two sources underneath.

**Recommendation: (b) now.** It delivers the whole RCS experience at low risk and does not reopen the
staleness problem. (a) becomes correct the moment the mirror writer exists — and that writer is worth
building on its own merits, at which point (a) is a small follow-on rather than a foundation gamble.

Either way: **drop `station_programming` from the SONG join.** With 12 rows it cannot carry category;
SONG detail keeps coming from `songs` until a v51-style backfill for programming rows happens.

---

## Filed, not built

- **Type-aware row actions** — the grid renders every type, but load-to-deck / cue editor / category
  assign still assume a song. Guards withhold them for now; making them genuinely type-aware is the
  remaining half of the unified-library work.
- **4b — rotation's per-station scoping.** Blocked: `station_programming` has 12 rows against 436
  categorised songs, so flipping rotation onto it yields a zero-song pool on all four stations.
  Needs a backfill first. Not required for the library goal.
- **User-created asset types.** RCS lets operators add Custom Asset Types in-app; ours live in
  `shared/asset-types.json`, so a 9th needs a shipped build. Real gap against the target model, not
  yet designed.
- **`jingle_categories` table rename** — deliberately not done (sync dispatch risk).
- **Pool `lead_in_sec`/`underlap_sec` are never read at generation** — `main.js` reads only
  `SELECT type` from `jingle_categories`, so pool 2's tuned `10/13.5` is ignored. Pre-existing.

## Standing constraints — none may be traded away

- The library is **install-scoped**; an asset is a file shared by every station (RCS: global fields).
- Per-station **treatment** is real and running on four stations (RCS: station-specific fields).
- **All** metadata is per-station overridable, every field.
- Custom metadata categories are user-created and **unlimited**, per station.
- **Ducking is a channel/deck function**, never a property of content type.
- Three orthogonal axes: TYPE (registry) · CATEGORY (unlimited, per-station) · METADATA (unlimited
  custom fields, per-station).

## Gate status

`tsc --noEmit` 0 errors · `prove-sweeper-rename` 14/14 · `loggen-category-gate` 9/9 ·
`smoke-announcement-library-mirror` 20/20 · `prove-panel-filtered-views` 13/13 ·
`prove-flip-4a-live` rotation 163/151/76/46 unchanged · transformer chain v2→v52, no gaps.

## Peers

Two installs sync this account. `8e8f6181…` (this machine, 31,117 local mutations) and
`041ceb96…` (**a genuine remote peer**, 5,803 mutations, active through 2026-08-27). It is still on
v51. Nothing journals from v51/v52, so both stay internally consistent — but a song edited between
this machine's v52 and the peer's would cross the gap. Worth getting the build onto that machine.

## Related

`library-asset-session-record-2026-08-27.md` (narrative) ·
`jingle-eradication-plan-2026-08-27.md` · `unified-library-architecture-2026-08-26.md` ·
`library-asset-build-plan-2026-08-26.md` · `three-axes-preserved-2026-08-26.md` ·
`reader-flip-plan-2026-08-27.md` · `sweepers-rcs-model-design-2026-08-22.md` ·
RCS Zetta/GSelector research PDF (external, `~/Downloads`)
