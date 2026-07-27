---
feature: audio-processing
title: Audio Processing (Loudness & Limiter)
summary: Per-station loudness ride to a target (EBU R128) plus a −1 dBTP true-peak limiter on the program bus — opt in for the local monitor, the stream, or both.
where: Settings → Broadcast → Audio Processing
since: 4.4.91
audience: operator
tour: true
---

# Audio Processing (Loudness & Limiter)

## What it is

Audio Processing keeps your station at a **consistent loudness** and stops it from **clipping**. It works on
the **program bus** — the single mix that feeds both your studio monitor and the stream — so every song, jingle
and spot lands at the same perceived level instead of some tracks sounding quiet and others jumping out.

Two things happen, in order:

1. **Loudness ride** — the level is measured continuously (EBU R128 / LUFS, the broadcast-standard loudness
   scale) and gently nudged toward your **target** (default **−14 LUFS**, the streaming norm). It rides slowly,
   so you hear even loudness, not pumping.
2. **True-peak limiter** — a final safety catch holds the peaks at **−1 dBTP** so the stream never clips or
   distorts, no matter what the ride does.

Both are **OFF by default**. With both off, the audio passes through **bit-for-bit unchanged** — turning this
on is always your choice, per station.

## When to use it

- Turn on **Process stream** when listeners tell you the station is too quiet, too loud, or jumps around in
  level between songs.
- Turn on **Process local output** if you want your **studio monitor** to hear the same processed sound the
  stream gets (otherwise your monitor stays clean/unprocessed).
- Leave both off if you already loudness-normalize your library elsewhere and want an untouched signal.

## Set it up (Settings → Broadcast → Audio Processing)

1. Open **Settings** (gear) → the **Broadcast** category → **Audio Processing**.
2. **Process local output** — apply processing to THIS machine's speaker/monitor output only. The stream is
   unaffected. Use this to monitor the processed sound.
3. **Process stream** — apply processing to the Icecast stream — **what your listeners hear**.
4. **Target loudness** — the loudness the ride aims for. **−14 LUFS** is the streaming standard; louder
   (e.g. −12) is more aggressive, quieter (e.g. −16) is gentler. The limiter always holds −1 dBTP regardless.

Each setting is **per station** and takes effect within a few seconds — no restart. Switch stations and set
each one independently.

## The live meters

When either toggle is on, a **Live meters** panel appears:

- **IN LOUDNESS / OUT LOUDNESS** — the LUFS before and after processing. OUT should sit near your target.
- **peak (dBFS)** — the loudest sample at each stage.
- **GAIN REDUCTION** — how hard the limiter is working right now (in dB). A little movement on peaks is
  normal; constant heavy reduction means your target is set too loud.

The meters read live off the engine — they show what's **actually** happening on air, not a prediction. If
they say "waiting for audio…", nothing is playing yet.

## How it behaves on air

- Processing runs on the program bus, so it covers **everything** — songs, jingles, sweepers, spots.
- It does **not** move any deck fader or change your mix; it only shapes the final program level.
- Changing the target or a toggle applies on the fly; the ride eases in, it doesn't jump.

## If you don't hear a difference

- Confirm the right toggle is on for what you're checking (**stream** vs **local monitor** are separate).
- Give the ride a few seconds — it moves slowly on purpose.
- Very quiet source material (well below the target) is lifted up to a point, then held; extremely loud
  material is caught by the limiter (watch GAIN REDUCTION move).

## Not in this version (by design)

- No multiband / EQ / compression curves — this is a **loudness ride + true-peak limiter**, not a full
  processing chain.
- The limiter ceiling (−1 dBTP) is fixed; only the loudness **target** is adjustable.

## Related

- **Broadcast delay & DUMP** (Settings → Broadcast) — profanity delay on the stream path.
- **Categories / Clocks** — programming that feeds the program bus this processes.
