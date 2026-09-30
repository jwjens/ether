---
feature: resync
title: Re-sync library
summary: Point every song, spot, cart and announcement at the copy of its file on THIS computer — after a restore, a move, or bringing your stations to a different machine.
where: Preferences → Audio → Catalogue Folder & Sync → Re-sync library
since: before 4.6 (Windows ↔ Mac re-pointing: the release after 4.6.52)
audience: operator
tour: true
---

# Re-sync library

## What it is

Every song, spot, cart, announcement and sweeper in Ether remembers where its audio file is. When you sign in
on a different computer — or restore a backup, or move your music folder — those remembered places belong to
the **old** computer. The files may already be on this one (the backup brings them down), but Ether is still
looking where they used to be.

**Re-sync library** fixes that. It finds each item's file **by its name** in this computer's catalogue folder
and points the item at it. It works across Windows and Mac: an item remembered as
`C:\Users\…\catalogue\ABC.mp3` on a Windows PC is re-pointed to `ABC.mp3` in your Mac's catalogue, and the
other way round.

Nothing is copied, renamed or uploaded, and nothing is sent to your other computers — each computer keeps its
own idea of where its files are.

## When to use it

- The Health Monitor says **N OUTSIDE** — items whose file is not in this computer's catalogue folder.
- You signed in on a new computer and the music came down, but items still point at the old machine.
- You moved or renamed your catalogue folder.

## Do it (Preferences → Audio → Catalogue Folder & Sync)

1. **Check the folder.** *Folder for this station* shows this computer's catalogue folder. If it is wrong,
   press **Choose folder…** and pick the folder your music is in.
2. **Test sync (optional, changes nothing).** Press **Test sync**. It tells you how many of this station's
   songs it found in the folder and lists the ones it could not find.
3. **Re-sync library.** Press **Re-sync library**. It links everything it found and tells you
   **Linked N/M** and how many are still missing.
4. **Do it on each station.** Re-sync works on the station you are in. Switch station and repeat.
5. **Look at the Health Monitor.** The **OUTSIDE** count drops to the items Re-sync could not reach (below).

## What it will not do

- **It will not invent a file.** If a file is not in the folder, the item is listed as missing. Its place in
  the log is cleared so the station **skips it instead of going silent**. Add the file and Re-sync again.
- **Music outside the station's format is left alone.** For music, Re-sync looks at the categories the
  station's clocks play (plus its sweepers and spots). A song filed in a category no clock uses is not
  touched — it keeps playing if its file is found by name, and still counts as OUTSIDE. Put it in a category
  a clock uses, then Re-sync.

## If something looks wrong

- **OUTSIDE did not drop at all:** check step 1 — the folder must be the one your files are actually in.
- **Many items missing:** the files may not have arrived yet. Preferences → Backup & Restore → **Advanced**
  shows **Audio transfer** — whether audio is still coming down.
