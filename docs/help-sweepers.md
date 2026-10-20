---
feature: sweepers
title: Sweepers
summary: Station IDs, stingers and sweepers that fire as an overlay on the seam between songs — assigned per music category.
where: Bottom bar → SWEEPERS (next to CATEGORIES)
since: 4.4.57
audience: operator
tour: true
---

# Sweepers

> **Help corpus template.** First entry in EtherCast's built-in help — plain language, step-by-step, no
> jargon — the format the Iris tour layer reads verbatim. Every feature ships a `docs/help-<feature>.md`
> (a flat file directly in `docs/`, no subfolders) written this way. Keep the section order below.

## What it is

**Sweepers** are short imaging — station IDs, stingers, "you're listening to…" drops. They don't sit on
a deck and never interrupt the music: they **fire as an overlay** on the seam between two songs, riding
over the tail of the outgoing song and the head of the incoming one. Nothing stops, nothing skips.
There is one kind of imaging — the sweeper — shown in indigo with an **SWP** badge. (Older rows once
tagged as "jingles" are treated as sweepers.)

Imaging is **assigned by category**: you decide, per music category, whether songs in it get imaging —
a **specific** sweeper ("always THIS ID on the Power Gold") or a **rotating pool** (variety, no
burnout). Some categories get imaging, some get nothing. **The dropdowns are the only thing that decides:** a
category set to **none** never gets a sweeper, and a category set to a pool or a sweeper gets one on every seam
inside its active hours.

## When to use it

Imaging between songs on a per-category basis. A full commercial or scheduled break is a **Spot**, not this.

## Set it up (bottom bar → SWEEPERS)

The **SWEEPERS** button in the bottom bar (next to CATEGORIES) opens this home. It has two tabs:
**MANAGE** (pools and assignments) and **ADD IMAGING — CUT A REEL** (the Reel Splitter).

1. **Tag your imaging.** In the **Library**, right-click a cut and choose **Mark as Sweeper**. Tagged
   items appear in this panel. (Right-click again → **Unmark Sweeper (→ Music)** to undo.)
2. **Build pools (optional but recommended).** Type a name in **New sweeper pool** (e.g. "Legal IDs"),
   add it, and put several tagged cuts into it. A pool **rotates least-recently-played**, so the same cut
   doesn't repeat too soon — that's your burnout protection. Cuts of different lengths can share a pool
   freely; length is never an input to the seam. To rename a cut, pick its pool and press **EDIT** beside
   the cut's name — the new name shows everywhere, the Library included.
3. **Assign per category — the core.** In **Category assignments**, each music category has an **OVERLAY**
   dropdown: pick **— none (no sweeper) —**, a **specific sweeper**, or a **sweeper pool**. Set
   **LEAD (s)** for that category (see below) and **ACTIVE HOURS** (default **Always**) to keep imaging
   out of hours where it doesn't belong.
4. **It's live.** Every change is saved straight away and applied to the log ahead at once — no Fill Day
   needed. A line under the assignments says what happened, e.g. *"KIDS: sweeper saved. Log ahead updated:
   212 sweepers placed (198 replaced)."* If a change could not be saved, that line says so in red, and the
   dropdown shows what is really stored. Sweepers already aired and sweepers you placed by hand are never
   touched. One sweeper already loaded for the very next seam (the last 90 seconds or so) may still play.
5. **Fill Day** places sweepers the same way when it builds the log. On air they fire automatically.

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

Changes apply to the log ahead **at once**, like every other control here.

Two practical limits:

- **Floor:** the engine checks the deck four times a second, so a LEAD under about **1s** can be missed.
- **Ceiling:** the box stops at **90 seconds minus your segue overlap** — the engine gets a sweeper ready
  90 seconds before the end of a song, so that is the most lead it can honour. Hover the LEAD box to see
  the exact maximum.

## No station fallback

Earlier versions had a **Fallback for unassigned categories** pool. It is gone: it put sweepers on every
category set to none, so the dropdowns said one thing and the air did another. Now **none means none** — a
clean segue, a legitimate programming choice, **never an error**. If a station used the fallback, set each
category's dropdown to the pool you want.

## AUTO-POST (station switch)

Under the assignments, **AUTO-POST** is one switch for the whole station. **OFF** (the default): sweepers
start **LEAD** seconds before the seam, as above. **ON**: a sweeper from a **pool** is timed to **end
exactly where the next song's vocal starts** — its **post**, the intro marker you set in the cue editor —
and Ether picks a cut from the pool short enough to fit.

- A song with **no post marked** uses LEAD instead.
- A category assigned a **specific sweeper** (not a pool) uses LEAD.
- A seam where **no cut in the pool is short enough** gets **no sweeper** — a cut that doesn't fit would
  have to talk over one of the two songs.

Like LEAD, it applies to the log ahead **at once**.

## How it behaves on air

- In **Up Next**, a scheduled sweeper appears as **its own row, directly above the song it introduces**,
  with an **SWP** badge, its title and its length:
  - **Category colour = scheduled** — it is placed for this seam.
  - **White = armed** — the seam is coming up (within about 90 seconds); the sweeper is loaded and ready.
  - **Yellow (blinking) = firing** — the sweeper is on air right now.
  - **at seam** — the element before it is a commercial, so the sweeper starts exactly at the seam
    instead of over the end of the spot.
  - **FILE MISSING — WILL NOT PLAY** (title struck through) — the sweeper's audio is not on this
    computer, so it will be skipped.
- Sweepers are logged in Play History but **kept out of music reports and rotation math** — they never
  count as a song play or block an artist.

## Turning the imaging channel off (the ON button)

Sweepers and carts reach air through their own board channel. Its **ON** button is a **channel on/off**,
exactly like the OFF switch on any board channel. It is not a play button and not a light.

- **ON (lit)** — imaging and carts pass to air normally.
- **OFF (unlit)** — the channel is **cut**. Sweepers and carts still fire on schedule, but **no audio from
  them reaches air**. Nothing else is affected: music, spots and the decks keep playing untouched.

Use it when you want a clean run with no imaging — a special broadcast, a live remote, a memorial — without
tearing down your pools or assignments. Turn it back ON and imaging resumes on the next fire.

The setting is **remembered per station**. Each station has its own — cutting imaging on one station does
not cut it on another. **If your imaging has gone silent, check this button first.**

When the channel is off the fader dims but stays usable — that is "switched off," not broken. You can still
set the level while it is off; it takes effect when you turn the channel back on, and turning the channel
off and on **never moves your fader**. See **Channel Faders** (`docs/help-channel-faders.md`) for how this
works on every channel strip.

## If you don't see any imaging

**Look at the Health Monitor first.** Each station's **Sweepers** row counts what was placed, fired and skipped
today, and says why each skip happened; it turns red if none fired in the last hour of air.

- **Nothing assigned?** A category with **OVERLAY = none** plays a clean segue by design.
- **No tagged cuts / empty pool?** Mark cuts as sweepers in the Library and put them in a pool.
- **Wrong hour?** Check the category's **ACTIVE HOURS** — it may be gated out of the current hour.
- **Is there a log?** Sweepers are placed on the songs in the log. With no log ahead there is nothing to place
  them on — Fill Day first.
- **FILE MISSING in Up Next?** The sweeper's audio isn't on this computer; it will not play.
- If a sweeper is armed but the song is skipped or the hour hard-cuts at :00, it cancels cleanly and re-arms
  for the next seam — that's expected.
- **Next to a commercial?** A sweeper after a spot still fires, but **at the seam** (lead 0), never over the
  end of the commercial. If you don't want imaging around a break, that's what **ACTIVE HOURS** and the
  category's **OVERLAY = none** are for.

## Not in this version (by design)

- **Trailing links** — imaging is *Leading* (introduces what's next). Outro-over-the-tail comes later.
- **Produced / semi / dry variants** — a production practice: drop the different cuts into one pool and
  rotation handles the variety. No separate setting.

## Related

- **Spots** (`docs/help-spots.md`) — scheduled commercials/breaks (different from imaging).
- **Segue overlap** (`docs/help-segue-overlap.md`) — the seam a sweeper plays over.
- **Reel Splitter** (`docs/help-reel-splitter.md`) — cutting a reel into sweepers (the ADD IMAGING tab).
- **Clocks / Generate** — where the schedule (and sweeper placements) are built.
