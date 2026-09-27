---
feature: reel-splitter
title: Reel Splitter — cutting a sweeper reel
summary: Slice a long imaging reel (sweepers stacked back to back) into individual sweepers, named and pooled in your library, in one screen.
where: Bottom bar → SWEEPERS → “ADD IMAGING — CUT A REEL” tab
since: 4.4.58
audience: operator
tour: true
---

# Cutting a sweeper reel

> Built-in help corpus entry — plain language, step-by-step; the Iris tour layer reads it verbatim.

## What it is

A **reel** is one long audio file with many sweepers stacked back to back, separated by silence — the way
imaging often arrives from a production house. The **Reel Splitter** is a single dedicated screen that
slices that reel into individual cuts, lets you review them by ear, and adds them all to your library —
**tagged as sweepers and pooled in one step**. It is not a DAW: no tracks, no BPM, no sessions.

## When to use it

Any time you get a bundle of imaging as one file. If your sweepers are already separate files, just import
them normally and mark them as sweepers in the Library, then manage them in the **SWEEPERS** push-up.

## Do it (one screen)

1. **Open.** Bottom bar → **SWEEPERS** → the **“ADD IMAGING — CUT A REEL”** tab. **Drag the reel onto the
   drop zone**, or click **Open reel…**.
2. **Auto-cut.** The splitter finds the silent gaps and pre-slices the reel into **numbered regions** on the
   waveform. Too many / too few cuts? Drag the **Silence threshold** slider (−70 to −25 dB) and hit
   **Re-cut** — lower (more negative) dB splits on quieter gaps.
3. **Review (keyboard-first).**
   - **Space** — audition the selected region.
   - **← / →** — move between regions.
   - **Delete** — remove the selected region.
   - Drag a selected region's **left/right edge** on the waveform to fine-tune its boundaries.
   - Row buttons: **▶** audition · **⌥** split in half · **⌄** merge with the next · **✕** delete.
4. **Name.** Each region is pre-named `<reel> 01`, `<reel> 02`… Click **EDIT** on any name to change it.
5. **Commit.** Optionally pick a **pool**, then **Commit N sweepers →**. Each region is rendered to its own
   file and added to the Library as a sweeper, in the pool you picked — ready to assign to a music category
   in the **SWEEPERS** push-up.

## Where the cuts go

Rendered cuts are written into your audio catalogue folder, one file per cut, named
`<reel>__<name>.wav`, and imported by that path — the normal Library import, no side doors.

## If something looks off

- **Regions merged / too coarse** — raise the threshold toward −25 dB and Re-cut, or use **⌥ split**.
- **One giant region** — the reel had no clear silence gaps; split by hand with **⌥** and drag edges.
- **A cut has silence on the ends** — drag its edges in tighter; the auto-cut keeps a small pad.
- **Committed to the wrong pool** — the cuts are normal library items; change the pool in the
  **SWEEPERS** push-up.

## Related

- **SWEEPERS push-up** — assign these cuts to music categories (a specific sweeper or a rotating pool).
- **Library** — where every committed cut lands.
