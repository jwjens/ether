# Rotation goals (`spins_per_hour`) vs "clock is law" — a blocking design conflict
**Date:** 2026-08-09 · **Status:** BLOCKED — needs Jeff's ruling. Nothing built, nothing changed.

---

## 1. The ask

Make the scheduler honour each category's `spins_per_hour`: track spins per category in the last 60 minutes, prefer categories below target, deprioritise those above, keep artist separation / dayparting / LRP intact. Named as the #1 bake-off loser against GSelector.

## 2. Premise: CONFIRMED

`spins_per_hour` is written by the UI (`Scheduler.tsx:423`), carried in the sync schema (`electron/sync/handlers/categories.js:17`, `synced-tables.js:141`), and defined `INTEGER DEFAULT 1` (`scripts/verify-main-schema.js:85`).

**It is read by nothing in any scheduling path.** Zero references in `_generateDayRows`, `audiod/loggen.js`, or `src/audio/loggen.ts`. Verified by exhaustive grep across `src`, `electron`, `audiod`, `native/src`, `scripts`.

## 3. Correction to the task's file list

The task named `audiod/loggen.js` / `loggen.ts` as the place to fix. Those are the wrong layer:

- `audiod/loggen.js` is a **log-reader**. Its header: *"Tier 0: pre-generated log (generated_schedule), in order."* `:417`: *"The daemon is a LOG-READER (D1=A′)."* It reads `generated_schedule`; it never writes it. Its `fillQueue` ladder is the emergency path for an exhausted or off-log station.
- The real generator is **`_generateDayRows`** (`electron/main.js:6759`, ~272 lines), chunked by `_generateDayChunked` (`:7031`), entered via `schedule:generateDay` (`:7103`) / `schedule:generateDays` (`:7062`). It WRITES `generated_schedule`.
- Under the Log-Reader Flip, `generated_schedule` is the single playout source. A change made only in the fill ladder would be invisible in normal operation and would fight the flip.

## 4. THE BLOCKER — there is nowhere for a rotation goal to act

Every music slot the generator fills already carries exactly one category, fixed by the clock:

| Receipt | What it shows |
|---|---|
| `main.js:6956` | `if (slot.slot_type !== 'music' \|\| !slot.category_id) { currentTs += slotDurationS; continue; }` — a music slot without a category is **skipped entirely** |
| `main.js:6787` | `slots.filter(s => s.slot_type === 'music' && s.category_id)` |
| `main.js:7293` | `WHERE cs.slot_type='music' AND cs.category_id IS NOT NULL …` |
| `loggen.js:106 / 108 / 162 / 471` | every clock query requires `category_id IS NOT NULL` |

There is **no auto-fill, unassigned, or multi-category music slot anywhere in the schema or the code.** The category is decided by the clock *before* any song is chosen. "Prefer the under-rotated category" therefore has no decision to influence — unless it picks a category the slot did not name.

### Which is a documented violation

`docs/generate-clock-law-deleted-slots-2026-07-21.md` (v4.4.76), Jeff's ruling:

> **"the clock is law; Generate is the violator."** Fix Generate to fill the clock's slots from the clock's categories — **never import off-clock songs.**

> `:24-25` — "not a designed fallback and not the `_lrpFallback` ladder (both of which already **work strictly within `slot.category_id`**)"

> `:35-36` — "The already-correct behavior (relax separation *within* the category; **never off-clock**) is unchanged"

And the failure mode is recorded: off-clock rows carry a `category_id` the daemon's on-format guard `getFormatCategoryIds` (`loggen.js:87-91`) does not recognise, so **the daemon drops them** — that was the §2.7 shadow gap, and 52% of OF's schedule.

## 5. Why the field is orphaned — the real diagnosis

This is not an oversight. It is an architectural mismatch.

> **The clock already IS the rotation goal, expressed positionally.** Want Gold 4×/hour? Put 4 Gold slots in the clock.

- **GSelector is goal-driven:** you set targets; the engine composes the log to meet them. Clocks are soft templates.
- **Ether is clock-driven:** you place slots; the engine fills them. The clock is law.

`spins_per_hour` is a GSelector-shaped field sitting in a Zetta-shaped architecture. Implementing it as specified would install a *second authority* over the same decision, and under the current ruling the clock must win — so the goal would be inert by design, or the ruling breaks.

## 6. The delegate's recommendation — REJECTED

A delegated design pass (DeepSeek, deep-read of the generator + all governing docs) chose **option (c), goals may override the slot's category**, on the reasoning that the clock-law doc *"does not forbid re-ordering or overriding the category — its focus is on not walking deleted slots."*

That is a misreading. The deleted slots were the *mechanism* of the leak; the *ruling* is the principle quoted in §4. The doc explicitly calls "never off-clock" the already-correct behaviour and states both fallback ladders work strictly within `slot.category_id`. Building (c) would reintroduce precisely the defect v4.4.76 fixed.

Two further problems in that design, recorded so they are not re-proposed:
- It proposes `ALTER TABLE generated_schedule ADD COLUMN selection_reason`. The clock-law doc `:42-44` **defers** the `source`/`relaxed` column deliberately, to join the flip's operator-insert work as *"one schema change, not two."* A separate ALTER contradicts that.
- Its scoring uses raw `deficit = target − placed` and dismisses normalisation as unnecessary, so a category with target 8 / placed 2 (deficit 6) always beats target 2 / placed 0 (deficit 2), even though the second is 100% starved and the first is 75% served. The brief asked for exactly this to be handled.

**Salvageable from it:** §A, its read of what `_generateDayRows` actually does (candidate order is `ORDER BY RANDOM()`; separation maps `songLastTs`/`artistLastTs`/`titleLastTs` seed from `songs.last_played_at`, not `play_log`; `_lrpFallback` is Tier-2/3). That matches spot checks and is reusable whichever option is chosen.

## 7. Options

### A — Make `spins_per_hour` an advisor (RECOMMENDED interim)
Generate compares each clock's slot composition against category targets and reports mismatches: *"Gold target 4/hr; this clock has 2 slots — under by 2."* Surfaced in the Health Monitor beside the existing Rotation-depth sense (`library-health.js depthCheck` already computes the sibling fact: "Feel Good: 37 songs for ~10 slots/hr").
- **Respects clock law completely** — changes nothing about what airs.
- Makes the orphaned field mean something, and tells the PD the one thing they actually need: *your clock does not match your intent.*
- ~1 day. No migration.

### B — Goals as tiebreak in the off-log fallback only
In `loggen.js` Tier 2/3 there is genuinely no slot category — it picks from the on-format set (`getFormatCategoryIds`). Goals could legitimately break ties **there** without touching clock law.
- Honest, but that path is the emergency ladder — rare now, rarer after the flip. Near-invisible in normal operation.
- Low value alone; reasonable as an add-on to A.

### C — Build a genuinely goal-driven scheduler
Real GSelector parity: targets drive composition, clocks become templates rather than law.
- This is what actually closes the bake-off gap.
- It **reverses "clock is law"** and so requires an explicit ruling, its own design doc, and a migration that should ride the flip's `source`/`relaxed` column per `:42-44`.
- Weeks, not days.

**A and C are not exclusive.** A is the honest interim, and the telemetry it produces (target vs actual composition per clock) is exactly the input C needs.

## 8. What I need from Jeff

One ruling: **may a rotation goal ever cause Generate to fill a slot from a category the clock did not name?**

- **No** → build A (+ optionally B). The clock stays law; `spins_per_hour` becomes an advisor.
- **Yes** → that reverses the v4.4.76 ruling. It needs a design doc, and the on-format guard `getFormatCategoryIds` must be revisited in the same change or the daemon will silently drop the rows.

Until that is answered, building either way risks shipping a change to what goes on air that contradicts a standing ruling.

## 9. Compliance note

Nothing was built. No files changed. This document exists because the implementation as specified would contradict a binding design doc, and the standing rule is to surface the conflict rather than build over it.
