# Build report — Release 1 of 3: the Spot Schedule board actually computes

**Date:** 2026-07-30 · **Scope:** the shipped-but-dead Spot Schedule projection. **Display only.**
**Gates:** `tsc --noEmit` at baseline · `smoke-autofit` 47/47 · `smoke-nearest-anchor` 37/37 ·
`smoke-seam-stop` 35/35. **No bump, no commit, no build.**

**Reported symptom:** "the spot schedule window just looks unresponsive" — every PROJECTED and DRIFT cell
reading `—`. It was not stale. It had nothing to compute with.

---

## 1. The queue mirror was dropping the two fields the walk needs

`src/audio/engine-rodio.ts:266-271`, before:

```ts
this.queue = m.items.map((it: any) => ({
  filePath, title, artist, durationMs, chainType, qid,   // ← no contentClass, no scheduledAt
}));
```

The daemon sends both (`loggen.toItem` carries `contentClass` and `scheduledAt`), and the renderer threw
them away. So `item.contentClass === "SPOT"` was **never true** in the renderer — the projection could
not find a single spot in the queue, and every cell fell through to `—`.

Both fields are now carried, and the queue type at `:90` declares `contentClass`.

**This is the defect I should have caught before shipping.** I verified the arithmetic against the real
11:19:50 case and it was correct — but I never checked that the renderer's queue carries the fields the
walk depends on. Correct maths on absent data.

## 2. `projectSpots` was asking the wrong question

It only placed a spot when `wouldPromote()` returned true. That is a **promotion** predicate — "would
the nearest-anchor selector jump this spot ahead?" — not a **projection**. Any anchor out of reach got
no answer at all, which is most of them.

Rewritten as a **walk** (`src/lib/spotProjection.ts`): step through the queue accumulating durations and
place every pending spot where it will actually air. Promotion is now a **modifier** that can move a
spot *earlier* on a flipped station, never the gate. On legacy a spot simply waits its turn, which is
the honest truth of legacy.

**Anything past the end of the visible queue gets a lower bound, not a blank** — `projectedAt` = the
queue end with `beyondQueue: true`, rendered `≥ 2:29:29`. It can only get later, so if the bound is
already past the anchor that is a real warning.

## 3. Verifying against the live queue found two more wrong answers

Reconstructing exactly what the board computes, from the live DB and the daemon's own pending rows:

**First run — computing, but two rows lying:**

```
2:00:00 PM   2:04:39 PM    pending   +4:40     error  ⏻ hard cut     ← WRONG: the cut fires this exactly
2:38:41 PM   ≥ 2:28:46 PM  pending   ≥ −9:55   error                  ← WRONG: a bound we can't see past
3:00:00 PM   ≥ 2:28:46 PM  pending   ≥ −31:14  error  ⏻ hard cut
```

- **A top-of-hour anchor is fired by the hard cut, not reached by the queue.** Walking the queue to it
  produces a meaningless "late" — the cut pre-empts whatever the walk predicted. Now projected **at its
  anchor**, drift `0`, which is what actually happens and why these land exact.
- **A lower bound EARLIER than the anchor carries no information.** It does not mean the spot airs
  early, only that we cannot see that far yet. Reporting it as a confident negative painted a red
  `−31:14` on a spot that is perfectly fine. Now `driftSec = null` → grey `unknown`.

**After both fixes, against live data:**

```
ANCHOR       PROJECTED        FIRED        DRIFT
1:00:00 PM   —                1:00:00 PM   on time    ok       ⏻ hard cut
1:20:33 PM   —                1:23:03 PM   +2:30      error              ← the miss you watched
1:39:43 PM   1:41:45 PM       pending      +2:02      error              ← WARNING BEFORE IT MISSES
2:00:00 PM   2:00:00 PM       pending      on time    ok       ⏻ hard cut
2:20:23 PM   2:25:45 PM       pending      +5:22      error              ← and this one too
2:38:41 PM   ≥ 2:29:29 PM     pending      —          unknown            ← honest "can't see that far"
3:00:00 PM   3:00:00 PM       pending      on time    ok       ⏻ hard cut
```

**The `1:39:43` row is red while the spot has not aired yet.** That is the section doing the one job it
exists for. `1:20:33 · +2:30` is the miss you reported, now on the board as history rather than a
mystery.

**What I cannot claim:** I have not seen this rendered. The projection is verified against the live
queue as reconstructed from the daemon's own pending rows, which is the same input the renderer walks —
but the final confirmation is your eyes on the panel. If the reconstruction and the renderer's
`getQueue()` disagree, the board will differ from the table above, and that difference is itself worth
reporting.

## 4. Blast radius

Display only. `engine-rodio.ts` change is two extra fields carried on a queue mirror that is already
built from the daemon's event — no command, no write, no effect on playout. `spotProjection.ts` is pure.
`HealthMonitor.tsx` renders the `≥` prefix and the `· past queue` note.

## 5. Not in this release

- **Release 2** — the fitter observation hook (engine + health event + board surfacing of the fitted
  arrival). `audiod/autofit.js` and `smoke-autofit.js` (47/47) are built and benched but **not wired**;
  they ship with release 2 so the observation day runs against a board that works.
- **Release 3 (design only)** — rotation preferring the deck holding a due SPOT over letter order, from
  the 20:20:04 case.

## Files

```
src/audio/engine-rodio.ts     :90 queue type · :266-271 carry contentClass + scheduledAt
src/lib/spotProjection.ts     projectSpots rewritten as a walk · hard-cut anchors · lower-bound honesty
src/components/HealthMonitor.tsx  "≥" prefix, "· past queue" note
```
