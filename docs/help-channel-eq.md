---
feature: channel-eq
title: Channel EQ (Filters and PEQ on a fader)
summary: Every fader has its own rack — a high-pass and low-pass filter, and a 4-band parametric EQ — drawn as a curve you can drag, with IN and OUT meters so you can see what it did.
where: The EQ button on any fader strip (and on the on-air decks A/B/C). In the rack window, the selector row: MASTER | A B C D E F | CART | G…K (each fader by its board letter).
since: slice 5 (DSP)
audience: operator
tour: true
---

# Channel EQ

## What it is

**Each fader has its own rack**, separate from the master rack: every fader on the board, by the letter the board shows it (A–F, CART, and the extra source channels G onward). It can hold:

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
   - **A B C D E F**, **CART**, **G…K**, the same letters as the board. A dot on a tab means that fader's rack has something IN.

On the **on-air decks A/B/C**, the deck's **EQ** button opens the same rack.

## Using it

1. **Add a module.**
   - An empty rack says **"empty · add"**. Press **+ FILTERS**, **+ GATE**, **+ PEQ** or **+ COMP** (one of each;
     the gate and compressor are in **Gate and Compressor**). Or take the **Voice** preset.
   - **A new module starts OUT**, so adding one changes nothing on air.
2. **Press IN** on the module's tile when you want to hear it.
3. **Shape it on the curve.** The editor names what you are editing, for example *"editing: H · PEQ"*.
   - **Drag a numbered node**: sideways sets the frequency, up and down sets the gain.
   - **Width:** use the mouse wheel over the curve, a trackpad pinch, or a two-finger pinch on a touch screen.
     Or pick **BAND 1–4** and use the sliders.
   - **Filters:** drag the green **HPF / LPF** line sideways. **HPF IN** and **LPF IN** switch each one on its
     own.
4. **Every change is smooth.** Each edit crossfades over 20 ms, so dragging a node never clicks on air.
5. **Changes are saved for this station** as soon as the engine accepts them.

**Reading the curve:**
- The **thick blue line** is exactly what the engine is running on this fader.
- A **dashed grey line** is what you have set but switched **OUT**: what you'd hear if you pressed IN.
- A **shaded green area** is a filter that is IN. An **outlined** area is one that is OUT.

**The two meters on the right** are this fader before (**IN**) and after (**OUT**) its rack, both before the
fader. They show what the EQ did.

## Reading the spectrum

Behind the EQ curve is a **live spectrum of this channel**, so you can see the sound change as you move a band.
- **Faint:** the channel **before** its rack.
- **Brighter:** **after** it, which is what the EQ, filters, gate and compressor did.
- Both are taken **before the fader**, so moving the fader doesn't change them. The spectrum shows the EQ, not
  your level.
- The scale is on the right: **0 dBFS at the top, −90 at the bottom**. 31 third-octave bands, 20 Hz to 20 kHz.
- **Hatched at the far left (below 160 Hz):** those bands are too narrow for the analyser to split finely. They're
  shown, but read them as a guide.
- **NOT FED:** nothing is playing on this channel.
- **PEAK HOLD** (off by default) keeps each band's highest level for 2 seconds, as a dashed line.

It runs only while this rack window shows the curve, one channel at a time. Close the window and it stops.

## Starting over

These reset buttons change the sound smoothly (20 ms crossfade), like any other edit. They take effect
straight away and are saved.

| Button | Where | What it does |
|---|---|---|
| **FLAT** | the PEQ controls | Every band goes to **0 dB**. Frequencies, widths and shelf settings are kept, so you can bring a band back up where it was. PEQ IN is not changed. |
| **RESET FILTERS** | the Filters controls | **HPF and LPF both OUT**, back to 80 Hz and 18 kHz. The FILTERS tile's IN is not changed. |
| **CLEAR RACK** | the right of the strip | **Empties this fader's rack**: Filters and PEQ are removed, and the fader is untouched again. |

**Clearing a rack:**
1. Press **CLEAR RACK**. It asks first: *"Clear H's rack?"*
2. Press **CLEAR** to empty the rack, or **CANCEL** to keep it.

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

- **A mic is a channel like any other now.** Patch a source channel to your mic (see **Mic on Air**), and its
  channel EQ works exactly as described here: Filters to cut rumble and hiss, and a PEQ to shape the voice.
- The old 10-band "mic input EQ (browser audio)" is gone, and its settings were not carried over. Use the
  channel EQ.

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

- No presets that follow a source or a show yet (a later slice). The rack belongs to the fader.

## Related

- **Gate and Compressor** (`docs/help-channel-dynamics.md`)

- **The Master Rack** (`docs/help-processor-rack.md`)
- **Reading the Meters** (`docs/help-meters.md`)
- **Mic on Air** (`docs/help-mic-input.md`)
