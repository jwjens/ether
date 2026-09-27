---
feature: channel-dynamics
title: Gate and Compressor on a channel (and the Voice preset)
summary: Every fader's rack can hold a Gate (turns the room down when nobody is talking) and a Compressor (evens out a voice) — with a transfer graph, live gain-reduction meters, a COMP lamp on the fader, and a Voice preset to start from.
where: The EQ button on any fader strip → the rack window at that fader → + GATE / + COMP, or Preset → Voice → TAKE.
since: slice 6 (DSP)
audience: operator
tour: true
---

# Gate and Compressor

## What they do

A fader's rack runs in this order: **Filters → Gate → PEQ → Comp**. You can drag modules to reorder them.

- **GATE** (magenta) **turns the room down when nobody is talking.**
  - Below its **threshold** it lowers the channel by up to its **depth** (14 dB is usually enough, 20 dB tops).
  - It opens the moment you speak.
  - **Why it matters for a mic:** with the gate closed, the room noise and fans don't reach air. They also
    **can't hold the music down if the channel's DUCK is on**, because the ducker listens after the gate.
- **COMP** (magenta, with its orange curve) **evens out a voice.**
  - Above its **threshold** it reduces the level by its **ratio** (3:1 is gentle; 20:1 is close to limiting), so
    loud words come down towards quiet ones.
  - **Makeup** (0–24 dB) brings the whole voice back up.
  - It listens to loudness (RMS), not to single peaks, so plosives don't make it grab.

## Start from Voice

1. Open the channel's rack (**EQ** on the fader).
2. In **Preset**, choose **Voice**, then press **TAKE ▸ Voice**.
3. The channel now runs, all IN:
   - **HPF 80 Hz**;
   - **Gate** −45 dB, depth 15 dB, 1:4, open 1 ms, hold 100 ms, release 150 ms, hysteresis 3 dB;
   - a flat **PEQ**;
   - **Comp** 3:1 at −20 dB, attack 10 ms, release 150 ms, knee 6 dB, makeup 0 dB.
4. Adjust by ear. The usual moves are the gate **threshold** (just above your room noise) and the compressor
   **makeup**.

**Off** empties the rack: nothing runs, and the channel is untouched. **Save as** keeps your own settings as a
preset for this station.

**Taking a preset switches its modules IN.** Adding a single module with **+ GATE** or **+ COMP** starts it **OUT**,
so nothing changes on air until you press **IN**.

## The transfer graph

Pick the GATE or COMP tile to open its editor:
- **the grey diagonal** is "no change";
- **the orange line** is what the channel actually does: input level across, output level up;
- **the faint magenta lines** are the gate and the compressor on their own;
- **drag a threshold line** sideways to move it;
- **the dot** is where your channel is right now: its level, and what the gate and compressor are doing to it.

**The sliders beside the graph:**

| Module | Controls |
|---|---|
| Gate | threshold, depth, ratio (1:1–1:5), open time, hold, release, **hysteresis** |
| Compressor | threshold (−40…+10 dB), ratio (1:1–20:1), **knee** (0–12 dB), attack (0.1–330 ms), release (50 ms–3 s), makeup (0–24 dB) |

**Hysteresis** makes the gate close only a few dB *below* where it opened, so it doesn't flutter on a voice
hovering at the threshold.

**Every change is smooth:** a 20 ms crossfade, so moving a threshold or the makeup never clicks on air. There's
**no lookahead**, so nothing is added to the mic's delay.

## Reading it from the board

- **The fader strip** shows **COMP −x dB** in magenta while that channel's compressor is reducing the level by
  1 dB or more.
- **In the rack,** the GATE and COMP tiles show a live **gain-reduction bar**. The gate tile also says
  **OPEN / CLOSED**.

## Not in this version (by design)

- **No lookahead**, no side-chain filter, no de-esser, no automatic makeup.
- **Presets belong to the station,** not to a source: "the host's mic settings follow the host" is a later
  step.

## Related

- **Channel EQ** (`docs/help-channel-eq.md`)
- **Mic on Air** (`docs/help-mic-input.md`)
- **Channel Faders** (`docs/help-channel-faders.md`) — PFL to hear the processed sound
