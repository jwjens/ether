---
feature: import-duplicates
title: Songs you already have (Import Music)
summary: Import a folder and Ether finds the songs already in your library before copying anything. Skip them all to bring in only the new ones, replace them, or choose song by song.
where: Library → Import Music → Choose Folder & Import (or Choose File(s) & Import)
since: 4.6.59 (1019, import duplicate guard)
audience: program director, music director
tour: true
---

# Songs you already have (Import Music)

## What it is

When you import a folder of downloaded songs, some of them may already be in your library. Ether checks every
file **before it copies anything** and lists the ones you already have, the way Windows asks "Replace or Skip
Files". You decide for each one.

A file counts as **already in your library** when:
- its **title and length** (to the second) match a song you have, or
- its **file name and length** match a song you have (this finds songs you renamed in Ether).

Same title with a different length is a **different song** and is imported as new (for example two different
recordings of "A Nightmare On My Street").

## Import only the new songs

1. Open the **Library** and press **Import Music**.
2. Pick a category for the new songs (optional).
3. Press **Choose Folder & Import** and pick the folder.
4. Ether reads every file ("Checking for songs you already have…").
5. If some are already in your library, you see **"N of M songs are already in your library"**.
6. Press **Skip all N — import only the new**. Only the new songs are copied and added.

When nothing in the folder is already in your library, the import just runs.

## Replace instead

- **Replace all N** swaps in the new file for every song on the list.
- Or set **Skip** / **Replace** on each song (**set all to Skip** / **set all to Replace** flip the whole list),
  then press **Continue**.

**Replace keeps your song**: its category, play history, rotation and settings stay. Only the audio file changes
to the new one (copied into your catalogue). The old file is left on disk; nothing is deleted.

## Each row shows

- The new file's title, artist and length.
- "You have:" your song's title, artist, length and category, and the new file's name.

## Good to know

- **Cancel import** goes back without copying anything.
- The finish screen says how many were imported, skipped and replaced.
- A song whose stored length doesn't match its file (for example after the file was swapped outside Ether) has a
  different length, so it is not recognised as the same song.
- Only songs already in your library are checked. Two copies of a song inside the folder you import are both new.
