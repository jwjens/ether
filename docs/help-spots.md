---
feature: spots
title: Spots & Promos
summary: Commercials, promos, PSAs and sponsorships — scheduled into timed breaks on your clocks, kept out of music rotation and reporting.
where: Bottom bar → SPOTS · Library right-click → Mark as Spot
since: 4.4.79
audience: operator
tour: true
---

# Spots & Promos

## What it is

**Spots** are your non-music, scheduled audio — **commercials, promos, PSAs, sponsorships**. Unlike a jingle
(which fires as an overlay on a song seam), a spot is a full element that plays in a **timed break** on your
clock: "a stop set at :20 past the hour, three spots." Spots are kept **out of music rotation** and out of
music reporting — they're their own content class (amber **SPOT** badge on a library track).

The **Spots & Promos** panel is the traffic manager: each spot carries a **category** (e.g. Local Sponsors,
Top-of-Hour IDs), a **type** (commercial / promo / PSA / sponsorship), and optional **flight dates**, a
**max-plays-per-day** cap, and an **advertiser**. Clocks pull from spot categories at the break times you set.

## When to use it

Anything that's a scheduled commercial break. Short imaging that rides *over* the music (station IDs,
stingers, sweepers) is **Jingles**, not this.

## Two ways in

### Fast path — Mark a library track as a Spot
The quickest way to turn an existing audio file into a spot:

1. Open the **Library** and **right-click** the track.
2. Choose **Mark as Spot (SPOT)**.
3. In the small dialog, pick a **category** (or type a new one) and a **type** (Commercial by default), then
   **Mark as Spot**.
4. The track gets an amber **SPOT** badge, leaves music rotation, and a spot record is created carrying its
   title and file. Fine-tune dates, caps and advertiser later in the panel.

*(To undo: right-click → **Unmark Spot (→ Music)** returns it to music rotation.)*

### Full manager — the Spots & Promos panel
Open **SPOTS** in the bottom bar (or **Library → Spots & Promos** in the top menu):

1. **Import** your commercials/promos (single files or a folder) — or use the Mark-as-Spot fast path above.
2. Organize them into **spot categories** (create categories like *Local Sponsors* or *Station Promos*).
3. Set each spot's **type**, **advertiser**, **flight dates** (start/end), and **max plays per day**.

## Scheduling the breaks (on your clocks)

Spots don't rotate like music — they air in **timed breaks** you place on a clock:

1. Open **CLOCKS**.
2. On a clock, use the **Timed Spot Breaks** grid: set a break at a minute past the hour (:00, :20, :40…),
   choose which **spot category** it pulls from, and how many spots it plays.
3. Every hour that clock runs, the break airs at that time. Music fills the time around the breaks
   automatically — you don't count songs to fill the hour.

## Notes

- A spot at the **top of the hour** airs exactly at :00; breaks at other minutes drop at the nearest song
  boundary so a song is never cut off mid-play.
- Spots are excluded from music-rotation separation and from the music/plays reporting — they have their own
  play logging for advertiser affidavits.
