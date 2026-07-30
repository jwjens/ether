# Countdown oscillating 0:00 ↔ correct — what actually shipped, and what is causing it

**Date:** 2026-07-30 · **Mode:** READ-ONLY. Source read only. Nothing changed, nothing built, no patch applied.

---

## First, the correction that changes everything below

**The §3 animation fix was never built. `src/audio/engine-rodio.ts` has not been modified.**

```
$ git status --porcelain src/audio/engine-rodio.ts
(no output — file is clean)

$ git diff --stat src/audio/engine-rodio.ts
(empty)
```

Working tree carries only `audiod/engine.js`, `audiod/smoke-seam-stop.js` and `package.json` (the 4.4.105 liveDeck
observer). There is **no identity keying, no `loadGen`, no fallback condition** anywhere in the poll rebuild —
`grep` for them returns only unrelated comments and the pre-existing `auth.durationSec > 0` test inside
`resyncDaemonDecks`.

**So the oscillation is not the §3 fix misbehaving. It is a different, already-shipped change — and it is mine.**

## 1. The poll-rebuild duration logic as it is NOW — unchanged, verbatim

`src/audio/engine-rodio.ts:427-440`:

```ts
const durA = this.stateA.durationSec;
const durB = this.stateB.durationSec;
const durC = this.stateC.durationSec;

const posA = (this.stateA.status === "playing") ? Math.min(this.stateA.positionSec + elapsed, durA || 9999) : this.stateA.positionSec;
const posB = (this.stateB.status === "playing") ? Math.min(this.stateB.positionSec + elapsed, durB || 9999) : this.stateB.positionSec;
const posC = (this.stateC.status === "playing") ? Math.min(this.stateC.positionSec + elapsed, durC || 9999) : this.stateC.positionSec;

this.stateA = this.daemonDriven ? { ...this.stateA, positionSec: posA } : { ...makeState("A", s.deckA), durationSec: durA, positionSec: posA, contentClass: this.deckContentClass["A"] ?? null };
this.stateB = this.daemonDriven ? { ...this.stateB, positionSec: posB } : { ...makeState("B", s.deckB), durationSec: durB, positionSec: posB, contentClass: this.deckContentClass["B"] ?? null };
this.stateC = this.daemonDriven ? { ...this.stateC, positionSec: posC } : { ...makeState("C", s.deckC), durationSec: durC, positionSec: posC, contentClass: this.deckContentClass["C"] ?? null };
```

Byte-identical to what the 2026-07-29 diagnosis quoted. `durationSec: durA` is still unconditional.

## 2. What is the fallback condition? — **There isn't one. Nothing was built.**

No identity check, no fresh-value test, no conditional of any kind. The question "is it taking the fresh value
unconditionally?" has no subject: the line was never touched.

## 3. Does Rust report `duration_sec = 0` intermittently? — **No. It never reports it at all.**

This is the receipt that reframes the whole problem. `audio_get_state` (`native/src/lib.rs:129-157`) serialises
each deck via `DeckMeta::info` (`native/src/audio.rs:82-92`), which returns:

```rust
DeckInfo {
    id, status, title, artist, file_path, volume, is_finished
}
```

**There is no `position_sec` field and no `duration_sec` field in the payload.** So in `makeState`
(`engine-rodio.ts:60-61`):

```ts
positionSec: s.position_sec || s.positionSec || 0,   // → 0, always (key absent)
durationSec: s.duration_sec || s.durationSec || 0,   // → 0, always (key absent)
```

Raw Rust yields **0 for both, on every call, forever** — not intermittently. That is *why* both the renderer's
in-process branch and the daemon's own poll carry these two values forward instead of reading them; the daemon does
exactly the same thing (`audiod/engine.js:288-296`).

**This also means the §3 fix I proposed was wrong and would have made things worse.** "Prefer the fresh value from
`makeState`, fall back only when it is 0" would have preferred 0 on every tick. Good that it was never built; the
proposal is withdrawn and superseded by §5 below.

## 4. Is daemon mode affected? — **Yes, and ONLY daemon mode. That is why it is every station.**

The cause is `resyncDaemonDecks`, shipped in **4.4.104 (commit `29640ef`, "deck position authoritative resync")**,
which I wrote. It is gated on daemon mode and runs every 20 polls at 250 ms = **once every 5 seconds**:

```ts
engine-rodio.ts:416
if (this.daemonDriven && (++this.daemonDeckPollN % 20 === 10)) void this.resyncDaemonDecks();
```

Its source of "authoritative" truth is a daemon `getState` call — and `getState` returns **raw Rust**, not the
daemon engine's tracked state:

```js
audiod/ether-audiod.js:112
getState:  (m) => JSON.parse(A.audioGetState(m.stationId)),
```

So `auth = makeState(id, ds)` has `positionSec === 0` and `durationSec === 0` every time. Then
(`engine-rodio.ts:297-302`):

```ts
if (auth.status === "playing" && typeof auth.positionSec === "number") {
  merged.positionSec = auth.positionSec;                                   // ← 0. UNGUARDED.
  if (typeof auth.durationSec === "number" && auth.durationSec > 0) {
    merged.durationSec = auth.durationSec;                                 // ← guarded by > 0, correctly skipped
  }
}
```

**`typeof 0 === "number"` is true, so position is overwritten with 0.** Duration got a `> 0` guard; position did
not.

**That is the oscillation, exactly as described:**

1. Every 5 s the resync slams `positionSec` to **0** → the deck reads **0:00**.
2. `poll()` then advances position from the wall clock at 250 ms → it climbs back toward the true time over the
   next couple of seconds.
3. 5 s after the last resync it is slammed to 0 again. **For the entire song, on every daemon-driven station.**

Stations 1-3 were fine before because nothing was writing their position; 4.4.104 introduced a writer that writes
zero. The stations that "worked" are broken by the fix meant to bound drift on the one that didn't.

**Why it was not caught:** the change was reasoned about as "re-anchor position from the daemon's authoritative
view," and `getState` was assumed to be the daemon engine's view. It is the Rust addon's view, and the Rust addon
does not carry position or duration at all. That assumption was never verified against `DeckInfo` — a static check
that would have taken one grep. The build report claimed the resync bounded drift; **it was never verified on air**,
and that is the failure.

## 5. What the correction has to be

**The daemon's `onDeck` event stream is already the correct and only good source.** The daemon maintains position by
wall-clock accumulation in its own poll (`audiod/engine.js:288-296`) and emits the whole coherent state ~1/s; the
renderer's `onDeck` handler applies it atomically (`engine-rodio.ts:233-237`). Position and duration are correct
there.

**There is no daemon command that returns the engine's tracked deck state.** The full command table
(`ether-audiod.js:105-165`) offers `getState` (raw Rust), `getLevels`, `getQueue`, `getEngineState` (a
`live|stalled|off` string) — nothing exposing `DaemonEngine.stateA/B/C`. So the resync as designed had **no correct
source available**, and picked the wrong one.

Two candidate shapes, smallest first:

- **(i) Revert the position/duration re-anchor from `resyncDaemonDecks`** (commit `29640ef`), leaving the original
  volume-only merge that the method's own docblock still describes. This restores stations 1-3 to their pre-4.4.104
  behaviour immediately and removes the zero-writer. It gives up the drift bound — which was never verified to work
  anyway.
- **(ii) Then, if the drift bound is still wanted, add a daemon command that returns the ENGINE's deck state** (the
  same object `_maybeEmitDeck` emits) and re-anchor from that, with a `> 0`/identity guard on position as well as
  duration. That is a new daemon command plus a renderer change — bigger, and it should not be bundled with the
  revert.

**Recommendation: (i) alone, as its own release.** It is a revert of a known-bad writer, it is the whole of the
reported regression, and it should ship without anything else riding along.

**Note on the separate animation bug:** the stale-duration mixing described in
`docs/deck-state-mixed-across-tracks-2026-07-29.md` §1-2 is still real and still unfixed — but its §3 fix
recommendation is **withdrawn**, because it was written on the assumption that Rust supplies a fresh
`duration_sec`. It does not. A corrected approach has to source duration from `loadToDeck`/`get_file_duration`
keyed to track identity, never from `audio_get_state`. That is a separate piece of work and I have not designed it
here.

## Blast radius of the correction

Renderer display only. `resyncDaemonDecks` writes `stateA/B/C` and fires listeners; it issues no deck command and
touches no daemon, rotate, stop or timing path. Reverting it cannot change audio output. The visible change is that
the countdown stops being reset — i.e. the regression stops.

---

## Scope note

Read-only. Source and git state read; no file in `C:\openair` changed, nothing committed, nothing built, no patch
applied. **Awaiting authorisation.**
