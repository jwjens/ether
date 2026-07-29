# Which side is dead — live evidence from the running machine

**Date:** 2026-07-29, ~18:16 UTC · **Mode:** READ-ONLY. Live log and running system inspected; nothing changed.
**Supersedes the conclusion of** `docs/daemon-deck-events-decay-trace-2026-07-29.md` (§3) — that trace blamed
`automationStop` clearing the daemon's per-station poll timer. **The log rules that out.**

---

## Verdict: the producer and the transport are both ALIVE. The fault is renderer-side.

Three independent facts from the live system, all timestamped within minutes of the frozen UI.

### 1. `automationStop` was never sent for station 4 — Jeff is right

```
$ grep automationStop %APPDATA%\Ether\logs\ether-audiod.log
… 2026-07-29T14:03:27.344Z [INFO] [audiod] cmd automationStop station=4     ← the LAST one, 4 hours ago
    2026-07-29T15:10:05.613Z … station=3
    2026-07-29T15:38:56.958Z … station=2
    2026-07-29T17:52:19.684Z … station=3
    2026-07-29T17:52:28.222Z … station=2                                    ← none for station 4

$ grep automationStart …
    2026-07-29T17:51:42.389Z [INFO] [audiod] cmd automationStart station=4
    2026-07-29T17:51:42.445Z [INFO] [engine s4] automationStart: requested — _started false → true
    2026-07-29T17:51:42.660Z [INFO] [engine s4] automationStart: deck A LIVE — Tidings Of Comfort And Joy
```

Station 4's automation has been engaged continuously since **17:51:42** — 25 minutes at time of writing — with no
stop. **The daemon's per-station `pollTimer` for s4 has therefore never been cleared**, and my earlier conclusion
does not apply to this failure.

### 2. Station 4's daemon engine is doing work *right now*

```
2026-07-29T18:16:02.836Z [INFO] [engine s4] segue: deck B LIVE — What the World Needs Now Is Love
2026-07-29T18:16:02.836Z [INFO] [engine s4] advance done handleRotate 5ms
2026-07-29T18:16:05.162Z [INFO] [engine s4] deck A ended (pos=163.2/163.76s, chain=segue, readyC=true)
2026-07-29T18:16:06.339Z [INFO] [engine s4] advance → stop:A (queue=12)
2026-07-29T18:16:10.363Z [INFO] [engine s4] jingle CLEARED (done)
```

A segue, a deck end, an advance and a jingle — seconds ago. `poll()` is running, so `_maybeEmitDeck` is being called
every 250 ms (`audiod/engine.js:277`), and **the state is changing constantly**, which is exactly the condition under
which `_changed` (`engine.js:471-476`) returns true and the event is emitted. Deck A ending and deck B going live is
a `status` **and** `title` **and** `filePath` change — impossible for the change-detector to suppress.

Audio is flowing for all four stations at the same moment:

```
2026-07-29T18:15:18.723Z [INFO] [mix s4] active=1 frames=+228588 peak=0.359 | A src=1 a=1 p=0 …
```

### 3. The transport is intact — one client, no reconnect

```
2026-07-29T17:51:41.851Z [INFO] [audiod] client connected (1 total)
```

**One** connection, established just before station 4's automation started, and **no disconnect, reconnect or respawn
line since**. So main's socket to the daemon has been continuously up for the whole window in which the UI froze.

And the forward is unconditional and individually guarded:

```js
electron/main.js:574   sendToAllWindows("audio:daemon-deck", { stationId: m.stationId, deck: m.deck, state: m.state, ready: m.ready });
electron/main.js:4654-4663
  BrowserWindow.getAllWindows().forEach(w => {
    try { if (!w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) w.webContents.send(channel, payload); }
    catch (e) { /* skip silently */ }
  });
```

Per-window `try`/`catch` plus `isDestroyed()` checks — **a closed Show+ popout cannot break delivery to the main
window**, which was my other candidate. Ruled out.

**Conclusion: deck events for station 4 are being produced and delivered to the renderer, and the renderer is not
applying them.**

---

## Where renderer-side the failure has to be

The handler is `engine-rodio.ts:227-241`:

```js
const h = a.onDeck((m: any) => {
  if (m && m.stationId != null && m.stationId !== this.stationId) return;   // :229
  const id = m?.deck as DeckId;
  if (id !== "A" && id !== "B" && id !== "C") return;                        // :231
  const st = makeState(id, m.state || {});
  if (id === "A") this.stateA = st; else if (id === "B") this.stateB = st; else this.stateC = st;
  this.lastFiredState[id] = st;
  this.listeners.forEach(l => l(id, st));                                    // :240
});
```

Given §1-§3, exactly one of these is true, and they are distinguishable:

| # | Candidate | Why it fits / how to tell |
|---|---|---|
| **A** | **The engine the UI reads never attached to the daemon at all.** `attachDaemonEvents()` runs only if `a.daemonEnabled()` resolved **true** (`engine-rodio.ts:167-170`). It is `async`, called once per engine, and guarded by `daemonDetectStarted`. If engine 4 asked while the daemon socket was not yet up, `daemonDriven` stays **false** and no `onDeck` subscription is ever created — and because the guard is one-shot, it never retries | Fits "one station only": engine 1 asked at login when the daemon was up; engine 4 asked at switch time. **Distinguishing sign:** with `daemonDriven === false`, `poll()` takes the in-process branch and rebuilds deck state from main's *local* native engine — which is idle, because the daemon owns audio in another process |
| **B** | The subscription exists but `m.stationId !== this.stationId` rejects every event | Requires the engine's `stationId` to differ from 4. Set once in the constructor, so it would have to be the wrong engine instance entirely — HOP 1 territory |
| **C** | Listeners fire but the UI's listener was removed | The `[engine]` effect's cleanup calls `unsub()` on station change, then re-subscribes. A freeze would need a cleanup with no re-subscribe |

**Candidate A is the one that matches "worked for a few minutes, then stopped" least well and best at the same time,
and that ambiguity is the honest state of this:** it explains one-station-only and silence perfectly, but not why it
worked *first*. If deck events were being applied for a few minutes, the subscription existed — which argues for C
or for something that changes after the fact.

**What I cannot see from here:** the renderer's own state. The daemon log proves the producer; nothing on disk
records whether the renderer applied a given event. `rotLog`'s `[ROT] daemon-driven: local advance DISABLED` line
goes to the renderer console only, and dev globals (`src/lib/devGlobals.ts:72-74`) expose only tier/onboarding
helpers — no engine handle.

## The one check that closes it

With the frozen station on screen, open DevTools on the **main** window (F12 — the accelerator is registered at
`electron/main.js:1823` even though the menu bar is not drawn) and run:

```js
await window.ether.audio.daemonEnabled()
```

- **`true`** → the renderer knows the daemon is driving. Then the subscription should exist, and the fault is
  candidate B or C — the event arrives and is discarded or nobody is listening.
- **`false`** → candidate A is confirmed: that engine decided "in-process" at init, never subscribed, and
  `poll()` has been rebuilding deck state from an idle local engine ever since. The one-shot `daemonDetectStarted`
  guard (`engine-rodio.ts:161`) means it can never recover without a reload.

Watching the console while a track changes on that station is equally decisive: deck A ending and deck B going live
(as at 18:16:02-18:16:05 above) is a status+title+filePath change that **must** produce a visible UI change if the
event is being applied. If the UI does not move at a track boundary, no event is landing.

## What is now ruled out, with receipts

- **`automationStop` / a cleared daemon poll timer** — no stop for station 4 since 14:03; automation engaged since
  17:51:42 (§1). My previous trace's conclusion is withdrawn.
- **`_changed` suppressing steady-state events** — s4 changed decks, titles and status at 18:16 (§2); the detector
  cannot suppress that.
- **Daemon disconnect / respawn** — one client connected at 17:51:41, no reconnect since (§3).
- **A destroyed popout breaking the broadcast** — `sendToAllWindows` guards every window individually (§3).
- **The engine-teardown patch built earlier today** — not shipped, and `stop()` is not called anywhere in 4.4.103.

## Scope note

Read-only. The daemon log was read, not modified. No file in `C:\openair` changed, nothing committed, nothing built.
The un-shipped teardown patch and recording-UI changes remain in the working tree.
