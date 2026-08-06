# Generate freeze (renderer) + the calendar can't show past vs future — 2026-08-06

**Status: TRACED, NOTHING BUILT.** Read-only receipts only. Two defects, both open. Order is Jeff's call.
Version in play: 4.4.151 (local, uncommitted). Branch `log-reader-flip`.

Companion to `docs/deleted-songs-still-air-design-2026-08-06.md` (the delete-foundation work) and
`docs/generate-off-main-thread-design-2026-08-03.md` (the original freeze design, 4.4.121).

---

## (0) First — the "Rotten to the Core is BACK" alarm was a FALSE alarm, and part of it was my fault

**Jeff's report:** regenerated, and "Rotten to the Core" (song 342, soft-deleted 2026-07-20) appeared at
**04:10 AM in today's schedule** — screenshot confirmed.

**What that row actually is** (live DB copied 07:17 local):

```
gs=152141  station 2  LOCAL 2026-08-06 04:10:46 AM   state=played   retracted=no
           created 2026-07-26T07:10:04Z
```

`state='played'` — it **already aired**, at 4:10 AM, and the screenshot clock reads 07:16 AM. The
4.4.151 installer did not exist until 06:17 local, so at 4:10 AM the OLD build was running and that
phantom aired exactly as it had for weeks. It is the *record of an airing*, not a scheduled one.

**The fix held. Receipts:**

| check | result |
|---|---|
| `songs` object type in the live DB | **VIEW** `SELECT * FROM songs_all WHERE deleted_at IS NULL` — 511 live / 543 raw |
| song 342 | `deleted_at = 2026-07-20T20:32:31Z`, **not visible through the view** |
| song 342 resurrected? | No — mutation history ends at `op=delete`; no re-insert |
| duplicate live "Rotten to the Core" | None — exactly one row in `songs_all` |
| `songs_all` referenced anywhere in `audiod/` | **0 times** — the daemon reads `FROM songs`, the view |
| airable rows whose song is deleted | **0** |
| rows created for ANY deleted song since the cleanup | **0** |
| **a Generate DID run at 07:15:31 local** — one minute before the screenshot | its rows: "Opportunity Village Spot", "Sally's Song", "Bad Romance", "Rest in Peace", "What Else Can I Do?" — **zero deleted songs** |

So the regenerate test passed; the proof is one minute older than the screenshot that looked like a
failure.

**Where I was wrong.** After the live cleanup I told Jeff the 12 songs' entries were "gone from the
calendar." The calendar *does* filter retracted rows (`g.deleted_at IS NULL`, `main.js:6680`), so the
300 retracted rows are hidden — but **played history rows were never retracted, by design**, because
Jeff ruled that deleting must not erase the record of what aired. I should have said: *"gone from
everything upcoming; this morning's airings stay in the log."* That wrong sentence is why the
screenshot read as a failure. Recorded here so the next session doesn't repeat it.

**Live cleanup outcome (for the record):** 200 phantom rows retracted (not 215 — 13 more had aired and
2 were missed between the first measurement and the fix). `integrity_check: ok`, `foreign_key_check: 0`,
aired history preserved 1866 === 1866, play_log untouched. Backup:
`openair.db.bak-prephantomretract-20260806_070908`.

---

## (1) DEFECT A — the calendar renders history identically to the future

**The operator-visible defect:** at 07:16 AM, a row at 04:10 AM (already aired) and a row at 04:10 PM
(about to air) look **exactly the same**. There is no now-line and no played/upcoming styling, so the
only way to tell whether a song in today's log is history or a threat is to query the database. That is
what turned a passing test into a fire drill.

**What exists today:** `BroadcastCalendar.tsx:343` —

```js
const isNow = isToday && it.scheduled_at === currentAt;   // ONE row highlighted green with ▶
```

A single current-row highlight. Nothing else distinguishes past from future.

**The data is already in the payload** — no schema or query change needed. `main.js:6704`:

```js
const cols = `g.id, g.scheduled_at, g.title, g.artist, g.duration_s, g.state, g.played_at, g.seq, g.content_class`;
```

`state` and `played_at` are already delivered to the renderer and simply unused for styling.

**Proposed fix (contained, renderer-only):**
1. **Now-line** — a divider between the last elapsed row and the next upcoming one.
2. **Played rows read as history** — dim/desaturate rows where `state='played'` (or `scheduled_at < now`),
   so the eye separates "already happened" from "will happen" without reading a clock.
3. Keep the existing green ▶ current-row highlight unchanged.

**Why it matters beyond cosmetics:** preserving airplay history was a deliberate ruling (delete retracts
the future, never the past). This defect is the direct consequence of that ruling — we preserved history
and then displayed it indistinguishably from the schedule. The ruling is right; the display has to catch up.

---

## (2) DEFECT B — the Generate freeze is in the RENDERER, not main

**Jeff's requirement, unchanged:** *one day at a time, in the background, the window never freezes.*
Acceptance: generate a week while a deck animates and the clock ticks — the window NEVER goes
"Not Responding."

### The chunked fix IS shipped and IS working

`main.js:6399-6409` — present in 4.4.151, verified in the packaged asar:

```js
async function _generateDayChunked(dayBase, ctx, effStart, meta) {
  for (let h = 0; h < 24; h++) {
    if (_genCancel) return { cancelled: true };
    _generateDayRows(dayBase, ctx, effStart, h);        // one hour
    _genEmit({ phase: "hour", hour: h, ... });           // ← progress IPC to the renderer
    await new Promise(r => setImmediate(r));             // ← the yield; main pumps here
  }
}
```

Main genuinely yields 24 times per day. So Q1 ("was it ever built?") = **yes, it shipped and it works.**

### What main-thread measurement RULED OUT

Measured on a copy of the live DB (`play_log` 36,859 rows, `mutations` 262,807 rows, a real day = 1176 rows):

| phase | cost | verdict |
|---|---|---|
| `buildRestMaps` (before the chunked loop, no yield) | 67–234 ms per station | not it |
| `_commitDayRows` — DELETE + 1176 inserts + 1176 `logMutation` rows | **468 ms/day**, ~3.3 s/week | jank, not a freeze |
| `_placeJingles` pool query — **cold** | 2233 ms (pool 4, 52 candidates) | misleading, see below |
| `_placeJingles` pool query — **warm, 200 calls** | **0.02 ms/call** | **not it** |
| `_placeJingles` total per day (113 music rows, station 2) | **≈ 0 s** | **not it** |

> **Correction recorded:** mid-investigation I reported the 2.2 s cold figure and it was read as the
> cause. It is not. Warm it is 0.02 ms and the per-day total is ~0. Optimizing `_placeJingles` would fix
> nothing. Nothing on main adds up to a multi-minute freeze — **because the freeze isn't on main.**

### The actual mechanism

`BroadcastCalendar.tsx:332-342` renders the day view as `hours.map(...)` → `items.map(...)` — **every
row, no virtualization.** The screenshot shows **1019 items in show**. That list lives in the **same
component** that holds `genProgress`, and `setGenProgress` fires **once per hour** (`:169`).

```
one-day generate  =  24 hour-ticks × ~1019 rows re-rendered
week generate     = 168 hour-ticks × ~1019 rows re-rendered
```

**The hour-level progress meter added on 2026-08-03 to prove the window wasn't frozen is what freezes
it now.** Main was fixed; the work moved to the renderer — the process that actually paints the window
Jeff is watching. Every `setImmediate` yield on main delivers an IPC that forces a full re-render of a
thousand-row list.

### Proposed fix (renderer-side; the picker is fine)

1. **Throttle progress** to ~4 updates/sec instead of one per hour completed (coalesce in the renderer).
2. **Isolate the progress state** — move `genProgress` out of the component that renders the list, or
   memoize the list so a progress tick cannot re-render 1000 rows.
3. **Virtualize the day view** — render only visible rows. A 1000-row day should never be 1000 live DOM
   nodes; this also fixes plain scrolling on a big day.

Explicitly **not** proposed: more chunking of the picker, a utility process, or `_placeJingles`
optimization. Measurements above say none of those are the constraint.

### The one check that would settle it — UNVERIFIED

This is a **code-path argument, not a runtime receipt.** Main-process console output isn't captured in a
packaged build, so there is no `hourMs` log from Jeff's actual freeze. **Settle it in one shot:** open
DevTools → Performance, record, generate a week. If this diagnosis is right, the trace shows ~168 long
React commits on the renderer while main stays responsive. If it shows something else, this section is
wrong and the fix changes.

---

## (3) Open decisions — Jeff

1. **Order: A or B first?** Recommend **A** — small, uses data already in the payload, and it is what
   made a passing test look like a failure this morning.
2. **Defect A shape:** now-line, played-vs-upcoming styling, or both? Recommend **both**.
3. **Defect B:** run the DevTools Performance trace before building, so the fix targets the measured
   stall rather than the best-supported inference? Recommend **yes**.

## (4) Noted in passing — NOT investigated, not actioned

`%APPDATA%\Ether\logs\health-events.jsonl` is **38 MB** and growing, dominated by GREY↔GREEN audio-health
flap events written with synchronous `fs.appendFileSync` on main. Unrelated to the above, but it is
constant synchronous disk I/O on the main thread and deserves its own look. One line, per the
stay-on-task rule — no action taken.

## (5) Still outstanding from earlier work

- 4.4.151 is **uncommitted** — 9 modified files + design doc + `docs/help-deleting-songs.md` + the
  cleanup script.
- Library defects #2 (500-row `LIMIT` hides 29 songs) and #3 ("No music yet" on zero search results)
  from `docs/deleted-songs-still-air-design-2026-08-06.md` §10 — untouched.

---

## (6) CORRECTION — 2026-08-06, the §2 theory is WRONG for the path that actually freezes

**Jeff's differential (his eyes):** *"It's WEEK GENERATE from month view that freezes — Day Generate
(green button, single day) is fine."*

That differential is real and useful, but it does **not** confirm the §2 mechanism. Two structural
receipts kill it:

1. **`BroadcastCalendar.tsx:277` — the day list is inside `if (selectedDay) { … }`.** In MONTH view
   `selectedDay` is null, so the ~1019-row list and the `byHour` bucketing are **not mounted and not
   built**. The 168 progress ticks there re-render only the month grid (~35 cells). The
   "168 × 1000 rows" cost cannot be happening on the path that freezes.
2. **No quadratic growth in the picker.** `ctx.generatedRows` is only pushed to and `slice()`d
   (`main.js:6217/6231/6299/6318/6358/6443/6446`) — never scanned. Separation uses O(1) Maps
   (`songLastTs`/`artistLastTs`/`titleLastTs`). A week does not degrade super-linearly for that reason.

**What is still unexplained:** why the week path (7 days) hits "Not Responding" when the day path
(1 day) does not, given both run the SAME `_generateDayChunked` with a `setImmediate` yield every hour.
Main-side per-day costs measured in §2 (commit 468 ms, placeJingles ~0 warm, ctx 234 ms) stay well under
the ~5 s no-pump threshold that triggers "Not Responding".

**Why the day-vs-week difference is a genuine clue:** the ONLY things week does that day does not are
(a) 7× total work in one IPC call, (b) one shared `ctx` across days, (c) 168 `_genEmit` broadcasts
instead of 24 — and `_genEmit` sends to **every** BrowserWindow (`main.js:6395`), of which this install
has several.

**NEXT STEP — a measurement, not more inference** (per the standing ask-first rule): while a week
generate is frozen, sample every Ether process for `Responding` and CPU. That identifies whether MAIN or
a RENDERER is the stalled process, which decides the whole fix:

- **MAIN stalled** → the renderer spec (throttle/isolate/virtualize) will NOT deliver "never Not
  Responding"; the fix is main-side.
- **RENDERER stalled** → follow up with a DevTools Performance trace to find the component, then the
  renderer spec is correct.

**Unchanged regardless of the outcome** — these ship either way, because "no bar, no message, customers
think it crashed" is its own defect: the confirm popup with a "don't show again" checkbox, and the
bottom-left progress bar with `day X of N` + a working Cancel (`schedule:generateCancel` /`_genCancel`
already exist and are unwired in the UI).

---

## (7) SOLVED — the freeze is main, and the yield was simply too rare (4.4.152)

Both earlier theories were wrong. §2 blamed the renderer; §6 corrected that but left the cause open.
This is the measured answer.

### Receipt 1 — MAIN is the stalled process, not a renderer

Sampled during a real week generate on Jeff's install (`Get-CimInstance` for the process type):

```
59340  ppid=28144  MAIN (browser)   Responding=False   ← the window owner
54752  ppid=59340  renderer         Responding=True
56864  ppid=59340  renderer         Responding=True
67452  ppid=59340  gpu-process      Responding=True
```

Confirmed from the other side by Jeff's screenshot: the GENERATING bar was **at 43% and still
painting** while the title bar read "(Not Responding)". The renderer was alive and drawing; main
could not process input. Any renderer-side fix was aimed at a process that was never stalled.

### Receipt 2 — the yield fires once per DAY of wall time, not once per hour

240s of 200ms sampling during a week generate:

```
unresponsive: 1028/1039 samples (98.9%)
longest continuous unresponsive stretch: 100.1s
moments it recovered:  2          ← in 4 minutes; per-hour yielding should give 168
main CPU: 230.0s over 239.9s wall = 0.96 cores, sustained
```

The two recoveries sit ~100s apart — a **per-day** boundary. Within a day, 24 hour-yields produced no
pumping at all.

### Receipt 3 — the threshold, from a standalone Electron harness

A minimal Electron app burning CPU in fixed slices with a `setImmediate` yield between them:

| slice | result |
|---|---|
| 120 ms | 75 responsive / 0 unresponsive |
| 500 ms | 36 responsive / 0 unresponsive |
| 2000 ms | 10 responsive / 0 unresponsive |
| 5000 ms | only 4 samples in 18s — the sampler itself was blocking on `Responding` |
| **9000 ms** | **0 responsive / 34 unresponsive, 6.8s stall** |

`setImmediate`, `setTimeout(0)` and `setTimeout(1)` behaved **identically** at 120ms. So the primitive
was never the problem, and a worker/utility process was never required.

### The diagnosis

One hour of picking is ~4s of solid CPU (24 hours ≈ the observed ~100s per day). Yielding only
*between hours* leaves main inside a single uninterrupted 4s+ compute — past the point where Windows
stops pumping the window's messages and stamps "(Not Responding)". The 2026-08-03 chunking was right in
kind and **too coarse by two orders of magnitude**.

### The fix (4.4.152)

1. **Yield inside the hour, every ~60 ms of work** (`_genMaybeYield`, `main.js`), called at the top of
   the three slot loops (break-fill, hour-fill, sequential slot walk). `_generateDayRows` became
   `async`. Picks are bit-identical — the yield adds no state and no ordering.
2. **Progress moved out of the calendar** into `src/components/GenerateProgressBar.tsx`, mounted at
   App top-level: bottom-left above the station badge, `Generating <day> · day X of N`, a live bar, and
   a **CANCEL** button wired to the existing `schedule:generateCancel`/`_genCancel`. Events are
   coalesced and flushed at 4/sec instead of painting all 168. The old inline meter is gone — it lived
   in the component that renders the day list.
3. **`phase:"start"` / `phase:"end"` added to main's progress events** so the bar is correct regardless
   of which panel is open, and survives navigating away mid-run.
4. **Confirm dialog before a week generate** — explains that it runs day by day, takes a few minutes,
   the app stays usable, and it can be stopped; with a **"Don't show this again"** checkbox
   (`localStorage: ether_gen_explain_dismissed`).

**Not built:** day-view virtualization. It was specced against the renderer theory and does not affect
this freeze. Worth doing later for plain scrolling of a 1000-row day; tracked, not done.

### Acceptance test (Jeff's eyes)

1. Month view → **Generate week** → the dialog appears → **OK, generate**.
2. The **bottom-left bar** appears and advances, naming the day and `day X of N`.
3. The title bar **never** says "(Not Responding)" — click tabs, open panels, watch the clock tick and
   a deck animate throughout.
4. Press **CANCEL** mid-run — it stops, and the bar reports how many days were kept.
5. Re-run and tick **"Don't show this again"** — the dialog stays gone next time.

---

## (8) THE ACTUAL CAUSE — a missing index, found by profiling the live frozen process (4.4.153)

**Three theories shipped and failed before this one.** §2 blamed the renderer (wrong — main was the
stalled process). §6 corrected that but left the cause open. §7 blamed per-hour yield granularity and
shipped 60ms slicing in 4.4.152 — **it still froze**, because no JS-level yield can interrupt a single
native call that never returns to the event loop.

### The receipt — CPU profile of the LIVE frozen main process

Attached Node's inspector to the running app with `process._debugProcess(pid)` (no rebuild, no restart)
and took a 30s CPU profile while the window was ghosted:

```
=== SELF TIME (top 25) — total sampled 30.4s ===
   30.12s   99.2%  all  :0                    ← native better-sqlite3 .all()
    0.22s    0.7%  resolvePool  main.js:6071

=== YIELD BEHAVIOUR ===
  moments the loop went idle/program: 0
  LONGEST continuous JS stretch with no idle: 30.36s
  stack: _placeJingles @ main.js:6045  ←  (anon) @ main.js:6453
```

**One SQLite call held main's thread for 30+ seconds.** That is why per-hour yielding, and then 60ms
yielding, both changed nothing: execution never returned to JS for a yield to run.

### Why the earlier measurement said "not it" — my error

§2 recorded `_placeJingles` at "0.02 ms/call warm, ≈0s per day" and dismissed it. That benchmark timed
`pools[0]` — the **empty** pool, 0 candidates. The same run *also* printed pool 4 at **2233 ms** and it
was written off as a cold-start artifact. Jeff's instinct that `_placeJingles` was the heavy work was
correct and was argued away on a bad number. **Benchmark the worst case, never element zero.**

### Root cause

`play_log` carries indexes on `uuid`, `programming_row_id`, `station_uuid` — and **none on
`file_path`**. The overlay pool query orders by a correlated `MAX(played_at)` subquery keyed on
`pl.file_path = s.file_path`, so it **full-scans all ~36,900 play_log rows per candidate**. And
`resolvePool` re-ran that query for **every music row**.

Measured on the live DB: 898 ms/call warm × 452 music rows = **406 seconds per day**, ~47 minutes for a
week, in uninterruptible native calls.

### The fix

1. **`idx_play_log_file_station` on `play_log(file_path, station_id, played_at)`** (runMigrations,
   idempotent, ~80ms to build). The query goes **1015 ms → 0.16 ms**. Also serves the daemon's LRP
   ordering and `buildRestMaps`.
2. **Resolve each overlay pool ONCE per run and cache it** (`poolCands`), plus the same for specific
   overlay items (`itemCache`). Correct because `play_log` is not written during a generate, so the
   LRP ordering cannot change mid-run; rotation was already handled by `usedByPool`, not by re-querying.

### Proof BEFORE building (Jeff's hard rule)

Both code paths replicated verbatim against a copy of the live DB, 500 music rows:

```
WITHOUT index (shipping):  total 178.4s     worst single call 1399.7 ms
WITH index + resolve-once: total  0.86 ms   worst single call    0.13 ms
placements: IDENTICAL — 500 compared, against old-with-index AND old-without-index
GATE: worst un-yielded stretch 0.13 ms  [PASS] < 120 ms
```

### What remains un-yielded, stated honestly

- **`_commitDayRows` ≈ 470 ms per day** — DELETE + ~1176 inserts + ~1176 `logMutation` rows in ONE
  transaction. Above the 120ms target, ~10× below the ~5s threshold that freezes a window. It is
  deliberately **not** sliced: the atomic delete+insert is what stops `generated_schedule` sitting
  empty mid-generate for flipped stations
  (`docs/log-reader-single-source-playout-design-2026-07-20.md`). Breaking atomicity to shave 470ms
  would trade a cosmetic stutter for dead air.
- **`buildRestMaps` ≈ 230 ms**, once per run (should improve with the new index).

### Retained from 4.4.152 (correct, just not sufficient alone)

The 60ms time-sliced yield in the picking loops, the bottom-left progress bar with Cancel, the
start/end phases, and the confirm dialog all stay — they were right, they just were not the freeze.
