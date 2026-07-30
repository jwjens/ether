# Build report — the reader's decisions are visible (+ Spot Schedule section)

**Date:** 2026-07-30 · **Scope:** logging + classifier only on the reader side; plus the Spot Schedule
section built earlier in the same session. **No bump** — this rides with the Spot Schedule release.
**Gates:** `tsc --noEmit` at baseline · `smoke-nearest-anchor` 37/37 · `smoke-seam-stop` 35/35.

**Trigger:** a duplicate "Soak Up The Sun" on station 1 — cued on deck C *and* listed in Up Next —
resolved itself, and **nothing appeared in Live Activity**. Warnings showed `0 shown of 800 buffered`;
Decisions didn't name it either. A self-correction that changes what will air is a decision.

---

## 1. Does `_refillFromLog` log its actions? — Partly, and the important one not at all

Every line the reader could write, before this change:

```
:811  logreader refill error: <e>
:821  LOG-READER FLOOR: log <mode> — emergency clock/on-format fill (never dead-air)
:838  LOG-READER: behind <N>m — stamped <N> skipped-past rows 'missed' (day-bounded)
:845  LOG-READER: ahead <N>m — next row plays early (never wait)
:871  logreader refill: <N> pending from log (mode=…, queue=…)
:883  LOG-READER: operator deck-load → wrote source='operator' log row "<title>"
```

**The dedup drop wrote nothing.** `engine.js:851`:

```js
if (it.schedId != null && seen.has(it.schedId)) continue;   // ← silent. No log, no event.
```

And the one summary line that does fire is a **count**, not a description — `19 pending` before and
after, with no statement of *what changed*. That is the exact gap you watched.

## 2. Is the classifier hiding them? — **Yes, and worse than expected**

Running the terminal's shipped regexes over the reader's own lines:

```
routine (HIDDEN)   LOG-READER FLOOR: log exhausted — emergency clock/on-format fill (never dead-air)
routine (HIDDEN)   LOG-READER: behind 1m — stamped 1 skipped-past rows 'missed' (day-bounded)
routine (HIDDEN)   LOG-READER: ahead 3m — next row plays early (never wait)
routine (HIDDEN)   nearest-anchor: re-cued deck A to SPOT "…"
routine (HIDDEN)   LOG-READER: operator deck-load → wrote source='operator' log row "…"
DECISION           logreader refill: 19 pending from log (…)        ← only by accident, via /refill:/
WARNING            logreader refill error: …                        ← only via the generic /\berrors?\b/
```

**`LOG-READER FLOOR` — the log ran dry and the emergency fill took over, which is dead-air-adjacent —
was hidden by default.** So was the behind/missed catch-up, and so was my own `nearest-anchor` line,
which I should have checked when I added it. Only two of the reader's lines surfaced, and both by
coincidence of a generic pattern rather than intent.

## 3. The fix

### (a) The reconciliation now says what it did — `audiod/engine.js:869-891`

Inside the existing `if (oldPending !== newPending)` block (so it is already gated on a **real** change):

```js
const newIds = new Set(freshPending.map(q => q.schedId).filter(x => x != null));
const dropped = oldPendingItems.filter(q => q.schedId != null && !newIds.has(q.schedId));
if (dropped.length) …
  logreader reconciled: removed 1 row(s) from Up Next — "Soak Up The Sun" (already cued on a deck)
if (promoted) …
  logreader reconciled: nearest-anchor promoted "<title>" to the head of Up Next
```

**Why this cannot become 2 s noise:** it only names rows that were in the *previous pending region* and
are gone from the new one. The routine per-refill dedup of the currently-cued decks never changes the
pending region, so it never reaches this branch. Titles are capped at 4 with a `+N more` tail.

Note it also distinguishes the two reasons a row can vanish — `(already cued on a deck)` versus dropped
for any other reason — because "where did it go" is the operator's actual question.

### (b) The classifier tells the truth — `src/components/LiveActivityTerminal.tsx:30-40`

- **WARNING** gains `LOG-READER FLOOR` and `LOG-READER: behind` — the floor because it means the log ran
  out, the behind/missed line because rows were stamped `missed` and will not air.
- **DECISION** gains `LOG-READER`, `logreader`, `nearest-anchor`, and `liveDeck GUARD` (the guard was
  renamed from OBSERVER and the pattern had not followed it — a second thing that had gone quiet).

Verified against a table of 14 representative lines, every one landing where intended:

```
✅ all classified as intended
WARNING   LOG-READER FLOOR · LOG-READER: behind · refill error · TWO DECKS ON AIR
DECISION  LOG-READER: ahead · logreader refill · logreader reconciled (×2) · nearest-anchor
          · operator deck-load · liveDeck GUARD · deck B LIVE
routine   advance done preload · [mix] heartbeat
```

**And the default view is still quiet** — re-measured on 1,977 real lines from the live daemon log:
`routine 1748 · decision 218 · warning 11`, so Decisions still hides **88%**. Making the reader visible
did not make the terminal noisy.

## 4. Also in this release — the Spot Schedule section

Built earlier in the session, unchanged since: `src/lib/spotProjection.ts` (pure) +
`HealthMonitor.tsx` left column, near Live Events. Columns **Anchor · Projected · Fired · Drift**, this
hour and next, green ≤15 s / amber ≤60 s / red beyond, applied to *projected* drift as well as fired —
so a spot about to miss goes amber before it misses. `:00` rows are marked `⏻ · hard cut`.

Verified by running the real module against the live 11:19:50 case:

```
FLIPPED   anchor 11:19:50  proj 11:19:59  drift +9s     ok
LEGACY    anchor 11:19:50  proj 11:23:30  drift +3:40   error
```

Both correct: flipped promotes to the nearest seam, legacy honestly shows it stuck behind the cued song.

**Known duplication, stated plainly:** `spotProjection.ts` mirrors `loggen.orderForNearestAnchor` for
flipped stations. Two implementations of one rule drift apart. The permanent answer is the daemon
exposing its own projection (it already computes everything needed) and the renderer displaying it; this
renderer-side copy is the cheap version, and `TIE_SEC` is called out in both files as needing to stay in
step. **I would not leave this indefinitely.**

## 5. Blast radius

- **(a)** is two `_log` calls inside an existing conditional in `_refillFromLog`. It changes no queue, no
  deck, no rotate; it runs only on the flip path, so legacy stations are untouched.
- **(b)** is renderer display classification only.
- **The Spot Schedule section** reads `generated_schedule` read-only plus engine getters already exposed;
  it issues no command and writes nothing.

**Nothing in this release can affect what airs.**

## 6. Not verified

I have not seen the reconciliation line or the Spot Schedule table on screen. The classification is
proven against real log lines and the projection against the real 11:19:50 case, but neither has run in
the app. First install: switch Live Activity to **Decisions** and confirm the reader's lines now appear
beside rotates and stops — a `logreader refill:` at minimum, and `logreader reconciled:` the next time a
duplicate resolves.

## Files

```
audiod/engine.js                     :869-891  reconciliation lines (dropped rows / promotion)
src/components/LiveActivityTerminal.tsx  :30-40  WARNING + DECISION patterns
src/lib/spotProjection.ts            NEW — pure projection + drift banding
src/components/HealthMonitor.tsx     Spot Schedule section + poll
```
