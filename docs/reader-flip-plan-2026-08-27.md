# Step 4 — the reader flip: plan and proof design

**READ-ONLY. Nothing has been flipped. No reader has been changed.**
Date: 2026-08-27 · Branch: `log-reader-flip` · Precedes: `docs/library-asset-build-plan-2026-08-26.md`

---

## The one thing that decides this step

I ran the pool comparison against the live DB before touching anything. The result changes
the shape of step 4:

```
── station 1: Open Format ───────────────────────────────────
   A  today (songs columns)      avg eligible/hour: 163
   C  programming → station_programming  avg eligible/hour: 0   vs A: DRIFT 3912 across 24h ✗
── station 2: halloVeen ─────────────────────────────────────
   A  today (songs columns)      avg eligible/hour: 151
   C  programming → station_programming  avg eligible/hour: 0   vs A: DRIFT 3624 across 24h ✗
── station 3: Magical Forest ────────────────────────────────
   A  today (songs columns)      avg eligible/hour: 76
   C  programming → station_programming  avg eligible/hour: 0   vs A: DRIFT 1824 across 24h ✗
── station 4: Christmas in Jully ────────────────────────────
   A  today (songs columns)      avg eligible/hour: 46
   C  programming → station_programming  avg eligible/hour: 0   vs A: DRIFT 1104 across 24h ✗

   songs carrying a category (install-scoped):  436
   station_programming rows (per-station):      12
```

**Zero.** Not "fewer" — every hour, every station, nothing eligible. Rotation would have
nothing to pick and all four stations would go to dead air the moment the flip landed.

The cause is arithmetic, not a bug: 436 songs carry a category on `songs`, and
`station_programming` — the per-station table rotation would read instead — has **12 rows**.
A join can only offer what has a row.

---

## Why the step splits in two

The 31 touchpoints are not one kind of change. They read two different kinds of column, and
only one kind moves scope:

| | columns | what it is | scope today | scope after | behaviour risk |
|---|---|---|---|---|---|
| **ASSET** | `file_path` `file_key` `title` `duration_ms` `artist_id` `album_id` `intro_end` `outro_start` `cue_in/out` `content_class`→`type` | properties of the **file** | install-wide | install-wide | **none** — same values, same scope |
| **PROGRAMMING** | `category_id` `rotation_status` `daypart_mask` `no_repeat_hours` | how **this station** treats the file | install-wide (shared) | **per station** | **total** — this is the 0-eligible result above |

Count by file (`s.<col>` references):

```
audiod/loggen.js        8 song touchpoints   — the live rotation predicate (line 70)
src/audio/loggen.ts     7 song touchpoints   — the renderer twin, must stay identical
audiod/playlog.js       1                    — classifier, asset-only
```

`category_id` alone appears 24 times across the two loggens. Every one of those is a
programming read.

### 4a — asset fields → `library_asset`  ·  behaviour-neutral, safe to do now

Swap only the ASSET column reads onto `library_asset`, joined by `uuid`. The programming
columns keep reading `songs` exactly as they do today. Same values, same scope, same pool —
this is a plumbing change wearing a rotation change's clothes.

Proven, not asserted: scheme **B** in the harness runs the real predicate with the asset
fields sourced from `library_asset`, and the pool must come back **IDENTICAL** on all four
stations across all 24 hours before the reader is touched.

### 4b — programming fields → `station_programming`  ·  BLOCKED

Cannot be done in this step. It needs the programming rows to exist first, which is a
**v51 backfill**, not a reader change:

> one `station_programming` row per (song, the station owning its current category),
> carrying `rotation_status` / `daypart_mask` / `no_repeat_hours` across verbatim.

Only after that backfill can scheme **C** return a non-zero pool, and only when C comes back
IDENTICAL to A on all four stations does the programming reader get flipped.

**This also forces the (a)/(b) ruling that was still open.** The 436 categorised songs have
to become programming rows on the station whose category they point at — that is (a), and it
is now mandatory rather than a preference. (b) — letting other stations add their own rows
later — remains free and additive on top.

---

## The proof: `scripts/prove-rotation-pool.js`

Rotation picks with `ORDER BY <least-recently-played>, RANDOM()`. Comparing the **sequence**
it produces proves nothing — two identical systems produce different logs. What must be
identical is the **eligible pool**: the exact set rotation is allowed to draw from, per
station, per hour. Pool unchanged ⇒ rotation unchanged. Pool moved ⇒ rotation moved.

So the harness computes the pool three ways — A (today), B (4a), C (4b) — for
**4 stations × 24 hours**, and diffs the sets. It reports drift counts and names the actual
song ids that appear or vanish, so a difference can be inspected rather than argued about.

It is read-only, opens the DB `readonly: true`, and writes nothing.

One correction worth recording: the first version printed
`VERDICT: A ≡ B on every station and hour` while B had been **skipped** for a missing table —
a false green from a harness whose entire job is preventing false greens. It now prints
`NOT EVALUATED` and says what to do about it. Current live output:

```
VERDICT (B): NOT EVALUATED - library_asset is absent on this DB. Apply v50 (relaunch)
             and re-run. The asset-field flip is UNPROVEN until this shows IDENTICAL.
```

`library_asset` is committed (v50) but this DB has not been relaunched since, so the table
isn't there yet. **A relaunch is the first thing that has to happen** — until then 4a's
safety is unproven and I will not flip it.

---

## Proposed order

| # | action | gate before proceeding |
|---|--------|------------------------|
| 1 | Relaunch the app so v50 applies to the live DB | `library_asset` present, backfill counts reported |
| 2 | Re-run the harness | **B = IDENTICAL** on all 4 stations, 24h |
| 3 | Flip the ASSET reads in `audiod/loggen.js` + `src/audio/loggen.ts` (4a) | re-run harness → still IDENTICAL; Jeff sees rotation on all 4 |
| 4 | **STOP.** Separate ruling. | — |
| 5 | v51 backfill: programming rows for all 436 categorised songs | harness **C = IDENTICAL**, non-zero pool |
| 6 | Flip the PROGRAMMING reads (4b) | Jeff verifies rotation on all 4 stations |

Steps 5–6 are a distinct arc and are not part of what I'm asking to do now.

Nothing is pushed at any point without Jeff's verification on all four stations.

---

## What I am deliberately NOT doing

- Not flipping any programming reader — the measured result is dead air.
- Not backfilling `station_programming` in this step; that is v51, ruled on separately.
- Not touching `categories` / `metadata_definitions` / `metadata_vocabulary` — the three
  axes stay as they are, `+ Add Category` and unlimited per-station custom metadata included.
- Not changing the pick order, separation rules, or `ORDER BY` in either loggen.
- Not backfilling the 35,826 historical `play_log` MUSIC rows.

## Architecture compliance

- `docs/unified-library-architecture-2026-08-26.md` — asset identity unified, per-station
  treatment stays an overlay. 4a moves identity only, which is precisely that boundary.
- `docs/three-axes-preserved-2026-08-26.md` — TYPE / CATEGORY / METADATA remain orthogonal;
  nothing here collapses one into another.
- CLAUDE.md, *"a grep is a claim about the tree, never about the product"* — hence a live-DB
  measurement rather than a reading of the SQL, and hence B marked UNPROVEN until it runs.
