# Design of record — nearest-anchor seam selection (spots land closest to their anchor)

**Date:** 2026-07-30 · **Status:** DESIGN ONLY, read-only. Nothing built.
**Scope:** the log-reader flip's refill path only. **Legacy stations are untouched by construction.**

---

## The rule (Jeff, treated as given)

> **Early or late does not matter — closest to the anchor wins.**
> At each seam: `|t − A|` vs `|(t + d) − A|`, take the smaller.

Where `t` = the seam, `A` = the spot's anchor (`generated_schedule.scheduled_at`), `d` = the duration of the
music row that would otherwise air.

**Worked against the live 2026-07-30 case** (clock: `minute=0/20/40`, anchor `A = 11:19:50`):

```
seam 11:17:18   spot now → 152s early   ·  music (164s) first → 12s late    → MUSIC
seam 11:20:49   spot now →  59s late    ·  music (211s) first → 259s late   → SPOT
```

The spot airs at the seam nearest its anchor and nothing is cut. Early-vs-late never has to be decided as a
policy — it falls out of the comparison.

## What this is NOT

- **It never interrupts a playing deck.** Every decision happens at a seam that was going to occur anyway.
- **It does not touch `handleRotate`, `_segueTick`, the deferred stop, or the Bug-A/liveDeck guards.**
- **It does not run on legacy stations** — the hook is inside `_refillFromLog`, which only executes when
  `_logReaderOn()` is true for that station.

---

## Where it hooks

`audiod/engine.js:805` `_refillFromLog()`. The pending region is already rebuilt there from the anchored
read:

```js
:810   r = loggen.readLogAnchored(this.db, this.stationId, 20);   // rows, scheduled_at ASC
:814   const boundHead = this.queue.filter(q => this.boundQids.has(q.qid));   // the cued decks — kept
:849   const seen = …; const kept = [];   for (const it of r.items) { …dedup / playability… }
:856   const freshPending = this._ensureIds(kept);
:858   this.queue = [...boundHead, ...freshPending];
```

**One insertion point:** between `:849`'s filter and `:856`, reorder `kept` with a pure function. Nothing
else in the method changes.

```js
const ordered = loggen.orderForNearestAnchor(kept, seamTs, { … });
const freshPending = this._ensureIds(ordered);
```

`seamTs` — the projected next seam — is `now + remaining(playing deck)`, computable from state the engine
already holds (`_deckState(P).durationSec − positionSec`, the same values `_segueTick` uses at `:1303`). When
no deck is playing, `seamTs = now`.

### The selector — pure, testable, no I/O

```
orderForNearestAnchor(items, seamTs, { reachMode, tieSec, hourStartTs }) → items

1. spotIdx  = first item with contentClass === 'SPOT'        → none? return items unchanged
2. musicIdx = first item with contentClass !== 'SPOT'        → none? return items unchanged
3. A = items[spotIdx].scheduledAt ;  d = items[musicIdx].durationMs / 1000
4. OUT OF SCOPE (§4): A >= nextTopOfHour  → return unchanged   (the hard cut owns it)
5. REACH  (§1):      (A − seamTs) > d     → return unchanged   (anchor further than one candidate song)
6. nowDist   = |seamTs − A|
   afterDist = |(seamTs + d) − A|
7. TIE (§2): if (afterDist − nowDist) <= tieSec → return unchanged    (prefer log order)
   else if nowDist < afterDist → promote the spot BLOCK (§3) to the head
   else → return unchanged
```

Pure in, pure out — benchable in `audiod/smoke-*.js` with no audio, DB or daemon, like
`_outgoingStopAction` and `_foreignPlayingDecks`.

---

## The four open points, settled

### 1. Reach window — one candidate-song duration

`(A − seamTs) > d` ⇒ out of reach, leave the log alone. Rationale: the comparison only has meaning when
airing the spot at *this* seam is a live option. If the anchor is further away than the song that would fill
the gap, the song cannot overshoot it, so there is nothing to weigh — and considering distant anchors would
have the engine "thinking about" a spot an hour out at every refill.

**Note the asymmetry, deliberately:** a **past** anchor (`A < seamTs`) is always in reach, because
`A − seamTs` is negative. An overdue spot is aired at the next seam, which is what "closest to" demands —
`nowDist` can only grow by waiting.

### 2. Near-ties — `tieSec = 2`, prefer log order

Promote only when `afterDist − nowDist > 2s`. Two reasons the tie-break is *not* symmetric:

- **Stability.** `seamTs` is a projection that shifts by fractions of a second between refills (the 2 s
  throttle means several evaluations per seam). A strict `<` would let a 0.3 s difference flip the queue head
  back and forth between refills — the queue would flap, and the operator would watch Up Next change its mind.
- **Log order is the tie-break with meaning.** When the two options are equally good, the schedule's own
  order is the answer already on record and visible on the calendar.

### 3. Multiple spots in one break — promote the whole block, compare on the first

Today `clock_breaks` for station 4 is `count=1` at each of `minute=0/20/40`, so this is forward-looking — but
the rule must be stated or it becomes an accident later.

- A **break block** = the run of consecutive `SPOT` items sharing the same anchor `A` (or within a few
  seconds of it), in log order.
- The comparison uses **the first spot's anchor and the block's head** — because what "lands on the anchor"
  is the *start* of the break, not its middle.
- If promoted, **the entire block moves together, order preserved.** A break is atomic: splitting one across
  a song would be worse than either option being compared.
- `d` remains the *first* music row's duration — the question is still "does one song fit before the break".

### 4. Top of the hour — the hard cut keeps it, unconditionally

`_hardCutTopOfHour` (`engine.js:375`) does **not** go through `_refillFromLog`: it clears the queue and
refills from `loggen.fillFromHour(hourStartTs)`. So it is structurally untouched by this change.

The one hazard is this selector *pre-empting* a `:00` spot a few seconds early and leaving the hard cut to
fire a second one. Closed explicitly by step 4: **an anchor at or beyond the next top-of-hour is out of
scope.** `:00` stays forced by the hard cut, exactly as it is today — and it is currently the only anchor
that lands exactly, which is worth preserving rather than competing with.

---

## The honest limitation — and the companion change it implies

**Reordering the pending region cannot move a deck that is already cued.** `boundHead` (`:814`) is preserved
by §2.4a, and `preload` pulls from the queue at rotate time, so this selector decides **one preload ahead**.

Concretely: it changes what gets cued for the *next* seam, not what is already sitting on a standby deck. In
the live case that is enough — the promotion happens at the 11:17 refill, which cues the spot for the 11:20
seam. But if both standby decks are already cued with music when the anchor comes into reach, the spot still
waits one extra song.

**To be truly nearest, the design needs a bounded companion:** when the selector promotes a spot block and a
standby deck is cued with a music row **that has not started**, re-cue that deck to the spot. Strictly
scoped — SPOT promotions only, unstarted decks only, never the playing deck — it is still inside
`_refillFromLog`'s remit (it owns the queue and the bound head), and it cannot stop or start anything
audible.

**I am flagging this rather than folding it in.** It is a bounded exception to "never drop the bound head",
which is a rule with a reason, and it deserves an explicit yes rather than arriving as an implementation
detail. **Without it, this design gets spots within one song of their anchor. With it, within one seam.**

---

## Blast radius

**Confined to flipped stations, and to queue *ordering* only.**

| | Effect |
|---|---|
| Legacy stations (1, 2, 3 today) | **None.** `_refillFromLog` never runs for them. |
| `handleRotate` / `_segueTick` / deferred stop / Bug-A / liveDeck guard | **Untouched.** |
| Top-of-hour hard cut | **Untouched** (§4), and explicitly excluded from the selector. |
| Playing deck | **Never touched.** No stop, no cut, no fade. |
| Emergency floor, missed-stamping, ahead/behind handling | **Untouched** — the insertion is after all of them. |
| Up Next display | **Changes** — the operator will see a spot move to the head when it is promoted. That is the feature; it should be visible before air, not a surprise. |

**Failure mode if the arithmetic is wrong:** a spot airs at the wrong seam — early or late by one song. It
is a *scheduling* error, audible as a mistimed break, **not dead air and not a double-play.** The selector
cannot produce silence (it only reorders rows that were already going to air) and cannot produce two decks
(it issues no deck commands).

**Bench before build:** the worked 11:17/11:20 case above, the reach boundary, a past anchor, a near-tie in
both directions, a multi-spot block, an anchor at `:00`, no-spot and no-music inputs. All pure — no audio, no
DB.

## Sequencing

1. The pure selector + bench, wired into `_refillFromLog` — this document.
2. **Decide the companion re-cue** (above) — separately, on its own approval.
3. Generate placing spots *on* `:00/:20/:40` rather than where the fill lands (`11:19:50`, `11:39:30`,
   `12:21:17` today) — a Generate fix, not playout. Nearest-anchor selection absorbs a 10-30 s placement
   error, but "closest to `11:19:50`" is still closest to the wrong target.

**Not bundled:** the auto-fitter (this is one decision at one seam; the fitter reshapes the hour), the
`_schedCursor` sharing, and §1/§2 of the renderer-as-pure-view design.

---

**Approval requested on:** the selector contract, the four settled points, and — separately — whether the
companion re-cue of an unstarted deck is in scope. **Building nothing until approved.**
