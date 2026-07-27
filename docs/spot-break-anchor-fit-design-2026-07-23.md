# Design — Generate fits songs to break anchors (duration-aware last pick)

**Status:** BUILT — v4.4.84 (`electron/main.js` break-mode fill + `selectMusic` fit path; `library-health.js`
break-drift signal). Proven by simulation over real durations (`scripts/prove-anchor-fit.js`); STOP before install.

## Proof (simulation over REAL library durations, `scripts/prove-anchor-fit.js`, 400 hrs/station)

Mirrors the generator's break-mode fill decision exactly. Mid-hour anchors (:00 is a hard cut, excluded):

| Station | pool | BEFORE p90 / ±15s | AFTER p90 / ±15s |
|---|---|---|---|
| Open Format | 165 | 1m56s / 13% | **0m05s / 96%** |
| halloVeen | 180 | 1m49s / 16% | **0m05s / 99%** |
| Magical Forest | 76 | 1m28s / 16% | 0m25s / 78% |

Rich libraries (165–180) land p90 within 5s. Magical Forest's thin 76-song pool floors at p90 25s — no song of
the right length exists to hit ±15s every time; those residual misses fire the `generate-break-drift` health
event (visible, never silent) and shrink as the library gains duration variety. Algorithm is pool-limited, not
flawed — the fit is a tiebreaker within the eligible pool, so a thin pool simply offers fewer landing options.

---

**Status (original proposal):** approved & built as above.
**Scope discipline:** touches ONLY the break-mode fill in `electron/main.js` (the `breaks.length > 0` branch,
~6100–6190). The sequential no-break path, clock law (categories), and separation rules are untouched.

## (1) Today's behavior — receipts

**Algorithm (main.js:6155–6181, v26 break-mode).** For each break (anchor at minute `M`), fill music by
**LRP / separation order** until a song would straddle `target = hourStart + M*60`, then drop the break at the
**nearest song boundary** (before-this-song vs after-this-song, whichever is closer). The last song before the
anchor is whatever LRP hands back — its duration is arbitrary — so the anchor lands wherever a boundary
happens to fall.

**Measured drift** (`scripts/measure-break-drift.js`, read-only over the live `generated_schedule`, ~1400
station-hours; boundary-drift proxy because spots weren't being generated):

| Station | breaks | mean | p50 | p90 | max | ±15s | ±30s |
|---|---|---|---|---|---|---|---|
| Open Format | :00 :20 | 0m31s | 0m00s | 1m36s | 3m50s | 57% | 65% |
| halloVeen | :00 :20 :40 | 0m39s | 0m26s | 1m38s | **4m33s** | 43% | 53% |
| Magical Forest | :00 :20 :40 | 0m32s | 0m22s | 1m22s | 2m02s | 45% | 55% |

`:00` is exact (hard top-of-hour cut) which flatters the median; the **mid-hour anchors (:20/:40) carry the
drift** — p90 ≈ 1.5 min, worst case 4.5 min. Under half of anchors land within ±15s. That's the before-picture.

## (2) The fit — duration-aware last pick before the anchor

Treat break minutes as **anchors** (already true in break-mode). Change only the **final song before each
anchor**: instead of accepting the next LRP song, choose from the **already-eligible pool** (Tier-1
separation-compliant; the existing ladder if none) the song whose duration lands `currentTs` closest to the
anchor — **closest-fit, ties broken by LRP** so rotation is preserved.

```
remaining = target - currentTs                    // seconds to the anchor
pool      = compliant candidates at currentTs      // SAME selectMusic eligibility — separation intact
pick      = argmin over pool of | remaining - duration(song) |   // closest-fit; LRP breaks ties
place pick, currentTs += duration(pick)
if |currentTs - target| <= TOL_SEC: place the break here (on time)
else: keep the existing nearest-boundary decision as the floor, then place the break
```

- **Tolerance.** `TOL_SEC = 15` = "on time" (a spot's own start is sub-second; ±15s is inaudible and matches
  the reporting bucket). Secondary acceptable band ±30s. The fitter aims for ±15s; the nearest-boundary logic
  remains the hard floor so we never do worse than today.
- **Clock law + separation are constraints, not casualties.** Closest-fit is a **tiebreaker within the
  compliant pool** — never a reason to air a song that violates separation or a foreign category. If the
  compliant pool has nothing that fits, we fall to the existing ladder (LRP), place best-fit, and…
- **No song fits → visible, never silent.** Place the best-fit song, then stamp a health event
  (`schedule:break-drift` with `{stationId, hour, breakMinute, driftSec, direction: over|under}`) so an
  un-fittable anchor (e.g. a category of only 4-minute songs against a :20 gap of 40s) surfaces in the Health
  Monitor instead of drifting quietly. This is the build-the-sense half — the fitter reports its own misses.
- **Rotation guard.** Because the pick stays inside the LRP-ordered compliant pool and ties break by LRP, the
  last-before-anchor song still rotates across days (the pool changes hour to hour) — the fit biases by
  duration only when it genuinely tightens the anchor.

## (3) Interaction with §2.7 (the log-reader's asymmetric anchor)

§2.7's time-anchored playhead corrects **live** drift at play time (BEHIND → catch up by dropping missed
rows; AHEAD → play early). This generation-time fit makes the **schedule itself arrive pre-fitted**, so the
anchors already sit near their minutes → the live corrections stay small (less catch-up churn, fewer `missed`
stamps at the boundary).

**Shared shape, two triggers.** Both score a row against a time target (`|target − projected|`). This is the
**static / generation-time** sibling of the future **dynamic / live auto-fitter** (which would re-fit as the
running hour drifts). Same scoring idea; different trigger. **Build the static one now**; factor the scoring as
a small pure helper (`fitScore(remaining, durations) → index`) so the live fitter can reuse it later. Do NOT
build the live re-fitter in this pass.

## (4) Verify

1. Regenerate halloVeen with breaks + eligible spots (post-4.4.83, once Jeff re-picks the break category and
   re-creates a spot).
2. Re-run `scripts/measure-break-drift.js` — now with **real spot rows** — for the after-picture: ACTUAL
   spot-row drift mean/p90/max, and % of anchors within ±15s. Target: **p90 ≤ TOL_SEC**, max bounded, gold
   rows at :00/:20/:40.
3. Confirm no regression on a no-break clock (byte-identical sequential path) and that separation counters are
   unchanged (same `ctx.relaxed` count on a fixed seed).

## What I am deliberately NOT building

- The **live auto-fitter** (re-fit a running hour) — only the generation-time fit.
- Any change to **music rotation** for songs that are not the last-before-anchor.
- Any change to the **sequential (no-break) path**, clock categories, or separation rules.
- Re-fitting on clock/spot edits — the fit runs at Generate.
