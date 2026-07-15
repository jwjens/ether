# Segue crossfade (smooth song-to-song transitions)

**What it does:** makes every automatic song change overlap smoothly — the song that's ending fades down
while the next one comes up, so the music never stops. This is the classic radio "segue."

There are now **two** crossfade settings in **Settings → Audio**, and they do different things:

- **Segue crossfade (auto)** — the NEW one. Controls **every automatic song-to-song transition** while the
  station is running itself (AUTO / on air). This is the one you want for a smooth-sounding station.
- **Manual crossfade (X key)** — the OLD one, just relabelled. Controls only the crossfade **you** trigger
  by pressing the **X** key (or AUTO-X). It does not affect automatic segues.

## Set it up

1. Open **Settings** (bottom bar) → the **Audio** section.
2. Find **Segue crossfade (auto)**.
3. Drag the slider to how many seconds you want the overlap to last:
   - **3s** (default) — a natural radio segue.
   - **1–2s** — a tight, quick blend.
   - **5–10s** — a long, gentle wash (good for softer formats).
   - **0 (hard)** — no overlap at all; each song stops dead and the next begins (a "hard cut").
4. That's it — the change takes effect on the next song transition. Nothing else to save.

## How it sounds

- The outgoing song **fades out** over the seconds you chose while the next song **starts at full**. At no
  point is there silence.
- **Jingles ride the same fade.** When a jingle plays over a transition, the outgoing song fades down under
  the jingle and the next song comes up under the jingle's tail — one continuous weave, no dead gap where the
  jingle plays alone.

## Tips

- If transitions sound **abrupt**, raise the Segue crossfade a second or two.
- If songs sound like they **mush together**, lower it (or use 1–2s).
- Use **0 (hard)** only if your format wants every song to start cleanly with no blend.
- The **X key** crossfade is separate — set that one for how fast a manual crossfade should be when you do it
  by hand.

## Where the setting lives

The Segue crossfade is remembered on this machine and is sent to the audio engine automatically — including
after an app update or restart, so your station keeps segueing the way you set it.
