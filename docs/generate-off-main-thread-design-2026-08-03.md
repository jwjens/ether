# Generate off the main thread — design of record

**Date:** 2026-08-03 · **Status:** DESIGN ONLY — nothing built, nothing edited.
**Trigger:** a live hang, 2026-08-03 09:07 local, 4.4.121. Title bar `EtherCast (Not Responding)`,
window ghosted, calendar mid-`GENERATING` on Aug 3 – Aug 9.

**Receipts from the hang (captured while it was frozen):**

| Evidence | Value |
|---|---|
| Non-responding process | **pid 53600 — the MAIN process** (`ether-startup.log`: `version: 4.4.121 … pid: 53600`) |
| `Responding` | **False** |
| CPU | **5.78 s per 5 s wall** — more than one core, *spinning*, not blocked on I/O |
| RSS | 202 MB main / 227 + 254 MB renderers / 106 MB daemon — **no leak, no OOM** |
| WAL | 4.19 MB (09:03) → **12.46 MB (09:07:53), then static** across 3 samples |
| Audio | all four stations airing throughout — daemon is a separate detached process |

The write was done; the **CPU picker** was still running. That is the target.

---

## 1 · Where Generate executes today — main, synchronously

`electron/main.js:6295`:

```js
ipcMain.handle('schedule:generateDay', (_, dayTs) => {     // NOT async — nothing yields
  db.prepare("DELETE FROM generated_schedule WHERE station_id = ? AND scheduled_at >= ? AND … ").run(…);
  const ctx = _buildScheduleCtx(activeStationId);          //  59 lines, DB reads
  _generateDayRows(dayBase, ctx, effStart);                // 233 lines, CPU-bound picker  ← the spin
  _placeJingles(db, activeStationId, ctx.generatedRows);
  generatedScheduleBulkCreate(db, activeStationId, ctx.generatedRows);
  … then ~8 more synchronous db.prepare().get() calls building operator diagnostics …
```

Every call is synchronous better-sqlite3 on main's thread inside a non-async handler. While it runs
**main's event loop is dead**: the window stops pumping messages (→ "Not Responding"), and every
renderer IPC — deck state, meters, KV, health — queues behind it.

**The week loop multiplies it by seven.** `BroadcastCalendar.tsx:167` fires the blocking handler once
per day, sequentially. The code already confesses the shape:

```js
// Yield to the event loop so the meter paints before the (blocking) day generate.
await new Promise(r => setTimeout(r, 0));
const res = await (window as any).ether.invoke("schedule:generateDay", ts);
```

That yield paints the progress meter *between* days and does nothing during one. Seven days = seven
main-thread stalls with a repainted number between them.

**This is pre-existing and architectural.** It is not a 4.4.121 regression and not related to the ON
rewire — that handler long predates both.

### 1a · A worse defect found while tracing: the delete window

`DELETE` runs in autocommit and commits **immediately**. The rows are then absent for the entire
duration of the CPU pick — minutes, as measured — until `generatedScheduleBulkCreate` finally writes.

**`_generateRange` (`:6347`) is worse still:** it loops all seven days deleting each one, and writes
**once, after the whole range**. During a week generate, up to a week of `generated_schedule` is
deleted and not yet rewritten.

`docs/log-reader-single-source-playout-design-2026-07-20.md` makes `generated_schedule` **the single
playout source** for flipped stations. A flipped station generating a week is therefore reading a
table that has been emptied ahead of it. **UNVERIFIED at runtime** — I did not confirm which stations
have `log_reader_flip` set, and I did not query the live DB during the hang. One check settles it:
read the per-station `log_reader_flip` KV. Regardless of the current flag state, **the fix must make
delete+write atomic**, and that requirement drives the design below.

## 2 · Mechanism — `utilityProcess` + `node:sqlite`

**Recommendation: extract the generator into a module and run it in an Electron `utilityProcess`,
opening its own `node:sqlite` handle — the pattern the audio daemon already ships.**

### Why a separate process, honestly

The three candidates, and why this one:

| Option | Main stays alive? | Real CANCEL? | Cost / risk |
|---|---|---|---|
| **A · Chunk + yield on main** | Between chunks only | Cooperative only | No new process. **But the work still competes with main's IPC, and one heavy hour still stalls.** Doesn't meet "event loop stays alive *through*". |
| **B · `worker_threads`** | Yes | `terminate()` — usually | Shares the process heap with main. A week of rows is a large array, and this app has a history of `render-process-gone: reason=oom`. A native sync call already entered cannot always be interrupted. |
| **C · `utilityProcess` ✅** | **Yes, structurally** | **Yes — kill the process** | Electron-native, OS-isolated heap, IPC via MessagePort. Costs the extraction + IPC plumbing. |

**C wins on two grounds that matter here.** First, *structural* rather than *cooperative* safety: main
cannot block on work it does not run, so no future edit to the picker can re-freeze the window.
Second, **CANCEL becomes truthful** — you can always kill an OS process; you cannot always interrupt a
synchronous native call that has already entered.

### Why `node:sqlite` and not better-sqlite3 in the worker

**Because the daemon already proves this exact thing works against this exact database file**
(`audiod/ether-audiod.js:62-84`):

```js
// Bare Node can't use better-sqlite3 (V8-ABI); node:sqlite is ABI-stable.
_db = new DatabaseSync(dbPath, { readOnly: false });
_db.exec("PRAGMA journal_mode = WAL"); _db.exec("PRAGMA busy_timeout = 5000");
// WAL + busy_timeout makes cross-process contention with the app's better-sqlite3 a
// microsecond wait, not a failure (proven by spike-write-contention.js).
```

A second process holding a concurrent read-write handle on `openair.db` is **not novel risk here — it
is the shipping steady state**, continuously, across four stations. `node:sqlite` is ABI-stable, so
the generator never re-enters the electron-rebuild coupling that bit the benches. It must resolve the
DB path exactly as main and the daemon do (`ETHER_DB_PATH` → `%LOCALAPPDATA%`), and `mkdir` the parent
first — the fresh-install `SQLITE_CANTOPEN` lesson.

### The extraction — the real work, and its risk

`_buildScheduleCtx`, `_generateDayRows`, `_placeJingles` and the `generated_schedule` bulk writer move
to a standalone `electron/schedule/generator.js` that both main and the worker can require. **The one
structural change: they must take `db` as a parameter** rather than closing over main's module-global
handle (`_placeJingles` already does; `_buildScheduleCtx` does not).

**Blast radius, named plainly:** this is the scheduler. The extraction must be *mechanical* — identical
logic, only the `db` reference threaded. Any behavioural change to the picker rides in a separate
release, benched on its own. The generator's output is bit-comparable before and after, and that is
the acceptance gate for the extraction (below).

## 3 · Chunking, atomicity, progress, cancel

Off-process alone is not enough — you asked for bounded and observable. Inside the worker:

**Chunk = one hour.** The natural unit: clocks are hourly, and `_generateDayRows` already walks hours.

**Atomicity = one transaction per DAY, covering DELETE + INSERT together.** The picker builds a day's
rows in memory hour by hour (chunked, cancellable, emitting progress); only when the day is complete
does one transaction delete the old rows and insert the new. **The delete window from §1a closes** —
readers see either the old day or the new day, never a hole. This also matches the measurement: the
write was never the bottleneck, so keeping it in one short transaction costs nothing.

**Progress is per hour, from the worker, and it is real:**

```
{ phase: "day", day: "2026-08-04", hour: 14, hoursDone: 15, hoursTotal: 24, rows: 212 }
{ phase: "day-committed", day: "2026-08-04", rows: 340 }
```

Main relays to the renderer; the calendar shows day + hour, not a number that only moves seven times.

**CANCEL, two-stage and honest:**
1. Main sets a cancel flag over IPC; the worker checks it **at every hour boundary** and, if set, stops
   without committing the in-flight day and exits.
2. If the worker does not exit within a grace window, main **kills the process**.

Either way the invariant holds: **cancel never leaves a partial day.** Days already committed stay
committed; the in-flight day is discarded whole. The button becomes true.

**One correctness bonus.** The calendar's seven separate `generateDay` calls each rebuild the context
(`_buildScheduleCtx` per call), so **separation and the LRP ladder do not carry across days today** —
whereas `_generateRange` builds ctx once and shares it. Moving the week to a single worker run with one
shared ctx fixes that as a side effect. Worth stating because it means generated output *will* differ
across a day boundary after this change — so the bit-comparable gate above applies **per single day**,
not across a range.

## 4 · Acceptance test

**Generate a full week while the UI stays responsive and a deck keeps animating.**

That is the right test, and it is worth saying why the deck matters: deck position flows
**daemon → main → renderer**. If main's loop stalls, the animation freezes. So a deck that keeps
counting is a live assertion that main is still pumping — the exact thing that failed today. Concretely:

1. Start a week generate on a station with a deck playing.
2. Throughout: the deck countdown keeps moving, meters keep moving, the window never greys.
3. Per-hour progress advances visibly.
4. Press CANCEL mid-run → it stops within a second or two; already-generated days are intact; the
   in-flight day is unchanged from before the run.
5. `Responding` stays `True` on the main pid for the whole run (the OS-level version of 2).
6. Single-day output is unchanged vs. the current implementation (extraction gate).

Add a bench for the parts that are pure: hour-chunk boundaries, the cancel-at-boundary invariant, and
"a cancelled day is byte-identical to before the run."

## 5 · Architecture compliance

- **`generated_schedule` is the single playout source** —
  `docs/log-reader-single-source-playout-design-2026-07-20.md`. Honoured, and strengthened: §3's
  per-day transaction removes a delete window that design did not anticipate (§1a).
- **ONE-scheduler model** — this changes *where* Generate runs, never *what* it decides. No second
  scheduler, no second picker; the module is extracted, not reimplemented.
- **BUILD THE SENSE, NOT THE SCAFFOLD** — progress and cancel are permanent product surfaces, and the
  worker's lifecycle (running / cancelled / killed / failed) should emit health events like every other
  subsystem. No diagnostic scaffolding, nothing temporary.
- **Correct minimal solution.** Deliberately **not** built: no change to picker logic, no rotation-rule
  changes, no new scheduling features, no touching the daemon, and no migration.

## 6 · Open question for Jeff

**Should the four stations generate in parallel?** One worker per station would cut a multi-station
week substantially, and they write disjoint `station_id` ranges. But it multiplies concurrent writers
on `openair.db` from 2 to 5. The daemon's contention note says WAL + `busy_timeout` makes this a
microsecond wait — but that was proven at daemon write volume, not at bulk-generate volume. **My
recommendation: ship serial first**, measure, and only then consider parallel. Serial already meets
the acceptance test, because responsiveness comes from being off-process, not from being fast.
