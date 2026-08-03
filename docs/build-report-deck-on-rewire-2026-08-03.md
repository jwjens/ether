# Build report — the deck ON rewire (ON is the only start control)

**Date:** 2026-08-03 · **Design:** `docs/auto-xfade-contract-trace-2026-08-02.md` §Design A–D
**Gates:** `tsc --noEmit` at baseline (2 pre-existing, OnboardingFlow + PhoneDesk — no new) ·
**smoke-xfade-contract 33/33 (new)** · deck-identity 22/22 · manual-mode 30/30 · seam-stop 35/35 ·
nearest-anchor 37/37 · autofit 47/47.
**No bump, no commit, no build.**

---

## What changed, in one line

**ON is now the only start control, and every start it issues goes through the daemon's serialized
advance chain.** XFADE is gone.

## The regression this closes

ON was a raw solo play. `App.tsx:3924` called `engine.getDeck(slot).play()` — `audioPlay` straight to
Rust, **outside the advance chain**: no serialization against rotate/preload/stop, no play-skip guard, no
stop of the outgoing, and no `liveDeck` update. That is the same out-of-chain start shape as the
2026-07-21 OF two-decks incident. Pressing ON on a cued deck while another deck played put **both** on
air, and `liveDeck` still named the old one, so end-detection tracked the wrong deck.

Jeff's premise going in was that ON already stopped the previous deck. It did not — that was traced and
surfaced before any edit.

## The three ON behaviours

| Deck state when ON is pressed | Now |
|---|---|
| Cued, **another deck playing** | serialized rotate — incoming live, outgoing off on the safety cut |
| Cued, **nothing playing** | guarded start on the chain (`reason: "started"`) — never a raw `audioPlay` |
| **Playing** | board-style channel OFF — audio off *now*, not pause |

All three run inside `_advance`, so ON can never interleave with automation's own rotate, preload, or
deferred stop.

## Daemon — `audiod/engine.js`

**`intentCrossfade(from, to)` decides INSIDE the chain.** The decision used to be made synchronously
before queuing, so two presses both resolved against pre-rotate state. It now resolves and acts within
one `_advance("operator-start", …)` and returns an honest `{ok, reason, from, to}`:
`already-live` · `no-target` · `target-not-cued` · `absorbed` · `started` · `took-over`.

**`intentDeckOff(deckId)`** — new, serialized: `_stop`, clear `deckReady`/`endTriggered`, clear
`liveDeck` if it was the live one, deck reads **idle**.

**`handleRotate` → `_rotateBody(fromId, toId, opts)`.** One rotate body, two callers (automation's segue
and the operator's ON). Guards unchanged — spurious-end, play-skip, the deferred Bug-A stop.

**`SAFETY_CUT_MS = 300` (design A).** `opts.cutMs` overrides the outgoing stop delay, so the operator's
skip cuts the outgoing at ~300 ms while a routine segue keeps its 3 s musical overlap — **same path, one
parameter**. The reasons an operator hits this in an emergency (profanity, wrong track, garbled file) are
all reasons the outgoing must come *off*, not linger under the incoming.

**`_armAfterRotate(toId, cfMs)`** — the preload/refill tail, extracted and fixed two ways:
- **symmetric `refillIfNeeded()`** on every target letter (design C — it fired only for `A`, so the
  log-reader continued from the skipped-to position on one letter in three);
- **gated on `_mayDecide()`** (design D, resolved the way I leaned in the trace): **in MANUAL the rotate
  fires but nothing auto-cues.** One ON in MANUAL used to cue two decks from the queue — automation
  behaviour inside the mode whose contract is "nothing automated fires." The jock owns the hour.

## Two defects the bench caught in my own implementation

Disclosed rather than quietly fixed, because both are the kind that pass a casual read:

**1. The double-press was still dishonest.** Moving the decision inside the chain was not sufficient.
The outgoing was resolved by scanning deck status — and **during the cut window both decks report
"playing"** (the outgoing hasn't reached its deferred stop). So press 2 resolved `playing` to the deck on
its way *out*, targeted the deck already live, and the spurious-end guard absorbed the rotate while
`intentCrossfade` returned `ok: true`. Exactly §4-point-3 of the trace. **Fix:** resolve the outgoing
from **`liveDeck`** — the authoritative on-air pointer — falling back to a status scan only when it is
null (cold start).

**2. A guard-absorbed rotate reported success.** `_rotateBody` returned `undefined` on both guard paths
and the caller assumed a rotate. It now **returns `true`/`false`**, and `intentCrossfade` reports
`{ok:false, reason:"absorbed"}` when the rotate did not happen. For a safety control, "I pressed it,
nothing happened, and it said OK" is the worst possible feedback.

## Renderer

`src/audio/engine-rodio.ts` — `deckOff(deck)` added alongside `deckCrossfade`.

`src/App.tsx` — the ON handler:

```js
onToggleOn={async () => {
  if (deck?.status === "playing") {           // board-style OFF
    if (eng.isDaemonDriven) await eng.deckOff(slot); else engine.getDeck(slot)?.stop();
    return;
  }
  if (eng.isDaemonDriven) {                   // start — always through the chain
    const r = await eng.deckCrossfade(undefined, slot);
    if (r && r.ok === false) console.warn(`[deck ${slot}] start not applied: ${r.reason}`);
    return;
  }
  engine.getDeck(slot)?.play();               // in-process only: no daemon chain to route through
}}
```

**XFADE removed** — button, `handleXfade`, `xfadeActive`, and the two dead props on `LivePanel`.
`xfadeDuration` / `autoXfade` stay: they still drive AUTO-X and `engine.crossfadeDuration`.

## Bench — `audiod/smoke-xfade-contract.js`, 33 assertions

Exercises the real `DaemonEngine` — no audio, no DB, no daemon.

**Case 1 is the headline regression:** `_advance` is wrapped and counted, and the bench asserts the first
`ADVANCE` precedes every `PLAY` — **ON can never issue a raw play**. Plus `liveDeck` follows the new deck,
which the old raw path never did.

Then: take-over stops the outgoing on the safety cut **and a routine segue at the same moment has not**
(the contrast that gives the number meaning) · double-press → one rotate, second returns
`ok:false/"already-live"` · five-press hammer → one PLAY, one success, no third deck · deck identity
survives the rotate (title/duration/position are the incoming's — the 4.4.120 rule holds through it) ·
play-skip guard refuses an uncued target · **MANUAL fires the rotate but preloads and refill stay
silent, with AUTO asserted as the contrast** · ON-on-playing = stop with the deck reading idle and
`liveDeck` cleared · cold start plays on the chain with nothing stopped.

**One bench correction, disclosed:** case 2 first waited 500 ms for the deferred stop, which lands at
`cutMs + 500` = 800 ms. The bench was wrong, not the code. Cases 3/4 failing, by contrast, **were** the
code — see above.

## Blast radius

**The rotate path — the one that caused the 2026-07-21 OF incident and has been opened twice since.**
Named honestly:

- `_rotateBody` is `handleRotate`'s body moved verbatim; automation's segue reaches it through the same
  `_advance("handleRotate", …)` wrapper, with `opts` absent → `cfMs` falls back to
  `crossfadeDuration * 1000`. **Automatic segues are byte-for-byte unchanged in timing.**
- The guards are untouched. The only additions are `return false` on the two paths that already returned.
- `_armAfterRotate` is new behaviour on two counts — refill on B/C (more refills than before) and the
  MANUAL gate (fewer preloads in MANUAL). Both benched.

**UNVERIFIED — runtime.** All of the above is what the source says and what the bench proves against the
real engine class. **No runtime receipt yet**, and the box is on 4.4.119, so the installed app has neither
this nor the identity fix. The one check that settles it: **in AUTO with a deck on air, cue another deck
and press its ON** — the incoming must go live, the outgoing must drop within ~300 ms, the deck strip must
show the new track's title and countdown, and the log must show `operator start` / `segue: deck X LIVE`
with no second deck playing. Then the same in MANUAL, confirming no deck auto-cues afterward.

## Files

```
audiod/engine.js               intentCrossfade (decision on-chain, honest result, liveDeck-resolved)
                               · intentDeckOff · handleRotate → _rotateBody(+verdict) · SAFETY_CUT_MS
                               · _armAfterRotate (symmetric refill, MANUAL-gated)
audiod/ether-audiod.js         "deck:off" command
src/audio/engine-rodio.ts      deckOff()
src/App.tsx                    ON handler rewired · XFADE button + dead state/props removed
audiod/smoke-xfade-contract.js NEW — 33 assertions, case 1 is the out-of-chain regression
```

## Not built (deliberately)

- **No help-doc entry yet** — the ON/XFADE change is user-facing and needs one before ship. Flagged, not
  written, since this release is unauthorized.
- **No fade on the safety cut** — it is a 300 ms cut, not a ramp. Automation never moves a fader by
  design; adding one would be the first exception to that rule and is Jeff's call.
- **XFADE's keyboard shortcut / any external trigger** — not audited for other callers of
  `deckCrossfade` beyond the ON handler.
