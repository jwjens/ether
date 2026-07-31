# MANUAL mode dead air on halloVeen — traced, named, and the contract that does not exist

**Date:** 2026-07-31 · **Mode:** READ-ONLY. Daemon log, rotation.log, source and Rust read. Nothing changed.
**Verdict:** **not the 4.4.114 crash.** A separate, reproducible fault with a complete causal chain.
**Severity:** this is the top reliability item for the OV manual season. A jock shift runs on these buttons.

---

## 1. What was running — 4.4.115, daemon-attached

| | |
|---|---|
| Installed | **4.4.115.0** — the corrected build **is** installed |
| Staged daemon | `%LOCALAPPDATA%\Ether\engine\audiod\` holds **autofit.js** (21:26 Jul 30) — the staging fix worked |
| Playout mode | `[ROT] daemon-driven: local advance DISABLED, mirroring ether-audiod` (17:32:55Z, last mode line before the wedge) |

**No in-process fallback, no MODULE_NOT_FOUND, no leftover 114 state.** The daemon was attached and healthy —
s2 was rotating normally right up to the moment MANUAL was pressed.

## 2. The wedge, from the log

```
17:47:17  segue: deck C LIVE — I'm In Love With a Monster      ← automation running fine
17:48:22  cmd automationStop station=2
17:48:22  [engine s2] _started: true → false (automation stopped)
          ⟵ ⟵ ⟵  THREE MINUTES.  NOT ONE LINE FOR s2.  THIS IS THE DEAD AIR.  ⟶ ⟶ ⟶
17:51:28  cmd automationStart station=2                         ← toggle 1
17:51:32  automationStart: decks claim playing but output is SILENT (observed) — NOT adopting
17:51:40  cmd automationStop / automationStart                  ← toggle 2
17:51:44  automationStart: decks claim playing but output is SILENT (observed) — NOT adopting
17:52:12  cmd automationStop → 17:52:58 automationStart         ← toggle 3
17:53:03  cmd automationStop / automationStart                  ← toggle 4
17:53:12  automationStart: decks claim playing but output is SILENT (observed) ×3
17:53:12  automationStart: deck A LIVE — Heads Will Roll        ← finally sounding
```

**The jock's deck-play press left no trace at all.** Not "a command that failed" — a command nothing logged,
because in MANUAL the engine that would log it is switched off.

## 3. Root cause — `automationStop` empties the decks and kills the poll loop

`audiod/engine.js` `stop()`:

```js
stop() {
  this._started = false;
  if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }   // ← the eyes close
  if (this._procMeterTimer) { clearInterval(this._procMeterTimer); this._procMeterTimer = null; }
  this._stop("A"); this._stop("B"); this._stop("C");                              // ← the decks are emptied
}
```

`_stop` → `A.audioStop` → Rust (`native/src/audio.rs:532-539`):

```rust
AudioCmd::Stop(deck) => {
    playing_decks.remove(&deck);
    loaded_files.remove(&deck);                       // the file is forgotten
    if let Some(sink) = sinks.remove(&deck) { sink.stop(); }   // the sink is destroyed
}
```

So the instant MANUAL is pressed, **all three decks have no source.** Pressing play then reaches the daemon —
the handler is ungated, `play: (m) => A.audioPlay(m.deck, m.stationId)` (`ether-audiod.js:107`) — and Rust
answers (`native/src/audio.rs:791`):

```
[RUST] Play deck B: source=None, path empty — skipping
```

**That line is in the live log.** Play is accepted, and plays nothing.

### Why the UI said "playing"

`src/audio/engine-rodio.ts`, `getDeck(id).play()`:

```js
play: () => {
  else if (deckId === "A") this.stateA = { ...this.stateA, status: "playing" };   // OPTIMISTIC, local
  …
  return invoke("audio_play", { deck: deckId, stationId: this.stationId });
}
```

The renderer marks the deck playing **before** the command goes out, and never checks the result. Normally the
daemon's `onDeck` event corrects a wrong guess within a second — **but `stop()` cleared `pollTimer`, and
`_maybeEmitDeck` only runs from `poll()`.** No poll, no events, nothing to contradict the guess.

**Three failures compounding: the deck is empty, the play silently no-ops, and the UI has been blinded.**

## 4. What the four toggles did

Each AUTO press is `automationStart` → `start()` → `refillIfNeeded()` → `loadToDeck(A, …)` → `_play("A")`.
**The load is the part that matters** — it puts a source back on a deck that `stop()` had emptied.

It took four because each cycle raced itself: the log shows `watchdog: STALL — no deck playing` firing between
toggles, `automationStop` landing 2 ms after an `automationStart` (17:51:32.786 → .788), and the
silent-while-playing detector refusing to adopt decks that claimed to play but produced no samples
(`decks claim playing but output is SILENT (observed) — NOT adopting; force-starting a fresh deck` — six
times). Cycle 4 finally completed a load-then-play without being interrupted.

**The detector is the honest part of this story.** It correctly refused to adopt silent decks every time. What
it could not do is put content back on a deck the operator was trying to drive by hand.

## 5. The MANUAL-mode contract — there isn't one

**MANUAL is not a mode. It is the absence of automation**: one boolean, `_started`, plus a `stop()` that tears
down the engine's poll loop and empties every deck. Nothing was ever built for a jock to drive by hand through
the daemon.

What actually works with AUTO off and the daemon attached:

| Action | Works? | Why |
|---|---|---|
| **Cart fire** | ✅ **Yes** | CART is a separate Rust slot; `stop()` never touches it. *This is why the cart played and the deck did not.* |
| **Mic** | ✅ Yes | Never goes through the engine at all. |
| **Deck stop** | ✅ Yes | Stopping an already-stopped deck is a no-op; the command reaches Rust. |
| **Deck LOAD then play** | ⚠️ **Probably** | A load restores the source, so a play should sound — but the UI still flies blind (no deck events), so position/duration are the renderer's guesses. **Untested; do not promise it.** |
| **Deck play (no load)** | ❌ **No — dead air** | The deck was emptied by `stop()`. Play is accepted and skipped. |
| **Deck ON buttons** | ❌ **No** | Same path, same empty deck. |
| **UI truth in MANUAL** | ❌ **No** | Poll loop cleared → no `onDeck` events → position, duration and status are unverified renderer guesses. |

**Naming the wedge: `automationStop` performs a full engine teardown when the operator asked only to stop
automating.** Everything downstream follows from that one conflation.

## 6. The requirement

> *"manual mode needs to be fully functional for live djs"* — Jeff, 2026-07-31

That is a build, not a patch, and it starts from a decision I should not make alone: **what does MANUAL mean?**

My reading, for your approval — **MANUAL should stop the engine from *deciding*, not stop the engine from
*running*:**

1. **`stop()` must not empty the decks.** Stop automating; leave the decks loaded and whatever is playing
   playing. A jock pressing MANUAL mid-song expects the song to keep going.
2. **The poll loop must keep running.** It is what makes deck events, position and the silent-while-playing
   detector work. Only the *deciding* parts — end-detection, auto-rotate, refill, watchdog-recover — should be
   gated on `_started`. (The §3 choke point from the renderer-as-pure-view work is the same shape: one decision,
   not scattered guards.)
3. **A play on an empty deck must be honest**, not silent. Rust already detects it (`source=None … skipping`);
   that needs to reach the operator as a refusal, and the UI must not claim "playing" when the engine refused.
4. **The renderer must stop guessing.** `getDeck().play()` setting `status: "playing"` optimistically is only
   survivable while events flow to correct it. That is the same defect class as the deck-state mixing already
   documented in `docs/design-renderer-as-pure-view-2026-07-30.md`.

**Blast radius, stated early:** this touches `stop()` on the live-air path for all four stations, and MANUAL is
what the OV season runs on. It wants a design of record with the contract written down, then a build — not an
edit to `stop()` today.

## 7. What I have not verified

- **Whether LOAD-then-play works in MANUAL.** The chain says it should; I have not tested it, and the
  contract table above says so rather than guessing.
- **Whether the same wedge hits the other three stations.** The mechanism is station-independent (it is
  `stop()`), so it should — but only halloVeen was observed.
- The `[RUST] source=None` lines are inherited stderr and carry no timestamp, so they cannot be pinned to the
  exact minute. They name deck B, and the observed press was deck A — the same skip path, a different press.

## Scope note

Read-only. Daemon log, rotation.log, `audiod/engine.js`, `audiod/ether-audiod.js`, `src/audio/engine-rodio.ts`
and `native/src/audio.rs` read. Nothing changed, nothing built, no command issued to the daemon.
