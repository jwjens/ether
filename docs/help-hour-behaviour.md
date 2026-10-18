---
feature: hour-behaviour
title: Hour Behaviour
summary: Choose, per station, what happens when an hour runs short (nothing left before :00) or runs late (rows' times have passed).
where: Preferences → Programming → Hour Behaviour
since: 4.6.59 (1018)
audience: program director
tour: true
---

# Hour Behaviour

## What it is

Songs never run exactly to plan. Some hours come up short: everything in the log for that hour has played and
:00 is still ahead. Some hours run late: a song ran long, or the hour started late, and rows' scheduled times have
already passed. **Hour Behaviour** is where you decide what your station does in each case. It is your choice, per
station. Ether doesn't decide it for you.

## When to use it

Set it once per station when you set up the programming, and change it whenever your format calls for it.
For example, a station with paid spots may never want a spot skipped.

## Set it up (Preferences → Programming → Hour Behaviour)

1. Open **Preferences** (hamburger menu → Preferences) and pick the station at the top.
2. Scroll to **Hour Behaviour** (just below **Music Scheduling Rules**).
3. **When an hour runs short**, choose one:
   - **Fill from the hour's clock**: a song from that hour's own clock is added to the Program Log (marked as a fill)
     and plays until the next hour starts.
   - **Silence until the next hour**: nothing is added. The station stays silent until the next row in the log is due.
4. **When an hour runs late**, choose one:
   - **Catch up to the clock**: rows whose time has passed (songs *and* spots) are marked **missed** and the log
     jumps to the row for now.
   - **Catch up, keep spots**: passed songs are marked missed, but passed **spots still play**, in log order,
     before the row for now.
   - **Play everything, run late**: nothing is skipped. Every row plays in order, and the hour runs as late as it runs.
5. Your choice is saved at once ("✓ Saved") and the station uses it from the next song.

## What you'll see

- Each setting shows **Set: …** once you have chosen. Until then it shows **Not set — currently: …** in amber,
  naming what the station does today (Fill from the hour's clock / Catch up to the clock).
- In the Program Log, rows the station passed over show as **missed**. A fill shows as a fill row.

## Good to know

- A row refused at playout (it would break a separation rule) is still replaced by a song for that same slot,
  whichever short-hour setting you choose.
- Outside your shows' hours there is no programming, so silence there is normal and not reported.
- "Catch up, keep spots" only plays spots after the last row that aired, so starting automation late never
  replays hours of old breaks.
