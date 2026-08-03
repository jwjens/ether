# Build report — identity-keyed deck state (pure-view §1/§2)

**Date:** 2026-08-02 · **Design:** `docs/deck-state-mixing-reproducer-2026-08-02.md` §4
**Gates:** `tsc --noEmit` at baseline · **smoke-deck-identity 22/22 (new)** · manual-mode 30/30 ·
seam-stop 35/35 · nearest-anchor 37/37 · autofit 47/47. **No bump, no commit, no build.**

---

## The rule

**A deck's identity-bearing fields are replaced together, from one track. A value is carried forward only
while the identity is unchanged.** Title, duration, contentClass and position can no longer come from
different tracks, because no path sets them separately.

## Daemon — the site the reproducer exercises

**`_setDeckTrack(id, track)`** (`engine.js:323`) is now the only way a deck's occupant changes. It
replaces title, artist, filePath, duration, contentClass, schedule identity and position together, bumps
`deckGen` (the Bug-A invalidation) and clears `endTriggered`.

**Duration resolution, in order:** the caller's `durationSec`/`durationMs` → `getFileDuration(filePath)`
→ **0**. Never the previous track's number. An unknown duration is honest; a stale one freezes the
countdown.

**Both occupant-changing paths now route through it:**

| Path | Before | Now |
|---|---|---|
| automation `loadToDeck` (`:1173`) | already correct — set everything | `_setDeckTrack(id, item)` |
| **inbound `load` → `noteManualCue`** | **set `deckReady`/`manualCue` and nothing else** | `_setDeckTrack` with the loaded track |

**The second row is the bug.** That command is where *every renderer-initiated load lands in daemon
mode* — library drag, queue click, JockStrip, cart assign — so the deck kept the previous occupant's
duration and class while Rust supplied the new title. `ether-audiod.js:116` now passes the track it just
loaded (`title/artist/filePath/durationMs/contentClass`) rather than only the deck letter.

`noteManualCue` reads back from Rust for any field the caller omitted, so the identity is right even from
a bare call — but **never for duration**, which Rust does not carry (§ the withdrawn-§3 lesson).

**Poll carry, identity-keyed** (`engine.js:320`): duration survives a tick only while `filePath` is
unchanged; a different file yields 0 until the load path supplies one.

**`_changed` checks identity first** (`:530`): a `filePath`/`title` change **always** emits, before any
position arithmetic. The frozen countdown was position clamped at a stale duration so nothing in the
comparison moved and the UI stopped being told anything.

## Renderer — §1 as designed

`engine-rodio.ts:499-505` — the same identity-keyed carry for the in-process branch, and `contentClass`
keyed on `filePath` too (the gold-outline half of the same defect). Daemon mode never reaches this
rebuild; it mirrors the daemon, which is why the daemon fix is the one that matters for the reproducer.

## Bench — `audiod/smoke-deck-identity.js`, 22 assertions

Case 1 **is the reproducer**: a deck holding the 0:11 Commercial Spot, a new track loaded onto it →
duration **251 not 11**, contentClass **MUSIC not SPOT**, position reset, title and filePath the new
track's. Then: unknown duration → 0 never 11; `getFileDuration` fallback; class cleared when unknown;
**the `load` path sets identity, not just the cue flag**; a *playing* deck is never re-identified under
the operator; `_changed` fires on identity change with position unmoved; and the poll carry keyed on
filePath.

**Regression guard (case 7), two ways:** a behavioural assertion that duration comes from the load even
when `_state()` offers a `duration_sec`, **and a source scan asserting `_setDeckTrack` never calls
`_state()`**. Rust's `DeckInfo` carries no duration, so any future fix that reads it from
`audio_get_state` yields 0 on every call — that is exactly what made the withdrawn §3 fix wrong, and the
guard fails the bench if anyone repeats it.

**One bench correction, disclosed:** the source scan first used a fixed 1400-character window, which
overran into `poll()` — which legitimately reads `_state()` — and produced a false positive. It is now
scoped to the method body. **The bench was wrong, not the code**, but a guard that fails for the wrong
reason is worse than no guard.

## Blast radius

**Daemon deck state on all four stations.** `_setDeckTrack` is on the load path, not the audio path — it
issues no deck command and changes nothing about what Rust plays. The failure mode if wrong is a deck
displaying the wrong metadata, which is what it is fixing; it cannot cause silence or a double-play.

**One behavioural change worth naming:** `noteManualCue` now writes deck state where before it only set
flags. It refuses on a **playing** deck (benched), so it cannot re-identify something on air.

## Verification after install

The click that found it: **MANUAL → load a track onto a deck holding a spot → XFADE.** Title, duration,
class and countdown must all belong to the new track — no gold outline, no 0:11, countdown running.

## Files

```
audiod/engine.js               _setDeckTrack · loadToDeck + noteManualCue routed through it
                               · identity-keyed poll carry · _changed identity-first
audiod/ether-audiod.js         load command passes the track it loaded
src/audio/engine-rodio.ts      §1 identity-keyed carry (duration + contentClass), in-process branch
audiod/smoke-deck-identity.js  NEW — 22 assertions, case 1 is the reproducer
```
