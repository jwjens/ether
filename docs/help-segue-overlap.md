---
feature: segue-overlap
title: Segue overlap (no dead air between songs)
summary: Starts the next song a few seconds before the current one ends, so the two overlap on the outgoing song's own ending and the music never drops to silence. No fades, and your faders never move.
where: File → Preferences → Audio → Audio Devices → "Segue overlap (auto)"
since: 4.4.74
audience: operator
tour: true
---

# Segue overlap (no dead air between songs)

## What it is

Segue overlap starts the **next song a few seconds before the current one ends**, so the two briefly
overlap and the music never drops to silence between tracks. The songs play over each other's natural
endings — there are **no fades and nothing touches your faders**.

It is one setting, **Segue overlap (auto)**, and it applies while the station is running itself
(AUTO / on air).

## Set it up

1. Open **File → Preferences** → the **Audio** section → **Audio Devices**.
2. Find **Segue overlap (auto)**.
3. Drag the slider (0–10 seconds) to how many seconds early the next song should start:
   - **3s** (default) — a natural, tight segue.
   - **1–2s** — a very short overlap.
   - **4s and up** — a longer overlap (the songs blend more).
   - **0 (off)** — the next song waits for the current one to fully end (a clean hard start).
4. That's it — it takes effect on the next transition.

## How it works

- The next song **starts at full** while the current song plays out its **own ending** — both are heard for
  the overlap you chose, then the outgoing song finishes on its own. Nothing cuts it short.
- **Your faders never move.** The deck faders are yours; automation never touches them. Songs bring their own
  mastered fade-outs — the overlap just lets the next one begin over that tail.
- **Sweepers ride the same seam.** A sweeper's LEAD is timed against this overlap, so it lands on the start
  of the song it introduces (see **Sweepers**).
- **Never into or out of a spot.** A commercial is exclusive program content: the overlap is not applied at
  a spot's edges, so spots start and end clean.

## Tips

- If there's a **beat of silence** between songs, raise the overlap a second or two (or check that your next
  track is cued/ready).
- If songs **step on each other** too much, lower it to 1–2s.
- Use **0 (off)** only if you want each song to start cleanly after the last one ends.

## Where the setting lives

The segue overlap is **stored with the station**, not with this computer. Every machine running the station
segues the same way, and the audio engine reads it automatically — including after an app update or restart.
Each station has its own value.

## Related

- **Sweepers** (`docs/help-sweepers.md`) — imaging that plays over the seam this setting creates.
