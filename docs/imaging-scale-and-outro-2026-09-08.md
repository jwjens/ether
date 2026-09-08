# Imaging at 5,000 cuts · and whether the outro needs its own mark
2026-09-08 · read-only, measured on a COPY of the profile · **nothing built**

Two corrections from Jeff:

1. The 64 cuts are a **test library**. Full libraries are thousands. Do not design around 64.
2. **The song owns the timing.** The post says how much room exists; a cut either fits or is not
   selected. Marking is song-side work; cuts just need their length, which the file already gives.

Both accepted. Everything below is measured by growing the library to 5,000 cuts on a throwaway copy
and timing the real queries.

---

## 1 · What actually breaks at 5,000 cuts

Measured: library grown to 5,000 `SWEEPER` rows, 4,955 in one pool, on a copy of the live profile.

| what | at 5,000 | verdict |
|---|---|---|
| **Candidate query** (`electron/sweeper-pool.js`, LRP-ordered) | **38.2 ms**, once per pool per Generate, cached | **fine** |
| **Length filter per seam, in SQL** (indexed, `LIMIT 1`) | **11.8 ms** for a whole day of 452 seams — 0.026 ms each | **fine** |
| **Length filter per seam, in memory** (naive `.filter` over 4,955) | **81.1 ms** for 452 seams — 0.18 ms each | **fine** |
| **Pool membership list** (`sweeper_pool_member`, station-scoped) | **4.1 ms** for 4,955 rows | **fine** |
| **RACK list query, as shipped** | **1,937 ms** | **BREAKS** |
| **RACK list query with `LIMIT 200`** | **1,732 ms** | **still breaks — the limit does not help** |
| **RACK list rendering** | 5,000 rows × 5 cells ≈ 25,000 DOM nodes | **breaks** |
| **POOLS per-cut checkboxes** | 5,000 cuts × one checkbox per pool | **breaks** |

### The one that matters: RACK is a two-second stall, and paging does not fix it

The RACK query carries a **correlated `group_concat` subquery per row** to name the pools a cut is in.
With `ORDER BY`, SQLite must produce and sort every row before the limit applies, so **the subquery runs
5,000 times whether you ask for 200 rows or all of them** — measured, 1,732 ms vs 1,937 ms.

**Fix:** stop correlating. Two flat queries and a join in JS — the cut page (indexed, limited) plus the
station's whole membership list, which costs **4.1 ms for 4,955 rows**. Then RACK pages properly and
the pool names come from a Map.

### Rendering and the marking workflow

- **RACK must page or window.** At 5,000 cuts a full render is 25,000 nodes and every keystroke in a
  future search box re-renders them.
- **POOLS cannot keep a checkbox grid.** One checkbox per cut per pool is fine at 64 and absurd at
  5,000. It inverts: pick a pool, then search and add cuts to it — the membership list is the cheap
  half (4.1 ms), the all-cuts render is not.
- **The marking workflow is already the right shape, and it is now songs-only.** RACK's songs mode
  already limits to 400 and orders unmarked-first, most-scheduled-first. That is exactly the shape a
  large library needs, because it is the *only* order in which marking pays for itself.
- **Songs mode carries the same correlated-subquery trap** — a per-row `COUNT(*)` over
  `generated_schedule` before the limit. Same class as the RACK one. **Not separately measured**; I am
  naming it because it is the same shape, not because I timed it.

### And the cut side stops mattering at scale

Because cuts need no marking — their length comes from the file — a 5,000-cut library adds **no
operator work at all**. The work scales with songs, not cuts. That is a direct consequence of Jeff's
correction and it is the single best thing about this model at scale.

---

## 2 · Where selection runs: Generate, not fire time

**Generate.** It already does: `_placeJingles` picks the cut and writes `song_id` and `title` onto the
placement row, and the daemon fires what is named. Selection by length changes what is picked, not
when.

**Two rules that keep it fast, both learned the hard way:**

1. **Resolve candidates ONCE per pool, as today.** The 2026-08-06 Generate freeze was a per-row query
   whose correlated `MAX(play_log.played_at)` scanned 115,371 rows per candidate — 898 ms per call,
   406 seconds per day. The cache is what fixed it and it must survive.
2. **The length filter is cheap either way — but it must not drag the play_log subquery with it.** The
   per-seam SQL filter is fast *because* it has no `play_log` correlation. Put the LRP ordering in the
   once-per-pool query and the length filter per seam, and both stay cheap.

**I was wrong about this earlier.** I said the filter had to be in memory or it would reintroduce the
freeze. Measured, the indexed SQL filter is **7× faster** than a naive in-memory scan (11.8 ms vs
81.1 ms per day). Neither breaks; the freeze risk is the `play_log` correlation, not the per-seam query
itself.

**What the daemon needs on the placement row** so it never queries at fire time: the incoming song's
`post_ms` and the cut's audible end. Both are known at Generate. Writing them onto
`generated_schedule` keeps fire time a comparison against a deck position and nothing else.

---

## 3 · The outro — and why it does not need a second mark

### First, the measurement: `outro_start` cannot mean what you want

`outro_start` is **where trailing silence begins** (`native/src/audio_engine.rs:826-843`). On songs:

- **3 of 444 have it at all**, and in **all three it equals the duration** — average tail 0.01 s.
- Songs are mastered to the last sample. There is no trailing silence to find, so the column is empty
  of meaning on music.

**It cannot express "the instrumental tail after the last vocal."** That would be a new song-side
mark — the mirror of `post_ms` — and it does not exist in any column today.

### But the constraint you want is already delivered, by a constant

Under this model the cut fires at `P = post − cue_out`, where `P` is the **incoming** song's position.
Since selection guarantees `cue_out <= post`, the fire point is at or after `P = 0` — **the cut lies
inside the incoming song's intro and never reaches back over the outgoing song.**

The one exposure is `segueOverlap`: the incoming starts while the outgoing still has `segueOverlap`
seconds to run. A cut firing at `P = 0` overlaps those last seconds.

**So the choice is one comparison, not a marking pass:**

| test | behaviour |
|---|---|
| `cue_out <= post` | The cut may overlap the outgoing song's final `segueOverlap` seconds. |
| **`cue_out <= post − segueOverlap`** | The cut fires at `P >= segueOverlap`, strictly after the outgoing has ended. **It cannot talk over the end of a song, ever, and no outro mark is needed.** |

**Recommended: the second.** It buys the whole guarantee for the price of one term, using a number
that is already a station setting the operator owns.

**What it costs:** headroom. With `segueOverlap = 3`, a 5 s intro admits cuts up to 2 s — on the test
library that is 11 of 64. **On a library of thousands this is not a constraint**, which is exactly why
your first correction matters: the tight-library worry and the outro worry are the same worry, and
scale answers both.

### When an outro mark WOULD earn its place

Not as a safety rule — as a **deliberate mode**: imaging that rides the instrumental tail of the
outgoing song, talking up to its last vocal, the mirror of AUTO-POST. That wants a real mark, and it
would cost:

- a new column, mirroring the post trio, with the same `_source` / `_confirmed_at` honesty
- **a second mark per song** — doubling the song-side marking pass, which is the only work that scales
- a second trigger arm reading the **outgoing** deck's remaining time — the two-sided trigger that this
  whole model just deleted

**My recommendation: design the column name now, build nothing.** If `end_post_ms` is going to exist,
it should be named before `post_ms` ships anywhere near a peer, so the pair reads as a pair. Building
it is a slice of its own and should wait until you have heard AUTO-POST on air and decided you want the
other end too.

---

## 4 · What I would change in what has shipped

| | |
|---|---|
| **RACK query** | drop the correlated `group_concat`; two flat queries joined in JS |
| **RACK list** | page or window it; the songs list already limits, the imaging list does not |
| **POOLS** | invert at scale — pool first, then search-and-add, not a checkbox per cut |
| **Songs mode** | same de-correlation as RACK before the library grows |
| **The editor** | two handles on a cut writing `cue_in`/`cue_out`, opening on `intro_end`/`outro_start`; one marker on a song writing `post_ms`. Unchanged from the last proposal. |
| **`dry_ms`** | stop offering it. Columns stay — removing them costs a migration to undo a migration. |

None of this is built. The scale fixes are cheap and worth doing before the library grows, not after.

## 5 · What this document does not claim

The 5,000-cut library was **synthetic** — 4,936 rows cloned from the 64 real cuts, so file diversity,
title distribution and pool spread are artificial; the query timings are real, the data is not. RACK's
**songs** mode was not separately timed. The fire arithmetic in §3 is designed, not measured — no
placement has been made under it. Whether `segueOverlap` is the right amount of headroom is Jeff's
call and depends on his own setting.
