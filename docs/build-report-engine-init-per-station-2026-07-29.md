# Build report — HOP 4: every active station's engine initializes

**Date:** 2026-07-29 · **File touched:** `src/App.tsx` (one effect, +13/−0)
**Status:** built + typechecked. **No bump, no commit, no build.** Awaiting GO.
**Source:** `docs/deck-fill-sweep-station-identity-trace-2026-07-28.md` — HOP 4, the primary defect.

---

## The defect

`engine.init()` lived only in the startup effect, deps `[accountSignedIn, wasOnAir]` (`src/App.tsx:1526`,
`:1664`). A station switched to **after** launch — the soft switch at `App.tsx:1940-1948`, no reload — therefore held
an `AudioEngine` on which `init()` had never run. `init()` is what starts the 250 ms poll and reaches
`detectDaemon()` → `attachDaemonEvents()` (`engine-rodio.ts:149-153`, `:167`, `:172`), so an uninitialised engine has
**no event source at all**: `engine.on()` returns a perfectly valid unsubscribe function and never fires.

Every consumer of that engine went quiet at once — the ConsoleStrip fill sweep, the position countdown, the deck
duration — and nothing threw, logged, or rendered an error. Station 1 worked because it is the login-time station.

## The fix — `src/App.tsx:1499-1512`

`engine.init()` added to the **display-subscription effect**, which is keyed `[engine]` and already re-runs whenever
the active station changes (that is how `deckA/B/C` follow the switch today).

```js
useEffect(() => {
  engine.init();                       // ← added
  setDeckA(engine.getDeck("A")?.getState?.() ?? null);
  …
  const unsub = engine.on((id, st) => { … });
  return () => unsub();
}, [engine]);
```

### Why this placement and not the two alternatives

**Cannot double-init.** `init()` is idempotent by construction: `if (this.pollTimer) return;`
(`engine-rodio.ts:150`) and `detectDaemon` guards on `daemonDetectStarted` (`:161`). Re-running it on every engine
change cannot start a second poll timer, cannot re-attach daemon events, cannot re-run daemon detection.

**Cannot leak an engine.** This effect does not *create* engines — `getEngine` already did that on first use. It
initialises only the engine the app is actively using, one at a time as the operator switches.

**Rejected — adding `engine`/`stationId` to the startup effect's deps (`App.tsx:1664`).** That effect also owns
**crash-only auto-resume** (`:1532-1545`: `if (readAutoAdv(stationId) && accountSignedIn && wasOnAir === true)` →
`autoStartTimer` → `startDaemonAutomation()`). Re-running it on every station switch would re-evaluate that
auto-start against the station just switched to. On a machine where `wasOnAir` is true, switching stations could put
the new station on air by itself. That is a live-rotation hazard for a fix that only needs a poll timer started.

**Rejected — calling `.init()` inside `getEngine` (`engine-registry.ts:11`).** Structurally tempting (it would also
cover popout renderers, see below) but it initialises engines that are merely *looked up*, not used. In the
**in-process fallback** — daemon not connected, which is a real field state per the known cold-start race — every
initialised engine runs end-detection in `poll()` against the single global native engine. Two initialised engines
would both detect the same track end and both advance. The daemon path is safe (`poll()` returns early:
`if (this.daemonDriven) return;  // daemon owns end-detection + advance`), but the fallback is not, and I am not
willing to introduce a double-advance path into rotation for this.

## Answer to the HOP 1 question: in play, but not the cause here — and this fix does not need it

**HOP 1 is real.** `useActiveStation` resolves `{ id: 1 }` with `ready = true` when `stations:get-active` returns no
row (`src/hooks/useActiveStation.tsx:60-70`), falls back to `{ id: 1 }` again in its `catch` (`:71-73`), and the hook
returns `station?.id ?? 1` (`:115`). Any of those paths hands **every** consumer engine 1 — silently, with no error
state. Since the same resolver feeds both the fill engine and SHOW PROGRESS, a wrong id shows up as both at once.

**But it is not what breaks a switched-to station.** A successful switch resolves the correct id and fires
`"station-switched"`, which the hook listens for (`:105-113`) and re-resolves. The engine the app then holds is the
right one — it has simply never been initialised. That is HOP 4, and **HOP 4 alone is sufficient** for the reported
symptom. This patch does not depend on HOP 1 being fixed.

**Where HOP 1 still bites, unfixed here:** no signed-in account, an IPC failure, or a station lookup returning
nothing — the app carries on against engine 1 as though that were the answer. It produces the *same* symptom class
(wrong engine) from a different cause, so it will look like a regression of this fix when it is not. The trace's
recommendation stands: make that fallback an explicit loading/error state, never a wrong id. **Not built here** —
it changes first-run and signed-out routing, which is account-gate territory.

## Known limits, stated rather than discovered later

1. **Popout renderers are still uncovered.** `StandaloneDecksPanel` and the decks popout call `useAudioEngine()` →
   `getEngine()` (`src/audio/AudioEngineContext.tsx:35-38`) in a window where `App.tsx` never mounts, so no effect
   ever calls `init()` there. Those windows have this defect for **every** station, before and after this patch.
   Fixing it needs either the registry approach (with the in-process hazard resolved first) or an equivalent
   `init()` in the popout tree.
2. **Engines are never torn down.** There is no `stop()`/`dispose()` on `AudioEngine` — no `clearInterval(this.pollTimer)`
   anywhere in `engine-rodio.ts`. After visiting N stations, N poll timers run for the session. In daemon mode each
   is cheap (it only advances `positionSec` locally between daemon events). In the in-process fallback, more than
   one initialised engine is the double-advance hazard described above — pre-existing in shape, now reachable by
   visiting two stations. **This is the one thing to watch**, and the clean answer is a `stop()` paired with the
   switch, or scoping in-process end-detection to the active station. Neither is built here.
3. `ConsoleStrip`'s duration-only re-arm key (`ConsoleStrip.tsx:112`) is untouched, per instruction — that is the
   per-track collision, affecting all stations, and is a separate fix.

## Typecheck

```
$ npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: …
src/components/PhoneDesk.tsx(777,21): error TS2345: …
```

**PASS — the 2 standing baseline errors only. Zero new, none in `App.tsx`.**

## Architecture compliance

- **"A station is a shell over one implementation."** After this, the engine backing a switched-to station is
  initialised on exactly the same path as the login-time station's — same poll, same daemon subscription, same
  listener delivery. No station-specific branch exists in this path.
- **`CLAUDE.md` — "Correct minimal solution … name what you're deliberately NOT building."** One line of behaviour in
  one effect. Not built: the registry-level init, `AudioEngine.stop()`, the HOP 1 fallback, popout coverage, and the
  ConsoleStrip re-arm key.
- **`CLAUDE.md` — "The only valid test of a UI fix is launching the app and seeing the actual screen."** Not claimed
  fixed. What to look for: switch to a non-login station with a track playing — the fill should sweep and the
  countdown should tick, identically to the login-time station.
- **Nothing contradicted the trace.** Every line it cited was found as recorded, including the idempotency guards
  that make this placement safe.
