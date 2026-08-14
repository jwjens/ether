# Health Monitor v2 — the dashboard, designed

**Date:** 2026-08-13 · **Status:** DESIGN ONLY. No code written for the chart; the one exploratory
IPC was reverted (§7.1).
**Builds on:** Phases 1–2 shipped in 4.4.204–4.4.207 (cards, rotation bars, events timeline).
**Governing:** `docs/schedule-manager-v2-design-2026-08-10.md` §0.3 (bundle cost) and §3 (visual
language), `src/index.css` (tokens), CLAUDE.md (flat / dense / muted).

---

## 0. THE FINDING THAT SHOULD DECIDE THE CHART

The reference dashboard's chart is smooth and rising. Ours will not be, and the reason is not
styling — it is **what is being plotted**.

**The reference plots a LEVEL** (net worth over time). A level moves gradually, is defined at every
instant, and therefore draws a continuous curve.

**Spins per hour is a RATE**, and these stations are not on air most of the time. Measured over the
last 7 days:

| Station | plays in 7d | hours WITH airplay (of 168) |
|---|---|---|
| 1 Open Format | 460 | **39** (23%) |
| 2 halloVeen | 2,454 | **81** (48%) |
| 3 Magical Forest | 570 | **34** (20%) |
| 4 Christmas in Jully | 1,080 | **34** (20%) |

An hourly spins chart over 7 days is **168 buckets of which 87–134 are zero**. That is a comb, not a
curve, and no amount of gradient fill makes it read like the reference. Daily buckets would smooth it
into 7 points — legible, but 7 points is a bar chart wearing a line.

**Ether's true equivalent of "net worth" is RUNWAY** — days of log remaining. It is a level, it moves
gradually, it is defined at every moment, and it is the single most decision-relevant number in the
panel: it is how long until dead air. A runway trend would look like the reference *because it is the
same kind of quantity*, not because it was styled to.

**Recommendation: plot runway.** §3 covers the one obstacle — we do not currently keep its history.

---

## 1. Layout

```
┌─ AT A GLANCE — halloVeen ─────────────────────────────────────────────┐
│ ┌─RUNWAY──┐ ┌─DESIGNATED─┐ ┌─ROTATION─┐ ┌─QUEUE──┐                    │
│ │ 17.2d   │ │This machine│ │    1     │ │   0    │   ← --t-metric 30px │
│ └─────────┘ └────────────┘ └──────────┘ └────────┘                    │
│                                                                        │
│ ┌─ RUNWAY, LAST 7 DAYS ──────────────────────────────── 17.2d ──────┐ │
│ │      ╱‾‾‾╲                                          ╱‾‾‾‾‾        │ │
│ │  ╱‾‾╯     ╲___╱‾‾‾╲___╱‾‾╲______╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾╯              │ │
│ │ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ ← 1d floor │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│ ┌─ ROTATION GOALS ────────────────────────────────── last 24h ──────┐ │
│ │ HalloVeen      ████████████████████████┃      18.3/4 /hr          │ │
│ │ Early tracks   ░░░░░░░░░░░░░░░░░░░░░░░░        0 /hr · no target  │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│ ┌─ LIVE EVENTS ──────────────────────── ALL (+227) · RELOAD ────────┐ │
│ │ ● 19:19  Logreader missed   s3 · 1 row · drift -50s               │ │
│ │ ● 17:53  Designation refreshed   Open Format · mine                │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

Order matches the brief: cards, chart, bars, timeline. The chart sits between cards and bars because
it explains the Runway card directly above it — the number and its history read as one thought.

---

## 2. Chart library — the cost, honestly

The brief says install `recharts`. Here is what that costs, so the decision is made with numbers.

| | recharts | hand-rolled SVG |
|---|---|---|
| Bundle added | **~100–120 KB gzipped** (pulls d3-scale, d3-shape, d3-array, d3-path) | **0** |
| Code to write | ~30 lines of JSX | ~50 lines + ~40 lines of pure geometry |
| Styling | override its defaults to reach flat/muted | already flat; uses our tokens directly |
| Testable | renders via DOM | the geometry is pure and unit-tested |
| Risk | a new dependency in the renderer | none |

`docs/schedule-manager-v2-design-2026-08-10.md` §0.3 records the renderer bundle at **2.49 MB and
warned about on every build**, and says any new dependency "must carry that cost honestly". Today's
build emits `2,974 KB` for the main chunk with the >500 KB warning.

For **one area chart of ≤168 points**, recharts is a large amount of machinery for one `<path>`.

**Recommendation: hand-rolled SVG.** Adopt recharts the moment a second chart type appears (axes,
tooltips, legends, brushing) — that is when a library starts paying for itself. A draft of the pure
geometry already exists at `src/components/health/chartPath.ts` (untracked, imported by nothing).

**If you prefer recharts anyway, say so and it goes in** — it is your call and the difference is
~110 KB, not a correctness issue.

---

## 3. Chart data — the real problem

### 3.1 Runway history does not exist as a series

Runway is computed on demand (`electron/runway.js` `computeRunway`) from the schedule as it stands
*right now*. **It is never stored.** So "runway over the last 7 days" cannot be queried today, and it
cannot be reconstructed retroactively either — yesterday's runway depended on yesterday's schedule
and yesterday's clock, both since overwritten.

It IS present incidentally inside `health-events.jsonl`: every `library-health` event carries
`stations[].runway`, and those fire every ~2 minutes. The ledger currently spans
**2026-07-21 → 2026-08-14 (24 days) in 39 MB** and has no rotation.

Three ways to get the series:

| | How | Cost | Verdict |
|---|---|---|---|
| **A. Scan the ledger** | read back 7 days of `library-health` events, extract `runway.days` | 7 days ≈ 5,000 events ≈ **~10 MB** to read and parse on every panel open | Works today, no new writes. Heavy, and gets heavier — that file never rotates. |
| **B. Sample it properly** | append one compact row per station per hour to a small `runway_history` table | ~24 rows/station/day; 7 days = 168 rows | **Recommended.** Cheap to write, trivial to query, and it is the thing we actually want: a time series. |
| **C. Plot spins instead** | `play_log` grouped by hour/day | one indexed query | Available immediately, but §0 shows it is a comb, not a curve. |

**Recommendation: B, with C as the interim.** B needs a migration (one small table) and a write on
the existing 30-minute tick, and starts empty — a 7-day chart takes 7 days to fill. So ship C's data
path first (it works now), and switch the same chart component to B's series once it has history.
The chart component does not care which series it is given.

### 3.2 If we plot spins, plot it honestly

- **Zero-fill every bucket.** A quiet hour must be a zero, not a missing point — otherwise the line
  is drawn between the surrounding hours and paints continuous output over a gap that really happened.
- **Daily buckets for a 7-day view** (7 points), hourly for a 24-hour view (24 points). Do not offer
  hourly-over-7-days: §0's numbers make it 87–134 zeros out of 168.
- **Label the window on the chart.** "Spins per hour" with no window is not a number.

---

## 4. Cards — no change

Shipped in 4.4.204/4.4.207 and matching the brief:

| Card | Value | Thresholds |
|---|---|---|
| Runway | `17.2d` | green ≥5d · yellow <3d · red <1d (from `runway.js`, unchanged) |
| Designated generator | `This machine` | from `generation-designation.js` `status()` |
| Rotation health | mismatch **count** | green 0 · yellow 1–2 · red >2 |
| Queue | track count | green ≥10 · yellow 5–9 · red <5 |

`--t-metric: 30px` was added to `src/index.css` because the scale had no metric step — five sizes
topping out at `--t-head: 20px` "panel titles only". That absence is why the panel kept reading as
text however it was arranged; `--t-lead` (14px) would have made it worse.

Two honesty rules already implemented and worth keeping: an unknown status renders **grey, never
green**, and runway `days: null` (no active show) renders **"—", never 0** — zero days is real and
urgent and must not look like not-applicable.

---

## 5. Bars — no change

Shipped. One bar per category from `goals.categories`, target vs 24h actual, fill clamped at 100%
with a hatched cap when over, and a target tick at the 100% mark.

**The open question is not the bars, it is the targets.** Measured 2026-08-13: **1 of 10** categories
on station 1 has `spins_per_hour` set, **1 of 2** on station 2, **none** on 3 or 4. So most bars have
an actual and no target, and halloVeen's one target reads 18.3 against a declared 4 — which is
almost certainly a placeholder rather than a real goal. A goals chart is only as meaningful as the
goals; **someone has to declare them** before this section says much.

---

## 6. Timeline — no change

Shipped. The substantive fix was not visual: **95% of the ledger is periodic heartbeats** (227 of the
last 238 events are `library-health` / `queue-lint`), which is why it rendered as eight identical
rows. Routine kinds are hidden by default with an `ALL (+n)` toggle that states exactly how many are
held back, and no row can render blank.

**Backlog item, not this design:** `health-events.jsonl` has no rotation and is at 39 MB after 24
days. That is ~1.6 MB/day, and the tail-read is bounded so the panel stays fast — but the file grows
forever. It needs a rotation or compaction policy.

---

## 7. Build plan

| Phase | What | State |
|---|---|---|
| 1 | Cards | **shipped** 4.4.204 |
| 2 | Rotation bars + spins backend | **shipped** 4.4.205–207 |
| 3 | Timeline | **shipped** 4.4.206–207 |
| **4a** | `health:spins-by-hour` IPC (zero-filled buckets) + chart on spins | ~1 hour |
| **4b** | `runway_history` table + hourly sample + switch the chart's series | ~2 hours, then 7 days to fill |

### 7.1 What was written ahead of this doc, and undone

While building toward the chart I added a `health:spins-by-hour` IPC to `electron/main.js` and drafted
`src/components/health/chartPath.ts`. **`main.js` has been reverted** — it is back to the committed
state — because it was edited while 4.4.207 was packaging, which is precisely what the
no-edit-during-build rule prevents. `chartPath.ts` remains on disk, untracked and imported by nothing,
so it cannot reach a bundle; it is the §2 geometry draft and is either used by 4a or deleted.

**The 4.4.207 installer produced during that window should be treated as untrustworthy and rebuilt**
from a clean tree before anyone installs it.

---

## 8. Open questions

1. **§2 — recharts, or hand-rolled SVG?** Recommendation: SVG for one chart; recharts when a second
   chart type appears. ~110 KB gzipped either way.
2. **§3 — what does the chart plot?** Recommendation: runway (a level, so it looks like the
   reference), via option B, with spins as the interim. Plotting spins alone will not resemble the
   reference no matter how it is drawn, and it is better to say that now than after building it.
3. **§3.1 — is a new `runway_history` table acceptable?** It is the first schema addition in this
   work; everything else has reused existing columns.
4. **§5 — who declares the rotation goals?** The bars are built and mostly have nothing to measure
   against.
5. **§6 — ledger rotation.** 39 MB and growing 1.6 MB/day, unbounded. Not urgent, not ignorable.

---

## 9. Compliance

- **Flat, dense, muted** — `--r-0` throughout, existing tokens only, one documented addition
  (`--t-metric`) with a stated reason.
- **Never rebuild what exists** — `health:recent-events` (4.4.195) powers the timeline; the cards and
  bars are unchanged; the chart reuses whichever series backend already exists.
- **Honest state** — unknown is grey not green; "no active show" is "—" not 0; a filter always
  declares what it hides; a zero-filled bucket rather than a line drawn across a gap.
- **No new dependency** proposed, and the one requested is costed rather than refused.
