---
feature: jingles
title: Jingles
summary: Station IDs, stingers and sweepers that rotate on their own and fire as an overlay on the seam between songs.
where: Settings → Programming → Jingles
since: 4.4.55
audience: operator
tour: true
---

# Jingles

> **Help corpus template.** This is the first entry in EtherCast's built-in help. Every feature ships with a
> `docs/help/<feature>.md` written this way — plain language, step-by-step, no jargon — because the Iris tour
> layer reads these verbatim to walk an operator through a feature. Keep the section order below.

## What it is

A **jingle** is a short piece of imaging — a station ID, stinger, sweeper, or "you're listening to…" drop.
In EtherCast, jingles don't sit on a deck and they don't interrupt the music. They **rotate on their own**
(least-recently-played, so the same one doesn't repeat too soon) and **fire as an overlay** right on the
seam between two songs: the jingle rides over the tail of the outgoing song and the head of the incoming one.
Nothing stops, nothing skips.

## When to use it

Use jingles for anything you want to hear *between* songs on a regular cadence — top-of-set IDs, quick
sweepers, seasonal drops. If it's a full commercial or a scheduled break, that's a **Spot**, not a jingle.

## Set it up (3 steps)

You'll find everything under **Settings → Programming → Jingles**. (On the live screen, the **JINGLES**
fader also shows a **"Set up jingles →"** link when nothing is set up yet — click it to jump here.)

1. **Create a pool.** A pool is a group of jingles that rotate together — for example "Station IDs". Type a
   name and click **Add pool**.
2. **Tag your jingles.** Go to the **Library**, right-click a sting/ID/sweeper, and choose
   **"Mark as Jingle (JIN)"**. Every tagged jingle then shows up in the list at the bottom of the Jingles
   page. Pick a **pool** for each one from the dropdown.
3. **Set the cadence and timing** on the pool, then **Generate** your schedule (Calendar → Generate). That's
   when jingles get placed onto the song seams. On air, they fire automatically.

## The three numbers on each pool

- **Lead-in (seconds)** — how far *before* the outgoing song ends the jingle starts. Default **5s**.
- **Underlap (seconds)** — how far *before* the jingle ends the next song starts. Default **2s**.
- **Every N** — cadence: fire one jingle from this pool every **N** song transitions. Default **4**.

Bigger lead-in = the jingle starts earlier over the song's tail. Bigger underlap = the next song comes in
sooner under the jingle's tail. Tune by ear on air.

## How it behaves on air

- On the deck strip, the deck the jingle is bridging shows a small indicator: **white = armed** (a jingle is
  lined up for the next transition), **yellow = firing** (the jingle is actually playing).
- The **Health Monitor** shows the same armed/firing state per station.
- Jingles are logged in Play History but are **kept out of your music reports and rotation math** — they never
  count as a "song play" or block an artist.

## If you don't see any jingles

- **No pool yet?** The feature does nothing until a pool exists — go back to step 1.
- **No tagged jingles?** Nothing was marked JIN in the Library (step 2), or nothing is assigned to a pool.
- **Cadence too slow?** "Every N" of 8 on a short show may not come around — lower N.
- **Did you Generate?** Jingles are placed when you Generate the schedule. Regenerate after changing a pool.
- Jingles fire in normal (daemon) playout. If a jingle is armed but the song is skipped or the hour hard-cuts
  at the top of the hour, the jingle cancels itself cleanly and re-arms for the next seam — that's expected.

## Related

- **Spots** — scheduled commercials/breaks (different from jingles).
- **Clocks / Generate** — where the schedule (and jingle placements) are built.
