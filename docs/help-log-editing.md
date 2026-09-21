---
feature: log-editing
title: "Editing the log by hand"
summary: How to swap a song, trade two rows' times and remove rows in the Program Log's hour editor, what the YOURS badge means, and why Fill Day never undoes your work.
where: Program Log → open an hour → ✎ Edit
since: 4.4.196 (moved from the Calendar to the Program Log in the log-reader-flip build, 2026-09-20)
audience: operator
tour: true
---

# Editing the log by hand

Open the **Program Log**, open an hour, press **✎ Edit**. You get that hour's rows — **Time, Type,
Title, Artist, Length** — and every change you make is saved to the airing log the moment you make it.

## The one rule worth knowing

**Anything you touch becomes yours, and Fill Day leaves it alone.**

Fill Day only fills the **empty** places. Your rows stay exactly where you put them, no matter how
many times you fill the day again.

## Swapping a song

Click a song row. A list of songs from the same category opens on the right — search it, click one.
The row now plays that song, with the title, artist, length and file the Library has for it. The row
gets the purple **YOURS** badge.

## Moving a song

**Drag it onto another row.** The two swap times — the one you dragged goes where the other was, and
that one comes back to where yours started.

> **The song that was there does not vanish, and nothing shuffles down.** The two rows *trade places*.
> Everything else in your hour stays exactly where it is. Moving one song by three minutes would
> otherwise push the whole rest of the day out of place, including your spot breaks and top-of-hour.

Both rows now show **YOURS**.

## Removing a song

Click the **✕** at the right of the row. The song comes out of the log and leaves a hole.

The next time you press **Fill Day**, that hole is filled with a fresh song chosen by your clock and
your rotation rules — exactly as if the scheduler had picked it in the first place. So "remove it and
fill again" is how you say *"not this one, give me something else"*.

## The YOURS badge

A purple **YOURS** badge on a row means you placed, moved, swapped or edited it. Fill Day will not
move, replace or remove it.

If most of a day is yours, Fill Day has very little left it is allowed to fill, and it will look like
it is doing nothing. That is not a fault — it is doing what you asked. Remove a few of your rows (✕)
and fill again if you want the scheduler to help.

## Rule warnings

If a swap or a move puts a song too close to another by the same artist, the same title, or the same
song, an **amber ⚠ note** appears under that row:

> *⚠ Same artist "Fleetwood Mac" 10 min away (rule: 60 min)*

**The change still happened.** This is a heads-up, not a refusal. You know your station and there are
good reasons to break a separation rule — a themed set, an artist feature, a request. Ether tells you
what it noticed and then gets out of your way. The warning uses the same rules Fill Day uses.

## What you cannot edit

**Rows that have already aired or are on air now.** They are dimmed, cannot be dragged, swapped or
removed, and if you try, the reason is shown at the top of the editor:

> *"…" has already aired — the log is a record of what happened, not a plan.*

This is deliberate and it is not negotiable: that row is the **record of what your station actually
broadcast**. It feeds your as-run log and your advertiser affidavits. A log you can edit after the
fact is a log nobody can trust — including you.

## What moved with the Calendar

The Calendar window is gone; the Program Log is the one log surface. Three of the Calendar's editing
tools did not come across and are not planned: sorting and resizing the day's columns, the 📍 pin
(an edit, swap or move already marks a row YOURS), and double-clicking a title, artist or category to
retype it. If you need one of them, say so.

## Frequently hit questions

**I filled the day again and my changes are still there. Is that right?**
Yes. That is the whole point.

**I filled the day again and nothing new appeared.**
If every slot is yours, there is nowhere for Fill Day to put anything.

**I deleted a song and it came back.**
It did not — a *different* song was chosen for that gap by your clock and rotation rules. If you want
the slot empty, leave it deleted and do not fill again.

**Can I edit a different station's log from here?**
Only the station you are switched into.

## Related

- **Program Log** (`help-program-log.md`) — the whole panel: Fill Day, Clear Day, docked or in its own
  window.
- **Health Monitor** — every edit is recorded as a `log-edit` event, and a Fill that preserved your
  rows records how many it kept.
