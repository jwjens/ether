# Why the sweep and countdown die minutes in — the daemon deck-event subscription

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Nothing changed, nothing fixed.
**Scope:** the decay only. Engine init (HOP 4) and deck rows are entry-point fixes and are not re-examined.

---

## Headline

**The renderer's subscription never dies. The daemon simply stops emitting for that station.**

Deck events are produced by a per-station timer inside the daemon
(`audiod/engine.js:236` — `this.pollTimer = setInterval(() => this.poll(), 250)`), and that timer is **cleared** by
`DaemonEngine.stop()` (`audiod/engine.js:243`). Once it is cleared, `_maybeEmitDeck` is never called again for that
station, so `audio:daemon-deck` events for it stop **while every other station keeps emitting**.

The renderer then does exactly what it was built to do, and that is what you see: the last state it received said
`status: "playing"`, so `poll()` keeps advancing `positionSec` locally — until it clamps at `durationSec` and the
countdown freezes with the sweep stuck. NOW PLAYING keeps updating because it rides a **different** channel.

Nothing is unsubscribed, nothing is filtered out, nothing races. The producer went quiet.

---

## 1. The path, and where station identity enters

```
audiod/engine.js:277        poll() → for (const id of ["A","B","C"]) this._maybeEmitDeck(id)
audiod/engine.js:482-485    if (this._changed(lastFired[id], st) || lastReady[id] !== ready)
                              this.emit("deck", { stationId: this.stationId, deck: id, state: {...}, ready })
audiod/ether-audiod.js:89   new DaemonEngine(stationId, db, (event, payload) => broadcast({ event, ...payload }))
electron/main.js:574        sendToAllWindows("audio:daemon-deck", { stationId, deck, state, ready })
electron/preload.js:37      onDeck: cb => ipcRenderer.on("audio:daemon-deck", h)  → returns the handle
src/audio/engine-rodio.ts   attachDaemonEvents(): a.onDeck(m => { …stationId filter… ; listeners.forEach(...) })
```

Station identity enters at **three** points, and only one of them can go quiet:

| Point | Where | Can it silently drop one station? |
|---|---|---|
| The daemon has **one engine per station** | `ether-audiod.js:56` `const engines = new Map()`, created on demand at `:87-89` | **YES — this is the one.** Each engine owns its own `pollTimer` |
| Main forwards **every** station's events to **every** window | `electron/main.js:574` `sendToAllWindows(...)` | No — it is a blind broadcast, no per-station gating |
| The renderer engine self-filters by `stationId` | `engine-rodio.ts` `if (m && m.stationId != null && m.stationId !== this.stationId) return;` | Only if the id were wrong, and it is set once in the constructor and never mutated |

## 2. Can the subscription be dropped, replaced, or starved? **No — and that is the point.**

- **Not unsubscribed.** The renderer's IPC listener is registered once in `attachDaemonEvents()` and released only by
  the `daemonUnsub` closures, which nothing calls today (there is no teardown in the shipped build — that is exactly
  what the un-shipped stop() patch adds).
- **Not replaced.** `preload.js:37` registers a plain `ipcRenderer.on`; nothing removes or overwrites it mid-session.
- **Not filtered out by a drifting id.** `this.stationId` is a constructor field. A mid-session mismatch would
  require the engine instance to change, and a new instance means a new subscription, not a dead one.
- **Not starved.** `sendToAllWindows` has no per-station queue or throttle.

**So the renderer keeps listening on a channel that has gone quiet.** That is why it fails silently: a listener with
no events is indistinguishable from a listener with nothing to report.

## 3. What stops the producer

`DaemonEngine.stop()` — `audiod/engine.js:240-245`:

```js
stop() {
  this._started = false;
  if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }      // :243
  if (this._procMeterTimer) { clearInterval(this._procMeterTimer); … }
  this._stop("A"); this._stop("B"); this._stop("C");
}
```

Reachable from three commands, all keyed to one station:

```
ether-audiod.js:135   automationStop: (m) => { const e = engines.get(m.stationId); if (e) e.stop(); }
ether-audiod.js:138   stopAll:        (m) => { const e = engines.get(m.stationId); if (e) e.stop(); … }
ether-audiod.js:265   shutdown:       for (const e of engines.values()) e.stop()          ← all stations
```

And the app sends `automationStop` from two places, both per-station:

```
src/App.tsx:1123               case "automation_off": … if (useDaemon) await dcmd("automationStop")
src/audio/engine-rodio.ts:330  stopDaemonAutomation() → daemon("automationStop", { stationId: this.stationId })
```

**The mirror image matters too:** the poll only *starts* in `init()` (`engine.js:236`), which is called from
`start()` (`engine.js:1114-1115`) — i.e. `automationStart`. The daemon command `init` at `ether-audiod.js:105` calls
`A.initAudioEngine(...)` (the NAPI layer) and **does not** start the DaemonEngine poll. So a station's deck events
flow **only while its automation is running**, and stop the moment it is stopped.

**UNKNOWN, and only a live check can decide it:** which of those reached Christmas In July. `LOGGED_CMDS`
(`ether-audiod.js:188`) includes `automationStop`, so the daemon log records it by name and station —
`%APPDATA%\Ether\logs\ether-audiod.log` will name the moment and the station. That is the receipt that turns this
from mechanism to cause.

## 4. Confirmed: the frozen countdown is the renderer faithfully mirroring a stale "playing"

`src/audio/engine-rodio.ts` `poll()`:

```js
const posA = (this.stateA.status === "playing") ? Math.min(this.stateA.positionSec + elapsed, durA || 9999) : this.stateA.positionSec;
…
this.stateA = this.daemonDriven ? { ...this.stateA, positionSec: posA } : { … };
```

In daemon mode the local poll advances **only `positionSec`** — status, title and duration are authoritative from
deck events. So when events stop:

1. `status` stays at its last value, `"playing"`.
2. `positionSec` keeps incrementing every 250 ms because of that stale status.
3. `Math.min(..., durA)` **clamps** it at `durationSec` — the countdown stops moving.
4. The ConsoleStrip sweep, driven off the same state, stops with it.

This is per-station by construction: each renderer `AudioEngine` holds its own `stateA/B/C`, and only the station
whose daemon engine stopped goes stale.

**And NOW PLAYING survives** because it does not ride this channel — it is fed by `audio:daemon-playstart`
(`main.js:634`) and the app's own now-playing state, which is why one freezes and the other does not. Your
observation is the strongest evidence for this diagnosis: it separates "the deck-event channel died" from "the whole
event flow died", and it points at exactly one channel.

---

## 5. The single change that keeps every station identical for the whole session

**Make deck-event emission independent of automation state — the daemon should report a station's deck truth for as
long as the station exists, not only while its automation is running.**

Concretely, the smallest version: `DaemonEngine.stop()` currently clears the poll timer that does two jobs at once —
**automation** (end-detection, advance, watchdog, segue) and **reporting** (`_maybeEmitDeck`, `_emitEngineState`).
Stopping automation must not stop reporting. Separating them — leaving a reporting tick alive after `stop()`, or
emitting a final authoritative deck state on stop so the renderer is never left mirroring a stale `"playing"` — makes
a stopped station show the truth (stopped, at 0) instead of a frozen countdown.

That is one change in one place, and it makes every station behave identically for the whole session: the login-time
station is not special today, it simply happens to be the one whose automation nobody stopped.

**A renderer-side belt-and-braces, not a substitute:** treat "no deck event for this station in N seconds while we
believe it is playing" as a state worth showing rather than silently extrapolating. Today `poll()` will advance a
stale `"playing"` forever with nothing said anywhere.

## Not the cause

- **Renderer subscription lifecycle** — nothing tears it down in the shipped build (§2).
- **The engine-teardown patch built earlier today** — correct, but it addresses accumulation and in-process
  double-advance, and in daemon mode `poll()` returns early before end-detection. It cannot cause or cure this.
- **HOP 4 / engine init** — an entry-point fix; this station's events were flowing, so its engine was initialised.
- **HOP 1 / `useActiveStation`** — a wrong id would break it from the first second, not minutes in.

## Scope note

Read-only. No file modified, nothing committed, nothing built. The un-shipped teardown patch and the recording-UI
changes remain in the working tree, untouched by this investigation.
