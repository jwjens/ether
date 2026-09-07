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

Until now the only way in was a push-up at the bottom of the screen. That push-up is still where you
*edit* imaging — but IMAGING is now a place of its own in the menu, where you can see all of it at once,
including two things you could not see anywhere before: every cut in one list, and what is about to fire.

## How to get there

- **Hamburger menu → Imaging.** This is the main door.
- **Bottom bar → SWEEPERS → OPEN IMAGING.** The push-up is the editor; this button walks you from
  editing to the full picture.

## The five views

**RACK** — every imaging cut in the library, one row each: its name, its type (SWEEPER or
ANNOUNCEMENT), its length, and which pool it belongs to. If a length shows a dash, that cut has no
duration recorded — the row is incomplete, not broken, and it will still play.

**POOLS** — the groups a category can draw from. A pool is how you get variety: assign a category to a
pool of ten IDs and it rotates through them instead of playing the same one every time.

**ASSIGNMENTS** — which music category gets which imaging, the LEAD (how many seconds before the next
song starts the cut fires), and the ACTIVE HOURS it is allowed in. This is the grid that decides what
actually happens.

**ON DECK** — what will fire ahead of you, in log order, with the **specific cut named** against the
song it introduces. This is the view to check before a shift: it tells you what the audience is about
to hear, not what might happen.

**RULES** — where segue bans will live. **Nothing is configured and bans are not built yet.** The view
says so rather than showing controls that do nothing.

## What you can change here

**Nothing, in this release.** IMAGING is read-only: it shows you what is set, and every panel that lets
you change something says where that is done. Editing lives in the **SWEEPERS push-up** at the bottom
bar — create and name pools there, assign cuts to pools, set each category's imaging, LEAD and active
hours.

This is deliberate. There is one editor, so two screens can never disagree about what is set.

## If ON DECK is empty

It tells you which of three things is true, because they need different fixes:

- **"Nothing is scheduled ahead of now."** There is no generated log. Go to the **Calendar** and
  generate a day.
- **"N elements scheduled, no imaging placed."** The log exists but carries no imaging. The view names
  the reason — usually that no music category has an overlay assigned and there is no fallback pool.
  Fix it in the push-up, then Generate again.
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

Three more words belong to imaging and are **not built yet** — you will see them in later releases:
**post** (where a song's vocal starts), **dry** (the part of a cut with no music under it), and **ban**
(a rule saying a cut may not go somewhere).

## Related

- **Sweepers** (`help-sweepers.md`) — the push-up editor, in detail.
- **Categories** — the music categories that assignments hang off.
- **Calendar** — where the log is generated.
