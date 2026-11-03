# UNSCHEDULED slots, the least-recently-played ruling, and the import duplicate guard (2026-10-19)

Branch `sched/log-plays-through` (worktree `C:\openair-wt\log-plays-through`). Local commits only.

## Jeff's reports (verbatim)

> there plendy of songs to play when the all run out why am i getting thi
> [pasted: "14 slots UNSCHEDULED — no song passes your rules there. … 4 PM, Mon, Oct 19 — 3: 4:00 PM kids (I Want Candy:
> song 43.2 of 60 min; …)" through 8 PM]
> there are still songs that dont get put in rotation this is wrong

> its or least recently played weve gone over this

> and just because the song has the same name look at the length they are not the same song

> with the categories there is no way a song could need to be played again in an hour

> there is less times an hour than amount of songs in the category thats impossible

> once all songs have been played you start with the least recently played so that would be the first song again

> also i need a duplicate indentifier when i download songs like windows does to replace or skip duplicates this i a
> priority this morning

> i have a largef folder with some repeating songs and i only want the new ones

> no not repeats in the folder songs i already have

> make sure you finish the first project on the generator you were not supposed to abandoned that

## Finding 1: the cause of the UNSCHEDULED slots (Jeff was right)

Read-only, from the live DB (`%LOCALAPPDATA%\Ether\profiles\ETH-STN-BAA8-E056-6FC8\openair.db`, schema v66) and a copy.

- Station 2 categories: Kids 8 songs, Disney Halloween 8, HV Adult 9. Rules: song, artist and title 60 min.
- Clock "HalloVeen Hour One" (3–6 PM) has 33 rows, 10 of them Kids, about 75+ minutes of music. Since 2026-10-18 every
  clock row is placed, so the 3 PM hour's last rows are timed 4:00–4:14 PM. They belong to the 3 PM hour.
- **The picker counted those rows as if they would air.** By Jeff's rule (the song crossing :00 plays out, then the next
  hour's first row; the rest are didn't-play) they do not. Each new hour's Kids, Disney and Adult picks were blocked by
  songs sitting in the previous hour's leftover rows. Example: Thunder at 4:14 PM (3 PM hour) blocked Thunder for the
  4 PM hour.
- **On a copy of the live DB, Generate for Oct 19 (station 2):**

  | | UNSCHEDULED | least recently played |
  |---|---|---|
  | before | 14 (Jeff's report) | — |
  | least-recently-played only | 0 | 15 |
  | plus leftover rows not counted | 0 | **0**: every slot passes the rules |

- I first told Jeff the clock "contradicts" his statement because 10 Kids rows > 8 songs. That was wrong: the 10 Kids
  rows span about 75+ minutes, not 60. Retracted.

## Finding 2: duplicate rows in the clocks (reported, not changed)

Pairs of clock rows created 6–64 ms apart, too fast for a hand:

| Clock | Pairs (row id, time apart) |
|---|---|
| Hour One | 473/474 (same position, 22 ms), 503/504 (same position, 6 ms), 498/499 (64 ms), 500/501 (94 ms) |
| Hour Two | 387/388 (49 ms), 479/480 (same position, 16 ms) |

- All have `duration_min 3.5`, the value the "+ add" button in `ClocksTab.tsx` passes (`handleAdd`, line ~395).
- `handleAdd` awaits a query before it creates the row, and uses the stale `slots.length` as the position. A double
  click therefore makes two rows, sometimes at the same position.
- **Not changed.** Jeff decides whether those rows were meant; only he removes clock rows.

## Finding 3: two songs on one file

These rows point at one stored file (a later download with the same name):
- "The Monster" by Chris Bacon (2:26) and by Eminem (4:10): `The Monster_spotdown.org.mp3`.
- "The Munsters" Theme at 0:48 and 2:54: `_The Munsters_ Theme_spotdown.org.mp3`.
- Thriller (×2) and Jack's Lament (×2).

Mentioned only. The duplicate guard below stops new cases at import.

## What changed

### Generate and the pick (`audiod/scheduler-core.js`, `electron/generate-core.js`)

- **When no song passes, the least recently played song goes in** (`leastRecent`). It is the song in the slot's
  category that has waited longest since it last aired or was placed; ties are random.
  - The row's `pick_reason` is `{m:'least-recent', broke:{rule,…}}`.
  - It is counted in Generate's `relaxed` list (Health and Scheduler Health show it), and the status line says
    "N least recently played".
  - The station's fallback category, if named, is tried first under the rules.
  - UNSCHEDULED now means only an empty category.
- **The title rule's identity is title + length to the second** (`titleKey`), everywhere the rules are measured: the pick,
  the timeline from play history and the log, and the playout check.
- **Rows past their hour's end don't count for the next hour.**
  - In a run: they keep the rules among themselves while their hour is built, then come off the timeline (`uncommit`).
  - From earlier runs: `loadTimeline` skips them.
  - The hour's end is the piece's end from the show schedule (`show-window.pieceAt`, `pieceEndFn`), the same as
    Generate. A show ending at 22:30 ends its hour at 22:30.
- **Playout check** (`audiod/loggen.js`): a least-recently-played row is never refused at air. No song passed there, so
  the rule was already set aside.
- **Program Log:** the UNSCHEDULED banner now reads "the slot's category has no song to play".

### Import Music duplicate guard (`src/lib/importDuplicates.ts`, `src/components/ImportDialog.tsx`)

- Before anything is copied, every file's title and length are read and compared with the library. A file is
  "already in your library" if it has the same title and length to the second as a song there, or the same file name
  and length (which catches songs renamed in Ether). Only songs already in the library count, not repeats inside the
  folder.
- The new step lists each one: the new file's title, artist and length, and "You have:" with your song's title, artist,
  length and category.
- Choices: **Skip all — import only the new**, **Replace all**, or Skip / Replace per song, then Continue. Cancel import
  copies nothing.
- **Replace** keeps the library song (id, category, play history, rotation). Its file is replaced by the new file
  copied into the catalogue, its length is updated, and analysis re-runs. The old file stays on disk.
- The finish screen reports how many were imported, skipped and replaced.

### Help
- `docs/help-program-log.md` → new section "How each song is picked".
- `docs/help-import-duplicates.md` (new). Door: Library → Import Music.

## Tests

- `tsc --noEmit`: 0 errors.
- vitest: 118 files, 1024 tests pass. New tests: least recently played (including "the first song comes round again"),
  title + length, and the import guard (including a Windows path, and titles normalised the same as the scheduler).
- Smoke tests: verify:schema, stale-rows, queue-rows, calendar-anchor, spot-edge, programlog-reads, programlog-writes,
  sweeper-sense, hour-rollover, copy-on-import: all pass.
- **Scheduler gate:** 41 PASS. T1 and T2 pass on all three stations; on FX-EVENING, 405 least-recently-played slots,
  all of them the least recently played song.
  - The gate's checker was taught the same three things: least-recently-played rows, title + length, and rows past
    their hour's end.
  - Still failing, as before: T3 (stations 1 and 3), T15 (17 findings, static), T18 (station 2, 328 → 335).
- **Duplicate rule on real data** (live-DB copy, the engine's own length probe on each file):
  - 423 of 433 catalogue files would be recognised if imported again.
  - The 10 that would not have a stored length that differs from the file, e.g. Ghostbusters 4:05 in the library and
    3:20 from the probe, and "Don't Stop Me Now" with no length. Same title, different length is a different song.

## UNVERIFIED (not seen in the running app)
- The Import Music duplicate step on screen, and that Replace re-points the song and it plays.
- Fill Day on station 2 showing no UNSCHEDULED slots in the app.

**One check settles both:** install the build, open the Program Log for station 2, press Fill Day for Oct 19 or 20, then
Library → Import Music → Choose Folder & Import on a folder with some songs you already have.

## Installer

- Path: `C:\openair\dist-electron\Ether Setup 4.6.59 1019 lrp+import-dupes 05ecb452 833028f.exe`
- Size: 216,135,773 bytes. Commit: `833028f`.
- sha256: `05ecb4525378643ecd4eaa8d8d2eb13fa37f1ef677fba9abe2b424436b0bc043`

Release checks:
1. **Contents**: PASS. 215 of 215 packages of the last good build (809ffa7) are present.
2. **Size**: PASS. 216.1 MB against 216.1 MB.
3. **Launch**: NOT RUN. Jeff's installed Ether was running (pid 16636, started 9:16 AM). The test copy exited at the
   single-instance lock (`%TEMP%\ether-diag.txt`: "POINT-2b: lock NOT acquired — exiting (another instance running)").
   The lock follows the real Roaming AppData path (main.js:281 `app.getPath("appData")`), which a temporary APPDATA
   does not change. Jeff's running app was not closed. To be run with Ether closed.

The packaged files carry today's code: the staged `audiod/scheduler-core.js` has `leastRecent`/`pieceEndFn`, the asar's
`generate-core.js` has `least-recent`, and the renderer bundle has the "already in your library" screen.

## Later the same morning: "the schedule is gone after every install" (commit b02a58b)

Jeff (verbatim):
> everytime i install generator says no songs are there to play but i generated earlier this morning a schedule can not be
> deleted every new install or ether close thats hours of work gone
> htats what a database is for
> why is morning show not populating the queue
> i just added it
> thats bad it should attach to the time of that hour and be instant

**What the records show** (live DB read-only, health-events.jsonl, rotation.log, %TEMP%\ether-diag.txt):
- No database swap or restore at the 10:24 install: `initDb() done (open + repair + migrations)` on the same file.
- The rows Jeff saw were later replaced by his own Fill presses: Generate at 9:17, 9:18, 9:20, 9:25, 10:22 and 10:32.
  Fill hard-deletes the pending rows of the window it rebuilds.
- Station 2 was never playing. AUTO was pressed 12 times between 9:17 and 10:35. Station 2's shows ran 3–9 PM, so no
  show was on.
- At 10:35 Jeff added "Morning" (9 AM–3 PM). Fill builds from the **next** hour, so today's rows started at 11:00. AUTO
  at 10:36 found nothing due in the 10:00 hour and waited for 11:00. The queue stayed empty.
- So the log was not lost to the install. What Jeff saw was an empty queue: no show on, then a current hour Fill never
  builds. UNVERIFIED: the exact words on screen; no "no songs" text exists in the Program Log or Calendar code.

**Fix (b02a58b):**
- Fill Day and Fill Week build the **current** hour, timed from its :00, unless the log has reached it (anything
  played, playing, didn't play or refused in it).
- AUTO joins that hour at the row for now; earlier rows are didn't-play.
- The reader never jumps ahead to a later hour. I tried that first and took it out: T5 caught it playing 53 evening rows
  hours early, and Jeff called it bad.
- The unattended extender still starts at the next hour, so it never reshuffles the hour on screen.
- Rows written before v66 (no log hour) are recognised by their time when deciding whether an hour has been reached, so
  an on-air hour keeps its pending rest.

**Tests:**
- Copy of the live DB at 11:02: the 11:00 hour was built (69 rows from 11:00), and AUTO played the 11:02:50 row at once.
- hour-join 28/28; smoke programlog-writes 110/110; vitest 1027/1027.
- Gate: 41 PASS, with the same three failures as before (T3, T15, T18).
- Flaky, unrelated: `src/modules/proof/carts.proof.test.tsx` failed 1 run in 3 on its own (an extra bridge call).

### Installer with b02a58b
- `C:\openair\dist-electron\Ether Setup 4.6.59 1019 current-hour+lrp+import-dupes a1085bbd b02a58b.exe`
- 216,136,710 bytes; sha256 `a1085bbd52c05731fe87096cb416f9e595a08979cc1be741d4e952b0788d22a0`
- Contents: PASS, 215 of 215 packages. Size: PASS, 216.1 MB against 216.1 MB.
- The packaged main.js carries `_genStartTs`.
- Launch: NOT RUN. Jeff's Ether is running and holds the single-instance lock (same as the 05ecb452 build).
- Supersedes the 05ecb452 installer.
