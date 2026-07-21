# Open Format pre-flip — why its §2.7 anchor is gappy (read-only diagnosis, 2026-07-21)

Follow-up (2) from the Phase 3 shadow (v4.4.75). The shadow proof showed OF reaching back to a stale
row while halloVeen + Magical Forest anchored cleanly. Question: does OF need a Generate run (+ ~60
real-min density check), or is its generation genuinely thinner than stations 2/3?

## Answer: NEITHER. It's a category-definition mismatch rooted in a thin/skewed library.

Diagnosis is entirely read-only (`scripts/diag-of-schedule-density.js`, `diag-of-filter.js`,
`diag-of-cat1.js` — gitignored, re-runnable; WAL concurrent read, no writes).

### 1. OF is fully generated — NOT sparse, NOT thinner
Today's `generated_schedule`, per station:

| Station | rows/day | coverage | real-min/hour |
|---|---|---|---|
| Open Format | 375 | 00:00 → 11:54 PM (all 24h) | **~62** |
| halloVeen | 942 (470 music + 472 JIN) | all 24h | ~62 |
| Magical Forest | 482 | all 24h | ~61 |

OF has a row in every hour to end-of-day, ~16 music rows/hour, ~62 real audio-min/hour — dead-on the
~60 target and on par with 2/3. **It does not need a Generate run, and its density is not thinner.**

### 2. The real cause — 52% of OF's schedule is category 1, which is OFF-format
OF today by the song's live category: **cat 1 = 194 rows (52%)**, cat 5 = 133, cat 3 = 24, cat 2 = 24.

But OF's **on-format set is the active clock's music-slot categories** (`getFormatCategoryIds`,
`loggen.js:84`) = **`[2,3,4,5,8]`** (clock 1 "Open Format" [ACTIVE]). **Category 1 ("OF — Open Format",
the catch-all) is not a clock music slot.** So the daemon's on-format read-guard
(`readGeneratedSchedule` / `selectRowForNow`, filtering `s.category_id IN (2,3,4,5,8)`) **drops all 194
cat-1 rows.** In the ±2h window around 2 PM that left stretches (1:22–2:49 PM) with *no* on-format
pending row — so the time-anchored selector reached back to the last on-format row it could see (10 AM).
(`gs.category_id` and `s.category_id` match exactly — this is not a re-categorization drift; cat 1 is
simply off the clock.)

### 3. Root beneath that — OF's library is thin and skewed to the catch-all
Install library by category: cat 7 (HalloVeen) 172 · cat 6 (Christmas) 76 · **NULL (uncategorized) 69**
· cat 5 (Feel Good) 37 · **cat 1 (Open Format) 37** · cat 3 (80s) 36 · cat 4 (2ks) 24 · cat 2 (90s) 13
· cat 8 (Hits) 9 · cat 9 (70s) 7.

OF's on-format buckets `[2,3,4,5,8]` hold **~119 songs total (cat 2/90s just 13)** — too thin to fill a
24-hour clock under separation, so the schedule leans hard on the broad cat-1 "Open Format" catch-all
(and there are 69 uncategorized songs the format ignores). Stations 2/3 are **single-category formats**
(`[7]` = 172 songs, `[6]` = 76) whose *entire* library matches the clock → **zero rows dropped → clean
anchoring.** That is exactly why 2/3 anchor and OF doesn't.

## What OF needs before the flip (content/config, not code)
1. **Reconcile the format definition with the content:** either add category 1 ("Open Format") to OF's
   clock as a music slot (if the catch-all IS intended OF programming — the format is literally named
   "Open Format"), so the on-format guard accepts those 194 rows; and/or
2. **Categorize OF's library:** 69 songs are uncategorized (NULL) and the decade buckets are thin —
   sorting songs into the categories the clock actually asks for gives Generate real on-format content
   instead of catch-all fallback.
3. This is the same problem-child station as the R2/library-materialization arc
   [[project_library_r2_materialization]] — its library is the weak link, not the scheduler.

**Implication for the flip:** the time-anchored reader is correct; OF's data isn't ready. halloVeen +
Magical Forest are flip-ready today; OF needs the category reconciliation first (or the emergency
floor / auto-fitter must cover its off-format gaps). The shadow burn-in will keep measuring this.
