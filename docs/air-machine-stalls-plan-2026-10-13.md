# Air machine stalls, sync cleanup, health logs, false reopen, stream password — PLAN ONLY (2026-10-13)

Nothing is built. The code was read on branch `fix/monitor-local-output` at 91f1558. File:line references describe what the
source says. How the running app behaves is UNVERIFIED unless Jeff's report says it.

## Jeff (verbatim)

> Findings from ovowforestmusic (air machine, new build 16e13166, HalloVeen on air): startup froze ~68 s (ensurePushPendingIndex ~18 s, runMigrations ~12 s, GC); 241,064 stuck generated_schedule sync entries there; recurring 100–380 ms main stalls from the sync scheduler tick, scheduleForDate, and blocking writes to two health-events.jsonl files (415 MB + 375 MB, both written on every event); a false "output frozen" reopen of an on-air output earlier today on the old build.
>
> Fix in the next installer, plan first in plain words:
> 1. Air-machine cleanup: option B. Add a "Run sync cleanup now" button (Settings, with backup and before/after counts, plain-words result). Keep the 15-second-silence automatic path too.
> 2. Startup: never build the sync index or run heavy migrations on the main process while the window waits. Window first, then do it in the background.
> 3. Health logs: write in the background, rotate by size (size is a setting), and stop writing two copies.
> 4. Move the sync tick and scheduleForDate work off the main process or cache it so neither stalls.
> 5. Never reopen an on-air output because the main process is late. Check that the engine is still producing audio first.
> 6. Stream server password: it's still the Icecast default "hackme". Plan only: how to change the source password safely across the server and every machine's encoder without dropping any station. Do not change it until I approve.

## 1 · "Run sync cleanup now" button

**Today:** a cleanup already exists (`electron/sync/purge-excluded-queue.js` + `-worker.js`, started from `main.js:3488-3520`):
- It counts, backs up exactly the rows it will remove, checks the backup, deletes in small batches, then counts again.
- It runs once, 60 s after launch, on its own thread, and only after **15 s with nothing playing**.
- HalloVeen plays all the time, so on ovowforestmusic it never gets that quiet spell, and the 241,064 entries stay.

**Plan:**
- **Where:** Preferences → **Multi-Machine Sync** (`SettingsPanel.tsx` `MultiMachineSyncSection`), new row "Stuck sync entries". It sits next to the existing **CLEAR PENDING…** button, which stays: nothing is removed.
  - CLEAR PENDING… is a different thing. It discards the whole sync journal and sets a new baseline, in **one big delete on the main thread** (`main.js:12689-12712`). On an air machine with 241,064 entries, that would be one long stall.
  - The new button is the safe one for an air machine, and its row will say so.
- **The row shows:**
  - The count right now (e.g. "241,064 entries this machine will never send").
  - A **Run sync cleanup now** button.
- **What it runs:** the same cleanup code, on the same separate thread, with its own database connection:
  - **Backup first** to `backups\sync-queue-removed-<date-time>.db` in the station's profile folder.
  - The backup is counted, and if it is short, nothing is deleted.
  - Then small batches, about 30 ms each with a pause between, so the app and the audio engine never wait behind it.
  - The audio itself runs in the separate engine process, so it is not on this thread.
- **Unlike the automatic path, it does NOT wait for silence.** You chose B: it runs now, while on air. That is why the batches stay small.
- **Result in plain words**, shown on the row and written to the health log. For example:
  > "Removed 241,064 stuck sync entries (all for the generated log, which is never sent). Before: 241,064 waiting / 241,310 total. After: 0 waiting / 246 total. Backup: …\backups\sync-queue-removed-20261013-2210.db (241,064 rows). Took 3 min 12 s."
- **Safety:**
  - Only one cleanup can run at a time: the button is greyed while the automatic one runs, and the reverse.
  - A cleanup cut short (Ether closed mid-way) picks up where it stopped. The backup keeps what was already copied.
  - Only entries that are both "waiting to send" and for a table that is never sent are touched. Nothing else in the queue, and no station data.
- **The automatic path stays as it is:** once, 60 s after launch, after 15 s of silence.
- **Help entry:** `docs/help-sync-cleanup.md`.

## 2 · Startup: window first, heavy work after

**Today:** the steps run one after another, and the main window is created only after all of them (`main.js:3399-3483` then `createWindow()` at `:3906`):
1. The splash shows.
2. The database is opened and checked.
3. Every migration runs (`runMigrations`, `:2273`). Inside it:
   - The sync-push index is built (`:2347`). This was your 18 s.
   - The other index builds and a whole-table update of the songs run (`:2334-2370`).

**Plan:** split startup into "needed to show the board" and "heavy".
- **Stays before the window, because the window reads the database the moment it opens:**
  - Opening the database.
  - The repair check.
  - The numbered schema steps that add tables or columns. These are small, and each will be timed.
- **Moves to a background thread with its own connection, started after the window is on screen:**
  - The sync-push index (`ensurePushPendingIndex`).
  - The generated-log index (`idx_gensched_station_at`).
  - The play-log index (`idx_play_log_file_station`).
  - The songs "eligible hours" fix-up (`UPDATE songs SET daypart_mask…`).
  - Any later step that takes over 200 ms on a real station database.
  - It is the same SQL, only off the main thread.
- **Until the background job reports "indexes ready," the parts that need those indexes wait:**
  - Sync push does not start. Today, if the index is missing, the push builds it itself on the main thread (`sync-engine.js:549-556`); that goes.
  - The runway figure shows "calculating…", not a slow query.
- **A permanent sense, not a one-off:**
  - The boot report records the time of every step and every background job.
  - The Health Monitor shows "Startup background work: done in 21 s", or still running.
  - A step over 1 s on the main thread is written to the health log by name.
- **I can't measure your 12 s of migrations here:** my database is not ovowforestmusic's. The timing above will name the slow step on the first launch of the new build.

## 3 · Health logs: one file, written in the background, rotated by size

**Today:** there are two files, from different writers. Both write with `appendFileSync`, which blocks the main thread on every line.
- **`<profile>\health-events.jsonl`:** written by main (`main.js:818, 1101, 1247, 10626, 10636`) and the library check (`library-health.js:39-47`). This is the one the Health Monitor reads (`main.js:11363`).
- **`<profile>\logs\health-events.jsonl`:** written by the audio health monitor (`audio-health.js:52-53, 155, 202, 238, 259, 347`).
- **Not seen in the code:** the same event going to both files. Each writer writes one. Your report says "both written on every event", so I'll check that on the new build by counting lines per event.
- **Nothing rotates either file.** That is how they reached 415 MB and 375 MB.

**Plan:**
- **One file:** `<profile>\health-events.jsonl`, the one the Health Monitor reads. The audio health monitor writes there too, and the `logs\` copy is no longer written.
- **One writer for everyone:**
  - A line goes into a memory queue and is written to disk in the background, so the main thread never waits on the disk.
  - If the disk is slow, the queue holds up to 5,000 lines. If it ever overflows, one line says how many were dropped. It never blocks.
- **Rotation by size, both values settings:** in Preferences, in the same section as the sync row, "Health log" (shown with the current file size):
  - **Rotate at:** start value 50 MB.
  - **Keep:** start value 5 old files.
  - When the file passes the size, it becomes `health-events.1.jsonl`, the older ones shift up, and the oldest past "Keep" is removed.
  - These are written once as stored settings, shown with their values, never fixed in code.
- **The two big files today:** on the first launch both are renamed, not deleted:
  - The root file becomes `health-events.archive-<date>.jsonl`.
  - The `logs\` copy becomes `logs\health-events.archive-<date>.jsonl`.
  - Nothing is lost. **Question A** asks whether Ether may delete them after a set time.

## 4 · Sync tick and scheduleForDate off the main thread

**Sync tick:** every 10 s, on the main thread (`sync-scheduler.js:267-345`):
- The push query.
- Every third tick, the pull, which writes other machines' changes into the database.
- A `COUNT(*)` of every waiting entry, for the status line (`:306`). With 241,064 waiting, that is a walk of the whole index every 10 s.

**Plan:**
- **The sync engine runs on its own background thread with its own database connection**, the same way the cleanup does.
- **The main thread only receives the result** ("pushed 3, pulled 0, waiting 12") and passes it to the screen.
- **Pull writes go in short transactions,** the same as today.
- **The waiting count comes from the worker,** so the main thread never runs it.
- **Sleep, wake and screen-lock still pause and resume it** (`main.js:3880-3885`).

**scheduleForDate:** the announcement tick runs **4 times a second** (`ANNOUNCE_TICK_MS = 250`, `main.js:5057`), and every tick reads today's schedule for every station (`:5322-5327`, `:5359`). It is indexed, but it runs about 240 times a minute.

**Plan:**
- **Read each station's list for today once and keep it in memory.**
- **Re-read it only when:**
  - The date changes.
  - Any announcement or schedule is saved, deleted or synced in. Every such write passes through main, so the save itself clears the list.
  - Or once a minute as a safety net.
- **When an announcement fires,** its "played at" is updated in the kept list as well as in the database. The "already played today" check stays exact.
- **The tick still runs 4 times a second** and matches to the second. It just reads memory.
- **Any read that takes over 50 ms** goes to the health log, so a slow one shows by name.

## 5 · Never reopen an on-air output because main is late

**Today:** every 2 s, main asks the engine for "the time of the last sound-card callback" and subtracts it from main's own clock (`main.js:905-906`).
- If the result is 3 s or more, it reopens the output (`wedge-judge.js:13, 31-33`; `main.js:936-939`).
- **The time is measured on main's clock, after main gets the answer.** If the main thread was stuck for 3 s, a healthy output looks 3 s stale, and it is reopened. That is a gap on air for nothing.

**Plan:** all three must agree before an on-air output is reopened.
1. **The engine measures the age itself:**
   - The engine process answers "my last callback was N ms ago", measured on its own clock when it answers, not on main's.
   - This is in the engine's JavaScript (`audiod/ether-audiod.js`). No change to the Rust engine.
2. **Second check:** before any reopen, main asks again 1 s later.
   - If the callback time moved between the two answers, the card is producing audio and nothing is reopened.
   - The health log gets "Main was late 3.4 s; output alive (callback moved); no reopen".
3. **A late watchdog does not judge:**
   - If the watchdog's own 2 s tick arrived more than 4 s late, that round is skipped and logged.
   - A late main thread can never be the evidence.
- **Unchanged:** the engine's own stall watch, inside the engine process, which reopens a card whose callback has really stopped for more than 1 s (`audio.rs:3038`). Main's watchdog stays the backstop, now unable to fire on its own lateness.
- **Test:** a unit test that feeds "main was stuck 5 s, callback still moving" and expects no reopen. Plus a check on this machine that holds the main thread for 5 s on purpose while a station plays, and finds no reopen in the log.

## 6 · Stream server password ("hackme") — PLAN ONLY, nothing changes until you approve

**What is known:**
- Each machine keeps its stream password in its own station row (`stations.icecast_password`). It is local to that machine, never synced (`synced-tables.js:1088`), and it falls back to `hackme` when empty (`main.js:12350`, `audiod/stream.js:66`).
- **The server's `icecast.xml` on Lightsail is not in any repo.** Its passwords, mounts and per-mount settings are UNVERIFIED until it is read.
- **A running encoder keeps the password it started with.** The password is handed to the engine when the stream starts and kept for automatic restarts (`main.js:12353-12358`, `_streamIntent`). Saving a new password in Station settings does not change a running stream; only Stop → Go Live does.
  - So if the server changes first, the next automatic reconnect uses the old password and fails. That would drop a station.

**Safe order:**
0. **Read-only survey** (you, or me with your OK): read the server's `icecast.xml` and the live mount list, and record:
   - Every mount, which machine feeds it, and whether the admin and relay passwords are also defaults.
   - How long the passwords are.
   - The passwords themselves are not copied into any doc.
1. **Ether change** (needs your approval, would go in an installer): on every automatic reconnect, the encoder re-reads the password from the station row. A saved new password is then used on the next reconnect, with no Stop/Go Live and no gap.
2. **One password per mount** (`<mount><mount-name>/ov</mount-name><password>…</password></mount>`), so one machine's password can't feed another station.
   - The global source password changes too, so no mount is left on `hackme`.
3. **Per station, one at a time, between songs:**
   - **a.** The new password is typed into that machine's Station settings. The running stream is untouched.
   - **b.** The server's config is edited for that mount only, and Icecast is told to reload it.
   - **c.** Check that the station is still connected, and that the listener page still plays.
4. **Before any live station:** steps 3a–3c on a **spare test mount** first. This proves that a reload keeps connected sources on the air, which is UNVERIFIED for this server, and that the old password is refused and the new one accepted.
5. **Rollback:** the old `icecast.xml` is kept next to the new one; put it back and reload.

**Who does what:**
- You type the password on the air machines (ovowforestmusic, and the USPH Mac) and decide the server edit.
- I do OVEVENTS and jensj only with your OK.

**Also noted:**
- The password is in the whole-database cloud backups.
- It is visible in the encoder's command line on each machine.

## Questions

- **A.** The two old big health files are renamed to archives, not deleted. Delete them after 30 days, or keep them until you delete them?
- **B.** Health log start values: rotate at 50 MB, keep 5 files. Other numbers?
- **C.** Stream password, step 1 (re-read the password on reconnect): build it in this installer so it's ready, or wait until you approve the whole password plan?

## Installer

Items 1–5 go into one installer after you approve this plan. The Rust engine is not changed. Tests:
- The sync-cleanup and wedge-judge unit tests.
- A startup timing receipt from this machine.
- The full gate: `tsc` zero errors, leak-guard 13, `verify-packaged`.

---

## Jeff's GO (verbatim, 2026-10-13)

> GO: build items 1–5 into one installer.
> A: delete the archived health logs after 30 days (setting).
> B: rotate at 50 MB, keep 5.
> C: yes, include the re-read-password-on-reconnect change in this installer. No password change itself until I approve.
> For item 1: test the on-air cleanup on a copy of ovowforestmusic-size data while simulating playout, and report the worst app write wait during it.
> Also: 16e13166 is installed on ovowforestmusic (not yet on OVEVENTS). GO to deploy the server and Park page parts (lock, who/when, Park fader); Listen stays off. Then run test 4 against ovowforestmusic, since HalloVeen is on air from there.

## Built (commit b343fe0)

### Deployed (Jeff's GO)
- **Backend:** `git push origin HEAD:refs/heads/main` from C:\ether-backend.
  - 58e5c0d..eb61418 (f7d720e, db7cda1, eb61418). 130/130 tests passed before the push.
  - The Listen env vars are unset, so `listenRelayConfigured()` is false and Listen stays off.
- **Park page:** `npm run deploy` (C:\ether-park) → Pages deployment 7768525d.
- **Receipt:** `GET /public/ops/halloween` now carries these fields, reported by ovowforestmusic:
  - `locked: false`
  - `last`: via park, 00:19:18Z
  - `law`: option A
  - `feel`: fine 10, wheel 0.5, arrow 0.5, fine arrow 0.1

### Test data
- **A copy of this machine's live database** (read-only online backup → scratchpad). 383,998 sync queue rows after adding
  **241,064 pending generated_schedule entries** made from real generated_schedule rows (ovowforestmusic's count).
- **Simulated playout:** two separate processes, like the engine and the app:
  - "engine": a play_log insert every 250 ms.
  - "app": a station_config_kv upsert every 100 ms.
  - Each write is timed from start to commit, with busy_timeout 5 s (the app's and the engine's own).

### Item 1 — on-air cleanup test (the real worker, mode "now", no silence gate)

| | writes | p50 | p99 | **worst** | errors |
|---|---|---|---|---|---|
| app, during cleanup | 3,267 | 0.48 ms | 30.6 ms | **60 ms** | 0 |
| engine, during cleanup | 1,370 | 1.17 ms | 32.6 ms | **55.5 ms** | 0 |
| app, without cleanup | 181 | 0.30 ms | 7.4 ms | 16.2 ms | 0 |
| engine, without cleanup | 76 | 0.96 ms | 16.7 ms | 16.7 ms | 0 |

- **Removed** 241,064, backup 241,064 rows (verified count), 2,279 batches.
- **Slowest:** batch 57 ms; checkpoint 161 ms (PASSIVE, which does not block writers).
- **Took** 5 min 56 s on this machine's disk.
- **Before:** 241,064 waiting / 383,998 total. **After:** 0 waiting / 142,934 total.
- **Worst app write wait during the cleanup: 60 ms.**
- ovowforestmusic's disk is slower. The batches are sized by time (a 30 ms target), so they shrink there, and the run
  takes longer.

### Measured on the same copy (main-thread costs)
| What | Time |
|---|---|
| COUNT(*) of every pending row (the sync status line, every 10 s) | 8–17 ms here |
| Pushable count through the push index (replacement) | 0.1 ms |
| Push query without the push index, 241,064 stuck | 407–741 ms |
| Push query without the push index, after cleanup | 0.5 ms |
| Today's announcements read (×200, worst) | 0.33 ms here |
| Build push index, idle | 0.8 s |
| Build push index **with the two writers running** | **11.7 s, and each writer FAILED twice (5 s busy timeout)** |
| Build push index after cleanup, with writers | 1.7–4.2 s; one write waited 4.2 s |

**Change from the plan, because of that measurement:** a background thread does not make an index build safe. The build
holds SQLite's write lock for its whole length, so on air the engine's play-log writes would fail behind it. So:
- A step whose index already exists does nothing. That is the normal case: ovowforestmusic built all three on 16e13166.
- A missing index is built only after 15 s with nothing on air, the same gate as the automatic cleanup.
- Until it exists, the push uses the plain query when the queue is small. Over 20,000 pending, it **waits** and says so
  (`sync-engine.js PUSH_WAIT_OVER`).
- Item 4 (sync tick): the two stall sources measured were the status COUNT and the unindexed push. Both are removed
  (above), so the sync engine stays on main. Moving it to a thread would have meant untangling about 15 closures it
  shares with main (sign-in, member sync, push-now, re-baseline), for no measured gain.

### What changed, by item
1. **Run sync cleanup now:** Preferences → Multi-Machine Sync → "Stuck sync entries".
   - Shows the count, read on a worker. **RUN SYNC CLEANUP NOW** and COUNT AGAIN.
   - Live progress ("Backing up N of M…", "Removing…").
   - A plain-words result on the row and in the health log (`sync-queue-cleanup-now`).
   - Shares one lock with the automatic run. While the automatic run is still waiting for silence, the button replaces it.
   - Files: `electron/main.js` (`_syncCleanupRunNow`, `sync-cleanup:*`), `electron/sync/purge-excluded-queue{,-worker}.js`
     (modes count/now, progress, `plainResult`), `src/components/SyncCleanupRows.tsx`.
2. **Startup:**
   - The push index, the generated-log index, the play-log index and the songs eligible-hours fix-up moved out of
     `runMigrations` into `electron/startup-heavy{,-worker}.js`. They start once the window is visible.
   - Every migration statement over 200 ms is named in the startup log and the health log (`startup-migrations`).
   - A boot step over 1 s is named too (`startup-slow-step`).
   - The background steps are in the boot report, the startup log, and the health log (`startup-heavy`).
3. **Health log:** `electron/health-ledger.js`.
   - One file, `<profile>\health-events.jsonl`. The audio-health and library-health writers on main use it.
   - Lines are queued and written with async appendFile. The queue is capped at 5,000 lines, and an overflow is reported
     in one line.
   - Rotates at `health_log_max_mb` (50) and keeps `health_log_keep` (5).
   - The old `logs\` copy and any over-size file are renamed to `health-events.archive-<date>.jsonl`, and deleted after
     `health_log_archive_days` (30). These are this machine's settings (install_config_kv), written once and shown on
     Preferences → Multi-Machine Sync → "Health log".
4. **Sync tick:** the status count goes through the push index, and the push waits on a huge queue. Today's announcements
   are read once per database change: total_changes() for this connection, PRAGMA data_version for other connections.
   Neither reads a table, and any writer anywhere is caught. There is a 60 s safety re-read, and a read over 50 ms goes to
   the health log (`slow-main-read`).
5. **Output reopen:**
   - The engine measures the callback age on its own clock (`callbackAge`).
   - A watchdog round that ran over 2 s late is skipped and logged (`watchdog-late`).
   - Before any reopen there is a second look after 1 s. If the callback moved, there is no reopen, logged as
     `reopen-avoided`.
   - Tests: `npm run test:wedge`, 15/15.
- **C. Password re-read:** every encoder (re)connect re-reads `stations.icecast_password`. Daemon:
  `audiod/stream.js withPassword` with `ether-audiod.js readPassword`. In-process fallback: `main.js _spawnStream`.
  An empty saved password keeps the one the stream started with. **The password itself was not changed.**

### Tests
- `vitest` 105 files / 900 tests, including the new `health-ledger.test.js` (5) and `stream-password.test.js` (2).
- `npm run test:sync`: 13 files / 55 tests (new T-53..55, push wait).
- `npm run test:wedge`: all passed.
- `tsc --noEmit`: 0 errors.
- leak-guard: 13 (baseline 13).
- Schema chain v0–v62 clean (pre-commit).

### UNVERIFIED (needs the running app)
- **The Preferences rows on screen.** The check: Preferences → Multi-Machine Sync shows "Stuck sync entries" and
  "Health log".
- **The startup log on the first launch.** It should say `[startup] background … already there` and name any slow
  migration statement.
- **On ovowforestmusic:** the count, the button's progress and result, and the two old health logs renamed to archives.

### Installer
- **Path:** `C:\openair\dist-electron\Ether Setup 4.6.59 airstalls+cleanup ecf38bbf b343fe0.exe`
- **sha256:** `ecf38bbfdf7898c925d22bf6d06d1130a3be57709f90182b6a1a25aa78340770`
- **Size:** 216,080,309 bytes.
- **Version:** unchanged, 4.6.59. The engine is unchanged (native 91b9f495).
- **`verify-packaged`:**
  - **First run, straight after packaging: RELEASE GATE FAIL.** The daemon answered but reported engine identity
    "(none)". Every other check had passed.
  - **Re-run on the same artifact: RELEASE GATE PASS.** The engine identity matched by sha256.
  - Recorded as seen. The first run's cause is not known.
- **Contents:** 16e13166 (park control, logo, faders) plus items 1–5 and C.

