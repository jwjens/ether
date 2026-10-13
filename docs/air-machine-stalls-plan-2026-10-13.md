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
