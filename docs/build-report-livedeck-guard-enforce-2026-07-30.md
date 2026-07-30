# Build report — (c)-enforce: the liveDeck GUARD, + rogue-loader hunt, + two-column threshold

**Date:** 2026-07-30 · **State:** built, bench 35/35, `tsc --noEmit` at baseline. **No bump, no commit, no
build** — awaiting authorisation.

**Justification, from live air:** two incidents on 2026-07-30 — `16:35:10 → 16:35:51` (**46.0 s**) and
`16:37:24 → 16:38:14` (**50.6 s**) — each put two songs on air simultaneously on station 4. Both ended only
because the Bug-A guard happened to catch deck A on its next real rotate. Nothing in the engine would
otherwise have stopped them: the deferred stop is armed only by `handleRotate`, so a deck started outside the
chain is invisible to it. The observation phase did exactly its job — it named the fault, and now the fault
has a measured cost.

---

## 1. (c)-enforce — `audiod/engine.js`

**Same placement, same derived grace.** The only behavioural change is that the guard now acts.

| | Observer (4.4.105) | Guard (this build) |
|---|---|---|
| Placement | `poll()` `:298`, after the deck-state rebuild, before any decision work | **unchanged** |
| Grace | `(segueOverlap + crossfadeDuration) × 1000 + 1500` = 7500 ms | **unchanged** |
| Foreign set | `_foreignPlayingDecks` — A/B/C only, `[]` when `liveDeck` unknown | **unchanged** |
| Past grace | log only | **log + STOP the foreign deck(s)** |

`_liveDeckObserverTick` (`engine.js:1334-1406`). The stop:

```js
this._advance("liveDeck-guard", async () => {
  for (const d of targets) {
    if (d === this.liveDeck) continue;                     // it became live legitimately
    if (this._deckState(d).status !== "playing") continue;  // already stopped
    if (this.liveDeck !== live) continue;                   // a rotate landed — it owns the decks now
    this._stop(d);
    this.deckReady.delete(d);
    this.endTriggered.delete(d);
  }
});
```

Five properties, each deliberate:

1. **On the advance chain.** `_advance` serialises it with preload/rotate exactly like the Bug-A deferred stop
   — it can never land mid-rotate.
2. **Re-checked under the chain.** The world can move between the tick and our turn; all three conditions are
   re-tested before any stop. Covered by bench 12f.
3. **`liveDeck` is never a target** — by construction in `_foreignPlayingDecks`, and again in the loop.
4. **CART is never a target** — `_foreignPlayingDecks` iterates `["A","B","C"]` only.
5. **`deckReady`/`endTriggered` cleared alongside**, matching the Bug-A guard, so a nulled Rust source is never
   left marked "ready" (the stale-ready → silent `source=None` play).

It also now emits `error {where: "liveDeckGuard"}` so the Health Monitor sees it, the same way `play-skip`
does — the log is no longer the only place this surfaces.

**Why a legitimate segue can't trip it, arithmetically:** a normal overlap ends when the deferred stop fires at
`crossfadeDuration × 1000 + 500` = **3500 ms**. The guard's grace is **7500 ms** — more than twice as long, and
both numbers derive from the same two settings, so they move together if either is changed.

### Bench — `audiod/smoke-seam-stop.js`, 27 → **35 tests, all pass**

The five original Bug-A cases are untouched and still pass. New coverage, in the two shapes you named:

- **Legitimate overlap, inside grace — untouched.** Three probes: at the start, at the deferred-stop moment
  (`cf + 500 ms`), and one tick before the grace expires. All assert nothing logged and **no stop issued**.
- **Foreign past grace — stopped.** Asserts the anomaly line, that it says `STOPPING A`, that the stop ran
  **on the advance chain**, that the stopped deck is `["A"]`, that **the live deck C was never stopped**, and
  that `deckReady` was cleared.
- **Still not an actuator otherwise** — never plays, never loads, never rotates.
- **CART is never foreign**, even when playing.
- **A rotate between tick and turn cancels the queued stop** (12f) — the guard abandons rather than fighting a
  rotate it lost the race to.
- Re-log throttle, clear-line, and the never-throws contract retained.

## 2. Rogue-loader hunt (read-only) — the evidence now points at one sender

**Every path that can reach `audio:load` / `audio:play`:**

| Sender | Site | Reaches the daemon? |
|---|---|---|
| Renderer engine — post-rotate preload | `engine-rodio.ts:549-556` → `preloadDeck` `:584` → `loadToDeck` `:670` | yes, via `audio:load` (`main.js:3059`) |
| Renderer engine — chain/advance load | `:575`, `:599`, `:759`, `:765` | yes |
| App startup / station switch | `App.tsx:1395`, `:1600`, `:1748`, `:1769`, `:1794`, `:1862` | yes |
| Remote command (`play`) | `App.tsx:1097` → `dcmd("play", {deck:"A"})` | yes, daemon-direct |
| Operator UI hand-loads | `JockStrip.tsx:63/67/71`, `DeckConfigurator.tsx:368/554`, `Widgets.tsx:186`, `App.tsx:1162/1897/3270/3399` | yes |
| Daemon's own chain | `engine.js` `_load`/`_play` | in-chain — not rogue |

**Which fired at 16:37:23-25 — the operator rows are the receipt.** `generated_schedule.source='operator'`
(written by `_writeOperatorLogRow` ← `noteManualCue` ← every inbound `load`, `ether-audiod.js:107`):

```
id=184691  created 16:35:05.579   "Jingle Bell Rock - John's Version"   ┐ pair, 1.248 s apart
id=184692  created 16:35:06.827   "Holiday Road - 2024 Remaster"        ┘
id=184693  created 16:37:23.793   "Candy Christmas"                     ┐ pair, 1.239 s apart
id=184694  created 16:37:25.032   "Spot_Free_Christmas…"                ┘
id=184695  created 16:43:16.630   "Holiday Road - 2024 Remaster"
```

**All five are on station 4. Zero on stations 1, 2 or 3.**

Three things converge on the renderer's in-process engine:

1. **Station 4 is the only station with `is_active = 1`** — the only one whose renderer `AudioEngine` is
   `init()`-ed (`App.tsx:1084-1086`: non-active stations' engines "are created but never init()-ed"). The
   operator rows appear on exactly that station and nowhere else.
2. **The pair signature matches the renderer's post-rotate preload exactly.** `engine-rodio.ts:547-556`:
   ```js
   const nearDelay = (this.crossfadeDuration * 1000) + 800;
   setTimeout(() => this.preloadDeck(X, 0), 800);
   setTimeout(() => this.preloadDeck(Y, 1), nearDelay);
   ```
   Two loads separated by `nearDelay − 800`. **At the shipped default that is exactly 1.24 s** — matching both
   observed pairs to within 10 ms.
3. **`preloadDeck` early-returns when `daemonDriven`** (`:585`). It ran. **Therefore station 4's renderer
   engine has `daemonDriven === false`** — it is running its own advance in parallel with the daemon, which is
   precisely the two-brains diagnosis from `station4-vs-working-stations-diff-2026-07-29.md`.

**What this still does not prove:** that the renderer *initiated* it rather than relaying a remote command,
and *why* `daemonDriven` resolved false. Both need the `[ROT]` line, which still writes to a path that does
not exist in a packaged install (`main.js:3299`) — **authorised, still unbuilt, and now the highest-value
remaining diagnostic.** The guard bounds the damage; it does not close the source.

## 3. Two-column threshold — measure the panel, not the window

**My error, corrected.** `HealthMonitor.tsx:10-38`:

- `TWO_COL_MIN_PX` **1000 → 820** (sections' comfortable minimum ~360 + the 460 terminal column).
- `useTwoColumn()` now returns `[ref, wide]` and measures **the panel's own element** via `ResizeObserver`,
  falling back to a window listener where that is unavailable. The ref is attached to the panel root
  (`:512`).

The ~950 px Station Health popout now resolves to **two columns**. It also means the docked panel decides for
itself when it is resized without the window changing at all — which the old window-based check could not see.

## Blast radius

- **§1 is live-air daemon code** — the advance path on four stations, no staging. This is the second change to
  this area for a two-decks bug; the first (2026-07-22 Bug-A hardening) exists because an earlier edit here
  caused the 2026-07-21 OF incident. Mitigations: additive placement unchanged from the observation release
  that has now run for a day; the stop is on the advance chain; three re-checks before acting; a grace twice
  the width of a real overlap; and 35 bench assertions including the "must not touch a legitimate overlap"
  case. **The failure mode if I am wrong is a music deck stopped that should be playing** — audible
  immediately. Watch the first hour for any `liveDeck GUARD` line that is *not* accompanied by an inbound
  `load` in the same window.
- **§3 is renderer display only.**
- **§2 changed nothing** — read-only.

## Not built

- The `[ROT]` repair (§2's blocker).
- (a) effective-overlap clamp and (b) observed-condition stop, from the no-floor family.
- The auto-fitter.
- The `_schedCursor` shared-across-stations bug (`loggen.js:185`).
- The renderer duration-mixing / frozen-countdown defect — still open; the Live Activity poll has not been
  ruled out as an aggravator (the one-minute test: close Station Health, watch two songs).

## Gates

```
node audiod/smoke-seam-stop.js        → ✅ ALL PASS (35 passed, 0 failed)
./node_modules/.bin/tsc --noEmit      → 2 accepted-baseline errors only (OnboardingFlow, PhoneDesk)
```

## Files

```
audiod/engine.js                  :298 call-site comment · :1334-1406 guard (log + chain stop)
audiod/smoke-seam-stop.js         +8 assertions (27 → 35)
src/components/HealthMonitor.tsx  :10-38 container-measured breakpoint · :512 ref
```
