# Station 4 vs stations 1–3 — the difference, not the mechanism

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Daemon log read, live DB opened `readOnly: true`. Nothing changed,
nothing built, no daemon command issued.
**Question as posed:** stations 1/2/3 stop their outgoing decks correctly; station 4 left deck C airing after
rotation moved past it. **What is station 4 doing differently?**

---

## The answer, up front

**Station 4 is the station the renderer has open — `is_active = 1`. It is the only station with a second thing
able to start and stop its decks.**

It is **config, not data.** Nothing about what Christmas In July *plays* differs from what the other stations play.
The difference is which station the app is looking at.

```
id  name                is_active
 1  Open Format             0
 2  halloVeen               0
 3  Magical Forest          0
 4  Christmas In July       1      ← the only one
```

Why that is the difference, in two receipts:

```js
// electron/main.js:3059-3078 — renderer deck commands are FORWARDED INTO THE DAEMON
ipcMain.handle("audio:load", … AUDIO_DAEMON ? audiodClient.cmd("load", { deck, filePath, …, stationId }) : …);
ipcMain.handle("audio:play", (_, deck, stationId) => AUDIO_DAEMON ? audiodClient.cmd("play", { deck, stationId }) : …);
```

```js
// src/App.tsx:1084-1086 — only the ACTIVE station's engine is ever init()-ed
// "We never call getEngine(targetId).* for a non-active station — those engines are created
//  but never init()-ed, so their daemonDriven is false and they'd misfire"
```

So the renderer's `AudioEngine` for the **active** station runs live and its deck commands land **inside the daemon's
own Rust engine** — the same engine `DaemonEngine` is driving — through `audio:load` / `audio:play`. Stations 1–3
have renderer engines that are never init()-ed: **one brain each.** Station 4 has two.

And the daemon cannot see the second one. `load` and `play` are deliberately excluded from the daemon's command log:

```js
audiod/ether-audiod.js:188
const LOGGED_CMDS = new Set(["automationStart","automationStop","skip","fill","init","shutdown","startStream","stopStream"]);
```

That is exactly why deck A appears in the mixer at 22:04:01 with **no `[engine s4]` line of any kind** in the fifteen
seconds before it.

---

## What I ruled out first — station 4's routine behaviour is IDENTICAL to 2 and 3

### Rotation shape — the same

```
                     deck A LIVE   deck B LIVE   deck C LIVE
  s2                      32            36            33
  s3                      35            37            36
  s4                      33            41            30      ← same distribution
```

### Deck occupancy — the same. s4 spends *less* time on C, not more

```
  s2   A-live 32%   B-live 33%   C-live 34%   (3196 mix samples)
  s3   A-live 32%   B-live 30%   C-live 37%   (3198)
  s4   A-live 32%   B-live 45%   C-live 23%   (3208)
```

### Stops keep up with rotations — s4 is not behind

```
  s2:  LIVE=34  stop=34   s3:  LIVE=32  stop=32   s4:  LIVE=25  stop=26  (+1 forced by the Bug-A guard)
```

### Segue overlap is transient on every station — except once

Run-length of consecutive `active>=2` mix samples (samples ~5 s apart):

```
  s2:  29 × run of 1 sample     ← every overlap is a normal 3 s segue
  s3:  29 × run of 1 sample
  s4:  36 × run of 1 sample  +  ONE run of 17 samples (~85 s)      ← the double-play
```

**Station 4's normal segues are normal.** There is one event, not a pattern.

### The content theory is dead

The 18-second item is the **spot**, not the song, and every station has one:

```
  s2: 11.468 s spot × 7      s3: 11.468 s spot × 9      s4: 18.13 s spot × 11
```

Kana Kaloka's DB duration matches its decoded duration exactly — there is no short-track or metadata mismatch:

```
songs id=518  "Kana Kaloka"  duration_ms = 162821          (2:42)
daemon decoded duration seen in the log: 162.82122448979592 s
```

`clock_breaks` are at parity too (s1 3, s2 3, s3 4, s4 3). **Nothing about s4's content or clock produces a
different path.**

---

## What occurs on station 4 and NEVER on 1, 2 or 3

All three are the same thing said three ways — **the daemon's model of the decks disagrees with Rust's:**

| Signal | s1 | s2 | s3 | **s4** |
|---|---|---|---|---|
| Sustained `active>=2` (double-play) | 0 | 0 | 0 | **1 run, ~85 s** |
| Mix samples with `a=1 p=1` (active **and** paused) | 0 | 0 | 0 | **635** — 22:05:29 → 22:59:57 (54 min) |
| `watchdog: STALL — no deck playing` **while Rust has a deck active** | 0 | 0 | 0 | **3** (22:24, 22:39, 22:49) |

A watchdog stall means the engine believed nothing was playing at a moment the mixer shows `A a=1 p=0`. That is not
a stop bug — **that is the engine reading a deck table that someone else has been writing.**

---

## Why the disagreement went silent instead of self-correcting (mechanism — noted, not the answer)

The daemon does not track "the deck I rotated to." It picks the live deck by **alphabetical scan**:

```js
audiod/engine.js:1299
const P = ["A", "B", "C"].find(d => this._deckState(d).status === "playing");
```

So when deck **A** started at 22:04:01 while **C** was still playing, `P` flipped C→A instantly — A sorts first —
and the engine simply carried on with A. Its very next act is the read-ahead re-targeting, which is the only trace
left in the log:

```
22:03:45.168  JIN SCHEDULED … for deck C's upcoming seam      ← engine thinks C is live
22:04:01.795  [mix s4] active=2 | A a=1 p=0 | C a=1 p=0       ← A starts, unlogged
22:04:00.000  JIN SCHEDULED … for deck A's upcoming seam      ← engine now thinks A is live
```

C was never any rotate's `fromId`, so the deferred stop was never armed and the Bug-A guard — which only ever
inspects a rotate's own `fromId` — had nothing to inspect. It caught A three minutes later precisely *because* A
went out through a real rotate (`segue overlap: A→B` at 22:06:13 → forced `stop:A` at 22:06:17).

The fault cleared itself at the **23:00 top-of-hour HARD CUT**, which resets all decks. Station 4 has rotated
cleanly since (`stop:C` at 23:37:17 and 23:43:51).

---

## What I cannot claim

**I cannot prove from disk which of the two brains issued that `play`.** Two channels are missing, and both are
already known:

1. The renderer's mode line — `[ROT] daemon-driven` vs `[ROT] in-process` — goes to
   `__dirname/../tmp-userdata/rotation.log` (`electron/main.js:3299`), a path that does not exist in a packaged
   install, inside a silent `try/catch`. **That is the repair you already authorised and I have not built.** It
   answers whether station 4's renderer engine was running its own advance.
2. The daemon does not log inbound `load`/`play` (`LOGGED_CMDS`, above), so an out-of-chain deck start leaves no
   record at all.

What the log *does* prove is the shape: **a deck was started on station 4 outside the daemon's advance chain, and
station 4 is the only station where a second command source exists.**

---

## Two smaller s4-only divergences, filed not chased

- `clocks.station_uuid` is **NULL** for station 4's clock ("Summer Christmas"); stations 1–3 all carry one. A
  click-created-vs-install divergence, same family as the missing `station_name` kv noted in
  `docs/station-parity-deck-events-2026-07-29.md`. Not implicated here — the daemon keys by integer id.
- `icecast_bitrate` 320 vs 128 on the others. Stream encoder only; no deck path.
- Health Monitor reporting s4 at 13k/s against a mixer log showing parity with s2 — still filed, still not chased.

---

## Scope note

Read-only. Daemon log and live DB read (`readOnly: true`), no file in `C:\openair` changed, nothing committed,
nothing built, no daemon command issued. Diagnostic scripts live in the session scratchpad, not the repo.
