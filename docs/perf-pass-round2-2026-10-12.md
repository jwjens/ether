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
