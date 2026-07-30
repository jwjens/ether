# Deck-freeze — instrumentation armed, awaiting the freeze

**Date:** 2026-07-29 · **Status:** instrumentation built and typechecked. **Not built into an installer yet.**
**This is temporary tooling.** Teardown obligation logged at the top of `docs/backlog.md`.

---

## Why instrumentation was needed at all

The evidence so far (`docs/deck-freeze-live-evidence-2026-07-29.md`) proved two of the three legs:

- **Producer alive** — station 4's daemon engine segued, ended deck A and cleared a jingle at 18:16, and its
  automation has run unbroken since 17:51:42 with no `automationStop`.
- **Transport alive** — one daemon client connected 17:51:41, no reconnect since; `sendToAllWindows`
  (`electron/main.js:4654-4663`) guards each window individually, so a closed popout cannot break delivery.

The third leg — **did the renderer apply the event** — is invisible. Renderer `console.log` goes to DevTools and
nowhere else, and nothing on disk records renderer state. That is the entire reason for this build: the split
between *"events stopped arriving"* and *"events arrived and were discarded"* cannot be resolved statically, and
asking anyone to eyeball a sub-second stall is not a measurement.

Your point also killed my leading theory outright: **"the subscription never attached"** would be silent from the
first second, not after minutes. It stays on the list only as something the log can now rule out by evidence.

## What was added

Three pieces, all tagged `[DECKDBG]`.

### 1. Renderer console → disk bridge — `electron/main.js:1644-1667`

```js
mainWindow.webContents.on("console-message", (...args) => { … if (!msg.startsWith("[DECKDBG]")) return;
  fs.appendFileSync(path.join(app.getPath("userData"), "logs", "renderer-deckdbg.log"), ts + " " + msg + "\n"); });
```

Only `[DECKDBG]` lines are written, so the file stays small and no other console output leaks to disk. The handler
accepts **both** Electron `console-message` signatures (older `(event, level, message, …)` and newer `(event)` with
`event.message`) because that API changed across majors and a silent mismatch would waste the whole run.

Output: `%APPDATA%\Ether\logs\renderer-deckdbg.log`

### 2. Arrival and application — `src/audio/engine-rodio.ts`, inside the `onDeck` handler

| Line | Emits | Answers |
|---|---|---|
| `arrive` — logged **before any filter** | engine stationId, event stationId, deck, status, pos, dur, `daemonDriven`, listener count | Did the event reach this renderer at all? |
| `reject-station` | engine id vs event id | Did the `stationId` self-filter discard it? |
| `reject-deck` | the deck value | Did a malformed deck id discard it? |
| `applied` — after `stateA/B/C` is written and listeners fanned out | deck, status, pos, dur, listener count | Was it actually applied, and was anyone listening? |

The `listeners` count is deliberate: it separates "applied but nobody subscribed" (the UI listener was lost) from
"never applied".

### 3. Five-second heartbeat — `poll()`

```
[DECKDBG] hb engine=4 daemonDriven=true listeners=3 A=playing/62.4/163.8 B=stopped/0 C=cued/0
```

Every engine reports itself every ~5 s whether or not events are flowing. This is the piece that makes the log
self-diagnosing:

| Log pattern at the freeze | Meaning |
|---|---|
| `hb` present, `arrive` lines **stop** | Events stopped reaching the renderer — producer/transport, despite §1 |
| `hb` present, `arrive` continues, no `applied` | Arriving and **discarded** — the adjacent `reject-*` line names which guard |
| `hb` present, `arrive` + `applied` continue, but the UI is frozen | Delivery is fine; the fault is downstream in the UI listener (ConsoleStrip / App state) |
| `hb` **stops** for engine 4 | That engine's poll timer died — nothing else could do that in the shipped build |
| `hb` shows `daemonDriven=false` | The engine never attached to the daemon — my earlier theory, confirmed or excluded on sight |
| `hb` shows `listeners=0` | The UI unsubscribed and never re-subscribed |

Every hypothesis raised across this investigation resolves to one of those rows, which is the point.

## Volume and safety

- Deck events fire on `Math.floor(positionSec)` change — about one per second per playing deck. With four stations
  that is roughly 4-12 lines/second worst case; an hour of running is a few MB of plain text.
- Logging is wrapped in `try/catch` at every site so **instrumentation can never break event delivery** — a failed
  `console.log` must not be able to cause the bug it is measuring.
- The bridge only appends; it reads nothing and changes no behaviour.
- `tsc --noEmit`: the 2 standing baseline errors only, none in the touched files.

## How to run it

1. Build an installer with this in it and install (that step needs your GO — no bump, commit or build has been done).
2. Switch to Christmas In July and leave it. No watching required.
3. When the countdown freezes, note the wall-clock time and tell me — I read
   `%APPDATA%\Ether\logs\renderer-deckdbg.log` and the daemon log side by side around that timestamp.

The two logs share real timestamps, so the daemon's emit and the renderer's arrive/apply for the same deck event
line up directly.

## Teardown

Logged at the top of `docs/backlog.md` with the exact three code locations and the log file to delete. **This must
not reach a customer build.** Per `CLAUDE.md`, temporary tooling expires — and the permanent replacement this points
at is the honest one: a station whose deck events have gone quiet while it believes a deck is playing should say so
in the Health Monitor rather than extrapolating `positionSec` in silence forever.

## Scope note

No fix applied — the instrumentation only observes. The un-shipped engine-teardown patch and the Show+ recording-UI
changes remain in the working tree alongside it. Nothing committed, nothing built, nothing on the live DB or the
Lightsail box.
