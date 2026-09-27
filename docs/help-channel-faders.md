---
feature: channel-faders
title: Channel Faders and Channel Cut (ON/OFF)
summary: Your fader is your level and nothing moves it but your hand — or a show you TAKE — not a track load, not a device change, not the ON/OFF switch. Your faders come back after a restart, and every level change is smooth. ON/OFF is a channel cut that silences the channel without touching where you set the fader.
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

**Nothing moves your fader but your hand** — and a **show preset you TAKE**, because pressing TAKE is your hand
too (see **Show Presets**). Specifically:

- **Loading a track does not move it.** Ride a deck down, and the next song into that deck plays at the
  level you set — it does not jump back to full.
- **Turning the channel OFF and back ON does not move it.** The audio returns at exactly your level.
- **A sound-card change does not move it.** If the station fails over to another output device mid-show,
  your levels come back untouched.

- **A restart does not move it.** Ether remembers every fader (and the master) for the station and puts them
  back when it starts.

Before 4.4.146 a track load reset the channel to full — a song could undo the level a jock had just set.
That is fixed: only you move your faders.

### Every level change is smooth

When a level changes — your drag, a show you TAKE, TAKE NOW, or the levels coming back at start — the engine
glides it over **20 milliseconds** instead of jumping. A jump in level makes a click on air; the glide doesn't,
and it is too short to hear as a fade. A level that isn't changing is untouched.

### PENDING on a channel

After you **TAKE** a show, a channel that was **ON** keeps what it has, so nothing changes under a live voice or
a playing song. Its ON button **flashes amber and says PENDING**, with the show's name above it.
- Switch it **OFF** (or let the deck finish) and the show's settings land.
- Or press **TAKE NOW** on that strip to apply them while it stays ON. The level glides; it doesn't jump.

See **Show Presets** (`docs/help-show-presets.md`).

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

## Listening to a channel off air (PFL)

**PFL** ("pre-fader listen") lets you hear a channel **without putting it on air**: check a mic before you open
it, or cue a cart.

1. Press **PFL** on the channel's strip. The button lights **amber** once the audio engine is doing it. The lamp
   is the engine's answer, not just your press.
2. You hear that channel in **this station's local output** (the speakers or headphones the music plays through
   here):
   - **before its fader and before ON/OFF**, so it works with the channel OFF and the fader down;
   - **after its channel EQ**, so you hear the processed sound.
3. **While any PFL is on, the programme in that output dips** so you can hear what you're checking.
   - How far is a station setting: **Preferences → Audio → PFL → Programme dip** (−60 to 0 dB).
   - **−12 dB** until someone changes it.
4. Press **PFL** again to stop.

**Nothing on air changes.** The stream, the programme and every on-air meter are exactly as they were. PFL only
ever reaches the local output.

### PFL in headphones (a separate PFL output)

By default PFL plays through the **main local output**, and the programme there dips. To keep PFL off the
speakers:

1. Go to **Preferences → Audio → PFL → PFL output**.
2. Pick your **headphones** (or any output on this computer). The default is **Same as main output**.

**Then, while any PFL is on:**
- **the headphones** carry the channel you're checking, plus the programme at the dip level so you keep your
  place;
- **the main speakers are left completely alone.**

With no PFL on, the headphones are silent.

**The PFL output belongs to this computer.** Each computer picks its own; it never syncs.

**If the chosen headphones aren't connected, PFL is silent.** It never falls back to the speakers, where it
would surprise you.
- The strip shows **⚠ cue device not found — PFL silent** while its PFL is on.
- **Health Monitor → PFL Output** says the same.
- Plug the headphones back in and PFL returns by itself within a few seconds.

**A mic on PFL arrives about 40 ms late.** That's the time through the computer and back. It's fine for
checking how the mic *sounds*, but it's too late to talk against. **To hear yourself while you speak, use your
audio interface's direct-monitor.** See **Mic on Air**.

## If a channel has gone silent

1. **Check its ON button first.** Unlit means you cut that channel — press it to restore.
2. **Check the fader** — it may simply be parked at the bottom.
3. **Check the meter.** The strip meter shows the SOURCE, before the fader and before ON/OFF. If it is
   moving, the source is alive — so a silent channel with a moving meter is cut (ON unlit) or faded down.
   If it is not moving, the source itself is silent. See **Reading the Meters**.

## Not in this version (by design)

- **The cut is not a fade.** OFF is immediate and ON is immediate — use the fader if you want to ride it.
- **No per-channel cut memory except the SWEEPERS channel**, which is remembered per station. Deck, guest
  and mic cuts start every session ON.

## Related

- **Mic on Air** (`docs/help-mic-input.md`) — the mic as a channel, and hearing yourself
- **Show Presets** (`docs/help-show-presets.md`) — the whole board saved and recalled, PENDING, TAKE NOW

- **Starting a Deck — the ON button** — the deck ON button also starts and stops playout
- **Sweepers & Sweepers** — cutting the imaging channel, remembered per station
- **Audio Processing** — station-wide loudness on the program bus, after all the faders
