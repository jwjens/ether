# What the existing logs can and cannot show about the deck freeze

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Live daemon log and install inspected. Nothing changed, no
instrumentation added, no new cause proposed.

**Facts from Jeff that outrank every inference, and which every prior theory has died against:** automation is
running, the stations are identically created, and **D/E/F are unused — rotation only ever plays A/B/C.** So the
freeze happens on a normal A/B/C deck while the daemon is emitting for it.

---

## 1. Does the daemon log record per-deck emission? **No.**

`_maybeEmitDeck` (`audiod/engine.js:477-486`) calls `this.emit("deck", …)` with **no log statement of any kind** —
grep for `_log`/`console` inside it returns 0. Emission is silent by design; the daemon logs *decisions*, not the
event stream.

What `[engine s4]` lines actually exist, counted over the whole log:

```
1522  advance      513  clean       386  jingle      341  segue
 203  deck          22  engine       18  top          11  refill
   8  automation     6  watchdog      6  resume        4  processing
```

The 203 `deck` lines are **outcomes** — `deck A ended (pos=163.2/163.76s …)`, `deck B LIVE` — not emissions. They
prove the engine's poll was alive and its state was changing (a deck ending and another going live is a status +
title + filePath change, which `_changed` cannot suppress), which is what
`docs/deck-freeze-live-evidence-2026-07-29.md` already established at 18:16.

**So: the log proves the producer was working at the freeze moment. It cannot show individual deck events, because
they were never logged.** That is not a gap to fill — logging ~1 line/second/deck/station would drown the file, and
the daemon deliberately excludes routine pollers for exactly that reason (`ether-audiod.js:186`).

## 2. Is there ANY existing persistent signal for the renderer side? **No. This is the honest blocker.**

Everything that reaches disk today is written by the **daemon** or by **main** — both upstream of the question:

| Written to disk | By | Proves |
|---|---|---|
| `ether-audiod.log` | daemon | The daemon emitted / decided |
| `health-events.jsonl` | main (`_health.noteDeck` at `main.js:575`) | **Main received and forwarded** — not that the renderer applied |
| `logs/*.jsonl`, `playhead-divergence.jsonl`, `logreader-shadow.jsonl` | main | Playout/scheduling state, nothing renderer-side |

The one renderer→disk channel that exists is `rotLog` (`engine-rodio.ts`), which does
`ether.fs.logRotation(msg)` → `preload.js:163` → `main.js:3300-3305`. **But look where it writes:**

```js
electron/main.js:3299
const _rotationLogPath = path.join(__dirname, "..", "tmp-userdata", "rotation.log");
```

`__dirname/..` in a packaged build is inside `resources/`, and there is **no `tmp-userdata` directory in the
install** — verified: no `rotation.log` anywhere under `C:\Users\jensj\AppData\Local\Programs\Ether`. The
`appendFileSync` is wrapped in `try {} catch {}`, so every `[ROT]` line the renderer has ever produced on this
machine — **including the one line that would answer the whole question, `"[ROT] daemon-driven: local advance
DISABLED"` vs `"[ROT] in-process engine (daemon not active)"`** — was silently discarded.

**Stated plainly, as asked: with what exists today we cannot see the renderer side.** Not "it is hard to find" —
the only renderer→disk path is a dev-only relative path that does not resolve in a packaged install, and it fails
silently.

That is the decision point: instrumentation, or a permanent sense. Worth noting that **fixing `_rotationLogPath` to
resolve under `app.getPath("userData")` is neither** — it is repairing an existing, already-shipped channel that is
currently a no-op, and it would immediately answer the `daemonDriven` question below without adding anything new.

## 3. Other guards that can short-circuit application — one competing writer, and it is not the deck letter

**Every early return in the daemon-event path** (`attachDaemonEvents` → `onDeck`):

| Guard | Can it drop a playing A/B/C event? |
|---|---|
| `if (!a) return` — no `window.ether.audio` | Only at attach time; would mean no subscription at all |
| `if (a.onDeck)` — the API exists | Same |
| `if (m.stationId != null && m.stationId !== this.stationId) return` | Only on an id mismatch; `stationId` is a constructor field and never mutates |
| `if (id !== "A" && id !== "B" && id !== "C") return` | **Not in play** — Jeff confirms rotation only uses A/B/C, and the daemon's own emit always carries a letter |
| `this.listeners.forEach(...)` | Not a guard, but **if the set is empty the event is applied and nothing renders** |

**Nothing there becomes true after minutes.** The handler has no time-dependent condition at all.

**But the handler is not the only writer of `stateA/B/C`.** `poll()` writes them too, every 250 ms
(`engine-rodio.ts:438-440`):

```js
this.stateA = this.daemonDriven
  ? { ...this.stateA, positionSec: posA }                                   // daemon mode: position only
  : { ...makeState("A", s.deckA), durationSec: durA, positionSec: posA, … } // in-process: FULL REBUILD
```

The ternary is the whole story. **If `daemonDriven` is false, poll() rebuilds the entire deck state four times a
second from `invoke("audio_get_state")` — main's own native engine — and overwrites anything the daemon handler
applied.** In a daemon-driven install main's native engine is not the one playing audio, so what it returns is
whatever stale state it happens to hold: a deck that reads `playing` with a position that never advances is exactly
a frozen countdown with a live-looking deck.

And `daemonDriven` is decided **once, one-shot** (`detectDaemon`):

```js
if (this.daemonDetectStarted) return;
this.daemonDetectStarted = true;
…
a.daemonEnabled().then(on => { this.daemonDriven = !!on; if (on) attachDaemonEvents(); });
```

If that resolves `false` — daemon socket not up at the moment this engine initialised — then **no `onDeck`
subscription is ever created and poll() owns the state permanently**, with no retry, for the life of that engine.

**I am not asserting this is the cause**, and the honest reason is the one you have used to kill every previous
theory: it does not obviously explain "worked for minutes, then froze". It is offered as the answer to what you
actually asked — *is there any other guard or condition that can short-circuit application* — and it is the only
one: **a competing writer, gated on a one-shot boolean, that silently takes ownership of the same fields.**

**And it is checkable with no new instrumentation**, because the code already logs its own answer:

- `"[ROT] daemon-driven: local advance DISABLED, mirroring ether-audiod"` → subscribed, poll only ticks position
- `"[ROT] in-process engine (daemon not active — fallback or disabled)"` → **never subscribed**, poll owns the state

Those lines are already written on every engine init. They are simply going nowhere (§2). One console read on the
frozen window shows which one fired; repairing `_rotationLogPath` would put them on disk permanently.

---

## Summary

1. **Daemon log:** proves the producer was alive and emitting at the freeze; does not and cannot show individual
   deck events, because emission was never logged.
2. **Renderer side: invisible with what exists.** The single renderer→disk channel writes to a relative path that
   does not resolve in a packaged install and fails silently. That is the blocker, stated plainly.
3. **The only condition that can short-circuit application** is not in the handler at all — it is `poll()`'s
   in-process branch overwriting `stateA/B/C`, gated on a one-shot `daemonDriven` that never retries. The code
   already logs which branch it chose; the log line has nowhere to land.

**Not proposed here:** any new cause, any new instrumentation, any fix. The three options this leaves — read the
console once, repair the existing `rotLog` path, or build the permanent sense — are yours to choose.

## Scope note

Read-only. Daemon log and install directory read, not modified. No file in `C:\openair` changed, nothing committed,
nothing built.
