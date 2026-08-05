---
feature: jingles
title: Jingles & Sweepers
summary: Station IDs, stingers and sweepers that fire as an overlay on the seam between songs — assigned per music category.
where: Bottom bar → JINGLES (next to Categories)
since: 4.4.57
audience: operator
tour: true
---

# Jingles & Sweepers

> **Help corpus template.** First entry in EtherCast's built-in help — plain language, step-by-step, no
> jargon — the format the Iris tour layer reads verbatim. Every feature ships a `docs/help/<feature>.md`
> written this way. Keep the section order below.

## What it is

**Jingles** and **sweepers** are short imaging — station IDs, stingers, "you're listening to…" drops. They
don't sit on a deck and never interrupt the music: they **fire as an overlay** on the seam between two songs,
riding over the tail of the outgoing song and the head of the incoming one. Nothing stops, nothing skips.
(Jingle = teal, Sweeper = indigo — same idea, two labels for how you produce them.)

The v2 model is **assignment by category**: you decide, per music category, whether songs in it get imaging —
a **specific** cut ("always THIS ID on the Power Gold") or a **rotating pool** (variety, no burnout). Some
categories get a jingle, some a sweeper, some nothing.

## When to use it

Imaging between songs on a per-category basis. A full commercial or scheduled break is a **Spot**, not this.

## Set it up (bottom bar → JINGLES)

The **JINGLES** button in the bottom bar (next to Categories) opens this home. The JINGLES fader on the live screen also shows **"Set up jingles →"** when unconfigured — it jumps
you here.

1. **Tag your imaging.** In the **Library**, right-click a cut and choose **"Mark as Jingle (JIN)"** or
   **"Mark as Sweeper (SWP)"**. Tagged items appear in this panel.
2. **Build pools (optional but recommended).** On the **JINGLES / SWEEPERS** tabs, add a pool (e.g. "Station
   IDs") and drop several tagged cuts into it. A pool **rotates least-recently-played**, so the same cut
   doesn't repeat too soon — that's your burnout protection. Give each pool a **lead-in** and **underlap**.
3. **Assign per category — the core.** In **Category assignments**, each music category has an **Overlay**
   dropdown: pick **None**, a **specific** jingle/sweeper, or a **pool**. Set **Active hours** (default
   Always) to keep imaging out of hours where it doesn't belong.
4. **Generate.** Jingles/sweepers are placed on the song seams when you Generate the schedule (Calendar →
   Generate). On air they fire automatically.

## The two timing numbers

- **Lead-in (seconds)** — how far *before* the outgoing song ends the overlay starts. Default: jingle **5s**,
  sweeper **2s**.
- **Underlap (seconds)** — how far *before* the overlay ends the next song starts. Default: jingle **2s**,
  sweeper **1s**.

## Fallback (optional)

Set a **station-level fallback pool** for any category you didn't assign. Leave it **None** and unassigned
categories play a **clean segue** — silence between songs is a legitimate programming choice here, **never an
error**. Nothing warns you; nothing is placed.

## How it behaves on air

- The deck bridging the overlay shows a small third-line indicator, labelled with the class (**JIN** or
  **SWP**), that tells you exactly where the imaging is in its lifecycle:
  - **Grey = scheduled** — shown from the moment the song starts, a read-ahead that a jingle is placed for
    this song's upcoming seam.
  - **White = armed** — the seam is imminent (within ~30s of the end); the jingle is loaded and ready.
  - **Yellow (blinking) = firing** — the jingle is on air right now.
- The **Health Monitor** shows the same armed/firing state per station.
- The **JINGLES fader** on the live screen **lights up while imaging is actually on air** — its label and
  **ON** button brighten for the length of the jingle or cart, then settle back.

## Turning the imaging channel off (the ON button)

The **ON** button on the JINGLES fader is a **channel on/off**, exactly like the OFF switch on a board
channel. It is not a play button and not a light.

- **ON (lit)** — imaging and carts pass to air normally.
- **OFF (unlit)** — the channel is **cut**. Jingles and carts still fire on schedule, but **no audio from
  them reaches air**. Nothing else is affected: music, spots and the decks keep playing untouched.

Use it when you want a clean run with no imaging — a special broadcast, a live remote, a memorial — without
tearing down your pools or assignments. Turn it back ON and imaging resumes on the next fire.

The setting is **remembered per station**, so it survives closing and reopening the app. Each station has
its own — cutting imaging on one station does not cut it on another. **If your imaging has gone silent,
check this button first.**

When the channel is off the fader dims but stays usable — that is "switched off," not broken. You can still
set the level while it is off; it takes effect when you turn the channel back on.
- Overlays are logged in Play History but **kept out of music reports and rotation math** — they never count
  as a song play or block an artist.

## If you don't see any imaging

- **Nothing assigned?** A category with **Overlay = None** and no station fallback plays a clean segue by
  design.
- **No tagged cuts / empty pool?** Tag JIN/SWP in the Library and put cuts in the pool.
- **Wrong hour?** Check the category's **Active hours** — it may be gated out of the current hour.
- **Did you Generate?** Placements happen at Generate time. Regenerate after changing an assignment.
- If an overlay is armed but the song is skipped or the hour hard-cuts at :00, it cancels cleanly and re-arms
  for the next seam — that's expected.

## Not in this version (by design)

- **Trailing links** — v2 is *Leading* imaging (introduces what's next). Outro-over-the-tail comes later.
- **Produced / semi / dry variants** — a production practice: drop the different cuts into one pool and
  rotation handles the variety. No separate setting.

## Related

- **Spots** — scheduled commercials/breaks (different from imaging).
- **Clocks / Generate** — where the schedule (and overlay placements) are built.
