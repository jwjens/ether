# Build report — nearest-anchor seam selection + companion re-cue

**Date:** 2026-07-30 · **Scope:** `docs/design-nearest-anchor-seam-selection-2026-07-30.md`, both approved
parts. **Flip path only — legacy stations untouched by construction.**
**Gates:** new bench 37/37 · `smoke-seam-stop.js` 35/35 · `smoke-logreader-anchor.js` 18/18 ·
`tsc --noEmit` at baseline. **No bump, no commit, no build.**

---

## 1. The selector — pure, in `loggen.js`

`orderForNearestAnchor(items, seamTs, opts)` — no I/O, same shape as `selectRowForNow` and
`_outgoingStopAction` so it benches off-air. It **only reorders rows that were already going to air**: it
issues no deck command, never touches the playing deck, and cannot produce silence.

```js
nowDist   = |seamTs − A|
afterDist = |(seamTs + d) − A|
promote the spot block when (afterDist − nowDist) > tieSec
```

Returns the **same array identity** when nothing changes, so the caller detects a no-op without comparing
contents.

### The four settled points, as built

| § | Rule | Implementation |
|---|---|---|
| 1 | Reach = one candidate-song duration | `if ((A - seamTs) > d) return items;` — and a **past** anchor is always in reach, because `A − seamTs` goes negative. An overdue spot airs at the next seam; waiting can only make it worse. |
| 2 | Near-tie → log order | `if ((afterDist - nowDist) <= tieSec) return items;` with `tieSec = 2`. Asymmetric on purpose: `seamTs` is a projection that moves between refills, so a strict `<` would flap the queue head. |
| 3 | Multi-spot break is atomic | `spotBlockAt()` collects the contiguous SPOT run within 5 s of the first anchor; the block moves whole, order preserved. Comparison uses the **first** anchor (what lands on the anchor is the *start* of the break) and `d` stays the first music row's duration. |
| 4 | `:00` belongs to the hard cut | `if (A >= opts.nextHourTs) return items;` — the selector never pre-empts an anchor the top-of-hour cut will fire itself. |

## 2. The companion re-cue — `engine.js`

A promotion only reaches air if a deck can take it; without this, "closest" degrades to within-one-**song**
instead of within-one-**seam**. `_recueForPromotedSpot(head)` is bounded exactly as approved:

```js
if (!head || head.contentClass !== "SPOT") return;        // SPOT promotions only
const target = ["A","B","C"].find(d =>
  d !== this.liveDeck &&                                   // never the live deck
  this._deckState(d).status !== "playing" &&               // never something already sounding
  this.deckReady.has(d));                                  // it holds a cue we would have aired
if (cur.filePath === head.filePath) return;                // idempotent
if (!this.loadToDeck(target, head)) return;                // failure leaves the old cue intact
```

It may **load**. It never plays, never stops, never rotates. Wrapped in `try/catch` with the same
"playout unaffected" contract as the other ticks.

## 3. Wiring — one insertion point

`_refillFromLog` (`engine.js:848-870`), between the existing dedup/playability filter and `_ensureIds`:

```js
const seamTs = this._projectedSeamTs();
const ordered = loggen.orderForNearestAnchor(kept, seamTs, { nextHourTs: this._nextTopOfHourTs() });
const promoted = ordered !== kept;
…
if (promoted) this._recueForPromotedSpot(freshPending[0]);
```

Two small helpers alongside: `_projectedSeamTs()` (now + remaining on the playing deck — reads the same
fields `_segueTick` uses, writes nothing) and `_nextTopOfHourTs()`.

**Nothing else in `_refillFromLog` changed** — the emergency floor, missed-stamping, ahead/behind handling
and the bound-head preservation are all upstream of the insertion and untouched.

## 4. Bench — `audiod/smoke-nearest-anchor.js`, 37 cases, all pass

No audio, no DB, no daemon — safe to run anytime. Every case named in the design, plus the degenerate inputs:

**The worked live case** (station 4, anchor `11:19:50`) is encoded directly:

```
seam 11:17:18, d=164s  → music first (12s late beats 152s early)     → MUSIC   ✓
seam 11:17:18, d=211s  → music first (220s late beats 152s early)    → MUSIC   ✓
seam 11:20:49, d=211s  → spot now   (59s late beats 259s late)       → SPOT    ✓
```

Also: reach boundary at exactly `A − seam == d` **and** one second beyond; past anchor; exact tie, 2 s
near-tie, and a 4 s clear win; music-clearly-better; multi-spot block promoted whole; a distant spot **not**
swept into the block; `:00` excluded while `11:58:30` is still evaluated; no-spot / no-music / spot-already-
first / single / empty / non-array; unanchored spot; zero-duration music; `NaN` seam; and the same-identity
no-op contract.

**Re-cue cases (9):** unstarted deck re-cued + dequeued + logged; a **playing** deck never re-cued; the
**live** deck never re-cued; no cued standby → nothing; a MUSIC head never re-cued; idempotent when the deck
already holds that spot; **never plays**; **never stops**; a failed load leaves the previous cue; never
throws.

## 5. Gates

```
node audiod/smoke-nearest-anchor.js                                    → ✅ 37/37   (new)
node audiod/smoke-seam-stop.js                                         → ✅ 35/35   (liveDeck guard, unchanged)
ELECTRON_RUN_AS_NODE=1 electron.exe audiod/smoke-logreader-anchor.js   → ✅ 18/18   (flip selector, unchanged)
./node_modules/.bin/tsc --noEmit                                       → 2 accepted-baseline errors only
```

**One thing worth recording:** `smoke-logreader-anchor.js` crashes under plain `node` with
`ERR_DLOPEN_FAILED` — the known `better-sqlite3`-built-for-Electron ABI mismatch, **not** a regression. I
verified that by stashing my changes and reproducing the identical failure, then ran it the documented way
(`ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe …`) where it passes 18/18. Worth a line in
that file's header so the next person doesn't read it as breakage.

## 6. Blast radius

| | Effect |
|---|---|
| Legacy stations | **None.** `_refillFromLog` only runs when `_logReaderOn()` is true. |
| `handleRotate` / `_segueTick` / deferred stop / Bug-A / liveDeck guard | **Untouched.** |
| Top-of-hour hard cut | **Untouched**, and explicitly excluded from the selector (§4). |
| Playing deck | **Never touched** — no stop, no cut, no fade. |
| Emergency floor / missed-stamping / ahead-behind | **Untouched** — upstream of the insertion. |
| Up Next | **Changes** when a spot is promoted, and the re-cue is logged (`nearest-anchor: re-cued deck X to SPOT "…"`). Visible before air, which is the point. |

**Failure mode if the arithmetic is wrong:** a spot airs at the wrong seam — early or late by one song. A
mistimed break, **not dead air and not a double-play**: the selector issues no deck commands, and the re-cue
can only load onto a deck that is not sounding.

## 7. What to watch on air

Christmas In July is the only flipped station currently executing the log-reader. After install:

- `nearest-anchor: re-cued deck X to SPOT "…" — anchor <ts>` in the daemon log, shortly before a break.
- The `:20` and `:40` spots landing within seconds of their anchor instead of one song late.
- `:00` unchanged — still fired by `top-of-hour @N:00 HARD CUT`.

**Not verified on air.** The arithmetic is proven against the real 11:17/11:20 case in the bench, but no
promotion has yet occurred on a live station with this code.

## 8. Not built

Generate placing spots **on** `:00/:20/:40` rather than where the fill lands (`11:19:50`, `11:39:30`,
`12:21:17` today). Nearest-anchor absorbs a 10-30 s placement error, but closest to `11:19:50` is still
closest to the wrong target — that is a Generate fix and its own piece of work. Also not bundled: the
auto-fitter, `_schedCursor`, and §1/§2 of renderer-as-pure-view.

## Files

```
audiod/loggen.js               orderForNearestAnchor + spotBlockAt (pure) · exported
audiod/engine.js               _refillFromLog wiring · _projectedSeamTs · _nextTopOfHourTs · _recueForPromotedSpot
audiod/smoke-nearest-anchor.js NEW — 37 cases
```
