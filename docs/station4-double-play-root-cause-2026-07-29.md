# Station 4 double-play — root cause, with the blast radius named

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Live daemon log read; nothing changed, nothing built, no daemon command
issued. Station left on air untouched.
**Builds on:** `docs/station4-double-play-live-capture-2026-07-29.md`.

---

## The moment it went wrong, from the Rust mixer's own count

`active=` is the number of decks actually mixing. Station 4, unfiltered:

```
22:03:41.271  [engine s4] segue: deck C LIVE — Kana Kaloka
22:03:44.777  [engine s4] advance → stop:B
22:03:45.168  [engine s4] JIN SCHEDULED — for deck C's upcoming seam (read-ahead)
22:03:46.194  [mix s4] active=1 | A a=0 p=1 | B a=0 p=1 | C a=1 p=0      ← C alone. Correct.
22:03:56.575  [mix s4] active=1 | A a=0 p=1 | B a=0 p=1 | C a=1 p=0
22:04:00.000  [engine s4] JIN SCHEDULED — for deck A's upcoming seam (read-ahead)
22:04:01.795  [mix s4] active=2 | A a=1 p=0 | B a=0 p=1 | C a=1 p=0      ← A STARTS. TWO DECKS.
   …          active=2 sustained for ~83 s …
22:05:24.293  [mix s4] active=2 | A a=1 p=0 | B a=0 p=1 | C a=1 p=0
22:05:29.437  [mix s4] active=1 | A a=1 p=0 | B a=0 p=1 | C a=1 p=1      ← C → active AND paused, stuck
```

**Between 22:03:45 and 22:04:00 there is not one `[engine s4]` line.** No `handleRotate`, no `segue overlap`, no
`deck A LIVE`. Deck A began playing at ~22:04:01 **without the daemon's advance chain doing it** — the very next
engine line (22:04:00) already treats deck A as the airing deck when scheduling its seam jingle.

Kana Kaloka is an 18-second track. C started at 22:03:41, so its natural seam was ~22:03:59 — precisely when A came
up. Something rotated C → A at C's seam **outside the logged chain**.

## 1. Why `stop:C` was never issued

Because **the daemon never rotated out of C.** Every `stop:X` in this engine is armed inside one place —
`handleRotate` — as a deferred, generation-checked stop of the *outgoing* deck:

```js
audiod/engine.js:605-617
const fromGen = this.deckGen[fromId];
setTimeout(() => this._advance("stop:" + fromId, async () => {
  const act = this._outgoingStopAction(fromId, fromGen, toId);
  if (act !== "stop") return;
  if (this._deckState(fromId).status === "playing") this._log("stop:" + fromId + " — outgoing still playing past grace (same source) → FORCE stop (Bug-A guard)");
  this._stop(fromId);
  …
}), cfMs + 500);
```

`fromId` only exists because `handleRotate` ran. **No rotate ⇒ no `fromId` ⇒ no deferred stop ⇒ no guard.** The
daemon's chain went straight from "C is live" to, three minutes later, treating **A** as the outgoing deck at
22:06:13 (`segue overlap: A→B`). C was never any rotate's `fromId`, so nothing in the daemon was ever going to stop
it. It has now been active for over half an hour.

## 2. Why the Bug-A guard caught A at 22:06:17 but not C

It fired for A because A **was** a rotate's `fromId`:

```
22:06:13.920  segue overlap: A→B  → advance → handleRotate      ← A is the outgoing deck
22:06:17.423  stop:A — outgoing still playing past grace (same source) → FORCE stop (Bug-A guard)
```

That is the guard working exactly as designed (`engine.js:564-571`, hardened 2026-07-22 after the OF two-decks
incident): the outgoing deck was still reporting `playing` past the crossfade grace, so it was force-stopped rather
than skipped.

**The difference is not how C exited — it is that C never exited through the chain at all.** The guard is armed by
`handleRotate` and only ever inspects that rotate's `fromId`. A deck that stops being the live deck by any other
means is outside the guard's field of view entirely.

## 3. The hole

**Yes — a deck can become "no longer live" without either a normal stop or the guard.**

`handleRotate` is not the only thing that can start a deck on a station. The daemon exposes direct commands that go
straight to Rust, bypassing the engine's chain and its bookkeeping:

```js
audiod/ether-audiod.js:106   load: (m) => A.audioLoad(m.deck, m.filePath, …, m.stationId)
audiod/ether-audiod.js:107   play: (m) => A.audioPlay(m.deck, m.stationId)
```

Anything that issues `play` for deck A goes into the **same Rust engine** the DaemonEngine is running. Rust now has
two decks sounding; the DaemonEngine's model still says C is live and has no `fromId` to stop. **The engine's stop
bookkeeping is keyed to its own rotates, so a deck started from outside is invisible to it and a deck superseded from
outside is never stopped.**

**Who issued that play is not in this log** — the daemon logs its own decisions, not inbound `play`/`load` commands
(`LOGGED_CMDS`, `ether-audiod.js:188`, deliberately excludes routine traffic). The strongest available candidate,
and I flag it as a candidate rather than a finding: a **renderer-side engine in in-process mode** running its own
end-detection and advance. Its deck commands are forwarded to the daemon, so they land in the daemon's Rust engine
exactly like this, unlogged. That would also account for the renderer showing different decks than the daemon and
for the frozen countdown — one Rust engine, two brains. **It is unprovable from disk today** because the
`[ROT] daemon-driven` / `[ROT] in-process` line goes to a path that does not exist in a packaged install
(`main.js:3299`) — the repair already authorised and not yet built.

**What the log does prove, and this is enough to act on:** a deck was started outside the chain, and the chain has
no mechanism to ever stop it.

## 4. The fix — and the blast radius first

**Blast radius: this is the live-air advance path.** `handleRotate` and the deferred stop are what put every song on
every station on air. A wrong stop here is dead air or a cut-off song on all four stations, immediately, with no
staging. The 2026-07-22 Bug-A hardening exists because a previous change in this exact code caused the OF two-decks
incident. There is a smoke test — `audiod/smoke-seam-stop.js`, which `_outgoingStopAction` was deliberately factored
to be testable against — and any change here must extend it before shipping.

**Given that, the correct fix is the smallest possible one, and it is NOT in the rotate path.**

Do not add logic to `handleRotate`, do not change `_outgoingStopAction`, and do not change what the deferred stop
does. All of that is working — it caught A. The gap is that **nothing enforces "at most one music deck is playing"
independently of the chain.**

Proposed: a **standalone invariant check in the existing 250 ms `poll()`** — where the watchdog, segue tick and
jingle tick already live — that observes Rust's own truth and acts only on a state the chain can never produce:

- read the per-deck active/paused state the mixer already reports;
- if **more than one music deck (A/B/C) is simultaneously active**, and the condition persists beyond the
  crossfade/overlap grace (so legitimate segue overlap is never touched), then **stop the deck that is not the
  engine's current live deck**, and log it loudly as an invariant breach with which deck and why;
- never touch the deck the engine believes is live, and never run during an in-flight advance.

Three properties make it safe where a rotate-path change would not be: it is **additive** (no existing branch
changes), it is **observation-driven** (it reads Rust, not the engine's model, so it catches exactly the case where
the two disagree), and it **cannot fire during normal operation** because normal operation never sustains two active
music decks past the overlap grace — as stations 2 and 3 demonstrate continuously.

It also turns this failure from silent to loud, which is the deeper problem: **the station aired two songs for over
half an hour and nothing in the product said so.**

**What it does not do:** it does not stop the out-of-chain `play` from happening. It bounds the damage. Finding and
closing the source needs the `[ROT]` repair (to establish whether the renderer is in in-process mode on station 4)
and is a separate change.

---

## Filed, not chased

The Health Monitor reports Christmas In July at **13k/s** while the daemon's own mixer log shows station 4
producing the same frames per tick as station 2 (`+227702` vs `+227702`) with identical drain (355050 B/s vs target
352800). **Station 4's reported numbers are wrong; its actual output is not.** Same pattern as the deck UI — s4's
numbers arrive wrong. Noted, not investigated, per instruction.

## Scope note

Read-only. Nothing built, nothing committed, no daemon command issued, station still on air with the fault present.
