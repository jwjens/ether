---
feature: announcement-schedule
title: Scheduling Announcements
summary: Pick the days (or a date) on the left, then build that selection's list of announcements and times on the right.
where: Announcements panel → Schedule
since: 4.4.x
audience: operator
tour: true
---

# Scheduling Announcements

## What it is

An announcement is just **the audio** — a name and a file, uploaded in the list at the bottom of the
page. **When it plays is separate**, and one announcement can play as many times, on as many days, as
you need.

That's the whole idea. The same "we're closing" chime can play at 8:45 on a Friday and 7:45 on a
Sunday without you making two copies of it.

**One rule: nothing scheduled means nothing plays.** There is no other condition to remember.

## The layout

**Left — what you're scheduling.** The days across the top, and a calendar underneath for a single
date.

**Right — that selection's schedule.** A **＋ Add Announcement** button and a list of lines. Each line
is one announcement and one time.

The right column always says in words what it's editing, so you never have to work it out.

## Schedule by day

1. Open **Announcements**. Along the top of the left column: **S M T W T F S**.
2. **Click the day or days you want.** Days that run the *same* announcements can be selected
   together — click **F** and **S** if the weekend runs the same list. Days that differ are set
   separately.
3. On the right, press **＋ Add Announcement**. A line appears.
4. Pick the announcement from the dropdown, and set its time. Seconds are real — `20:45:30` fires at
   20:45:30, not somewhere in that minute.
5. Press **＋ Add Announcement** again for as many as you want.
6. Press **✕** on a line to remove it.

Nothing to save — every change writes immediately.

**A typical closing set** — select the days, then three lines:

| Announcement | Time |
|---|---|
| Park closes in 30 minutes | 8:30:00 PM |
| Closing in 15 minutes | 8:45:00 PM |
| We are now closed | 9:00:00 PM |

## Schedule a specific date

For a holiday, a special event, or any single date that runs something different.

1. In the calendar on the left, use **‹** and **›** to find the month, then **click the date**.
2. The right column switches to that date. Build its list exactly the same way.

**A date with its own list runs THAT list instead of the usual weekday one.** If Oct 31 has three
announcements of its own, the normal Friday list does not play that day. The right column says which
is in force.

Remove all of a date's lines and it goes back to following its weekday.

Click any day letter to go back to editing the weekly schedule.

## How to read it

- On the calendar, a date showing **♪3** has three announcements of its own.
- In the announcements list at the bottom, the **Scheduled** column summarises where each one plays —
  `MTWTF 5:30 PM`, or `3 dates`, or **not scheduled** in amber.
- **"not scheduled" means it will never fire.** That's the first thing to check if something didn't
  go to air.
- A time box outlined in **amber** means that line has no time yet and won't play. Type one.

## Worth knowing

- **Selecting days picks which list you're editing.** Select **F+S** and you're editing the list that
  plays on both. Select **F** alone and you're editing the Friday-only list — a different list. If
  other day groups also cover the day you've selected, the panel says so underneath, so nothing is
  hidden from you.
- **Deleting an announcement removes it from every schedule.** You'll be told how many lines go with
  it first.
- **Whether anyone hears it is still the board's call.** The schedule decides *when* an announcement
  fires onto the Announcement channel. The fader and channel ON decide whether it reaches air. If a
  scheduled announcement didn't go out, check the channel before you check the schedule.
- **Ducking is set per station** in Preferences → Ducker, and applies to every source. There is no
  per-announcement duck setting.
- **It syncs.** Your other machines running this station get the same schedule.
