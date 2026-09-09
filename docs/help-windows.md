---
feature: windows
title: Windows — everything opens beside the live screen
summary: Every destination in the ≡ menu now opens in its own window instead of covering the mixer, so you never lose sight of what is on air.
where: ≡ (top-left) → NAVIGATE
since: 4.6.20
audience: operator
tour: true
---

# Windows — everything opens beside the live screen

## What it is

The **≡ menu** used to have two lists. The top one, NAVIGATE, **replaced the live screen**: click Library
and the mixer went away. The bottom one, WINDOWS, opened the same places in **their own window**, beside
the mixer. Same destinations, two different behaviours, and the one you got depended on which list you
happened to use.

There is now **one list**, and **everything on it opens in its own window**. Clicking Library, Schedule,
Imaging, the Program Log, Calendar, Play Log, Carts, Decks — any of them — leaves the live screen exactly
where it is. Decks keep spinning, levels keep moving, ON AIR stays in front of you.

**Why it works this way:** you should never have to close something to see what is playing.

## When to use it

Any time you need to work on something while a show is on. That is most of the time.

## Open a window (≡ → NAVIGATE)

1. Click the **≡** button, top-left.
2. Click any entry in the list — **Library**, **Schedule**, **Imaging**, **Program Log**, **Calendar**,
   **Play Log**, **Schedule Manager**, **Rotation Analytics**, **Carts**, **Decks**, **Processor**,
   **Shows**, **Categories**, **Jukebox**, **Show+**, **Show+ DAW**, **Desk**, **Now Playing**, **Phone**.
3. It opens in its own window. The menu closes. **The live screen stays put.**
4. Click the same entry again and the window you already have **comes to the front** — you never end up
   with two Libraries.

Close a window the normal way (its X, or Ctrl+W / Cmd+W) — closing it never touches audio.

## Where a window lands

**Two monitors:** the window opens on the **second monitor**, out of the way entirely.

**One monitor:** the window opens in the **right-hand portion of the screen, below the top strip** — so
the station name, the clock, the ON AIR state and the left column stay visible behind it. Open a second
window and it steps down and left a little so it doesn't land exactly on the first.

**Move it wherever you like.** Ether **remembers each window's position and size** and puts it back there
next time you open it. If you drag Library onto a second screen and size it, that is where Library opens
from then on.

## The star

An entry you have opened three or more times gets a **★**. That is just a usage marker — the entries you
actually reach for, easy to spot in the list.

## What did not change

- **The mixer.** Nothing opens on top of it, and no menu entry takes it away.
- **Your audio.** Opening, moving or closing a window never touches a deck. Esc still never kills audio.
- **The bottom bar.** The bottom-bar buttons behave as they always have.
- **Settings**, and **Live Captions**, still open in the main window (see below).

## Live Captions is the one that still takes over the screen

**Live Captions** stays in the main window rather than opening beside it. That is deliberate, not a
leftover: captions listen to a **live microphone**, and a second window running its own copy would try to
open the same microphone twice — which fails, and which would leave the two windows disagreeing about
whether captions were even on. When the listening moves out of the window, Live Captions will open like
everything else.

Use **Return to Mixer** at the top of the ≡ menu to come straight back to the live screen.

## If you unplug the monitor a window was living on

Nothing to do — Ether checks the remembered position against the screens you actually have. If the
monitor it was on is gone, the remembered position is ignored and the window opens on your main screen
in the normal place. Move it back and it is remembered again.

## Related

- `help-live-activity.md` — the live screen itself
- `help-imaging.md` — the Imaging window
- `help-logs.md` — the Play Log window
- `help-schedule-manager.md` — the Schedule Manager window
