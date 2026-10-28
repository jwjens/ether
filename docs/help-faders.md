---
feature: faders
title: Faders — moving, fine control and typing a level
summary: Every fader moves only by how far you drag it, never jumps when grabbed, and can be stepped, fine-tuned or typed to an exact dB.
where: Every fader — channel faders, MASTER, MONITOR, Station Monitors, AUX rows, and the Park page. Settings: Settings → Audio → Loudness & faders
since: 4.6.59 (fader handling build, 2026-10-13)
audience: operator
tour: true
---

# Faders

## What it is

Every fader in Ether works like a console fader:
- **It never jumps.** Pressing on the fader, or anywhere on its track, changes nothing.
- **It moves by how far you drag.** Drag up or right to make it louder, down or left to make it quieter.
- The exact level shows next to every fader, to 0.1 dB, and lights up while it moves.

The same rules apply to the channel faders, MASTER, MONITOR, the Station Monitors faders, the AUX rows and the Park
page fader.

## Fine control

- **Shift + drag:** moves slowly, for small changes.
- **Mouse wheel:** one notch = one step (0.5 dB to start).
- **Arrow keys:** click a fader first, then Up/Right is louder and Down/Left is quieter (0.5 dB to start).
  **Shift + arrow** is a small step (0.1 dB to start).
- **Back to 0 dB (unity):** double-click the fader. A fader whose top is below 0 dB goes to its top.
- **Type a level:** double-click the level next to the fader (on a channel fader, click the fader and press **Enter**),
  type a number such as **-5**, and press **Enter**. **Esc** cancels. Type **off** to turn it off. A number above the fader's
  maximum stops at the maximum and says so.
- On the Park page, double-tap the level to type one.

## The fader cap

Every fader on the board has the same cap: raised, with grip ridges, and a dark line across its middle. **Read the
level where that line meets the scale.** The pointer turns into a hand over a fader, and the cap lifts with a coloured
ring while it is being moved.

## The scale

From −20 to +10 dB, every dB is the same width: three-quarters of the travel. Below −20 the scale gets tighter,
down to off. 0 dB (unity) sits three-quarters of the way up on channel faders. MASTER and MONITOR top out at 0 dB.

## Settings (Settings → Audio → Loudness & faders)

- **Fader maximum:** the top of each group (channel faders, AUX rows, MASTER, MONITOR).
- **How a fader moves:** the Shift fine factor, the mouse wheel step, the arrow key step and the Shift + arrow step.
- **Fader law:** the points that set where each level sits on the travel (position in %, level in dB).
  - The last point is always 100 % = +10 dB.
  - Each group's maximum slides the whole curve.

Changing the law or a group's maximum never changes a level that is set. It only changes where a fader is drawn.

## If something looks wrong

- **A fader moved by itself:** it shows the real level. Someone may have changed it from the Park page or a Show.
- **The wheel scrolls the page instead:** point at the fader itself, not the empty space beside it.
