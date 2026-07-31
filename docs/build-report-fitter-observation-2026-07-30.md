# Build report — Release 2 of 3: the auto-fitter, OBSERVATION ONLY

**Date:** 2026-07-30 · **Scope:** wire `audiod/autofit.js` into the flip's refill path to compute and
report fits. **IT WRITES NOTHING.**
**Gates:** `tsc --noEmit` at baseline · autofit 47/47 · nearest-anchor 37/37 · seam-stop 35/35 ·
logreader-anchor 18/18. **No bump, no commit, no build.**

---

## What it does, and the one thing it does not

Each refill on a flipped station: find the next hard anchor, gather a separation-filtered candidate
pool, compute the fit, and **log what it would have done**. No `generated_schedule` row is written, no
queue is reordered, no deck is touched. `computeFit` is pure and returns a decision object; the caller
logs it and discards it.

```
autofit: window 13:00:00 overshoot +93s — would have swapped
         "What the World Needs Now Is Love" (211s) → "Christmas In July" (192s); arrival 12:59:58 (−2s)
```

The `would have` wording is produced by `describeFit(fit, anchorTs, observationOnly = true)` — flipping
that flag is the entire difference between observing and acting, and it is not flipped here.

## The three pieces

**1. The eligible pool — `loggen.eligibleForFit()`** (`audiod/loggen.js`). The fitter never invents a
pick; it size-matches against whatever this returns. Eligibility reuses **the existing separation
predicates** — `baseConditions` + `sepConfig`, station-scoped via `play_log`, on-format via
`getFormatCategoryIds`, MUSIC only — so a swap it proposes cannot break separation. A second, parallel
notion of "eligible" is exactly the kind of drift that produced the `spotProjection` duplication already
in the backlog, so there isn't one.

**2. The hook — `_observeFit(seamTs)`** (`audiod/engine.js`), called from `_refillFromLog` after the
nearest-anchor ordering. Alongside it, `_nextHardAnchorTs()` returns whichever comes first: the next top
of the hour, or the next pending SPOT row — null if neither is inside `LOOKAHEAD_SEC`.

**Throttled by signature, not by time.** The refill runs every couple of seconds and a window's fit is
stable, so re-logging it would drown the Decisions view. The signature is
`anchor | mode | action-type : from → to`; a line appears only when the window or the proposed action
actually changes. That is the same lesson as the nearest-anchor tie band — a projection that flaps is
worse than no projection.

**3. Health event on no-fit.** `emit("error", { where: "autofit", … })` naming the window and the reason
("no single swap fits (3 eligible)"), so the condition that starves the fitter surfaces in the Health
Monitor rather than only in the log. The Rotation-depth row already shows the underlying cause —
*Summer Christmas: 46 songs for ~23 slots/hr — needs ~69*.

## Board surfacing — what I did, and what I deliberately did not

You asked for the fitter's arrival on the board "where cheap". **It is cheap through the Live Activity
terminal and not cheap as a Spot Schedule column**, so I did the first only.

- **Cheap and done:** the terminal already tails the daemon log, so the fit lines appear there with no
  new plumbing. The classifier now routes them: `autofit …` → **DECISION**, and the two no-fit shapes
  (`NO FIT`, `hard cut will trim`) → **WARNING**. Verified against six representative lines, all landing
  where intended. The arithmetic is therefore verifiable on the board during the observation day, in
  Decisions, beside the rotates it is reasoning about.
- **Not cheap, not done:** a *Projected (fitted)* column in the Spot Schedule. The fit is computed
  daemon-side; the board is renderer-side, so it would need a new daemon event, a main forward, a
  preload channel and renderer state — four touch points for a column that would only restate a log line
  the operator can already read. Worse, the renderer would then need its own copy of the fit arithmetic
  to place it, which is precisely the duplication already filed in the backlog for `spotProjection.ts`.
  **I would rather not add a second instance of a known problem to display an observation.** If the
  observation day says the column is wanted, the right way to build it is the same fix the backlog
  entry describes: the daemon exposes its projection, the renderer displays it.

## Blast radius

**Nothing here can change what airs.**

| | |
|---|---|
| `generated_schedule` | **Not written.** No INSERT, no UPDATE anywhere in the fitter path. |
| The queue | Not reordered. `_observeFit` reads `this.queue`; it does not assign to it. |
| Decks | No `_load`, `_play`, `_stop`, `handleRotate`, `preload`. |
| Legacy stations | Untouched — `_refillFromLog` runs only when `_logReaderOn()` is true. |
| Nearest-anchor / liveDeck guard / Bug-A stop / hard cut | All untouched. |
| Failure mode | The whole method is inside `try/catch` with the "playout unaffected" contract; a throw logs and returns. |

The one measurable cost is the candidate query (`LIMIT 200`, on-format, indexed on the same predicates
every other selection path already uses) once per refill where a fit is in reach — bounded and on the
daemon's own poll, not the audio path.

## What the observation day should produce

1. **`autofit:` lines in Decisions** on Christmas In July, near each `:20`/`:40`/`:00` window.
2. **How often a single swap suffices** — the deferred v2 question. Every `no single swap fits` line is
   a data point for whether the two-row cap should be lifted.
3. **Whether the proposed swaps look musically sane** to you. The arithmetic can be right and the
   choices still wrong; that is a judgement only you can make, and it is the real reason this release
   observes instead of acting.

**Not verified on air.** The computation is proven against today's measured cases in the bench (Case B
reproduces the 93 s overshoot exactly; Case A fits all four stations), but no fit has yet been computed
on a live station with this code.

## Files

```
audiod/loggen.js   eligibleForFit() — separation-filtered candidate pool, exported
audiod/engine.js   require autofit · _observeFit() · _nextHardAnchorTs() · call from _refillFromLog
src/components/LiveActivityTerminal.tsx   autofit → DECISION, no-fit shapes → WARNING
```

## Still queued

**Release 3 (design only)** — rotation preferring the deck holding a due SPOT over letter order, from
the 20:20:04 case (spot cued on deck B, rotation took deck A, anchor 29 s away). Touches
`_nextRotateDeck`/the rotate path, so it is a design of record first, with bounded conditions, what the
Bug-A and liveDeck guards see during it, and named benches.
