---
feature: patch-bay
title: Patch Bay (outputs and inputs)
summary: Where each station's Master, Cue (PFL) and Aux play on this computer, and which input, Park mic or Remote Link feed comes in on each source fader.
where: ☰ → Patch Bay, Menu → Patch Bay, or the "Patch Bay" button on the board's Master line, the AUX panel's Output line, or Settings → PFL
since: unreleased (patch bay steps 1 and 2, after 4.6.67)
audience: admin
tour: true
---

# Patch Bay (outputs and inputs)

## What it is

The **Patch Bay** is a grid. Each **row** is one of a station's outputs:

- **Master**: the station's local output, after the MONITOR fader. On OV, this is what feeds the Bose.
- **Cue (PFL)**: where PFL plays. With nothing patched, PFL plays over Master.
- **Aux**: the aux monitor bus. With nothing patched, the aux is silent.

Each **column** is one channel pair on one device on this computer. A normal stereo device has one column, "1-2". An
8-channel interface has four columns: 1-2, 3-4, 5-6 and 7-8.

Click a square to connect that output to those channels. Click it again to disconnect. **One output can play to up to
four devices at once.** For example, Master can play to the speakers and to channels 3-4 of an interface at the same time.

The stream to your listeners **never** depends on any of this. On-air audio goes to Icecast, whatever is patched here.

## When to use it

- A new pair of speakers or headphones: connect Master, Cue or Aux to it.
- A multichannel interface: send Master to 1-2 and Aux to 3-4 of the same interface.
- The same output in two rooms: connect Master to both devices.

## Set it up

1. Open **☰ → Patch Bay** or **Menu → Patch Bay** (or the **Patch Bay** button in Settings → Audio → Mic Inputs). You can also use the **Patch Bay** button next to the board's Master line, the AUX panel's
   Output line, or Settings → PFL.
2. Find the station. Its three rows are Master, Cue (PFL) and Aux.
3. Click the square where the row meets the device and channels you want. It turns teal (●) once Ether has it.
4. Read the line under the grid. It says what the audio engine **actually opened**, for example
   "Live: Speakers (Realtek) ch 1-2 (48000 Hz, 2 ch)".
5. Optional: **If the Master device stalls, switch to the Windows default**. Choose **On** or **Off**. See below.

Everything here is saved **for this computer only**. Another computer on the account keeps its own patch, because device
names belong to one computer.

## What the colours and words mean

- **● teal / "Live"**: that device is open and playing.
- **! red / "MISSING: <device>"**: the device is not connected to this computer. **Nothing else plays in its place.**
  Ether checks every couple of seconds and opens it again when it's back.
- **"STALLED: <device>"**: the device is present but keeps stopping. Ether reopens the same device.
- **"FAILED"**: the device would not open those channels.
- **"No Master device is open. The station runs on its own clock"**: Master's device is missing. The station keeps
  running, so the stream, Aux, Cue and Park Listen keep going. Only the missing device is silent.

## The stall setting

**If the Master device stalls, switch to the Windows default** has three choices:

- **Not set** (the starting value): a stalling device is shown in red and retried. Ether never switches on its own.
- **On**: after the device has stalled twice in a row, Ether plays on the Windows default. The screen names the device it
  opened.
- **Off**: Ether never switches. It keeps retrying the same device.

A device that is simply **missing** never switches to anything, whatever this is set to.

## Inputs

Under each station's outputs is its **Inputs** grid.

- Each **row** is one of the station's **source faders** on the board (D, E, F, S1 to S5 — the ones on the board).
- Each **column** is one input on this computer: every input of every input device (an interface with 8 inputs has
  8 columns), **Park Mic 1** and **Park Mic 2**, and the station's **Remote Link** feed.

Click a square to bring that input in on that fader. Click it again to disconnect it.

- **The fader's SOURCE on the board changes with it.** Connect an interface's input 2 to fader D and D's SOURCE says
  that interface. Set a fader's SOURCE on the board and the grid shows it. They are the same setting, so they always
  agree.
- **The Remote Link feed comes in on one fader per station.** Connect it to another fader and it moves there; the fader
  it left says "— no source —".
- An input that is connected to a fader keeps its **gain** (Settings → Audio → Mic Inputs) when you move it to
  another input.
- The line under the grid says what the audio engine is doing with each fader's input: **live**, **device not
  connected**, **that input is not on this device**, the Remote Link's state, and so on.
- A fader set to **Mic** or **Link** on the board with nothing connected is shown in red, so it can't go unnoticed.

To set the gain, see the live numbers, or paste a Remote Link key, use Settings, as before.

## Things to know

- **Nothing patched on Master** = the Windows default, as before. The line under the grid names it.
- **Levels and mutes stay on the board.** MONITOR, the station strip, MUTE, PFL dim and the aux faders work exactly as
  before. The Park page's level and mute too.
- Up to **four devices per output**. To add a fifth, disconnect one first.
- A device that isn't connected stays in the grid, marked **NOT CONNECTED**, so you can see it and disconnect it.

## If something is wrong

- **A device is missing from the grid**: plug it in, then press **Refresh devices**.
- **A square stays red**: read the line under the grid. It names the device and the reason.
- **"The audio engine did not take it"**: Ether just updated. Fully close and reopen it, because the audio engine only
  reloads on a full restart.

## Not in this version

- An input pair as **one stereo** source (for example a mixer's 1-2 into one fader). Today each input is mono.
- Finding Remote Link computers without addresses: the next step (Remote Link).
- Who may open the Patch Bay (roles) is not enforced yet.

## Related

- **Board → Station Monitors**: Master's level and mute.
- **AUX panel**: the aux faders.
- **Settings → PFL**: the PFL dim.
- **Health Monitor**: device stalls are logged there.
