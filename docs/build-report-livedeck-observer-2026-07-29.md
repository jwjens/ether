# Build report — liveDeck OBSERVER (observation-only)

**Date:** 2026-07-29 · **Scope:** §3(c) of `docs/short-track-timing-premise-check-2026-07-29.md`, shipped as the
observation-only step named in §4. **(a) and (b) untouched. No stop, rotate or timing path altered.**
**State:** SHIPPED as **4.4.105**. Bench green (27/27), typecheck at baseline, installer built locally.
**Artifact:** `C:\openair\dist-electron\Ether Setup 4.4.105.exe` — not pushed, not installed.

---

## Does the observer survive a poll-silent window? — the window was never poll-silent

**The 15 s of `[engine s4]` silence was the DECISION log going quiet, not `poll()` stopping.** Receipt — every
station-4 line in that window:

```
22:03:45.168  [engine s4] JIN SCHEDULED — … for deck C's upcoming seam
22:03:46.194  [mix s4] active=1 …          ← poll() ran
22:03:51.368  [mix s4] active=1 …          ← poll() ran
22:03:56.575  [mix s4] active=1 …          ← poll() ran
22:04:00.000  [engine s4] JIN SCHEDULED — … for deck A's upcoming seam
22:04:01.795  [mix s4] active=2 …          ← poll() ran; A is now foreign
```

`_mixHeartbeat` is called **from inside `poll()`** (`engine.js:284`) and emitted three times across the window.
`poll()` was running its full 250 ms cadence the entire time — roughly 60 ticks. It logged nothing because it had
no *decision* to log: no rotate, no stop, no end. **The engine's eyes were open; it simply had nothing to say.**
So an in-`poll()` hook is not blind at the moment of failure — it is the only thing that *was* awake.

An independent timer would be **worse, not better**: the observer reads `this.stateA/B/C`, which only `poll()`
refreshes. A separate timer would report stale state, and if `poll()` ever truly stopped, the engine would have no
state at all to observe — that is a dead-engine condition the watchdog owns, not an anomaly this can describe.

**One real hazard did exist, and it is now closed.** The first cut placed the call at the END of `poll()`, after
`checkEnd` / `_maintain` / `_jingleTick` / `_segueTick` / `_checkTopOfHour` / `_watchdog`. A throw in any of those
would have skipped the anomaly report for that tick. **Moved to `engine.js:298`** — immediately after the deck
states are rebuilt from Rust and **before any decision work**:

```js
this.stateA = { ...makeState("A", s.deckA), … };
this.stateB = { ...makeState("B", s.deckB), … };
this.stateC = { ...makeState("C", s.deckC), … };

this._liveDeckObserverTick(now);        // ← nothing downstream can skip it

for (const id of ["A","B","C"]) this._maybeEmitDeck(id);
```

Only `_mixHeartbeat` and `_applyProcessingFromKv` precede it, both already `try/catch`-wrapped. It now reads the
freshest possible state and cannot be starved by a failure anywhere else in the tick. **Moving it changes no
output — its position is free of side effects precisely because it only logs.**

---

## Blast radius — confirmed: output cannot change

**Every edit is additive. Not one existing statement was modified, reordered, or removed.** The full diff of
`audiod/engine.js` is 4 hunks; here is what each does to running behaviour:

| # | `audiod/engine.js` | What it does | Effect on output |
|---|---|---|---|
| 1 | `:104-114` (constructor) | Declares three new fields — `liveDeck`, `_foreignSince`, `_foreignLastLogAt` | **None.** New fields; nothing existing reads them. |
| 2 | `:240-249` (`_play`) | Adds `if (this._isRotationDeck(deck)) this.liveDeck = deck;` **above** the untouched body | **None.** One assignment to a new field. `this.segueTriggered.delete(deck)` and `return A.audioPlay(deck, this.stationId)` are byte-identical and still run in the same order. |
| 3 | `:294-298` (`poll()`) | Adds `this._liveDeckObserverTick(now);` after the deck-state rebuild, before `_maybeEmitDeck` | **None on playout.** It reads state and logs; it calls no actuator, so no decision below it can be affected. |
| 4 | `:1313-1366` (new methods) | `_isRotationDeck`, `_foreignPlayingDecks`, `_foreignGraceMs`, `_liveDeckObserverTick` | **None.** New methods; the only caller is #3. |

**`P` is untouched.** `engine.js:1299`'s `const P = ["A","B","C"].find(d => this._deckState(d).status === "playing")`
is unchanged and still drives every existing decision in `_segueTick` and `_jingleTick`. The observer runs
*alongside* it and, when they disagree, prints both answers.

**Nothing reads `liveDeck` except the observer** — audited across `audiod/`, `src/`, `electron/`:

```
audiod/engine.js:247    this.liveDeck = deck            ← the only WRITE
audiod/engine.js:1337   this._foreignPlayingDecks(this.liveDeck, statuses)   ← the only functional READ
audiod/engine.js:1341,1360   …the two log lines
```

(The two hits at `src/audio/engine-rodio.ts:578-579` are a pre-existing local variable of the same name in the
renderer's rotate guard — unrelated, unchanged, not this field.)

**The observer cannot act.** It has no call to `_stop`, `_play`, `_load`, `handleRotate`, `_advance`, `preload` or
`emit`. It calls `this._log` and nothing else. That is asserted, not asserted-by-eye — see tests 12 below.

**It cannot throw into playout.** Wrapped in `try/catch` with the same contract and wording as `_segueTick` /
`_jingleTick` (`:1365`), and tested (14).

---

## What it does

**`liveDeck` = the deck the engine itself put on air.** Set in `_play()` (`engine.js:247`), which is the single
funnel every rotation path goes through — `handleRotate` (`:623`), `load-next` (`:674`), `play-now` (`:1128`),
`skip` (`:1486`), `top-of-hour` (`:397`), `resume-playout` (`:465`, `:482`), `automationStart` (`:1194`). One
assignment covers all eight; no per-site edits. `CART` (the jingle overlay) is excluded — it is not a rotation deck.

**Each poll tick (250 ms), if a music deck other than `liveDeck` is playing past a grace, it says so — loudly, in
the daemon log that already works.** Verbatim, from the bench driving the exact 2026-07-29 state:

```
[engine s99] liveDeck OBSERVER — TWO DECKS ON AIR (station 99): engine live deck C="Kana Kaloka" 21.0/162.8s
             | FOREIGN A="Foreign" 12.0/136.8s — held 7.5s past grace. NOT STOPPED (observation-only release).
             alphabetical P would pick A.
```

Station, both deck ids, both titles, both positions and durations — and the alphabetical answer next to the real
one, so the log itself carries the proof of the diagnosis.

**Cadence:** silent inside the grace, one line on the transition, one line per 10 s while it persists (the
2026-07-29 event ran 85 s → ~9 lines), one line when it clears with the held duration. It cannot spam.

**The grace is derived, not hardcoded** (`_foreignGraceMs`, `:1330`): `(segueOverlap + crossfadeDuration) × 1000 +
1500` = **7500 ms** at today's settings. A legitimate segue overlap resolves at `crossfadeDuration × 1000 + 500` =
3500 ms, so **normal seams on stations 2 and 3 never reach the threshold and never log**. If either setting
changes, the threshold tracks it.

**When `liveDeck` is unknown** (fresh engine, nothing rotated yet) it reports nothing — never claim an anomaly that
cannot be attributed.

---

## Would it have caught the 2026-07-29 event? Yes — and here is the honest limit

The out-of-chain start came in through the daemon's direct `play` command (`audiod/ether-audiod.js:107` →
`A.audioPlay` on the Rust engine), which **never passes through `engine._play`**. So `liveDeck` would have stayed
`C` while deck A began sounding, and the observer would have printed the line at ~22:04:09 — 7.5 s into the 85 s
double-play, instead of the silence that actually occurred.

**The limit, stated plainly:** the observer keys on `status === "playing"`. The 54-minute tail of that incident —
deck C stuck at `a=1 p=1`, active in the Rust mix but flagged **paused** — would **not** be reported, because the
engine's own deck state says C is not playing. Catching that needs the mixer's `active` count rather than the deck
status, which is a different sense and not in this release.

---

## Bench — `audiod/smoke-seam-stop.js`, extended

`node audiod/smoke-seam-stop.js` → **✅ ALL PASS (27 passed, 0 failed)**. The 5 original Bug-A guard cases are
unchanged and still pass; 22 new cases were added. The bench stays free of audio/DB/pipe — `_play` is covered
through the real `_isRotationDeck` predicate rather than by invoking the addon, so running it opens no engine and
no port.

Coverage of note:

- **(7)** the exact incident shape — `live=C`, `A` started outside the chain → `["A"]` foreign — plus an explicit
  assertion that alphabetical `P` disagrees with `liveDeck`. The defect is now pinned by a test.
- **(10)** the grace outlasts a normal segue overlap, and is derived from the settings (re-checked at
  `segueOverlap=6, crossfadeDuration=5`).
- **(12) the scope invariant.** `_stop`, `_play`, `_load` and `handleRotate` are each replaced with tripwires and
  the tick is driven through the full double-play sequence; four assertions confirm **no deck was stopped, played,
  loaded, or rotated**. This is the test that holds the observation-only promise if someone later edits the tick.
- **(14)** the tick swallows its own errors — playout unaffected.

## Typecheck

`./node_modules/.bin/tsc --noEmit` → **exactly the 2 accepted-baseline errors** (`OnboardingFlow.tsx:2039`,
`PhoneDesk.tsx:777`). **No new errors.** (`audiod/` is plain JS and outside the TS program; the gate is run to
confirm nothing else regressed.)

## Architecture compliance

- **BUILD THE SENSE, NOT THE SCAFFOLD** — this is permanent built-in observability on an existing, working channel
  (the daemon log), not a temporary watcher. Nothing to tear down, no `docs/backlog.md` entry required.
- **Correct minimal solution** — what I deliberately did **not** build: (a) the effective-overlap clamp, (b) the
  observed-condition stop, any enforcement in (c), any Health Monitor surface, any new event channel, and any change
  to `P`.
- **Physical deck positions are sacred** — no deck mapping touched.
- Sequencing from §4 of the premise-check doc is intact: **(c)-observe** → (a) → (b) → (c)-enforce, one per release.

## Files changed

```
audiod/engine.js            +81  −1   (4 additive hunks; the −1 is _play's one-line body becoming a block)
audiod/smoke-seam-stop.js   +84  −0
```

## What I need from you

Authorisation to bump, commit and build. **On the next release the thing to watch is the daemon log**: a
`liveDeck OBSERVER — TWO DECKS ON AIR` line appearing on station 4 (and its absence on 1-3 during normal seams) is
the on-air proof of the diagnosis, at zero output risk. If it never appears, the liveDeck theory is wrong and we
have learned that too.
