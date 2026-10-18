---
feature: module-programlog
title: Program Log (screen module)
summary: The day's log — every hour, every song and break that will air — as a building block for your own screens, the same log as the Program Log window.
where: ☰ menu → Program Log (today). On a screen you build: placed from the module palette (coming with the Screen Builder).
since: Screen Builder Phase 1 (ui/screen-builder, 2026-10-18)
audience: operator
tour: false
---

# Program Log (screen module)

> **Help corpus template.** Written to the format in `docs/help-sweepers.md`: plain language, step-by-step, the
> section order kept.

## What it is

The **Program Log** is the list of what will air today, hour by hour: songs, spots, sweepers and voice tracks, in
order, with their times. It is the log the station plays from.

As a **screen module**, it is exactly the **Program Log** window — the same log, read and edited the same way. An
edit you make in one Program Log shows in every other Program Log that is open, on any screen, within a moment.

You can put **more than one** on a screen — for example today in one and tomorrow in another.

## When to use it

When you want the log beside other tools on a screen of your own — carts, the library, or a second day's log.

## Set it up

Today the module is the **Program Log** window: **☰ menu → Program Log**. Placing it on a screen of your own comes
with the Screen Builder (the next step); this page will say how when it arrives.

1. **Pick a day** in the small calendar on the left. Each Program Log keeps its own day on screen.
2. **Fill it.** **Fill Day** builds the day from your clocks and shows; **Fill Week** builds seven days.
3. **Edit an hour.** Press **✎ Edit** on an hour: click a song to swap it, drag a row onto another to swap their
   times, or press **✕** to remove a row.

## How it behaves on air

- An hour that has **started** is a record — its rows cannot be moved or removed.
- Rows you placed or changed are marked **YOURS**; a later Fill Day keeps them.
- Every Program Log that is open follows every change, from anywhere: your edit, a Fill Day, a voice track, the
  station marking a song played.
- The station is the screen's station. A Program Log module shows only that station's log.

## If you don't see the log

- **"No shows configured for this day"** — the day has no shows. Add shows in **Schedule → Show Scheduler**, then
  **Fill Day**.
- **Hours but no songs?** Press **Fill Day**.
- **An edit didn't take?** The reason is shown in red at the top of the hour editor, word for word.

## Not in this version (by design)

- Each Program Log remembers its own day while it is open. The day the **next** one opens on is shared per station.

## Related

- **Program Log** (`docs/help-program-log.md`) — the full guide to the log itself.
- **Log editing** (`docs/help-log-editing.md`).
- **Carts module** (`docs/help-module-carts.md`), **Song Library module** (`docs/help-module-library.md`).
