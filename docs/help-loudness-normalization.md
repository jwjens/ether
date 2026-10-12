---
feature: loudness-normalization
title: Loudness Normalization
summary: Every file on any fader — songs, sweepers, carts, announcements, the jukebox — plays at one loudness you set, so a sweeper or cart is never louder than the music just because the file was mastered hot.
where: ☰ Menu → Preferences → Loudness & fader smoothing
since: 4.6.59
audience: operator
tour: true
---

# Loudness Normalization

## What it is

Audio files are mastered at very different loudness. On 2026-10-11 a song measured −15.8 LUFS, a sweeper −9.6 and
a cart −7.3, so the cart played about 8 dB louder than the music at the same fader.

Ether now measures every file once and plays it at the same loudness: your **Loudness target**. The rule is the
same for every file on every fader. There are no exceptions by type, and no per-file trims.

## How to use it

1. Open **☰ Menu → Preferences → Loudness & fader smoothing**.
2. **Loudness target** shows the current value (−16 LUFS unless you change it). Type a new value and press **Save**.
   - −16 LUFS is a common target for internet radio. −14 is louder, −18 quieter.
   - Range −40 to −5.
3. The new target applies to every file **from its next load**. What is playing now is not changed mid-play.

The line under it shows how many files have been measured, and how many are waiting.

## Things worth knowing

- **Measuring happens in the background,** at low priority. It never delays or interrupts what is on air. A file is
  measured once; a copy of the same file is not measured again, and an edited file is measured again.
- **New files are measured when you import them.** Files already in the library are measured over the first minutes
  after Ether starts.
- **Your faders still mean what they say.** Normalization evens out the files *underneath* the fader, so 0 dB on a
  fader is the same loudness whatever you put on it.
- **Live inputs (a mic, a Link feed) are not files.** Their level is set by their own input gain.
- **Everything still goes through the same processing on air** (Settings → Broadcast → the rack). Normalization
  makes sure every file arrives there at the same loudness.

## If something looks wrong

- **The Health Monitor shows "Loudness unmeasured skipped".** A file aired before it had been measured, so it played
  as it is, and it is now queued. It is normal right after an update or an import. If it keeps appearing for the same
  file, tell support.
- **"Loudness gain limited skipped".** The file is so loud or so quiet that it needed more change than the engine
  allows (−20 dB to +12 dB). It played at the nearest allowed level. Consider replacing that file.

## Related

- Channel Faders (`docs/help-channel-faders.md`): the fader scale and smoothing.
- Health Monitor (`docs/help-health-monitor.md`).
