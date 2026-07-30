# Short-track segue/stop timing — premise check, then the real no-floor defect

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Daemon log and source read; nothing changed, nothing built.
**Asked:** confirm that station 4's short tracks (~30 s avg, an 18 s track) break a segue/stop timing calc that
assumes tracks are longer than the segue window, producing both the missed `stop:C` and the frozen countdown.

---

## Premise check first — and it does not hold. Receipts before anything else.

Every decoded track duration in the log, per station (`deck X ended (pos=a/b s)` — the daemon's own decoded
duration, not DB metadata):

```
       n     mean     median    min      under 60s      under 30s
 s2   117   160.1s    166.3s   11.5s    27 (23%)       17 (15%)
 s3   124   153.1s    167.7s   11.5s    21 (17%)       21 (17%)
 s4   132   140.1s    140.9s   18.1s    22 (17%)       22 (17%)
```

Three things follow, and each one cuts against the premise:

1. **Station 4 averages 140 s, not ~30 s.** Its median is 140.9 s — full songs.
2. **Station 4's shortest item is 18.1 s. Stations 2 and 3 both go down to 11.5 s** — they play *shorter* content
   than station 4 does, 7 and 9 times respectively.
3. **Short content is not more common on station 4.** Under 30 s: s2 15%, s3 17%, s4 17%. Under 60 s: s2 **23%**,
   s3 17%, s4 17%. Station 2 — which stops its decks correctly every time — has the *most* short content, including
   a whole band station 4 doesn't have (47.96, 48.40, 50.63, 50.81, 53.14, 60.12, 62.06, 63.66, 64.57 s). **Station
   4's shortest music track is 72.86 s**; its 18.13 s item is the spot, and every station has one.

And the tracks actually involved in the incident were all long:

```
 outgoing B  "Morning Christmas"   205.98 s
 the deck that was orphaned, C  "Kana Kaloka"   162.82 s   (songs.duration_ms = 162821 — DB and decode agree)
 the deck that stole the chain, A                136.83 s
```

**So short content did not trigger this event, and short content is not what distinguishes station 4.** I am
stating that plainly because a premise that survives into a design doc gets built on. If there is a station-4 track
list from a different window that shows a 30 s average, that would change this — the check is a duration histogram
over that window; the one above covers 21:25 → 01:57 and is everything the log holds.

---

## 1. The segue/stop timing calc, cited — and where it *does* break

The numbers are real and worth having on the record regardless.

```js
audiod/engine.js:95    this.crossfadeDuration = 3;      // seconds
audiod/engine.js:102   this.segueOverlap      = 3;      // seconds
```

**When the rotate fires** (`_segueTick`, `engine.js:1298-1317`):

```js
const P = ["A","B","C"].find(d => this._deckState(d).status === "playing");
const st = this._deckState(P);
const remaining = (st.durationSec || 0) - (st.positionSec || 0);
if (!(remaining > 0 && remaining <= this.segueOverlap)) return;
…
this.handleRotate(P, nextDeck);
```

**When the outgoing deck is stopped** (`handleRotate`, `engine.js:599, 605-617`):

```js
const cfMs = this.crossfadeDuration * 1000;              // 3000
const fromGen = this.deckGen[fromId];
setTimeout(() => this._advance("stop:" + fromId, async () => {
  const act = this._outgoingStopAction(fromId, fromGen, toId);
  if (act !== "stop") return;                            // 'skip-reloaded' | 'skip-target'
  …
  this._stop(fromId);
}), cfMs + 500);                                          // 3500 ms after the rotate — a FIXED timer
```

**The assumption, stated exactly:** the rotate fires when `remaining <= 3 s`, and the outgoing deck's stop is a
**fixed 3500 ms timer** from that moment. Both hold only while a track is comfortably longer than ~3 s.

**Where it genuinely breaks — the floor is ~3 s, not 18-30 s:**

- **Duration ≤ segueOverlap (3 s):** `remaining = duration - 0` is already `<= 3` **at position 0**, so the segue
  fires the instant the track starts. A 2-second sounder loaded as a rotation item is rotated past before it plays.
  `remaining > 0` is the only floor, and it is not a floor at all.
- **A track shorter than 3500 ms as the *incoming*:** it ends and rotates onward before the previous outgoing's
  stop timer lands. The stop still evaluates correctly (`deckGen` unchanged, `fromId !== toId` → `"stop"`) — but it
  now fires *after* a subsequent rotate, into a chain that has moved on.
- **The `skip-reloaded` window is live in normal operation, at any track length.** The engine re-preloads the
  outgoing deck on its end, and that lands *inside* the 3500 ms window:

  ```
  22:03:41.266  handleRotate B→C      → stop:B armed for ~22:03:44.77
  22:03:43.347  deck B ended → advance → preload:B      ← re-preload at +2.08 s, INSIDE the window
  22:03:44.777  advance → stop:B                        ← evaluates against a deckGen that may have moved
  ```

  If the preload bumped `deckGen[B]`, `_outgoingStopAction` returns `"skip-reloaded"` and the stop is **skipped with
  no log line** — indistinguishable in the log from a stop that happened. That is a real silent path, and it is a
  race against preload timing, not against track length.
- **Jingle seam:** `lead_in = 5 s` with the arm window (`_ARM_WINDOW_S`) means a track shorter than the lead-in has
  its jingle arm before the track has meaningfully started (`engine.js:1375-1385`).

**None of these fired in this incident** — the tracks were 136-206 s — but every one of them is a real no-floor
defect under your "no minimum-length assumption" rule.

## 2. Do both symptoms trace to this calc? **No — and they are not the same calc.**

### The missed `stop:C` — nothing was ever *scheduled*, so no schedule could be mistimed

A stop only exists because `handleRotate` armed it. For the 22:03:41 instance of deck C there is **no
`handleRotate`, no `segue overlap: C→…`, and no `deck C ended`** — the log is empty of `[engine s4]` lines from
22:03:45.168 to 22:04:00.000. Deck A appears in the mixer at 22:04:01.795 with nothing having rotated into it.

What actually happened is `engine.js:1299`:

```js
const P = ["A","B","C"].find(d => this._deckState(d).status === "playing");
```

The engine identifies the live deck by **alphabetical scan**, not by the deck it rotated into. The moment A became
playing alongside C, `P` flipped C→A — A sorts first — and the engine carried on with A. C was never any rotate's
`fromId`, so no stop was armed and the Bug-A guard, which only inspects a rotate's own `fromId`, had nothing to
inspect. **This is a missing-schedule bug, not a mistimed-schedule bug.**

### The frozen countdown — the duration shown was the *wrong track's*, so it is not a clamp at true duration

The UI held **`0:18 / 0:18`** under the title *Kana Kaloka*. Kana Kaloka is **162.82 s** (DB `duration_ms = 162821`,
decoded 162.82122448979592 s in the log). 18.13 s is the **spot's** duration.

So the renderer was holding **the spot's duration with a different track's title** — a mixed state. The clamp
itself (`src/audio/engine-rodio.ts:438-440`) is `Math.min(pos + elapsed, dur || 9999)`: it pins position at whatever
duration the renderer holds. It faithfully clamped a duration that was already wrong. **Position running past a
short duration is not the cause; carrying the wrong duration is.**

**Answer to the question as put: two different calcs, and they do not share the duration-vs-segue-window
assumption.** One symptom is daemon-side (a deck that never entered a rotate), one is renderer-side (deck state
mixed across tracks). That is the same two-faults split recorded in
`docs/station4-double-play-live-capture-2026-07-29.md`, and the comparison in
`docs/station4-vs-working-stations-diff-2026-07-29.md` still stands: station 4 is the only station with
`is_active = 1`, hence the only one whose renderer engine is `init()`-ed and able to drive the daemon's Rust engine
through `audio:load` / `audio:play` (`electron/main.js:3059-3078`) outside the advance chain and outside
`LOGGED_CMDS`.

## 3. The fix, no floor and no ceiling — correct for a 2-second sounder and a 10-minute mix

Three independent changes. Only the first two are the timing work you asked about; the third is the one that
actually addresses the incident.

**(a) Make the overlap a property of the track, not a constant.** Replace the bare comparison with an effective
overlap that can never exceed what the track can give, and never fire before the deck has genuinely started:

```
effectiveOverlap = min(segueOverlap, duration * OVERLAP_MAX_FRACTION)     // e.g. never more than ~⅓ of the track
fire when  positionSec > 0  AND  remaining > 0  AND  remaining <= effectiveOverlap
```

For a 180 s song `effectiveOverlap` is 3 s — **bit-identical to today**. For a 6 s sounder it becomes 2 s. For a
2 s sounder it becomes ~0.7 s and the rotate can no longer fire at position 0.

**(b) Stop the outgoing deck on an observed condition, not a fixed timer.** `cfMs + 500` becomes the *earliest*
moment the stop may run, not the only one. From that point the existing 250 ms `poll()` re-evaluates
`_outgoingStopAction` each tick until it resolves, and — critically — **`skip-reloaded` stops being a silent
permanent skip**: it logs, and if the deck is still sounding the old source it is stopped anyway. This is what makes
the stop correct at any track length: it stops at the *actual* end rather than at a predicted one.

**(c) The engine must own which deck is live.** `P = ["A","B","C"].find(playing)` is the hole. Track the deck the
engine rotated into (`this.liveDeck`), use that as `P`, and treat any *other* playing music deck as an anomaly:
log it loudly and stop it. That single change would have caught this incident — C keeps `P`, A is recognised as
foreign, and the double-play ends in one poll tick instead of 85 seconds. It also makes the failure loud, which is
the deeper problem here: **the station aired two songs for a minute and a half and nothing said so.**

## 4. Blast radius

**This is the live-air advance path on four stations with no staging.** `_segueTick` and `handleRotate` put every
song on air. A wrong stop is a cut-off song; a wrong rotate is dead air; both are audible to listeners immediately.
The 2026-07-22 Bug-A hardening exists *because* a previous change to this exact code caused the 2026-07-21 OF
two-decks incident — this is the second time this code has been opened for a two-decks bug.

**What must not change, and how each item is protected:**

| Must not change | Protection |
|---|---|
| Normal-length segues on s2/s3 — 3 s overlap, same seam, same feel | (a) is `min()` against a fraction: for any track over ~9 s the result is exactly 3 s. Prove it with a table of durations 9 s → 600 s showing `effectiveOverlap === 3`. |
| Clean spot edges — a SPOT never overlaps | Untouched. The `deckContentClass` branch (`engine.js:1311`) sits before any change in (a). |
| Bug-A semantics — `skip-reloaded` never wipes a freshly preloaded source | (b) must keep returning `skip-reloaded` for that case; the only new behaviour is that it is logged and re-evaluated, never that it stops a fresh source. `_outgoingStopAction` stays pure and stays under `audiod/smoke-seam-stop.js`. |
| Jingle bridging / underlap weave | (b) changes only *when* the stop is re-checked, not the bridge path. Verify a full jingle seam on a normal track before and after. |
| Manual X-key crossfade | `crossfadeDuration` is a distinct setting (`engine.js:95-96`); do not fold it into the overlap change. |

**Risk surface, ranked:**

1. **(b) is the dangerous one** — it converts a one-shot stop into a repeating one. A wrong predicate stops a deck
   that should be playing. It must never evaluate against the live deck, and `skip-target` must remain absolute.
2. **(c) is medium risk and high value** — changing how `P` is chosen changes what every downstream tick
   (segue, jingle, watchdog) considers "the playing deck". Ship it behind an explicit anomaly log first so it
   *reports* foreign decks for one release before it *stops* them.
3. **(a) is the lowest risk** — pure arithmetic, provably identity for all normal content.

**Sequencing I'd recommend, one per release:** (c)-as-observation-only → (a) → (b) → (c)-as-enforcement.
`audiod/smoke-seam-stop.js` must be extended before each, and each needs a normal-length seam verified on air.

---

## Scope note

Read-only. Daemon log and live DB read (`readOnly: true`), source read, no file in `C:\openair` changed, nothing
committed, nothing built, no daemon command issued. **No code written — awaiting your call on the blast radius,
and on the premise correction above.**
