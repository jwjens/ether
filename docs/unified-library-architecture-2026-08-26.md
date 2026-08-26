# The unified library — one store, every asset typed (design, 2026-08-26)

**Status: DESIGN ONLY. NOTHING BUILT. Jeff rules.**

Jeff specified this model from the start and it got built as separate subsystems instead. This is the
north star that the sweeper redesign, the spots fix and the log-reader flip each serve — one coherent
target rather than three scattered tasks.

**The model (Zetta's asset-type model):** ONE library. Every asset carries a **TYPE**. The type drives
scheduling and playout behaviour. The section tabs — SPOTS, SWEEPERS — become **filtered views of the
one library**, not separate stores.

---

## 0. A naming defect, first, because it is load-bearing

**They are SWEEPERS. They have always been sweepers.** "Jingle" is the wrong word and it is currently
spelled into a table name (`jingle_categories`), a content class (`JIN`), a panel (`JinglesPanel`), a
bottom-bar button (JINGLES), an engine subsystem (`_jingleTick`, `_jingleCartGen`, `_emitJingle`) and
a help doc (`help-jingles.md`).

This is not cosmetic. A wrong name in a schema is a wrong name in every query, every log line and
every conversation for as long as it stands, and it is already causing the operator to look for
"sweepers" in a panel called "Jingles". The rename is part of this convergence, not a follow-up to it.

`JIN` → `SWP` is the class rename. The tab becomes **SWEEPERS**.

---

## 1. Where we are — measured, not assumed

Read off the live install (station profile `ETH-STN-BAA8-E056-6FC8`) on 2026-08-26.

| Asset | Stored in | Scope | Scheduled by | Plays on |
|---|---|---|---|---|
| **Song** | `songs`, `content_class='MUSIC'` (444) | INSTALL | clocks → `loggen` → `generated_schedule` → queue | rotation decks A/B/C |
| **Sweeper** | `songs`, `content_class='JIN'` (64) | INSTALL | `jingle_categories` cadence, armed at the SEAM | **CART overlay bus** |
| **Spot** | **`spots`, a SEPARATE TABLE** (3) | STATION | `clock_breaks` → `loggen` materialises rows | rotation decks A/B/C |
| **Spot (also)** | `songs`, `content_class='SPOT'` (2) | INSTALL | — | — |
| **Announcement** | `announcements` (5) | STATION | `announcement_schedule` (30) → main's 250 ms tick | Announcement **source channel** |

### 1a. What is already RIGHT

**Sweepers are library assets, and that was the correct call.** Migration v29 states it as a decision:
*"Jingles live in the UNIFIED songs table as content_class='JIN' — no parallel jingle table
(decision)."* Storage got this right. Only the name and the playout path are wrong.

**`generated_schedule` already carries `content_class`,** and the log-reader already excludes by class
(`NOT IN ('JIN','SWP')`). The typed-log machinery exists.

**`jingle_categories` already has a `type TEXT DEFAULT 'JIN'` column.** A JIN/SWP discriminator was
already added there — a half-step toward this design that nothing has finished.

**The library UI can already type an asset.** `App.tsx:5595-5599` offers *Mark as Jingle (JIN)*,
*Mark as Sweeper (SWP)*, *Mark as Spot (SPOT)*. The typing gesture exists; the consequences do not.

### 1b. What is WRONG

**(i) The separate `spots` table — and the stores already disagree.**
Three live spot rows. **One** has a matching `songs` row classed SPOT; **two** do not. Meanwhile
`songs` holds **2** rows classed SPOT. Neither store is authoritative and neither is complete. This is
not a theoretical duplication — it is already inconsistent on a real machine.

**(ii) It broke the play-log classifier, silently, for months.**
`logPlay` derives a class by asking `songs` first, then `spots`. The `songs` query carried
`AND station_id = ?` — a column `songs` LOST when it went install-scoped — so it threw, the catch
swallowed it, the spots branch was never reached, and **every commercial ever aired was logged as
MUSIC**. Measured: 35,826 MUSIC / 14,073 JIN / 7 ANN / **0 SPOT**. Fixed forward in `e56f70a`, but the
fix is a patch on a two-store lookup that should never have needed two stores. **One store, one
lookup, and the bug class disappears.**

**(iii) Sweepers play on the CART overlay bus, not as scheduled elements.**
`_jingleTick` arms a sweeper against a generation token at the seam and fires it over the master bus
(`engine.js:151-160, 521`). It is an overlay, not a log element: it does not appear in
`generated_schedule`, the operator cannot see it coming in the queue, and it cannot be moved, skipped
or reported on as a row. RCS/Zetta treat it as a scheduled element on a real deck.

**(iv) Two scopes for what is one concept.** `songs` is install-scoped; `spots` and `announcements`
are station-scoped. An asset that is "the same file" is simultaneously shared and not shared.

**(v) `songs_all` is ABSENT on this install.** The delete-foundation work that makes `songs` a live
VIEW over `songs_all` is local/uncommitted and has never landed here. Anything that reshapes `songs`
has to be sequenced against it or they will collide.

---

## 2. The target

```
library_asset            ← ONE store. Every asset. Every type.
  id, uuid, type, title, file_path, file_key, duration_ms, …
  type ∈ { SONG, SPOT, SWEEPER, ANNOUNCEMENT }
```

**TYPE DRIVES BEHAVIOUR.** Not a badge — a dispatch key. One table says what each type does:

| Type | Eligible for | Scheduled by | Plays on | Separation | Logged as |
|---|---|---|---|---|---|
| `SONG` | music rotation | clocks / rotation | deck A/B/C | artist + title + file | `MUSIC` |
| `SPOT` | traffic breaks | `clock_breaks`, per-break count | deck A/B/C | max-plays/day, date window | `SPOT` |
| `SWEEPER` | seam / positional | cadence, or a log element | deck (see §4) | own cadence | `SWP` |
| `ANNOUNCEMENT` | date-keyed schedule | `announcement_schedule` | Announcement source channel | none (board is the gate) | `ANN` |

**The tabs become views.** SPOTS = `library WHERE type='SPOT'`. SWEEPERS = `type='SWEEPER'`. The
Library = all of it, filterable — exactly the element filter that already exists in the Play Log now.
No tab owns a store.

**Type-specific metadata does NOT go in the shared row.** A spot's `advertiser`, `isci_code`,
`cart_number`, `agency`, `max_plays_day`, `start_date`/`end_date` are real traffic fields and must not
be lost. They belong in a **side table keyed by asset uuid** (`asset_spot_meta`), joined only by the
paths that need them. One shared identity, per-type detail alongside. This is the single most
important structural decision in the whole design: unify IDENTITY, not every column.

---

## 3. What each in-flight arc contributes

| Arc | Contribution | Status |
|---|---|---|
| **v29 content_class** | Established that a class lives on the asset, and that jingles are library assets | shipped, correct |
| **Announcement arc (v45-v49)** | Asset-vs-schedule split; `ANN` as a real class; typed/coloured log surfaces with a user filter | shipped today |
| **Spots fix (`e56f70a`)** | Stops the bleeding; proves the two-store lookup is the root cause | shipped today |
| **Sweeper redesign** | The rename and the move off the CART bus | designed, not built |
| **Log-reader flip** | Makes `generated_schedule` the single playout source, so a typed row IS the schedule | Phases 0-2 shipped, flag off |

**The announcement arc already proved the pattern.** An announcement is an ASSET (`announcements`) and
its schedule is separate rows (`announcement_schedule`). That is exactly the asset/schedule split this
design generalises. The work is done once, in miniature.

---

## 4. The convergence order — nothing off air at any step

Each step is independently shippable, independently verifiable, and reversible. **No step changes
what airs on the step it lands.**

### Step 1 — TYPE becomes real, alongside `content_class`
Add `type` to `songs` as a NOT NULL column derived from `content_class` (`MUSIC→SONG`, `JIN→SWEEPER`,
`SPOT→SPOT`). **Both columns exist and agree.** Nothing reads `type` yet.
*Risk: none. Additive.* Numbered transformer.

### Step 2 — the RENAME: JIN → SWP, Jingles → Sweepers
Class value, `jingle_categories.type`, the panel, the tab, the engine identifiers, the help doc. A
transformer rewrites the stored class; the log-reader's exclusion list already knows `SWP`.
*Risk: low, but it touches every sweeper query — the one to smoke hardest.*
**Do this BEFORE moving spots.** Renaming inside one store is far cheaper than renaming during a
migration between stores.

### Step 3 — SPOTS move into the library
Every live `spots` row becomes a library row with `type='SPOT'`, plus an `asset_spot_meta` row holding
the traffic fields. **The `spots` table stays, read-only, for one release** — the log generator and
Spots panel keep reading it until Step 4 flips them. Reconcile the existing overlap explicitly: the
2 songs-SPOT rows and the 3 spots rows are matched by `file_path`, and anything ambiguous is reported,
never silently merged.
*Risk: medium. This is the step that needs a real smoke and a dry-run report before it writes.*

### Step 4 — readers flip to the library
`loggen`'s spot materialisation, the Spots panel, `clock_breaks`, and `logPlay`'s classifier read the
library instead of `spots`. **`logPlay`'s two-store lookup collapses to one** and the bug class from
§1b(ii) becomes unrepresentable.
*Risk: medium. Behaviour-preserving by construction — same rows, one source.*

### Step 5 — `spots` is dropped
Only after a release of Step 4 running clean. Same shape as v49's `date_closing_times` removal: drop
the table, delete its orphaned sync-journal rows, remove the registry entry and handler.

### Step 6 — SWEEPERS become scheduled elements
The one that changes what airs, so it goes **last and behind a per-station flag**, exactly like the
log-reader flip's canary. Sweepers stop being a CART overlay and become rows in `generated_schedule`
on real decks. This depends on the flip's Phase 3 — a typed row is only "the schedule" once the
log-reader is the playout source.
*Risk: HIGH. It moves audio. Flag, canary, one station, burn-in.*

### Step 7 — ANNOUNCEMENTS join the library
Optional, and deliberately last. `announcements` already has the right asset/schedule shape; folding
it in is tidiness, not a fix. It buys one library and one filter across every element — which is the
whole point — but nothing is broken until it happens.

---

## 5. What this design deliberately does NOT do

- **It does not merge schedules.** Four scheduling mechanisms stay distinct because they *are*
  distinct: rotation, traffic breaks, cadence, and a date-keyed list. One library, several schedulers.
- **It does not flatten type metadata** into one wide table. Identity unifies; detail stays beside.
- **It does not touch the ducker, the fire path, or the 250 ms announcement tick.**
- **It does not require the log-reader flip** for Steps 1-5. Only Step 6 does.

---

## 6. Open questions — Jeff rules before anything is built

1. **New table or grow `songs`?** Growing `songs` (add `type`, rename in place) is far less disruptive
   than a new `library_asset` table and a mass move — but it keeps a table called "songs" holding
   spots and sweepers, which is its own naming defect and would need a rename of its own eventually.
   **My recommendation: grow `songs`, and rename the table itself in a later, separate step.**
2. **Install scope vs station scope.** `songs` is install-scoped; `spots` and `announcements` are
   station-scoped. Unifying forces a choice. **My recommendation: the ASSET is install-scoped (it is a
   file), and anything station-specific lives in the side table or the schedule.** This needs your
   ruling because it changes what "my station's spots" means.
3. **Step 6's blast radius.** Moving sweepers off the CART bus is the only step that changes audio.
   Confirm it stays behind a canary and lands after the flip's Phase 3.
4. **Does `songs_all` land first?** The delete-foundation VIEW work is local/uncommitted and absent
   here. It reshapes the same table. **One of the two goes first, deliberately** — they must not be
   interleaved.
5. **Scale of Step 3 on a real machine.** 510 library rows and 3 spots here; OV will differ. The
   dry-run report comes before the write.

---

## 7. The one-line summary

**Everything that can air is one asset with a type; the type says what it does; the panels are
filters.** Storage was already right for sweepers, wrong for spots, and the wrongness has cost one
silent months-long logging defect — which is the argument for converging rather than patching again.
