---
feature: smart-tool
title: The Smart Tool (Show+ DAW)
summary: The pointer picks the gesture from where it sits on a clip — trim at the edges, cursor up top, move down low, fade at the corners — so editing no longer means switching tools first.
where: Show+ DAW → the edit-tools row above the timeline (SMART is the default)
since: 4.4.223
audience: operator
tour: true
---

# The Smart Tool

## What it is

Editing a clip used to start with a detour: pick **Trim**, drag, pick **Grab**, drag, pick **Fade**,
drag, then remember to go back to **Select** before clicking anything else. Four decisions before the
first useful one.

The **Smart Tool** removes that. It reads **where on the clip your pointer is sitting** and offers the
gesture that belongs there. Move toward a clip edge and it becomes a trim. Slide into the top half and
it becomes a cursor. Drop into the bottom half and it becomes a grab. Ride into a top corner and it
becomes a fade. **The cursor changes before you click** — so the clip tells you what a drag will do
while there is still time to change your mind.

Smart is **on by default**. There is nothing to turn on.

## The zones

Picture a clip as a small map. Six places, six gestures:

| Where you point | What you get | Cursor |
|---|---|---|
| **Left or right edge** (a thin strip) | **Trim** — drag the clip's start or end | ↔ |
| **Top half, middle** | **Cursor / I-beam** — click to drop the playhead for a precise cut | I-beam |
| **Bottom half, middle** | **Grab** — drag the clip anywhere, including to another track | hand |
| **Top-left corner** | **Fade in** — drag right to lengthen | corner arrow |
| **Top-right corner** | **Fade out** — drag left to lengthen | corner arrow |
| **Bottom corner where two clips meet** | **Crossfade** — drags both sides of the joint at once | ⇹ |

A small white marker paints the zone you're hovering, so the affordance is visible as well as felt.

The crossfade corner only appears **where a neighbouring clip actually meets this one**. On a clip with
open space either side, that corner is simply a trim like any other edge.

## The one modifier

**Hold Alt while dragging an edge** to *trim with a fade* — the clip's start or end moves, and a fade is
laid over exactly the amount you trimmed away. One drag instead of two.

That is the only modifier. **Ctrl does nothing here** — Ctrl is the timeline's zoom, and a tool that
stole it would break zooming. If you were taught a Ctrl+drag shortcut in an earlier build, it is gone
on purpose.

## Try it once

The whole thing in a single motion:

1. Open **Show+ DAW** and load a clip onto a track.
2. Put the pointer on the clip's **left edge** — the cursor becomes a trim arrow.
3. Slide right into the **upper middle** — it becomes an I-beam.
4. Slide **down** — it becomes a grab hand.
5. Slide up into the **top-right corner** — it becomes a fade.

Four gestures, one slide, no toolbar. That is the feature.

## When you want the old way

The five named tools are still there, and they still win when you pick one:

**Select (V) · Grab (G) · Splice (C) · Trim (T) · Fade (F)**

Click one and it applies everywhere on every clip, exactly as before — useful when you're doing one
thing fifty times and don't want the pointer making decisions for you.

**To get back to Smart:** click the active tool a second time, or press its key again (press **T**
while Trim is lit and you're back to Smart). The **SMART** button at the left of the row does the same
thing and shows you which mode you're in.

## Undo

Every gesture is **one undo**. A drag that lasted two seconds and repainted forty times still steps
back with a single **Ctrl+Z** — it does not walk backwards through the drag a pixel at a time. A click
that never travelled leaves no undo entry at all.

## Notes

- Shift-click (or Ctrl-click) a clip still **multi-selects** rather than starting a drag.
- Double-click still opens the clip editor.
- On a very short clip the zones shrink proportionally so a narrow clip never becomes all corner and
  no body — you can always reach its middle.
- If two clips **overlap**, Show+ may also apply its own automatic crossfade over the overlap. It only
  ever lengthens a fade, never shortens one you set by hand.
