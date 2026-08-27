# Segue overlap (no dead air between songs)

**What it does:** starts the **next song a few seconds before the current one ends**, so the two briefly
overlap and the music never drops to silence between tracks. The songs play over each other's natural
endings — there are **no fades and nothing touches your faders**.

There are two separate settings in **Settings → Audio**:

- **Segue overlap (auto)** — the NEW one. How many seconds the next song starts **before** the current one
  ends, while the station is running itself (AUTO / on air). This is the one that keeps your station tight
  with no gaps.
- **Manual crossfade (X key)** — the OLD one, just relabelled. Only affects the crossfade **you** trigger with
  the **X** key (or AUTO-X). It does not affect automatic segues.

## Set it up

1. Open **Settings** (bottom bar) → the **Audio** section.
2. Find **Segue overlap (auto)**.
3. Drag the slider to how many seconds early the next song should start:
   - **3s** (default) — a natural, tight segue.
   - **1–2s** — a very short overlap.
   - **4–6s** — a longer overlap (the songs blend more).
   - **0 (off)** — the next song waits for the current one to fully end (a clean, gap-free hard start).
4. That's it — it takes effect on the next transition.

## How it works

- The next song **starts at full** while the current song plays out its **own ending** — both are heard for
  the overlap you chose, then the outgoing song finishes on its own.
- **Your faders never move.** The deck faders are yours; automation never touches them. Songs bring their own
  mastered fade-outs — the overlap just lets the next one begin over that tail.
- **Sweepers overlap too.** When a sweeper plays over a transition, the next song starts early **under** the
  sweeper instead of waiting for the sweeper to finish — no more sweeper-playing-alone gap.

## Tips

- If there's a **beat of silence** between songs, raise the overlap a second or two (or check that your next
  track is cued/ready).
- If songs **step on each other** too much, lower it to 1–2s.
- Use **0 (off)** only if you want each song to start cleanly after the last one ends.
- The **X key** crossfade is separate — set that for how a *manual* crossfade sounds when you do it by hand.

## Where the setting lives

The Segue overlap is remembered on this machine and sent to the audio engine automatically — including after
an app update or restart — so your station keeps segueing the way you set it.
