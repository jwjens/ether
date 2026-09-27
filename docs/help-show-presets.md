---
feature: show-presets
title: Show Presets (save and recall the whole board)
summary: Save the whole board as a show — every fader, channel EQ, gate and compressor, the ducker, the room and monitor levels, the master rack — and TAKE it back in one press. Channels that are ON keep what they have until you switch them OFF, so nothing changes under a live voice.
where: On the board, the SHOW bar above the faders (the dashboard and the pop-out board) → Arm a show… → TAKE. Save / Save As on the same bar.
since: slice 7 (DSP)
audience: operator
tour: true
---

# Show Presets

## What it is

A **show preset** is a snapshot of the **whole board** for this station. It holds, for every channel:
- whether the channel is on the board, and what it's patched to ("a mic", "the jukebox", "announcements");
- its fader level;
- its channel rack: filters, gate, EQ, compressor;
- its duck settings;
- its room level.

For the whole station it also holds:
- the master rack;
- the master fader;
- the ducker settings;
- the monitor level.

**Take a show** and the board changes to it in one step, in the same instant.

**One show is built in: Flat.** Every channel EQ empty, every fader at full, the ducker at its standard settings,
and the master at Ether's standard chain. It's always there as a known clean start.

## Find it

The **SHOW** bar sits **above the faders**, in the dashboard and in the pop-out board. It shows:
- **SHOW: Morning Drive**, the show you last took;
- **· modified**, when the board no longer matches it (you moved a fader, changed an EQ, and so on);
- **· waiting: A, G**, the channels still waiting for the show (see PENDING below).

## Take a show

1. In **Arm a show…**, pick the show. **Nothing changes yet.** Arming only gets it ready.
2. The bar opens **what TAKE will change**:
   - **CHANGES NOW:** everything on channels that are OFF, and the master section.
   - **WAITS — ON NOW:** the changes for channels that are ON right now.
3. Press **TAKE ▸ *name***. Or press **DISARM** to put it away.

**Channels that are OFF change at once. Channels that are ON wait.** A mic that's ON waits even while nobody is
talking, and a deck that's playing waits until it stops. A show never changes anything under a live voice or a
playing song.

**A show never switches a channel ON.** Putting a channel on air is always your press.

## PENDING and TAKE NOW

A channel that was ON when you took the show:
- keeps everything it had;
- its **ON button flashes amber and says PENDING**, with the show's name above it.

**When you switch it OFF** (or the deck finishes or stops), the show's settings land on that channel.

**TAKE NOW** on that strip applies the show to it right away, while it stays ON. Its level glides over 20 ms, so it
doesn't click.

**Waiting channels are remembered by the audio engine, not the screen.** Close the board, open the pop-out, or
restart Ether, and PENDING is still there.

## Save a show

- **SAVE** overwrites the show you last took with the board as it is now.
- **SAVE AS…** saves the board under a new name.
- **Flat can't be overwritten.** Use Save As.

Shows belong to the **station**. They travel with it to its other computers, and a show saved for one station can
never be taken on another.

## What a show does NOT hold (on purpose)

| Not in a show | Why |
|---|---|
| **Which microphone, which sound card, which headphones** | These belong to **this computer**; another computer has different devices. A show says a channel is *a mic*. *Which* mic is this computer's setting (Preferences → Audio → Mic Inputs). The mic's input gain stays with the computer too. |
| **Processing on / off** | A show never switches processing on or off (Preferences → Broadcast). |
| **PFL** | PFL is momentary; the PFL dim and PFL output are your preferences. |
| **The log, what's loaded, AUTO / MANUAL** | A show is the board, not the programme. |

## Your faders after a restart

Ether remembers where every fader and the master were for each station, and puts them back when it starts.

## Not in this version (by design)

- **Presets that follow a person** ("the host's mic settings go wherever the host sits") come in a later step.
- **No timed shows:** a show doesn't take itself at a set time.
- **A channel removed from the board while it's PENDING** keeps waiting until that channel is cut.

## Related

- **Channel Faders** (`docs/help-channel-faders.md`): PENDING, smooth level changes
- **Channel EQ** (`docs/help-channel-eq.md`) and **Gate and Compressor** (`docs/help-channel-dynamics.md`): what
  a channel rack holds, and one-channel presets such as Voice
- **Mic on Air** (`docs/help-mic-input.md`): why the mic device stays with the computer
