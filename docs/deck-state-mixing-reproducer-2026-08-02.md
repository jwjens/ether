# Deck state mixed across tracks — a one-click reproducer, and the §1/§2 trigger

**Date:** 2026-08-02 · **Mode:** READ-ONLY. Source and `rotation.log` read. Nothing changed.
**Supersedes the trigger question in** `docs/deck-state-mixed-across-tracks-2026-07-29.md` — that trace
found the mechanism in the renderer. **This one is in the daemon**, and it is reproducible in one click.

---

## The reproducer (live, halloVeen, MANUAL)

XFADE onto the deck holding an 0:11 Commercial Spot. The deck then shows:

| Field | Shows | Belongs to |
|---|---|---|
| title / artist | **Jack's Lament — Danny Elfman** | the new track |
| durationSec | **0:11** | the Commercial Spot it replaced |
| contentClass | **SPOT** (gold outline) | the Commercial Spot it replaced |
| positionSec | frozen at **0:11 / 0:11** | clamped against the stale duration |

**One deck, one action, three fields from two different tracks.** That is the whole bug in a single
screenshot, and it is now trivially repeatable — which is what makes it benchable.

## 1. Which fields refresh and which carry — confirmed

**`contentClass` rides the same carry as `durationSec`, and the gold outline is styling keyed to it.**

`deckContentClass[id]` is written in exactly **one** place — `audiod/engine.js:1123`, inside the daemon's
own `loadToDeck`:

```js
this.deckContentClass[id] = item.contentClass || null;   // clean-edges: SPOT decks never overlap
```

That is the **automation** load path. It is read on every deck event (`:544`) and stamped onto the
payload the renderer draws:

```js
this.emit("deck", { … state: { ...st, scheduledAt: …, contentClass: this.deckContentClass[id] ?? null }, ready });
```

**Nothing clears it, and no other path sets it.** A deck whose occupant changes by any route other than
the daemon's `loadToDeck` keeps the previous occupant's class — so the gold outline is not a rendering
bug, it is the daemon reporting a stale fact.

**`durationSec` carries for a different but related reason**, and this is the part the withdrawn §3 fix
got wrong: the daemon's own `poll()` re-imposes the previous tick's duration because **Rust has no
duration to read**. `DeckMeta::info` returns `{ id, status, title, artist, file_path, volume,
is_finished }` — no `duration_sec`, no `position_sec`
([[reference_daemon_getstate_no_position]]). So the daemon must carry it, and it carries it across track
changes with no identity check:

```js
audiod/engine.js  poll()
const dur = { A: this.stateA.durationSec, … };                        // previous tick
this.stateA = { ...makeState("A", s.deckA), durationSec: dur.A, … };  // fresh title, stale duration
```

**Same defect, same line shape, as `engine-rodio.ts:506-508` — in the daemon.**

## 2. Which branch — and this is the correction that matters

**The renderer is DAEMON-DRIVEN.** `rotation.log`, current session:

```
[2026-08-03 00:40:37] [ROT] daemon-driven: local advance DISABLED, mirroring ether-audiod
```

In daemon mode the renderer's poll takes the *other* side of the ternary — it only ticks `positionSec`
and never rebuilds from raw Rust. **So the renderer's mixing branch is not active, and the renderer is
not at fault here.** It is faithfully drawing what the daemon sent.

**The mixing lives in BOTH branches, independently:**

| | Carries `durationSec` | Carries `contentClass` |
|---|---|---|
| Renderer, in-process (`engine-rodio.ts:506-508`) | yes | yes (`deckContentClass`) |
| **Daemon (`engine.js` poll + `:544`)** | **yes** | **yes** |
| Renderer, daemon mode | no — mirrors the daemon | no — mirrors the daemon |

The 07-29 trace looked only at the renderer and concluded the defect was renderer-side. **That was
incomplete.** Fixing only the renderer would have left this exact screenshot unchanged, because in
daemon mode the renderer has no independent opinion to fix.

## 3. What XFADE actually does — traced, with one gap I am not going to paper over

```
XFADE (App.tsx:658)  →  isDaemonDriven → engine.deckCrossfade()
                     →  daemon cmd "deck:crossfade" (ether-audiod.js:191)
                     →  intentCrossfade(from, to)   (engine.js:1300)
                     →  handleRotate(playing, target)
```

**`handleRotate` rotates INTO an already-cued deck — it does not load.** It sets
`{ status: "playing", positionSec: 0 }` on the target and plays it. So the target's `durationSec` and
`contentClass` are whatever the *cue* left there.

**The gap:** I have not established how that particular deck came to hold Jack's Lament with the spot's
duration — whether it was cued by automation `preload` (which does go through `loadToDeck` and *should*
set both fields) or hand-loaded through the inbound `load` command (which calls `noteManualCue` and
**never touches `deckContentClass`**). The hand-load path is the one with the hole, and MANUAL mode is
exactly when it gets used — but **I have not proven that is what happened here**, and the fix below does
not depend on knowing.

## 4. The fix — this is §1/§2 of renderer-as-pure-view, and it now has a second site

**The contract, unchanged from the approved design:** *deck state is applied atomically per track
identity — title, duration, contentClass and position come from the SAME payload, and a value is carried
forward only when the identity is unchanged AND no fresh value exists.*

**What is new is that it must be applied in the daemon as well as the renderer**, and the daemon is
where it matters more, because in daemon mode the renderer only mirrors.

**Daemon side (the site this reproducer exercises):**
1. **Duration is sourced at load, keyed to identity.** `loadToDeck` already receives `durationMs`, and
   `getFileDuration` exists for when it does not. Store it against the deck's current `filePath`; carry
   it forward **only** while `filePath` is unchanged. A track change with no fresh duration must yield
   `0`/unknown, never the previous track's number.
2. **`contentClass` is set on EVERY path that changes a deck's occupant** — automation `loadToDeck`, the
   inbound `load` command, and any future one — and **cleared when unknown**. Never inherited. The
   simplest correct shape is to store it beside the identity rather than in a parallel map that nothing
   invalidates.
3. **`_setDeck` should not be able to produce a mixed state.** One function that takes a whole track and
   replaces the whole identity-bearing set, the way the renderer's `onDeck` handler already does.

**Renderer side (§1 as designed):** delete the carry-forward at `engine-rodio.ts:506-508` for the
in-process branch, and key any remaining carry on `filePath`.

**⚠ THE WITHDRAWN §3 LESSON, ON THE RECORD SO IT IS NOT REPEATED:** the first proposed fix said *"prefer
the fresh value from `makeState`, fall back to the carried value only when fresh is 0."* **Rust never
supplies a fresh duration — `makeState` yields 0 on every call — so that would have zeroed every
duration.** Any fix that reads duration from `audio_get_state` is wrong by construction. Duration comes
from the load, or from `get_file_duration`, and from nowhere else.

## 5. Bench — from this exact case

`audiod/smoke-deck-identity.js` (new), pure, no audio/DB/daemon:

1. **The reproducer:** deck holds `{title: "Commercial Spot", durationSec: 11, contentClass: "SPOT"}`;
   a new track `{title: "Jack's Lament", filePath: "jl.mp3", durationMs: 251000}` becomes its occupant →
   assert **duration is 251, not 11** and **contentClass is MUSIC, not SPOT**.
2. **Unknown duration on a track change** → assert `0`/unknown, **never** the previous track's value.
3. **Same track, no fresh duration** (the legitimate carry) → assert the duration is retained.
4. **contentClass cleared when unknown** → assert `null`, not inherited.
5. **The hand-load path** (`load` command → `noteManualCue`) sets both fields, not only the cue flag.
6. **`stateChanged`/`_changed` fires on a track change** — the frozen countdown was `_changed()` seeing
   nothing move once position clamped; assert an identity change always emits.
7. **Regression guard:** duration is never read from `audio_get_state` (the withdrawn §3 trap).

---

## Scope note

Read-only. `App.tsx`, `engine-rodio.ts`, `audiod/engine.js`, `audiod/ether-audiod.js` and `rotation.log`
read. No file changed, nothing built. **Not claimed:** the precise cue history of the deck in the
screenshot (§3), and any statement about how it sounds.
