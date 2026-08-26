# Per-station metadata — what is actually true (verified 2026-08-26)

**Status: READ-ONLY VERIFICATION. Corrects my own schema draft. No schema written.**

Jeff, correcting me:

> *"ALL metadata is changeable per station in the library — every field (title, artist, category, all
> of it), not just category. Nothing is baked in. The song carries defaults, and each station can
> override any field independently. If two stations show the same value, it's ONLY because no one
> changed it — not because they're shared or locked."*

**He is right. I was wrong, and my `library_asset` draft would have destroyed this.** I had title,
artist, BPM and the rest as columns on the shared asset row — which collapses per-station-overridable
fields into single shared values. That is precisely the thing the ruling forbids.

---

## 1. The mechanism that already exists

Three tables, all **station-scoped**, all seeded per station by `seed-station-config`:

| Table | Scope | Rows here | What it is |
|---|---|---|---|
| `metadata_definitions` | `station_id NOT NULL` | **188** = 47 × 4 stations | the field list, per station |
| `metadata_vocabulary` | `station_id` | **140** = 35 × 4 | choice values for choice-typed fields |
| `song_metadata_values` | `station_id` + `song_id` + `definition_id` | **0** | the per-station OVERRIDE for one field on one asset |

### The 47 built-in definitions — every field, not custom extras

```
Title | Artist | Album | Album Artist | Composer | Year | Genre | BPM | Energy | Mood |
Comments | Description | Grouping | Movement Name | Movement Number | Work | Track Number |
Disc Number | Release Date | Purchase Date | Rating | Album Rating | Favorite | Era |
Tempo Feel | Vocal Type | ISRC | Intro Time | Outro Time | Sort Title | Sort Artist |
Sort Album | Sort Album Artist | Sort Composer | Length | Date Added | Date Modified |
Last Played | Last Skipped | Plays | Skips | Bit Rate | Sample Rate | Size | Kind |
Cloud Download | Cloud Status
```

**All 47 are `is_built_in = 1`.** Title and Artist are in the list. This is not a custom-fields
sidecar bolted next to fixed columns — it is the whole field set, per station.

### It is wired end to end

- `App.tsx:5228` fetches `songMetadataValues.listBySong(songIds, stationId)` — **station-scoped**.
- `reloadDefs()` re-runs on `[stationId]`, so the field list itself re-reads on a station switch.
- Full IPC surface exists: `list`, `get-by-id`, `create`, `update`, `delete`, `bulkApply`,
  `listBySong` (`electron/preload-handlers.js:262-268`).
- It is a synced table with its own handler.

### `song_metadata_values` = 0 rows is NOT evidence of an unused feature

It is the **default state**, and it is exactly what Jeff described: *"If two stations show the same
value, it's ONLY because no one changed it."* No override rows means no field has been overridden
yet — the resolution falls through to the asset's own value, on every station. The moment one is
changed, one row appears and only that station moves.

**I nearly made the same mistake here that I made with `station_programming`'s 12 rows** — reading a
low row count as "barely wired" rather than as "nobody has needed it yet". A sparse override table is
the correct shape for an override table.

---

## 2. So there are TWO per-station overlays, on different axes

| Overlay | Table | Axis | Fields |
|---|---|---|---|
| **Metadata** | `song_metadata_values` | what the asset *is* | any of the 47 — Title, Artist, BPM, Genre, Mood… |
| **Programming** | `station_programming` | how the station *plays* it | category, rotation_status, daypart_mask, energy, no_repeat_hours |

Both are keyed `(song_id, station_id)`. Both carry `station_id`, so both already ride the
station-switch contract (`docs/station-switch-contract-2026-08-26.md`) with no special handling.

---

## 3. What this changes in the library design

### WRONG (my earlier draft)

```sql
CREATE TABLE library_asset (
  title TEXT NOT NULL, bpm REAL, lufs_measured REAL, …   -- THE values. Shared. WRONG.
);
CREATE TABLE asset_music_meta (artist_id, category_id, …);  -- invented; duplicates what exists
```

This collapses overridable fields into shared ones and invents a table beside two that already do the
job.

### RIGHT

```
library_asset            — the FILE and its DEFAULT values (install-scoped)
  ↑
  ├── asset_metadata_values     — per-station override of ANY defined field   (= song_metadata_values, generalised)
  └── asset_station_programming — per-station programming treatment           (= station_programming, generalised)
```

- `library_asset` carries **defaults**, not truths. Renaming the column comment matters: what lives
  there is what a station sees *until it changes it*.
- The two overlays are **generalised from `song_id` to `asset_uuid`**, so they cover spots, sweepers,
  announcements and every future type — not rebuilt, not replaced.
- `metadata_definitions` and `metadata_vocabulary` need **no change at all**: they are already
  per-station and already describe arbitrary fields. They simply come to apply to every asset type.
- **One resolver**, the same discipline as `closingTimeForDate` and `resolveTypeBehaviour`:

  ```
  resolveAssetField(stationId, assetUuid, field)
      → per-station override   (song_metadata_values / asset_metadata_values)
      → asset default          (library_asset column)
  ```

  Precedence in one place. Nothing downstream reads a column directly and calls it the truth.

### The prohibition this adds

**No field that is currently overridable may become a single shared value.** Any column on
`library_asset` must be readable as a default with an override in front of it. If the migration would
make Title shared, the migration is wrong.

---

## 4. What I got wrong, twice, and the pattern

Both corrections were the same mistake: **reading a sparse table as unbuilt rather than as unused**,
and then designing a replacement for something that already worked.

- `station_programming`: 12 rows → I wrote "barely wired". It is the per-station programming overlay,
  correctly sparse.
- `song_metadata_values`: 0 rows → I would have concluded the same, and designed shared columns.

The rule for the rest of this arc: **an empty override table is evidence of a default, not of a
missing feature.** Ask what the empty state means before designing past it.

---

## 5. Still open, unchanged

The one decision: the 436 categorised songs migrate as **(a)** one programming row each on their
current station, or **(b)** the same plus availability to every station. Neither changes what airs.

And the `songs_all` sequencing question.

**No schema written.**
