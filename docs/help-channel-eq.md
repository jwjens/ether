---
feature: channel-eq
title: Channel EQ (Filters and PEQ on a fader)
summary: Every fader has its own rack — a high-pass and low-pass filter, and a 4-band parametric EQ — drawn as a curve you can drag, with IN and OUT meters so you can see what it did.
where: The EQ button on any fader strip (and on the on-air decks A/B/C). In the rack window, the selector row: MASTER | A B C D E F | CART | S1…S5.
since: slice 5 (DSP)
audience: operator
tour: true
---

# Channel EQ

## What it is

**Each fader has its own rack**, separate from the master rack: A–F, CART and S1–S5. It can hold:

- **FILTERS** (green):
  - a **high-pass** (HPF), to cut rumble below it;
  - a **low-pass** (LPF), to cut hiss above it.

  Both are steep (24 dB per octave), and each has its own IN.
- **PEQ** (blue): four bands you can boost or cut.
  - Each band has its own colour.
  - Band 1 can be a **low shelf** and band 4 a **high shelf**. Otherwise they are bells.

The rack sits **after the fader's trim and before the fader**.

**A fader whose rack is empty, or whose modules are all OUT, is untouched.** Its audio is exactly what it was
before channel EQ existed.

## Open it

1. On any fader strip, press **EQ**. When the lamp is lit, that fader's rack has something **IN**.
2. The rack window opens at that fader. If it is already open, it switches to that fader.
3. Inside the window, the **selector row** at the top goes to any rack:
   - **MASTER**;
   - **A B C D E F**, **CART**, **S1…S5**. A dot on a tab means that fader's rack has something IN.

On the **on-air decks A/B/C**, the deck's **EQ** button opens the same rack.

## Using it

1. **Add a module.**
   - An empty rack says **"empty · add"**. Press **+ FILTERS** or **+ PEQ** (one of each).
   - **A new module starts OUT**, so adding one changes nothing on air.
2. **Press IN** on the module's tile when you want to hear it.
3. **Shape it on the curve.** The editor names what you are editing, for example *"editing: S2 · PEQ"*.
   - **Drag a numbered node**: sideways sets the frequency, up and down sets the gain.
   - **Width:** use the mouse wheel over the curve, a trackpad pinch, or a two-finger pinch on a touch screen.
     Or pick **BAND 1–4** and use the sliders.
   - **Filters:** drag the green **HPF / LPF** line sideways. **HPF IN** and **LPF IN** switch each one on its
     own.
   - **FLAT** puts every band back to 0 dB.
4. **Every change is smooth.** Each edit crossfades over 20 ms, so dragging a node never clicks on air.
5. **Changes are saved for this station** as soon as the engine accepts them.

**Reading the curve:**
- The **thick blue line** is exactly what the engine is running on this fader.
- A **dashed grey line** is what you have set but switched **OUT**: what you'd hear if you pressed IN.
- A **shaded green area** is a filter that is IN. An **outlined** area is one that is OUT.

**The two meters on the right** are this fader before (**IN**) and after (**OUT**) its rack, both before the
fader. They show what the EQ did.

**Moving a module:** the **⋯** menu on a tile has **Move earlier / Move later**, so Filters can go after the PEQ.
It also has **Remove**.

## The ranges

| Control | Range |
|---|---|
| HPF | 16.1–500 Hz |
| LPF | 1–20.2 kHz |
| PEQ frequency | 16.1 Hz–20.2 kHz |
| PEQ gain | ±14 dB |
| PEQ width | 0.2–3 octaves |

A new Filters module starts with the HPF at 80 Hz (IN) and the LPF at 18 kHz (OUT), inside a module that is
itself OUT. A new PEQ starts with every band at 0 dB.

## The mic

- **The mic's EQ is separate.** The mic runs in the browser's audio (Web Audio), not in the audio engine, so a
  channel rack cannot process it.
- The mic's own 10-band EQ is labelled **"mic input EQ (browser audio)"** and still works on the mic.
- It used to also send its settings to the master EQ of one station by mistake. That send is removed.

## If something looks wrong

- **A red "the engine did not accept that" line** means **nothing changed on air**, and the rack shows what is
  running.
  - If Ether has just updated, fully close it and reopen it. The audio engine doesn't reload on its own.
  - The same applies if the **OUT** meter is **hatched**: the running engine predates channel EQ.
- **The EQ lamp is lit but you hear no change:** a PEQ can be **IN** with every band at 0 dB. The editor says
  *"nothing IN changes the sound"*.
- **The old deck EQ drawer is gone.** It never processed the deck: its settings went to the master EQ by
  mistake. Those old settings were not carried over, because they never affected the sound.

## Not in this version (by design)

- No gate or compressor on a channel yet (the next slice).
- No presets that follow a source or a show yet (a later slice). The rack belongs to the fader.
- The mic is not an engine channel yet.

## Related

- **The Master Rack** (`docs/help-processor-rack.md`)
- **Reading the Meters** (`docs/help-meters.md`)
