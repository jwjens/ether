---
feature: log-editing
title: "Editing the log by hand"
summary: How to drag, pin and remove songs in a day's log, what the YOURS badge means, and why Generate no longer undoes your work.
where: Calendar → click a day
since: 4.4.196
audience: operator
tour: true
---

# Editing the log by hand

Open the **Calendar** and click any day. The hour-by-hour list you get is now a list you can change.

## The one rule worth knowing

**Anything you touch becomes yours, and Generate leaves it alone.**

Before this, pressing **Generate** rebuilt the whole day and threw away every change you had made.
Now Generate only fills the **empty** places. Your rows stay exactly where you put them, no matter how
many times you regenerate.

## Moving a song

**Drag it onto another row.** The two swap times — the one you dragged goes where the other was, and
that one comes back to where yours started.

As you drag, the row under your pointer lights up purple with a ring around it and a chip reading
**⇄ SWAP WITH 3:42 PM** — the time your dragged row is leaving. That is your drop target: release
there and those two rows trade places.

> **Why a highlight and not a line between rows?** Because a line between two rows would mean
> "insert here and push everything down", and that is not what happens. Ether swaps the two rows and
> leaves the rest of your day exactly where it is. The highlight shows you the row you are trading
> with, which is what actually takes place.

Both rows now show a purple **YOURS** badge. Nothing else in the day moves, **and the screen stays
exactly where you were** — you can make a run of edits in the 3 PM hour without being thrown back to
midnight between each one.

> **Why a swap and not a shuffle-everything-down?** Because moving one song by three minutes would
> otherwise push the whole rest of the day out of place, including your spot breaks and top-of-hour.
> A swap changes exactly two things and leaves the rest of your day where you put it.

## Pinning a song where it is

Sometimes a song is already in the right place and you just want Generate to stop replacing it.

Click the **📍 pin** on the row. It turns into **📌** and the row gets the **YOURS** badge. Nothing
moves — you have simply told Generate "hands off this one".

Click **📌** again to release it. The badge disappears and the row goes back to being the scheduler's
to manage.

## Removing a song

Click the **✕**. The song comes out of the log and leaves a hole.

The next time you press **Generate**, that hole is filled with a fresh song chosen by your clock and
your rotation rules — exactly as if the scheduler had picked it in the first place. So "remove it and
regenerate" is how you say *"not this one, give me something else"*.

## The YOURS badge and the day counter

- A purple **YOURS** badge on a row means you placed, moved or pinned it. Generate will not move,
  replace or remove it.
- At the top of the day you will see **"N yours — Generate won't touch"**.

**Keep an eye on that number.** If most of a day is yours, Generate has very little left it is allowed
to fill, and it will look like it is doing nothing. That is not a fault — it is doing what you asked.
Release a few rows with **📌** if you want the scheduler to help again.

## Rule warnings

If a move puts a song too close to another by the same artist, the same title, or the same song, an
**amber note** appears under that hour:

> *Landslide — Same artist "Fleetwood Mac" 10 min away (rule: 60 min)*

**The move still happened.** This is a heads-up, not a refusal. You know your station and there are
good reasons to break a separation rule — a themed set, an artist feature, a request. Ether tells you
what it noticed and then gets out of your way.

The warning uses the same rules Generate uses, so it means the same thing your scheduler means.

## What you cannot edit

**Songs that have already aired.** Once a song has played, its row is dimmed and has no controls. You
cannot drag it, pin it or remove it.

This is deliberate and it is not negotiable: that row is no longer a plan, it is the **record of what
your station actually broadcast**. It feeds your as-run log and your advertiser affidavits. A log you
can edit after the fact is a log nobody can trust — including you.

## Frequently hit questions

**I regenerated and my changes are still there. Is that right?**
Yes. That is the whole point of this feature.

**I regenerated and nothing new appeared.**
Check the "N yours" count. If every slot is yours, there is nowhere for Generate to put anything.

**I deleted a song and it came back.**
It did not — a *different* song was chosen for that gap by your clock and rotation rules. That is what
regenerating a gap does. If you want the slot empty, leave it deleted and do not regenerate.

**Can I edit a different station's log from here?**
Only the station you are currently in. Editing is scoped to the active station, and pinning a row on
one station never affects another.

## Related

- **Generate** — builds the log from your clocks and rotation rules. It now fills gaps rather than
  rebuilding days.
- **Health Monitor** — every edit is recorded as a `log-edit` event, and a Generate that preserved
  your rows records how many it kept.
