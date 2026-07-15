---
feature: reel-splitter
title: Reel Splitter — cutting a jingle reel
summary: Slice a long imaging reel (stacked jingles/sweepers) into individual, tagged, pooled library items in one screen.
where: Tools → Reel Splitter…  (also "Cut a reel →" in Settings → Programming → Jingles & Sweepers)
since: 4.4.58
audience: operator
tour: true
---

# Cutting a jingle reel

> Built-in help corpus entry — plain language, step-by-step; the Iris tour layer reads it verbatim.

## What it is

A **reel** is one long audio file with many jingles or sweepers stacked back to back, separated by silence —
the way imaging often arrives from a production house. The **Reel Splitter** is a single dedicated screen
that slices that reel into individual cuts, lets you review them by ear, and adds them all to your library —
**tagged and pooled in one step**. It is not a DAW: no tracks, no BPM, no sessions.

## When to use it

Any time you get a bundle of imaging as one file. If your jingles are already separate files, just import
them normally and tag them in **Jingles & Sweepers**.

## Do it (one screen)

1. **Open.** Tools → **Reel Splitter…** (or **Cut a reel →** on the Jingles & Sweepers page). **Drag the
   reel onto the drop zone**, or click **Open reel…**.
2. **Auto-cut.** The splitter finds the silent gaps and pre-slices the reel into **numbered regions** on the
   waveform. Too many / too few cuts? Drag the **Silence threshold** slider and hit **Re-cut** — lower
   (more negative) dB splits on quieter gaps.
3. **Review (keyboard-first).**
   - **Space** — audition the selected region.
   - **← / →** — move between regions.
   - **Delete** — remove the selected region.
   - Drag a selected region's **left/right edge** on the waveform to fine-tune its boundaries.
   - Row buttons: **▶** audition · **⌥** split in half · **⌄** merge with the next · **✕** delete.
4. **Name.** Each region is pre-named `<reel> 01`, `<reel> 02`… Edit any name inline in the list.
5. **Commit.** Choose **Jingles** or **Sweepers**, optionally pick a **pool**, then **Commit N →**. Each
   region is rendered to its own file and added to the Library, tagged JIN/SWP and assigned to the pool —
   ready to assign to a music category in **Jingles & Sweepers**.

## Where the cuts go

Rendered cuts are written under the app data folder (`…/imaging/<reel>/<name>.wav`) and imported by that
path — the normal Library import, no side doors. (Content-hash identity arrives with the future library
migration; today, like all imports, identity is the file path.)

## If something looks off

- **Regions merged / too coarse** — raise the threshold toward 0 dB and Re-cut, or use **⌥ split**.
- **One giant region** — the reel had no clear silence gaps; split by hand with **⌥** and drag edges.
- **A cut has silence on the ends** — drag its edges in tighter; the auto-cut keeps a small pad.
- **Committed to the wrong class/pool** — the cuts are normal library items; retag in **Jingles &
  Sweepers** or the Library.

## Related

- **Jingles & Sweepers** — assign these cuts to music categories (specific or rotating pool).
- **Library** — where every committed cut lands.
