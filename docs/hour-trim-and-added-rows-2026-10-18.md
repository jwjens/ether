# Clock rows trimmed, ~5 min silence before :00, songs I add get deleted — diagnosis (2026-10-18)

Read-only. Nothing changed. Code read at `809ffa7` (worktree `C:\openair-wt\release-1018`, installer
`Ether Setup 4.6.59 1018 show-boundaries 809ffa7.exe`) unless a commit is named.

## Jeff's report (verbatim)

> we had a problem with the build i put more way more rows of songs on the clocks just to make sure there is more than
> enough music to fill the hour. but you made it so only enough songs go in to fill the hour. the problem is you didn't
> account for the song overlays so it adds up to about 5 minutes of silence at the end. and you made it impossible for
> me to add songs to fill the hour because whatever you did deletes the songs i try to add. this counterintuitive to
> everything i asked for. all the rows in the clock should be added. what should be happening is after that last song
> the goes into the top of the hour is then followed by the first row of the following hour. you could do that when you
> see no songs left add one at a time from the scheduled rows. but manually adding songs should never be taken out i
> dont know what gave you the idea that was a good idea i never told you to do that

## Rules (Jeff, 2026-10-18)

1. Generate places EVERY row on the clock. Nothing is trimmed to fit the hour.
2. All timing uses each song's real segue/overlay point, not its file length.
3. The log plays in order. When a song crosses the top of the hour, it plays out and the next hour's first row follows.
   Rows of the old hour that didn't get to air are marked didn't-air, never deleted.
4. A row added by hand is NEVER removed by anything automatic: not Generate, not the reader, not any fill or catch-up.
   Only the user removes it.
5. Find exactly what deleted the added rows and what trimmed the clock rows (file:line, which change, which day).
6. Test on the test stations: a clock with extra rows, songs with overlays, a hand-added row, the hour crossing.

## What the code does (UNVERIFIED on the running app — see "check")

### A. The clock rows are trimmed — Generate stops at :00, counting full file length

- `electron/generate-core.js:277` — `if (currentTs >= hourEnd) break; // no slot STARTS past the piece's end`. Every
  clock row after the one that reaches :00 is never written to the log.
- Break-mode clocks do the same: `generate-core.js:255`, `:261`, `:267` (`while (currentTs < hourEnd)`).
- Time is counted with the **full file length**: `generate-core.js:220` and `:284` (`duration_ms / 1000`). The
  segue/overlay point is not used. On air the next song starts at the overlap, so the hour actually runs out early.
- **Which change / day:** the break is OLD — carried in `8a24202` (2026-08-11, "lift the picker into
  generate-core.js (pure move)"). It was the same in the builds before today. Before today something filled the gap
  it left; see C.

### B. ~5 minutes of silence before :00 — the reader waits for the top of the hour

- `audiod/loggen.js:249-252` — after the song on air, a row is offered only if its piece (the hour, or the show
  piece) has not ended. Rows of an hour whose time has passed are never offered.
- `audiod/loggen.js:256-258` — when the next row belongs to the next hour, the reader returns `nothing-due` until
  that hour's start: **"silence after the hour's last song until the top of the hour"** (the comment says it).
- `audiod/engine.js` `_refillFromLog` — "No built-in fill (Jeff, 2026-10-18): the station waits for the next row".
- **Which change / day:** `809ffa7`, 2026-10-18 15:08, "The show schedule is the boundary; the log plays as
  built": "no built-in fill (fillShortHour removed …) … an hour that runs out before :00 is silent until :00."

### C. Why it showed up today

- Before `2be1ea3` (2026-10-18 12:50) a short hour fell to the emergency floor (off-log picks) — the 6558e57 engine
  (`engine.js:1431`, "LOG-READER FLOOR … emergency clock/on-format fill (never dead-air)").
- `2be1ea3` (12:50) deleted the floor and added `loggen.fillShortHour`, which filled the short hour from its own clock.
- `809ffa7` (15:08) deleted `fillShortHour`. From then on, A + overlaps = silence until :00.
- The phrase "never runs past the end of its hour" does not appear in the repo or the commit messages. The rule that
  matches it is in `809ffa7`: "A row starts only inside its own piece … the song playing at :00 is the hour's last",
  implemented at `loggen.js:249-252`. That change carries it.

### D. What removes songs you add — the queue is rebuilt from the log every ~2 s

- `audiod/engine.js:2100` `addToQueue` — a song added to Up Next goes into the daemon queue with **no log row**
  (no `schedId`).
- `audiod/engine.js:1619` — every refill (2 s throttle) sets `this.queue = [...boundHead, ...freshPending]`:
  the pending part is rebuilt from log rows only. **A hand-added song that is not yet on a deck is dropped.**
  This line is also in 6558e57 (`engine.js:1529`) — not new today.
- `audiod/engine.js:1523` — NEW in `2be1ea3` (2026-10-18 12:50): when the log has nothing due (exactly the
  silence in B), `this.queue = [...boundHead]` — everything not on a deck is wiped, every 2 s.
- Also: a row in the log whose hour has passed is never offered (`loggen.js:249-252`) and is later stamped `missed`
  (`engine.js` missedRowIds sweep). An added row placed after the last row of the hour would never play.
- The Program Log at this build has no "add a song" action (IPC used: generateDay, editRowFields, moveRow,
  deleteRow, checkRow). So "add" here is assumed to be Up Next / the queue. **To confirm with Jeff.**

## Check that settles it (one run)

On the test station with a clock longer than an hour: Generate, AUTO, and at ~:50 add a song to Up Next. The daemon
log (`audiod` log) shows `logreader refill … pending from log` and the song leaves Up Next within ~2 s; at the end of
the log it shows `waiting: nothing is due — the next log row may start at <:00>`.

## Proposed fix (not built — waits for GO)

1. **Generate places every clock row** (rule 1): remove the `hourEnd` breaks at `generate-core.js:255/261/267/277`.
   Rows past :00 are still written in clock order, timed in sequence.
2. **Timing by segue point** (rule 2): Generate's per-row time = the station's segue point for that song (`outro_start`
   when set, else the duration minus the station's segue overlap — the same number the engine uses to start the next
   song). One function, used by Generate and the reader.
3. **Hour crossing** (rule 3): the reader plays the log in order. Remove the wait at `loggen.js:256-258` and the
   piece-ended skip at `:249-252` for rows of the **same show**. After the song that crosses :00, the next row is the
   **first row of the new hour**; the old hour's remaining rows are stamped didn't-air (`missed`), never deleted.
   If the old hour runs out before :00, the next hour's rows continue one at a time from its first row (Jeff's "add
   one at a time from the scheduled rows"). Show-boundary minutes (`809ffa7`) keep working as today for a different
   show.
4. **Hand-added songs stay** (rule 4): an added song becomes a **log row** marked hand-added at the position chosen
   (the next to play, unless placed elsewhere). The queue rebuild (`engine.js:1523`, `:1619`) keeps hand-added
   rows. Generate, the reader, the missed sweep and the playout check never stamp, move or delete a hand-added row.
   Only the user's delete removes it.
5. **Tests** (rule 6): on the gate test stations (`scripts/lib/gate-fixture.js`) — a clock with extra rows, songs
   with overlays, a hand-added row, an hour crossing — added to `audiod/hour-join.test.js` and the scheduler gate.

Not building: a new fill picker, any tolerance number, or a setting for this — the rules above are Jeff's.
