---
feature: schedule-manager
title: Schedule Manager
summary: Shows, Clocks and Categories side by side in one window, linked — pick a category and the clocks using it light up; edit anything and all three panes refresh.
where: Menu → Schedule Manager · or Schedule → Schedule Manager in the menubar
since: 4.4.172
audience: programmer
tour: true
---

# Schedule Manager

## What it is

Shows, Clocks and Categories have always been **tabs** — you could look at one at a time. That is
fine for editing one thing and useless for the question programming actually asks: *does my clock
match what I said I wanted?*

The Schedule Manager puts all three in one window and links them:

```
┌──────────────┬────────────────────────────┬─────────────────┐
│ SHOWS        │ CLOCK                      │ CATEGORIES      │
│ which clock  │ the hour grid for the      │ targets and     │
│ airs when    │ selected show's clock      │ library depth   │
└──────────────┴────────────────────────────┴─────────────────┘
```

## Arranging it

The panes are **dockable**. Drag a tab to move a pane, drop it beside or on top of another to
re-arrange or stack them, and drag the dividers to resize. Panes cannot be shrunk to nothing.

**Your layout is saved automatically, per station, on this machine only.** Switching stations
restores that station's arrangement. It is never synced — how you arrange your screen is yours, not
something that should rearrange a colleague's.

**Reset layout** in the header puts everything back to the default three panes. No confirmation, no
data affected — it only moves panes.

**Fixed layout** switches to the older non-dockable three-pane view if you prefer it.

## The linking is the point

| You do this | This happens |
|---|---|
| **Click a category** | The strip at the top names its target and library depth; clocks that use it get an amber border |
| **Click a show** | The Clock pane focuses that show's clock |
| **Edit anything** | All three panes refresh — one store, one refresh |

The panes are the **same editors** as the tabs and popouts. Anything you can do there you can do
here, and vice versa; nothing was rebuilt.

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

- **It does not change what airs.** It edits the same shows, clocks and categories through the same
  write paths. Generation and playout are untouched.
- **It does not change what airs.** Same shows, same clocks, same write paths.
- **Rotation Analytics is a link, not a pane.** The button in the header opens it; embedding it is
  for a later version.

## Related

**Station Health → Rotation goals** — the same advisor, for every clock at once.
**Rotation Analytics** — what the log actually did, after generation.
