# Diagnosis — "The Munsters Theme" back-to-back repeat on *Christmas In July* (2026-07-26)

**Branch:** log-reader-flip · **Method:** read-only, against a copy of the live DB
(`scratchpad/diag.db`, copied with WAL+SHM). Live `openair.db` never touched.
**Reproducer scripts:** `scripts/diag-munsters-{1..4}.js` (read-only, one-shot).

---

## TL;DR (root, with receipts)

**Playout eligibility is not station-scoped.** A MUSIC song is admitted to a
station's air by *category membership* (or by a NULL-category escape), never by a
check that the category actually belongs to the airing station. Two consequences
put "The Munsters Theme" on *Christmas In July*:

1. **The dominant cause — a NULL-category ORPHAN aired from the schedule.**
   There are two "Munsters Theme" library rows: `song_id=364` (legitimate —
   halloVeen, category HV, artist "Munsters Theme") and **`song_id=397` — an
   ORPHAN: `category_id = NULL` → belongs to no category → no station** (artist
   "Los Straitjackets", file `_The Munsters_ Theme_spotdown.org.mp3`). The orphan
   sits in **station 4's `generated_schedule` 84 times at a 2-minute minimum gap
   (83 of 84 gaps violate the 180-min song separation)**, 2026-07-24 22:00 →
   2026-07-25 01:58 (gsid 119324–119330 etc.). The daemon airs
   `generated_schedule` verbatim (Tier 0) and its format gate is
   `AND (s.category_id IS NULL OR s.category_id IN (fmt))` — **the `IS NULL` arm
   lets an orphan pass EVERY station's format filter** (`audiod/loggen.js:155`,
   also 175, 209, 252). So an orphan that belongs nowhere airs on Christmas, and
   because separation keys off the song's unique `file_path`/`song_id`, nothing
   suppresses the every-2-minute repeat.

2. **Secondary — the fill ladder's account-wide fallback.** Before the schedule
   began (22:00), station 4 also aired `Wonderwall` (cat 1 / Open Format) and
   `Bad Moon Rising` (cat 7 / halloVeen) at 20:19–20:20 (`play_log`, station_id=4).
   Those songs are **not** in station 4's schedule (see receipt below) — they came
   from `loggen.fillQueue`'s relaxation ladder, which on an empty/thin in-format
   pool falls back to `pickTier(..., formatCats=[], ...)` = **all active songs, any
   category, any station, separation off** (`audiod/loggen.js:362-364`, Tier 3b).

**The "SEPARATION 172–175M EARLY" chip is warn-only and correct.** It is the
Slice-C lint (`electron/library-health.js:140 lintUpcoming` → `UpNext.tsx:573`),
computed from `generated_schedule` vs `play_log` by `file_path`. 180-min rule −
~5–8 min actual gap ≈ 172–175 min early. **It flags but does not enforce** — there
is no separation gate in the playout path, so the daemon airs what the lint warns
about.

**Not the log-reader flip.** The flip flag is OFF (shadow-compare confirms,
`UpNext.tsx:134-174`); this is the legacy Tier-0 `generated_schedule` reader, which
runs regardless of the flag.

**Status: the acute event is entirely in the past (7/24–25).** Zero future
pending orphan-MUSIC rows are queued on any station; station 4's current schedule
is clean CS variety. The **leak is latent**, not actively firing.

---

## Receipts

- **Station:** id=4 "Christmas In July", the only active station (is_active=1).
  One category: id=14 CS "Summer Christmas", **46 songs, all local, all playable,
  none inactive, none non-MUSIC, no duplicates, no Munsters.**
  (`diag-munsters-1.js`)
- **Clock 4:** 23 music slots, every one category 14/CS, station 4.
  `getFormatCategoryIds(4,4) = [14]` — clock is correct. (`diag-munsters-3.js`)
- **Two Munsters rows:** `364` cat=7 (station 2) artist "Munsters Theme";
  **`397` category_id=NULL (station NULL)** artist "Los Straitjackets". Different
  files, different artists — a near-duplicate import, not an exact dupe.
  (`diag-munsters-2.js`, `diag-munsters-4.js`)
- **Orphan #397 in station 4's schedule:** 84 rows, minGap **2 min**, 83 gaps
  under the 180-min separation window, span 07-24 22:00 → 07-25 01:58.
  (`diag-munsters-4.js`)
- **What actually aired on station 4** (`play_log`, station_id=4): orphan #397 at
  21:02, 21:05, 21:07 (7/24) + 01:09 (7/25); plus `Wonderwall` (cat 1) and
  `Bad Moon Rising` (cat 7) at 20:19–20:20. (`diag-munsters-2/3.js`)
- **Schedule composition, station 4:** 8,381 rows owned by station 4 (correct) +
  **84 orphan rows** + 0 rows owned by other stations. So the Munsters repeat is
  the schedule/reader path; the cross-station plays are the ladder path.
  (`diag6`)
- **Systemic:** **74 orphan songs** (category_id=NULL, not deleted) exist
  account-wide; several are MUSIC (#29 Daydream Believer, #349, #397, #400, #401,
  #543). Orphans currently carry `generated_schedule` rows on non-owning stations
  (#397: 58 on st2, 84 on st4; the rest are mostly JIN overlays, which the daemon
  already excludes from music fill). (`diag-munsters-4.js`)
- **Generate itself is category-scoped** (`electron/main.js:5989`,
  `WHERE s.category_id = ?`) — so #397 was picked while it still had category 14,
  then orphaned afterward; the stale schedule rows survive only via the reader's
  NULL escape.

---

## Proposed fix — STOP for GO before any code or data change

One root ("eligibility not station-scoped"), so one correct change; presenting the
cut for your call.

### A. Minimal, stops the on-air repeat with NO data write (recommended first)
Tighten the daemon's four `generated_schedule` format gates so a song row that
**exists but is orphaned** is skipped, while a row whose song join is **absent**
(legacy/SPOT snapshot) still plays:

- `audiod/loggen.js` catClause: `(s.category_id IS NULL OR s.category_id IN (fmt))`
  → **`(s.id IS NULL OR s.category_id IN (fmt))`** (lines 155, 175, 209, 252).

Effect: the 84 orphan rows are skipped on air even though they sit in the schedule;
SPOT rows (`song_id NULL` → `s.id NULL`) still pass; jingles untouched (already
`content_class NOT IN ('JIN','SWP')`). Stops the Munsters repeat class immediately.

### B. Close the ladder's account-wide fallback (same root, second surface)
`loggen.fillQueue` Tier 1/Tier 3b must not fall back to *all songs, any station*
when a station's in-format pool is empty — it should stay within the station's
categories (and honest-fail to the emergency floor) rather than borrow another
station's library. This is the deeper station-scoping invariant; scope it
deliberately, don't just patch Tier 3b.

### C. Bounded data repair (Jeff-run, only after Ether + daemon fully closed)
The MUSIC orphans (esp. #397) are the "duplicate" you saw in library search.
Decide per song: reassign to the right category or soft-delete; then soft-delete
their stale pending `generated_schedule` rows. **Never write the live DB while
Ether is open** — this is a close-then-write step, not part of A/B.

### Deliberately NOT building now
- Full candidate-pool station-scoping via `stationUuid` (that's the peer-sync
  UUID-identity track) — beyond this fix.
- Turning the separation lint into a hard playout blocker — it stays advisory.
- Auto-dedup / auto-category-assign on import.

**Recommendation:** ship **A** as the one fix (defensive, no data write, kills the
class), file **B** and **C** as sequenced follow-ups. Awaiting your GO.

---

## Implementation status (GO received — A + B shipped together; B = the Beach-Boys cause)

**A — orphan format gate (`audiod/loggen.js`).** All four log-reader gates changed
from `(s.category_id IS NULL OR …)` to `(s.id IS NULL OR s.category_id IN (fmt))`
(`readGeneratedSchedule`, `fillFromHour`, `selectRowForNow`, `readLogAnchored`).
A song row that exists but is orphaned (category NULL) is skipped; a row whose song
join is absent (legacy/SPOT snapshot) still airs.

**B — Tier-3b station scoping (`audiod/loggen.js` + `audiod/engine.js` + `electron/main.js`).**
Tier-3b's last-resort pool changed from `formatCats=[]` (whole account, any category,
any station) to the station's own categories via new helper
`getStationCategoryIds(db, stationId)`. If the station has no playable song in any of
its own categories, `fillQueue` returns `starved:true`; the daemon emits a throttled
(60s) `fill-starved` event which `main.js` appends to `health-events.jsonl` — loud,
never a silent foreign-song borrow. Separation stays relaxed at this absolute floor
(unchanged — the defect was cross-station borrowing, not the relax).

**Proof (read-only, DB copy):** `scripts/prove-orphan-gate-fix.js` — ALL PASS.
- A: OLD gate admitted **84** orphan (#397) rows on station 4 → NEW gate **0**;
  legit CS rows (8,381) still pass; no-song-join rows preserved.
- B: OLD Tier-3b pool = `st1=167 st2=179 st3=76 st4=46 + 9 orphan` (431 foreign) →
  NEW pool = `st4=46` only (0 foreign, 0 orphan).

**Gates:** `tsc --noEmit` = zero new errors (only the 2 known pre-existing in
OnboardingFlow.tsx / PhoneDesk.tsx); `node --check` clean on all three edited files.

**NOT changed (flagged for you):** the in-process TS twin `src/audio/loggen.ts:457`
carries the same old `s.category_id IS NULL` gate. The daemon is the authoritative
playout path; the twin only airs during the cold-stage in-process fallback window.
Mirror it in a follow-up if you want the fallback window covered too.

**C stays yours** (Ether + daemon fully closed): soft-delete/reassign the MUSIC
orphans (esp. #397) + their stale pending `generated_schedule` rows. Not part of A/B.

**Not committed, not version-bumped, not built, not installed** — awaiting your call
on the version bump + installer build.
