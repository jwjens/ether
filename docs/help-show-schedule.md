---
feature: show-schedule
title: Show times and AUTO
summary: Shows start and end at any minute. Every clock row goes into its hour; the log plays in order straight through the show; the show schedule is the boundary; songs you add are never taken out.
where: Schedule → Shows (and the Create Show wizard)
since: 4.6.59 (1018, schema v65)
audience: program director
tour: true
---

# Show times and AUTO

## What it is

Your **show schedule is the boundary** for everything that airs. A show runs from its start time to its end time, to
the minute. A show that ends at 1:30 automates until 1:30. The Program Log plays exactly what you built, in order.
Ether never adds songs of its own, and never skips songs because the station is running late inside an hour.

## Set it up (Schedule → Shows)

1. Open **Schedule → Shows** and click a show, or **+ New show** (or use the **Create Show** wizard).
2. Set **Starts** and **Ends** to any minute, for example 3:00 PM to 9:30 PM.
   An end of 12:00 AM means "through midnight". An end before the start is an overnight show.
3. Pick the show's clock and its days as usual, and save.
4. Run **Fill Day / Fill Week**. The log is built to the show's minutes: a show ending at 9:30 is filled to 9:30, and
   the next show's clock starts at 9:30.

## How the hour plays

- **Your clock decides how many rows an hour gets.** Fill Day / Fill Week puts **every row of the clock** into its
  hour: nothing is added and nothing is cut, even when the rows add up to more than 60 minutes. Rows that run past
  :00 still belong to their own hour in the Program Log.
- **Times use your segue overlap.** Each song is timed to start when the one before it hands over (Settings → **Segue overlap
  (auto)**), not at the end of its file, so the log's times match what airs.
- **The log plays in order, straight through the show.** When a row ends, the next row plays. **Inside a show the
  player never waits for a row's time** — no waiting for the top of the hour, no waiting for a row's start time. If
  the hour's rows run out before :00, the next hour's first row plays right away, with no silence.
- **The song playing at the top of the hour always finishes** (there's no hard stop). Then the new hour's **first
  row** plays. The old hour's rows that didn't get to play are marked **didn't play** in the Program Log, even one that
  was already loaded on a deck. They never air in the new hour, and they're never deleted.
- **Songs you added by hand to the old hour play after the song crossing :00**, then the new hour's first row.
- **There is always music inside a show.** When no song passes your rules, the song in that row's category that has
  waited longest goes in. Every show's log is built before the show starts, so a show never waits for one.
- **If a song stalls**, the watchdog restarts that same song on its own deck. It never plays a different deck instead.
- **Shows are the boundary.** A row of the next show never plays before that show starts, and the log never pulls
  rows from another day. When a show's last row ends and no show follows, nothing plays.
- **Songs you add stay.** A song you add to Up Next (Library **Q**, a drop on Up Next, or the jock strip search) goes
  into the log right after the last song in Up Next, marked as added by hand. Nothing automatic removes it, skips it
  or marks it didn't play: not Fill Day, not the top of the hour, not the playout rules. Only you remove it (the **×**
  in Up Next, or delete in the Program Log). It plays while its show is on.

## AUTO on and off

- **AUTO turns off by itself** when the log's rows are done and no show is on.
- **AUTO turns on by itself** when a show starts, starting with that show's first row.
- AUTO turns on only on a machine where the **last press for that station was AUTO**. Pressing **MANUAL** or **STOP**
  on a machine means that machine won't turn AUTO on by itself until you press AUTO there again. This keeps a second
  machine that holds the same station from going on air. After installing this version, press AUTO once on the machine
  that broadcasts.
- Starting AUTO before the first show of the day: the station waits for the show's first row. Starting AUTO **inside**
  a show: the next row plays at once.

## Good to know

- Shows made before this version keep their whole hours exactly (the minutes start at :00).
- Install this version on every machine that shares the station: older versions read a 9:30 show as 9:00.
- The web dashboard's show editor still sets whole hours. A change there keeps the minutes you set in the app.
