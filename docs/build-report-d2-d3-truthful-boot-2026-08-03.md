# Build report — D2 + D3: the truthful boot (cold-start slice 2)

**Date:** 2026-08-03 · **Design:** `docs/cold-start-contract-design-2026-08-03.md` §D2, §D3
**Gates run:** `tsc --noEmit` baseline · **9 benches 268/268** (`smoke-deck-snapshot` 19 → **25**).
**No bump, no commit, no build.** Slice gate is a relaunch (§ Gate).

---

## The receipts this slice answers

From the 4.4.123 cold-cache launch, all three confirmed in the daemon log:

```
[mix s2] ... mon=1.00 ...                                    ← monitor bus at UNITY
[audiod] cmd automationStart station=2                       ← automation ENGAGED, no operator act
[engine s2] automationStart: deck A LIVE — Commercial Spot
```

Plus Jeff's observation, which named the mechanism exactly: **"as soon as the dashboard opens they all
silent."** Monitor gain was only ever applied when the *board* rendered — so from daemon spawn until the
dashboard painted, every station monitored at unity and nothing had asserted otherwise.

## D2 · Silence asserted at ATTACH, not at dashboard render

`assertMonitorSilence()` runs inside `adoptFromDaemon()` — the same attach unit as the queue and deck
snapshot. **Silence now holds from the moment the engine exists**, not from the moment the board paints.

**Why the assertion is required rather than "just don't unmute":** the Rust bus default is
`monitor_vol: 1.0` (`audio.rs:368`). Nothing unmutes monitors — **they are never muted**, so an engine
that exists is audible unless something says otherwise. Silence has to be a positive act.

**Operator level survives a respawn.** `noteOperatorMonitor(level)` records a raised monitor;
`assertMonitorSilence()` then re-applies *that level* on reattach instead of re-muting, because a daemon
respawn resets the bus to 1.0. Un-raised stations get 0. The park case works: the jock raises halloVeen,
and it stays raised across a daemon restart while the other three stay silent.

**Cannot affect air.** `monitor_vol` applies to the device branch only (`audio.rs:1157`); the broadcast
branch is untouched. Muting monitors is inaudible to listeners.

## D3 · AUTO and ON AIR are OBSERVED — and automation needs a named act

### The light

`autoAdv` was `useState(() => readAutoAdv(...))` — seeded from KV, i.e. the UI's own memory of last
session. It is now `boolean | null`, seeded **`null` = UNKNOWN**, and fed from
`engine.observedAutomation`, which returns `null` unless `attachState === "daemon"`.

The header pill renders **three** states — `● AUTO` / `MANUAL` / `— UNKNOWN` (dashed border). **UNKNOWN
never falls back to MANUAL**, and the one behavioural read of `autoAdv` was tightened from `!autoAdv` to
`autoAdv === false` so an unknown state cannot act like MANUAL.

KV survives **only** as the operator's stored preference for what the button does when pressed — never a
trigger, never a display source.

### The state itself

The daemon now publishes `started` alongside `state` on the `enginestate` event — both on change
(`_emitEngineState`) **and inside the adopt snapshot**, so an attaching renderer learns whether
automation is engaged without waiting for a change. Without that second half, an adopting renderer would
know its decks but not its automation, and would have had to fall back to KV — the exact defect removed.

### The choke point

`startDaemonAutomation(reason)` now requires a named origin: **`"operator"` | `"remote"` |
`"watchdog-resume"`**. Anything else is refused and logged as an error. Every start logs its origin:

```
[ROT] automationStart station=2 origin=watchdog-resume
```

Per Jeff's confirmed split: **attended launch → AUTO off, displayed and engaged, until he presses it;
watchdog respawn with a station live → automation resumes unattended, exactly as today.** That exception
stays narrow and is the only caller passing `"watchdog-resume"` (`App.tsx:1538`, already gated on
`wasOnAir === true`).

**An honest gap, stated plainly.** Static reading does **not** explain which caller issued
`automationStart station=2` on the 4.4.123 launch: `:1084` is the remote `automation_on` command (a
legitimate operator/remote act) and `:1538` is watchdog-gated, and the box had no watchdog (parent
`explorer`). Rather than guess, the choke point **makes the next one identify itself** — every start now
names its origin in the log, and an unnamed one is refused outright. If something is still starting
automation at boot, the next launch will say so by name instead of requiring another trace.

## Bench — `smoke-deck-snapshot.js`, 19 → **25** assertions

Added: the adopt emits `enginestate`; `started` is **false** on a fresh engine (never assumed true) and
is a **real boolean** — `undefined` would leave the UI UNKNOWN forever, which is the failure mode of a
half-wired observation; an engaged engine reports `true`; and the change-driven stream carries `started`
alongside `state`, not only the adopt.

**Not benched, and why:** the monitor assert and the AUTO pill are renderer-side, reached through
`window.ether.audio` and React state — no seam that can be driven from bare Node without mocking the
whole preload surface. Their gate is the relaunch.

## Two field names I guessed wrong, both caught before they shipped

Disclosed because each would have been a silent failure:

- **`this.jingleState`** (D4, previous slice) — does not exist. I removed the fabricated `"idle"` rather
  than emit a claim the engine never made.
- **`this.engineState`** — the field is **`this._engineState`**; the accessor is `engineState()`. My
  snapshot emit would have published `undefined` as the state on every adopt. Caught by running the
  emit directly against a real `DaemonEngine` and reading the payload.

## THE SLICE GATE — a relaunch

1. **Silence until a monitor is raised.** Launch. From the on-shift screen onward, **no station audible
   locally** — including the window before the dashboard paints, which is where the four-at-once came
   from. Raise halloVeen's monitor deliberately → only halloVeen is heard.
2. **AUTO dark until pressed.** No station shows `● AUTO` on launch. Nothing automates on its own; the
   log shows no `automationStart` without `origin=`.
3. **Indicators honest from UNKNOWN forward.** During the cold-stage window the pill reads `— UNKNOWN`
   (dashed), then resolves to the daemon's real state — never AUTO-then-corrected.

**Still airing throughout** — the daemon is untouched. Listeners hear no change from any of this.

## Files

```
audiod/engine.js               enginestate carries `started` (stream + adopt snapshot)
src/audio/engine-rodio.ts      assertMonitorSilence() + noteOperatorMonitor() (D2)
                               · observedAutomation getter · startDaemonAutomation(reason) choke point
src/App.tsx                    autoAdv boolean|null seeded UNKNOWN · observed-state poll
                               · three-state pill · `autoAdv === false` behavioural guard
                               · watchdog caller names its origin
audiod/smoke-deck-snapshot.js  +6 assertions (25 total)
```

## Not built (deliberately)

**D1 remains the last slice** — the unconditional gate and "Continue as \\<account\\>". Nothing here
touches the sign-in gate, the daemon's lifecycle, or the program bus. The pre-auth engine race that made
the Christmas station audible at the PIN screen is D1's to close; D2 makes that window *silent* in the
meantime, but it does not stop the engine from existing before sign-in.
