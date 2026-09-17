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

---

## Part 4 — the loop, both boxes, with receipts (read-only, 2026-09-16)

Sources: this box's daemon logs `%APPDATA%\Ether\logs\ether-audiod.log` (since 2026-09-16T02:36Z) and
`.log.1` (2026-09-15T03:52Z → 02:36Z); a COPY of this box's DB (`scratchpad\dbcopy\openair.db`, taken
18:05 local 09-16; the live DB was not opened). Times LOCAL (UTC−7) unless marked Z. Nothing edited.

### 1. OVEVENTS — the signature is PRESENT. Three bursts, two of them last night on this box's own air

`resume-playout` lines: 234 in `.log.1`, 2,513 in `.log`; `[RUST] Play deck B: REFUSED — no content
loaded on this deck`: 2,686 in `.log.1`, 0 in `.log`. (REFUSED is stderr; the daemon's stderr fd was
opened on the file that was later renamed to `.1`, so every REFUSED lands there — the rotation gotcha
`main.js` already describes at `_healthReadTail`. 207 + 1,500 + 979 = 2,686 exactly.)

Bursts = consecutive `resume-playout: deck B LIVE — <same title>` ≤ 5 s apart:

| Local | Duration | Lines | Deck / title | DB rows (file_path NULL, duration_ms 0) | daemon session |
|---|---|---|---|---|---|
| 09-15 01:52:53 → 01:59:58 | 7m 05s | 207 | B · Jack's Obsession | 207 | `674faada` (pid 40984, 4.6.40) |
| 09-15 22:08:03 → 22:59:59 | 51m 56s | 1,500 | B · I'm In Love With a Monster | 1,500 | `5cdd20f8` (pid 25092, 4.6.44) |
| 09-16 00:26:19 → 00:59:59 | 33m 40s | 979 | B · Remember Me (Ernesto de la Cruz) | 979 | `5cdd20f8` |

Log ↔ DB match 1:1 on count, deck, title and window. **≈ 1h 33m of dead air on OVEVENTS**, all deck B, all
ended by the top-of-hour cut. The two last night happened after AUTO was pressed at 17:33 (Part 1) and
after the 18:02 relaunch (`sink open … pid 25092` 2026-09-16T01:02:53Z). Receipts: `.log.1:8791`,
`.log:4559`, `.log:14811` (first LIVE of each burst).

One more session in the DB copy, `9b92548d` (bursts 08:16:34→08:59:58 "Zombie - 2025 Remastered" 1,273
rows; 09:31:00→09:50:38 "Addams Groove" 575 rows, 09-15), is **attributed to OV by elimination**: it
carries deck-E sweeper rows (a daemon-only write, `engine.js:2314`), this box's daemon logged nothing
between 14:46Z and its 16:21:56Z `cmd shutdown` (`.log.1:19469-19472`), and the session's rows run to
09:54 local — after that shutdown. UNVERIFIED until OV's log is read; it does not change the OVEVENTS
count above.

### 2. The trigger — determined, from this box's log. It is the re-cue (shipped in 4.6.40), and it is a self-deadlock

The lines immediately preceding each burst's first `resume-playout: deck B LIVE` (position-drift and
`[mix]` heartbeats elided):

**Burst 1** (`.log.1`, 08:49–08:52Z = 01:49–01:52 local 09-15)
```
08:49:17.422Z advance → handleRotate (queue=19)
08:49:17.428Z segue: deck A LIVE — We Don't Talk About Bruno
08:49:17.428Z advance done handleRotate 6ms
08:49:18.285Z advance → recue:B (queue=20)
08:49:18.285Z calendar re-cue: deck B held "Jack's Obsession" — the log now says "Defying Gravity"
08:49:19.998Z deck C ended (pos=220.0/220.248s, chain=segue, readyB=false readyC=false readyA=false)
08:52:52.642Z deck A ended (pos=216.1/216.189s, chain=segue, readyB=false readyC=false readyA=false)
08:52:53.395Z watchdog: advanceP WEDGED 215110ms — resetting chain
[RUST] Play deck B: REFUSED — no content loaded on this deck
08:52:53.395Z watchdog: STALL — no deck playing 1016ms, forcing advance
08:52:53.395Z advance → watchdog-recover (queue=20)
08:52:53.399Z resume-playout: deck B LIVE — Jack's Obsession
```
**Burst 2** (`.log`, 05:03–05:08Z 09-16 = 22:03–22:08 local 09-15)
```
05:03:53.867Z advance → handleRotate (queue=20)
05:03:53.878Z segue: deck A LIVE — The Monster
05:03:53.878Z advance done handleRotate 11ms
05:03:54.842Z advance → recue:B (queue=21)
05:03:54.842Z calendar re-cue: deck B held "I'm In Love With a Monster" — the log now says "For Good"
05:03:56.481Z deck C ended (… readyB=false readyC=false readyA=false)
05:06:19.293Z deck A ended (pos=146.0/146.155s, chain=segue, readyB=false readyC=false readyA=false)
05:08:03.934Z watchdog: advanceP WEDGED 249092ms — resetting chain
05:08:03.935Z advance → watchdog-recover (queue=21)
05:08:03.943Z resume-playout: deck B LIVE — I'm In Love With a Monster
```
**Burst 3** (`.log`, 07:23–07:26Z = 00:23–00:26 local 09-16)
```
07:23:54.202Z advance → handleRotate (queue=20)
07:23:54.207Z segue: deck A LIVE — I Put a Spell On You
07:23:55.147Z advance → recue:B (queue=21)
07:23:55.147Z calendar re-cue: deck B held "Remember Me (Ernesto de la Cruz)" — the log now says "Goo Goo Muck"
07:23:56.778Z deck C ended (… readyB=false readyC=false readyA=false)
07:26:18.477Z deck A ended (pos=144.9/144.927s, … readyB=false readyC=false readyA=false)
07:26:19.256Z watchdog: advanceP WEDGED 144109ms — resetting chain
07:26:19.264Z resume-playout: deck B LIVE — Remember Me (Ernesto de la Cruz)
```
Same shape every time: `advance → recue:B` → `calendar re-cue …` → **no `advance done recue:B`** →
nothing gets cued for the rest of the song (`readyB=false readyC=false readyA=false`) → A ends → `WEDGED
<≈ song length>` → the reset → `resume-playout` picks the deck the re-cue emptied, whose Rust `title`
survived `_stop` → REFUSED → 2 s loop.

**Why the re-cue never completes — the code:** `_advance()` serialises ops by `this.advanceP =
this.advanceP.then(fn)` and returns `advanceP` (`audiod/engine.js:939-947`). The `recue:B` op IS the current
`advanceP`. Inside it, `await this.preload(d, this._pendingStart())` (`:2172`) — and `preload()` itself
does `return this._advance("preload:" + deckId, …)` (`:1139`), which chains onto the promise of the op
that is awaiting it. The outer waits for the inner; the inner is queued behind the outer. The chain is
wedged until `_watchdog()` resets it (`:733-737`), which requires "no deck playing ≥ 1 s" — i.e. the end
of the song. (`preload`'s idempotent early-return at `:1136` does not save it: the re-cue deletes
`deckReady` first, `:2169`.)

**Scale on this box:** 44 `calendar re-cue` lines since 4.6.40 (first 2026-09-15T05:32:39Z = 22:32
local 09-14, nine minutes after the 4.6.40 launch) → 44 `advanceP WEDGED` → **0** `advance done recue`.
Every re-cue wedges. Most end as a ≥ 1 s stall + recovery onto a deck that still had content
(`resume-playout: deck C LIVE — Be Prepared`, `.log.1` 08:45:40Z); the three above are the ones where
the only idle deck with a title was the one the re-cue had emptied. The re-cue shipped in fb4ab4f =
the 4.6.40 commit (`git merge-base --is-ancestor` confirms), so this is 4.6.40+, not 4.6.44-only.

**OV:** its bursts cannot be read from here — OV's daemon log is not synced. The line that settles OV's
trigger is `advance → recue:B` followed by `calendar re-cue: deck B held "<burst title>" — the log now
says "…"` with no `advance done recue:B`, ~1 s after the `segue: deck A LIVE` that precedes each burst —
in `%APPDATA%\Ether\logs\ether-audiod.log(.1)` on OV. The alternative (`retire B (drained)` +
`play-skip GUARD`) is not what this box shows in any of its 44 cases.

### 3. The queue was NOT empty

`advance → watchdog-recover (queue=20)` / `(queue=21)` on every burst's first line, and `(queue=20)` on
every 2-second retry after it. The queue had twenty rows the whole time. It was never consulted because:
- `_resumePlayout` returns `true` at the cued-deck branch (`engine.js:760-773`) — selecting on `idle &&
  title` — and only reaches `refillIfNeeded()` + "load next onto A" (`:775-790`) when NO deck has a
  title. The emptied deck B always has one.
- The standby-arming path only runs off a **playing** deck: `_maintain` returns at `if (!playing ||
  this.queue.length === 0)` (`:862`), and `_armAfterRotate` (`:1096`) only runs from a real rotate. With
  Rust reporting B idle, nothing preloads A or C, so nothing ever becomes `deckReady`, so the pick at
  `:761` never finds a better deck than B.
So the 2-second loop is closed on itself; the queue's contents are irrelevant to it. On OV this follows
from the same code; the `(queue=N)` on OV's `watchdog-recover` lines would confirm, UNVERIFIED there.

### 4. Proposal — NOT built

**0 (the trigger — the one that stops the dead air):** `_resyncCuedDecks`, `engine.js:2162-2174`. The
re-cue op must not `await` a chained op. Options, smallest first:
- (a) split `preload()` into the chained wrapper and a body `_preloadNow(deckId, queueIndex)` containing
  `:1141-1155`; the re-cue op calls `_preloadNow` directly (it is already inside `_advance`, so the
  serialisation it wanted is already held). `preload()` keeps calling `_advance` → `_preloadNow`.
  Blast radius: zero for every other `preload` caller (same body, same chain); the re-cue completes in
  ms; the 44-for-44 `WEDGED` pattern ends; seams go back to segue-overlap instead of stall-recovery.
- (b) alternatively, in `_advance` detect re-entrancy (an op scheduling an op and awaiting it) and log
  loudly — a guard, not a fix; (a) is the fix.

**1. `_resumePlayout` selects on content, not title** — `engine.js:760-762` (three `find`s) and the
`haveContent` test at `:719`. Replace `this._deckState(d).title` with `this._deckState(d).filePath`
(Rust clears `file_path` on stop, `lib.rs:120`, so it is the honest "has content" bit). Blast radius:
`_resumePlayout` is shared with `intentPlayNow` (`:1930-1950`, PLAY NOW button) — a hand-cued deck has a
file, so it still wins; the manual-cue preference order is unchanged. `haveContent` becoming false when
only title-only decks exist + empty queue means "genuinely nothing to play — not a stall" (`:720`),
which is the truth.

**2. Honour `_play()`'s refusal** — `_resumePlayout` `:764-772` (cued branch) and `:779-785` (load-next
branch), also the other go-live sites that call `_play` then `_fireStart` without checking:
`handleRotate` `:1080`, `handleLoadNext` `:1125`, operator start `:1893`, play-now `:1945`,
`automationStart` `:2028`, skip `:2712`. Minimal: in `_resumePlayout` only — `if (this._play(cued) ===
false) { log "resume-playout: deck X REFUSED (no content) — falling through to the queue"; emit an
engine error; clear the deck's title-only state (`_setDeck(cued,{title:"",artist:"",filePath:""})` or
step 4); continue to the queue branch; }` — no `_setDeck(playing)`, no `_fireStart`, no play_log row.
Blast radius: `_fireStart` is where `playlog.logPlay`, the `playstart` event (renderer now-playing,
stream metadata), `_airGen++` (jingle supersede) and the log-reader shadow fire (`:1664-1690`); none of
them fire for a play that did not happen — which is what "honest" means here. The other six sites can
take the same check later; they are not in the receipts above.

**3. On refusal, reload from the queue** — falls out of 1+2: with the cued branch skipped, `:775-790`
runs `await this.refillIfNeeded()` and loads the next playable row onto **A**. Note it always targets A
(`loadToDeck("A", next)`, `:779`); acceptable for a recovery. `_armAfterRotate` is not called from here,
so the standby decks get cued by `_maintain` on the next tick once A is playing (`:862-866`).

**4. `audio_stop` leaves an honestly empty deck** — `native/src/lib.rs:110-124`: alongside
`m.file_path = String::new()` clear `m.title` and `m.artist`. Blast radius — everything that reads a
stopped deck's title:
- daemon: `makeState` (`engine.js:62-70`) → `stateA/B/C.title` → the `deck` event to the renderer
  (`_maybeEmitDeck`) and the `adopt` re-emit; the log strings at `:700, :771, :785, :1081, :1126, :1894,
  :1946, :2029, :2713` (display only, `|| "(untitled)"`); the decision reads at `:719, :760-762` (fixed
  by 1). `_resyncCuedDecks` reads `filePath` (`:2166`), not title.
- renderer: the deck stream consumer `src/audio/engine-rodio.ts` (daemon-driven path) → deck panels
  show an empty deck after a stop instead of the last title. That matches the physical-deck rule ("Deck
  X UI always shows what Rust deck X is decoding"); a stopped deck decodes nothing. Anyone relying on the
  stale title to re-press PLAY was already refused at `lib.rs:93`.
- native: `DeckInfo` (`native/src/audio.rs:52-63`) is the only carrier; `audio_load` (`lib.rs:63-75`)
  re-sets all three fields on the next load, so nothing downstream sees a title without a file.
- in-process fallback engine: no title-based stall pick found in `src/audio/engine-rodio.ts` (grep
  `resumePlayout|STALL|_watchdog` → none); unaffected.

Order if built: 0 first (removes the cause and the 44 stalled seams), then 1+2+3 as one change (the loop
can no longer form even if a title-only deck appears by another path), then 4 (belt and braces).
Not built; nothing in this section was changed.

### Dead-air totals in the DB copy (rows with file_path NULL, duration_ms 0, ≥ 3 in a run)
- **OVEVENTS** (`674faada`, `5cdd20f8`): 3 bursts, ≈ 1h 33m (09-15 01:52; 09-15 22:08; 09-16 00:26).
- **OV** (`311c5aff`, plus `9b92548d` by elimination): 19 bursts from 09-15 08:16 to 09-16 07:59,
  ≈ 8h 09m — every hour has one, each ending at :59:59 (and at 00:48:47 / 07:37:44 where a second
  recovery re-selected the same deck). Last row from OV 09-16 08:19:41; this box's daemon shut down
  09-16 15:24:07Z (08:24 local) — both boxes stopped at ~08:20 today.

---

## Part 5 — the dead-air fix, BUILT (local commit only, 2026-09-16)

Branch `log-reader-flip`, on top of 7fb8eba (untouched). No push, no tag, no version bump, no install.
Neither live DB was opened. Line numbers are the post-change tree.

### What changed

**0. Re-cue deadlock — `audiod/engine.js`**
- `preload()` is now the chained wrapper only (`:1172-1177`): idempotency/status guards, then
  `this._advance("preload:" + deckId, () => this._preloadNow(deckId, queueIndex))`.
- `_preloadNow()` (`:1179-1195`) is the former closure body, verbatim: re-check inside the chain,
  never cue a file already on another deck, load the first playable row, drop unplayables loudly.
- `_resyncCuedDecks` (`:2179-2222`) calls `await this._preloadNow(d, this._pendingStart())` (`:2218`)
  — it is already on the chain, so it runs the body instead of chaining an op behind itself. It also
  empties its own view of the deck with the file (`_setDeck(d, { status:"idle", title:"", artist:"",
  filePath:"", positionSec:0 })`, `:2214`), not just the status.
- Every other `preload` caller is unchanged and still goes through the wrapper: `:702` (top-of-hour,
  inside a `setTimeout`), `:891-892` (`_maintain`), `:1069` (rotate play-skip guard, `setTimeout`),
  `:1128-1129` (`_armAfterRotate`), `:2038`, `:2069`, `:2757`. A static scan for any `_advance` closure
  that calls a chained method (`preload/handleRotate/handleLoadNext/_recoverStall/_advance`) finds only
  the top-of-hour site, and that one is deferred through `setTimeout`, not awaited.

**1. Stall recovery selects on a file — `engine.js`**
- `_watchdog` `haveContent` (`:723`): `!!this._deckState(d).filePath` (was `.title`).
- `_resumePlayout` (`:768-771`): `hasFile(d)` in all three picks (manual-cue → deckReady → any idle).
  Order unchanged, so PLAY NOW (`intentPlayNow` → `_resumePlayout`) still prefers a hand-cued deck —
  bench (d) below.

**2. `_play()===false` is honoured — `engine.js`**
- Cued branch (`:778-784`): on `false` → log `resume-playout: deck X REFUSED by the engine (no content
  loaded) — falling through to the queue`, emit `{ where:"resume-playout", deck }`, delete
  `deckReady`/`manualCue` for it, `_setDeck(idle, title:"", artist:"", filePath:"")`. No
  `status:"playing"`, no `endTriggered` change, no `dequeue`, **no `_fireStart`** — so no `playstart`
  event, no `_airGen++`, no `playlog.logPlay`, no shadow eval/stamp (`_fireStart` is `:1690-1716`).
  Then execution continues into the queue branch (`:795-815`): `refillIfNeeded()` + load onto A.
- Load-next branch (`:802-807`): the same contract after a successful `loadToDeck("A")` — a refusal
  empties A and `continue`s to the next row.

**4. `audio_stop` leaves an honestly empty deck — `native/src/lib.rs:110-128`**
- `m.title = String::new(); m.artist = String::new();` alongside `m.file_path` (`:125-127`).
- Addon rebuilt: `cargo build --release` in `native/` (2m 24s, 38 pre-existing warnings, 0 errors);
  `target/release/ether_audio.dll` → `native/ether-audio.node`. Receipt:
  `4307456 2026-09-16 18:58:43 target/release/ether_audio.dll` · `4307456 2026-09-16 18:58:54
  ether-audio.node` · `cmp` → IDENTICAL bytes · differs from `ether-audio.node.bak-pre-deadair-20260916`
  (backup kept, untracked, same convention as `docs/addon-rebuild-trace-2026-07-31.md`).
- Behavioural receipt against the rebuilt addon (station 99, no daemon, no DB):
  ```
  after load : {"title":"Ghost Title","artist":"Ghost Artist","file_path":"C:/nonexistent/x.mp3","status":"idle"}
  after stop : {"title":"","artist":"","file_path":"","status":"idle"}
  play on stopped deck returns: false
  ```

### Title readers — what still behaves, what changes
- `makeState` (`engine.js:62-70`): a stopped deck now rebuilds as `title:""` — correct, that is Rust's
  state. Unchanged code.
- Go-live log strings (`:696, :791, :810, :1073, :1149, :1931, :1983, :2066, :2752`): read the title
  right after a load/play, never on a stopped deck — unchanged output. The re-cue log reads `s2.title`
  BEFORE `_stop` (`:2215`) — unchanged.
- Decision reads (`:723, :768-771`): now on `filePath` (step 1).
- `src/audio/engine-rodio.ts` (renderer, daemon-driven): `stateChanged` (`:802-811`) compares title, so
  a stop now emits one deck update (title → "") — the panel repaints to empty. The `[ROT] END` log
  (`:823`) reads the title before the stop — unchanged.
- **The one visible change:** `src/components/OnAirDeck.tsx` renders the deck title from the stream —
  a STOPPED deck now shows as empty instead of still naming its last track. That is the physical-deck
  rule (a stopped deck decodes nothing); pressing PLAY on it was already refused.
- `native/src/audio.rs:52-63` `DeckInfo`: unchanged shape; `audio_load` (`lib.rs:63-75`) resets all
  three fields on the next load. No DeckInfo consumer other than `audio_get_state`.
- Renderer non-display decisions keyed on title: none found (grep over `engine-rodio.ts` and
  `src/components/*Deck*.tsx`).

### The seven other go-live sites — listed, NOT changed
`_play` result still ignored at: `:696` (top-of-hour, deck A), `:1072` (`handleRotate` → `toId`, guarded
by `deckReady` at `:1065`), `:1148` (`handleLoadNext`), `:1930` (operator start), `:1982` (play-now
inside `_resumePlayout`'s caller path only via the two fixed branches — this line is the manual
`intentPlayNow` deck path), `:2065` (`automationStart`, deck A), `:2751` (skip). `:2720` (jingle
channel) already checks `played`. Each follows a `loadToDeck` that returned true, so Rust has a file;
they were not in any receipt. Left for a follow-up with the same contract.

### Tests
`audiod/smoke-dead-air.js` — real `DaemonEngine`, addon stubbed at `_load/_play/_stop/_state` with a
fake Rust that mirrors lib.rs (load sets title+file; stop clears all; play refuses without a file).
`playlog.logPlay` spied. Output, verbatim:
```
── (a) THE RE-CUE COMPLETES — the chain does not wedge ──
PASS  a · the advance chain settled (no wedge)
PASS  a · 'advance → recue:B' was logged
PASS  a · 'advance done recue:B' ARRIVED
PASS  a · deck B is READY again
PASS  a · deck B holds the calendar's head row
PASS  a · the wrapper preload() was NOT chained from inside the recue (no nested op)
PASS  a · deck A untouched (still playing the same file)
PASS  a · chain idle afterwards
── (a2) NEGATIVE CONTROL — the old shape (chained preload awaited from inside the op) DOES wedge ──
PASS  a2 · awaiting the chained wrapper from inside an op wedges (this is what 4.6.40–4.6.44 did)
── (b) TITLE-ONLY DECK, RUST EMPTY — no phantom play; the queue loads onto A in ONE recovery ──
PASS  b · recovery settled
PASS  b · NO play_log row for the ghost deck
PASS  b · NO 'resume-playout: deck B LIVE' line
PASS  b · _fireStart never ran for B
PASS  b · deck B never marked playing
PASS  b · deck A LOADED and PLAYING the queue's next row (same recovery, no retry needed)
PASS  b · exactly one play_log row, for A
PASS  b · 'resume-playout: deck A LIVE' logged
PASS  b · _airGen bumped exactly once (for A), not for the refusal
PASS  b · queue consumed
PASS  b · no REFUSED line (B was never even selected — filePath rules)
── (b2) RUST REFUSES A DECK WE THOUGHT HAD A FILE — the refusal is honoured, not painted over ──
PASS  b2 · recovery settled
PASS  b2 · Rust refused B
PASS  b2 · the refusal was LOGGED as a refusal
PASS  b2 · an engine error was emitted for it
PASS  b2 · NO play_log row for B
PASS  b2 · NO LIVE line for B
PASS  b2 · _fireStart never ran for B
PASS  b2 · B emptied on our side (no ghost title left to pick next time)
PASS  b2 · fell through: deck A playing the queue's row
PASS  b2 · one play_log row, for A
PASS  b2 · _airGen bumped once, for A only
── (c) WATCHDOG: a title-only deck is not 'content' — no recovery fires for it with an empty queue ──
PASS  c · no STALL line — nothing to recover with
PASS  c · with a file, the stall recovery fires
── (d) PLAY NOW keeps its manual-cue preference for a hand-cued deck that HAS a file ──
PASS  d · resumed on the HAND-CUED deck first
PASS  d · queue not dequeued against a manual cue
=== 35 passed, 0 failed ===
```
Gates: `npx tsc --noEmit` → exit 0 (zero errors). `npx vitest run` → 28 files, **399 passed**.
`node watchdog/test/run-tests.js` → **32 passed, 0 failed**.
Existing `audiod/smoke-*.js`: autofit 47, autopost-arm 21, cmd-routing 7, deck-identity 22,
deck-position 16, deck-snapshot 25, enginestate-wire 15, enginestate 19, logreader-anchor 18,
manual-mode 30, meter-contract 15, orphan 4, queue-classes 8, seam-stop 60, xfade-contract 33 — all
pass. NOT run: smoke-automation / smoke-playlog / smoke-stream / smoke-test (they play audio and
require `--i-am-off-air`, which is Jeff's call on this box), smoke-loggen (needs a running daemon).
Pre-existing failure, unrelated: smoke-topofhour (`fillFromHour(@7:00) returned 0 item(s)` — in-memory
DB, `loggen.js` untouched by this change, last changed in 928f48e).

### Runtime receipts still owed (not done — no install)
One hour of air on a box running this build with the log-reader flag on: zero `advanceP WEDGED` after
a `calendar re-cue`, `advance done recue:B` present, and no `resume-playout: deck B LIVE` runs. On a
stop, the deck panel goes empty. Jeff confirms on screen before anything is pushed.
