# Deleted songs are still being scheduled and aired (2026-08-13)

**Trigger:** "Perfect Revenge" and "Rotten to the Core" were deleted from the library on 2026-07-20
and are still in the log.

**Status:** root cause CONFIRMED in code and data. **Nothing has been changed** — propose-first.

---

## 1. The delete worked

| id | title | uuid | deleted_at |
|---|---|---|---|
| 330 | Perfect Revenge | `94cc13e8-…97c3` | 2026-07-20T20:38:11Z |
| 342 | Rotten to the Core | `f33a377b-…5c20` | 2026-07-20T20:32:31Z |

Both rows are tombstoned, and the delete was recorded as a mutation:

```
2026-07-06  insert, update        imported
2026-07-13  update
2026-07-20  DELETE  (both)        ← recorded correctly
2026-08-07  update ×8             ← written to AFTER deletion (§4)
```

**The delete is not the problem.**

## 2. THE ROOT CAUSE — the generator's candidate pool ignores `deleted_at`

`electron/generate-core.js:147`:

```sql
stmtCandidates:
  SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms,
         s.last_played_at, s.no_repeat_hours, s.file_path
    FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
   WHERE s.category_id = ?
     AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
     AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
     AND (s.daypart_mask IS NULL OR ((s.daypart_mask >> ?) & 1) = 1)
   ORDER BY RANDOM()
```

**No `AND s.deleted_at IS NULL`.** A soft-deleted song stays in the pool Generate picks from, forever.

The two statements **immediately above it in the same function** — `stmtShows:145` and
`stmtSlots:146` — both filter `deleted_at IS NULL`. Identical shape to the deleted-show defect fixed
yesterday: neighbouring queries get it right, this one does not.

### It is in all three generators, not one

| File | Line | What it selects |
|---|---|---|
| `electron/generate-core.js` | **147** | Generate's music candidate pool ← the one that matters |
| `electron/generate-core.js` | 148 | `stmtSongById` — resolving a specific song |
| `audiod/loggen.js` | 162 | daemon song base query |
| `audiod/loggen.js` | 518 | daemon category fill |
| `src/audio/loggen.ts` | 180, 311, 350, 489 | the in-process TS twin's candidate queries |

Every path that CHOOSES A SONG TO AIR is missing the filter. `audiod/engine.js:1295` is the only
selection-adjacent query that has it.

(Also unfiltered but lower stakes: `main.js:7777-7778`, the category-health counts, which therefore
count deleted songs as available depth.)

## 3. What it has cost, measured

```
729   future scheduled rows from 28 soft-deleted songs
        station 1: 64      station 2: 665
438   plays recorded AFTER the song's own delete timestamp
 63   future rows for these two songs alone, through 2026-08-22
```

Next two airings of a deleted song at the time of writing: 2026-08-13 19:40 and 22:36, halloVeen.

## 4. A second defect — something writes to deleted songs

Eight `update` mutations landed on these two rows on **2026-08-07**, weeks after deletion. They did
not resurrect the rows (`deleted_at` is still set), so this is not the cause of the airing — but a
writer that does not check `deleted_at` is how a tombstone eventually gets undone. Worth identifying;
the likely candidates are the library rescan and the cue/loudness pass.

## 5. A THIRD defect, and this one is mine

`_commitDayRows` deletes only `WHERE source IS NULL` (4.4.196), and `isOperatorOwned()` in
`electron/log-edit-core.js` treats **any** non-empty `source` as human-owned. But `main.js:7208`
stamps `source='auto'` on every row the unattended extender writes — as **provenance**, not
ownership, and the code comment says so.

So every auto-extend row is currently permanent: Generate cannot delete or replace it, and gap-fill
skips anything overlapping it. **The 729 stale rows cannot be cleared by regenerating**, because of
this.

Before 4.4.196 the window delete was unconditional and these rows were replaced normally. This is a
regression I introduced.

## 6. The three fixes, in order

1. **`source` allowlist** (`log-edit-core.js`) — preserve `'operator'` only. `'auto'`, `'autofit'`,
   `'machine'`, `NULL` and `''` all become disposable again. This matches the design doc's Layer 1
   table exactly, which lists only `NULL` and `'operator'`. **Must be first** — until Generate can
   delete machine rows again, no amount of fixing the picker will clear what is already scheduled.
2. **`deleted_at IS NULL` on every song picker** — the 9 sites in §2, plus a guard test that greps
   for `FROM songs` in a selection context without the clause, shaped like the
   `deleted-shows-guard` test added yesterday.
3. **Regenerate the affected window** and confirm the 729 rows drop to 0.

Fix 2 without fix 1 leaves the existing stale rows in place. Fix 1 without fix 2 lets Generate clear
them and then immediately pick the same deleted songs again. **They ship together.**

## 7. What this does NOT explain

The `songs` 543 vs `songs_v2` 350 gap is separate: `songs_v2` is the account library mirror, its
snapshot version is 350 stamped 2026-07-06, and it has not advanced since. That is why a second
machine pulling from the account sees a different library — a sync question, not a delete question.
