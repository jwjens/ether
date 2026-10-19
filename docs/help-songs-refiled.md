---
feature: songs-refiled
title: "Songs re-filed by stable id" — what it means
summary: After this update each computer checks every song's category (and artist, album, jingle category) against the computer that assigned it, and moves any that sync had filed in the wrong place. It lists every song it moved.
where: An alert in the app ("Songs re-filed by stable id …") and a report file in this computer's Ether profile folder.
since: sync/uuid-refs (2026-10-19)
audience: operator
tour: false
---

# Songs re-filed by stable id

> **Help corpus template.** Written to the format in `docs/help-sweepers.md`: plain language, step-by-step, the
> section order kept.

## What it is

When two computers run the same station, each one numbers its categories in the order it made them. If one computer
ever made a category the other did not (for example "Early tracks" created twice), the numbers stop matching. Before
this update, a song's category travelled between computers as that number, so a song filed under **Kids** on one
computer could land under the category next to it on the other.

From this update, a song's category (and its artist, album and jingle category, and the jukebox and sweeper-pool
settings) travel by a **stable id** that is the same on every computer. Nothing lands one off any more.

A song that arrives before its **artist** gets the artist created on arrival (the same artist, not a copy), so a new
import never shows up without artist names on the other computer.

Songs already filed in the wrong place are fixed **once**, automatically, on each computer the first time it opens
this version. For each song Ether looks at who made its category assignment, reads that computer's numbering, and
puts the song back where it was filed. You do not re-file anything by hand.

## When you will see it

- Shortly after the first start of this version, an alert: **"Songs re-filed by stable id: N to their right category
  … Every move is listed in …"**.
- If the other computer has not been updated yet, songs **it** filed wait. They are fixed automatically as soon as it
  opens this version — no action on this computer.

## What to do

1. **Update both computers** to this version. Each one fixes its own copy.
2. Open the report the alert names (a `songs-refiled-<date>.txt` file in this computer's Ether profile folder). It
   lists every song whose **category** changed and every song whose **artist** changed — **from** what **to** what, and
   on which computer it had been filed — and any artist it had to create because it was missing here.
3. Nothing else. Running it again moves nothing.

## How it behaves on air

- It changes which category a song belongs to — the same thing you do by hand in the Library. Songs already in
  today's log keep their place; the next Generate uses the corrected categories.
- It does not send anything to the other computer. Each computer repairs itself from the same history, so the two
  arrive at the same answer.

## If something looks wrong

- **The report says songs are "waiting".** The other computer has not opened this version yet. Update it; this one
  finishes on its own (it checks every 10 minutes).
- **"Could not be placed".** The category that song was filed to no longer exists on either computer. The song is
  left exactly as it was — file it by hand.
- **A song you re-filed on both computers at almost the same moment** keeps whichever edit was saved last. Edit it
  again on one computer.

## Related

- **Multi-machine sync** (`docs/help-multi-machine-sync.md`).
- Engineering record: `docs/sync-uuid-references-2026-10-19.md`.
