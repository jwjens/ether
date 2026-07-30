# Build report — revert the deck position/duration re-anchor (4.4.106)

**Date:** 2026-07-30 · **Scope:** §5(i) of `docs/countdown-oscillation-regression-2026-07-30.md`. Reverts the
`resyncDaemonDecks` position/duration re-anchor added in **4.4.104 / commit `29640ef`**.
**Artifact:** `C:\openair\dist-electron\Ether Setup 4.4.106.exe` — built, signed. Not pushed, not installed.

---

## The bug being removed

`resyncDaemonDecks` re-anchored deck position from `daemon("getState")`. That command returns **raw Rust state**:

```js
audiod/ether-audiod.js:112     getState: (m) => JSON.parse(A.audioGetState(m.stationId)),
```

and Rust's per-deck payload has no position or duration in it at all:

```rust
native/src/audio.rs:82-92   DeckMeta::info → DeckInfo { id, status, title, artist, file_path, volume, is_finished }
```

So `makeState(id, ds)` (`engine-rodio.ts:60-61`, `s.position_sec || s.positionSec || 0`) returned
`positionSec === 0` on **every** call. The duration write was guarded by `> 0` and correctly skipped; **the position
write was not** — `typeof 0 === "number"` passes — so every 5 s the countdown was slammed to 0:00 and `poll()`
spent the next seconds climbing back. For the whole song, on **every daemon-driven station**, which is why the
stations that had been fine were the ones that broke.

## What changed — `src/audio/engine-rodio.ts`, three hunks, all removals

| # | Line | Change |
|---|---|---|
| 1 | `:139` (was) | Removed the `daemonDeckPollN` counter — it existed only to phase the re-anchor. |
| 2 | `:284-302` (was) | Removed the position/duration re-anchor block from `resyncDaemonDecks`, restoring the volume-only merge. |
| 3 | `:405-410` (was) | Removed the periodic `resyncDaemonDecks()` call from `poll()`. The method is one-shot on attach again (`:264`), as before 4.4.104. |

**Verified as an exact behavioural revert.** Comparing the method body against `29640ef^` with comments stripped:

```
$ diff <(git show 29640ef^:… | sed -n '/resyncDaemonDecks/,/^  }/p' | grep -v '^\s*//')  <(… current …)
11c11
< const vol = makeState(id, ds).volume;   // defaults to unity when the daemon omits it
---
> const vol = makeState(id, ds).volume;
```

The **only** difference is an inline comment relocated into the explanatory block above it. The executable code is
identical to pre-4.4.104:

```ts
const vol = makeState(id, ds).volume;
if (id === "A") this.stateA = { ...this.stateA, volume: vol };
else if (id === "B") this.stateB = { ...this.stateB, volume: vol };
else this.stateC = { ...this.stateC, volume: vol };
const st = id === "A" ? this.stateA : id === "B" ? this.stateB : this.stateC;
this.listeners.forEach(l => l(id, st));
```

`grep daemonDeckPollN src/audio/engine-rodio.ts` → no matches. `grep auth.positionSec dist/assets/index-*.js` → **0**
in the packaged bundle.

A comment block is left at both sites recording *why* the re-anchor could never work and what a correct version
would require — so this is not silently re-introduced.

## Blast radius — confirmed: audio cannot change

- **Renderer display only.** `resyncDaemonDecks` writes `this.stateA/B/C` and fires listeners. That is all it has
  ever done.
- **No deck command.** It issues no `load`, `play`, `pause`, `stop`, `setVolume` — it *reads* `getState` and merges
  the observed fader value into renderer state. Removing writes from it cannot send anything anywhere.
- **No daemon, rotate, stop or timing path touched.** `audiod/` is untouched by this change; the daemon's advance
  chain, deferred stop, segue and jingle timing are all byte-identical.
- **Removes one daemon round-trip per station per 5 s.** Strictly less traffic, never more.
- The visible change is that the countdown stops being reset every 5 s — i.e. the regression stops.

## What this deliberately does NOT do

- **Not built: candidate (ii)**, the drift-bound replacement. It needs a new daemon command exposing the
  `DaemonEngine`'s tracked deck state (the command table at `ether-audiod.js:105-165` has no such command today).
  Separate work, not bundled.
- **Not touched: the stale-duration animation bug** (`docs/deck-state-mixed-across-tracks-2026-07-29.md` §1-2). It
  is real and still unfixed. **Its §3 fix recommendation is withdrawn** — it assumed `audio_get_state` supplies a
  fresh `duration_sec`, and it does not. A corrected approach must source duration from
  `loadToDeck`/`get_file_duration` keyed to track identity. Not designed here.
- **Not touched:** the 4.4.105 liveDeck observer in `audiod/engine.js` (still uncommitted in the tree and included
  in this build), the double-play work, or anything in `(a)`/`(b)`.

## Gates

- `./node_modules/.bin/tsc --noEmit` → **exactly the 2 accepted-baseline errors** (`OnboardingFlow.tsx:2039`,
  `PhoneDesk.tsx:777`). No new errors; none in `engine-rodio.ts`.
- `node audiod/smoke-seam-stop.js` → unaffected by this change (daemon-side); last run **27 passed, 0 failed**.
- `npm run build` → clean. `npm run electron:build:win -- --publish never` → NSIS artifact signed.

## Honest note

This regression was mine. 4.4.104's build report claimed the resync bounded countdown drift; it was never verified
on air, and one grep of `DeckInfo` would have shown the source carried no position field. The claim should not have
been made without a runtime receipt.

## Files changed in this build

```
src/audio/engine-rodio.ts   −22 lines of logic (+ explanatory comments)
package.json                4.4.105 → 4.4.106
```

Also present in the working tree and therefore in this artifact, uncommitted from 4.4.105: `audiod/engine.js` and
`audiod/smoke-seam-stop.js` (the liveDeck observer, observation-only).

## Artifact

```
C:\openair\dist-electron\Ether Setup 4.4.106.exe
```

Not pushed, not installed, no tag. **Reminder: the audio daemon does not reload on auto-update — fully close and
reopen the app after installing.**
