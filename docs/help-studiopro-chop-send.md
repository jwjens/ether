---
feature: studiopro-chop-send
title: Cut and send from the Show+ DAW
summary: Bring a file into the Show+ DAW, cut the piece you want, and send it straight to the Library, a sweeper pool, or a deck — in its own window beside the live screen.
where: ≡ Menu → Show+ DAW · Tools → Show+ DAW in the menubar · Library → right-click a track → Send to Studio
since: 4.4.74
audience: operator
tour: true
---

# Cut and send from the Show+ DAW

The Show+ DAW is where you produce audio: bring a file in, cut the piece you want, and send it
straight to air or your library — **quick import, chop, send to the Library, a sweeper pool, or a deck.**

## Open it — its own window

The Show+ DAW opens as its **own separate window**, not a takeover of the main screen — so your decks,
meters, Station Health, and queue stay fully visible and live while you produce. Open it from:

- **≡ Menu → Show+ DAW**, or **Tools → Show+ DAW** in the menubar, or
- **Library → right-click a track → Send to Studio** (opens the DAW and drops that track in).

Drag it to a second monitor if you have one. The window **remembers its size and position** for next
time. Closing it is safe — but if you have **uncommitted regions** (audio loaded that you haven't sent to
a deck, the Library, or a pool yet), it **warns you before closing** so you don't lose your work. The
send exits work from this window exactly as they do inline — → Deck loads the real deck, → Sweeper and
→ Library file into the active station.

## Import audio

Two ways to get audio into the DAW:

- **Drag & drop** — drop an audio file (or several) from your computer onto a track lane. The first lands
  where you drop it; extras land on new tracks below.
- **＋ Import** (top toolbar) — pick one or more audio files. Each opens on its own track.

## Chop — pick the piece you want

1. **Double-click the region** on the timeline to open it in the **Editor** (the large-waveform drawer at
   the bottom; you can also toggle it with **Editor ⤒**).
2. **Drag the trim handles** (the two bars at the left and right edges of the waveform) to frame exactly the
   part you want to keep. The shaded areas are trimmed off.
3. **▶ Audition** (in the Send bar) plays just your selection so you can hear it before you send. It plays
   on the DAW only — **nothing goes to air while you audition.**

## Send — three exits

The **Send selection** bar sits under the waveform. Name your cut (click the name to edit), then choose an
exit:

- **→ Library** — imports the cut as a normal library song.
- **→ Sweeper** — pick a **pool** (or leave it **— unassigned —**), then press **Send to Sweepers →**. The
  cut is imported as a sweeper and, if you picked a pool, filed in it.
- **→ Deck** — then pick **A**, **B** or **C** to load the cut straight onto that deck, ready to fire. A deck
  that's playing is protected — the send is refused and it won't be interrupted.

Every send renders your trimmed selection to a real audio file first, so what lands in the library or on
the deck is exactly what you framed.

## Notes

- The same cut-and-tag engine powers the **Reel Splitter** (the SWEEPERS push-up → **ADD IMAGING — CUT A
  REEL**). One engine, two places — a cut behaves the same wherever you make it.
- Sweepers you send here appear in the SWEEPERS panel's pools and are eligible for automatic seam
  placement, exactly like ones cut in the Reel Splitter.

## Related

- **Sweepers** (`docs/help-sweepers.md`) — pools and category assignments.
- **Reel Splitter** (`docs/help-reel-splitter.md`) — cutting a whole reel into tagged pieces.
- **The Smart Tool** (`docs/help-smart-tool.md`) — editing clips on the timeline.
