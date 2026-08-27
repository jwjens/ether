---
feature: schedule-manager
title: Schedule Manager
summary: Shows, Clocks, Categories, Spots and Sweepers side by side in one window, linked — pick a category and the clocks using it light up; edit anything and every pane refreshes.
where: Menu → Schedule Manager · or Schedule → Schedule Manager in the menubar
since: 4.4.172 (Spots and Sweepers panes added 4.4.176)
audience: programmer
tour: true
---

# Schedule Manager

## What it is

Shows, Clocks and Categories have always been **tabs** — you could look at one at a time. That is
fine for editing one thing and useless for the question programming actually asks: *does my clock
match what I said I wanted?*

The Schedule Manager puts the whole picture in one window and links it:

```
┌──────────────┬────────────────────────────┬──────────────────────────────┐
│ SHOWS        │ CLOCK                      │ CATEGORIES │ SPOTS │ SWEEPERS │
│ which clock  │ the hour grid for the      │ ───────────┴───────┴──────── │
│ airs when    │ selected show's clock      │ targets and library depth    │
└──────────────┴────────────────────────────┴──────────────────────────────┘
```

**Categories, Spots, Sweepers and Rotation Analytics share the right-hand column as tabs.** Click a tab to switch. Five
columns side by side would leave every one of them too narrow to use, and Spots and Sweepers are
things you consult while building a clock rather than watch continuously. Drag any tab out if you
want it as its own column — see *Arranging it*.

## Arranging it

The panes are **dockable**. Drag a tab to move a pane, drop it beside or on top of another to
re-arrange or stack them, and drag the dividers to resize. Panes cannot be shrunk to nothing.

**Your layout is saved automatically, per station, on this machine only.** Switching stations
restores that station's arrangement. It is never synced — how you arrange your screen is yours, not
something that should rearrange a colleague's.

**Layouts**, at the bottom of the Panels menu, are named arrangements for a particular job:

| Layout | Opens | For |
|---|---|---|
| **Programming** | Shows · Clocks · Categories (+ Sweepers, Spots) | Building the hour |
| **Traffic** | Spots · Clocks · Sweepers, Categories | Spot and break work |
| **Analysis** | Rotation Analytics · Categories, Shows · Clocks | Reading what aired |

Picking one **replaces your current arrangement** — same as Reset layout, and just as harmless: it
moves panes, nothing else. From that moment it is simply your layout again. Drag it, resize it,
close panes; it saves as normal. Nothing is locked and there is no mode to leave, which is why no
layout is ever shown as "active" — the moment you moved a pane, the name would be a lie.

**Panels** in the header lists every pane with a tick beside the open ones. Closing a pane with its
**✕** is always reversible — tick it in this menu to bring it back. When something is closed the
button turns amber and says how many are hidden, so a missing pane reads as recoverable.

**Reset layout** in the header puts everything back to the default arrangement. No confirmation, no
data affected, and **you stay signed in** — it only moves panes.

> **After updating to 4.4.176 your saved arrangement is rebuilt once.** Two new panes exist that
> your old layout had never heard of; restoring it would have left Spots and Sweepers invisible with
> no way to reach them. Arrange it again and it will stick.

**Fixed layout** switches to the older non-dockable three-pane view if you prefer it.

## The linking is the point

| You do this | This happens |
|---|---|
| **Click a category** | The strip at the top names its target and library depth; clocks that use it get an amber border |
| **Click a show** | The Clock pane focuses that show's clock |
| **Edit anything** | Every pane refreshes — one store, one refresh |
| **Add or delete a spot category** | The Clock pane's break rows and segment picker update with it |
| **Assign a sweeper to a category** | The Categories pane picks the change up |

The panes are the **same editors** as the tabs and popouts. Anything you can do there you can do
here, and vice versa; nothing was rebuilt.

## The loop, in one window

**Rotation Analytics** is a pane here too, which closes the circle:

1. **Categories** — declare what you want: a target of 4 spins/hr.
2. **Clocks** — shape the hour against the inline advisor, which tells you the clock says 11.
3. **Rotation Analytics** — read what actually aired, and whether the log agrees with either.

The numbers there are history. Editing a clock does not change them; press **Refresh** after you
generate. Its tables sort and resize like a spreadsheet — see its own help entry.

## Spots and Sweepers

**Spots** is the full *Spots & Promos* manager — the same one on the main menu, hosted here so you
can build a break without leaving the clock you are building it for. Spot categories are created,
renamed and deleted here.

**Sweepers** is the same panel as the SWEEPERS push-up at the bottom of the screen, which remains its
home. Use it here to see which music categories carry imaging while you look at the clock.

### Where spot categories moved, and what did not move

| Thing | Where it lives | Why |
|---|---|---|
| **Spot categories** (the buckets) | **Spots** pane | They belong to the station, not to any one clock |
| **Timed breaks** ("3 spots at :20") | **Clocks** pane, unchanged | A break belongs to the clock it is on |

The Clocks pane used to carry a Spot Categories card beside the breaks editor, and it crowded the
part of the pane you actually work in. In this window that card is gone and the Spots pane owns it.
**In the tabbed view and the Fixed layout the card is still there**, because neither of those has a
Spots pane to send you to.

The Clock pane still names categories everywhere it did before — the segment picker, break defaults
and break rows are untouched, including the **⚠ 0 eligible spots** warning on a break that would air
nothing.

## The inline advisor

Each clock in the middle pane carries its rotation-goals verdict:

> **Feel Good** target 4/hr, 11 slots — over by 7

Those are **the same numbers** Station Health → Rotation goals shows, from the same function. If the
two ever disagree, that is a bug, not a difference of opinion. The verdict updates when you edit the
clock, rather than waiting for the background sense.

A category with **no target declared** never produces a verdict. Not declaring a goal is a choice.

## Reading the category strip

Select a category and the strip tells you three things:

- **target N/hr** — what you declared, or "no target declared"
- **N songs, needs ~M** — library depth: how many songs exist versus how many the clocks demand.
  **THIN** means the category cannot support its own demand without repeating
- **used by the selected clock** — the context link

Thin plus a high target is the burn signature: the scheduler will be forced to relax separation to
fill the hour.

## The old surfaces still work

Nothing was taken away. `Schedule → Clocks / Shows & Dayparts / Categories` still opens the tabbed
panel, the three popout windows still work, and the embedded programming panel is unchanged. The
Schedule Manager is an additional door onto the same rooms — use whichever suits the task.

## What it does NOT do

- **It does not change what airs.** It edits the same shows, clocks, categories, spots and sweepers
  through the same write paths. Generation and playout are untouched.
- **It does not report on itself.** The Rotation Analytics pane reads what already aired; editing a
  clock beside it does not change those numbers. Hit Refresh after you generate.
- **Your layout is not your colleague's.** It is stored per station on this machine and never synced.

## Related

**Station Health → Rotation goals** — the same advisor, for every clock at once.
**Rotation Analytics** — what the log actually did, after generation.
**Spots & Promos** — the same manager the Spots pane hosts.
**Sweepers & Sweepers** — the same panel the Sweepers pane hosts; the push-up is its home.
