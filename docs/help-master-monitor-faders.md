---
feature: master-monitor-faders
title: Master and Monitor Faders
summary: MASTER sets what your listeners hear. MONITOR sets how loud it is in your room. They are separate — turning your speakers down never turns the broadcast down.
where: Right-hand Master Out panel (both also in the pop-out Master Output window)
since: 4.4.154
audience: operator
tour: true
---

# Master and Monitor Faders

## What they are

Two faders at the top of the **Master Out** panel on the right-hand side. They do different jobs, and
the difference matters on air:

- **MASTER** — the **broadcast**. This is your station's output level: what listeners hear on the
  stream and what feeds your transmitter chain. Pull it down and your audience hears it quieter.
- **MONITOR** — the **speakers in your room**. This is your local listening level only. Turn it all the
  way down and your studio goes silent while the station keeps broadcasting at full level.

The rule to remember: **MASTER is heard by everyone. MONITOR is heard by you.**

## When to use each

**MASTER**
- Trimming your on-air level.
- Dropping the broadcast for a moment without stopping playout.

**MONITOR**
- Turning the room down to take a phone call, or up to hear a mix detail.
- Talking to someone in the studio without touching what airs.

## How to use them

1. Open the **Master Out** panel on the right.
2. Drag **MASTER** in that panel to set your on-air level. The **PGM, LOCAL and STREAM meters reflect the change** —
   they show what is actually going out, so what you see is what your listeners get.
3. Drag **MONITOR** to set your room level. Only the **MONITOR** meter moves, because your speakers are
   not the broadcast.

Both faders remember where you left them. If the audio engine restarts during a show, they are
re-applied automatically — the station will not jump back to full level, and your speakers will not go
silent, on their own.

## Reading the meter

The master meters (PGM / LOCAL / STREAM / MONITOR) are measured **after** the faders. That is deliberate:

- If PGM is low and the audio sounds quiet to your listeners, **MASTER** is where to look.
- If your room sounds quiet but PGM is healthy, look at the **MONITOR** meter — your listeners are fine.

How to read the bar, the peak dot and OVER: see **Reading the Meters** (`docs/help-meters.md`).

## Things worth knowing

- **MASTER only turns down, not up.** It runs from silence to normal (unity) level. It cannot push the
  station louder than the mix, which prevents accidentally driving the signal into distortion.
- **Channel faders are separate.** Each deck and the mic have their own fader. MASTER applies once, at
  the output, after everything is mixed together — moving MASTER does not move your channel faders.
- **Two monitor controls, one room level.** The MONITOR fader in the panel and the one in the pop-out
  Master Output window both set the same room level.

## If something looks wrong

- **The broadcast is quiet but I didn't touch anything.** Check MASTER. If it is down, drag it back to
  the top (unity).
- **My speakers are silent but the station is still on the air.** That is MONITOR at zero — which is the
  safe direction. Drag it up.
- **Moving MASTER doesn't change the meter.** Check **Help → About** for your version and fully close and
  reopen Ether after an update.

MASTER and MONITOR in the **pop-out Master Output window** are the same controls as the ones in the
Master Out panel: move one and the other follows.
