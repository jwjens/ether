# Build report — Generate off the main thread (4.4.122)

**Date:** 2026-08-03 · **Design:** `docs/generate-off-main-thread-design-2026-08-03.md`
**Gates run:** `tsc --noEmit` baseline · **8 benches 243/243** · `verify-packaged` PASS · installer built.
**RELEASE GATE NOT YET PASSED** — the acceptance test is a runtime test only Jeff can run. Not committed.

---

## Accountability trace — the chunked generateDay was never started

`git log -S "ipcMain.handle('schedule:generateDay', async"` returns **zero commits across all history**:
the handler has never been async, so part 1 was never committed and never reverted. No design doc or
build report for it exists in `docs/`. What landed instead was the *appearance* of the fix — the
progress meter and CANCEL button (`genCancelRef`, `setGenProgress`) arrived **2026-07-27**, the day
before the authorization, inside `2e3d2b3`, a squashed commit whose message reads *"(Parallel session's
work, reconciled into one commit.)"* The calendar's own comment dates them: *"Progress meter + cancel for
a week generate (2026-07-27)."*

**How the core piece vanished while the accessories shipped: the accessories are the visible part.** A
meter that moves and a cancel button that exists are exactly what a reviewer checks. Behind them nothing
changed — which is precisely why the meter only moved seven times and cancel only broke *between* days.
The feature was judged by its door, not its room.

## Mechanism — chunked-with-yields, NOT a utility process

**I reversed my own design doc's recommendation, on evidence I did not have when I wrote it.** The doc
argued for a utility process with its own `node:sqlite` handle, on the strength of the daemon's proven
cross-process RW precedent. Reading the generator killed that:

```js
function _generateDayRows(dayBaseDate, ctx, minTs = 0, onlyHour = null) {
  const { stmtShows, stmtSlots, stmtCandidates, stmtSongById, stmtSpotsByCategory, stmtClockBreaks, … } = ctx;
```

**`ctx` carries live better-sqlite3 prepared statements bound to main's handle.** They cannot cross a
process boundary. Off-process would mean re-implementing the scheduler's entire data layer against a
second SQLite binding and keeping two pickers in step — *"never rebuild what exists"*, on the one
subsystem where a silent divergence is least acceptable.

**And the hour loop already existed** (`for (let h = 0; h < 24; h++)`), with every per-hour accumulator
declared *inside* it and every cross-hour accumulator (`generatedRows`, `*LastTs`, `diag`, `relaxed`) on
`ctx`. So slicing it costs one guard line and changes scheduling not at all:

```js
if (onlyHour !== null && h !== onlyHour) continue;
```

The driver yields between hours — and that yield is the whole fix:

```js
async function _generateDayChunked(dayBase, ctx, effStart, meta) {
  for (let h = 0; h < 24; h++) {
    if (_genCancel) return { cancelled: true };
    _generateDayRows(dayBase, ctx, effStart, h);   // one hour, bounded
    _genEmit({ phase: "hour", hour: h, …, hourMs: Date.now() - t0 });
    await new Promise(r => setImmediate(r));       // ← main pumps its message loop HERE
  }
```

`hourMs` ships in every progress event, so the per-hour cost is **observed, not assumed** — if an hour
is too expensive to be a chunk, the product says so rather than the operator discovering it as a stutter.

## The delete window — a second defect found while tracing

The DELETE committed in autocommit and the INSERT landed **minutes later**. `generated_schedule` is the
single playout source for flipped stations (`docs/log-reader-single-source-playout-design-2026-07-20.md`),
so it sat **empty for the entire pick**. `_generateRange` was worse: it deleted all seven days and wrote
once at the very end.

Now delete + insert are **one transaction, per day** (`_commitDayRows`). A reader sees the old day or the
new day, never a hole. `ctx` is built *before* any delete — safe, because it reads `play_log`,
`separation_rules` and `songs`, never `generated_schedule`, so the reordering cannot change a pick.

## `_generateRange` — the same freeze through a different door

**The bench caught this, and it was a real finding, not a bench error.** `_generateRange` still did a
blocking 24-hour pick per day. Its callers are Iris's `generate` **and `_autoExtendTick`** — the
unattended auto-extend. **That path could have frozen the app with no operator action at all.** It now
uses the same chunked driver and per-day atomic commit. `routeIrisCommand` and `_autoExtendTick` became
async; the Iris HTTP endpoint at `main.js:5045` had to `await` or it would have serialised a Promise to
`"{}"` in the response body.

## The week is one pipeline

`schedule:generateDays` takes the whole list, keeps **one shared ctx across the range** and commits each
day as it completes. `BroadcastCalendar` makes **one** call and subscribes to `schedule:generate-progress`
— hour-level, so the meter moves **168 times across a week instead of 7**.

**CANCEL is now true.** It was a renderer-only ref, which could never stop work running in main. It now
invokes `schedule:generateCancel`; the driver checks at every hour boundary. **Invariant: a cancelled day
is never written** — committed days stay, the in-flight day is discarded whole.

**Correctness bonus:** the seven-call loop rebuilt `ctx` per day, so separation and the LRP ladder did not
carry across day boundaries. One shared ctx fixes that — which also means **week output will legitimately
differ across day boundaries** from before.

## Bench — `scripts/smoke-generate-chunk.js`, 21 assertions

Guards every structural invariant that made the freeze possible: handler is async · the yield is *inside*
the hour loop · no full-day picker call remains · the hour guard is the loop's first statement · the
already-aired skip survives · cancel is checked per hour and reaches main · a cancelled day is never
committed · delete+insert share a transaction · ctx precedes the delete · the calendar calls the range
once and subscribes to hour progress.

**Why source-contract and not behavioural, stated honestly:** the generator lives inside `main.js` bound
to main's better-sqlite3 handle, so it cannot be required from bare Node — and the only real database is
the **live** one, which is never written externally. The behavioural gate is therefore the runtime test.
**Two bench corrections disclosed:** the tail check compared LF against a CRLF file, and the handler slice
ran past the handler into `_generateRange`. Both were the bench; the second, once scoped correctly, is
what exposed the `_generateRange` defect above.

## THE RELEASE GATE — not yet passed

**`C:\openair\dist-electron\Ether Setup 4.4.122.exe`** is built so this can be run. Per Jeff: *no pass,
no ship.*

1. Install 4.4.122, station airing, a deck playing.
2. Generate the full week from the calendar.
3. **Throughout:** the deck countdown keeps moving, meters keep moving, the window never greys or reads
   "Not Responding". Progress shows day **and hour**.
4. Press CANCEL mid-run → stops within about a second; already-generated days intact; the in-flight day
   unchanged.
5. OS-level confirmation: `Get-Process Ether | Select Responding` stays `True` for the whole run.

Not committed until that passes.

## Files

```
electron/main.js                    _generateDayRows(onlyHour) · _generateDayChunked · _genEmit
                                    · _commitDayRows (atomic) · schedule:generateCancel
                                    · schedule:generateDays · async generateDay · async _generateRange
                                    · routeIrisCommand/_autoExtendTick async · Iris HTTP awaits
src/components/BroadcastCalendar.tsx one range call · hour progress subscription · CANCEL → main
scripts/smoke-generate-chunk.js     NEW — 21 assertions
docs/backlog.md                     3 items filed (reconcile timer, blind health writer, CPU diet)
```

## Not built (deliberately)

No change to picker logic, rotation rules, or scheduling behaviour. No migration. No utility process
(reasoned above). The per-hour cost is now *measured* (`hourMs`) rather than optimised blind — if hours
prove too coarse, that is a follow-up with data behind it.
