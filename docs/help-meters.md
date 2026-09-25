---
feature: meters
title: Reading the Meters
summary: Every meter in EtherCast is the same meter — a coloured average bar with a white peak dot riding above it, a hold tick, an OVER light and a mark at −18. Channel meters show the source before the fader; the master meters show each output after it.
where: Live panel → every mixer strip; Master Out → Bus meters and the Wild Meter; Health Monitor → each station card (PGM)
since: 4.4 (meter bus, slice 2)
audience: operator
tour: true
---

# Reading the Meters

## What it is

EtherCast has **one meter**, and you see it in three places:

- **On every channel strip** (decks, SWEEPERS/CART, source channels, mic, guest) — the tall meter beside
  the fader.
- **In Master Out** — a row of four meters labelled **PGM**, **LOCAL**, **STREAM** and **MONITOR**, plus
  the **WILD** meter with a picker under it.
- **In the Health Monitor** — a thin **PGM** bar on every station card.

It reads the same everywhere, moves at the same speed everywhere, and means the same thing everywhere.

## How to read one meter

Each meter shows the left and right channels side by side. On each side:

1. **The coloured bar is the average level** — roughly how loud it sounds. It moves smoothly.
   - **Green** — below −18.
   - **Amber** — from −18 up to −6.
   - **Red** — above −6.
2. **The white dot is the peak** — the highest single sample. It jumps up instantly and falls back
   steadily (20 dB in 1.7 seconds). The gap between the dot and the bar tells you how punchy the audio is:
   speech and dynamic music show a wide gap, heavily compressed music a narrow one.
3. **The thin grey tick is the peak hold.** It stays at the highest peak for 2 seconds and then falls, so
   you can catch a peak you blinked through.
4. **The purple line is −18.** That is the alignment level. A test tone at −18 sits exactly on it:
   the bar reads **−18** and the dot reads about **−15** (a steady tone's peak is 3 dB above its
   average).
5. **The red cap at the top is OVER.** It lights when the audio reaches full scale (0 dBFS) and stays lit
   for 2 seconds. On a channel it means the source itself is that hot. On STREAM or LOCAL it means the
   output was clipped.

The scale runs from **−60** at the bottom to **0** at the top.

## Channel meters are BEFORE the fader

A strip's meter shows **the source**, not what the fader lets through:

- **Pull the fader down and the meter does not move.** That is deliberate: you can see a source is
  alive and at the right level before you bring it up.
- **Switch a channel OFF and its meter keeps moving.** OFF (the channel cut) silences the channel's
  contribution to the mix; it does not stop the source. A cut channel whose meter is dancing is a
  channel that is live and cut — press **ON** to put it on the air.
- A mic or guest strip shows the input level the same way: before its fader, whether ON or OFF.

## Master meters are AFTER the fader

The four meters in Master Out show each **output**, as it leaves:

- **PGM** — the programme mix after the MASTER fader. This is what the station is putting out.
- **LOCAL** — the local air output (the sound card the transmitter or console is on).
- **STREAM** — exactly what is sent to the stream encoder.
- **MONITOR** — the studio speakers, after the MONITOR fader.

Moving MASTER moves PGM, LOCAL and STREAM. Moving MONITOR moves only MONITOR, because your speakers are
not the broadcast.

## The Wild Meter

The **WILD** meter at the end of the Master Out row can show **any** channel or output — pick it from the
list underneath it. Channels are shown before the fader, outputs after. Use it to spot-check one source
without hunting for its strip. Your choice is remembered on this computer.

## "NOT FED"

A meter that has nothing to measure is drawn **hatched with NOT FED**, never as an empty bar. You see it
when:

- the audio engine is not running, or has stopped sending meter data for more than a second;
- an output does not exist right now — for example **LOCAL** when no local output device is set;
- a strip has no engine channel behind it.

An empty (dark) bar means **silence on a working meter**. Hatched means **the meter is not connected**.
The difference matters: an empty bar is evidence of silence; hatching is not.

## If something looks wrong

- **A channel's meter moves but nothing is on the air.** Look at its ON button and its fader — the meter
  shows the source before both.
- **PGM moves but STREAM is flat or NOT FED.** The mix is fine; the problem is on the stream side. Open
  the Health Monitor.
- **Every meter says NOT FED.** The audio engine is not reporting. Check the Health Monitor's Engine
  section; if the engine has just updated, fully close EtherCast and reopen it.
- **The Health Monitor card and the master meter disagree.** Check **Help → About** — both read the same
  PGM tap from this version on.

## Not in this version (by design)

- **No loudness (LUFS) on these meters.** The average bar is an RMS level, not loudness. Loudness lives in
  the Audio Processing section of the Health Monitor.
- **No true-peak.** The white dot is the sample peak. True-peak metering is on the loudness panel.
- **One meter per strip.** A strip does not show before- and after-fader side by side; the after-fader
  level of the whole mix is on the master meters.

## Related

- **Channel Faders and Channel Cut (ON/OFF)** — `docs/help-channel-faders.md`
- **Master and Monitor Faders** — `docs/help-master-monitor-faders.md`
- **Health Monitor** — `docs/help-health-monitor.md`
