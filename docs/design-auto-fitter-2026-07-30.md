# Design of record — the AUTO-FITTER (deterministic look-ahead, no LLM)

**Date:** 2026-07-30 · **Status:** DESIGN ONLY. Nothing built.
**Governing ruling:** §2.7 of `docs/log-reader-single-source-playout-design-2026-07-20.md` — the fitter is
PRIMARY, boundary DROP is last-resort only.
**Prerequisite, already shipped:** the log-reader flip executing (4.4.111 nearest-anchor rides on it).

---

## 1. The two live cases, measured

Both are the **same event** — the 13:00 hard cut on 2026-07-30 — seen from two angles.

### Case A — the top-of-hour cut chopped a song mid-play on all four stations

```
station                        on air when the cut fired
s1  Lovely Day                        13.5 s
s2  Defying Gravity                   30.2 s
s3  Come December                     78.5 s
s4  What the World Needs Now Is Love 118.0 s   ← 93 s of a 211 s song, chopped mid-vocal
```

Station 1's song had been playing for **thirteen seconds**. It was started, then killed. That is the
hard cut doing exactly its job — the clock is law — against a log that never arranged for it.

### Case B — a long song cued into a short window when better-sized ones existed

Station 4's seam fell at 19:58:02 with **118 s** until the anchor. The reader cued a **211 s** song. The
station's own pool, from today's airplay, contains:

```
18 73 98 109 115 123 124 126 127 128 129 131 132 133 137 141 156 163 164 173 179 180 190 191 192 206 211 213 225 240 241 310
```

**115, 123 and 124 all fit the hole almost exactly.** Nothing was wrong with the log's *content* — only
with its *arithmetic against the clock*. That is precisely the gap the fitter fills.

**The fitter's purpose, stated once:** make the hard cut never have anything to cut. The cut stays as the
backstop; it should simply stop firing through a vocal.

---

## 2. The model

A **fit window** is the span between the current seam and the next **hard anchor**:

| Anchor | Source | Movable? |
|---|---|---|
| Top of the hour | `_hardCutTopOfHour` | **Never.** The clock is law. |
| A SPOT anchor | `clock_breaks` → `generated_schedule` | Never moved; nearest-anchor selection (4.4.111) already places it at the closest seam. |

The fitter never moves an anchor. It adjusts **the pending MUSIC rows between the seam and the anchor**
so that a **seam lands on the anchor**.

```
seam ──[music]──[music]──[music]──▶ | ANCHOR
                                 ↑
                    projected arrival vs the anchor
                    overshoot  → the last row runs past  → SWAP shorter
                    undershoot → we arrive early         → INSERT a short fill
```

**Target:** a seam within **±5 s** of the anchor (`FIT_TOLERANCE_SEC`). Perfect zero is not achievable —
durations are what they are — and it is not needed: at ±5 s the hard cut clips at most five seconds of a
song instead of ninety-three. **Landing slightly EARLY is preferred to slightly late**, because the segue
overlap absorbs an early seam whereas a late one is what gets chopped.

---

## 3. The algorithm — deterministic, bounded, no LLM

Run on the flip's refill path. Pure decision, then a write.

```
1. WINDOW      anchor = next hard anchor within LOOKAHEAD_SEC;  none → return
2. PROJECT     t = seamTs;  rows = pending MUSIC rows before the anchor
               arrival = seamTs + Σ durations(rows)
3. GAP         gap = arrival − anchor        (>0 overshoot, <0 undershoot)
               |gap| <= FIT_TOLERANCE_SEC    → already fitted, return
4. REPAIR      overshoot  → SWAP  (§3.1)
               undershoot → INSERT FILL (§3.2), else SWAP LONGER
5. LAST RESORT DROP the final row and stamp it 'missed' (§3.3) — only when 4 finds nothing
6. WRITE       stamp source='autofit', rewrite the pending rows, log one DECISION line
```

Every step is arithmetic over rows already in the log plus a bounded query of the same category. No
model, no randomness, no time-dependence beyond the wall clock — the same inputs always give the same
fit, which is what makes it benchable.

### 3.1 Overshoot → swap for a shorter same-category song

For each candidate row **from the last backwards** (changing the latest row disturbs the least):

```
need = row.duration − gap                    the duration that would close the window
pick  = eligible songs in THE SAME CATEGORY, |duration − need| minimal
```

**Eligibility is the existing separation contract, not a new one** — reuse
`electron/separation-enforce.js` (`buildRestMaps` / `pickEnforced`), the same picker Generate and the
emergency floor use. A swap that violates separation is not a fit; it is a different bug.

- **Single swap first.** If one row closes the gap to within tolerance, take it and stop.
- **Two-row swap** only if no single swap fits. Bounded at two — beyond that the fitter is rewriting the
  hour rather than fitting it, and the operator loses the plot.
- **Never** swap the row currently on a deck, a SPOT row, or a JIN/SWP overlay.

### 3.2 Undershoot → insert a short fill

We arrive early: the gap is negative. Insert **one** short on-format element of ≈`|gap|`, drawn from the
same eligible pool with the same separation contract, preferring a category the clock already asks for
at this position. If nothing within tolerance exists, prefer a **slightly longer** fill (a small
overshoot that lands within tolerance) over leaving a hole — silence is never the answer.

### 3.3 Last resort — DROP

Only when neither swap nor fill can close the gap: drop the final row before the anchor and stamp it
`'missed'`, the same state the reader already uses for a skipped-past row. **Loudly** — this is the
outcome the ruling calls last-resort, so it must never pass quietly as a fit.

### 3.4 When nothing fits at all

State it, do nothing, and let the hard cut do its job. **A fitter that cannot fit must not thrash.** It
logs one line naming the gap and the reason (pool too thin, everything separation-blocked), emits a
health event, and leaves the log alone until the next re-fit. The Health Monitor already has the row for
it: *Rotation depth — 1 thin category · Summer Christmas: 46 songs for ~23 slots/hr — needs ~69*, which
is exactly the condition that starves the fitter.

---

## 4. Hard constraints

**Never touched, under any circumstance:**

| | Why |
|---|---|
| The playing deck | The fitter writes the log ahead of air. It never stops, cuts or reorders what is sounding. |
| A cued deck already started | Same rule. Cued-but-unstarted decks are re-cued only by the 4.4.111 companion, and only for SPOTs. |
| SPOT rows | Spots are the anchors. Nearest-anchor selection owns their placement; the fitter fits music *around* them. |
| JIN / SWP overlays | Seam overlays, never deck tracks — excluded from every query, as they already are. |
| The top-of-hour anchor | The clock is law. The fitter changes what arrives at `:00`, never when `:00` is. |
| Separation rules | Every swap and fill goes through the shared enforced picker. A fit that breaks separation is not a fit. |
| Legacy stations | Hooks live in `_refillFromLog`, which runs only when `_logReaderOn()` is true. |

---

## 5. Visibility — every fit is a DECISION, minutes before air

The 4.4.112 lesson applies directly: **a correction nobody sees is indistinguishable from a bug nobody
caught.**

- **Stamped `source='autofit'`** on every written row — the column already exists (migration v34) and
  already carries `'operator'`. The calendar and Up Next can then show *why* a row is there.
- **Written minutes ahead**, never at the seam, so the operator sees the corrected log **before** it airs
  and can override it.
- **One log line per fit, classified DECISION** (the `LiveActivityTerminal` patterns already route
  `logreader` / `nearest-anchor`; `autofit` joins them):

```
autofit: window 13:00:00 overshoot +93s — swapped "What the World Needs Now Is Love" (211s)
         → "Christmas In July" (192s)… arrival now 12:59:58 (−2s)
autofit: window 13:00:00 undershoot −47s — inserted "Jingle Bell Rock" (44s); arrival 12:59:57 (−3s)
autofit: window 13:00:00 gap +93s — NO FIT (pool thin: 3 eligible, none within tolerance); hard cut will trim
autofit: window 13:00:00 gap +93s — DROPPED "…" (last resort), stamped 'missed'
```

- **A health event** on no-fit and on drop, so both surface in the Health Monitor rather than only in the
  log.

---

## 6. Where it hooks, the window, and the cadence

**Hook:** `audiod/engine.js` `_refillFromLog`, after nearest-anchor ordering and before the queue is
rebuilt — the fitter adjusts the *pending region* the reader is about to publish. One insertion point,
same as 4.4.111, same flip-only gate.

**`LOOKAHEAD_SEC = 900` (15 minutes).** Long enough to have three or four rows to work with, short enough
that the swaps are still near-term and the operator can see them coming. Beyond that the pool state and
the clock will both have moved.

**Re-fit cadence: on change, not on a timer.** Re-evaluate when the refill runs *and* something material
moved — the anchor came into the window, a row aired, or the projected arrival drifted outside tolerance.
**Stability rule: never re-swap a row already stamped `'autofit'` unless the gap has moved outside
tolerance again.** Otherwise every refill would re-pick and Up Next would churn — the same flapping the
nearest-anchor tie band exists to prevent.

**Idempotence is the contract:** running the fitter twice on an already-fitted window must be a no-op.

---

## 7. Interaction with what already ships

- **Nearest-anchor (4.4.111)** places a spot at the closest seam. The fitter makes that seam land *on*
  the anchor, so nearest-anchor has a better choice to make. They compose: fitter first (it writes the
  log), then nearest-anchor orders what is there.
- **The hard cut** stays exactly as it is. It is the backstop and the guarantee. **The fitter's success
  metric is that the cut becomes invisible** — still firing at `:00`, with nothing left to chop.
- **The liveDeck guard / Bug-A stop** are untouched; the fitter issues no deck command.
- **The §2.7 selector** is untouched; the fitter changes *which rows* are pending, not *which row is now*.

---

## 8. Benches — today's live cases first

Pure, no audio/DB/daemon, in the shape of `smoke-nearest-anchor.js`:

1. **Case B, exactly:** seam 19:58:02, anchor 20:00:00, pending starts with a 211 s row, pool contains
   `115/123/124` → asserts a single swap picking the nearest fit and an arrival within ±5 s.
2. **Case A, all four stations:** the measured seams/durations above → asserts each window fits, and that
   the projected arrival is within tolerance so nothing would have been chopped.
3. **Undershoot:** arrival 47 s early → inserts one fill; and the no-short-fill variant → prefers a
   slightly longer element over a hole.
4. **Separation-blocked:** the only well-sized candidate is inside its window → must NOT be picked;
   asserts the next-best or a no-fit, never a violation.
5. **Thin pool → no fit:** logs, health-events, changes nothing, does not thrash.
6. **Last-resort drop:** only reachable when swap and fill both fail; asserts the `'missed'` stamp and the
   loud line.
7. **Idempotence:** fit, then re-fit the same window → no change, no new rows, no second log line.
8. **Never-touch invariants:** playing deck, cued-and-started deck, SPOT rows, JIN/SWP, the anchor itself
   — each asserted by tripwire, as the guard bench does.
9. **Boundary:** anchor exactly at `LOOKAHEAD_SEC`; gap exactly at tolerance; zero pending rows.

---

## 9. Blast radius

**This writes the log.** That is a bigger step than anything since the flip itself: the fitter *authors*
`generated_schedule` rows, where every previous change only chose among rows Generate had written.

- **It cannot cause dead air** — it never removes without replacing, except the last-resort drop, which
  only shortens a window that was overshooting.
- **It cannot cause a double-play** — no deck commands.
- **It CAN put the wrong song on air.** A swap that mis-picks airs a song the operator did not schedule.
  That is the real risk, and it is why every swap goes through the shared separation picker and every fit
  is written ahead of air and logged.
- **It can churn Up Next** if the stability rule is wrong. Idempotence and the no-re-swap rule are what
  prevent it; both are benched.
- **Flipped stations only.** Legacy is untouched by construction.

**Recommended rollout:** ship it **observation-only first** — compute the fit, log the line, write
nothing — for one release, exactly as the liveDeck guard was proven. The log will then say what it
*would* have swapped for a full day, on real air, before it is allowed to author a row. Given that this
is the first thing in the arc that writes the log, I would not skip that step.

---

## 10. Open questions for approval

1. **`FIT_TOLERANCE_SEC = 5`** — accept, or tighter/looser?
2. **`LOOKAHEAD_SEC = 900`** — accept?
3. **Two-row swap cap** — accept, or single-swap only for v1?
4. **Observation-only first release** — my recommendation; confirm or overrule.
5. **Undershoot fills**: draw from the clock's current category, or a dedicated short-element category
   (station IDs / sweepers) if one exists? The second is more musical but needs a category convention
   this station set does not have yet.

**Building nothing until approved.**
