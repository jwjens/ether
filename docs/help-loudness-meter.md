---
feature: loudness-meter
title: Loudness Meter (M / S / I / LRA / True Peak)
summary: For each output — the Monitor (your local output) and the Stream — EtherCast measures the loudness of what that output actually sent, the way broadcast loudness is judged (ITU-R BS.1770 / EBU R128). Integrated loudness, loudness range and true-peak max run from the last Reset. The ride and the limiter each have their own meter.
where: Master Out → Processor (pop-out) → the Loudness card, and the RIDE / LIMITER meters beside each output
since: slice 3 (DSP)
audience: operator
tour: true
---

# Loudness Meter

## What it is

A loudness meter for each output, measuring **what that output actually sent** — after the ride and the
limiter, so nothing on it is an estimate:

- **Monitor** — your local output (the sound card the station plays on), measured **before** your monitor
  knobs. Turning the room down does not change the reading; it is the programme's loudness.
- **Stream** — exactly what goes to the stream encoder. It keeps measuring when no encoder is connected
  (for example in a rehearsal), and the panel says **"encoder not connected — metering what would be sent"**.

It measures the way broadcast loudness is judged (ITU-R BS.1770, EBU R128), and it was checked against the
EBU's own test signals (Tech 3341 and 3342) and against an independent meter.

## Where to find it

1. Open **Master Out** (right side).
2. Open the **Processor** (it opens in its own window you can move to another screen).
3. The **Loudness** card shows both outputs side by side. Above it, each output's row has a **RIDE** meter
   and a **LIMITER** meter.

## Reading it

| Reading | What it tells you |
|---|---|
| **M** (momentary) | Loudness of the last 0.4 s. Jumps around — it is the "now". |
| **S** (short-term) | Loudness of the last 3 s. Steadier; what you watch while riding a show. |
| **Integrated** | The average loudness since the last **Reset**, measured the standard way: silence and very quiet passages are left out so they don't drag it down. **This is the number compliance is judged on.** |
| **LRA** | Loudness range since the last Reset, in LU: how far loud parts and quiet parts are apart. Speech-heavy talk sits low; dynamic music sits higher. |
| **True peak max** | The highest peak since the last Reset, including peaks **between** samples (measured 4× oversampled), in dBTP. |

- The **M** and **S** bars are drawn on a scale **centred on this output's own target** (the purple line).
  **+9** shows 18 LU below to 9 LU above the target; **+18** shows 36 below to 18 above. Pick either with the
  small buttons; the choice is remembered on this computer.
- The bar colour and the word beside it say how far you are from the target: **ok** within 1 LU, **hot**
  within 3 LU, **over** further away in either direction (too quiet is off target too).

## Reset

Press **RESET** on an output to start **Integrated**, **LRA** and **True peak max** again — for example at the
start of a show you want to measure on its own. The line beside it shows **"since hh:mm:ss"**.

- Reset does not touch the sound at all. It only restarts the measurement.
- After 24 hours without a reset, Integrated and LRA keep measuring the **most recent 24 hours**, and the line
  reads **"24 h window"**.

## RIDE and LIMITER

- **RIDE** is the loudness ride's correction: how much it is turning the programme **up** (+) or **down** (−) to
  reach the target, drawn around a centre line up to the Clamp you set.
- **LIMITER** is how hard the limiter is holding peaks down: the deepest reduction in each moment, a white tick
  that holds the recent peak for 2 s, and **max 10 s** — the deepest in the last ten seconds, because a seam
  is over before you can read a moving bar.
- **OFF** (hatched) means that output's processing is not running, so there is nothing to show — it is never
  drawn as "0 dB".
- On the Monitor row, **room chain** means an aux deck is playing: the local output then comes from the room
  chain's own processor, and that is the one being metered.

## The ceiling

The limiter's **Ceiling** label says what it does, for example **"−1.0 dBTP set · limits at −2.2 dBTP"**. The
limiter holds peaks about 1.2 dB below the setting (a safety margin). **True peak max** shows where your
output actually lands.

## If something looks wrong

- **"incomplete: N s not measured"** — the computer was too busy for the meter to keep up for that long, so
  Integrated is missing that audio. The sound was not affected. Reset to start a clean measurement.
- **NOT FED** (hatched over M and S) — no audio is reaching that output's meter.
- **"no meter data from the engine"** — the audio engine is not reporting loudness. If EtherCast has just
  updated, fully close it and reopen it (the audio engine does not reload on its own).
- **OUT on the rows reads differently from before** — it is now measured on what the output sent; it used to
  be an estimate that never saw the limiter.

## Not in this version (by design)

- No automatic reset at the start of a show yet — that needs the engine to know when a show starts. It will
  come as a setting, off unless you turn it on.
- No loudness per channel — this measures the outputs.
- No loudness log or compliance report.

## Related

- **Audio Processing** (`docs/help-audio-processing.md`) — the ride, the limiter and their settings.
- **Reading the Meters** (`docs/help-meters.md`) — the channel and output level meters.
