# Design of record — MANUAL mode as a real contract

**Date:** 2026-07-31 · **Status:** DESIGN ONLY. Nothing built.
**Cause trace:** `docs/manual-mode-dead-air-trace-2026-07-31.md`
**Priority:** top item for the OV manual season — **ahead of the fitter arc.** A jock shift runs entirely on
these buttons.

---

## 1. The contract (Jeff, 2026-07-31 — requirements, not proposals)

1. **MANUAL stops automation DECIDING, never stops the engine RUNNING.** Press MANUAL mid-song: the song
   keeps playing, the jock takes over.
2. **With MANUAL on, everything is the jock's responsibility.** Decks loadable by hand, ON/play fully
   functional, carts and mic working over master. **Nothing automated fires** — spot anchors and the
   top-of-hour hard cut included. The jock owns the hour.
3. **Pressing AUTO starts the calendar as it stands, from the real-time clock.** No behind-mode catch-up
   over the shift's hours, no play-log reconciliation, no special separation pass. The calendar runs exactly
   what it says from now. Looking ahead and not repeating what just aired is the jock's judgment, as always.

**One sentence:** *MANUAL hands the station to a person; AUTO hands it back to the clock.*

---

## 2. What is wrong today, in one line each

| | |
|---|---|
| `stop()` empties all three decks | `_stop("A"/"B"/"C")` → Rust drops the sink **and** `loaded_files` — the deck has no source |
| `stop()` kills the poll loop | `clearInterval(this.pollTimer)` — no deck events, no position, no observability |
| Play on an empty deck is silent | Rust logs `source=None … skipping`; nobody is told |
| The UI claims "playing" unconfirmed | `getDeck().play()` sets `status:"playing"` optimistically, and no event can correct it |
| Two deciding paths are ungated | `checkEnd` (→ rotate) and `_maintain` (→ refill/preload) have **no** `_started` check |

---

## 3. `stop()` — stop deciding, keep running

```js
stop() {                                          // ← BECOMES:
  this._started = false;                          //   keep: automation is off
  clearInterval(this.pollTimer);                  //   ✗ REMOVE — the eyes must stay open
  clearInterval(this._procMeterTimer);            //   ✗ REMOVE — meters are the jock's level check
  this._stop("A"); this._stop("B"); this._stop("C");  // ✗ REMOVE — never take a jock's decks away
}
```

**After: `stop()` sets one boolean and logs.** Nothing is torn down. A song playing when MANUAL is pressed
keeps playing, because nothing told it to stop — requirement 1, satisfied by deletion rather than by new code.

**A real stop still exists** — `stopAll` (`ether-audiod.js:39`) already stops the decks explicitly, and that is
the command that should be behind any "stop everything" affordance. Automation-off and audio-off become two
different verbs, which is the conflation at the root of this whole incident.

**Shutdown must still tear down.** `stop()` is called from `automationStop` *and* from daemon shutdown; the
timer teardown moves to an explicit `dispose()` that only the shutdown path calls. **Naming this now** — a
lingering `setInterval` per station on shutdown would be a leak, and it is the obvious way to get this wrong.

## 4. The single choke point — what "deciding" means

Same shape as §3 of `design-renderer-as-pure-view-2026-07-30.md`: **one predicate, not scattered guards.**

```js
/** May automation make decisions right now? MANUAL = no. The engine keeps RUNNING either way. */
_mayDecide() { return this._started; }
```

`poll()` continues to run every 250 ms in both modes. What it does splits cleanly:

| Runs ALWAYS (the engine running) | Gated on `_mayDecide()` (automation deciding) |
|---|---|
| `_state()` read + deck state rebuild | `checkEnd` → end-detection → `handleRotate` **(ungated today — must be gated)** |
| `_maybeEmitDeck` — **deck events, so the UI stays live** | `_maintain` → refill + preload **(ungated today — must be gated)** |
| `_mixHeartbeat` — telemetry | `_segueTick` — already gated (`:1567`) |
| `_liveDeckObserverTick` — the two-decks guard | `_jingleTick` — already gated (`:1593`) |
| `_emitEngineState` — honest state | `_checkTopOfHour` — already gated (`:367`) |
| `_applyProcessingFromKv` | `_watchdog` — already gated (`:416`) |
| `_emitProcMeters` — **ungate this**; a jock needs meters (`:221`) | |

**Only two paths actually need new gates.** Four of the six deciding paths are already correct, which is why
carts and the mic kept working — and it means the change is smaller than it looks. **`_emitProcMeters` moves
the other way**: it currently gates on `_started`, so a jock in MANUAL has no processing meters. That is
backwards.

**Requirement 2 is then satisfied by construction:** with `_mayDecide()` false, no rotate, no refill, no
preload, no jingle, **no spot anchor, and no top-of-hour hard cut**. The jock owns the hour.

**The liveDeck guard keeps running in MANUAL — deliberately.** A jock can start two decks by hand; that is
their prerogative and the guard must not fight it. **Open question 1 (below).**

## 5. Play on an empty deck — an honest refusal

Rust already knows (`native/src/audio.rs:791`, `source=None, path empty — skipping`). Three changes carry that
truth to the operator:

1. **`audio_play` returns false** when the deck has no source (it returns `is_ok()` of the send today, which is
   true even when the play is skipped). The refusal becomes a value, not a stderr line.
2. **The daemon's `play` handler relays that result**, and logs a DECISION line naming the deck:
   `deck A: play refused — no source loaded (load a track first)`.
3. **The renderer stops guessing.** `getDeck().play()` must not set `status:"playing"` before the command
   returns; it awaits the result and, on refusal, leaves the deck as it was and surfaces the reason.

**Requirement: the UI never claims playing unconfirmed.** In daemon mode the `onDeck` event is the confirmation
— and because §3 keeps the poll alive, those events flow in MANUAL exactly as in AUTO.

## 6. The jock's load path

**Already built and already correct** — this is the part that needs wiring-up, not inventing:

- `loadToDeck` (`engine-rodio.ts`) → `audio:load` (`main.js:3059`) → daemon `load` → `A.audioLoad` +
  `noteManualCue(deck)`. The daemon already treats a hand-load as first-class: `noteManualCue` marks the deck
  `manualCue` so the self-heal will not preload over it, and (flip on) `_writeOperatorLogRow` writes a
  `source='operator'` row so the hand-load appears **on the calendar**.
- Existing surfaces that already call it: `JockStrip.tsx:63/67/71` (deck A/B/C), `DeckConfigurator.tsx:368`,
  Library and queue click paths (`App.tsx:1162/1897/3399`), Canvas widgets.

**So a jock can already load a deck by hand. What was broken is that the load was then thrown away by
`stop()`,** and play on the emptied deck was silent. Fix §3 and §5 and this path works as designed.

**What the UI shows in MANUAL:** live position and duration from real `onDeck` events, because the poll stays
alive. No optimistic guessing, no frozen countdown — the same event stream AUTO uses.

## 7. AUTO — "start the calendar from now"

**Mechanically this is `selectRowForNow`, which the flip already implements** (`loggen.js:242-273`): given the
wall clock, return the row whose slot has arrived. That *is* "the calendar as it stands, from the real-time
clock". Nothing new is needed for the selection itself.

`start()` must then:

1. **Adopt what is playing.** The path exists (`engine.js:1174-1187`, `alreadyOnAir` → adopt + cue idle decks
   + return). With §3 in place a jock's song is still playing when AUTO is pressed, so **AUTO takes over
   mid-song without interrupting it** — one press.
2. **Not re-air the shift.** `selectRowForNow` returns the row for *now*, so the hours the jock covered are
   simply passed over. **No catch-up content plays.**
3. **No play-log reconciliation, no special separation pass** — neither exists in this path today, and none is
   to be added.

**The one thing that does happen, and I want it explicitly approved or removed:** `_refillFromLog` stamps
skipped-past rows `'missed'` (`engine.js:838`). After a three-hour shift that is ~60 rows in one stamp. It is
**bookkeeping, not catch-up** — nothing is aired, and without it those rows sit `pending` forever and become
exactly the stale-row debris we cleaned out of station 4 yesterday. **My recommendation: keep it, but emit one
summary line** (`calendar resumed at 14:05 — 62 rows from the manual shift retired`) instead of the current
"behind Xm" alarm wording, which reads like a fault when it is a handover. **Open question 2.**

## 8. The four-toggle bug

**Cause:** the jock's failed play left the deck *meta* saying `playing` with no source. On AUTO,
`claimsOnAir` was true and `_isAudiblyOnAir()` false → the force-restart path — correct, and it fired
(`decks claim playing but output is SILENT (observed) — NOT adopting` ×6). What defeated it was racing:
`automationStop` landed **2 ms** after an `automationStart` (17:51:32.786 → .788) as the jock kept clicking.

**Fix is mostly §3 and §5:** with decks never emptied, there is no silent-claiming-playing state to recover
from — AUTO adopts a genuinely playing deck in one press. Two hardening items regardless:

- **Serialize the mode toggle.** `automationStart`/`automationStop` should run on the advance chain like every
  other state change, so a fast double-click queues rather than interleaves.
- **The silent-while-playing detector stays exactly as it is.** It behaved correctly throughout and is the
  reason this failed loudly rather than silently.

## 9. Blast radius

**`stop()` is called on all four stations, and MANUAL is what the OV season runs on.** This is the most
consequential change in the current arc — bigger than the fitter, which is why it goes first.

| Risk | Mitigation |
|---|---|
| **Shutdown leaks timers** — the removed `clearInterval` still has to happen somewhere | Explicit `dispose()` on the shutdown path only; bench asserts no live timer after dispose |
| **A "stop" that no longer stops** — an operator expecting silence gets audio | `stopAll` already exists and is the correct verb; audit which UI control is wired to which |
| **Automation resuming when it should not** — a mis-gated path deciding in MANUAL | One predicate, benched per path; four of six are already gated and unchanged |
| **AUTO interrupting a jock's song** | Adopt path already exists; bench it explicitly |
| Legacy vs flip stations | `selectRowForNow` is flip-only; legacy AUTO resume keeps today's behaviour |

**Failure mode if wrong:** automation firing during a live jock shift (a rotate or hard cut under a talk
break) — audible and embarrassing. **That is the case the benches must cover hardest.**

## 10. Benches — `audiod/smoke-manual-mode.js` (new)

Pure, no audio/DB/daemon, in the shape of `smoke-seam-stop.js`:

**The contract:**
1. `stop()` leaves all three decks untouched — no `_stop` call, tripwired.
2. `stop()` leaves `pollTimer` **alive**; `dispose()` clears it.
3. `_mayDecide()` false ⇒ `checkEnd` does not rotate, `_maintain` does not refill or preload,
   `_checkTopOfHour` does not hard-cut, `_segueTick`/`_jingleTick` no-op — **one assertion per path**, since
   any single leak is a live-air fault.
4. `_mayDecide()` false ⇒ `_maybeEmitDeck` **still fires** (the UI stays live) and `_emitProcMeters` still
   emits.
5. The liveDeck guard still runs in MANUAL (per open question 1's answer).

**The handover:**
6. MANUAL pressed mid-song: the playing deck's status is unchanged after `stop()`.
7. AUTO pressed with a deck genuinely playing → adopts, does not restart it, cues the idle decks — **one
   press**.
8. AUTO pressed with nothing playing → loads and plays the row for now.
9. Rapid MANUAL/AUTO/MANUAL/AUTO → serialized, ends in the state of the last press (the four-toggle case).

**Empty-deck honesty:**
10. Play on a deck with no source → refusal returned, DECISION line logged, deck status **not** "playing".
11. Load-then-play on the same deck → sounds, status "playing" only after confirmation.

**Plus:** `smoke-seam-stop` (35), `smoke-nearest-anchor` (37), `smoke-autofit` (47) must stay green —
`stop()` and the poll are shared with the guard.

## 11. Open questions — answer before build

1. **Does the liveDeck guard enforce in MANUAL?** A jock may deliberately run two decks (a bed under a talk
   break). **My recommendation: observe-only in MANUAL, enforce in AUTO** — the guard exists to catch
   automation losing track of itself, not to overrule a person.
2. **The `'missed'` stamp on AUTO resume** — keep as bookkeeping with a calm summary line (my recommendation),
   or suppress entirely for the manual window?
3. **Is there a "stop everything" control today, and what is it wired to?** If a UI control currently relies on
   `automationStop` to silence the station, it needs re-pointing at `stopAll` in the same release.
4. **MANUAL and the stream** — the Icecast feed keeps running regardless, but should a jock's dead air (no deck
   playing, deliberately) suppress the dead-air watchdog? Today the watchdog is already gated off in MANUAL, so
   the answer is "yes, already". **Confirm that is intended** — it means nothing rescues a jock who walks away.

---

**Approval requested on:** the `stop()` deletion + `dispose()` split (§3), the single-choke-point split (§4),
the empty-deck refusal (§5), the AUTO-resume semantics (§7), and the four open questions. **Building nothing
until approved.**
