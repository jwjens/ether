# Unified library — current state and open decision

**LIVING DOCUMENT. This is the fixed source of truth for the library work.**
Read this before touching `library_asset`, `songs`, `spots`, `announcements`, or the panels.

Last verified against the live 4-station DB: 2026-08-27 · Branch `log-reader-flip` · Nothing pushed.

---

## The goal (Jeff's, unchanged)

Spots, sweepers and announcements become entries in ONE typed library, and the UI panels become
filtered views over it — the RCS model: one library, everything typed, filter to see each type.

## What has NOT been decided

**No ruling exists to drop `songs` or to make `library_asset` the source of truth for music.**
That is a separate re-architecture. No document, migration, or code in this tree may assume it.
If a future session finds language implying it, that language is wrong and should be removed.

---

## What is actually built (steps 1–4a, all committed, all local)

| commit | step | what it did | state |
|---|---|---|---|
| `6c74910` | 1 — type registry | `shared/asset-types.json`, 8 types, two loaders, tests | done |
| `f725792` | 2 — schema v50 | `library_asset` (install-scoped), `asset_spot_meta` (station-scoped), `asset_sweeper_meta`; `station_programming` + `song_metadata_values` **widened** with `asset_uuid`, not replaced | done |
| `cb9f8c9` | 3 — sync | handlers writing through `withMutation` with a no-op guard; registry entries; preload API. Also fixed a `refs` defect shipped in v4.4.231 | done |
| `93ba3f8` | 4a — reader flip | rotation read ASSET fields from `library_asset` | **REVERTED** — see below |
| (uncommitted) | v51 + panels + writer | Option 1 implemented | see below |

### Data as it stands

```
library_asset  511 rows        songs           510 rows      announcements  5 rows
   SONG     444                   (all 510 also exist in library_asset)   spots       3 rows
   SWEEPER   64                station_programming  12 rows
   SPOT       3                   — 0 of them for JIN/SWP/SPOT
```

- **Spots and sweepers are already typed in `library_asset`.** v50 did this.
- **Announcements are the only data gap** — 5 rows, no asset row. They live only in the
  `announcements` table and were never in `songs` (`content_class='ANN'` is 0).
- **v50 also copied all 510 songs in**, so `library_asset` currently duplicates music.

### Who reads / writes what, today

| | reads `library_asset` | writes `library_asset` |
|---|---|---|
| `audiod/loggen.js`, `src/audio/loggen.ts` | **yes** (asset fields, since 4a) | no |
| `electron/sync/handlers/*` | yes | **yes — the only writer** |
| Any UI panel | **no** | no |
| Song import / edit / R2 relink | no | **no** |

Panels today: `Spots.tsx` → `ether.spots.*`; `Announcements.tsx` → `ether.announcements.*`;
`JinglesPanel` → sweepers via `jingle_category_id` on `songs`.

The IPC the goal needs **already exists** in `electron/preload-handlers.js`:
`library_asset.list(opts)` accepts `{types:[…]}`, plus `getById`, `counts`, `create`, `update`,
`delete`, and both meta tables. No UI calls it yet.

---

## Option 1 — IMPLEMENTED (2026-08-27, uncommitted pending Jeff's verification)

| step | what changed | proof |
|---|---|---|
| 3 — revert 4a | asset reads removed from both loggens; rotation reads `songs` directly. The prove-* harnesses and plan doc from `93ba3f8` were kept | `prove-flip-4a-live` — 163/151/76/46 per station, 10,464 rows, 0 SQL errors |
| 1 — retire SONG rows | v51 deletes `type='SONG'` (477 incl. soft-deleted) | `songs` byte-identical before/after |
| 2 — announcements typed | v51 backfills 5 as `type='ANNOUNCEMENT'`, keyed by the announcement's own uuid | 13/13 assertions |
| 4 — panels are filtered views | `Spots.tsx`, `Announcements.tsx`, `JinglesPanel.tsx` list from `library_asset` joined to their station-scoped table | `prove-panel-filtered-views` 13/13 |
| 5 — announcement writer | create/update/delete mirror into `library_asset` inside the same mutation | `smoke-announcement-library-mirror` 20/20 |

**The 4a staleness risk is closed** — nothing reads `library_asset` for music any more, and the
non-music types now have a writer that keeps their asset rows current.

### Two things the ruling did not anticipate, found by the proofs

- **`announcements` has no `file_key` column.** Identity is the uuid, which every row carries. That
  also matches v50's contract (`la.uuid = s.uuid`) and makes the backfill deterministic across
  installs.
- **The 3 SPOT assets were not the 3 spots.** Two had been copied out of `songs` (rows with
  `content_class='SPOT'`) rather than from `spots`, so only one spot joined by uuid and the panel
  silently hid the other two. v51 now keys each type by the table that OWNS it:
  SPOT→`spots`, ANNOUNCEMENT→`announcements`, SWEEPER→`songs` (sweepers have no separate table, so
  those 64 rows are correctly keyed and deliberately untouched).

### Why v51 does not journal mutations
Migrations run on EVERY install, so a journalled backfill would arrive twice on a peer — once from
its own v51, once from the incoming mutation. v50 journals zero for the same reason. Convergence
comes from determinism: the asset row reuses the source row's uuid. The sanctioned sync path
(`withMutation`) is on the runtime writer in step 5, which is where it belongs.

### Library shape after v51

```
library_asset:  SWEEPER=64  ANNOUNCEMENT=5  SPOT=3        songs: 510 (untouched)
```

## Standing constraints — none of these may be traded away

- The library is **install-scoped**; an asset is a file, shared by every station. (RCS: global fields.)
- Per-station **treatment** is real and running on four stations. (RCS: station-specific fields.)
- **All** metadata is per-station overridable, every field.
- Custom metadata categories are user-created and **unlimited**, per station.
- **Ducking is a channel/deck function**, never a property of content type. No duck flags in the
  type registry.
- The three axes stay orthogonal: TYPE (registry) · CATEGORY (unlimited, per-station) ·
  METADATA (unlimited custom fields, per-station).

## Gate status

`tsc --noEmit` exit 0 · `loggen-category-gate` 9/9 unmodified · content-class exclusion passing ·
three proof harnesses passing · schema chain verified v2→v50, no gaps.

## Related

`library-asset-session-record-2026-08-27.md` (full narrative) ·
`unified-library-architecture-2026-08-26.md` · `library-asset-build-plan-2026-08-26.md` ·
`three-axes-preserved-2026-08-26.md` · `reader-flip-plan-2026-08-27.md` ·
`sweepers-rcs-model-design-2026-08-22.md` · RCS Zetta/GSelector research PDF (external, `~/Downloads`)
