# Build report — deck position authoritative resync

**Date:** 2026-07-29 · **File:** `src/audio/engine-rodio.ts` (only) · **Two edits, as designed.**
**Status:** built + typechecked. **No bump, no commit, no installer.** Awaiting your GO for the version build.
**Design:** `docs/deck-position-resync-design-2026-07-29.md`.

---

## What was wrong

In daemon mode `poll()` advanced `positionSec` from the wall clock and **clamped** it:

```js
const posA = (this.stateA.status === "playing") ? Math.min(this.stateA.positionSec + elapsed, durA || 9999) : …;
this.stateA = this.daemonDriven ? { ...this.stateA, positionSec: posA } : …;
```

Between deck events the displayed position was **entirely a renderer-side extrapolation with no correction path**.
Once the local value reached `durationSec` the clamp pinned it there permanently — the frozen countdown — and
`ConsoleStrip.tsx:110-123`, which drives the fill from `durationSec - positionSec`, froze with it at
`remaining === 0`.

`resyncDaemonDecks()` already pulled the daemon's authoritative state, but merged **volume only**, with the comment
*"status/title/position stay owned by the onDeck event stream."* That was the assumption that left position with
nowhere to recover from.

## Edit 1 — merge authoritative position — `engine-rodio.ts:294-327`

```js
const auth = makeState(id, ds);                        // the daemon's authoritative view
const cur  = id === "A" ? this.stateA : …;
const merged: DeckState = { ...cur, volume: auth.volume };   // volume: unchanged behaviour

if (auth.status === "playing" && typeof auth.positionSec === "number") {   // :314
  merged.positionSec = auth.positionSec;                                    // :315
  if (typeof auth.durationSec === "number" && auth.durationSec > 0) {
    merged.durationSec = auth.durationSec;             // anchors the clamp the tick applies  :317
  }
}
this.lastFiredState[id] = merged;                       // :325 — keeps poll()'s detector aligned
this.listeners.forEach(l => l(id, merged));
```

Four deliberate constraints:

- **Only when the DAEMON says the deck is playing** (`:314`) — the renderer's own possibly-stale `status` is not
  consulted for this decision.
- **Only the measurement.** `status`, `title`, `filePath` remain event-owned. Deciding a deck had stopped from a poll
  would race the daemon's own end/advance sequencing (`engine s4: deck A ended → advance → stop:A`, 18:16:05-06),
  and that is a decision the daemon owns.
- **`durationSec` rides along** because it is what the clamp is measured against — re-anchoring position against a
  stale duration would just move the freeze.
- **`lastFiredState[id]` is updated** (`:325`), the same discipline the `onDeck` handler already uses, so the resync
  cannot make `poll()`'s change-detector double-fire.

## Edit 2 — periodic cadence — `engine-rodio.ts:428-433`, counter at `:141`

```js
if (this.daemonDriven && (++this.daemonQueuePollN % 20 === 0))  void this.resyncDaemonQueue();   // existing
if (this.daemonDriven && (++this.daemonDeckPollN  % 20 === 10)) void this.resyncDaemonDecks();   // added
```

Same 20-tick (5 s) period and same `daemonDriven` gate as the queue resync it sits beside.

**`% 20 === 10` rather than `=== 0` is intentional** — it offsets the deck resync half a cycle from the queue
resync so the two daemon round-trips do not land on the same tick. Same cadence, staggered phase.

## Every station identical

The resync lives in `AudioEngine`, one instance per station, with `stationId` on every daemon call
(`a.daemon("getState", { stationId: this.stationId })`). Driving it from `poll()` means **every engine whose poll is
running re-anchors its own decks** — no active-station branch, no login-time special case.

It composes with what is already in the tree: HOP 4 (shipped in 4.4.103) ensures the active station's engine is
initialised so its `poll()` runs, and the un-shipped `stop()` patch stops a departed engine's poll — so its resync
stops with it, correctly, since nothing is displaying it.

## Cost

One extra `getState` per station per 5 s. The daemon explicitly classes it as routine traffic —
`ether-audiod.js:186` excludes `getState`/`getLevels`/`getQueue` from command logging *"which would drown the log"*.
The renderer already calls it on every attach.

## Typecheck

```
$ npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: …
src/components/PhoneDesk.tsx(777,21): error TS2345: …
```

**PASS — the 2 standing baseline errors only. Zero new, none in `engine-rodio.ts`.**

## What this fixes, and what it does not

**Fixes:** the display can no longer sit frozen indefinitely. Worst-case drift is now bounded at one resync interval
(≤5 s) instead of unbounded, and a position clamped at `durationSec` self-heals on the next cycle.

**Does not fix, and I want this on the record:** *why* deck events stopped being applied. Per
`docs/deck-freeze-live-evidence-2026-07-29.md` the daemon was demonstrably emitting (segue, deck end and jingle at
18:16) while the UI sat frozen, and `_changed` (`audiod/engine.js:471-476`) includes
`Math.floor(positionSec)` — so a playing deck emits roughly **once per second**, not rarely. Something is still
interrupting delivery or application, and this change makes the symptom self-correcting rather than removing the
cause. If the countdown now stays true but you ever see it lurch by several seconds, that lurch is the underlying
problem still there, made visible instead of frozen.

**Untouched:** the daemon, `_changed`, `_maybeEmitDeck`, `ConsoleStrip` (a pure consumer — correcting the source
corrects the sweep), and the separate `ConsoleStrip.tsx:112` duration-only re-arm key.

## Still in the working tree, not shipped

- The `[DECKDBG]` temporary instrumentation (`electron/main.js`, `engine-rodio.ts`) — **still armed**, teardown
  logged at the top of `docs/backlog.md`. This resync may make it unnecessary; it should come out either way.
- `AudioEngine.stop()` + the App-side teardown.
- The Show+ recording-UI changes (disabled button, destination-file wording, the "Phase 4" replacement).
- `package.json` at 4.4.103 with the 4.4.103 build already made.

## Files changed

```
src/audio/engine-rodio.ts   :141      daemonDeckPollN counter
                            :294-327  resyncDaemonDecks — merge authoritative positionSec/durationSec
                            :428-433  poll() — 5 s periodic re-anchor, phase-offset from the queue resync
```
