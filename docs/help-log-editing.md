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

Open the **Calendar** and click any day. What you get is a spreadsheet of the day's log — **Time,
Type, Title, Artist, Category, Status** — that you can sort, resize and edit.

## Reading the sheet

- **Hour markers** — `⏤ 3:00 PM ⏤` separates each hour.
- **The thin coloured bar** on the left of each row is its type: Song, Spot, Sweeper, Sweeper, Voice,
  Cart. Muted on purpose — it should be readable at a glance, not shout.
- **Dimmed rows** have already aired.
- **Click any column header** to sort by it. Shift-click adds a second sort.
- **Drag a column's edge** to resize it. Your widths are remembered for this station on this
  computer.

### Sorting turns dragging off, on purpose

A log is time-ordered — that is what makes it a log. If you sort by Artist and then drag row 3 onto
row 7, you would be swapping two unrelated airtimes with nothing on screen to tell you so.

So when you sort by anything other than Time, the hour markers hide and drag-to-reorder switches off,
with a note saying why. Click **TIME** to sort by time again and dragging comes straight back.
Sorting by Artist to *see* how your day looks is exactly what it is for.

## The one rule worth knowing

**Anything you touch becomes yours, and Generate leaves it alone.**

Before this, pressing **Generate** rebuilt the whole day and threw away every change you had made.
Now Generate only fills the **empty** places. Your rows stay exactly where you put them, no matter how
many times you regenerate.

## Moving a song

**Drag it onto another row.** The two swap times — the one you dragged goes where the other was, and
that one comes back to where yours started.

As you drag, a small purple chip follows your pointer with the song's name on it, and a **bright
purple line** appears across the top of the row you are hovering. That line is where your song lands.
Release, and it goes there.

> **The song that was there does not vanish, and nothing shuffles down.** The two rows *trade places*
> — yours takes that slot, and the one that was there moves to the slot yours came from. Everything
> else in your day stays exactly where it is.

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

## Editing a cell

**Double-click** a Title, Artist or Category cell to edit it. **Enter** saves, **Escape** cancels,
clicking away saves.

**Category** can be changed on any row that has not aired.

**Title and Artist can only be edited on rows that are not library songs** — spots, voice tracks and
talk breaks, where the text *is* the item. On a song row they are read-only, and hovering says why:

> *This row plays a song from your Library. Rename it in the Library — editing it here would make the
> log disagree with what actually airs.*

That is not a limitation, it is the point. A song row plays a **file**; its title is a label for that
file. If you could rename the label, your log would say one thing while your transmitter did another
— and that log is what your as-run and your advertiser affidavits are built from. Rename it in the
Library and every row that plays it follows.

Editing a cell marks the row **YOURS**, like any other manual change.

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
