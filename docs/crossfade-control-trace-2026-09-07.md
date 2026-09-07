# Finding #5, traced — and a correction to it

**Date:** 2026-09-07 · **READ-ONLY.** Nothing changed, nothing built. Proposal only.

**Correcting the inventory first.** `docs/hidden-decisions-inventory-2026-09-07.md` #5 says *"there is a
slider in Settings that changes nothing"* and *"`ether_xfade_duration` has never once been written to
localStorage."* **Both are wrong.**

- `src/App.tsx:1884` **does** write `ether_xfade_duration`. My evidence was a scan of the localStorage
  LevelDB that found no key — which means the slider has never been *moved on this machine*, not that the
  write does not exist.
- `src/App.tsx:1961` passes `xfadeDuration * 1000` **as an argument** to `engine.crossfade(...)`. So the
  slider does reach the X-key fade.

What is actually wrong is narrower, and different: **the `engine.crossfadeDuration` property assignment is
dead for a daemon-driven station, the daemon's own `crossfadeDuration = 3` is unsettable, and the X-key
reaches around the daemon entirely.**

---

## 1 · What `crossfadeDuration` does today, everywhere it is read

Two separate variables with the same name, in two engines.

### The daemon's copy — `audiod/engine.js:113`, `this.crossfadeDuration = 3`

| read at | what it does now |
|---|---|
| `engine.js:972` | `cfMs` — after 4.6.3, **only** the preload cadence and the operator-cut fallback. It no longer stops anything. |
| `engine.js:1003` | `_armAfterRotate`: `near = cfMs + 800` — when the two standby decks are cued after a rotate. |
| `engine.js:2065` | `_foreignGraceMs()` = `(segueOverlap + crossfadeDuration) * 1000 + 1500` — **how long two decks may both be on air before the liveDeck guard stops one.** |

**After 4.6.3 removed the timed stop, this is what is left:** a preload cadence and the two-decks grace.
The grace is the only one that touches air — it decides how long an unexplained second deck keeps playing.
The daemon has **no way to receive a value for this**: `audiod/ether-audiod.js` has no `setCrossfade`
command (only `deck:crossfade`, which is the manual intent and carries no duration).

### The renderer's copy — `src/audio/engine-rodio.ts:146`, `crossfadeDuration = 3`

| written at | read at |
|---|---|
| `App.tsx:1885` (on slider change) | `engine-rodio.ts:860` — the in-process rotate's timed stop |
| `App.tsx:2044` (on mount) | `engine-rodio.ts:870` — `nearDelay = cf*1000 + 800` |

Both readers are on the **in-process fallback path**. A daemon-driven station never executes either. So
those two assignments are inert in normal operation — the narrow, real version of finding #5.

## 2 · What the X-key actually does

`App.tsx:1953-1964` calls `engine.crossfade(xPlaying, xCand, xfadeDuration * 1000)`.

`src/audio/engine-rodio.ts:1135-1142`:

```ts
crossfade(fromId, toId, ms = 2000) {
  const from = this.getDeck(fromId); const to = this.getDeck(toId);
  to.setVolume(1);
  invoke("audio_play", { deck: toId, stationId: this.stationId });
  from.fadeTo(0, ms / 1000);
  setTimeout(() => invoke("audio_stop", { deck: fromId, stationId: this.stationId }), ms + 100);
}
```

**Yes, it fades, and yes, it honours the slider** — `from.fadeTo(0, ms/1000)` ramps the outgoing to
silence over exactly the seconds on the slider, and the outgoing is stopped 100 ms after the fade ends.

**But there is no `daemonDriven` branch.** It calls `invoke("audio_play")` / `invoke("audio_stop")` and the
deck's own `fadeTo` — **direct native calls from the renderer, bypassing the daemon.** On a daemon-driven
station that means:

- the daemon's `liveDeck`, `deckReady`, `endTriggered` and `_retiring` bookkeeping never learn about it;
- the incoming deck is not the daemon's `liveDeck`, so the **liveDeck guard sees a foreign deck on air**
  and will stop it once past `_foreignGraceMs()`;
- it is not serialised on the advance chain — the precise race `intentCrossfade` exists to prevent.

And the daemon *has* its own X-key path that behaves differently: `ether-audiod.js:467`
`deck:crossfade` calls `intentCrossfade(from, to)` — **no duration argument, no fade**, the outgoing cut at
`SAFETY_CUT_MS = 300 ms`. Two different X-key behaviours; the keyboard takes the renderer one.

**So the honest statement is not "the slider does nothing." It is: the X key fades correctly over the
slider's duration, while reaching around the engine that owns the decks.**

## 3 · The delivery path, if it becomes a station setting

The same shape as `segue_overlap_sec`. Every piece:

| # | piece | what it is |
|---|---|---|
| 1 | `station_config_kv` key `crossfade_sec` | station-scoped, **synced** — not in `LOCAL_ONLY_KEYS`; a fade length is a decision about the station's sound |
| 2 | `audiod/ether-audiod.js` | a `setCrossfade` command — the missing piece; mirrors `setSegueOverlap:479`, clamp 0–10 |
| 3 | `audiod/engine.js` | drop the `= 3` literal; add `_applyCrossfadeFromKv(now)` on the poll, the same 3-second-cadence pattern as `_applySegueOverlapFromKv` and `_applyProcessingFromKv` |
| 4 | `src/audio/engine-rodio.ts` | `setCrossfade(sec)` that sets the local field **and** `daemonCmd("setCrossfade")` when `daemonDriven`, re-sent on reconnect — exactly what `setSegueOverlap:678-684` already does |
| 5 | `src/App.tsx` | read from kv instead of `localStorage`, one-time migration of `ether_xfade_duration`, write kv on change |
| 6 | `src/components/SettingsPanel.tsx:3001` | the slider stays; its hint says it is saved with the station |
| 7 | the X-key | **the real decision.** Either route it through `deck:crossfade` and give `intentCrossfade` a duration so the daemon owns the fade, or leave the renderer path and accept that it bypasses the daemon. This is a behaviour choice, not plumbing |

Piece 7 is the substance. 1–6 are the same mechanical shape already proven twice.

## 4 · Anything else in the same condition — the sweep

I checked every control in `SettingsPanel.tsx` and every `engine.<prop> =` write in `App.tsx`.

### A genuinely dead control — AUTO-X

**`src/App.tsx:3129`** — `setAutoXfade={(v) => { setAutoXfade(v); engine.outroCrossfade = v; }}`

`outroCrossfade` is declared at `engine-rodio.ts:145` and **read by nothing, anywhere** — not the renderer,
not the daemon, not Rust. Its only companion is `checkOutroCrossfade() {}` (`engine-rodio.ts:1143`), an
empty method body. **The AUTO-X toggle sets a field no code reads, on either path.** This is the pure form
of the defect finding #5 was describing.

### Redundant, but not dead — AUTO / continuous

`App.tsx:2048`, `:2049`, `:2317`, `:2331`, `:2334`, `:2387` write `engine.autoAdvance` and
`engine.continuous`. Neither forwards to the daemon: `engine-rodio.ts:139-144` are a plain setter and a
plain field, and only `setSegueOverlap` (`:678-684`) has a `daemonCmd` forward.

`ether-audiod.js:475-476` **does** expose `setAutoAdvance` and `setContinuous` — and **nothing in the app
ever sends them.** Two daemon commands with no caller.

**This is not a broken AUTO button.** Automation reaches the daemon by a different route,
`automationStart` / `automationStop` (`engine-rodio.ts:525`, `:613`). The property writes are vestigial
state that matters only on the in-process path. Worth knowing, not worth alarm.

### localStorage-backed settings — which are real

Twelve keys are written from `App.tsx` / `SettingsPanel.tsx`. Nine are pure UI layout (`ether_dock_height`,
`ether_lib_cols`, `ether_queue_width`, `ether_tools_collapsed`, `ether_drawer_usage`,
`ether_master_user_*`, `ether_queue_collapsed`) — not sound, correctly local.

Three touch audio and are **read by real renderer code**, so they work — but they are per-machine and
invisible to the account:

| key | read at | status |
|---|---|---|
| `ether_auto_silence_trim` | `App.tsx:2437` — triggers cue analysis on import | works; per-machine |
| `ether_cue_device` | `MicChannel.tsx:82`, `TrackEditor.tsx:368` | works; per-machine |
| `ether_phone_input` | `PhoneDesk.tsx:468`, `:477` | works; per-machine |

Device pickers being per-machine is arguably correct — a sound card belongs to a box, not an account (the
same reasoning that makes `music_dir` local-only). `ether_auto_silence_trim` is the odd one: it decides
whether Ether writes cue points on import, which is a library decision, not a machine one.

### Nothing else

No other Settings control writes to a renderer object or to storage that a daemon-driven station cannot
read. The ducker, Master EQ, separation rules, jukebox, sync, station logo, experience mode and playout
server all go through `stationConfigKv` or a main-process `invoke`.

---

## Summary

- **One genuinely dead control: AUTO-X** (`outroCrossfade`, read by nothing).
- **One control that works but reaches around the daemon: the X key.**
- **One unsettable daemon value that still touches air:** `crossfadeDuration = 3` feeding
  `_foreignGraceMs()`.
- **Two daemon commands with no caller:** `setAutoAdvance`, `setContinuous`.
- **Three per-machine audio settings** that work but do not travel with the account.

## What this document does not claim

Every line is read from source with `file:line` on 2026-09-07. **No runtime observation was made** — I did
not press X on a daemon-driven station and watch the liveDeck guard react. The claim that the renderer
crossfade bypasses the daemon is read from the absence of a `daemonDriven` branch in
`engine-rodio.ts:1135-1142`; the claim about what the guard would then do follows from
`engine.js:2065` and `:2137`, not from having seen it happen.
