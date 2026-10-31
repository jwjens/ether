---
feature: music-scheduling-rules
title: Music Scheduling Rules (STRICT and SOFT)
summary: How long before an artist, song or title can play again, how many songs in a row from one category, and what happens when no song can meet a rule.
where: Settings → Programming → Music Scheduling Rules
since: 4.6.70
audience: operator
tour: false
---

# Music Scheduling Rules

## What it is

These rules decide which song Generate puts in each music slot:

- **Same artist plays again after** — minutes between songs by the same artist.
- **Same song plays again after** — minutes before the same recording repeats.
- **Same title (different artist) after** — minutes between songs with the same title and the same length.
- **Max songs in a row from same category** — how many songs from one category can follow each other.

Each rule can be turned on or off, and set to **STRICT** or **SOFT**.

## STRICT and SOFT

When a slot is filled, Ether looks for a song in the slot's category that meets every rule (then in the station's
fallback category, if you named one). If none does:

1. **SOFT rules are relaxed first.** The song is chosen from those that meet every STRICT rule. The log row says which
   SOFT rule was bent.
2. **A STRICT rule is broken only as the last resort**, when no song can meet it. The slot then gets the category's least
   recently played song. This is marked on the log row and listed in **Health Monitor**.

While playing, Ether also refuses a song that would break a STRICT rule against what has really aired. SOFT rules are
only used when the log is made.

## Max songs in a row

When a slot would make one song too many from the same category:

- **STRICT**: the slot takes its song from the next different category in the clock, and the row says so. If there is
  no other category, or it has no song, the rule is broken as the last resort, marked on the row and in Health.
- **SOFT**: the slot keeps its category and the row says the rule was broken.

Only songs count; spots and other elements between songs don't end a run. The count starts again at each Generate.

## Related

- **Program Log** and **Health Monitor**: where broken rules are shown.
- **Rotation goals** (`docs/help-rotation-goals.md`).
