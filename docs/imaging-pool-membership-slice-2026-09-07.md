# Per-station pool membership — a slice of its own. Proposal
2026-09-07 · read-only investigation · nothing built

**The ruling:** a cut belongs to more than one pool, and pools belong to stations. One library, many
uses — the same as a song sitting in halloVeen's HV category and Christmas in July's at once.

**The schema cannot express that today.** This is what it takes.

---

## 1 · What is wrong now

`songs.jingle_category_id` is a **single INTEGER on the shared song row**. It is the only membership
column. `jingle_categories` rows carry `station_id`. So one cut → one pool → one station.

The consequence, measured:

| pool | owner | cuts pointing at it |
|---|---|---|
| Summer Christmas | Christmas in Jully | 33 |
| Christmas | Open Format | 19 |
| Halloween | halloVeen | 12 |
| Christmas | Magical Forest | **0** |

The 64 shared cuts are **partitioned across three stations, not shared by them**. Putting a cut in
halloVeen's Halloween pool silently removes it from Christmas in Jully's Summer Christmas pool — a
station's imaging changes because someone edited a different station.

There is a second, unused membership column — `asset_sweeper_meta.sweeper_category_id` — with the same
shape and the same problem (one per asset, no station). Nothing reads it; the panel and the generator
both use `songs.jingle_category_id`. It should be retired by this slice rather than left as a second
answer to the same question.

## 2 · The schema change

One join table. It is the standard shape and it is the smallest thing that expresses the ruling:

```sql
CREATE TABLE sweeper_pool_member (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id     INTEGER NOT NULL,     -- jingle_categories.id (already per station)
  asset_uuid  TEXT    NOT NULL,     -- library_asset.uuid — the SHARED cut
  sort_order  INTEGER NOT NULL DEFAULT 0,
  uuid        TEXT,
  created_at  TEXT, updated_at TEXT, deleted_at TEXT
);
CREATE UNIQUE INDEX idx_sweeper_pool_member_key
  ON sweeper_pool_member(pool_id, asset_uuid) WHERE deleted_at IS NULL;
```

- **Keyed on `asset_uuid`, not `songs.id`.** The uuid is the identity that survives the songs/library
  split (v50 reused the song uuid as the asset uuid deliberately), and it is what a synced peer can
  resolve. A row keyed on a local integer id could not sync.
- **The station is implied by `pool_id`**, so a station cannot be given a pool it does not own.
- It joins the synced-table registry like `jingle_categories` did, with the same soft-delete and
  `updated_at` discipline.

**Backfill:** one row per existing `songs.jingle_category_id`, preserving today's three-way split
exactly. Nothing moves on migration day.

**`songs.jingle_category_id` stays, unread, for one release.** Dropping a column is irreversible and
this is the column the generator reads; leaving it in place means a rollback to the previous build
still finds its data. It is removed in a later, separate step once the new table has been in service.

## 3 · What has to change with it

| where | change |
|---|---|
| `electron/main.js` `resolvePool` (~8440) | pool candidates come from the join, not `songs.jingle_category_id` |
| `SweepersPanel` POOLS | per-cut dropdown becomes per-cut **checkboxes across this station's pools** — a cut can be in several |
| `ImagingPanel` RACK | POOL column becomes pool**s** — a cut can name more than one |
| sync registry | `sweeper_pool_member` added; row-level merge, same as `clock_slots` |
| `asset_sweeper_meta.sweeper_category_id` | retired — one answer to "what pool is this in" |

**The generator is the load-bearing change.** `resolvePool` picks a cut from a pool by
`jingle_category_id`; it becomes a join. Same rotation, same least-recently-played ordering, same
`usedByPool` burnout set — only the membership lookup moves. That is the one edit in this slice that
runs during Generate, which is why it needs its own bench and its own smoke test rather than riding
along with a UI change.

## 4 · What it costs

- **Migration:** one table, one index, a backfill of 64 rows. Sub-second.
- **Sync:** a new synced table means peers on an older build ignore rows they do not know — they keep
  reading `songs.jingle_category_id`, so an un-updated peer keeps today's behaviour rather than losing
  membership. Worth stating plainly: **mixed-version peers will disagree about pool membership until
  both are updated.** That is a real cost of this slice and it is why the old column stays.
- **Effort:** the migration and the panel are routine. `resolvePool` plus its test is the real work.
- **Risk:** contained to Generate. Nothing in the daemon or the audio path reads pool membership — the
  daemon fires what the log already names.

## 5 · What happens to today's three-way split

**Nothing, on migration day.** The backfill reproduces it row for row: Halloween keeps its 12, Summer
Christmas its 33, Christmas 19, Magical Forest 0. The generated logs already on disk are untouched —
they name cuts, not pools.

What changes is what you can *then* do: add all 64 to halloVeen's Halloween pool without taking one
away from anywhere else. That is an edit you make deliberately, not something the migration does for
you.

## 6 · Does anything you would hear change?

**Not by itself, no.** Three reasons, each checkable:

1. The backfill preserves membership exactly, so `resolvePool` returns the same candidate set for every
   pool it returned one for before.
2. Already-generated logs are untouched. `generated_schedule` stores the chosen cut's `song_id` and
   `title`, so every placement already scheduled fires the same cut regardless of pooling.
3. Nothing in the daemon or the Rust engine reads pool membership at all.

**The first thing that would change what you hear** is you putting a cut into a second station's pool —
after which that station's rotation has one more candidate. That is the feature working.

**A test should pin claim 1** rather than assert it: generate a day before and after the migration on
an untouched copy of the profile and diff the placements. If the two logs differ, the backfill is
wrong. That belongs in the slice.

## 7 · Order

After slice 2 (marks) or before it — they do not touch each other. It does **not** block slice 3
(chain types), which keys on `generated_schedule.chain_type`, not on pooling.

## 8 · What this does not claim

The migration, the `resolvePool` change and the before/after log diff are **designed, not measured**.
No code is written. The mixed-version sync behaviour is reasoned from the registry's dispatch on
`REGISTRY[m.table_name]` and has not been observed on two peers.
