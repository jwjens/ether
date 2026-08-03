# AUTO-XFADE as a safety control — contract trace

**Date:** 2026-08-02 · **Mode:** READ-ONLY. Source read; no edit, no build.
**Contract (Jeff, requirements):** XFADE in AUTO is a SAFETY control — skip to the next track NOW
without leaving AUTO. (1) current track crossfades out, cued track takes over immediately;
(2) automation absorbs it; (3) deck state truthful throughout; (4) rapid repeated presses safe.

**Path:** `App.tsx handleXfade` → `engine.deckCrossfade()` → daemon `deck:crossfade`
(`ether-audiod.js:191`) → `intentCrossfade` (`engine.js:1300`) → `handleRotate` → deferred stop +
preload re-arm.

---

## Two corrections to the carried-forward assumptions, before the clauses

**1. `handleRotate` IS serialized.** The prior session recorded it as "UNSERIALIZED — clause 4 unmet,
same shape as the 07-21 OF incident." That is **wrong**. `handleRotate` wraps its entire body in
`_advance("handleRotate", …)`, and `_advance` is a promise chain:

```js
_advance(where, fn) { this.advanceP = this.advanceP.then(async () => { … await fn() … }); return this.advanceP; }
```

Rotate bodies therefore run strictly one after another, serialized with preload and the deferred stop.
**Clause 4 is not met by luck, but it is not met the way that note implied either — see §4.**

**2. The box is on 4.4.119, not 4.4.120.** `Ether.exe` ProductVersion reads **4.4.119.0**. The
identity-keyed deck-state fix is built and committed but **not installed**, so clause 3 cannot be
runtime-verified on this machine as it stands, and any live XFADE test right now exercises the *old*
identity behaviour.

---

## Clause 1 — "the current track crossfades out, the next takes over immediately"

**Met on "takes over immediately." NOT met on "crossfades out" — and for a safety control the gap is
the wrong way round.**

```js
this._play(toId);                                    // incoming starts NOW
const cfMs = this.crossfadeDuration * 1000;          // 3000
setTimeout(() => this._advance("stop:" + fromId, …_stop(fromId)…), cfMs + 500);   // outgoing stops 3.5s LATER
```

There is **no fade**. Automation never moves a fader by design ("automation NEVER moves a deck fader —
those are operator controls"). So the outgoing track **keeps playing at full level for 3.5 seconds**
alongside the incoming, then cuts.

**Why that matters for a SAFETY control specifically:** the stated purpose is "skip to the next track
NOW, for any reason." The reasons an operator hits it in an emergency — profanity, a wrong track, a
dead/garbled file — are all reasons the current audio must come **off**, not linger for another 3.5
seconds under the new one. As built, XFADE is an *overlap-then-cut*, which is right for a musical segue
and wrong for a panic button.

**This is the clause that needs a decision, not just a fix:** does safety-XFADE cut the outgoing
immediately (or fade it over ~250-500 ms), while the routine automatic segue keeps its 3 s overlap? They
are currently the same code path with the same constant.

## Clause 2 — "automation absorbs it and keeps rolling"

**Substantially met.** Inside the same serialized rotate:

| Requirement | Where | State |
|---|---|---|
| preloads re-arm | `setTimeout(preload(X), 800)` + `setTimeout(preload(Y), cfMs+800)` per target | ✅ |
| end-detection tracks the NEW live deck | `_play(toId)` sets `this.liveDeck = toId` (`:254`); `checkEnd` runs per deck each poll | ✅ |
| no double-advance | `deckReady.delete(toId)`, `endTriggered.delete(toId)`, `segueTriggered.delete` in `_play` | ✅ |
| queue consumed correctly | `manualCue` decks don't dequeue; auto-cued do | ✅ |
| log-reader continues | `refillIfNeeded()` — **only in the `toId === "A"` branch** | ⚠️ |

**The one gap:** the immediate `refillIfNeeded()` is only wired into the `toId === "A"` branch. Rotating
to B or C waits for `_maintain()`'s `queue.length < 5` trigger on a later poll. **Not a stall** — the
queue is deep and `_maintain` runs every tick — but it means "the log-reader continues from the
skipped-to position" happens on the next maintenance pass rather than as part of the skip. Worth making
symmetric so the behaviour doesn't depend on which letter you land on.

## Clause 3 — "deck state truthful throughout"

**Structurally met as of 4.4.120 — and that is inference from code, not a runtime receipt.**

`handleRotate` sets only two fields on the incoming deck:

```js
this._setDeck(toId, { status: "playing", positionSec: 0 });
```

Title, duration and contentClass are **not** touched by the rotate — they are whatever the deck's
**preload** established. In 4.4.120 that is `_setDeckTrack`, which replaces the whole identity set
atomically, so an operator rotate inherits a correct identity by construction and the rule holds
through it.

**Two honest caveats:**
- **4.4.120 is not installed** (§ correction 2), so on the running box the rotate still inherits
  whatever the old load path left — the exact defect the reproducer found.
- The `positionSec: 0` reset is correct, but `durationSec` is untouched by the rotate. That is right
  *provided* preload set it. If a deck were ever rotated into without a proper load, the countdown would
  be wrong again — which is what the play-skip guard exists to prevent, and it is benched.

## Clause 4 — "rapid repeated presses are safe"

**Defended, but by a guard written for something else, and the operator is told the wrong thing.**

`handleRotate`'s body is serialized, but `intentCrossfade`'s **decision** is not — it reads deck state
and resolves `playing`/`target` synchronously, *before* queuing. Under a rapid double-press:

```
press 1 → intentCrossfade: playing=A, target=B (B ready)   → queue handleRotate(A,B) → returns TRUE
press 2 → intentCrossfade: playing=A STILL (chain not run) → queue handleRotate(A,B) → returns TRUE
          both rotates now on the chain
rotate 1 runs → plays B, deckReady.delete(B)
rotate 2 runs → spurious-end guard: liveTo(B).status === "playing" → return   ← the save
```

**So a hammered XFADE does not double-rotate** — the spurious-end guard at the top of `handleRotate`
absorbs it:

```js
if (liveTo?.status === "playing" || otherPlaying) return; // spurious-end guard
```

**Three things are still wrong with that, in ascending order of importance:**

1. **`intentCrossfade` returns `true` for a rotate that will no-op.** The renderer is told the skip
   succeeded when it was silently dropped. For a safety control, "I pressed it and nothing happened and
   it said OK" is the worst possible feedback.
2. **The defence is incidental.** The spurious-end guard exists for *spurious end-detection*, not for
   operator double-presses. Nothing states the intent, and nothing benches the double-press case, so a
   future edit to that guard could remove the protection without anyone noticing.
3. **A press during the 3.5 s stop window resolves against half-applied state.** Press 2 arriving after
   rotate 1 completes but before the deferred `stop:A` fires sees A still `playing` in Rust — so
   `playing` may resolve to **A** again (the outgoing) rather than B. The guard then catches it via
   `otherPlaying`, but the *decision* was made against a deck that is on its way out.

**Verdict: clause 4 holds today, and it holds for reasons nobody wrote down.** That is exactly the
condition the 2026-07-21 OF two-decks incident arose from.

## The MANUAL question — decide it, don't inherit it

`handleRotate` is **not** gated on `_mayDecide()`, so XFADE rotates in MANUAL too. Per Jeff that is
probably wanted — the skip button should work in both modes — but the consequence needs stating:

**A rotate in MANUAL re-arms automation's preloads.** `handleRotate`'s tail schedules `preload(X)` and
`preload(Y)`, and `preload` (`:783`) has **no mode gate** — only idempotence and status checks. So one
XFADE in MANUAL cues two decks from the queue, which is automation behaviour inside the mode whose
contract is "nothing automated fires."

**That is a genuine contract collision between two approved designs**, and I am flagging rather than
resolving it. The plausible readings:
- **Operator rotate is an operator action; cueing the next tracks is a courtesy** → keep it, and amend
  the MANUAL contract to say so.
- **MANUAL means nothing auto-cues** → gate the preload tail on `_mayDecide()`, and the jock cues decks
  by hand as the manual-mode contract already describes.

I lean to the second — it matches "the jock owns the hour" — but it is Jeff's call, and it changes what
XFADE does in MANUAL.

---

## Design — against the contract

**Blast radius first: this is the rotate path, which caused the 2026-07-21 OF two-decks incident and has
been opened twice since.** Every change below is additive or narrowing; none alters the deferred stop,
the Bug-A guard, or the play-skip guard.

**A. Separate the SAFETY skip from the musical segue (clause 1).**
Give `intentCrossfade` an explicit "cut" character rather than inheriting `crossfadeDuration`: the
incoming starts immediately (unchanged) and the outgoing's stop is scheduled at a short
`SAFETY_CUT_MS` (~300 ms) instead of `cfMs + 500`. Same code path, same guards, one parameter carried
into the deferred stop. Automatic segues keep 3 s.

**B. Make clause 4 explicit instead of incidental.**
Serialize the *decision* with the rotate: resolve `playing`/`target` **inside** the advance chain rather
than before it, so press 2 reads post-rotate state and resolves honestly (or finds nothing to do).
Then return a truthful result to the renderer — `false`/`"already-rotating"` when the skip was absorbed
— so the UI can stop lying about it.

**C. Symmetric refill (clause 2).**
Call `refillIfNeeded()` on every rotate target, not only `A`.

**D. Decide MANUAL (above), then gate or document the preload tail accordingly.**

**Benches** — `audiod/smoke-xfade-contract.js`, in the shape of `smoke-seam-stop.js`:
1. Single XFADE: incoming plays, outgoing stops at the **safety** delay, `liveDeck` is the new deck.
2. **Double press within the window → exactly ONE rotate**, and the second returns a falsy/"absorbed"
   result rather than `true`.
3. Triple/hammer press → still one rotate; no `_play` on a third deck.
4. Press during the deferred-stop window → decision made against post-rotate state, no rotate back into
   the outgoing deck.
5. Deck identity survives the rotate — title/duration/class are the incoming's, position 0.
6. Preloads re-arm after an operator rotate; `refillIfNeeded` called for every target letter.
7. The play-skip guard still fires when the target has no source (regression).
8. MANUAL: whichever way D is decided, assert it explicitly.

## Scope note

Read-only. `App.tsx`, `audiod/engine.js`, `audiod/ether-audiod.js` read; installed version queried. No
file changed, nothing built. **Not claimed:** any runtime behaviour of 4.4.120, which is not installed.
