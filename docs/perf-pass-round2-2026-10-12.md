# Performance pass, round 2 — to the target (2026-10-12)

Branch `fix/monitor-local-output`. Follows `docs/health-monitor-jump-and-freeze-2026-10-12.md` (round 1, fix build `6b1fcb43`).

## Jeff's request (verbatim, relayed)

> Yes, delete the measure/before-senses branch and the MEASURE-BEFORE installer.
>
> Next round, finish the performance pass to the target (no input over one frame, no main-process stall over 100 ms after startup):
> 1. Give the stall sense timer attribution, then name and fix the ~30 s timer stalls (0.3-0.8 s). Whatever it is, move the heavy work off main (worker thread or the daemon); no polling DB work on main.
> 2. Move health:frames and video:list-encoders off main: async, cached, never synchronous IPC. The encoder probe runs once in the background, not on demand.
> 3. Renderer: find and fix the long tasks (worst 259 ms) and the slow paints (worst 288 ms). Use the React profiler and long-task attribution; fix whatever re-renders or computes too much per click.
> 4. First launch after install takes 15-16 s before a window appears: diagnose with receipts (what main.js does between lock and whenReady on the first post-install launch) and propose a fix.
> 5. Confirm the Health Monitor fix holds under a long session: it never moves, scrolls, or takes focus on its own.
> Measure before and after on OVEVENTS with the same 5-minute method, report the table, rebuild the local installer. Goldens still on hold, no version bump.

Jeff, mid-round (verbatim): **"the carts window is flickering now do that last"** — queued as the last item of this round (§7).

Done first: branch `measure/before-senses` deleted (was `a27d3d8`); `Ether Setup 4.6.59 - MEASURE-BEFORE a27d3d8 - NOT FOR RELEASE.exe` deleted.

## 0 · Before (OVEVENTS, the installed fix build `6b1fcb43`, uptime ~75 min, `scripts/measure-responsiveness.js 5`)

| | Before (round 2) |
|---|---|
| Main `eventLoopLagPeakMs` | **1,026 ms** |
| Polls that saw a stall ≥ 250 ms / ≥ 1 s | 8 / 0 |
| `/health` unanswered / worst answer | 0 / 942 ms |
| Slowest IPC handler | `health:frames` 1,100 ms |
| Renderer (main window), nobody clicking | long tasks 2, worst 108 ms |

The ledger (`health-events.jsonl`, `main-stall`) over the same minutes: a stall of **313–1,224 ms every ~10.7 s** (the ledger's 10 s rate limit plus up to one 1 s meter tick — so at least that often), all but two "no IPC handler — a timer or an event held main". Not every ~30 s as round 1 estimated from fewer lines: more often.

Hypothesis tested and **rejected**: that appending to the 317 MB `health-events.jsonl` blocks main (an on-access rescan of a huge file). On a copy, appends took 3–16 ms, the same as on a 2 MB file. So the sense, not a guess, has to name it (§1).

## 1 · The stall sense now names timers, continuations and events — `electron/stall-sense.js`

The round-1 sense timed IPC handlers only. Round 2:
- **A 50 ms self-timer** sees every stall ≥ 100 ms (the 1 s lag meter misses a block that starts and ends between two of its ticks).
- **V8's sampling profiler** through the in-process inspector (no port, no flag), every 4 ms. When a stall is seen, the samples INSIDE it are counted and the stall is named by the innermost frames of Ether's own code (`electron/`, `audiod/`), innermost first, plus the leaf function: `readAll electron/x.js:10 ← timerTick electron/main.js:100 ~300 ms`. Timers, `await` continuations, events, a `spawn`, a synchronous SQLite call — whatever ran.
- **Armed, not always on.** Cutting a profile costs main 60–90 ms (measured, Electron 43). So the profiler is off while the app is healthy; the first stall arms it for 60 s and every stall in that window is attributed in ONE cut (17 ms measured) at its end. A recurring stall is named from its second occurrence; the first is reported as "first stall: the profiler is now armed" (or with the IPC handlers seen).
- On `/health` as `perf.mainStalls` (`stallsTotal`, `stallsLast60s`, `worstLast60sMs`, the attributed list, the sense's own `cutMsPeak`). The ledger gets ONE `main-stall` line per distinct cause per minute (was: one line per 10 s, whatever the cause — a recurring stall could hide a different one).

Proof (`npm run test:stall-sense`, real Electron main): 9/9 — the profiler is off before any stall; the first stall arms it; a 300 ms block in a TIMER is named `timerWork electron/blocker.js:3` (or `spin … ← timerWork …` when V8 does not inline); a 250 ms block after an `await` is named `afterAwaitWork electron/blocker.js:4`; a 60 ms block is not counted; the one cut costs 17 ms. Unit: `electron/stall-sense.test.js` (3).

**The ~11 s stall is named by this sense on Jeff's machine** — it needs the build installed (§8). Its fix follows the name.

## 2 · `health:frames` and `video:list-encoders` off main

**`health:frames`** — receipts (read-only snapshot of the live DB, 266,845 `generated_schedule` rows): its database part is `runway.computeRunway` per station, **42–437 ms per station warm, 1.4–1.9 s cold**, because no index covers `(station_id, scheduled_at)` — the query walked every one of a station's rows through `idx_gensched_playhead` (`EXPLAIN QUERY PLAN`). Fixes:
- **The index** `idx_gensched_station_at ON generated_schedule(station_id, scheduled_at)` (`electron/main.js` initDb, beside `idx_play_log_file_station`): `computeRunway` **0.1–8.7 ms per station** on a copy; built once in **557 ms**. Also speeds the 30-minute runway sampler and the library-health sweep, which call the same function.
- **Off main and cached:** the runway + 7-day trend are computed by the library-health worker (`runwayFrames`), cached 60 s in main (a runway moves over hours; the 5 s watch cadence no longer recomputes it), refreshed in the background when stale. The handler is `async` and never blocks. The 7-day low-water series moved to `electron/runway.js runwaySeries` (rules unchanged) so worker and fallback share it. If the worker is not running, the old in-main computation runs (same results).
- Proof (`npm run test:lh-worker <db copy>`, C): main's worst lag **8 ms** while the worker computed the runway for 5 stations; the worker's answer equals the in-main computation byte for byte.

**`video:list-encoders`** — the handler was `async`, but starting ffmpeg is not: on Windows `CreateProcess` runs on the calling thread, and an on-access scan of ffmpeg.exe made it the 1,777 ms stall. Now: the probe starts ffmpeg from a **worker thread**, **once**, **20 s after launch in the background**; every caller (the handler, start-stream, start-recording) shares the one answer. Proof (`npm run test:encoder-probe`, real Electron, twice): main's worst lag **16–18 ms** during the probe (old path, warm, here: 37–58 ms; on OVEVENTS cold: 1,777 ms); same encoder list as a direct probe; three callers, one probe.

**Also off main:** the `git rev-parse` at every session start (`execSync` through a shell, up to 2 s, on main) — a packaged install has no repo and wrote `commit: unknown` every time (rotation.log). Packaged now writes `packaged <version>`; dev asks git asynchronously.

## 3 · Renderer: the sense that names the component — `src/lib/perfSense.ts`

- **React commits by component.** Every window's root is wrapped in `<Profiler onRender={reactCommit}>`; the build uses React's profiling renderer (`vite.config.ts`: `react-dom` → `react-dom/profiling`, build only) and keeps function names (`esbuild.keepNames`). A commit over one frame is broken down by component: the self time of each component rendered in that commit (fibers with `actualStartTime` in this commit; subtrees React reused are skipped). On `/health` per window: `slowCommits`, `slowCommitPeakMs`, `slowCommitWorst`, `componentSelfMs` (60 s). Bundle 3.35 → 3.48 MB.
- **Long animation frames:** each frame ≥ 50 ms with its render/layout split. **Receipt:** Chromium withholds the frame's *script* list for a `file://` page — the same page over http names `BUTTON#b.onclick → onGo` and `TimerHandler:setTimeout → timerBurn`; over `file://` (Ether's packaged load), even with `webSecurity:false`, the list is empty. So in the field the React breakdown is what names the work.
- Proof (`npm run test:react-sense`, real Chromium, a real click): 5/5 — the click's 62 ms commit is reported as `SlowList 60.3 ms, App 1.1 ms, FastRow 0.1 ms`; the memoised component that did not re-render is not blamed.

**The renderer fixes follow what this names on Jeff's machine** (§8).

## 4 · First launch after install: 15–16 s before a window — receipts so far, and the proposal

**What `POINT-4` is:** not the moment the app became ready — it is logged at `main.js` ~3733, at the END of the first part of the `whenReady` callback (after the splash, `initDb`, migrations, cloud-backup/GPIO/sync installs). So POINT-3 → POINT-4 covers module load AND that work.

**Receipt 1 — the engine stage runs synchronously at module load.** `setupAudioBackend()` is called at module top level (`main.js` ~1370) → `audiodClient.ensure()` → `spawnDaemon()` → `stageEngine()` (`audiod/stage-engine.js`), which hashes and copies the engine runtime BY CONTENT — including the ~238 MB `ether-engine.exe`, ICU, snapshots and ffmpeg — whenever their size/mtime differ from `stage-manifest.json`. **An install changes every mtime**, so the first launch after an install hashes ~300 MB and copies what differs, on main, before the app can be ready; a relaunch hits the manifest cache (0.8 s). On OVEVENTS' last install launch (pid 41968): POINT-3 23:18:30.597Z, `stage-manifest.json` written **23:18:36.617Z** (its mtime) — **6.0 s of staging**, then 9.1 s more to POINT-4.

**Receipt 2 — the remaining ~9 s: boot marks added in this build.** `%TEMP%\ether-diag.txt` now gets `BOOT <step> t+<ms> cpu <ms>` lines: stage start / stage done (files replaced) / process started (CreateProcess returned) / `setupAudioBackend()` returned / module load finished / app ready / splash done / `initDb()` done. Clock vs CPU says whether main was computing or waiting on the disk / an on-access scan. **The install of this build is itself a first-launch-after-install, so its trace is the receipt.**

**Proposal (not built — Jeff's call):** take the stage off the main thread and out of module load. Run `stageEngine` in a worker thread (hashing + copying), and spawn the daemon from that worker when it finishes; main shows the splash and the window immediately and keeps the existing daemon-connect wait/handover (the in-process fallback + "daemon attached after fallback — handover ARMED" path already handles a daemon that arrives late — see the 23:18 log). Pair with the cold-stage connect window (memory: cold-stage daemon race). The remaining ~9 s will be split by the boot marks; if it is `initDb`/migrations or another sync step, the same rule applies: off main, or after the window.

## 5 · The Health Monitor under a long session

- **Long-session smoke** (`npm run test:feed-long`, real Chromium): 1,200 events over 30 s into the REAL Master Out console; the operator wheel-scrolls the column part-way (a real OS input event). Fixed: the column never moved before the operator touched it (worst scrollTop 0); after, it stayed exactly where the operator left it (moved 0 times); the window's own sense saw **no unprompted scroll**; the window never took focus. **Control** (`193aae1`, pre-fix): the same sense catches `div#column 0→100`. 10/10.
- **Built-in sense for the real session** (on `/health` as `perf.selfActions`):
  - `electron/self-action-sense.js` — every call Ether's code makes to `focus / show / moveTop / restore / setBounds / setPosition / setSize / center` on any window, with no operator input in any Ether window in the 1.5 s before it, is recorded with the window and the caller's stack. (Tray, menu and second-launch are marked as operator acts.)
  - `src/lib/perfSense.ts` — every scroll with no wheel/key/pointer/touch in that window in the second before it, that is not a feed following its own box (`stickyScroll.ts` marks those), is reported with the element; one row per element per report, so a frequent scroller cannot hide a rare one.
  - An empty `selfWindowActions` (after the first minute) and `unpromptedScrolls` over Jeff's session is the receipt.

## 6 · Gates (this commit)

tsc **0 errors**; vitest **871/871** (100 files); verify:schema PASS; ipc-contract, preload-bridge, undefined-calls, window-station, local-playback PASS; board-restore 39/39; attach-restore 15/15; closing-isolation PASS; leak-guard 13 = baseline 13. New: stall-sense 9/9, react-sense 5/5, encoder-probe 4/4, lh-worker 8/8 (incl. runway), feed-no-jump + long + control 10/10, `electron/stall-sense.test.js` 3/3.

## 7 · Queued last: "the carts window is flickering now"

Recorded verbatim above. Not investigated yet — after the performance work, as Jeff said.

## 8 · What happens next

1. Jeff installs this build (the boot trace of that launch is §4's receipt).
2. 5-minute measurement with the same script (now also reading the stall sense and the React breakdown) while Jeff works normally — clicks included.
3. The sense names the ~11 s main stall and the components behind the slow clicks → fix them (off main / stop the re-render) → after-measurement → installer.

## 9 · Build (round 2, senses + main-process fixes)

From `721cd86` (`npm run build` + `npm run electron:build:win -- --publish never`, no version bump):
- `C:\openair\dist-electron\Ether Setup 4.6.59.exe` — 216,040,164 bytes, sha256 `0b1ef492e5f1147102c69f97869d4973ca8689f4e21648eae6514746cd27c143`
- `app.asar` sha256 `ce021cb747e47b5ce7b7c4dc6a544cbc724166665c9a64230214b204df36feb1`; engine `7598aef6` (unchanged); `audiod/verify-packaged.js` RELEASE GATE PASS.
- The installed round-1 fix build was renamed `Ether Setup 4.6.59 - perf-fix 6b1fcb43 0acf1f8 - SUPERSEDED.exe` (sha256 checked before the rename).
- Rust suite not re-run: no Rust change since `90a6a47` (149 pass / 5 known goldens / 4 ignored). Goldens on hold.

## 10 · What the senses named on OVEVENTS (build `0b1ef492`, installed; `app.asar` `ce021cb7…` confirmed)

5-minute measurement from ~12 min uptime (`scripts/measure-responsiveness.js`, same method):
- **Main:** 36 stalls ≥ 100 ms in 5 min, worst 620 ms (the 1 s meter's peak 569 ms); 0 unanswered, worst answer 542 ms.
  - **20 × ~300–620 ms, every ~10.4 s — the SYNC PUSH.** The profiler showed no Ether frame (the sense's "Ether code" pattern did not cover `electron/sync/` — fixed) and a native leaf; the 10.4 s period matched the sync scheduler's push tick (10 s + work). Re-timed on the read-only snapshot, the push's pending load exactly as the engine builds it: **290 ms (node:sqlite) / 519–579 ms (better-sqlite3), 0 rows**. `mutations` holds **217,002 'pending' rows, every one `generated_schedule`** — syncExcluded since ruling A (`synced-tables.js:455`), so never sent, never retired, and still being journalled (5,136 since Oct 10). Each tick walked all of them through `idx_mutations_sync_status`, filtered them out by `table_name`, and sorted.
  - **5 × up to 186–207 ms — `schedule:playhead-view`**, UpNext's 30 s shadow-compare: a station's pending rows sorted by time, on main.
- **Renderer (main window):** 115 commits over one frame in 5 min, worst 205 ms. By component (self time in slow commits): `LiveConsole` 187 ms in ONE commit, `MasterOutput` 90 ms, `LivePanel` 71 ms; over the run `motion.div` 308, `ConsoleStrip` 218, `UpNext` 132, `PeakAvgMeter` 89 ms. A later 60 s window (nobody clicking) added `VideoEngineProvider` 152 + `VideoEnginePanel` 100 ms.
- **Item 5 receipt so far:** 27 min into the session, `selfWindowActions` = only the 4 startup calls (main window centred and shown, faded in, focused at launch — `main.js` 2820/2821/3813/3827, before any operator input exists); `unpromptedScrolls` = **none**.

## 11 · Fixes from what was named

**Main**
- **The push reads only what it can send.** A PARTIAL index `idx_mutations_push_pending_<hash>` on `mutations(hlc)` holding only pending rows of sendable tables; the push names it (`INDEXED BY`) with the excluded tables as literals in both index and query (SQLite uses a partial index only when the WHERE matches; the name carries a hash of the list, so a changed list makes a new index and the stale one is dropped at open). `electron/sync/sync-engine.js ensurePushPendingIndex` (initDb; made on first use if the table did not exist yet). On a copy of the live data: **431.5 ms → 0.57 ms**, the same 300 rows in the same order, no excluded table or station ever returned (`npm run test:push-index <db copy>`). Built once: 0.65–1.1 s. NOT changed (one line for Jeff, not this task): the 217k never-sendable rows stay in the table, the Sync panel's pending count includes them, and the writer still journals `generated_schedule`.
- **`schedule:playhead-view` off main:** the same read on the library-health worker's read-only connection (`electron/runway.js playheadView`); main only resolves the station. Worker smoke D: main's worst lag 9 ms, answers identical.
- The stall sense counts any `electron/…` / `audiod/…` subfolder as Ether code.

**Renderer**
- **Master Out:** the master level was React state set on every `audio:levels` event (~30/s), so all of Master Out (mixer, faders, the 100-row console) re-rendered ~30×/s. Now a ref; `onAir` renders only when it flips; the Limiter line is its own small component that renders only when its text changes; the console reads the level from the ref and checks silence every 500 ms (same rule: > 0.03 is sound, 5 s without it is silence).
- **The board:** `LivePanel` subscribed to every deck event only to hand the decks to `FaderSection`; the Decks pop-out polled every 250 ms. Both now render `FaderSectionLive`, which selects **status + volume only** (`deckStore.ts selectBoard`) — a position tick no longer re-renders the board.
- **Up Next:** the countdowns (deck event + 1 s tick) lived in Up Next's own state, so every tick re-rendered the whole animated list (each row a framer-motion `layout` element that measures the DOM). The deck rows are now their own component (`DeckRows`) with their own clock; the list renders when the queue, its lint, its sweepers or its art change.
- **Show+:** the 500 ms video-status poll set a new object every time; now only a changed status re-renders.
- Guards: `src/lib/renderBudget.test.ts` (7).

## 12 · Item 4 — the receipt (the install of `0b1ef492`, pid 40428, `%TEMP%\ether-diag.txt`)

```
POINT-3 lock acquired                                    t+1.5 s
BOOT setupAudioBackend() starts                          t+2049 ms  cpu 874 ms
BOOT main.js module load finished                        t+2693 ms  cpu 1202 ms
BOOT daemon spawn: engine stage starts                   t+3159 ms  cpu 1452 ms
  [stage-engine] staged engine updated from the install: ether-engine.exe
BOOT daemon spawn: engine stage done (replaced 1)        t+7420 ms  cpu 3624 ms   <- 4.3 s, 2.2 s CPU: hashing + copying
BOOT daemon spawn: process started (CreateProcess)       t+15797 ms cpu 3780 ms   <- 8.4 s, 0.16 s CPU: WAITING
BOOT app ready (whenReady callback starts)               t+16099 ms
BOOT createSplash() done                                 t+16237 ms
BOOT initDb() done                                       t+16680 ms
POINT-4                                                  t+16722 ms
```
- **13 s of the 16.7 s is the audio engine's staging and start, synchronous on main, before the app can be ready:** 4.3 s hashing/copying the 238 MB `ether-engine.exe` (changed by the install), then **8.4 s inside CreateProcess with almost no CPU** — main waiting while Windows starts a freshly written 238 MB executable (an on-access scan of a new binary is the consistent explanation; the trace proves the wait, not the scanner). A relaunch hits the stage cache and starts a known exe: 0.8 s.
- What Ether does after ready (splash, initDb, migrations) is 0.6 s.
- **Proposal (not built):** stage and spawn the engine from a worker thread, not on main and not at module load. The window and splash come up at once (~3 s); the daemon arrives when Windows lets it start, and the existing late-attach/handover path already plays on the in-process engine until then (the 23:18 log shows that path working). Widen the cold-stage connect window with it (memory: cold-stage daemon race).

## 13 · The carts window flicker (Jeff, verbatim: "the carts window is flickering now")

Done last, as asked. What the senses and the code show:
- No carts **pop-out** was open when read (the only window reporting was the main window), so the surface is most likely the CARTS dock or a cart deck inside the main window.
- The cart wall's VU took **every station's** `audio:levels` frames, interleaved, unscoped — its meter jumped between stations' CART levels (a sweeper on another station's CART bus moved this wall's meter), and the whole wall re-rendered at every station's meter rate. Fixed: this station's frames only (`matchesStation`), and a render only when the drawn bar changes.
- The round-1 build made the board re-render on every deck tick (LivePanel subscribed to the decks), and a cart deck lives inside the board. Fixed above (the board reads status + volume only).
- **Not confirmed as THE flicker** — neither change is proven to be what Jeff saw. Needs Jeff's eyes on the next build: which carts surface, and what flickers (the meter, the tiles, the whole panel).

## 14 · Build (round 2, fixes)

From `fc89cc5`, no version bump: `C:\openair\dist-electron\Ether Setup 4.6.59.exe` — 216,025,982 bytes, sha256 `020771f1520deb8c1df22fcba8a6260038043386334c32495f42f01ad64c0375`; `app.asar` `577806e8ae0541c734f4f6dfc702eb2b25bd9a2756574de61088902a320c5aab`; engine `7598aef6` unchanged; verify-packaged RELEASE GATE PASS. Previous (senses) installer renamed `… perf-senses 0b1ef492 721cd86 - SUPERSEDED.exe`. Gates: tsc 0; vitest 878/878; test:sync 49/49; schema/ipc/preload/undefined-calls/window-station/local-playback/closing PASS; board-restore 39/39; attach-restore 15/15; leak-guard at baseline; stall-sense 9/9, react-sense 5/5, encoder-probe 4/4, feed-long 10/10, push-index 5/5, lh-worker 10/10. The after-measurement follows Jeff's install.
