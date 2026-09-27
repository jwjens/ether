---
feature: program-log
title: "The Program Log"
summary: One day of the station's real log — what aired, what is on air, what is coming — with Fill Day, Fill Week, Clear Day and CSV / Print / PDF export.
where: ≡ menu → Program Log, Schedule → Program Log (its own window), or the PROGRAM LOG tab at the bottom of the dashboard (docked)
since: 4.6.49
audience: operator
tour: true
---

# The Program Log

The Program Log shows **one day of the log the station actually airs from** — the same log the
engine reads and airs from. Pick a day on the small calendar at the left; every hour of the
day is a row you can open.

## Docked or in its own window

- **PROGRAM LOG** on the bottom tab bar docks it under the decks — the live screen stays where it is.
  Drag the divider above it for more room; the left column scrolls if the dock is short.
- **≡ → Program Log** or **Schedule → Program Log** opens it in its own window (drag it to a second
  monitor; it remembers its size and place).
- You can have both open. They show the **same rows**: a Fill, a Clear, an edit in the hour editor, a
  song going to air — each surface updates within about a second. Both open on the last day you
  picked for this station.

## Reading the day

- **The left column of the mini calendar** shows a green dot under every day this station has a log for.
- **TODAY'S SHOWS** lists this station's shows and how many of their hours have rows.
- **Each hour row** names the show and clock for that hour, how many items it holds and how long they
  run. Open it to see the items.
- **Time** — the first column is the scheduled time, `HH:MM:SS`. When an item has aired, its **actual**
  air time appears underneath in green. That is the as-run receipt.
- **Status** — `pending` (not yet), **`playing`** (on air now, highlighted), `played` (aired, green),
  `missed` (a spot or item that did not air, red).
- **Why this song** — click a song and the generator's reason appears under its title: its category, how
  many songs were in the pool, how many were ruled out and by which rule, and whether any rule had to be
  relaxed. Click again to hide it. A song placed by hand (swapped in) or generated before reasons were
  kept says so instead — a reason is never made up afterwards.

The summary at the top — *N of M hours scheduled · total programming* — is counted from these rows. M is
the number of hours listed: the hours your shows cover, plus any hour that already has rows.

## Fill Day

**Fill Day** builds the log for the selected day from your shows and clocks. It fills **from the next top-of-hour to the end of the day**:

- Hours that have already started are never touched. What aired is a record, not a plan.
- Items you placed by hand (they wear the YOURS badge in the hour editor) survive a Fill.
- Filling a day that has already fully aired does nothing and says so.

Fill Day acts on the **station you are switched into**. Switch stations first if you mean another one.

There is no per-hour generate: to rebuild part of a day, clear the hours you want rebuilt (the ✕ on
each hour row) and press Fill Day — it fills the gaps and leaves everything else in place.

## Fill Week — scheduling weeks ahead

**Fill Week** sits next to Fill Day and builds **seven days in one run: the selected day and the six
days after it.**

To schedule further out, pick the day you want to start from in the mini month and press Fill Week.
There is no limit on how far ahead you can go — a week three weeks out fills exactly like next
week's. Three presses from three different start days gives you three weeks.

Every rule Fill Day follows, Fill Week follows on **each** of the seven days:

- Hours that have already started are never touched — only the first day can have any, since the rest
  are entirely in the future.
- Items you placed by hand (the **YOURS** badge) survive.
- Days that have already fully aired are skipped.

While it runs:

- The **progress bar** moves hour by hour across the whole week, not once per day, so you can see it
  working.
- **CANCEL** stops it at the next hour boundary. **Every day that already finished is kept** — you
  never get half a day. The message tells you how many days were kept.

When it finishes it reports **how many rows it placed across how many days**, and the day on screen
re-reads itself. The other six days are built and waiting; open any of them in the mini month to see
them. If you have the Program Log open in both the dock and its own window, both update.

> **One thing to know about the count.** The number reported is what the scheduler *built*. If a day
> contains rows you placed by hand, the built rows that would have landed on top of them are dropped
> rather than double-booking your slot — so the number shown can be slightly higher than the number of
> new rows actually in the log. Your rows are the ones that win.

## Keep the log filled (automatic)

Under Fill Day and Fill Week, **Keep the log filled: ON / OFF** is this station's auto-generate switch.

- **ON** — this computer extends the station's log on its own as the runway drops, so it never runs dry.
- **OFF** (the default) — the log is filled only when someone presses Fill Day or Fill Week.

It is **per station and local to this computer**: turning it on here does not turn it on at another studio. A
computer with it ON is the one that can become the station's **designated generator**. The button shows what is
actually stored — if a change doesn't stick, it says so in red underneath. The Health Monitor shows the same
state (read-only) and links back here.

## Clear Day and the hour ✕

**Clear Day** removes what has **not yet aired**: pending items from the next top-of-hour to the end of
the day. It never removes played, playing or missed items — those are the record of what happened —
and it never touches the hour that is on air right now, so the engine is never left with nothing to
play. The **✕** on an hour row does the same for that one hour.

After a Clear, press Fill Day to rebuild — it fills only the gaps.

## Export

**⬇ CSV**, **🖨 Print** and **📄 PDF Report** (Studio plan) export the day you are looking at.

## Editing an hour (✎ Edit)

Open an hour and press **✎ Edit**. Every change is saved to the airing log the moment you make it —
there is no Save button, and what you see after each change is what the log now holds.

- **Swap a song** — click a song row, then pick another song from the list on the right (same
  category, searchable). The row takes that song's title, artist, length and file from the Library.
- **Swap two rows' times** — drag a row and drop it onto another; the two trade places. (It is a
  swap, not a shuffle-down: nothing else in the hour moves.)
- **Remove a row** — the **✕** at the right of the row. The slot refills on the next Fill Day.
- **YOURS** on a row means you placed, moved, swapped or edited it — Fill Day will not move, replace
  or remove it.
- A yellow **⚠** under a row after a swap or move is a separation rule the placement bends (artist,
  title or song too close to another play). It tells you; it does not stop you.

**Rows that have aired or are on air cannot be changed.** They are dimmed, cannot be dragged or
deleted, and if you try, the reason is shown: *Already aired — a record, not a plan.*

## If something looks wrong

- **Every hour says "0 hours" / empty** — the day has no log yet. Press Fill Day, or Fill Week to
  build it and the six days after it at once.
- **An hour you expected is missing from the list entirely** — the Program Log lists the hours your
  shows cover, plus any hour that already has rows. An hour no show covers has no clock, so nothing
  can be scheduled in it and it is not listed. Give that hour a show under **⚙ Shows & Dayparts**,
  then Fill Day or Fill Week.
- **The wrong show name on every hour** — check the station switcher; the panel follows the active
  station.
- **Fill Day says "nothing to fill"** — the whole day has already aired.
- **An hour has no ✕** — that hour has already started; there is nothing left in it to clear.
- **An hour says "No clock for this hour"** — open **⚙ Shows & Dayparts**, give the show a clock, then
  Fill Day.
