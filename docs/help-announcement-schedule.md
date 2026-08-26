---
feature: announcement-schedule
title: Scheduling Announcements
summary: Pick the dates on the calendar — they add up — then build that selection's list of announcements and times.
where: Announcements panel → Schedule
since: 4.4.x
audience: operator
tour: true
---

# Scheduling Announcements

## What it is

An announcement is just **the audio** — a name and a file, uploaded in the list at the bottom of the
page. **When it plays is separate.**

Everything is scheduled against **real calendar dates**. There is no "every Wednesday" — you pick the
actual dates and give them a list. What plays on a day is exactly what you put on that day.

**One rule: nothing scheduled means nothing plays.**

## The layout

**Left — the calendar.** Multi-select the dates you're scheduling. **‹ ›** move between months.

**Right — the schedule for those dates.** A **＋ Add Announcement** button and a list of lines. Each
line is one announcement and one time.

## Build a schedule

1. Open **Announcements**. Today is selected on the calendar to start with.
2. **Click each date you want — they add up.** Click Oct 15, Oct 16, Oct 22 and all three stay
   selected. Move to another month with **‹ ›** and keep picking; your earlier dates stay selected.
   - To take a whole run quickly, click a **weekday letter** at the top of the calendar — that selects
     every one of them in the visible month (every Friday in October, say).
   - **Clear N** at the bottom drops the whole selection.
3. On the right, press **＋ Add Announcement**. The line is added to **every selected date**.
4. Pick the announcement from the dropdown and set its time. Type the digits normally — `10:15:00`.
   Seconds are real: `20:45:30` fires at 20:45:30, not somewhere in that minute.
5. Press **＋ Add Announcement** again for as many as you want per date.
6. Press **✕** to remove that line from all the selected dates.

Nothing to save — every change writes immediately.

**A typical closing set** — select your event dates, then three lines:

| Announcement | Time |
|---|---|
| Park closes in 30 minutes | 8:30:00 PM |
| Closing in 15 minutes | 8:45:00 PM |
| We are now closed | 9:00:00 PM |

## How to read it

- A date on the calendar showing **♪3** has three announcements on it.
- Each line shows a **date count** — `3 dates` means that announcement-and-time exists on all three
  dates you have selected.
- **`2/5 dates` in amber** means the line only covers 2 of your 5 selected dates. Editing it changes
  those 2. Add it again with all 5 selected if you want it everywhere.
- In the announcements list at the bottom, the **Scheduled** column shows the next date each one
  plays. **not scheduled** in amber means it will never fire — the first thing to check if something
  didn't go to air.

## Worth knowing

- **A line added to several dates is several entries.** The list groups them back into one line so
  you edit what you built, and the date count tells you how many it really covers.
- **Deleting an announcement removes it from every schedule.** You'll be told how many lines go with
  it first.
- **Whether anyone hears it is still the board's call.** The schedule decides *when* an announcement
  fires onto the Announcement channel. The fader and channel ON decide whether it reaches air. If a
  scheduled announcement didn't go out, check the channel before you check the schedule.
- **Ducking is set per station** in Preferences → Ducker, and applies to every source. There is no
  per-announcement duck setting.
- **It syncs.** Your other machines running this station get the same schedule.
