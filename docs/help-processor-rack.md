---
feature: processor-rack
title: The Master Rack (Processor)
summary: The master processing chain as a rack you can see and play while on air — the master EQ, then for each output (Monitor and Stream) the loudness ride and the true-peak limiter — with the meters pinned beside it and presets you Arm and Take.
where: Master Out → Processor → OPEN (its own window). Master Out → Master EQ → OPEN opens it with the EQ selected.
since: unreleased (log-reader-flip, after 4.6.50)
audience: operator
tour: true
---

# The Master Rack

## What it is

Everything that shapes your station's sound after the mix, laid out left to right in the order the audio goes
through it:

- **PGM** — the **GEQ**, the 10-band master EQ. It shapes the whole programme, before it splits.
- **MONITOR** — your local output: the **RIDE** (loudness ride) then the **LIMITER** (true-peak limiter).
- **STREAM** — what the stream encoder gets: its own RIDE then LIMITER.

While **LINKED**, the stream runs exactly the monitor's settings. **SPLIT** gives the stream its own. Splitting
changes nothing by itself; the stream starts as a copy of the monitor.

Each kind of module always has the same colour: **blue** for EQ, **cyan** for loudness, **magenta** for dynamics
(the limiter), and **green** for filters. Each fader's own channel rack uses the same colours (see **Channel EQ**).

## Open it

1. Go to **Master Out** (right side).
2. Next to **Processor**, press **OPEN**. The rack opens in its own window, so you can put it on another screen.
3. Or next to **Master EQ**, press **OPEN**. The same rack opens with the **GEQ** already selected.

## Using it

1. **Tap a module** in the strip. The editor below says what you are editing, for example
   *"editing: MONITOR · RIDE"*.
2. Move the controls. The change is on air straight away, and saved for this station.
   - **GEQ:** ten band faders over a live spectrum, **FLAT**, and **IN/OUT**. Above the faders is a graph like a
     Behringer X32's: 12 spectrum bars per octave (blue → green → yellow, red only at the very top), **dimmed**
     before the GEQ and **full** after it, both before the master fader. The GEQ's own curve is drawn in yellow,
     with a numbered dot at every fader's position (fader 1 = 31 Hz … 10 = 16 kHz). It's the same display as the
     channel EQ (see **Channel EQ → Reading the spectrum**), and it runs only while this view is open.
   - **RIDE:** Target (the loudness it aims for), Rate (how fast it moves), Clamp (how far it may go).
   - **LIMITER:** Ceiling and Release. The line under the ceiling says where it really limits, for example
     *"−1.0 dBTP set · limits at −2.2 dBTP"*.
3. **IN / OUT on the GEQ** is saved with the rack.
4. **BYP on the ride or the limiter** is a **test tool**. It works straight away, the banner warns you, and it
   switches itself off when Ether restarts. It is never saved, so a restart always ends with the ceiling
   held.

**The meters on the right stay put while you work:**
- IN (the programme before processing);
- OUT for each output;
- RIDE and LIMITER for each output;
- the loudness panels (see **Loudness Meter**).

## Presets

- The bar at the top shows the **active preset**. **· modified** appears when the rack no longer matches it.
- **To change presets without surprises:**
  1. **Arm** one from the list. Nothing changes on air yet.
  2. The rack shows exactly what would change, for example *"both: target −14.0 → −23.0 LUFS"*.
  3. Press **TAKE** to apply it, or **DISARM** to drop it.
- **Save** overwrites your own active preset. **Save as** makes a new one. The built-in presets cannot be
  overwritten.
- **Built-in presets:**
  - **Ether v1 (shipped)** is the default, and it is the −14 LUFS streaming target;
  - **Broadcast −24 (ATSC A/85)**;
  - **EBU −23 (R128)**;
  - **Stream/Podcast −16**.

  Only the target and the ceiling differ between them.
- **A preset never turns processing on or off.** "Process local output" and "Process stream" stay where you
  set them (Preferences → Broadcast → Audio Processing).

## If something looks wrong

- **A red "the engine did not accept that" line** means the change was refused and **nothing changed on air**.
  The rack shows what is running. If Ether has just updated, fully close it and reopen it (the audio engine
  does not reload on its own).
- **A yellow BYPASSED banner** means a test bypass is on. Press **BYP** again to put the module back **IN**.
- **"This station's rack is built from its existing processor settings"** means you haven't changed anything
  yet. The rack shows exactly what was already running, and it is saved as a rack the first time you change
  something.

## Not in this version (by design)

- **Nothing in the master rack can be moved.** The EQ comes first, and in each output the limiter is always
  last: it is what holds the ceiling. (Channel racks can be reordered.)
- **The ride and the limiter cannot be removed** (bypass is the test tool). The GEQ can be removed and added
  back.
- **Channel racks live in the same window.** The selector row at the top (MASTER | A–F | CART | G–K, every fader by its board letter) goes to a
  fader's own rack. See **Channel EQ** (`docs/help-channel-eq.md`).
- **A rack preset's Take applies at once**, because the master rack has no channels to protect. Presets for
  the whole board, which do protect live channels, are **Show Presets** — see `docs/help-show-presets.md`.

## Related

- **Channel EQ** (`docs/help-channel-eq.md`) — Filters and PEQ on each fader
- **Loudness Meter** (`docs/help-loudness-meter.md`)
- **Audio Processing** (`docs/help-audio-processing.md`) — turning processing on for each output
- **Reading the Meters** (`docs/help-meters.md`)
- **Show Presets** (`docs/help-show-presets.md`) — presets for the whole board
