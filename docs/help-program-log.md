---
feature: program-log
title: "The Program Log"
summary: One day of the station's real log — what aired, what is on air, what is coming — with Fill Day, Clear Day and CSV / Print / PDF export.
where: ≡ menu → Program Log, or Schedule → Program Log
since: unreleased (branch log-reader-flip, after 4.6.45)
audience: operator
tour: true
---

# The Program Log

The Program Log shows **one day of the log the station actually airs from** — the same log the
engine reads and the Calendar edits. Pick a day on the small calendar at the left; every hour of the
day is a row you can open.

## Reading the day

- **The left column of the mini calendar** shows a green dot under every day this station has a log for.
- **TODAY'S SHOWS** lists this station's shows and how many of their hours have rows.
- **Each hour row** names the show and clock for that hour, how many items it holds and how long they
  run. Open it to see the items.
- **Time** — the first column is the scheduled time, `HH:MM:SS`. When an item has aired, its **actual**
  air time appears underneath in green. That is the as-run receipt.
- **Status** — `pending` (not yet), **`playing`** (on air now, highlighted), `played` (aired, green),
  `missed` (a spot or item that did not air, red).

The summary at the top — *N of 24 hours scheduled · total programming* — is counted from these rows.

## Fill Day

**Fill Day** builds the log for the selected day from your shows and clocks — the same generator the
Calendar uses. It fills **from the next top-of-hour to the end of the day**:

- Hours that have already started are never touched. What aired is a record, not a plan.
- Items you placed by hand (they wear the YOURS badge in the Calendar) survive a Fill.
- Filling a day that has already fully aired does nothing and says so.

Fill Day acts on the **station you are switched into**. Switch stations first if you mean another one.

**Fill Day is the only fill.** There is no per-hour generate: to rebuild part of a day, clear the hours
you want rebuilt (the ✕ on each hour row) and press Fill Day — it fills the gaps and leaves everything
else in place.

## Clear Day and the hour ✕

**Clear Day** removes what has **not yet aired**: pending items from the next top-of-hour to the end of
the day. It never removes played, playing or missed items — those are the record of what happened —
and it never touches the hour that is on air right now, so the engine is never left with nothing to
play. The **✕** on an hour row does the same for that one hour.

After a Clear, press Fill Day to rebuild — it fills only the gaps.

## Export

**⬇ CSV**, **🖨 Print** and **📄 PDF Report** (Studio plan) export the day you are looking at.

## What is not wired yet

Inside an hour's **✎ Edit** window, swapping a song and dragging rows do **not** yet change the airing
log — those two actions still write to an old table nothing reads. Until the next update, make those
edits in the **Calendar** (drag, pin, remove), which writes the real log. Everything else on this panel
reads and writes the airing log.

## If something looks wrong

- **Every hour says "0 hours" / empty** — the day has no log yet. Press Fill Day.
- **The wrong show name on every hour** — check the station switcher; the panel follows the active
  station.
- **Fill Day says "nothing to fill"** — the whole day has already aired.
- **An hour has no ✕** — that hour has already started; there is nothing left in it to clear.
- **An hour says "No clock for this hour"** — open **⚙ Shows & Dayparts**, give the show a clock, then
  Fill Day.
