# AUTO cycle → double-play, and why the flip still hasn't engaged

**Date:** 2026-07-30 · **Mode:** READ-ONLY. Daemon log + live DB (`readOnly`) read. Nothing changed.
**Build on air:** 4.4.108.

---

## 1. The foreign deck — now traced to an inbound `load`, with a name

**`stop()` DOES stop the decks.** `audiod/engine.js:240-246`:

```js
stop() {
  this._started = false;
  if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  if (this._procMeterTimer) { … }
  this._stop("A"); this._stop("B"); this._stop("C");     // ← all three
}
```

**`start()` does NOT unconditionally play deck A.** `engine.js:1141-1200` has an adopt guard:

```js
await this.refillIfNeeded();                                     :1150
const claimsOnAir = order.some(d => …status === "playing") || …   :1156
const alreadyOnAir = claimsOnAir && await this._isAudiblyOnAir(); :1165
if (claimsOnAir && !alreadyOnAir) { …hard-stop A/B/C; force fresh… }  :1166-1173
if (alreadyOnAir) { …adopt, cue idle decks, RETURN… }             :1174-1187
// only if nothing was on air:
this.loadToDeck("A", first); this._play("A");                     :1189-1199
```

So a healthy `automationStop` → `automationStart` cannot itself produce two decks: stop kills all three, then start finds nothing on air and starts exactly one. **That path is not the trigger.**

### What the log actually shows at both episodes

**There is no `automationStop`/`automationStart` for station 4 at 16:32 or 16:37.** The only s4 automation command in the window is a bare `automationStart` at **16:30:41** (s1/s2/s3 got stop+start pairs at 16:31:22-16:31:32). What immediately precedes each foreign deck is this:

```
16:35:05.582  LOG-READER: operator deck-load → wrote source='operator' log row "Jingle Bell Rock - John's Version"
16:35:06.829  LOG-READER: operator deck-load → wrote source='operator' log row "Holiday Road - 2024 Remaster"
16:35:10.254  [mix s4] active=2 | A a=1 p=0 | B a=1 p=0
16:35:13.347  liveDeck OBSERVER — TWO DECKS ON AIR (station 4): engine live deck B="California Christmas" | FOREIGN A="Holiday Road - 2024 Remaster"
…
16:37:23.798  LOG-READER: operator deck-load → wrote source='operator' log row "Candy Christmas"
16:37:25.041  LOG-READER: operator deck-load → wrote source='operator' log row "Spot_Free_Christmas…"
16:37:24.227  [mix s4] active=2 | A a=1 p=0 | B a=1 p=0
16:37:31.671  liveDeck OBSERVER — TWO DECKS ON AIR (station 4): engine live deck B="Numbah One Day Of Christmas" | FOREIGN A="Holiday Road - 2024 Remaster"
```

**That line is written by an inbound `load` command.** `_writeOperatorLogRow` is reached from
`noteManualCue` (`engine.js:1017-1025`), which the daemon calls on **every `load` command**:

```js
audiod/ether-audiod.js:107
load: (m) => { … const r = A.audioLoad(m.deck, …, m.stationId); const e = engines.get(m.stationId); if (e) e.noteManualCue(m.deck); return r; }
```

**So: something outside the advance chain is issuing `load` (in pairs) for station 4's decks, and then a
`play`.** That is exactly the out-of-chain start named in
`docs/station4-double-play-root-cause-2026-07-29.md` §3 — and turning the flip on has made it **visible for
the first time**, because §2.5's operator-row writer logs it. Before today those loads left no trace at all
(`LOGGED_CMDS`, `ether-audiod.js:188`, excludes `load`/`play`).

**What I can and cannot say.** The log proves *a `load` arrived and a second deck began sounding*. It does
**not** name the sender. The strongest candidate remains station 4's renderer `AudioEngine` — it is the only
station with `is_active = 1` and therefore the only one whose engine is `init()`-ed (`src/App.tsx:1084-1086`),
and its deck commands are forwarded straight into the daemon's Rust engine (`electron/main.js:3059-3078`).
The correlation with an AUTO cycle fits: after `automationStart` the renderer re-runs its own startup
automation and loads decks. **Unproven** until the `[ROT]` repair lands (`main.js:3299` writes to a path that
does not exist in a packaged install — authorised, still unbuilt).

**The observer did its job.** It named both episodes, both decks, both titles, held-duration, and stated it
did not act: *"held 48.2s past grace. NOT STOPPED (observation-only release)."* Both cleared only when the
Bug-A guard caught deck A on its next real rotate (`16:35:51.736 stop:A — outgoing still playing past grace
(same source) → FORCE stop`) — 46 s and 50.6 s of two songs on air.

### This is the enforcement fix's justification

Two independent episodes in three minutes, each ~50 s of double-play, on a live station, with a **named,
reproducible trigger class** (an inbound `load` while a deck is live). The observation-only release has now
done what it was built to do: it converted a silent fault into a logged one and gave the enforcement step a
concrete, measured case. **(c)-enforce — the engine owns `liveDeck` and stops any other playing music deck
past the grace — is now justified by live evidence, not by inference.**

## 2. Why the flip still hasn't engaged — and it IS on

**The flag is on, and was on before the 16:37 episode.** No stale click intervened:

```
s1 '1' 16:33:07.179   s2 '1' 16:33:07.802   s3 '1' 16:33:08.473   s4 '1' 16:34:23.490
```

**`_logReaderOn()` is returning TRUE for station 4** — proven by behaviour, not by reading the flag:
`_writeOperatorLogRow` early-returns unless the flip is on (`engine.js:874`,
`if (!this._logReaderOn() || …) return;`), and it fired four times at 16:35 and 16:37.

**`start()` does consult it.** `start()` → `await this.refillIfNeeded()` (`:1150`) → `refillIfNeeded` checks
the flag *first*, before any queue-length test (`:739`):

```js
async refillIfNeeded() {
  if (!this.continuous) return;
  if (this._logReaderOn()) return this._refillFromLog();   // ← flip path, no queue gate
  if (this.queue.length >= 5) return;                      // ← legacy gate
  …
}
```

**The reason nothing happened is timing plus one gate:**

1. **The last `automationStart` for s4 was 16:30:41 — before the flag went on at 16:34:23.** That refill
   correctly took the legacy path because the flag was still `'0'`.
2. **Since then nothing has called `refillIfNeeded` at all.** The only routine caller is `_maintain`, and it
   is gated on the *caller* side:

   ```js
   audiod/engine.js:524
   if (this.continuous && this.queue.length < 5) this.refillIfNeeded();
   ```

   The queue has been 17-19 the whole time (Health Monitor shows `q 17`). **The flip's own no-queue-gate
   check at `:739` is never reached, because the call never happens.**

That is the complete explanation for "canary reads ON, AUTO cycled, refill still legacy, no missed-stamping":
`generated_schedule` for s4 is still `pending 15117 · played 1871 · playing 1` — **zero `missed`**, because
`_refillFromLog` has not executed once.

**One AUTO cycle on station 4 now would engage it**, since `start()` calls `refillIfNeeded()` unconditionally
and the flag is finally on. Expect, in order: `LOG-READER: behind Xm — stamped N skipped-past rows 'missed'`
then `logreader refill: N pending from log (mode=…)`.

**Also worth flagging:** `_refillFromLog` only logs when the pending region *changes*
(`if (oldPending !== newPending)`, `:861-864`). So its silence is not by itself proof it didn't run — the
`missed` count is the reliable receipt, and it is zero.

## 3. Two defects reported from the screenshot

**(a) The terminal rendered as a bottom row, not a second column.** My breakpoint is too high:
`TWO_COL_MIN_PX = 1000` (`src/components/HealthMonitor.tsx:12`), measured against `window.innerWidth`. The
Station Health **popout** in the screenshot is roughly 950 px wide, so it fell back to the stacked layout
exactly as written — correct code, wrong threshold for the window this panel actually lives in. **My error.**
Fix: lower the threshold (~820) and measure the panel's own container rather than the window, so the popout
and the docked panel each decide independently.

**(b) The countdown froze again on 4.4.108.** The screenshot shows deck 2 at `3:33 / 3:33` (clamped) while the
Health Monitor reports the same station at `-1:12` remaining — the renderer and the daemon disagree, which is
the unfixed mixing defect in `docs/deck-state-mixed-across-tracks-2026-07-29.md` §1-2
(`engine-rodio.ts:438-440`). **I am not claiming 4.4.108 didn't cause it.** What 4.4.108 newly adds to the
renderer is the Live Activity poll — one IPC call per second plus a parse and a React state update on a buffer
of up to 800 lines. That is real, continuous renderer work that did not exist in 4.4.106, and I cannot rule it
out as an aggravator. **Test that settles it in one minute: close the Station Health window entirely and watch
a deck for a couple of songs.** If the countdown is healthy with the panel closed and freezes with it open,
the terminal is implicated and I will make it cheaper (render only the filtered slice, throttle the poll,
stop polling when the panel is hidden). If it freezes either way, it is the pre-existing mixing bug and
4.4.108 is not the cause.

---

## Scope note

Read-only. No file in `C:\openair` changed, nothing committed, nothing built. **Fix nothing yet**, per
instruction — the three candidates above (enforce, breakpoint, terminal cost) are yours to authorise.
