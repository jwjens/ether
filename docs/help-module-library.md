---
feature: module-library
title: Song Library (screen module)
summary: Your music, spots, sweepers and announcements — searchable, with load-to-deck — as a building block for your own screens, the same library as the Library window.
where: ☰ menu → Library (today). On a screen you build: placed from the module palette (coming with the Screen Builder).
since: Screen Builder Phase 1 (ui/screen-builder, 2026-10-18)
audience: operator
tour: false
---

# Song Library (screen module)

> **Help corpus template.** Written to the format in `docs/help-sweepers.md`: plain language, step-by-step, the
> section order kept.

## What it is

The **Song Library** is everything your station can play: music, spots, sweepers and announcements, in one
searchable list.

As a **screen module**, it is exactly the **Library** window — the same list and the same buttons, doing the same
thing. The main screen's Library, the Library window and the module all load and queue the **same way**, by the
same rules.

## When to use it

When you want to find and load songs beside the log or the carts on a screen of your own.

## Set it up

Today the module is the **Library** window: **☰ menu → Library**. Placing it on a screen of your own comes with
the Screen Builder (the next step); this page will say how when it arrives.

1. **Find a song.** Type in the search box, or pick a category.
2. **Load it.** Press **A**, **B** or **C** on its row to cue it on that deck.
3. **Queue it.** Press **Q** to add it to the bottom of Up Next.
4. **Add music.** With an empty library, press **Import Music**.

## How it behaves on air

- **A / B / C** cue the song on that deck. If the song's audio is only in the cloud, Ether fetches it first and says
  **Loading "…" onto A…** while it does.
- **A deck that is on air is never replaced.** If the deck is **playing or paused**, nothing is loaded and Ether says:
  **Deck A is on air — "…" was not loaded. Stop deck A first.** The same words on the main screen, in the Library
  window and in the module.
- **Q** adds the song to the bottom of Up Next.
- The station is the screen's station. A Library module loads onto that station's decks only.
- Column choices and widths are remembered on this computer (widths per station), so two Library modules share
  them.

## If you don't see your songs

- **"No items yet — Import audio to add items to the library."** The library is empty: press **Import Music**.
- **"No … match that search"** — clear the search or the category filter.
- **"Deck … is on air"** — that deck is playing or paused. Stop it on the board (or pick another deck), then load.

## Not in this version (by design)

- **Edit cue points** is not offered here; open the cue editor from the main screen.

## Related

- **Deleting songs** (`docs/help-deleting-songs.md`).
- **Carts module** (`docs/help-module-carts.md`), **Program Log module** (`docs/help-module-programlog.md`).
