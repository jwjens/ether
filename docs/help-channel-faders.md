---
feature: channel-faders
title: Channel Faders and Channel Cut (ON/OFF)
summary: Your fader is your level and nothing moves it but your hand — not a track load, not a device change, not the ON/OFF switch. ON/OFF is a channel cut that silences the channel without touching where you set the fader.
where: Live panel → the mixer strips (decks, SWEEPERS, guest, mic)
since: 4.4.146
audience: operator
tour: true
---

# Channel Faders and Channel Cut (ON/OFF)

## What it is

Every channel strip has two separate controls, and they do two different jobs:

- **The fader** — **your level** for that channel, in dB. Where you park it is where it stays.
- **ON / OFF** — the **channel cut**. OFF silences the channel completely. It does **not** move your fader.

This is how a broadcast board works: the switch is the door, the fader is the level. Opening and closing
the door never changes the level you set.

## Your fader stays where you put it

**Nothing moves your fader but your hand.** Specifically:

- **Loading a track does not move it.** Ride a deck down, and the next song into that deck plays at the
  level you set — it does not jump back to full.
- **Turning the channel OFF and back ON does not move it.** The audio returns at exactly your level.
- **A sound-card change does not move it.** If the station fails over to another output device mid-show,
  your levels come back untouched.

Before 4.4.146 a track load reset the channel to full — a song could undo the level a jock had just set.
That is fixed: only you move your faders.

### What about tracks that are too loud or too quiet?

Each track can carry its **own loudness trim**, worked out from the file itself. That trim is applied
**before** your fader, so it evens out the material *underneath* your hand — quiet songs come up, hot songs
come down, and your fader still means what you set it to mean. The trim belongs to the track; the fader
belongs to you.

## Cutting a channel (ON / OFF)

Press **ON** to toggle the channel cut.

- **ON (lit)** — audio passes.
- **OFF (unlit)** — the channel is **cut**: nothing from it reaches air. The fader stays exactly where it
  is, and the strip dims to show it is switched off.

A dimmed strip means **off, not broken.** The fader still works while the channel is cut — you can set your
level ahead of time and it takes effect the moment you turn the channel back on.

## When to use the cut

- **Kill a channel's audio without losing your level** — you'll want it back at the same setting.
- **Run a clean segment with no imaging** — cut the SWEEPERS channel and sweepers stay off air even though
  they still fire on schedule. See **Sweepers & Sweepers** for that channel specifically.
- **Silence a guest or mic channel** between segments.

## If a channel has gone silent

1. **Check its ON button first.** Unlit means you cut that channel — press it to restore.
2. **Check the fader** — it may simply be parked at the bottom.
3. **Check the meter.** A cut channel shows no movement at all; a channel that is on but very low shows
   movement down at the bottom of the meter.

## Not in this version (by design)

- **The cut is not a fade.** OFF is immediate and ON is immediate — use the fader if you want to ride it.
- **No per-channel cut memory except the SWEEPERS channel**, which is remembered per station. Deck, guest
  and mic cuts start every session ON.

## Related

- **Starting a Deck — the ON button** — the deck ON button also starts and stops playout
- **Sweepers & Sweepers** — cutting the imaging channel, remembered per station
- **Audio Processing** — station-wide loudness on the program bus, after all the faders
