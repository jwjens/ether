# Build report — §3, the daemon-mode gate (renderer-as-pure-view, release 1 of 3)

**Date:** 2026-07-30 · **Scope:** §3 ONLY of `docs/design-renderer-as-pure-view-2026-07-30.md`.
**Nothing from §1 or §2.** No state writes deleted, no interpolator, no consumer changes.
**Gates:** `tsc --noEmit` at baseline · `smoke-seam-stop.js` 35/35. **No bump, no commit, no build.**

---

## Why this is the right first release

It is the **safety** property, not a display change. It removes the second brain and makes the mode
observable, and it touches **no rendering code at all** — so it cannot produce wrong numbers on screen. It
also pairs with the guard already committed in 4.4.109: the guard *bounds* a stray deck, this *prevents the
stray load*.

## 1. `daemonEnabled()` re-checked until true — TRUE latches, FALSE never does

`src/audio/engine-rodio.ts`.

**Before:** the decision was one-shot (`detectDaemon`). Whatever `daemonEnabled()` answered at init was final
forever, with no retry. Answer `false` because the socket wasn't up yet — the known cold-stage race — and the
engine ran its own advance for the life of the station.

**Now:**

- `detectDaemon()` (`:194-216`) records the daemon's answer in a **new, separate field**
  `daemonEnabledObserved`, and only latches `daemonDriven = true` on a `true`. A `false` logs
  *"will re-check every 5s"* and latches nothing.
- `recheckDaemon()` (`:220-234`) re-asks while not daemon-driven. **Only a `true` is acted on**; a `false`
  just means "ask again". On a late `true` it logs how long local advance had been running, attaches the
  event stream, and notes that any locally-started deck will be cleared by the daemon's liveDeck guard.
- Driven from `poll()` (`:414-416`), same low-frequency shape as the queue resync, and **only while not
  daemon-driven** — in daemon mode it costs nothing:

```ts
if (!this.daemonDriven && (++this.daemonDetectPollN % 20 === 5)) void this.recheckDaemon();
```

**The rule in one line: "not yet" is not "no".**

## 2. Single choke point — one decision, not six

`localAdvanceAllowed()` (`:236-252`) is now the only thing that decides whether this engine may drive itself,
and `poll()` (`:445-455`) is the only place it is consulted:

```ts
if (this.localAdvanceAllowed()) {
  this.checkEndByPosition("A", posA, durA, prevA, rustEndedA);
  this.checkEndByPosition("B", …);
  this.checkEndByPosition("C", …);
}
```

**Why this one gate covers the whole chain — verified, not assumed.** End-detection is the *sole* entry to
the autonomous path from the poll loop:

```
checkEndByPosition  :490          ← the only autonomous caller of…
  └─ handleRotate   :503,:509,:515   ← which is the only caller of…
       └─ preloadDeck  :549-556  ·  refillIfNeeded  :555,:571
```

The two other `preloadDeck` entries are **not** autonomous: `triggerPreload()` (`:633`, an explicit call,
already guarded `:634`) and `startAutomation`'s own path (`:774-776`, an operator/startup action). Neither is
reached from the poll loop.

**The six existing per-call-site guards stay** (`:490` end-detection, `:595` preload, `:615` refill, `:634`
triggerPreload, `:727` queue purge, plus `handleRotate` reachable only through the first) — belt-and-braces,
exactly as specified. The choke point makes them *unreachable* rather than merely *correct*.

## 3. The contradiction assertion

Inside `localAdvanceAllowed()`:

```ts
if (this.daemonDriven) return false;
if (this.daemonEnabledObserved === true) {
  if (!this.contradictionWarned) {
    this.contradictionWarned = true;
    rotLog(msg); console.error("[ENGINE] " + msg);
  }
  return false;      // refuse
}
return true;
```

The message names the station and states the diagnosis plainly:

> `[ROT] CONTRADICTION — daemon reports ENABLED but this engine (station N) is not daemon-driven. REFUSING local advance (this is the two-brains fault).`

Loud **once**, then refuses silently until `recheckDaemon()` resolves it. It goes to the `[ROT]` channel —
which as of 4.4.109 actually reaches disk (`userData/logs/rotation.log`) — and to the console.

**The two fields are deliberately separate.** `daemonEnabledObserved` is the daemon's own last answer;
`daemonDriven` is what this engine committed to. **Them disagreeing IS the fault**, so collapsing them into
one boolean would erase the very thing being detected.

## 4. Mode observable — Health Monitor, beside the engine row

`engine-rodio.ts:369-381` — `getPlayoutMode()` returns
`{ stationId, mode, daemonEnabled, contradiction, localAdvanceSec }`. A local getter; no IPC.

`HealthMonitor.tsx` — polled once a second (`:520-529`) and rendered directly under **Audio Engine** in Core
Systems (`:600-617`):

| State | Row reads | Status |
|---|---|---|
| daemon-driven | `Daemon-driven` — *mirrors ether-audiod, local advance disabled* | green |
| genuinely in-process | `In-process` — *station N owns playout (daemon off) — 42s* | amber |
| **contradiction** | **`IN-PROCESS — daemon is up`** — *running its own advance while the daemon reports enabled — two engines on one output. Local advance refused.* | **red** |

**Honest limitation, stated in the code:** only the **active** station has a renderer engine to report —
non-active stations' engines are created but never `init()`-ed (`App.tsx:1084-1086`). That is not a gap in the
row; it is the architecture, and it is precisely why station 4 was the only one affected.

## Blast radius

**Renderer only. No daemon change, no audio path change, no display change.**

- In **daemon mode** (all four stations today): the only difference is that `checkEndByPosition` is no longer
  *called* rather than being called and returning immediately at `:490`. Behaviour identical, one IPC every
  5 s avoided, and `recheckDaemon` never runs.
- In a **genuinely in-process install** (daemon off): `daemonEnabledObserved` is `false`, so
  `localAdvanceAllowed()` returns `true` and everything behaves exactly as before — plus one
  `daemonEnabled()` call every 5 s, which is a cached boolean in main (`main.js:3157`).
- The **only** new behaviour that changes playout: an engine that had been running local advance and then
  sees the daemon come up will **stop** driving itself and attach. That is the intended fix. If a deck was
  already started locally, 4.4.109's liveDeck guard clears it within the 7.5 s grace.

**What to watch on the first install:** the `Playout mode` row should read **Daemon-driven / green** for
Christmas In July. Amber or red there is a real finding, not a display bug.

## The CART decision is still open

Your approval message left the choice unfilled:
`[daemon emits CART deck events / CART stays locally ticked — pick one]`.

**It does not block this release** — CART is untouched here; it only matters when §1 deletes the local tick.
**My recommendation: CART stays locally ticked, documented as the one deliberate exception.** The cart channel
is an operator instrument, not rotation: it is triggered by hand, it never participates in the advance chain,
and it is the 7th mixer slot rather than a rotation deck. Making the daemon emit CART deck events adds a new
event type and a new consumer to the very boundary this design is simplifying, to serve a surface that has
none of the divergence problems — the mixing bug needs a *track change* to bite, and CART's changes are all
operator-initiated. I would rather write the exception down than widen the protocol. **Your call before §1.**

## Not in this release

§1 (deleting the local position tick as state, the duration carry-forward, the raw-Rust rebuild, the CART
block, `setDeckDuration`), §2 (`observedAt` + the display interpolator), and the consumer sweep. Per the
approved sequencing those come next, separately, with the canary step.

## Gates

```
./node_modules/.bin/tsc --noEmit   → 2 accepted-baseline errors only (OnboardingFlow.tsx:2039, PhoneDesk.tsx:777)
node audiod/smoke-seam-stop.js     → ✅ ALL PASS (35 passed, 0 failed)   [unchanged — this release is renderer-side]
```

## Files

```
src/audio/engine-rodio.ts          :141-147 gate state · :194-216 detectDaemon (never latch false)
                                   :220-234 recheckDaemon · :236-252 localAdvanceAllowed (choke + assertion)
                                   :369-381 getPlayoutMode · :414-416 re-ask tick · :445-455 choke point
src/components/HealthMonitor.tsx   :520-529 mode poll · :600-617 Playout mode row
```

## Not verified

**I have not seen the Playout mode row on screen**, and no contradiction has been observed at runtime with
this code — the logic is proven by construction and by the existing bench, not by a live reproduction. The
first install is the test: the row should read Daemon-driven/green on all stations, and the
`[ROT] CONTRADICTION` line should never appear. If it does, that is the two-brains fault caught at the moment
it happens instead of two days later.
