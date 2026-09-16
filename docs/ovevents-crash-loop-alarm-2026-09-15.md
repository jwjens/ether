# OVEVENTS crash-loop alarm — 2026-09-15 (4.6.44) — investigation, read-only

Operator report (verbatim): ALARM "Crash-loop limit reached — auto-restart halted." Session uptime 1m,
newest Live Activity entries from 15:32 (two hours old), Audio Processing "monitor + stream: on, waiting
for audio" with no LUFS. Last activity ~15:32:50, a segue on deck B. OV is on the same 4.6.44 and fine.

All times below are LOCAL (UTC−7) unless marked Z. Receipts are file paths + line numbers on OVEVENTS.

## Verdict in one paragraph

There was no app crash and no daemon crash on OVEVENTS. **Windows Update rebooted the machine** at
16:20–16:23. After logon the HA task started the watchdog, which (a) killed its first two app spawns as
"hangs" during a slow post-update cold boot, then (b) Jeff launched Ether by hand at 16:28:39, and the
watchdog's next three spawns bounced off the single-instance lock (exit 0 in <1 s) — the watchdog counted
those bounces as crashes, hit 5-in-300 s, wrote the alarm marker at 16:29:32 and halted. The running app
(pid 23440, launched by explorer.exe, alive since 16:28:39, signed in 16:34) is healthy, is **not**
supervised by anyone, and shows ALARM only because it polls a marker file on disk. The "15:32:50 segue on
deck B" is **2026-08-14T15:32:50Z** — Live Activity is tailing a file nothing has written since Aug 16.

## Timeline (receipts)

| Local | Event | Receipt |
|---|---|---|
| 13:28:08 | HA watchdog pid 19784 starts, spawns Ether 19904 + daemon 19772 | `Roaming\Ether\watchdog.log` 20:28:08Z |
| 13:28:27 | daemon 19772 gets `cmd shutdown` (app quit); watchdog log has NO exit line → watchdog was killed first (pause/disable path) — **UNVERIFIED, Jeff's word** | `Roaming\openair\logs\ether-audiod.log` 20:28:27Z |
| 13:29:31 | Ether 11308 launched WITHOUT watchdog; spawns daemon 18364; daemon logs `[cpal] The requested device is no longer available` ×2 then nothing for 3 h | `Roaming\Ether\logs\ether-audiod.log` 20:29:31Z |
| 13:50 | reconcile to Railway "Failed to fetch" — network out until 16:20 (79 failures) | `ether-startup.log` 20:50Z; ledger `cloud-reconcile-up failures:79` 23:20:14Z |
| 15:07:42 → 16:20:05 | 2-min `library-health` tick absent for 73 min (reconcile kept running) — **UNVERIFIED cause**, not on the crash path | `profiles\ETH-STN-BAA8…\health-events.jsonl` |
| 16:20:38 | `MoNotificationUx.exe` initiates restart on behalf of OV\jensj — "Operating System: Service pack (Planned)" | System event 1074 |
| 16:22:20 / 16:22:36 | shutdown / boot #1 | System 6006 / Kernel-General 12 |
| 16:23:29 / 16:23:47 | `TrustedInstaller.exe` restarts again "Operating System: Upgrade (Planned)" / boot #2 | System 1074 / 12; `LastBootUpTime` 16:23:47 |
| 16:25:20 | explorer.exe (logon) | Win32_Process |
| 16:25:33 | watchdog 16672 started by svchost 2580 (Task Scheduler = HA auto-logon task) | Win32_Process parent |
| 16:25:39 | spawns Ether 20468 (1/5); daemon 20516 at 16:25:40 | watchdog.log 23:25:39Z |
| 16:25:57–16:26:05 | health miss 1/3, 2/3, 3/3 (**timeout**, not refused) → HANG declared, 20468 force-killed at 26 s of life. It never reached SESSION START | watchdog.log; `ether-startup.log` has no pid 20468 |
| 16:26:12 | spawns Ether 22944 (2/5) — reaches SESSION START 16:26:14, no "daemon ACTIVE" line; ~40× `daemon cmd timeout: getState`; watchdog: `/health ok but audio.alive=false`, intermittent timeouts | ether-startup.log 23:26:14Z–23:27:12Z |
| 16:28:28 | HANG declared again, 22944 killed | watchdog.log |
| **16:28:39** | **Jeff launches Ether by hand → pid 23440 (parent explorer.exe 15528)**; daemon: `owner 22944 → 23440`, `supervisor (HA watchdog) pid → (none)` | Win32_Process; openair daemon log 23:28:40.549Z |
| 16:28:40 | watchdog spawns 3592 (3/5) — exit code 0 after 0.9 s | watchdog.log |
| 16:29:01 | spawns 25532 (4/5) — exit 0 after 0.9 s | |
| 16:29:32 | spawns 12456 (5/5) — exit 0 after 0.5 s → `CRASH LOOP: >=5 restarts within 300s — HALTING` → writes `.ether-ha-alarm` = 1789514972629 (23:29:32.629Z) | watchdog.log; `Roaming\Ether\.ether-ha-alarm` |
| 16:34:50 | 23440 signs in; stations 3/4 engines constructed | ether-startup.log 23:34Z |
| 17:33:49–54 | `cmd automationStart station=2` / `automationStop` / `automationStart` — Jeff pressing AUTO | openair daemon log 00:33Z |
| 17:33:58 | `[DB query error] SELECT DISTINCT date(scheduled_at…) FROM generated_schedule … Too few parameter values were provided` | ether-startup.log 00:33:58Z (side finding) |
| 17:35 | screenshot: ALARM, "Session uptime 1m" (panel just opened), Live Activity showing Aug-14 lines | |

Live processes at 17:44: watchdog 16672 (halted, alive, 13 MB) + its orphan Electron helpers 18572/21668
(userData `Roaming\openair`); daemon ether-engine.exe 20516 (up since 16:25:40, 401 CPU-s); Ether 23440 +
its helpers. No Windows Error Reporting events (Application 1000/1001) for Ether/ether-engine today.

## Answers

### 1. Where is the crash / what killed it?
No crash. Killed by the Windows Update reboot (event 1074 ×2 above). The "15:32:50 segue on deck B" line is
from **2026-08-14**: `profiles\ETH-STN-BAA8-E056-6FC8\logs\ether-audiod.log:117` =
`2026-08-14T15:32:50.204Z [INFO] [engine s2] segue: deck B LIVE — For Good`. That file is 55,822 bytes /
531 lines (= "531 buffered"), last written Aug 16.

**Live Activity tails the wrong file.** `electron/main.js:3979` (`activity:tail`) reads
`_profileData("logs","ether-audiod.log")` = `%LOCALAPPDATA%\Ether\profiles\<uuid>\logs\`. The daemon
actually writes to:
- app-spawned: `ETHER_AUDIOD_LOG = <userData>\logs\ether-audiod.log` = `Roaming\Ether\logs\`
  (`electron/audio-daemon-client.js:122,147`);
- watchdog-spawned ("staged engine"): no env → `audiod/daemon-log.js:24-31` default `Roaming\openair\logs\`
  (`watchdog/watchdog.js:151` passes no `ETHER_AUDIOD_LOG`).
Three daemon log files exist; the panel reads the one that is dead. The displayed HH:MM:SS is the raw UTC
from the line (15:28 = 08:28 local on Aug 14).

What OVEVENTS did this afternoon: nothing on air. Station 2 (Halloween) is designated to the OV box
(ledger: `auto-extend-skipped-not-designated stationId 2 … designated to ovow…`). Daemon 18364 logged no
automation commands 13:29→16:22. "waiting for audio / no LUFS" is truthful: decks idle.

### 2. Startup crash or after running?
The counted "restarts" are all post-reboot **startup** failures of three different kinds:
- 20468: killed as a hang 26 s after spawn. There is no startup grace — `spawnEther()` calls
  `startPolling()` immediately (`watchdog/watchdog.js:270`), first poll at 5 s, three 2-s timeouts = dead
  at ~18–26 s. On a cold post-update boot (Electron + 750 MB DB open + WAL recovery + McAfee) it had not
  even written SESSION START. Misses were `timeout`, so :3400 was listening but the main loop was blocked.
- 22944: alive but the daemon 20516 was not answering `getState` for two minutes (daemon log shows only
  connect/disconnect churn and no `opened library` line); watchdog killed it as a hang at 2m16s.
- 3592 / 25532 / 12456: exit code 0 in <1 s = `requestSingleInstanceLock` bounce off Jeff's manual 23440.
  `watchdog/watchdog.js:275` already names this failure mode in a comment ("…quit, and look like a crash →
  respawn storm"); the exit handler has no code-0/<1 s discrimination.

### 3. Is the alarm persisted, or is the daemon dying again?
**Persisted, and lying about the present.**
- Marker: `Roaming\Ether\.ether-ha-alarm`, written once by `tripCrashLoop()` (`watchdog.js:389`).
- Read by every app instance on every panel poll via `fs.existsSync` (`electron/main.js:3843
  _haAlarmActive`) → `deriveHaRollup` returns ALARM before anything else (`src/lib/haRollup.ts:59-61`).
- Cleared ONLY by the next watchdog start (`watchdog.js:408` in `main()`). No app-side path unlinks it —
  `ha:disable`/pause kill the watchdog pid but leave the marker (`main.js:4114-4150`).
- The daemon is not dying: ether-engine.exe 20516 has been up since 16:25:40.
- The halted watchdog is still alive (pid 16672) and supervises nobody: the daemon recorded `supervisor
  (HA watchdog) pid → (none)` when 23440 adopted it. So HA is effectively OFF for the running app while the
  panel says red.
- "Session uptime: 1m" is time since the Health Monitor component mounted
  (`src/components/HealthMonitor.tsx:593 useState(Date.now())`, `:1081`), not process uptime. 23440 had been
  up 66 min. The label is wrong, not the process.

Two different problems, as Jeff suspected: (a) a stale marker with no in-app clear and no "is the thing I
am supervising even the running app" check; (b) a hang detector with no startup grace and no lock-bounce
discrimination. Neither is "the daemon dying again".

### 4. What changed in the daemon 4.6.39 → 4.6.44?
4.6.39 = cf61ea2, 4.6.44 = 928f48e. Three commits touch `audiod/`:
- fb4ab4f fix(playout): the decks are a slave to the calendar
- 4a3b00a fix(playout): revert the bound-head filter — it emptied the head and desynced the decks
- 928f48e feat(playout): delete the nearest-anchor reorder; name every spot that did not air
`audiod/engine.js` +206/−…, `loggen.js` −78, `smoke-nearest-anchor.js` deleted (148+/330−).
None of it ran on OVEVENTS today (nothing played here), so it is not implicated in this alarm.

**Incidental, one line, not investigated further:** `play_log` rows synced in from the OV session
`311c5aff…` (they span the OVEVENTS reboot, so they are remote) show deck B re-logging the same song every
2 s until the top-of-hour cut — "Remember Me" 11:54:26→11:59:58 (163 rows), "Somebody's Watching Me"
14:16:16→14:59:59 (1,283), "Superstition" 15:27:04→15:59:59 (966). That IS on 4.6.44, on the box that is
airing, in the advance/segue path. Audibility UNVERIFIED (Jeff's ears on OV settle it).

### 5. Restart limit, where set, what clears it
- `watchdog/config.js:6-15`: `maxRestartsInWindow: 5`, `crashWindowMs: 300000`, `backoffMs: [2,5,10,20,30]s`,
  `pollIntervalMs 5000`, `healthTimeoutMs 2000`, `maxConsecutiveMisses 3`. Env overrides are test-only.
- The initial spawn counts as 1/5 (`spawnEther` pushes to `restartTimes` for every spawn), so it is really
  4 restarts in 5 min.
- Trip: `watchdog.js:385-395 tripCrashLoop()` — writes marker, `halted=true`, stays alive quiescent.
- Clear: `watchdog.js:408` unlink on the next `main()` — i.e. only a new watchdog process. "Manual
  intervention" today means: start the watchdog again (HA relaunch), which also puts 23440 back under
  supervision via the adopt path. No fix applied; nothing changed on the machine.

## Side findings (noted, not pursued)
- `Roaming\Ether\ether-startup.log` is **1.6 GB** and never rotates; 1.17 GB of it is un-timestamped
  continuation lines from 2026-09-03. Not on today's path, but every SESSION START appends to it.
- 17:33:58 `[DB query error] … generated_schedule … Too few parameter values were provided` (renderer).
- The watchdog's own Electron helpers run with userData `Roaming\openair` (legacy name) — cosmetic.
- OVEVENTS network to Railway was down 13:50→16:20 (79 reconcile failures).

---

## Part 2 — the OV play_log repeats (read-only chase, 2026-09-15 evening)

Operator's question, verbatim: *"What is re-firing every 2 seconds, and would I have heard anything?"*

### What is re-firing

The engine's **stall-recovery watchdog**, at its retry cadence: `RETRY_MS = 2000` (`audiod/engine.js:711`).
The loop, each piece with its receipt:

1. Deck B is **idle, with a title but no file**. Rust `audio_stop` clears `file_path` and leaves `title`
   in place (`native/src/lib.rs:110-124`, the 2026-07-31 change), and the JS deck state is rebuilt from
   Rust every 250 ms (`engine.js poll() → makeState`). Every burst row carries exactly that signature:
   `file_path NULL, duration_ms 0` (a normal play of the same song at 16:46 has 215,693 ms and a path).
2. Nothing is playing for ≥ 1 s → `_watchdog()` sees "content" because `haveContent` counts a deck with
   a **title** (`engine.js:718`) → `_recoverStall()` → `_resumePlayout()`.
3. `_resumePlayout` picks `cued = … order.find(d => status === "idle" && title)` → deck B
   (`engine.js:757`), calls `_play(B)` — Rust **refuses**: `Play deck B: REFUSED — no content loaded`
   (`lib.rs:89-97`, returns false) — and the return value is **ignored**: status is set to playing,
   `_fireStart(B)` runs, `playlog.logPlay` writes a row, the log says `resume-playout: deck B LIVE`.
4. Next poll: Rust still says idle. 2 s later (`RETRY_MS`) step 2 again. Until the top-of-hour hard
   cut loads the spot on deck A — which is why every burst ends at :59:59.

The title-only selection dates from 2026-05-30 (9d42d2d, the stall watchdog); the Rust
"clear file_path, keep title" from 2026-07-31 (a672529). Together they have been a loop waiting for a
title-only standby deck.

### Would you have heard anything

**No. Dead air.** Rust refused every play, so nothing started — not a stutter, not a 2-second loop of
the intro. On OV today (session `311c5aff…`, the airing box):

| Window (local) | Duration | Rows | Song on the dead deck |
|---|---|---|---|
| 11:54:26 → 11:59:58 | 5m 32s | 163 | Remember Me |
| 14:16:16 → 14:59:59 | 43m 43s | 1,283 | Somebody's Watching Me |
| 15:27:04 → 15:59:59 | 32m 55s | 966 | Superstition |

≈ 82 minutes of silence, each ended by the top-of-hour cut. The rows are remote-origin (they span the
OVEVENTS reboot, `created_at 23:25:32Z` while no Ether existed here), pulled in by sync — so this is OV's
receipt, sitting in OVEVENTS's database. **UNVERIFIED by ear**; two lines in OV's daemon log settle it
without any interpretation: `resume-playout: deck B LIVE — …` every 2 s, and `[RUST] Play deck B:
REFUSED — no content loaded on this deck` beside each (stderr lands in the app-spawned daemon's log,
`audio-daemon-client.js:126`). OV's log: `%APPDATA%\Ether\logs\ether-audiod.log` (app-spawned) or
`%APPDATA%\openair\logs\ether-audiod.log` (watchdog-spawned).

### What put deck B in that state — UNVERIFIED, two candidates

- **New in 4.6.44:** `_resyncCuedDecks` (`engine.js:2140-2180`, fb4ab4f/928f48e) does `_stop(d)` on a
  standby deck whose file is not the calendar's next row, then `preload(d, …)`. If that preload finds
  nothing loadable (queue empty / every pending row unplayable), the deck is left title-only with Rust
  empty. The line to look for in OV's log: `calendar re-cue: deck B held "…" — the log now says "…"`.
- **Old path:** a normal `retire B (drained)` leaves the same title-only state; it only bites if the
  rotate to the next deck then fails and the queue is empty (`play-skip GUARD` lines).
Either way the loop itself is the defect: recovery selects on a title, ignores Rust's refusal, and logs a
play that did not happen. OVEVENTS's copy of `generated_schedule` cannot speak for OV (every MUSIC row
11:00–17:00 here is `missed`, stamped at 17:33 by this box's own forced anchor refill when AUTO was
pressed; OV's aired titles do not match this calendar).

### Proposed fix (NOT built — read-only chase)

1. `_resumePlayout` and `_watchdog.haveContent` select on **`filePath` (or `deckReady`)**, never on title.
2. `_resumePlayout` honours `_play()`'s return: refused → no status change, no `_fireStart`, no play_log
   row; emit a loud engine error naming the deck and fall through to "load next from the queue onto A".
3. Rust `audio_stop` clears `title`/`artist` with `file_path` (one honest empty deck), or the JS side
   treats "no file_path" as "no content" everywhere it reads a deck.
4. A recovery that fails N times on the same deck stops re-selecting it.
Sized to the report: the 2-second loop and the phantom play_log rows both stop; playout resumes from the
queue instead of dead-airing to the hour.

---

## Part 3 — what was changed tonight (alarm fixes 1–4), LOCAL, uncommitted until Jeff's word

1. **Live Activity tails the running daemon's log.** The daemon reports its sink in `hello`
   (`audiod/ether-audiod.js` → `logPath`), the client keeps it (`audio-daemon-client.js
   getDaemonLogPath`), main tails that (`main.js _daemonLogPath` / `activity:tail`, also the health
   snapshot's drain tail). Fallback with no report: newest of the two writer locations — never the
   profile copy. The watchdog now passes `ETHER_AUDIOD_LOG` like the app (`watchdog.js spawnDaemon`).
   The pane names the file and its last write; **STALE** in red after 10 min of silence.
2. **Observed supervision + in-app clear.** The watchdog signs each poll (`x-ether-watchdog: <pid>`);
   main records it (`/health` route) and reports `watchdog.supervising / lastPollAt / lastPollPid` and
   `alarmAt`. The rollup (`src/lib/haRollup.ts`) now says when the limit tripped and whether THIS app
   is supervised; alarm + supervised = DEGRADED "stale marker". `ha:clearAlarm` unlinks the marker,
   kills a halted watchdog, relaunches one that adopts the running app, starts mutual supervision.
   Panel: **Supervising This App** row, **CLEAR & RE-SUPERVISE** button. A watchdog observed via
   `/health` is monitored back (symmetry). Tests: `src/lib/haRollup.test.ts` +5 (16 pass).
3. **Watchdog: startup grace + lock bounce.** `startupGraceMs 90000`: misses don't count until the app
   has answered once or the grace passes. `lockBounceMs 2000`: exit 0 within it (after the sentinel
   checks) is a bounce — struck from the crash window, lock holder adopted via `/health`'s `pid`
   (`adoptLockHolder`). `watchdog/config.js`, `watchdog.js`. Tests: `watchdog/test` +11 (32 pass); the
   suite moved to its own port (3477) because the live Ether on the dev box answered `:3400` for the mock.
4. **"Session uptime" → "App uptime"** from `/health` `uptimeSec` + pid (`HealthMonitor.tsx`).

Help: `docs/help-live-activity.md`, `docs/help-health-monitor.md`. Backlog: startup-log rotation,
BroadcastCalendar day-list query (`docs/backlog.md`).

**Runtime receipts still owed** (the live app on this box is Jeff's; not relaunched): the panel showing
the file line, the Supervising row, the button's result line, and the header uptime — one launch of the
built artifact settles all four. `tsc --noEmit`: zero errors.
