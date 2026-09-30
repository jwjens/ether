---
feature: remote-link
title: Remote Link (a feed over the network, straight into a fader)
summary: Another Ether computer at the venue feeds its board over the network straight into a fader on your station's board — about a fifth of a second behind, not the 8 seconds of the listener stream — so your station stays on air and takes the remote as a channel.
where: At the station — a fader's source dropdown → "Link (network feed)", then paste the venue computer's link key on that strip. At the venue — Preferences → Broadcast → Remote Link → "Copy link key", and SEND FEED TO (the master section, or the hamburger menu → Remote Link). Its live state — the strip, SEND FEED on the master section, and Health Monitor → Remote Link.
since: unreleased (log-reader-flip, after 4.6.51)
audience: operator
tour: true
---

# Remote Link

## What it is

A **remote broadcast** without leaving the air: your station keeps running, and an Ether computer at the venue
(a park, a gala, a remote studio) **feeds its whole board** — its mics, its carts — over the network straight
into **one fader** on your station's board.

Think of it as the **input selector knob** on a console channel: you set a fader's source to **Link**, and that
fader carries the venue's feed. It is not "one station talking to another" — with sync, the same station
(say, **halloVeen**) runs on the venue computer and on the studio computer, and the venue feeds its halloVeen
programme into the studio's halloVeen board.

It is **direct**: about **a fifth of a second** from the venue's mic to your station's output. The listener
stream is about **8 seconds** behind, which is why you can't cue a remote from it.

At your station the remote is **a channel like any other**: its meter, its fader, its ON button, the ducker —
and your station's processing, **once** (the venue sends its board *before* its own processing).

## When to use it

- A live remote: the talent is at the venue, the station stays on air, and you bring the remote up on a fader.
- Any time another Ether computer needs to feed your board live.

For a **phone caller** use the phone desk. For a **pre-recorded** segment, use a cart or the log.

## The key — the venue computer makes it, the studio fader takes it

Like telling a codec which caller to accept: the **computer that sends** makes a **link key**, and the **fader
that receives** is given that key. That fader then takes **that computer's feed and nobody else's**.

1. **At the venue** (the computer that sends): hamburger menu → **Remote Link** (or Preferences → Broadcast →
   **Remote Link**). Under **This computer's link key**, press **Copy link key**. It is one line that starts
   `ether-link:1:` and names this computer. Send it to the studio (a message, an email — it is a key: send it
   only to the people who run the studio).
2. **At the studio**: on the fader that takes the remote, open its **source** dropdown and pick
   **Link (network feed)**. Under the dropdown a box appears: **paste the sender's link key**. Paste the line.
   The strip now shows **← <venue computer> · key 271A-413B**. Check that fingerprint matches the one on the
   venue's screen.
3. **Cut a sender off**: press the **✕** next to its name on the strip (or **Forget key** in Preferences). Only
   that fader stops taking that computer's feed; every other fader is untouched.
4. **Replace key…** at the venue makes a new key: every fader holding the old one stops taking that computer's
   feed until the new line is pasted.

## Set it up — at the station (the one that stays on air)

1. **Put a Link fader on the board** and paste the venue's key (above). Until something arrives, the strip says
   **● LINK · waiting for a sender · UDP 9760** and its meter says **NOT FED** — the board says so.
2. **Check the numbers** (Preferences → Broadcast → Remote Link → **Feed in**). Every one is shown, and you can
   change it:
   - **Jitter buffer — 120 ms.** How much audio the Link holds to ride out network wobble. More = fewer
     dropouts, more delay.
   - **Listen on UDP port — 9760.** The port this computer listens on (one port, every station on it). The
     station's router must forward it to this computer.
   - **Auto-cut on loss — OFF.** See below.

## Set it up — at the venue (the computer that sends)

1. Sign in to the same account on the venue computer.
2. Press **SEND FEED** (the master section, under Station) — or hamburger menu → **Remote Link**.
3. Under **SEND FEED TO another computer**: pick the **computer · station** (for example
   *ovowforestmusic · halloVeen · the fader set to Link there*), type that computer's **address** and **port**
   (9760), and check the **bitrate** (128 kb/s). The computer for each station is the one that airs it.
4. Press **▶ SEND FEED TO <computer · station>**. The line turns to **● SENDING → … receiving**. "Receiving"
   comes from **the studio's own report**, never assumed. If it says **no answer yet**, the studio can't be
   reached, or its fader doesn't hold this computer's key — check the address, the port, and the key.
5. To stop: **■ STOP THE FEED**.

**The one thing you can't do: feed this same computer.** Its own programme would come straight back into it (a
loop), so this computer's own stations are greyed out with the reason — and a fader refuses a key made on its own
computer. Feeding **the same station on another computer** is the normal case.

## What the state line means (at the station)

| It says | What it means |
|---|---|
| **LINK · paste the sending computer's link key** | The fader is set to Link but holds no key yet — nothing can be accepted. |
| **LINK · waiting for a sender · UDP 9760** | Ready. Nothing is arriving. The meter says NOT FED. |
| **LINK · connecting · OVEVENTS** | The venue is sending; the buffer is filling (a moment). |
| **LINK · OVEVENTS · 128 ms** | On. The number is **how far behind the venue's board** this channel is, measured all the way through. |
| **LINK · LOST OVEVENTS 4 s ago — waiting** | Nothing has arrived for over a second. The channel is **silent and NOT FED**, the rest of your programme carries on, and the Link takes the venue back **by itself** when it returns. |
| **LINK · a sender's key was refused** | Something tried to send without this fader's key (or with an old one after the venue replaced it). It was refused and counted. |
| **LINK · cannot listen** | This computer couldn't open the port — another program has it, or it is blocked. The reason is in Preferences. |

## If the Link drops

- The channel goes **silent** and shows **NOT FED**. The ducker lets the programme back up by itself.
  Nothing else changes: **your automation keeps running exactly as it was.**
- **Auto-cut on loss** (Preferences → Remote Link; **OFF** by default): when it's ON, a Link lost for longer
  than the seconds you set (5 by default) turns that channel **OFF** — the same as pressing its ON button — so
  the venue never comes **back on air unannounced**. You bring it back with the ON button when you're ready.
- A short wobble never needs you: a missing packet is **recovered** or **smoothed over** by the codec, and
  every one is counted (Health Monitor → Remote Link).

## Health Monitor → Remote Link

Both directions, as the engine reports them:
- **IN** — the fader, whose key it holds, who is sending, the latency, the buffer, the jitter; frames **lost**
  (recovered by FEC or concealed), **late**, **dropouts**, **keys refused**, a **second sender refused**, the
  clock difference the engine is absorbing, reconnects, and whether auto-cut is on.
- **FEED OUT** — what this computer sent, and what the far end **says** it received.

Every change (Link up, lost, a key refused, a second sender refused, the feed answered / stopped answering, a key
made or replaced, a fader patched with whose key) is written to the health ledger.

## Good to know

- **Loss protection (FEC)** is **ON** by default. It was measured: while nothing is lost, the audio is at full
  quality; when the studio reports loss, the codec carries a spare copy of each packet, coding part of the
  audio as speech — so music is measurably less clean until the loss stops. You can turn it off in SEND FEED TO.
- **Only one venue at a time** per station. A second computer trying to send is refused, and its name is shown.
- **Every packet is sealed** with the key and tied to both computers: a feed meant for one studio never plays on
  another, and a fader only plays the computer its key names.
- **The key line is a secret.** Anyone holding it can feed the fader that took it — if it goes astray, press
  **Replace key…** at the venue and paste the new line.
- **Hearing yourself at the venue:** use the interface's **direct monitor**, as with any mic.

## Not in this version (by design)

- **The relay on the Ether server** (for a station network that can't open a port) comes next. This version
  sends directly: the studio's router must forward UDP 9760 to the studio computer.
- **SRT** is not in this version — the Link sends plain UDP. Its fallback timeout is shown in Preferences,
  greyed out, so it can be set before SRT arrives.
- **No return feed** to the venue (hearing the station without the 8 s stream delay) yet.
- **No Zephyr / Comrex / AoIP** — that is the separate **Network** source, still to come.

## Related

- **Mic on Air** (`docs/help-mic-input.md`)
- **Channel Faders and PFL** (`docs/help-channel-faders.md`)
- **Health Monitor** (`docs/help-health-monitor.md`)
