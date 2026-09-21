---
feature: imaging
title: Imaging
summary: The home for everything that fires between songs — the cuts, the pools they sit in, what is assigned where, and what will fire ahead of you.
where: Hamburger menu → Imaging (or bottom bar → SWEEPERS → OPEN IMAGING)
since: 4.6.13
audience: operator
tour: true
---

# Imaging

## What it is

**Imaging** is everything short that goes between the songs — station IDs, sweepers, stingers, the
"you're listening to…" drops, and announcements. It never sits on a deck and never interrupts the music:
it fires on the **seam** between two songs.

Until now the only way in was a push-up at the bottom of the screen. That push-up still works and is
unchanged — but IMAGING is now a place of its own in the menu, where you can see and set all of it in
one screen, including two things you could not see anywhere before: every cut in one list, and what is
about to fire.

## How to get there

- **Hamburger menu → Imaging.** This is the main door.
- **Bottom bar → SWEEPERS → OPEN IMAGING.** The push-up is the quick way in mid-show; this button
  walks you from it to the full picture.

## The five views

**RACK** — every imaging cut in the library, one row each: its name, its type (SWEEPER or
ANNOUNCEMENT), its length, and which pool it belongs to. If a length shows a dash, that cut has no
duration recorded — the row is incomplete, not broken, and it will still play.

Every cut is available to **every station** — one shared library, the same as your songs. The POOL
column shows only *this* station's pool; a dash there means the cut is not in one of them, not that it
is unavailable.

**POOLS** — the groups a category can draw from. A pool is how you get variety: assign a category to a
pool of ten IDs and it rotates through them instead of playing the same one every time.

A cut can be in **several pools at once**, including pools belonging to different stations — the
library is shared, and adding a cut to one pool takes it out of nothing.

**ASSIGNMENTS** — which music category gets which imaging, the LEAD (how many seconds before the next
song starts the cut fires), and the ACTIVE HOURS it is allowed in. This is the grid that decides what
actually happens.

**ON DECK** — what will fire ahead of you, in log order, with the **specific cut named** against the
song it introduces. This is the view to check before a shift: it tells you what the audience is about
to hear, not what might happen.

**RULES** — where segue bans will live. **Nothing is configured and bans are not built yet.** The view
says so rather than showing controls that do nothing.

## What you can change here

**POOLS and ASSIGNMENTS are live** — create and name pools, put cuts in them, and set each category's
imaging, LEAD and active hours, right here.

The **SWEEPERS push-up** at the bottom bar does the same job and is unchanged. Mid-show it is faster
than leaving the mixer, so use whichever is closer to hand: both are the same editor, so they can never
disagree about what is set.

**RACK, ON DECK and RULES show no controls at all** — not greyed-out ones. What they will eventually let
you do (swap a placement, write a ban) is not built, so there is nothing there to press.

**Song timing is not set here.** A song's intro is marked where songs are edited: right-click the song
anywhere in the Library and choose **Open in Cue Editor**, then drag **INTRO END** to the first word and
Save. That is the mark imaging is measured against — see "How imaging fits a song" below.

## If ON DECK is empty

It tells you which of three things is true, because they need different fixes:

- **"Nothing is scheduled ahead of now."** There is no generated log. Go to the **Program Log** and
  press Fill Day.
- **"N elements scheduled, no imaging placed."** The log exists but carries no imaging. The view names
  the reason — usually that no music category has an overlay assigned and there is no fallback pool.
  Fix it in ASSIGNMENTS, then Generate again.
- **A list.** Imaging is placed and this is what will fire.

Changing an assignment does **not** rewrite a log that is already generated. Generate the day again to
see it take effect.

## Words you will see

- **Cut** — one piece of imaging audio.
- **Pool** — a group of cuts a category rotates through.
- **Assignment** — the link from a music category to a cut or a pool.
- **LEAD** — how many seconds before the next song starts the cut fires, so it plays over the tail of
  the song that is ending.
- **Active hours** — the hours of the day an assignment is allowed to fire in.

- **Post** — where a song's vocal starts. It is the **INTRO END** marker in the cue editor, and it is
  how much room imaging has before the singing.
- **Ban** — a rule saying a cut may not go somewhere. Not built yet.

## How imaging fits a song

When a music category is set to **AUTO-POST**, the song decides the timing and the sweeper either fits
or is not chosen:

1. The song's **post** (INTRO END in the cue editor) says how much room there is before the vocal.
2. Only cuts **shorter than that room** are candidates. A cut that would run past the vocal is never
   selected.
3. The chosen cut is fired so its last moment lands **on** the first word.

A song you have not marked keeps the fixed **LEAD** behaviour, unchanged — so marking is worth doing one
song at a time, starting with the ones that play most, and nothing breaks while the rest wait.

## Related

- **Sweepers** (`help-sweepers.md`) — the push-up editor, in detail.
- **Categories** — the music categories that assignments hang off.
- **Program Log** — where the log is filled.
