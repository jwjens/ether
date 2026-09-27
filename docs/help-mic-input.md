---
feature: mic-input
title: Mic on Air (the mic as a channel)
summary: A microphone is a channel on the board like any other — patch it to an input on this computer, set its gain, and it goes on air with its own meter, channel EQ, fader, ON and ducking.
where: On the board, a source channel's source dropdown → an input device (or "Mic — pick an input…"). Input number and gain: Preferences → Audio → Mic Inputs. Its live state: the strip, and Health Monitor → Mic Inputs.
since: DSP — mic in the engine (2026-09-26)
audience: operator
tour: true
---

# Mic on Air

## What it is

**A mic is a source channel on the board patched to Mic.** It works like every other channel:
- **its own meter**, showing the mic before its fader;
- **its own channel rack:** Filters, a **Gate**, the PEQ and a **Compressor** (see **Channel EQ** and **Gate and
  Compressor**). **Start from the Voice preset**: open the rack (EQ on the strip) → Preset → Voice → TAKE;
- **its fader and ON**;
- **the ducker**: switch DUCK ON and the music drops under your voice.

**It goes on air**, through the same engine as the music. Before this, the mic only played on this computer's
speakers and never reached listeners.

You can have a mic on any source channel: D, E, F, and the extra source channels the + button adds (G onward). Each mic has its own input.

## Put a mic on the board

1. Find a source channel (a strip with a **SOURCE** dropdown), or add one with **+**.
2. In its **SOURCE** dropdown, under **INPUT DEVICES (this computer)**, choose your microphone or interface.
   - Picking a device patches it at once, on input 1 at 0 dB.
3. The strip names the device, and the line under the dropdown says how it is: **● IN 1 · +0 dB · live**.
4. Bring the fader up and press **ON**. You're on air.

## Set the input and the gain

Go to **Preferences → Audio → Mic Inputs** (or click the state line under the strip's dropdown). For each mic
channel you can set:

| Setting | What it does |
|---|---|
| **Input device** | Which input on **this computer** feeds the channel. The list is the one the audio engine sees. |
| **Input number** | For an interface with several inputs (Input 1, Input 2, …). |
| **Input gain** | −10 to +40 dB, before the meter and the channel EQ. Set your preamp first, then trim here. |

**Mic settings belong to this computer.** Another computer on the same station picks its own mic: device
names are different on every machine, so they never sync. The board layout itself (which channel is the mic)
is shared as usual.

## An open mic and the ducker

If the mic channel's **DUCK** is on, anything it picks up (the room, a fan) can hold the music down. **Put a Gate
on the mic** (the Voice preset has one): the ducker listens *after* the gate, so a closed gate means the room noise
doesn't duck the music, and your voice still does.

## Hearing yourself

**Use your interface's direct monitor** to hear your own voice in your headphones. It has no delay.

The engine's path back to your headphones takes a few tens of milliseconds. That's fine for **PFL**, to check
how the mic *sounds* through its EQ, but it's too late to talk against: you'd hear an echo of yourself.

## What the state line means

| It says | What it means |
|---|---|
| **live** | The mic is running and on this channel. |
| **starting** | It has just opened and is filling its buffer; a moment. |
| **device not connected** | The chosen device isn't plugged into this computer. The channel is silent. It never switches to a different mic on its own: a wrong mic on air is worse than none. |
| **device lost — retrying** | It was unplugged or failed. The channel is silent, **the music keeps playing**, and Ether re-opens it by itself when it comes back. |
| **pure digital silence — Windows mic privacy?** | Windows is handing over exact silence. Almost always, Windows **Settings → Privacy → Microphone → "Let desktop apps access your microphone"** is off. It can also be a muted input. |
| **that input is not on this device** | The input number is higher than the device has. Pick another in Preferences. |
| **no input — Preferences → Audio** | The channel is set to Mic but no input is patched yet. |

When a mic isn't live, its meter is **hatched (NOT FED)** instead of reading zero, so you can't mistake a dead
mic for a quiet one.

**Health Monitor → Mic Inputs** lists every patched mic with its counters: dropouts, times lost, re-opened,
and the clock difference the engine is absorbing.

## Good to know

- **Turn off Windows "audio enhancements"** for your mic (Sound settings → your mic → Properties): noise
  suppression and automatic gain there change your voice before Ether sees it.
- **Other apps can use the same mic at the same time** (voice tracking, Show+, Zoom). Ether shares it.
- **The old mic strip and its 10-band "mic input EQ" are gone.** They played only on this computer. Your mic
  channel moved to a source channel by itself; if it couldn't (every source channel was in use), the board
  says so. The old EQ settings were not carried over: use the channel EQ.

## Not in this version (by design)

- Voice tracking and Show+ still record through the browser's audio, not this input (a later change).
- One channel per input device per station.
- No stereo pair input yet (a mic is mono).

## Related

- **Channel EQ** (`docs/help-channel-eq.md`)
- **Gate and Compressor** (`docs/help-channel-dynamics.md`)
- **Reading the Meters** (`docs/help-meters.md`)
- **Health Monitor** (`docs/help-health-monitor.md`)
