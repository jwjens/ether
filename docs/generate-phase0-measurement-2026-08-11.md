# Generate Phase 0 — measurement and verdict

**Date:** 2026-08-11 · **Status:** MEASUREMENT ONLY — no product code written.
**Gates:** `docs/generate-worker-design-2026-08-11.md` §1 (the worker).

---

## 1. The telemetry does not exist. Correcting my own doc.

The design doc said `hourMs` "rides in every `schedule:generate-progress` payload and has never been
read", and framed Phase 0 as *reading* it. That implied it was retrievable. **It is not.**

| Where it could have been kept | Reality |
|---|---|
| `_genEmit` (`main.js:7279`) | `webContents.send` only — fire and forget, no disk |
| `GenerateProgressBar.tsx` | **never references `hourMs`** — the renderer discards it too |
| `health-events.jsonl` (32 MB) | no `generate` kind at all: queue-lint, library-health, logreader-*, position-authority, song-retracted, prefetch |
| `ether-startup.log` | `[schedule:generateDay] N tracks` — count only, no timing |

So `hourMs` is computed on every hour of every generate and consumed by nothing, anywhere. There is
no history to read. **That is a build-the-sense failure in its own right** — the number exists, costs
nothing, and evaporates.

## 2. What was measured instead

Read-only benchmark against the live DB (`scratchpad/bench-hour.js`, `bench-scale.js`), replicating
`stmtCandidates` (`main.js:6706`) **verbatim**. Nothing written.

This is a **proxy**: it measures the candidate query, which is the dominant per-slot cost, not the
whole hour slice (which also includes scheduler-core arithmetic, separation map lookups, and spot and
jingle handling). Treat it as a lower bound.

### 2.1 Current install — all four stations

| Station | Categories | Songs in categories | Music slots/hr | Query p50 | Query p95 | **Hour slice (p50)** | **Hour slice (p95)** |
|---|---|---|---|---|---|---|---|
| 1 Open Format | 10 | 163 | 17 | 0.13 ms | 0.44 ms | **2 ms** | 8 ms |
| 2 halloVeen | 2 | 152 | 20 | 0.31 ms | 1.18 ms | **6 ms** | 24 ms |
| 3 Magical Forest | 2 | 76 | 18 | 0.16 ms | 0.64 ms | **3 ms** | 12 ms |
| 4 Christmas in Jully | 1 | 46 | 23 | 0.11 ms | 0.21 ms | **3 ms** | 5 ms |

A full **7-day generate is 0.4–1.0 s of candidate SQL** across the whole run.

### 2.2 The scaling curve — this is the finding that matters

`ORDER BY RANDOM()` sorts the ENTIRE candidate set to choose one song. Cost is therefore linear in
category size. Measured at 477 rows: **4.0 µs per candidate row**.

| Songs in one category | Projected hour slice (20 slots) | Verdict |
|---|---|---|
| ~150 (today) | 2–6 ms | worker pointless |
| 1,000 | ~81 ms | borderline |
| **5,000** | **~404 ms** | **worker justified** |
| 10,000 | ~807 ms | worker justified |
| 50,000 | ~4,000 ms | unusable either way |

Competitor-scale stations (Zetta/WideOrbit) routinely run 10k–50k libraries. So the worker is not
wrong — **it is early**, and it is aimed at the wrong lever.

## 3. Verdict

**Re-scope the arc: extraction + fuel gauge + auto-generation. Drop the worker for now.**

On the current data the p95 hour slice is **5–24 ms**, far below the doc's own ~50 ms
"buys almost nothing" line and an order of magnitude below the 300 ms bar. Moving a 3 ms slice to
another thread is machinery without a user-visible gain.

**Two caveats, stated rather than buried:**

1. **The 17 s freeze of 2026-07-21 is NOT explained by this measurement.** At these library sizes the
   pick loop cannot produce 17 s — the whole 7-day run is ~1 s of candidate SQL. So the freeze had
   another cause, still unidentified. **Building the worker would not have fixed it**, and the design
   doc leaned on that incident as motivation. Whatever caused it is still there.
2. **The proxy excludes the arithmetic and the commit.** If the real `hourMs` comes back far above
   these numbers, the gap is in code this benchmark did not run, and that gap is itself the finding.

**Before the worker is ever revisited, fix `ORDER BY RANDOM()` instead.** Sorting 10,000 rows to take
a handful is the actual defect at scale; a worker just moves that waste to another thread while still
burning the CPU. Reservoir sampling, or a random-offset seek on an indexed rowid, would cut the large
library case by orders of magnitude and helps every caller — including the daemon's fill ladder,
which uses the same pattern.

**Trigger to revisit:** any customer library crossing **~2,000 songs in a single category**, or a
measured `hourMs` p95 above 300 ms.

## 4. The authoritative number is 30 seconds away, no build required

`hourMs` already reaches the renderer. In DevTools on the running app:

```js
const seen = [];
window.ether.on('schedule:generate-progress', p => {
  if (p.phase === 'hour') { seen.push(p.hourMs); console.log(p.day, p.hour, p.hourMs + 'ms'); }
});
// …run Generate for a week, then:
seen.sort((a,b)=>a-b);
console.log('n', seen.length, 'p50', seen[Math.floor(seen.length*0.5)], 'p95', seen[Math.floor(seen.length*0.95)]);
```

That produces the real distribution, including everything the proxy missed. If it disagrees with §2,
§2 is wrong and the verdict should be revisited.

## 5. Recommended follow-on (small, and independent of the arc)

**Persist `hourMs`.** One health event per generate carrying `{days, hours, p50, p95, maxHour}` —
so the next time this question is asked there is a year of history instead of a benchmark. It is
three lines beside the existing `_libHealth.noteGenerate` call, and it is the difference between
measuring and guessing.
