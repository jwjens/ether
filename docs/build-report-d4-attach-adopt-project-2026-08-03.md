# Build report — D4: attach → adopt → project (cold-start slice 1)

**Date:** 2026-08-03 · **Design:** `docs/cold-start-contract-design-2026-08-03.md` §D4
**Gates run:** `tsc --noEmit` baseline · **9 benches 262/262** (incl. new `smoke-deck-snapshot` 19/19) ·
`verify-packaged` PASS. **No bump, no commit, no build.**
**SLICE GATE NOT YET RUN — it is a COLD-CACHE launch, and only Jeff can run it (§ Gate below).**

---

## The bug, precisely

`attachDaemonEvents()` only **subscribes**. Deck events are emitted by the daemon solely **on change**
(`_maybeEmitDeck`), and the generic full-state broadcast at `ether-audiod.js:236` is explicitly skipped
for stations that have an automation engine — which is all four here. So a renderer that attaches late
subscribes to a stream that then says nothing until the next track change.

**Attach and populate were separate steps.** Miss the attach window and the content is never requested
again — the panels stay empty until the app is restarted, when a warm daemon answers instantly. **That is
the entire "close and reopen once" ritual**, and the 2026-08-03 launch receipt (queue and decks empty on
first launch) is it.

## What shipped

### 1 · `emitDeckSnapshot()` — `audiod/engine.js`

Re-emits A/B/C unconditionally through the **existing** `deck` event, with a payload identical to
`_maybeEmitDeck`'s (`{...st, scheduledAt, contentClass}` + `ready`), so every existing listener applies
it with no new plumbing.

**Source is the ENGINE's own deck state** — duration set by `_setDeckTrack` — **never raw Rust
`DeckInfo`.** `audio_get_state` carries no `position_sec`/`duration_sec`; a snapshot built from it paints
0:00 on every deck. That is the 4.4.104 regression I shipped and Jeff had reverted in 4.4.106, and the
bench fails if anyone reintroduces it (case 4, two ways).

It also refreshes `lastFired`/`lastReady`, so the re-emit cannot make the following poll double-fire.

### 2 · `deck:snapshot` command — `audiod/ether-audiod.js`

`"deck:snapshot": (m) => getEngine(m.stationId).emitDeckSnapshot()`. Safe at any time — it only re-emits
current state, issues no deck command, and cannot affect audio.

### 3 · `adoptFromDaemon()` — `src/audio/engine-rodio.ts`

Pulls **queue + deck snapshot as ONE unit**, on **first attach** and on **every re-attach** (including
after a daemon respawn). Emits `ether:queue-changed` and a new `ether:daemon-adopted` event.

### 4 · Bounded-backoff attach retry

The fixed 5 s window is gone. `scheduleAttachRetry()` runs **250 ms → 2 s** (doubling), with a **120 s
ceiling that is a runaway stop, not a deadline**. The old piggyback on the 250 ms poll
(`++pollN % 20 === 5`) is removed.

**Why no constant** — measured on this box: the staged engine is **24 files, 307.1 MB**, copying in
**539 ms with a WARM cache**. That is the warm floor on a fast local disk. The failing case is the
opposite — first boot after an update, cold page cache, and on a managed box that scans every byte
(OV/McAfee) it is a different order of magnitude. Any constant taken from the warm number would be a
guess dressed as a measurement, failing exactly where it matters.

### 5 · `attachState` — the UNKNOWN substrate for D3

`"unknown" | "daemon" | "in-process"`, exposed as `daemonAttachState`. It stays **`"unknown"` for the
whole retry** — the engine never claims in-process until it actually gives up. D3 consumes this.

## What I deliberately did NOT snapshot

**CART / jingle.** I wrote a `jingle` re-emit, then removed it. The overlay rides its own event as a
transient **arm/fire/bridge lifecycle** (`_emitJingle`) — there is no "current jingle" field, and the
`this.jingleState` I reached for **does not exist**. Emitting an invented `"idle"` would be a claim the
engine never made. An adopting renderer picks the overlay up at the next arm, at most one seam away.

## Bench — `audiod/smoke-deck-snapshot.js`, 19 assertions

Real `DaemonEngine`, no audio/DB/daemon. All three decks emitted with no change required · the loaded
track's duration/class/ready survive · **an empty deck reports empty honestly** (duration 0, not the
neighbour's; contentClass null, not guessed) · **regression guard both ways** — `_state()` is never
called at runtime *and* the method body contains no `_state(` at all · the re-emit doesn't double-fire
the next poll · idempotent across repeated re-attaches.

## One bench correction, disclosed — and it was NOT my code

Running the suite, `smoke-deck-identity` case 7 failed. **The code was correct** — a direct check
confirmed `_setDeckTrack`'s real body contains no `_state()` call. The guard's END marker was a literal
`"\n  }\n"`, which **never matches in a CRLF file**; it had been landing at an unrelated later offset, so
the "body" swallowed half the file. It passed only by accident of where that offset fell — inserting
`emitDeckSnapshot` above `_maybeEmitDeck` moved it, and the guard fired on correct code. Now
CRLF-tolerant (`/\r?\n  \}/`).

**This is the third line-ending scoping bug in this family of source-scan guards** (two in
`smoke-generate-chunk` earlier today). The pattern is fragile and each instance has cost a false FAIL —
worth standardising on a shared helper rather than fixing a fourth.

## THE SLICE GATE — cold cache, not a warm relaunch

Per Jeff, and restated so it cannot be softened:

1. **Make the stage genuinely cold** — clear `%LOCALAPPDATA%\Ether\engine`, or install a fresh build.
2. Launch **once**.
3. **Queue and decks must fill on that FIRST launch, with no restart.**
4. Decks must show correct **titles and running countdowns** — a populated deck with 0:00 is the
   regression, not a pass.
5. **A warm relaunch does not count.** The warm copy is 539 ms — nowhere near the failure window, so a
   warm run would pass a broken implementation.

## Files

```
audiod/engine.js               emitDeckSnapshot() — re-emit A/B/C via the existing deck event
audiod/ether-audiod.js         "deck:snapshot" command
src/audio/engine-rodio.ts      adoptFromDaemon() (queue + deck snapshot, one unit, every attach)
                               · scheduleAttachRetry() bounded backoff · attachState UNKNOWN
audiod/smoke-deck-snapshot.js  NEW — 19 assertions
audiod/smoke-deck-identity.js  CRLF-tolerant guard scoping (bench fix, not a code change)
```

## Not built (deliberately)

D2 (assert monitors to 0) and D3 (indicators from `attachState`) are the next slice, per the approved
order. The daemon is untouched in lifecycle terms — `deck:snapshot` only re-reads and re-emits state it
already holds, and issues no audio command.
