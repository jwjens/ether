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

**Spots** are your non-music, scheduled audio — **commercials, promos, PSAs, sponsorships**. Unlike a sweeper
(which fires as an overlay on a song seam), a spot is a full element that plays in a **timed break** on your
clock: "a stop set at :20 past the hour, three spots." Spots are kept **out of music rotation** and out of
music reporting — they're their own content class (amber **SPOT** badge on a library track).

The **Spots & Promos** panel is the traffic manager: each spot carries a **category** (e.g. Local Sponsors,
Top-of-Hour IDs), a **type** (commercial / promo / PSA / sponsorship), and optional **flight dates**, a
**max-plays-per-day** cap, and an **advertiser**. Clocks pull from spot categories at the break times you set.

## When to use it

Anything that's a scheduled commercial break. Short imaging that rides *over* the music (station IDs,
stingers, sweepers) is **Sweepers**, not this.

## Two ways in

### Fast path — Mark a library track as a Spot
The quickest way to turn an existing audio file into a spot:

1. Open the **Library** and **right-click** the track.
2. Choose **Mark as Spot (SPOT)**.
3. In the small dialog, pick a **category** (or type a new one — this is **required**) and a **type**
   (Commercial by default), then **Mark as Spot**. A spot with no category can't be pulled by a break, so
   the dialog won't let you finish until one is set.
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

## Will it air? (the amber cues)

- In the **Spots & Promos** list, any spot that a break **can't pull** wears an amber **⚠ WON'T AIR** flag —
  it's either **inactive** or has **no category**. Open it (Edit) and set an active status + a category to fix.
  This is your at-a-glance check that every spot is schedulable.
- If a **timed break** on your active clock pulls a category with **no eligible spots**, the panel shows an
  amber banner naming each empty break (":20 → Sponsors — add or activate a spot"). If a break points at
  *another station's* category (a leftover after splitting stations), the banner says so and sends you to
  **Clocks → Timed Spot Breaks** to re-pick. The clock break editor shows the same **⚠ 0 eligible spots**
  warning inline, and each category in its dropdown shows its eligible count. A break that would air silence
  is never a silent fact.
- Once a spot is scheduled, its rows render **gold/amber** everywhere the log shows — in the **calendar**
  (a **SPOT** chip + amber row) and in the **live Up Next queue** (amber left-edge + **SPOT** chip) — so a
  commercial break is instantly distinct from music at a glance.

## How spots air (exclusive program, clean edges)

- A spot is **exclusive program content** — it owns its slot like a song. At a break the spot plays **alone**:
  clean start, clean end, **no music overlap in or out** and **no sweeper over it** (imaging introduces music,
  never a commercial). The next song follows at the spot's natural end.
- Spot length is read from the **actual audio file** on import / Mark-as-Spot (not a guessed default), so the
  log and the break timing are accurate. Existing spots self-repair their length the next time the panel loads.
- **Amber deck flash:** while a deck is holding a spot — from the moment it loads until it finishes airing —
  that deck card pulses an amber/gold frame, readable across the room. Songs never flash; this is separate
  from the sweeper indicator (the white/yellow line under a deck).

## Taking a spot off the air

A campaign ends, or an advertiser pulls a commercial, and you need it to stop airing. Two ways, and
they now do the same thing:

- **Delete it** — the trash icon on its row.
- **Switch it inactive** — open the spot and turn **Active** off. Use this when the advertiser may be
  back; the spot keeps its artwork, category and play history and can be switched on again later.

Either way Ether does **two** things, and the second one is the one that matters:

1. It stops the spot being placed in any future log.
2. **It pulls the spot out of the log that is already written.**

That second step matters because the airing log is generated ahead of time — often a full day or more.
Without it, a spot you deleted this morning would keep airing all day from the log made last night.

Ether tells you what it pulled: *"Deleted ‘Opportunity Village’ — 14 future airings pulled from the log"*.
If it says **no future airings were pulled** and you can still hear the spot, that is worth reporting —
the message is there so the two can never quietly disagree.

If the delete fails for any reason, the panel says so and the spot stays on screen. It never closes as
though it worked.

### What is deliberately NOT removed

- **Anything that already aired.** The play log is your advertiser affidavit — proof the commercial ran.
  Deleting the spot never erases a minute of it.
- **The spot playing right now.** If it is on air as you delete it, it finishes. Ether never yanks audio
  off the transmitter mid-play.
- **Rows you placed by hand.** Anything you dropped into the log yourself stays yours.

### Across two computers

If you run more than one Ether machine on the same account, deleting or deactivating a spot on one of
them takes it off the air on **both** — each machine pulls the spot from its own log as the change
arrives. There is nothing to repeat on the second machine.

### The one case you still handle by hand

A spot already **loaded on a deck**, or scheduled inside the **current hour**, may air once more. If you
need it gone immediately, remove that entry from the log grid in the calendar, or eject the deck.

## Notes

- A spot at the **top of the hour** airs exactly at :00; breaks at other minutes drop at the nearest song
  boundary so a song is never cut off mid-play.
- Spots are excluded from music-rotation separation and from the music/plays reporting — they have their own
  play logging for advertiser affidavits.
