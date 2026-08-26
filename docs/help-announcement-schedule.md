---
feature: announcement-schedule
title: Scheduling Announcements
summary: Build a list of announcements and times for each day — check the days that share a lineup, or give a single date its own list.
where: Announcements panel → Schedule
since: 4.4.x
audience: operator
tour: true
---

# Scheduling Announcements

## What it is

An announcement is now just **the audio** — a name and a file. **When it plays is separate**, and one
announcement can play as many times, on as many days, as you need.

That's the whole idea. The same "we're closing" chime can play at 8:45 on a Friday and 7:45 on a
Sunday without you making two copies of it.

You build a **list** for each day: *this announcement at this time*, then another, then another.

## When to use it

Any timed announcement — closing warnings, park info, legal IDs, event reminders.

## Two ways to schedule

### 1. By weekday — the normal week

This is your repeating pattern.

1. Open **Announcements** → **Schedule — by weekday**.
2. **Check the day or days you want.** Days that run the *same* lineup can be checked together —
   check **Fri** and **Sat** if the weekend runs the same announcements. Days that differ are set
   separately.
3. Under the checkboxes you'll see that group's list. Press **＋ Add another** to add a line.
4. On each line, pick the announcement and say when:
   - **at a set time** — type an exact time, including seconds if you want them (`20:45:30`).
   - **before closing** — 30, 15, 10, 5, 1 minutes, or right at closing. This uses **that day's own
     closing time**, so a day you close earlier announces earlier automatically.
5. Press **✕** on a line to remove it.

There's nothing to save — every change writes immediately.

**A typical closing set** (check the days it applies to, then three lines):

| Announcement | When |
|---|---|
| Park closes in 30 minutes | 30 minutes before closing |
| Closing in 15 minutes | 15 minutes before closing |
| We are now closed | At closing time |

### 2. By date — a one-off

For a holiday, a special event, or any single date that runs something different.

1. Scroll to the month calendar under **Closing time — specific dates**.
2. **Click the date.** Its page opens underneath, showing everything special about that date.
3. Under **Announcements on this date**, press **＋ Add another** and build that date's list the same
   way.

**A date with its own list runs THAT list INSTEAD OF the usual weekday one.** If Oct 31 has three
announcements of its own, the normal Friday list does not play that day. The panel says which is in
force, so you never have to work it out.

Remove all of a date's entries and it goes back to following its weekday.

## How to read it

- In the announcements list, the **Scheduled** column summarises where each one plays —
  `MTWTF 5:30 PM`, or `3 dates`, or **not scheduled** in amber.
- **"not scheduled" means it will never fire.** An announcement with no entry has no time, so nothing
  plays it. That's the first thing to check if something didn't go to air.
- On the calendar, a date showing **♪3** has three announcements of its own. A date showing a time has
  its own closing time. A date can have both, one, or neither.

## Worth knowing

- **Checking days is how you pick which list you're editing.** Check **Fri+Sat** and you're editing
  the list that plays on both. Check **Fri** alone and you're editing the Friday-only list — a
  different list. If other day groups also cover the day you've checked, the panel says so
  underneath, so nothing is hidden from you.
- **Deleting an announcement removes it from every schedule.** You'll be told how many entries go
  with it before it happens.
- **Seconds are real.** `20:45:30` fires at 20:45:30, not somewhere in that minute.
- **Whether anyone hears it is still the board's call.** The schedule decides *when* an announcement
  fires onto the Announcement channel. The fader and channel ON decide whether it reaches air. If a
  scheduled announcement didn't go out, check the channel before you check the schedule.
- **A day with no closing time fires no "before closing" announcements.** Nothing is guessed. Set the
  weekday closing times just above the calendar, or give a single date its own.
- **It syncs.** Your other machines running this station get the same schedule.

## See also

- **Closing Times for Specific Dates** — `help-date-closing-times.md`, the other half of that
  calendar.
