# Deck position — authoritative resync for the countdown and fill (design of record, 2026-07-29)

**STATUS: DESIGN ONLY — build after review.** No Health Monitor, no new sense, no temporary logging. This is the
UI's position source reading the authoritative value correctly.

---

## 1. Mechanism — confirmed in part, and one premise corrected

### Confirmed: the countdown runs on a LOCAL tick in daemon mode

`src/audio/engine-rodio.ts`, inside `poll()` (250 ms):

```js
const elapsed = (now - this.lastPollTime) / 1000;
const posA = (this.stateA.status === "playing") ? Math.min(this.stateA.positionSec + elapsed, durA || 9999) : this.stateA.positionSec;
…
this.stateA = this.daemonDriven ? { ...this.stateA, positionSec: posA } : { ...makeState("A", s.deckA), … };
```

Three facts, all load-bearing:

1. **`positionSec` is self-incremented from the wall clock**, not read from the engine — `positionSec + elapsed`.
2. **It is gated on the locally-held `status`** — `status === "playing"`. If `status` is stale, the tick keeps
   running against a track that has already ended.
3. **It is clamped** — `Math.min(..., durA || 9999)`. Once the local value reaches `durationSec`, **it stops
   moving and nothing lowers it again**. That is the frozen countdown, precisely.

In daemon mode the ternary preserves `status/title/durationSec` from deck events and overwrites **only**
`positionSec` — so between events the displayed position is *entirely* a renderer-side extrapolation with no
correction path.

**The fill sweep inherits this directly.** `ConsoleStrip.tsx:110-123` reads `engine.getDeck(id).getState()` on every
listener fire and drives `fill.style.transition = width ${remaining}s linear` from `durationSec - positionSec`. A
clamped position means `remaining === 0` forever — a stuck bar, from the same single stale number.

### Corrected: `_changed` does NOT suppress a steady playing deck

The brief's premise was that a steady "playing" deck produces no events. **The receipt says otherwise** —
`audiod/engine.js:471-476`:

```js
_changed(prev, next) {
  return prev.status !== next.status || prev.filePath !== next.filePath || prev.title !== next.title ||
    Math.floor(prev.positionSec) !== Math.floor(next.positionSec) ||        // ← ticks EVERY SECOND
    prev.durationSec !== next.durationSec || prev.volume !== next.volume;
}
```

`Math.floor(positionSec)` changes once per second on a playing deck, so `_maybeEmitDeck` (`engine.js:477-486`)
emits **roughly one event per second per playing deck**. A steady playing deck is the *most* talkative state, not the
quietest.

**Why this matters rather than being a footnote:** it means the design cannot rest on "events legitimately stop".
Something else is preventing those ~1/s events from reaching or being applied by the renderer — consistent with
`docs/deck-freeze-live-evidence-2026-07-29.md`, where the daemon was demonstrably emitting (segue, deck end, jingle
at 18:16) while the UI sat frozen.

**And that is exactly why the resync below is the right fix anyway.** The renderer currently has **no correction
path whatsoever** for `positionSec` — it depends 100% on an event stream arriving. Any interruption in that stream,
for any cause, freezes the display permanently with no recovery until the next track boundary. A periodic
authoritative pull removes that dependence and makes the display self-correcting **regardless of why the events
stopped** — which is the honest fix for a cause we have not yet named.

---

## 2. The fix — extend the existing resync, do not invent a mechanism

The pattern already exists in this class, three times over. `poll()`:

```js
if (this.daemonDriven && (++this.daemonQueuePollN % 20 === 0)) void this.resyncDaemonQueue();
```

— a **5 s** (20 × 250 ms) authoritative pull, daemon-gated, fire-and-forget. And on (re)attach:

```js
void this.resyncDaemonQueue();      // queue
void this.resyncDaemonEngineState();
void this.resyncDaemonDecks();      // decks
```

`resyncDaemonDecks()` (`engine-rodio.ts:287-320`) is the closest precedent and the place to extend. It already:

- calls `a.daemon("getState", { stationId: this.stationId })` (`:291`) — the daemon command
  `getState: (m) => JSON.parse(A.audioGetState(m.stationId))` (`ether-audiod.js:112`), i.e. the **Rust engine's own
  per-station deck state**, the authoritative source;
- unwraps `result` (`:292`);
- merges **one field only** into `stateA/B/C` (`:297-300`), today `volume`, with the comment:

  > *"Only the volume is merged — status/title/position stay owned by the onDeck event stream."*

That comment is the design decision to revisit. It was correct when the event stream was assumed reliable; it is
what leaves `positionSec` with no correction path.

### The change

**Two parts, both inside the existing resync.**

**(a) Merge the authoritative `positionSec` for playing decks.** Extend `resyncDaemonDecks()` to merge
`positionSec` (and `durationSec`, which anchors the clamp) alongside `volume` for any deck the daemon reports as
playing. Position becomes *observed* rather than extrapolated once every cycle; between cycles the local tick still
provides the smooth 250 ms motion the UI needs.

**(b) Run it on a periodic cadence, not only on attach.** Add a counter beside `daemonQueuePollN` in `poll()`, on
the same 5 s cadence and the same `daemonDriven` gate:

```
if (this.daemonDriven && (++this.daemonDeckPollN % 20 === 0)) void this.resyncDaemonDecks();
```

Worst-case drift becomes one resync interval (≤5 s) instead of unbounded, and a clamped position self-heals on the
next cycle instead of never.

### Why 5 s, and why merge rather than replace

- **5 s** is not a new number — it is the cadence `resyncDaemonQueue` already runs at, and the interval operators
  are already implicitly tuned to. A new number would be a new convention.
- **Merge, not replace:** the local tick must keep running for smooth sub-second motion; a 5 s replace alone would
  make the countdown lurch. The resync sets the truth, the tick interpolates between truths — the standard shape.
- **`status` stays event-owned.** Deciding a deck stopped from a poll would race the daemon's own end/advance
  sequencing (`engine s4: deck A ended → advance → stop:A`, 18:16:05-18:16:06). Position is a *measurement*; status
  is a *decision*, and the daemon owns decisions. This design deliberately corrects only the measurement.

### Cost

One extra `getState` per station per 5 s, on a command the renderer already calls at attach and which the daemon
excludes from its own logging as a routine poller (`ether-audiod.js:186`: *"pollers like getState/getLevels/getQueue,
which would drown the log"*). It is explicitly an expected-traffic command.

---

## 3. Every station identical

The resync lives in `AudioEngine`, whose instance is per station and whose `stationId` is passed on every daemon
call (`:291`). Running it from `poll()` means **every engine whose poll is running reconciles its own decks** — no
station-specific branch, no active-station special case, nothing keyed to the login-time station.

It composes correctly with the two fixes already in the tree:

- **HOP 4** (shipped 4.4.103) ensures the active station's engine is initialised, so its `poll()` runs and this
  resync runs with it.
- **The un-shipped `stop()`/teardown patch** stops engines being left behind, so a stopped engine's resync stops
  with it — as it should, since nothing is displaying it.

---

## 4. What this does not do

- **It does not explain why the events stopped.** It removes the *consequence* — a display that can never recover —
  not the cause. If deck events are still not being applied after this, the countdown will now be correct to within
  5 s while the underlying delivery problem remains, and that residual is worth knowing about.
- **It does not touch `status`, `title`, `filePath`, or the queue** — all still event-owned.
- **It does not touch the daemon, `_changed`, or `_maybeEmitDeck`.** The producer is provably fine.
- **No Health Monitor, no new sense, no temporary logging**, per the brief. (The `[DECKDBG]` instrumentation from
  earlier remains armed in the working tree and is still logged for teardown at the top of `docs/backlog.md` — it is
  unaffected by this design and should come out once you are satisfied.)
- **It does not change `ConsoleStrip`.** The sweep is a pure consumer of `positionSec`; correcting the source
  corrects the sweep. The separate re-arm-key defect (`ConsoleStrip.tsx:112`, duration-only key, all stations)
  stays untouched.

## Files this would touch

```
src/audio/engine-rodio.ts   resyncDaemonDecks() — merge positionSec/durationSec for playing decks (~:287-320)
src/audio/engine-rodio.ts   poll() — add the 5 s periodic call beside the existing queue resync
```

Two edits, one file, no new subsystem.

## Scope note

Design only — no code written for this. Nothing committed, nothing built.
