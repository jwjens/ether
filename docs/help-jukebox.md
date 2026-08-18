---
feature: jukebox
title: Jukebox (public request kiosk)
summary: A fullscreen wall of album art the public can browse and request from — each request shows the requester's name and its place in line.
where: ☰ menu (top right) → Windows → Jukebox
since: unreleased (Phase 1 build, 2026-08-17)
audience: operator
tour: true
---

# Jukebox (public request kiosk)

## What it is

A **second window** you point at a screen the public can see — a wall of big album covers they can
browse, search and pick from. Someone taps a cover, types their name, and their song joins the queue.
The queue is on the right of the screen with each person's **name** and their **place in line**, so
everyone can see their song coming.

You choose exactly what the public may pick from: you tick **categories** in Settings, and their songs
are the whole pool. Nothing else in your library is reachable from the kiosk.

## When to use it

An event, a bar, a park night, a lobby — anywhere the audience picks the music and staff are nearby.
It is a **display**, not a control surface: nothing on the kiosk screen can change your station's
settings, edit your library, or stop what is on air.

## Set it up (two minutes)

1. **Choose the music the public can pick.** In the main window open **Settings → Programming →
   Jukebox**. You'll see every category on this station with the number of playable songs in each.
   **Tick the ones you're happy for strangers to choose.** It saves as you tick — there's no Save
   button for the ticks.
   - The count under the list is the real pool ("1,284 songs across 4 categories"). Songs whose file
     isn't on this machine are **left out on purpose** — a request that can't play would be dead air
     in front of an audience.
   - A category showing **"no playable songs"** has nothing the kiosk can use. Ticking it adds nothing.
2. **Add your request link (optional, for phones).** In the same place, paste the public request page
   address into **Request link (QR)** and press **Save**. The kiosk turns it into a QR code big enough
   to scan from across the room. Leave it empty and the kiosk simply doesn't show a code.
3. **Patch it into a deck.** On the dashboard open the deck configurator and set the source of
   **deck D, E or F** to **Jukebox**. That is the jukebox's channel on your board — bring the fader up
   and it is on air, exactly like a microphone.
   - Only D, E and F are offered on purpose. Automation runs decks A, B and C, so a jukebox deck is
     one your scheduler never touches. Your log, your AUTO/MANUAL state and your clocks are unaffected.
4. **Open the display.** Click the **☰ menu** at the top right → under **Windows**, choose
   **Jukebox**. It opens as its own window, **fullscreen**, ready to face the public.

## Using it

- **Browse** — scroll the wall. Covers load as you go.
- **Search** — type in the box at the top. Results narrow as you type; there's no button to press.
- **Request** — tap a cover, type a name, press **PLAY NEXT**. The song joins the queue and the person
  sees their name appear on the right.
- **The queue** — each entry shows the name, the position (#1, #2, #3…) and the song. The **#2** entry
  is drawn larger with a flashing **UP NEXT** badge. Requests play **in the order they arrived**, and a
  request **never cuts a song that is already playing** — it starts when the current one finishes.
- **AUTO** (top right of the kiosk) is the **jukebox's own** AUTO and has nothing to do with the
  station's AUTO/MANUAL:
  - **AUTO ON** — between requests the jukebox keeps music going, shuffled from the categories you
    ticked. A request plays as soon as the current song ends.
  - **AUTO OFF** — only requested songs play. When the queue empties it goes **silent**, on purpose.
- **ON AIR** appears when the jukebox deck is actually playing and its fader is up. It reflects the
  board, not the AUTO button — AUTO on with the fader down is not on air, and the window says so.

## Moving and closing the window

- **Escape** leaves fullscreen so you get the normal window bar back. **F11** puts it back to
  fullscreen. Escape never stops audio and never closes the window.
- Close it like any window when the night is over. Closing the kiosk does **not** stop your station.
- Drag it to a second monitor and it remembers where you put it.

## What it does to what's on air

**You decide, at the fader.** The jukebox is a source on its own deck; its audio reaches air only when
that channel is up. It never adds anything to the station's queue, never changes your clocks, rotation
or scheduling, and never touches your AUTO/MANUAL state.

It is an **event tool**, not playout: it airs music only — no commercials, no traffic, no spots, ever.
If you need those, they stay on your normal station decks.

Jukebox songs **are** written to Play History like any other deck play, marked as jukebox plays so you
can tell a public pick from rotation.

## If something looks wrong

- **"The jukebox isn't set up yet"** — no categories are ticked. Settings → Programming → Jukebox.
- **"No station selected"** — this install has no active station. Sign in and pick a station in the
  main window, then reopen the kiosk. The kiosk will never guess a station for you.
- **The wall is empty but categories are ticked** — the ticked categories have no songs with playable
  files on this machine. Check Settings → Music Folder & Sync.
- **"The queue is full right now"** — the number of waiting requests hit the cap. It clears as songs
  play.
- **"Not routed to a deck"** — no deck has Jukebox as its source. Set deck D, E or F to Jukebox.
  Requests keep being collected in the meantime.
- **"The fader is down"** — the jukebox is patched in but its channel is not up, so nothing is
  reaching air. The queue keeps filling; bring the fader up when you want it heard.
- **The VU meter on a jukebox deck sits at zero** — decks D, E and F do not have level meters yet
  (this affects any source on those decks, not just the jukebox). The audio is playing and mixed
  normally; only the meter is missing.
- **A song won't queue twice** — if it's already coming up, the kiosk says so rather than stacking
  duplicates.

## Not included yet

- **Requesting from a phone.** The QR code shows the link you provide; the public page it points to is
  the next phase of this feature and isn't built yet.
- **Payments or donations.** There is no charge for a request and no payment step anywhere in this
  build.
- **Paying to skip the line.** Requests are strictly first-come, first-served. Priority is a future
  design that belongs with donations.
