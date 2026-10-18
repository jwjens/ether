---
feature: show-schedule
title: Show times and AUTO
summary: Shows start and end at any minute. The show schedule is the boundary; AUTO comes on when a show starts and goes off when the log is done and no show follows.
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

- **Every hour is its own piece.** The song playing when the top of the hour arrives is that hour's last song, and it
  always finishes: there's no hard stop. The new hour then opens with **its first scheduled row**.
- If the hour's songs run out before :00, the station is **silent until the top of the hour**. Then the hour's first
  row plays.
- A show's start or end inside an hour works the same way. At 9:30 the song on air finishes, then the next show's
  first row plays.
- Inside an hour nothing is skipped for being late. Rows play in order.
- Clocks carry extra rows so an hour can fill when songs run short. Rows that don't fit before the end are simply
  never placed.

## AUTO on and off

- **AUTO turns off by itself** when the log's rows are done and no show is on.
- **AUTO turns on by itself** when a show starts, starting with that show's first row.
- AUTO turns on only on a machine where the **last press for that station was AUTO**. Pressing **MANUAL** or **STOP**
  on a machine means that machine won't turn AUTO on by itself until you press AUTO there again. This keeps a second
  machine that holds the same station from going on air. After installing this version, press AUTO once on the machine
  that broadcasts.
- Starting AUTO before the first show of the day: the station waits for the show's first row.

## Good to know

- Shows made before this version keep their whole hours exactly (the minutes start at :00).
- Install this version on every machine that shares the station: older versions read a 9:30 show as 9:00.
- The web dashboard's show editor still sets whole hours. A change there keeps the minutes you set in the app.
