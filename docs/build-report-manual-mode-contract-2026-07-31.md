# Build report — MANUAL mode as a real contract

**Date:** 2026-07-31 · **Design:** `docs/design-manual-mode-contract-2026-07-31.md` (approved, all sections
+ four answers) · **Cause:** `docs/manual-mode-dead-air-trace-2026-07-31.md`
**Gates:** `tsc --noEmit` at baseline · **smoke-manual-mode 30/30 (new)** · seam-stop 35/35 ·
nearest-anchor 37/37 · autofit 47/47 · logreader-anchor 18/18.
**Ships before the fitter's observation day.**

---

## The shape of the fix: mostly deletion

`stop()` was tearing the engine down when the operator asked only to stop automating. It is now two lines.

```js
stop() {                                                    // BEFORE → AFTER
  this._started = false;                                    // kept
  clearInterval(this.pollTimer);                            // ✗ deleted → dispose()
  clearInterval(this._procMeterTimer);                      // ✗ deleted → dispose()
  this._stop("A"); this._stop("B"); this._stop("C");        // ✗ deleted — never take a jock's decks
}
```

**Requirement 1 — "press MANUAL mid-song and the song keeps playing" — is satisfied by removing code.**
Nothing tells the song to stop, so it doesn't.

`dispose()` takes the teardown and is called from exactly one place: `shutdown()`
(`ether-audiod.js:287`). Named in the design as the obvious way to get this wrong; benched.

## The single choke point — two gates, not six

`_mayDecide()` is the one predicate. Auditing every path showed the change is smaller than the incident:

| Path | Before | Now |
|---|---|---|
| `checkEnd` → end-detection → rotate | **ungated** | gated |
| `_maintain` → refill + preload | **ungated** | gated |
| `_checkTopOfHour` (`:367`) · `_watchdog` (`:416`) · `_segueTick` (`:1567`) · `_jingleTick` (`:1593`) | already gated | unchanged |
| `_emitProcMeters` (`:221`) | gated on `_started` | **ungated** — meters are the jock's level check |

**Only two paths were actually leaking**, which is exactly why carts and the mic kept working through the
incident. `_emitProcMeters` moved the other way: gating meters on automation meant a jock in MANUAL had no
levels, which was backwards.

**Requirement 2 by construction:** with `_mayDecide()` false there is no rotate, refill, preload, jingle,
**spot anchor or top-of-hour hard cut.** The jock owns the hour.

**Per-station by construction too** — `_started` is per-engine, so one station in MANUAL leaves the other
three deciding, untouched. That is the OV shape: turn up the local monitor on one station, press MANUAL,
run the shift.

## Empty-deck refusal — end to end

Three layers, because the failure was that every layer reported success over silence.

1. **Rust** (`native/src/lib.rs`) — `audio_play` returns **false without setting `status = "playing"`** when
   the deck has no content. It previously set playing unconditionally and returned `is_ok()` of the send,
   which is true even when the audio thread then skips the play. `audio_stop` now clears `file_path`
   alongside dropping the sink and `loaded_files`, so that field is an honest "this deck has content"
   signal and nothing above can claim otherwise.
2. **Daemon** (`ether-audiod.js`) — the `play` handler relays the refusal as a DECISION line:
   `deck A: play REFUSED — no content loaded (load a track onto this deck first)`.
3. **Renderer** (`engine-rodio.ts`) — `getDeck().play()` is now **async and awaits the result**. On refusal
   it leaves the deck exactly as it was and fires `onDeckRefused(deckId, reason)`. It no longer marks the
   deck "playing" before the command goes out.

**Requirement: the UI never claims playing unconfirmed.** In daemon mode the `onDeck` event is the
confirmation — and because the poll now stays alive, those events flow in MANUAL exactly as in AUTO.

## The four answers

1. **liveDeck guard: observe in MANUAL, enforce in AUTO.** A jock may deliberately run two decks under a
   talk break. It still logs — and the line now says which mode it is in rather than claiming
   `STOPPING` while observing, which would have been a new honesty bug.
2. **`'missed'` stamp kept, calm wording.** `_resumingFromManual` is set when `start()` finds automation was
   off, so the first refill after a shift reads
   `calendar resumed at 14:05 — 62 rows from the manual shift retired` instead of the "behind Xm" alarm.
   Nothing airs; without the stamp those rows become the stale-row debris cleaned out of station 4 on
   2026-07-30.
3. **Stop-everything audit — nothing is mis-wired.** `stop_all` → `stopAll` (`App.tsx:1093`),
   `automation_off` → `automationStop` (`:1123`), `stopDaemonAutomation()` → the AUTO button (`:1867`).
   Both verbs were already used correctly; **no re-pointing was needed.** Reporting that rather than
   claiming a fix I did not have to make.
4. **Dead-air watchdog off in MANUAL: confirmed intended**, and benched (3f). The help-doc note is listed
   under *Not in this release* below.

## Toggle serialization

`modeToggle(stationId, fn)` chains `automationStart`/`automationStop` per station, so a fast double-click
**queues rather than races**. On 2026-07-31 an `automationStop` landed **2 ms** after an `automationStart`
mid-adopt, and it took four presses to recover. Per-station, so a jock toggling one station never queues
behind another's automation.

## Bench — `audiod/smoke-manual-mode.js`, 30/30

All eleven named cases. **One assertion per deciding path**, because any single leak is a live-air fault:

```
3a checkEnd does NOT rotate          3d segue overlap does NOT fire (no spot anchor)
3b _maintain does NOT preload/refill 3e jingle tick does not arm or fire
3c top-of-hour hard cut does NOT fire 3f dead-air watchdog does NOT force an advance
```

Plus: `stop()` touches no deck and leaves both timers alive while `dispose()` clears them; deck events and
proc meters still fire in MANUAL; the guard observes in MANUAL and enforces in AUTO (both asserted against
the same two-deck shape); MANUAL mid-song leaves the deck playing **and holding its content**; AUTO adopts
a genuinely playing deck without restarting or reloading it and flags the calm-summary path.

**`smoke-seam-stop` went red and I fixed the FIXTURE, not the code.** Its engine had `_started` false, so
the guard correctly observed instead of enforcing — new, intended behaviour. The bench tests the AUTO case,
so its rig now says `_started = true`. **The failure was the bench being right about the old contract.**

## Blast radius

`stop()` is on the live-air path for all four stations. Per Jeff's narrowing, in operation MANUAL touches
**one** engine while three keep deciding; the all-stations concern is daemon shutdown only, which
`dispose()` covers and case 2 benches.

**Failure mode if wrong:** automation firing during a live shift — a rotate or hard cut under a talk break.
That is what the six §3 assertions exist for.

**Native change:** `native/src/lib.rs` is Rust — it needs `ether-audio.node` rebuilt to take effect. **The
JS and renderer layers are complete and inert without it:** the daemon's refusal line only fires when
`audioPlay` returns false, and the renderer only acts on `ok === false`. Until the addon is rebuilt, play
behaves as before — no regression, but **the empty-deck refusal is not live until then.** Stating it
plainly rather than implying §5 is fully in the artifact.

## Not in this release

- **The help-doc note** for answer 4 (the jock owns the silence — the dead-air watchdog does not rescue an
  unattended MANUAL station). The feature's help entry is owed before this is called done.
- **The cart wall** (8 → 24 strip, 64-slot window, square tiles, responsive rows). Assessed, not started:
  `DEFAULT_CART_KEYS` (`DeckConfigurator.tsx:484`) holds 18 keys and needs a key strategy beyond
  `1-0/QWERTYUI`; the strip is a `slice(0, 8)` flex row that becomes three rows of 8; the window needs a
  new responsive square-tile grid. **And I found no cart persistence or MIDI mapping at all** — assignments
  appear to live in component state only, so "make the count growable" is partly "add persistence that does
  not exist yet". That needs its own pass, not the tail of this one.

## Files

```
audiod/engine.js              stop()/dispose() split · _mayDecide() · checkEnd + _maintain gates
                             · _emitProcMeters ungate · guard observe-in-MANUAL · _resumingFromManual
audiod/ether-audiod.js       modeToggle() serialization · play-refusal DECISION line · shutdown → dispose()
native/src/lib.rs            audio_play refuses an empty deck · audio_stop clears file_path
src/audio/engine-rodio.ts    play() awaits the result, never claims playing unconfirmed · onDeckRefused
audiod/smoke-manual-mode.js  NEW — 30 assertions
audiod/smoke-seam-stop.js    fixture set to AUTO (the guard now enforces only while deciding)
```
