# Goal-Driven Scheduler — architecture analysis and redesign
**Date:** 2026-08-10 · **Status:** DESIGN APPROVED 2026-08-10 — all five decisions resolved (§6). No code written yet.
**Decision:** Jeff has chosen Option C (full goal-driven rewrite). This document is the analysis and design that precedes it.
**Supersedes (in part):** the v4.4.76 "clock is law" ruling — bounded reversal **GRANTED**, see §6.1. The original ruling still stands for deleted slots and undeclared categories.

---

## 0. The finding that reframes this project

The expected story was "Ether is clock-driven; GSelector is goal-driven; closing the gap is a rewrite."

The actual story, from the schema:

| Field | Purpose | Status |
|---|---|---|
| `categories.spins_per_hour` | rotation goal | **stored, synced, UI-editable — read by nothing** |
| `categories.priority` | category weighting | **stored, synced — read by nothing** |
| `separation_rules.is_hard` | breakable vs unbreakable | **stored, synced, editable in `RulesEditor.tsx` — read by nothing** |
| `separation_rules.scope` | per-category/global rule scope | **stored — read by nothing** |
| `separation_rules.rule_type` | arbitrary rule kinds | only 3 of N types read (`main.js:6559-6564`) |
| `songs.energy / bpm / mood / gender` | selection attributes | stored; used only by the localStorage SmartScheduler, never by the generator |
| `songs.daypart_mask` | dayparting | **read and enforced** ✅ |
| `generated_schedule.seq` | fractional reorder key | present, entirely unused |

**Ether already has a goal-driven data model. It has a clock-driven engine bolted on top of it.**

The gap is not schema. It is ~270 lines in `_generateDayRows` that bind each music position to exactly one category and then never reconsider. That is a far smaller and better-defined problem than "rewrite the scheduler," and it is why this is weeks rather than months.

---

## 1. Step 1 — Architecture comparison

### 1.1 How does the scheduler decide what plays next?

**Clock-driven (current).** The hour's clock is walked position by position (`main.js:6956`). Each music slot names one `category_id`. The generator queries candidates in that category for that hour (`stmtCandidates`, ordered `RANDOM()`), takes the first that passes song/artist/title separation, and falls back to `_lrpFallback` within the same category if none passes. The category is decided before any song is considered, and never revisited.

**Goal-driven (GSelector).** The clock supplies the hour's *shape* — how many music positions, where the breaks are. Which category fills each music position is computed from the station's rotation goals and the current state of the log: which categories are behind pace, which are burning, which are legal here. Category and song are chosen together, by score.

The distinction in one line: **clock-driven asks "what belongs in this slot?"; goal-driven asks "what does the station need next?"**

### 1.2 How does a PD control rotation?

**Clock-driven.** Positionally. Want Gold four times an hour? Place four Gold slots. Rotation is expressed as *geometry*, and changing it means editing every affected clock. A format tweak across six dayparts is six clock edits, and the intent ("Gold should be ~15% of the hour") is nowhere written down — only its consequence is.

**Goal-driven.** Declaratively. Set Gold to 4 spins/hour. The engine meets it wherever the shape allows. Intent is stored as intent, and one edit propagates to every hour that uses those goals.

This is the difference PDs actually feel, and it is why `spins_per_hour` exists in the UI: **someone already designed the goal-driven interface.** The engine never caught up.

### 1.3 How does manual log editing work?

**Clock-driven.** Poorly, today — Generate deletes the whole future window and re-inserts (`main.js:7047-7053`), destroying edits. That is Fix 2, designed separately in `docs/manual-log-editing-design-2026-08-10.md`, and it is **independent of this rewrite**: it teaches Generate to respect operator-owned rows via the existing `source` column.

Conceptually clock-driven editing is simple: a slot has one legal category, so an edit is either compliant or a violation.

**Goal-driven.** Editing is richer and harder. Removing a Gold track doesn't just leave a hole — it moves Gold *behind pace*, so the next regeneration legitimately wants to place Gold sooner. The log becomes a **negotiation between operator intent and station goals**, which is exactly why explainability stops being a nicety (§1.4).

**Design consequence:** Fix 2 must ship first and must ship on the `source` marker. Under goal-driven, "this row is operator-owned" also has to mean "count it toward the goals but never move it" — otherwise the engine reshuffles around a pinned row and the PD sees their edit "fight back."

### 1.4 How is "why was this song picked" explained?

**Clock-driven.** Trivially, and uselessly: *"the clock said Gold at position 7."* True, and it tells the PD nothing they didn't already know. The interesting question — why *this* Gold track — is answered by `ORDER BY RANDOM()` plus a separation filter, and is **not recorded anywhere**.

**Goal-driven.** The explanation is the *product*: *"Gold was 1.8 spins behind pace at :34; of 42 eligible Gold tracks, 31 were vetoed by artist separation and 6 by daypart; this was the least-recently-played of the remaining 5, last aired 6 days ago."*

That sentence is only possible if the engine records its own reasoning as it works. Retro-fitting it is impossible — the losing candidates are gone. **This is why explainability cannot be Phase 4** (§4.5).

### 1.5 How hard is it to change rotation?

| Change | Clock-driven | Goal-driven |
|---|---|---|
| "Gold 4×/hr instead of 3" | Edit every clock using Gold, in every daypart | One field |
| "More energy in drive time" | Rebuild the drive clocks | Adjust daypart goals |
| "Rest this artist for a week" | Not expressible | A rule |
| "Why is this song burning?" | Manual log inspection | A report |
| Risk of a mistake | High — geometry edited by hand, silently wrong | Lower — intent is declared and validated |

---

## 2. Step 2 — The gap

### 2.1 What must be rewritten

| Component | Change | Size |
|---|---|---|
| `_generateDayRows` music-slot branch (`main.js:6956+`) | Stop binding a position to `slot.category_id`; ask the goal engine for (category, song) | ~80 lines replaced |
| **NEW** `electron/scheduler-core.js` | Pure selection engine — no DB, no clock, no wall clock | ~400 lines new |
| `getFormatCategoryIds` (`loggen.js:87-91`) | **Must widen** from "categories in this clock's slots" to "this station's active categories" — see §2.4 | ~10 lines, high risk |
| `loggen.pickFromClock` (`loggen.js:128`) | Daemon's clock-tier fallback makes the same slot-category assumption | ~20 lines |
| `_buildScheduleCtx` | Load goals, `priority`, `is_hard`, rule `scope` | ~40 lines |
| Goals UI | Later phase; `spins_per_hour` already has a field in `Scheduler.tsx:423` | deferred |

### 2.2 What is reused unchanged

This is the larger list, and it is why the project is tractable:

- **`separation-enforce.js`** — `buildRestMaps` / `pickEnforced` already implement LRP-under-separation from `play_log`. The core consumes these as a constraint provider.
- **`_lrpFallback`** — least-recently-played ordering, reusable as the final tiebreak.
- **`daypart_mask`** filtering — already correct, already enforced in every tier.
- **The candidate SQL** (`stmtCandidates`) — widens from one category to a set; the shape is unchanged.
- **Spot placement** (`_pickSpot`, `clock_breaks`) — **entirely untouched.** Spots are traffic, not rotation. Goals never apply to them.
- **Jingle placement** (`_placeJingles`) — untouched.
- **`_commitDayRows`, `_generateDayChunked`, progress events, cancel** — the generation harness is fine; only the picking changes.
- **`generated_schedule` schema** — no change needed for the engine itself (only for reasons, §5.3).
- **Health Monitor senses** — `noteGenerate`, `depthCheck` already surface relaxation and rotation depth; goals extend them rather than replacing them.

### 2.3 What is genuinely new

1. A **rotation-state model** — spins per category over a rolling window, at generation time.
2. A **scoring function** with pacing (§3.4).
3. A **decision record** per pick (§5.3).
4. A **mode flag** so both engines coexist (§3.6).

### 2.4 Risks — ranked

**R1 — the daemon silently drops goal-chosen rows. CRITICAL.**
`getFormatCategoryIds` (`loggen.js:87-91`) computes the on-format set from *the clock's slot categories* and the log-reader filters rows against it (`catClause` in the `SELECT`, `loggen.js:196-202`). A goal-driven generator will legitimately place a category that appears in no slot of that hour's clock — and the daemon will **drop it**. The log would look right in the calendar and never reach air.

This is not hypothetical: it is exactly the mechanism that produced the §2.7 shadow gap in v4.4.76, where 194 off-clock cat-1 rows were generated and silently dropped.

**Mitigation is non-negotiable and must land in the same change:** widen the guard to the station's active, non-deleted category set. Until then, goal-driven mode must not be enabled on any station. **AUTHORISED 2026-08-10 — see §6.2.**

**R2 — reversing "clock is law."**
`docs/generate-clock-law-deleted-slots-2026-07-21.md:3-4` records Jeff's ruling: *"the clock is law; Generate is the violator… never import off-clock songs."*

The bounded reversal proposed here:

> **The clock remains law for STRUCTURE. Goals govern CATEGORY CHOICE within music positions.**

The clock still decides how many music positions the hour has, where the spot breaks fall, where talk breaks go, and the duration of everything. What changes is only *which category fills a music position*.

This distinction matters because the original violation was **accidental** — Generate walked *soft-deleted* slots and imported a catch-all category nobody had asked for. A goal engine choosing among the station's *declared, active* categories is a deliberate, visible policy. Different mechanism, different intent, different failure mode.

**RESOLVED 2026-08-10 — ruling GRANTED. See §6.1 for the exact wording and its limits.**

**R3 — two schedulers.** The daemon's `fillQueue` ladder is a second selector. Under goal-driven it would diverge from the generator's intent. The scheduler-rework doc (`docs/scheduler-rework-status.md:43-51`) already argues the daemon should fall to a *dumb* emergency floor rather than a smart in-daemon selector. Goal-driven strengthens that: **the daemon must not become goal-aware.** Its ladder stays dumb; the log carries the intelligence.

**R4 — goal thrash.** Goals are per-hour, but songs are 3–4 minutes and hours have ~15 music positions. Naive full-hour deficit front-loads a behind-pace category into consecutive positions. Pacing (§3.4) is the mitigation, not an optimisation.

**R5 — thin libraries.** Goals a station's library cannot meet turn into permanent relaxation. Must be surfaced as a *sense*, not silently absorbed — `depthCheck` already computes the sibling fact ("Feel Good: 37 songs for ~10 slots/hr").

**R6 — the auto-fitter interaction.** The time-anchored playhead and auto-fitter (§2.7 of the flip design) assume the log's *timing*. Goal-driven changes *content*, not timing, so they should be unaffected — but this is **UNVERIFIED** and must be proven in shadow mode before activation.

---

## 3. Step 3 — Proposed architecture

### 3.1 The central idea: separate PLACEMENT from SELECTION

```
CLOCK  ──►  PLACEMENT   what kind of element, at what position, for how long
                        (music | spot break | talk break | jingle) — CLOCK IS LAW
                             │
                             ▼  for each MUSIC position
GOALS  ──►  SELECTION   which category, then which song
                        (goal pacing → constraints → LRP) — GOALS GOVERN
```

Today these are fused: naming a category on a slot decides both. Splitting them is the whole rewrite.

### 3.2 A pure core

New module `electron/scheduler-core.js`. **No database, no clock, no `Date.now()`, no I/O.** Deterministic given its inputs, therefore unit-testable in plain Node — which nothing in the current scheduler is.

```
pickNext({
  position,        // { index, hourStartTs, atTs, dayOfWeek, hourOfDay }
  pool,            // [{ songId, categoryId, artistId, title, lastPlayedTs, daypartMask, energy, bpm, … }]
  goals,           // Map<categoryId, { spinsPerHour, priority }>
  rotationState,   // Map<categoryId, { placedThisHour, placedRolling60 }>
  constraints,     // { artistSepMin, songRepeatMin, titleSepMin, hardFlags, lastSeen maps }
  policy,          // { mode: 'clock' | 'goal', restrictToCategory?: number }
}) → {
  songId, categoryId,
  reason: {                     // structured, not a prose string
    mode, chosenCategory,
    goal: { target, paced, placed, urgency },
    poolSize, vetoed: { artist: n, title: n, song: n, daypart: n },
    finalists: [{ songId, score, lastPlayedTs }],   // top few, for explainability
    relaxations: [ 'artist_separation' ],           // soft rules broken, and which
    tiebreak: 'lrp',
  }
}
```

### 3.3 Clock-driven becomes a special case

The single most valuable property of this design:

> **`policy.mode = 'clock'` is `mode = 'goal'` with the pool restricted to one category.**

One engine, two policies. Not a fork, not a parallel implementation, not "two schedulers." The migration becomes a **policy flag**, and clock-driven mode gets the same explainability and the same testability for free — which is worth having even if goal-driven is never enabled on a given station.

### 3.4 Scoring — pacing, not raw deficit

Raw deficit (`target − placed`) is wrong, for a reason worth stating because it has already been proposed once and rejected in this project: a category with target 8 / placed 2 (deficit 6, **25% served**) always beats target 2 / placed 0 (deficit 2, **0% served**), even though the second is completely starved.

Two corrections:

**Fractional, not absolute:**
```
served  = placed / max(target, 1)
urgency = 1 − served                    // 0% served → 1.0 ; at target → 0
```

**Paced against position in the hour** — a 4-spins/hour category should have ~2 placed by the half-hour, not 4:
```
elapsed = positionIndex / totalMusicPositionsThisHour
paced   = target × elapsed
urgency = (paced − placed) / max(target, 1)
```
This is R4's mitigation. Without it a behind-pace category front-loads into consecutive positions and the hour sounds lumpy — the classic naive-goal-scheduler failure.

**Category score:**
```
score = w_goal   × urgency
      + w_pri    × normalisedPriority        // categories.priority, currently orphaned
      − w_burn   × recentSpinPressure        // rolling-60 spins vs target
```

**Song score within the chosen category:**
```
score = w_rest   × restRatio                 // time since last play ÷ separation window
      + w_lrp    × lrpRank
      − w_soft   × softViolationPenalty      // is_hard = 0 rules
      (hard violations are VETOES, never penalties)
```

**Hard vs soft is `separation_rules.is_hard`** — the column that already exists, is already synced, is already editable in `RulesEditor.tsx`, and is read by nothing. Wiring it is most of "rule hierarchy with rule relief," a headline GSelector feature, and it is a *read*, not a migration.

Weights live in `scheduling_rules` (station-scoped, `rule_data` JSON) with sane defaults — tunable without a schema change.

### 3.5 Constraint order — vetoes before scores

```
1. daypart_mask                     VETO   (already enforced)
2. hard separation (is_hard = 1)    VETO
3. content-class / on-format         VETO
4. soft separation (is_hard = 0)    PENALTY, recorded as a relaxation
5. goal urgency                      SCORE  (category level)
6. rest ratio / LRP                  SCORE  (song level)
```
Relaxation is only ever reached when a stage would otherwise return empty, and **every relaxation is recorded on the row** — that is what makes "never dead air" honest instead of silent.

### 3.6 Coexistence

Per-station KV `scheduler_mode` = `clock` (default) | `shadow` | `goal`, mirroring the proven `enforce_separation` pattern (`main.js:6573`) and the log-reader flip's own staged rollout.

- **clock** — today's behaviour, bit-identical.
- **shadow** — generate both, write only the clock log, record the goal log's decisions and the divergence. This is how the flip was validated and it is the only responsible way to evaluate a scheduler that decides what a real station broadcasts.
- **goal** — goal log airs. Requires R1 fixed.

---

## 4. Step 4 — Phased plan

### Phase 1 — Advisor (days) — *ships without changing what airs*
Read `spins_per_hour` and `priority`; compare each clock's slot composition against its category targets; report the mismatch — *"Gold target 4/hr, this clock has 2 slots — under by 2."* Surface in the Health Monitor beside the existing Rotation-depth sense.

**Value beyond the quick win:** it is the first time the goals and the clocks are compared at all, and it will likely reveal that existing clocks disagree with existing goals on real stations — information needed before Phase 3 is designed against them.
**Risk:** none. Read-only.

> ### ✅ BUILT 2026-08-10 — and it found something that changes Phase 3
>
> **Not one category on any live station has a target set.** All four stations: `spins_per_hour` is `0`
> or `NULL` on every row, and `priority` likewise (`scripts/diag-goal-values.js`).
>
> The field is not merely unread by the engine — **it has never been populated by anyone.** So:
>
> 1. The mismatch report is correctly empty everywhere, which would have made this sense invisible on
>    exactly the installs that need it. A **no-goals branch** was added: it states the clock's observed
>    composition instead (*"Open Format is 73% Feel Good — 11 of 15 music slots"*), which is the number
>    a PD needs in order to declare a goal at all. It deliberately does **not** write that back as the
>    goal — inferring intent from geometry would invent a decision nobody made.
> 2. **Phase 3 has a hard precondition nobody had noticed: targets must exist before a goal-driven
>    engine has anything to aim at.** A goal-driven scheduler over an all-zero goal table would either
>    do nothing or treat every category as fully satisfied. Phase 3 planning must include how targets
>    get declared in the first place — most likely seeded from current clock composition as a
>    reviewable suggestion, never silently.
> 3. Open Format's clock is **73% one category** (Feel Good ×11 of 15). Whether that is intended is
>    Jeff's call, but it is the kind of fact this sense exists to surface.

### ~~Phase 2 — Tiebreak in the off-log fallback~~ — **SKIPPED** (ruling §6.5)
Goals as a tiebreak in `loggen.js` Tier 2/3. Cut: that path is the emergency ladder, it gets rarer after the flip, and the time is better spent on Phase 2.5. Recorded so it is not re-proposed.

### Phase 2.5 — Explainability — **moved earlier, see below** (1–2 weeks)
Build `scheduler-core.js` as a pure module. Run clock-driven mode *through it*. Record decisions on every row.
**Value:** clock-driven gets "why this song" today; the core gets exercised on the safe path before it makes a single independent decision.

> ### The one change I would make to the proposed plan
>
> The brief sequences explainability as **Phase 4**, after full goal-driven. That ordering should be reversed, for two reasons:
>
> 1. **You cannot evaluate a goal-driven log without it.** Shadow mode produces two candidate logs; deciding whether the goal log is *better* requires reading its reasoning. Without reasons, shadow comparison degrades to "the lists differ."
> 2. **Reasons cannot be reconstructed.** The vetoed and losing candidates exist only during the pick. Add the recording later and every log generated before then is permanently unexplainable.
>
> Explainability is not a feature that decorates the rewrite. It is the **instrument you validate the rewrite with**, and it is the thing GSelector cannot easily copy. Build it first.

> ### ✅ MODULE BUILT 2026-08-10 — two bugs the tests caught before any wiring
>
> `audiod/scheduler-core.js` + `audiod/scheduler-core.test.js` (25 tests, all passing). Pure: no
> `require`, no DB, no `Date.now()`, no `Math.random()`. **Not wired to any caller** — nothing about
> what airs has changed.
>
> **Bug 1 — goals were ignored for the first music slot of every hour.** `elapsed = musicIndex /
> musicTotal` is 0 at position 0, so `paced` is 0 and no category can be behind pace. Corrected to
> `(musicIndex + 1) / musicTotal` — pace the position being *filled*. This also makes pacing
> self-consistent: a 4/hr target over 4 positions now lands on exactly 4.
>
> **Bug 2 — the relaxation report understated itself.** A fallback pick that broke artist *and* title
> separation recorded only the first, because the veto check short-circuits. Split into
> `violationOf` (first, for Tier 1 speed) and `violationsOf` (all, for the record). For a feature
> whose purpose is explainability, a partial answer is a wrong one.
>
> Both were found by unit tests on a scheduler that has never had any. That is the phase working as
> designed — these would otherwise have surfaced as "the goal-driven log looks slightly off" during
> Phase 3 shadow, with no way to localise them.
>
> **Parity caveat, restated because it governs Phase 3:** clock mode reproduces the *logic* of
> `_generateDayRows` :6956-6992 exactly, but cannot reproduce its *output* by construction — the live
> generator draws candidates `ORDER BY RANDOM()`. Identical output requires the caller to pass
> candidates in the query's order. Parity must be proven by a differential run, never assumed.

### Phase 3 — Goal-driven behind a flag (2–4 weeks)
Goal selection in the core; `_generateDayRows` music branch calls it; **`getFormatCategoryIds` widened (R1)**; shadow mode; per-station activation.
**Gate:** shadow runs clean on OV and one internal station for a full week before any station is switched to `goal`.

### Phase 4 — Rotation analytics
Turnover, artist burn, category histograms — reports built on the decision records from Phase 2.5. This is where GSelector parity is actually *claimed*, because the analysis features are what PDs evaluate.

---

## 5. Step 5 — Data model

### 5.1 Goals — no new table

`categories.spins_per_hour` and `categories.priority` exist, are synced, and are UI-editable. Use them.

**One addition needed for real parity:** goals are per-daypart in GSelector (Gold 4/hr in mornings, 6/hr overnight). Options:

- **(a)** new `category_goals` table — `(category_id, station_id, daypart_mask, spins_per_hour, priority)`
- **(b)** JSON in the existing `scheduling_rules.rule_data`, station-scoped

**RESOLVED (§6.4): flat per-category, using the existing `categories.spins_per_hour` / `priority`.** Neither (a) nor (b) is built now — no new table, no JSON goal blob, no migration. Per-daypart goals are revisited only when per-daypart editing is actually happening, so the shape is known rather than guessed.

### 5.2 Rotation state — computed, never stored

Storing spin counts creates a cache that can disagree with the log. Compute instead:

- **Generation time:** count from the rows being built in this run (deterministic, no DB read, no staleness).
- **Leading edge:** the first hour of a run overlaps real airplay — seed from `play_log` for the preceding 60 minutes.
- **Live/analysis:** `generated_schedule.state='played'` joined to `category_id`.

The core receives `rotationState` as an input and never computes it — that is what keeps it pure and testable.

### 5.3 Decision records — one column, not a table

```sql
ALTER TABLE generated_schedule ADD COLUMN pick_reason TEXT;   -- compact JSON, NULL for spots/jingles
```

**Why a column, not a `schedule_decisions` table:**
- It travels with the row through `_commitDayRows`, delete/regenerate, and sync — no orphan rows, no second lifecycle to keep consistent.
- The natural query is *"why this row?"* — a lookup by row, not an aggregate.
- The clock-law doc (`:42-44`) explicitly wanted deferred column work batched into **"one schema change, not two."** `source` and `seq` already landed in that batch; `pick_reason` is the last of it.

**When to revisit:** if Phase 4 analytics need to query *across* decisions ("every artist-separation relaxation last month"), a derived table or a JSON index is the answer then — driven by a real query, not anticipated now.

**Payload — bounded on purpose** (a full candidate dump would balloon the DB):
```json
{"m":"goal","cat":4,"tgt":4,"pac":2.1,"plc":1,"urg":0.27,
 "pool":42,"veto":{"art":31,"day":6},"lrp":518400,"relax":[]}
```

### 5.4 Not needed

- No changes to `clock_slots` — it still defines structure. A slot's `category_id` becomes a *hint/default* in goal mode rather than law.
- No changes to `songs` — `energy`/`bpm`/`mood`/`gender`/`daypart_mask` already exist and are unused by the generator; goal mode can start consuming them with no migration.
- No changes to `play_log`, `spots`, `clock_breaks`.

---

## 6. Decisions — RESOLVED (Jeff, 2026-08-10)

All five answered. Recorded here because #1 reverses a standing ruling and must live in the tree, not in a chat log.

### 6.1 — THE RULING (supersedes part of v4.4.76)

> **GRANTED.** The clock is law for **STRUCTURE**. Goals govern **CATEGORY CHOICE** within music positions.

This bounds and partially supersedes `docs/generate-clock-law-deleted-slots-2026-07-21.md:3-4` (*"the clock is law; Generate is the violator… never import off-clock songs"*).

**What the original ruling still forbids, unchanged:** walking soft-deleted slots; importing a category the station has not declared; any accidental off-clock leak. The v4.4.76 fix (`deleted_at IS NULL` on `stmtSlots`/`stmtShows`) stands and must never be regressed. `scripts/prove-of-regen-fix.js` remains a valid gate.

**What is now permitted:** in `scheduler_mode = 'goal'` only, a music position may be filled from a category other than the one its slot names, provided that category is **declared and active on that station**. The clock continues to decide element type, position count, break placement and duration.

The difference from the original violation is mechanism and intent: that was an *accident* (dead slots resurrecting a catch-all nobody asked for); this is a *declared policy* over the station's own active categories, visible on every row via `pick_reason`.

### 6.2 — `getFormatCategoryIds` widening: **AUTHORISED**
The daemon's on-format guard (`loggen.js:87-91`) may widen from "categories in this clock's slots" to "this station's active, non-deleted categories." Without this, goal-chosen rows are generated and silently dropped — the v4.4.76 §2.7 shadow-gap mechanism. Must land in the same change as goal selection (R1).

### 6.3 — Explainability first: **ACCEPTED**
Phase 2.5 moves ahead of full goal-driven. Reasons cannot be reconstructed after the fact, and shadow mode is unjudgeable without them.

### 6.4 — Goal granularity: **FLAT per-category first**
Use the existing `categories.spins_per_hour` / `priority`. No `category_goals` table, no per-daypart goals yet. Revisit only when per-daypart editing is actually being done, so the shape is known rather than guessed.

### 6.5 — Phase 2 (goals as tiebreak): **SKIPPED**
Removed from the plan. Low value, and it spends time Phase 2.5 uses better.

### Resulting sequence

| Phase | What | Status |
|---|---|---|
| **1** | Advisor — read goals, report clock-vs-goal mismatch | ✅ **BUILT 2026-08-10** — `library-health.js goalCheck` + Health Monitor row; 14/14 bench; no behaviour change |
| ~~2~~ | ~~Goals as tiebreak~~ | **skipped by ruling 6.5** |
| **2.5** | Pure `scheduler-core.js` + decision records; clock mode runs through it | ✅ **MODULE BUILT 2026-08-10** — `audiod/scheduler-core.js`, 25/25 unit tests. **NOT WIRED** — no caller yet, nothing airs differently |
| **3** | Goal selection + `getFormatCategoryIds` widening + shadow mode | ⚙️ **WIRED 2026-08-10** — core is the clock-mode authority in the sequential slot walk; legacy picker retained as a live differential; goal shadow logs only; `scheduler_mode` on `stations` (local, unsynced). **Break mode NOT wired** (anchor fitting). Parity fuzz 20k/20k. See `docs/phase3-wiring-plan-2026-08-10.md` |
| **4** | Rotation analytics on the decision records | blocked on 3 |

---

## 7. Compliance

- **Architecture before code.** Governing docs read and cited: the clock-law ruling, the log-reader flip design, the scheduler-rework status, separation-enforcement design, the LRP-repeat and rotation diagnostics.
- **Never rebuild what exists.** §2.2 lists what is reused; the design deliberately keeps spot placement, jingle placement, daypart enforcement, the separation engine and the generation harness untouched.
- **Conflict surfaced, not built over.** R2 reverses a recorded Jeff ruling and is flagged as requiring an explicit decision rather than assumed.
- **Build the sense, not the scaffold.** Decision records and shadow mode are in the design from Phase 2.5, not bolted on.
- **No code written.** This document is analysis and design only, as instructed.
