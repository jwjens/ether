---
feature: remote-link
title: Remote Link (a remote broadcast, straight to your board)
summary: Another Ether computer at the venue sends its board straight to a channel on your station — about a fifth of a second behind, not the 8 seconds of the listener stream — so your station stays on air and takes the remote as a channel.
where: At the station — a source channel's source dropdown → "Link (remote Ether)". At the venue — SEND TO on the master section, or the hamburger menu → Remote Link. Everything else — Preferences → Broadcast → Remote Link. Its live state — the strip, SEND TO, and Health Monitor → Remote Link.
since: unreleased (log-reader-flip, after 4.6.51)
audience: operator
tour: true
---

# Remote Link

## What it is

A **remote broadcast** without leaving the air: your station keeps running, and an Ether computer at the venue
(a park, a gala, a remote studio) sends **its whole board** — its mics, its carts — straight to **one channel**
on your station's board.

It is **direct**: about **a fifth of a second** from the venue's mic to your station's output. The listener
stream is about **8 seconds** behind, which is why you can't cue a remote from it.

At your station the remote is **a channel like any other**: its meter, its fader, its ON button, the ducker —
and your station's processing, **once** (the venue sends its board *before* its own processing).

## When to use it

- A live remote: the talent is at the venue, the station stays on air, and you bring the remote up on a fader.
- Any time another Ether computer needs to feed your board live.

For a **phone caller** use the phone desk. For a **pre-recorded** segment, use a cart or the log.

## Set it up — at the station (the one that stays on air)

1. **Make a key.** Hamburger menu → **Remote Link** (or Preferences → Broadcast → **Remote Link**). Under
   **Receive on this station**, press **Make a key**. The key is shown only as a short **fingerprint**
   (like `271A-413B`). A sender without this key is **refused** — silently, and counted.
2. **Put a Link channel on the board.** On a source channel, open its **source** dropdown and pick
   **Link (remote Ether)**. The strip's state line now says **● LINK · waiting for a sender · UDP 9760**, and
   its meter says **NOT FED** — nothing is arriving yet, and the board says so.
3. **Check the numbers** (Preferences → Broadcast → Remote Link). Every one is shown, and you can change it:
   - **Jitter buffer — 120 ms.** How much audio the Link holds to ride out network wobble. More = fewer
     dropouts, more delay.
   - **Listen on UDP port — 9760.** The port this computer listens on (one port, every station on it).
   - **Auto-cut on loss — OFF.** See below.

## Set it up — at the venue (the computer that sends)

1. Sign in to the same account on the venue computer.
2. Press **SEND TO** (the master section, under Station) — or hamburger menu → **Remote Link**.
3. Under **SEND TO another station**: pick the **station**, type its computer's **address** and **port**
   (9760), and check the **bitrate** (128 kb/s).
4. Press **▶ SEND TO <station>**. The line turns to **● SENDING → <station> · <station> receiving**. "Receiving"
   comes from **the station's own report**, never assumed. If it says **no answer yet**, the station can't be
   reached — check the address, the port, and that a channel there is set to Link.
5. To stop: **■ STOP SENDING**.

**You can't send to a station this computer airs** — patch the mics on its own board instead. **A station
can't send to itself** (its programme would feed back into itself), and **two stations can't send to each
other** (a loop). Those choices are greyed out with the reason.

## What the state line means (at the station)

| It says | What it means |
|---|---|
| **LINK · waiting for a sender · UDP 9760** | Ready. Nothing is arriving. The meter says NOT FED. |
| **LINK · connecting · OVEVENTS** | The venue is sending; the buffer is filling (a moment). |
| **LINK · OVEVENTS · 128 ms** | On. The number is **how far behind the venue's board** this channel is, measured all the way through. |
| **LINK · LOST OVEVENTS 4 s ago — waiting** | Nothing has arrived for over a second. The channel is **silent and NOT FED**, the rest of your programme carries on, and the Link takes the venue back **by itself** when it returns. |
| **LINK · a sender's key was refused** | Something tried to send with the wrong key (or an old one after you replaced it). It was refused and counted. |
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
- **IN** — who is sending, the latency, the buffer, the jitter; frames **lost** (recovered by FEC or
  concealed), **late**, **dropouts**, **keys refused**, a **second sender refused**, the clock difference
  the engine is absorbing, reconnects, and whether auto-cut is on.
- **SEND TO** — what this computer sent, and what the far end **says** it received.

Every change (Link up, lost, a key refused, a second sender refused, SEND TO answered / stopped answering)
is written to the health ledger.

## Good to know

- **Loss protection (FEC)** is **ON** by default. It was measured: while nothing is lost, the audio is at full
  quality; when the station reports loss, the codec carries a spare copy of each packet, coding part of the
  audio as speech — so music is measurably less clean until the loss stops. You can turn it off in SEND TO.
- **Only one venue at a time** per station. A second computer trying to send is refused, and its name is shown.
- **The key never leaves the computer it was made on in this version**, and is never shown — only its
  fingerprint. Compare fingerprints on both screens.
- **Hearing yourself at the venue:** use the interface's **direct monitor**, as with any mic.

## Not in this version (by design)

- **The venue and the station on different computers need the next update.** In this version the key stays on
  the computer that made it, so SEND TO works between two stations **on the same computer** (the test setup).
  Carrying the key to the account's other computers comes next.
- **The relay on the Ether server** (for a station network that can't open a port) comes in that update too.
  This version sends directly: the station's router must forward UDP 9760 to the station computer.
- **SRT** is not in this version — the Link sends plain UDP. Its fallback timeout is shown in Preferences,
  greyed out, so it can be set before SRT arrives.
- **No return feed** to the venue (hearing the station without the 8 s stream delay) yet.
- **No Zephyr / Comrex / AoIP** — that is the separate **Network** source, still to come.

## Related

- **Mic on Air** (`docs/help-mic-input.md`)
- **Channel Faders and PFL** (`docs/help-channel-faders.md`)
- **Health Monitor** (`docs/help-health-monitor.md`)
