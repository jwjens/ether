# Finding #7 — the end-of-song gates, observed

**Date:** 2026-09-07 · **READ-ONLY.** Nothing changed, nothing built.

> **⚠ SAMPLE CAVEAT (added 2026-09-07, Jeff's ruling).** Every airplay figure in this document comes from
> `play_log` **on this dev/beta machine**, which has never run continuously. Audio is switched on only for
> testing, so the log holds **a few hours of intermittent test playout, not station history**. Rates
> derived from it — aired-vs-scheduled percentages, per-bucket miss rates, anything expressed as a share —
> **cannot be supported by this sample and must not be quoted.** Counts and attributions (which deck a
> play landed on, which class it was) remain useful as existence evidence for what did air; rates do not.


`audiod/engine.js:799-800`:

```js
const positionEnd       = prevStatus === "playing" && dur > 5 && pos > 0 && (dur - pos) < 0.3;
const genuineBackendEnd = backendEnded && (dur <= 5 || (dur - pos) < 5);
```

Everything below is **observed** by driving the real `checkEnd` with synthetic position series, or measured
from the live database. Where something is read rather than seen, it says so.

---

## 1 · What each gate decides, and which one ends a normal song

**`positionEnd` ends a normal song.** It is the engine's own clock deciding: the deck was playing, the
duration is known and over 5 s, the position has advanced, and there is less than **0.3 s** left.

**`genuineBackendEnd` is the corroborated fallback.** Rust's `finished` flag alone is not trusted — the
position must agree, either because the item is short (`dur <= 5`) or because the clock is already within
5 s of the end. That corroboration exists for a documented reason (§4).

Observed on the real `checkEnd`, 180 s song, 250 ms poll:

| case | result | gate |
|---|---|---|
| clean 250 ms ticks | ended at **0.25 s** left | `positionEnd` |
| one tick dropped (500 ms gap) | ended at **0 s** left | `positionEnd` |
| position clock late by 0.4 s | ended at **0 s** left | `positionEnd` |
| position clock **stalls** entirely | **NEVER ENDED** | — |
| …same, Rust says ended | ended at 0.5 s left | `genuineBackendEnd` |

So in normal operation `positionEnd` fires within one poll tick of the true end, and `genuineBackendEnd`
never gets a turn. It only matters when the position clock stops telling the truth.

## 2 · What airs under 5 s — and the guard's real blast radius

**Measured on halloVeen.** Items shorter than 5 s in `songs`:

| class | count | range |
|---|---|---|
| SWP | **16** | 1.82 s … 4.95 s |
| MUSIC / SPOT / ANN | **0** | — |

In `generated_schedule`, rows under 5 s: **6,715, all SWP.** Announcements: none with a duration at all.
Your shortest spot is 11 s.

**Nothing under 5 s currently reaches a rotation deck.** The schedule side of that is solid — the counts
above are from `generated_schedule` and `songs`, which do not depend on how much the machine aired.

The airplay side is weaker than it looks. What `play_log` holds for the nominal seven-day window:

```
SWP    deck E  194        ← the sweeper channel
MUSIC  deck A 64 · B 63 · C 60
```

**Every sweeper play landed on deck E; none on A/B/C.** That is a useful ATTRIBUTION — of the plays that
did happen, none put a sweeper on a rotation deck — but it is **not** evidence about a seven-day period.
This machine is dev/beta and audio is on only for testing, so those 194 plays are a few hours of
intermittent test playout. Absence over such a sample is not absence over a week.

### How a short item WOULD end, if one ever landed on a deck

Observed:

| case | result | gate |
|---|---|---|
| 4 s item, clean ticks, no backend flag | **NEVER ENDED** | — |
| 4 s item, backend flag arrives | ended at 0 s left | `genuineBackendEnd` |
| 2 s sweeper, no backend flag | **NEVER ENDED** | — |
| 2 s sweeper, backend flag arrives | ended at 0.25 s left | `genuineBackendEnd` |
| 6 s item (just over the guard) | ended at 0.25 s left | `positionEnd` |

**A short item on a rotation deck has exactly one way to end: Rust's finished flag.** If that flag is
missed — and it is a one-shot `compare_exchange` consumed by whichever reader gets there first — the deck
never ends and the watchdog's stall recovery is the only thing left. `dur > 5` removes the engine's own
clock as a backstop for precisely the items least able to afford it.

### The thing I found while counting, which is larger than finding #7

**The queue-fill query does not exclude sweepers.** `audiod/loggen.js:241` and `:261`:

```sql
AND (gs.content_class IS NULL OR gs.content_class != 'JIN')
```

`'JIN'` has been an empty set since v52 collapsed every sweeper to `'SWP'`. The two *anchor* queries in
the same file (`:288`, `:332`) get it right — `NOT IN ('JIN','SWP')` — so the file disagrees with itself
about what may go on a deck.

**What actually keeps sweepers off the decks is incidental.** `catClause` (`:231`, `:251`) is
`AND (s.id IS NULL OR s.category_id IN (…format categories…))`, and all **64 of your sweeper songs have
`category_id = NULL`**, so they fail it.

**But that clause is conditional:** `fmt.length ? … : ""`. When `getFormatCategoryIds` returns nothing —
no active show clock for the hour — `catClause` is the empty string, and the only remaining filter is the
one that excludes a class no longer in use. **On an hour with no clock, sweepers become eligible for the
music queue**, and 6,715 of them are under 5 s, which is exactly the case §2 shows has no position-based
end detection.

This is read from source, not observed: I have not seen a sweeper on a rotation deck, and the plays that
exist in `play_log` do not include one. That sample is a few hours of intermittent testing, so it cannot
establish that the path has never been taken — only that it was not taken during the little that aired.
**Filing it here because it is the reason `dur > 5` is worth caring about at all.**

## 3 · The 0.3 s threshold — late clock, or cut song?

**Neither. The rotate lands late; the song is never cut.**

`checkEnd` does not stop anything. It sets the deck's status to `ended` and hands off to the rotate, so a
late detection produces a **gap**, not a truncation. Observed above: a clock 0.4 s late still fired
`positionEnd`, one tick later, at 0 s remaining rather than 0.25 s.

Why it survives lateness: the window `(dur - pos) < 0.3` is open-ended below. Once `pos` passes
`dur - 0.3` it stays inside the window for every subsequent tick, so **any late sample still lands in
it**. A 250 ms poll cannot step over a window that has no floor.

The only failure is a clock that **stops**, and that was observed too: a stalled position never ends the
deck by `positionEnd`, and only `genuineBackendEnd` recovers it.

**0.3 s is not a truncation risk.** It is roughly one poll tick, so it decides how promptly the rotate
starts, not whether the song completes.

## 4 · Where 0.3 and 5 came from

| value | origin | justified? |
|---|---|---|
| `(dur - pos) < 0.3` | `e9348bf` / `83faeef` — **"Ether v1.5 initial release"** | **No.** No commit, comment or doc explains it |
| `dur > 5` in `positionEnd` | same initial release, carried into the daemon by `c018e03` | **No.** Nothing explains why short items are excluded |
| `(dur - pos) < 5` in `genuineBackendEnd` | **`5fcb47f`, 2026-05-12** | **Yes, explicitly** |

`5fcb47f` is the one with a reason, and it is a good one:

> *"Rust occasionally emits a spurious 'ended' status for a preloaded or mid-play deck. backendEnded was
> accepted unconditionally, causing C to fire and play over an active deck. Now require that tracked
> position is also within 5s of end (or duration is unknown) before acting on the Rust signal."*

So the **corroboration window** is a deliberate fix for a real incident. The `dur <= 5` escape inside it
exists so short items — whose position can never satisfy a 5 s window — are not locked out of the only
gate they have.

**The `dur > 5` in `positionEnd` is a different number that happens to share a value**, and nothing
justifies it. The two 5s are not the same decision, and reading them as a pair is a mistake the code
invites.

## 5 · Options

### A · Do nothing

- **Cost:** none today, on the schedule evidence — nothing under 5 s is placed for a rotation deck. The
  airplay record is too thin a sample to confirm or deny anything on its own.
- **Risk:** the latent path in §2. If an hour ever runs without a clock, a 2-second sweeper can be queued
  to a deck with no position-based end detection behind it.

### B · Fix the queue filter, leave the thresholds alone

Change `!= 'JIN'` to `NOT IN ('JIN','SWP')` at `loggen.js:241` and `:261`, matching the two anchor queries
in the same file.

- **Cost:** two words. It closes the latent path rather than the symptom.
- **What could go wrong on air:** nothing I can find — it makes the queue-fill agree with the anchor
  queries that already ship, and sweepers are not supposed to be deck items.
- **Verdict:** this is the one I would do. It removes the reason to care about `dur > 5` at all.

### C · Lower or remove the `dur > 5` guard

Let short items end by position.

- **Cost:** small edit; the guard exists to avoid trusting a position clock on an item too short for it to
  have settled.
- **What could go wrong:** on a 2-second item at a 250 ms poll there are only eight samples, and the first
  is often 0. `pos > 0` already guards that, so the exposure is a bad duration rather than a bad position.
  **A wrong `duration_ms` on a short item would end the deck early** — and durations come from the file,
  so a mis-parsed header would cut audio rather than land late.
- **Verdict:** more risk than B for the same benefit, while B removes the case entirely.

### D · Make either number a setting

- **Verdict:** no. These are not programming decisions — nobody wants to choose how many milliseconds of
  slop the position clock gets. They are engine tolerances, and the honest treatment is a documented
  constant plus a test, not a slider.

**What I would propose, if you want a proposal: B alone**, plus a comment on `dur > 5` recording what §4
established — that it shares a number with the corroboration window and is not the same decision.

---

## What this document does not claim

§1, §3 and the short-item table in §2 are **observed** by driving the real `checkEnd`; the counts and the
`play_log` deck split are measured from the live database. **The latent path in §2 is read from source and
has not been seen happen** — the airplay record says it has not, over seven days. §4 is an absence of
evidence for two of the three values: I searched the commits that introduced them and the surrounding
docs and found no justification, which is not proof none existed.
