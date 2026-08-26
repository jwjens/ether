---
feature: date-closing-times
title: Closing Times for Specific Dates
summary: Set a different closing time for a holiday, special event or seasonal date — closing-relative announcements shift with it automatically.
where: Announcements panel → "Closing time — specific dates" calendar
since: 4.4.x
audience: operator
tour: true
---

# Closing Times for Specific Dates

## What it is

Your station has **seven closing times**, one for each day of the week — that's the normal pattern, and
it's the row of boxes just above this calendar.

But real places don't run on a perfect weekly loop. You close early on Christmas Eve. You stay open late
for a Halloween event. You shut completely on Thanksgiving. **This calendar is where you say so** — pick a
date, give it its own closing time, and that date stops following its weekday.

Any announcement set to fire **before closing** ("30 minutes before closing", "at closing") uses that
date's time automatically. You don't touch the announcements at all — you change the closing time and
they move with it.

## When to use it

Any single date that closes at a different time from its usual weekday. Holidays, special events,
seasonal hours, a one-off early close for staff training.

If your hours change **permanently** — you now close at 20:00 every Tuesday from here on — change the
**weekday** box above instead. This calendar is for exceptions, not for a new normal.

## Set it up (Announcements panel)

1. Open **Announcements**. Under the seven weekday closing times you'll see
   **"Closing time — specific dates"** with a month calendar.
2. Use **‹** and **›** to move between months. Today has a highlighted outline.
3. **Click the date** you want to change. A row appears underneath showing what that date currently
   does and where that comes from — for example *"closes at 9:00 PM — Tuesday default"*.
4. Pick what you want:

   - **Set for this date** — type a time (hours, minutes **and seconds**) and press it. That date now
     closes at that time. The date shows the time on the calendar in blue.
   - **No closing time this date** — the date has no closing time at all, so **no closing-relative
     announcement fires that day**. Use this when you're closed. The date shows **none** in amber.
   - **Use \[weekday] default** — removes your change and the date goes back to following its weekday.
     Only appears on dates you've already set.

That's it. There's nothing to save — each button writes immediately.

## How to read the calendar

| What you see | What it means |
|---|---|
| A plain date | Follows its weekday closing time |
| A date with a **blue time** | Closes at that time, just this date |
| A date with **none** in amber | No closing time — nothing closing-relative fires |
| Outlined date | Today |

The line under the calendar always spells out what the selected date actually does, so you never have
to work it out yourself.

## Which time wins

Simple order, top to bottom:

1. **A date you've set here** — always wins.
2. **The weekday closing time** above — used for every date you haven't set.
3. **Nothing set** — then there's no closing time, and closing-relative announcements don't fire.

## Worth knowing

- **"No closing time" is not the same as removing the date.** *No closing time this date* means "we're
  closed, nothing closing-relative should fire." *Use \[weekday] default* means "forget I said
  anything, treat it like a normal Tuesday." Two different buttons for two different intentions.
- **Only closing-relative announcements are affected.** An announcement set to a fixed clock time
  ("play at 10:00:00") still fires on its own schedule, because that's what a fixed time means. If you
  don't want it on a closed date, switch it off or take that day out of its Active Days.
- **Whether anyone hears it is still the board's call.** As with every announcement, this decides
  *when* something fires onto the Announcement channel. The fader and channel ON decide whether it
  goes to air.
- **Seconds are supported** — 20:45:30 is a real closing time, and a "15 minutes before" announcement
  off it fires at 20:30:30.
- **Set dates as far ahead as you like.** A whole year of holidays is fine.
- **Past dates stay.** They're the record of what happened, and nothing clears them automatically.
  Move back through the months to see them.
- **It syncs.** Set a date on one machine and your other machines running this station get it too,
  like the rest of your station's settings.
