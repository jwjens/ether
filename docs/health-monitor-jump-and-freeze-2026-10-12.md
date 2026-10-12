# Health Monitor jumps; "Not Responding" on first clicks (2026-10-12)

Tested build: `24d656e7` (from `90a6a47`) on OVEVENTS.

## Jeff's reports (verbatim, relayed)

1. "Health Monitor moves on its own: whenever something starts playing or is activated, the Health Monitor jumps to the bottom of the screen, so Jeff can't use the faders."
   - Rule: "the Health Monitor never moves, resizes, scrolls, auto-raises or takes focus by itself. New events appear without changing its position or the operator's scroll position (if the operator is scrolled up, stay there; at most show a 'new events' badge)."
2. "Not Responding" freeze: "the first click on something often freezes Ether with 'Not Responding' in the title bar for a few seconds, then it works." Jeff: "the freeze has always been there."
   - Do the performance pass from `docs/ui-freeze-diagnosis.md` at the root:
     - Stop the whole-app re-render on every deck event.
     - Stop the Up Next pop-out remounting.
     - Keep pop-outs alive.
     - Move the 60 s library snapshot and other heavy synchronous work off main.
     - Confirm the mismatch check is event-driven with no polling DB reads.
   - Measure before and after. Target: no "Not Responding", no input delay over one frame.

---

## 1 · The Health Monitor jump

**Cause:** `src/components/MasterOutput.tsx:347` (pre-fix).

The Master Out column holds, top to bottom:
- the MASTER/MONITOR faders;
- the mini **Health Monitor**;
- the **Live console**.

The console's auto-scroll ran `bottomRef.current?.scrollIntoView({ behavior: "smooth" })` on every new line. A new line arrives whenever a deck loads, starts or stops: `consoleLog("audio", "[DECK A] Loaded…")` in `App.tsx`.

`scrollIntoView` scrolls **every scrollable ancestor** until the element is visible, not just the console. Master Out's body is a scroll container (`MasterOutput.tsx:814`, `overflowY: auto`), and its content is taller than the screen. So each event scrolled the whole column down: the Health Monitor and console were dragged to the bottom of the screen and the faders went off the top.

**Fix:**
- New `src/lib/stickyScroll.ts`:
  - `useStickyScroll` follows new rows **only inside the feed's own box**, and only while the operator is at its bottom. Scrolled up, the view stays put and a **"N new events ↓"** badge appears; clicking it jumps to the newest line.
  - `scrollOwnToBottom` is for the two other feeds that used `scrollIntoView` on updates: the Producer Desk chat (`ProducerDesk.tsx`) and Captions (`Captions.tsx`). Both now scroll only their own box.
- The Health Monitor pop-out's activity terminal (`LiveActivityTerminal.tsx`) already scrolled only itself and locked when scrolled up. It now also counts what arrived while locked ("Resume · N new").
- Checked: no Health Monitor surface calls `focus()`, `show()`, `moveTo` or `setBounds` on an event. The only `focus` is the PIN field of a dialog the operator opens.
- Guard: `src/lib/noFeedScrollIntoView.test.ts`. `scrollIntoView` is allowed only inside an operator's handler.

**Test, in a real Chromium** (`npm run test:feed-no-jump` = `scripts/smoke-feed-no-jump.js --control 193aae1`). The real `LiveConsole` is mounted at the bottom of a column laid out like Master Out (fixed content taller than the column). The window is off-screen and never focused.

| | After 60 deck events | Scrolled up to read, then 5 more events |
|---|---|---|
| **Fixed** | column `scrollTop 0` (faders stay); console at its own bottom (1290/1290) | console stays at 40, column at 0, badge "5 new events ↓" |
| **Pre-fix (`193aae1`)** | column `scrollTop 100`, its full range: **dragged down, Jeff's report reproduced** | — |

---

## 2 · "Not Responding": measured, then fixed at the root

### Before (the live app, build `24d656e7`, OVEVENTS, 2026-10-12)

`/health` was read every second for 10 minutes (read-only; the poller ended by itself).

| What | Value |
|---|---|
| `eventLoopLagPeakMs` at the first read | **3,854 ms** |
| Main stalls ≥ 1 s seen | peaks of **8,589 ms (21:57), 9,313 ms (21:59), 8,005 ms (22:01)**, every 2 minutes |
| Stalls of 0.5–1.0 s | about once a minute (494, 664, 844, 778, 899, 1,010, 755 ms) |
| `/health` answers | **114 of ~570**: main was too blocked to answer the rest |

A main process (the browser process that owns the window) that is blocked for seconds is exactly what Windows shows as **"Not Responding"**. A click landing in that window waits for the stall.

### The cause, with receipts: the library-health sweep runs on main

`electron/library-health.js:1026`: `setInterval(computeAll, 120 * 1000)`. It ran **synchronously on the main process**; its comment says "cheap indexed reads".

The sweep times itself (`sweepMs` in `health-events.jsonl`). Today's values:

```
20:45:48 4386   20:47:49 5264   20:49:48 4312   21:45:06 5501   21:47:04 4003   21:49:04 4006
21:51:05 4603   21:53:05 4427   21:55:05 4102   21:57:10 9244   21:59:10 8476   22:01:09 7985
```

The 9.2/8.5/8.0 s sweeps line up with the 8.6/9.3/8.0 s lag peaks. The two-minute rhythm is old: the September startup log shows a trivial `SELECT … FROM stations` reported as taking 1.2–2.9 s every 120 s exactly (`[DB SLOW 2877ms]` 2026-09-27 21:57:55, 21:59:55, 22:01:55). That query was waiting behind the sweep.

**Reproduced off the live app.** I took a snapshot of the live database (SQLite backup API, read-only; the live file was never written) and ran `computeAll` under a profiler: **7,774 / 10,933 / 11,680 ms** for three sweeps. Self time across those three runs:

| Where | Self time |
|---|---|
| `eligibility` (`library-health.js:547`) | 8,992 ms |
| sweeper sense `one` (`sweeper-sense.js:81`) | 5,478 ms |
| `existsSync` per row | 3,935 ms |
| `computeRunway` (`runway.js:50`) | 3,797 ms |
| goal check (`library-health.js:434`) | 3,606 ms |
| `lintUpcoming` | 1,312 ms |

### Fixes

**A. The sweep runs off the main process.**
- New files: `electron/library-health-worker.js` and `electron/library-health-host.js`.
- The sweep, the R2 prefetch and the on-demand queries (eligibility, queue lint, rotation goals) run in a worker thread, with their own read-only database connection.
- Main keeps the same API as a proxy; queries become async round-trips (`ipcMain.handle` awaits them).
- If the worker cannot start, main falls back to running the sweep itself, exactly as before. It says so loudly: a `library-health-worker-error` health event.
- Test (`npm run test:lh-worker <db copy>`, under Electron's own runtime, against the snapshot):

| Run | Sweep time | Main's worst event-loop lag |
|---|---|---|
| Sweep on main (as before) | 6,924 ms | **6,915 ms** |
| Sweep in the worker | 8,286 ms | **16 ms** (Windows' timer resolution) |

  Results are identical (stations, queue lint). A queue-lint call answered in 18 ms during the sweep.

**B. The whole app no longer re-renders on every deck event.**
- `src/audio/deckStore.ts` is new. Deck state moved out of `App.tsx` (it was `setDeckA({...st})` on every deck event, the ≥ 1/s position ticks, re-rendering about 156 hooks and every docked panel).
- App reads only `selectOnAir` (which deck is on air, its title and artist), so it re-renders on a track change, never on a position tick.
- The board (`LivePanel`), the jock strip and the widget canvas read the full deck states themselves.
- The Library dock is an element App creates, so React no longer re-renders it per tick.
- The keyboard handler used to re-subscribe every second (deps `[deckA, deckB]`). It now reads the current AUTO toggle through a ref.

**C. The queue goes to the pop-outs only when it changed.**
- `queue:sync` (the whole queue, cloned through main into every window) was sent on every deck event. It's now sent on a changed queue only (`App.tsx`).

**D. The Up Next pop-out no longer remounts.**
- `PopoutRenderer.tsx` had `<UpNext key={rev}>`, bumped on every `queue:sync`. So the panel was rebuilt about once a second, re-running six main-process loads each time.
- It now stays mounted and follows the queue. `UpNext`'s 1 s queue poll re-renders only when the queue changed.

**E. Pop-outs stay alive.**
- Closing a pop-out now **hides** it; opening it again shows the same running window instead of booting the 3.3 MB renderer again.
- Pop-outs are found by panel (a title lookup could miss a live window).
- **Closed for real, as before:** anything that holds a device or acts while open: the Show+ DAW, Show+, camera, phone desk, voice tracking, mic, and the jukebox (it picks the next song while open).
- A real quit closes everything.
- Hidden pop-outs get no meter-rate channels (`audio:levels`, `audio:meters`, `audio:proc-meters`, `audio:rta`), but still get everything else.
- Window bounds are saved 500 ms after the last move or resize (they were a synchronous file read and write on every event).

**F. The 60 s library mirror.**
- `pushLibrary` (`src/lib/ccData.ts`) ran the full-library join through main and serialised the whole library every 60 s.
- It now **skips when a cheap change token is unchanged** (row counts plus the newest edit of the five tables it reads), with a full push at least every 10 minutes.
- When it does run, the join goes to the worker's read-only connection (`db:query-offmain`, SELECT only).
- On this box the join is 525 rows (2–20 ms, 0.24 MB); at OV's ~5,600 songs it is about ten times that.

**G. The board-state watch is event-driven, with no polling DB reads.**
- The build Jeff tested (`24d656e7`) polled every station every 500 ms and read the saved board from the database on every tick. It also raised **false** red mismatches while a fader was being dragged. The live log shows:
  - `21:49:37 [board-watch] s2 … C.volume saved 1.0654 live 1.0919 (applied)`: the callback's applied copy trails a drag by a buffer;
  - `21:50:07 s9 masterMonitorVol …` and `21:50:12 s4 masterMonitorVol …`.
- Rewritten (`electron/board-watch.js`):
  - **No timer of its own.** A station is compared after a change main routes (`_boardSend`), a blade level or Take event, or a write to its saved board.
  - Checks run on a trailing debounce: 200 ms, and never later than 600 ms after the first change.
  - **The saved board is cached** and re-read only after a write said it changed. Every writer of `station_config_kv` and `deck_configs` now announces itself (`electron/board-write-events.js`, wrapped in the two handler modules), and an inbound sync pull that touched those tables refreshes it. kv keys the board doesn't read are ignored.
  - **A difference is an error only when it holds still:** the same settings with the same values on two reads 300 ms apart. A drag is never an error; a lasting divergence is raised in under a second.
- Tests (`electron/board-watch.test.js`):
  - 60 s of nothing: 0 database reads, 0 engine reads;
  - 20 changes: 1 database read;
  - a 2 s drag with the applied copy trailing: no error;
  - a cloud-sync change to a saved value: raised;
  - and the earlier cases.

**H. Responsiveness is now a sense, on `/health` (`perf`).**
- `electron/perf-sense.js` and `src/lib/perfSense.ts` are new.
- **Main:** every `ipcMain` handler's synchronous part is timed, and any handler that holds main ≥ 50 ms is listed with its channel. A stall ≥ 250 ms writes a `main-stall` line to the health ledger naming what held it, or "no IPC handler — a timer or an event held main".
- **Each window** reports, every 5 s:
  - long tasks (≥ 50 ms);
  - every click/key's delay before its handler ran, and the full input-to-next-paint time;
  - how many inputs took over one frame;
  - the window's first input since it opened.
- 60 s windows, like `eventLoopLagPeakMs`.

### After

See §4. The new build carries the senses above, so after install the same `/health` read gives main lag, renderer long tasks and first-click timing.

---

## 3 · Gates

- `tsc --noEmit`: 0 errors.
- vitest: 868/868.
- Leak guard OK; isolation guard OK; local-playback guard PASS; window-station PASS.
- Show presets 52/52; meter contract 30/30; board-restore 39/39.
- attach-after-restore 15/15, including the pre-fix control (`ad3f958`).
- `test:lh-worker` 6/6; `test:feed-no-jump` 5/5, including the pre-fix control (`193aae1`).

**Not re-run:** the Rust suite. No Rust source changed since `7598aef6`; the last single-threaded run (`90a6a47`) was 149 passed, 5 failed (the known goldens, still on hold), 4 ignored, plus 12/12 and 2/2.

## 4 · Builds and measurement

Both builds are local and unsigned, version 4.6.59. No bump, nothing pushed. Engine `7598aef6be66488d5120688d8a4f67bbdb582965a87999227908a4925225658c` (unchanged); `verify-packaged` RELEASE GATE PASS on both.

| Build | From | sha256 | Bytes |
|---|---|---|---|
| **The fix**: `C:\openair\dist-electron\Ether Setup 4.6.59.exe` | `0acf1f8` | `6b1fcb432d023979337a754daabff803bc304a4f9508f6498135985af6560ad5` | 215,971,843 |
| **Measurement "before"**: `…\Ether Setup 4.6.59 - MEASURE-BEFORE a27d3d8 - NOT FOR RELEASE.exe` | `a27d3d8` = `193aae1` (the build Jeff runs) **+ the responsiveness sense only** (local branch `measure/before-senses`) | `e406bfa6960c7d420fdde40efd5dc276bd2e6eb3140874fd01a5724c71c968d9` | 215,957,281 |

The `24d656e7` installer is kept as `Ether Setup 4.6.59 - board-watch 24d656e7 2026-10-12 1417 - SUPERSEDED.exe`.

**Packaged worker check.** The packaged `Ether.exe` (`ELECTRON_RUN_AS_NODE`) started the library-health worker from **inside `app.asar`** with the packaged `better-sqlite3`. It swept all 5 stations of the snapshot (`inWorker=true`) and answered the off-main query.

**Why two builds.** Main-process lag "before" is measured above from the live app. Renderer long tasks and first-click timing can only be read by a build that carries the sense, so the "before" build is the code Jeff runs now plus the sense and nothing else.

**The measurement** (needs Jeff: only he installs):
1. Install the MEASURE-BEFORE build. Use Ether normally for ~5 minutes with music playing, and open/close pop-outs (Up Next, Carts, Health Monitor, Library) with first clicks. Meanwhile: `node scripts/measure-responsiveness.js 5 before before.json` (read-only, ends by itself).
2. Install the fix build and do the same, with `… 5 after after.json`.
3. Compare:
   - `main.eventLoopLagPeakMs` and the stalls;
   - `slowestHandlers`;
   - per window: `longTaskPeakMs`, `inputsOverOneFrame`, `inputResponsePeakMs` and `firstInput`.

**Temporary tooling:** none left running. The 10-minute `/health` sampler (2026-10-12 21:52–22:02 UTC) ended by itself. `measure-responsiveness.js` runs only when started, and stops after the given minutes.
