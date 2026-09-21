---
feature: sweepers
title: Sweepers & Sweepers
summary: Station IDs, stingers and sweepers that fire as an overlay on the seam between songs — assigned per music category.
where: Bottom bar → SWEEPERS (next to Categories)
since: 4.4.57
audience: operator
tour: true
---

# Sweepers & Sweepers

> **Help corpus template.** First entry in EtherCast's built-in help — plain language, step-by-step, no
> jargon — the format the Iris tour layer reads verbatim. Every feature ships a `docs/help/<feature>.md`
> written this way. Keep the section order below.

## What it is

**Sweepers** and **sweepers** are short imaging — station IDs, stingers, "you're listening to…" drops. They
don't sit on a deck and never interrupt the music: they **fire as an overlay** on the seam between two songs,
riding over the tail of the outgoing song and the head of the incoming one. Nothing stops, nothing skips.
(Sweeper = teal, Sweeper = indigo — same idea, two labels for how you produce them.)

The v2 model is **assignment by category**: you decide, per music category, whether songs in it get imaging —
a **specific** cut ("always THIS ID on the Power Gold") or a **rotating pool** (variety, no burnout). Some
categories get a sweeper, some a sweeper, some nothing.

## When to use it

Imaging between songs on a per-category basis. A full commercial or scheduled break is a **Spot**, not this.

## Set it up (bottom bar → SWEEPERS)

The **SWEEPERS** button in the bottom bar (next to Categories) opens this home. The SWEEPERS fader on the live screen also shows **"Set up sweepers →"** when unconfigured — it jumps
you here.

1. **Tag your imaging.** In the **Library**, right-click a cut and choose **"Mark as Sweeper (JIN)"** or
   **"Mark as Sweeper (SWP)"**. Tagged items appear in this panel.
2. **Build pools (optional but recommended).** On the **SWEEPERS / SWEEPERS** tabs, add a pool (e.g. "Station
   IDs") and drop several tagged cuts into it. A pool **rotates least-recently-played**, so the same cut
   doesn't repeat too soon — that's your burnout protection. Cuts of different lengths can share a pool
   freely; length is never an input to the seam.
3. **Assign per category — the core.** In **Category assignments**, each music category has an **Overlay**
   dropdown: pick **None**, a **specific** sweeper/sweeper, or a **pool**. Set **LEAD** for that category
   (see below) and **Active hours** (default Always) to keep imaging out of hours where it doesn't belong.
4. **Fill Day.** Sweepers are placed on the song seams when the log is filled (Program Log →
   Fill Day). On air they fire automatically.

## LEAD — the one number

Every category row has a **LEAD (s)** box: **how many seconds before the next song starts that this
category's sweeper fires.** That is the only timing decision the engine takes from you, and it is the only
one it needs.

**The sweeper belongs to the song it introduces, not the one it follows.** You assign it to a category, and
it plays ahead of every song in that category — over the tail of whatever happened to come before. That is
what makes the copy mean something: "new music next" is about the record that's starting.

Everything else follows from LEAD. The next song starts exactly when it would with no sweeper on the seam at
all. The sweeper plays on over its opening and **ends when it ends**. Where it lands in the song is
arithmetic, not a setting:

> A song with LEAD 3. The sweeper starts 3 seconds before that song does. If the sweeper runs 6 seconds, it
> ends 3 seconds into the record. A 10-second sweeper on the same seam ends 7 seconds in. Nothing is
> configured for that — it just follows from the sweeper's own length.

So sweepers of every length live happily in the same pool. How a cut sounds over the tail is an imaging
decision — yours and your imaging director's — not something the engine second-guesses.

**A greyed box is the station default, not an empty box.** When a category has no setting of its own, the
box still shows the number that is actually airing (2) in grey, so you can always see what is running. Type
over it and the box brightens: that category now has its own number. Clear the box and it goes back to grey
and follows the station default again.

Changes take effect on the **next Generate** — the number is written onto each placement when the schedule
is built, so a song already scheduled keeps the LEAD it was scheduled with.

One practical floor: the engine checks the deck four times a second, so a LEAD under about **1s** can be
missed. Above that, use whatever suits the imaging.

## Fallback (optional)

Set a **station-level fallback pool** for any category you didn't assign. Leave it **None** and unassigned
categories play a **clean segue** — silence between songs is a legitimate programming choice here, **never an
error**. Nothing warns you; nothing is placed.

## How it behaves on air

- The deck bridging the overlay shows a small third-line indicator, labelled with the class (**JIN** or
  **SWP**), that tells you exactly where the imaging is in its lifecycle:
  - **Grey = scheduled** — shown from the moment the song starts, a read-ahead that a sweeper is placed for
    this song's upcoming seam.
  - **White = armed** — the seam is imminent (within ~30s of the end); the sweeper is loaded and ready.
  - **Yellow (blinking) = firing** — the sweeper is on air right now.
- The **Health Monitor** shows the same armed/firing state per station.
- The **SWEEPERS fader** on the live screen **lights up while imaging is actually on air** — its label and
  **ON** button brighten for the length of the sweeper or cart, then settle back.

## Turning the imaging channel off (the ON button)

The **ON** button on the SWEEPERS fader is a **channel on/off**, exactly like the OFF switch on a board
channel. It is not a play button and not a light.

- **ON (lit)** — imaging and carts pass to air normally.
- **OFF (unlit)** — the channel is **cut**. Sweepers and carts still fire on schedule, but **no audio from
  them reaches air**. Nothing else is affected: music, spots and the decks keep playing untouched.

Use it when you want a clean run with no imaging — a special broadcast, a live remote, a memorial — without
tearing down your pools or assignments. Turn it back ON and imaging resumes on the next fire.

The setting is **remembered per station**, so it survives closing and reopening the app. Each station has
its own — cutting imaging on one station does not cut it on another. **If your imaging has gone silent,
check this button first.**

When the channel is off the fader dims but stays usable — that is "switched off," not broken. You can still
set the level while it is off; it takes effect when you turn the channel back on, and turning the channel
off and on **never moves your fader**. See **Channel Faders and Channel Cut** for how this works on every
channel strip.
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
- **Next to a commercial?** It fires. The engine used to suppress imaging on any seam touching a spot; it no
  longer makes that judgement. If you don't want imaging around a break, that's what **Active hours** and the
  category's **Overlay = None** are for.

## Not in this version (by design)

- **Trailing links** — v2 is *Leading* imaging (introduces what's next). Outro-over-the-tail comes later.
- **Produced / semi / dry variants** — a production practice: drop the different cuts into one pool and
  rotation handles the variety. No separate setting.

## Related

- **Spots** — scheduled commercials/breaks (different from imaging).
- **Clocks / Generate** — where the schedule (and overlay placements) are built.
