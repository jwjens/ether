---
feature: module-carts
title: Carts (screen module)
summary: The cart wall as a building block for your own screens — the same carts, the same buttons and the same audio path as the Carts window.
where: ☰ menu → Carts (today). On a screen you build: placed from the module palette (coming with the Screen Builder).
since: Screen Builder Phase 1 (ui/screen-builder, 2026-10-18)
audience: operator
tour: false
---

# Carts (screen module)

> **Help corpus template.** Written to the format in `docs/help-sweepers.md`: plain language, step-by-step, the
> section order kept.

## What it is

**Carts** is your station's cart wall — 64 tiles, each holding one piece of audio (a stinger, a sound effect, a
bed, a drop). Press a tile and it plays; press it again and it stops.

As a **screen module**, it is exactly the wall you already have in the **Carts** window: the same carts, saved
for the station, firing through the same channel. It is not a copy. Anything you fire from a screen you build
plays the same way it does from the Carts window.

You can put **more than one** Carts module on a screen — for example one with the full wall and one as a
short strip.

## When to use it

Any time you want carts within reach on a screen of your own — next to the program log, or beside the library.

## Set it up

Today the module is the **Carts** window: **☰ menu → Carts**. Placing it on a screen of your own comes with the
Screen Builder (the next step); this page will say how when it arrives.

1. **Put audio on a tile.** Click an **Empty** tile and pick a file, or drag a file onto a tile. The file is
   copied into your library first, so the cart works on every computer on your account.
2. **Rename a tile.** Right-click it → **RENAME…**, type, press **Enter**. (Double-click works too.)
3. **Replace or clear.** Right-click → **REPLACE FILE…** or **DELETE**. Delete empties the tile only; the file
   stays in your library.
4. **Set the level.** The slider beside the meter is the cart level.

## How it behaves on air

- **Click a loaded tile** to fire it. It flashes and counts down while it plays. **Click it again** to stop it.
- **Keyboard:** the first 24 tiles have keys — `1`–`8`, `Q`–`I`, `A`–`K`.
- **Two Carts on one screen:** the keys belong to the wall you **last clicked**. Click anywhere on a wall to give
  it the keyboard. Before you have clicked either, the wall added last has them. One key press fires one cart,
  once — never one on each wall.
- A cart plays on the channel dialled to **Cart / SFX rack**. If no channel is, it plays on the legacy cart
  channel and the Console says so.
- The station is the screen's station. A Carts module never fires carts on a different station.

## If a cart doesn't play

- **Check the channel.** Is a deck's input set to **Cart / SFX rack**, and is that channel **ON**? (See the
  Console for a `[CART]` line naming where it went.)
- **Is the tile loaded?** An empty tile says **Empty — click to assign**.
- **Two walls?** Click the wall you mean, then press the key.
- **File missing?** Right-click → **OPEN FILE LOCATION** is greyed when the audio is not on this computer.

## Not in this version (by design)

- Choosing which carts or how many rows a module shows. Every Carts module shows the whole wall.
- Your own hotkeys per wall. The keys are the 24 above, on whichever wall has the keyboard.

## Related

- **Sweepers** (`docs/help-sweepers.md`) — the cart channel's ON switch also carries sweepers.
- **Channel Faders** (`docs/help-channel-faders.md`) — the cart channel's fader and ON.
- **Program Log module** (`docs/help-module-programlog.md`), **Song Library module** (`docs/help-module-library.md`).
