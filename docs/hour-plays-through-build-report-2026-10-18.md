# The clock decides the hour: build report (2026-10-18)

Branch `sched/log-plays-through` (worktree `C:\openair-wt\log-plays-through`), off `809ffa7`. Local commits only:
- `5a476f7`: the hour rules.
- `787f05d`: the Carts window.

The diagnosis that led here is in `docs/hour-trim-and-added-rows-2026-10-18.md`.

## Jeff's rules (verbatim)

> 1. Every row in the clock is generated into its hour. Nothing added, nothing trimmed, no reserve rows, no fill logic.
> 2. The log plays in order. The song that crosses the top of the hour plays out, then the next hour's first row plays.
> 3. Rows of the old hour that didn't get to play are logged as didn't-play. Never deleted.
> Remove every other assumption the code makes about filling or trimming hours. We're building the shell; the user's
> clock decides.

Also from the same day:
- "All timing uses each song's real segue/overlay point."
- "A row added by hand is NEVER removed by anything automatic."
- "Inside a show, the log never waits for :00 … 'Never run ahead' only means: never play rows from outside the show
  schedule, never jump past the show's end, never pull rows from another day."
- "An hour whose rows end early because of overlays plays straight into the next hour's first row with no silence; a
  show's last row ends and nothing plays after the show."

Carts: "The Carts window opened from the Windows panel flickers: it gets bigger and smaller very fast. … no little
squares. 6 big buttons visible, 2 columns × 3 rows, big bright colors, no spacing between buttons, just color
separation. Below them, 5 more blocks of 6 the same way, reached by scrolling down."

## What changed

### Generate (`electron/generate-core.js`)
- **It places exactly the clock's rows, each once.** The stop at :00 is gone (`if (currentTs >= hourEnd) break`, carried
  since `8a24202`). It trimmed every clock that has extra rows.
- **Clocks with timed breaks no longer repeat rows to fill.** Before, they cycled the music rows to reach each break
  minute and the hour's end. Now each row goes in once, in order. A break goes in after the row that reaches its
  minute; a break whose minute is never reached goes after the clock's last row.
- **Times use the station's segue overlap** (Settings → Segue overlap (auto), `segue_overlap_sec`), read by the same
  function the engine uses (`audiod/segue-overlap.js`). Unset = 0, which is what the engine does. A spot edge never
  overlaps.
- **Every row stores the hour it belongs to** (new column `generated_schedule.log_hour_ts`, migration v66, not synced
  because the table never syncs). A row timed past :00 stays in its own hour.
- **An hour the log has reached is the record.** "Reached" means any of its rows played, is playing, didn't play, or
  was refused at playout. Generate doesn't rebuild or delete it, and the picker sees its rows. This replaces
  "never regenerate an hour that has already aired" by the clock alone: inside a show the station can be in a later
  hour before its time.
- **The regenerate window goes by log hour everywhere**: the delete, the gap fill, and the picker's timeline.

### Reader (`audiod/loggen.js`, `audiod/show-window.js`)
- **Log order is: log hour, then time, then row id.**
- **No wait for :00.** The same show's next hour plays as soon as the row before it ends (`playsStraightInto`). A row
  of another show, of no show, or of another day waits for its start.
- **A row whose hour has ended is passed over and stamped `missed`.** The Program Log shows that as "didn't play".
- **Hand-added rows (`source='operator'`) are exempt.** While their show is on they are never passed over, never
  refused by the playout check, and never in a missed sweep. They also pass the format gate.

### Engine (`audiod/engine.js`)
- **Adding to Up Next writes a hand-added log row.** This covers `queue:enqueue`: Library Q, a drop on Up Next, the jock
  strip search (`JockStrip.tsx` now uses this path), and the remote. The row goes right after the last entry in Up
  Next. Non-music adds stay in Up Next through every rebuild.
- **The end-of-hour reset that wiped everything not on a deck is gone** (it was added in `2be1ea3`). Now, only when
  nothing may play (the show is over, the next row is another show's or another day's, or the log is done): log rows
  leave Up Next and the standby decks, and hand-added entries stay.
- **The missed stamp (engine) and the stale-row sweep (`main.js`) never touch hand-added rows.**

### Removed
- **The auto-fitter**: `audiod/autofit.js`, `audiod/smoke-autofit.js`, `eligibleForFit`, and the next-top-of-hour
  anchor.
- **The legacy refill's off-log fill** (when the log was empty, the queue was filled from the clock with picks).
  `fillQueue` now returns log rows only.
- **Loggen's unused song SELECT.** Its guard test now asserts no song query is left there.

### Program Log
- Rows are grouped and sorted by their own hour.
- `schedule:get` windows the day by log hour.
- `moveRow` and the voice-track insert carry the log hour.
- "missed" is shown as "didn't play".

### Carts window (`src/components/DeckConfigurator.tsx`, `PopoutRenderer.tsx`)
- **Flicker cause** (`DeckConfigurator.tsx`, `useSquareGridAuto` from `9afb8c0`, 4.4.141; the same pattern is in
  `useSquareGrid`, `28a9756`): tile size comes from the measured grid width.
  1. The square rows make the wall taller than the window, so a scrollbar appears.
  2. The grid narrows, the tiles shrink, the wall gets shorter.
  3. The scrollbar disappears, the grid widens, and it repeats.
- **Fix:** `scrollbarGutter: "stable"` on the measured scroll parents (both the wall and the strip).
- **New window layout** (`variant="window"`): six blocks of six, each block 2 × 3 at the window's full height, bright
  cart colours, no gaps, pure CSS (nothing is measured). Slots 37–64 are not in this window.

### Help
`docs/help-show-schedule.md` → "How the hour plays" rewritten to these rules.

## Tests (run once on the final tree)

- `npx tsc --noEmit`: 0 errors.
- `vitest`: 117 files, 1013/1013 pass.
- `verify:schema`, `test:stale-rows`, `test:queue-rows`, `test:calendar-anchor`, `test:spot-edge`,
  `test:programlog-reads`, `test:programlog-writes`, `test:sweeper-sense`, `test:hour-rollover`,
  `test:copy-on-import`: all pass.
- **Scheduler gate** (exit 1): 41 PASS. New test station **FX-PLAYTHROUGH** (8 s overlap; a 15-row clock that ends
  early on air; a 20-row clock with extra rows) and new test **T20**: 14/14 PASS. That covers every clock row placed,
  overlap timing, the hour crossing, didn't-play stamping, hand-added rows through a regenerate and a crossing, no
  silence between hours, and nothing after a show ends.
- **Remaining failures:**
  - **T3** (category spread), stations 1 and 3. It failed on every station in the baseline (809ffa7): FX-EVENING went
    154 → 112, and FX-ALLDAY went 1268 → pass.
  - **T15**: static and pre-existing. 18 → 17 findings (a baked timing number went with the auto-fitter).
  - **T18** (timed breaks within ±30 s of their minute), FX-ALLDAY: 328 → 335 off. It is the one number worse than the
    ratchet. Cause: the clock's rows are placed once with no fill to reach each break minute, and inside the show the
    log plays straight through, so breaks air up to ~40 min early. That follows from the rules; the picker is not
    tuned.
- **Gate changes**:
  - The air simulation now models the segue overlap.
  - Its missed stamp is the engine's statement.
  - T8 is redefined per rule 6 ("aired before its hour began, outside its own show and day").
  - T2 replays rows in log order.

## Behaviour to know (consequences of the rules, not choices in code)

- **A station whose hours run short runs ahead of the clock inside a show** (rows are UNSCHEDULED, or the clock is
  short). On FX-EVENING (about a third of its slots UNSCHEDULED) the show used up its rows long before 21:30 and then
  waited in silence for the Late Show. Silence like that is the clock's, and shows in the log as a wait.
- **A break-mode clock's breaks move with the rows** (see T18).
- **Hand-added rows after a show's end don't play until that show is on again.** They stay in the log untouched; only
  the user removes them.
- **Clear Day still clears hand-added rows.** It is the user's own act, and was unchanged.

## Architecture compliance

- **Log-reader single source** (`docs/log-reader-single-source-playout-design-2026-07-20.md` §2.5 operator writes):
  hand-added songs are `source='operator'` log rows, the same writer as the deck hand-load
  (`_writeOperatorLogRow`). No second queue model.
- **ONE pick** (`audiod/scheduler-core.js`): untouched except that its replace window now uses the log hour. No picker
  tuning.
- **Manual log editing** (`electron/log-edit-core.js` ownership rule): the one `'operator'` predicate is used for the
  delete, the stale sweep, the missed stamp and the reader.
- **The record is never rewritten** (`NOT_AIRED_SQL`): extended so that an hour the log has reached is the record.
- **Settings, not code**: overlap timing reads the station's setting. No new number is chosen in code.

## UNVERIFIED (static and gate only, not seen in the running app)
- Up Next keeps an added song through the end of the hour, and it plays.
- The Program Log shows rows past :00 under their own hour, and "didn't play" as their status.
- The Carts window no longer flickers and shows 2 × 3 big buttons per screen.

The one check that settles all three: install this build on the test station, Generate with a clock that has extra
rows, AUTO, add a song to Up Next at :50, and open ☰ → Carts.

## Installer

- Path: `C:\openair\dist-electron\Ether Setup 4.6.59 1018 hour-plays-through+carts e1417753 787f05d.exe`
- Size: 216,131,513 bytes (216.1 MB). Commit: `787f05d`.
- sha256: `e1417753cd3a3ad504033306cfb20cd4d50c4d9394dd1c644865b705de237462`

Release checks:
1. **Contents**: PASS. 215 of 215 packages of the last good build (`809ffa7` show-boundaries) are present.
2. **Size**: PASS. 216.1 MB against 216.1 MB (−0.0%).
3. **Launch**: the packaged app started with an empty temporary LOCALAPPDATA/APPDATA. The main window loaded, the engine
   was staged and running (`ether-engine.exe`, with `segue-overlap.js` staged and no `autofit.js`), and the daemon
   attached 2 s in. The **"Stop & Quit Ether" button could not be reached through UI Automation** (only the native menu
   bar was exposed), so the test copy was closed by ending its 7 processes. A clean in-app quit was not measured.

The new worktree had no `ha-setup.exe`. It was built from this tree's source
(`cargo build --release --manifest-path native/ha-setup/Cargo.toml`) before packaging.
