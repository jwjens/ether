---
feature: park-listen
title: Park page — Listen
summary: Logged-in park staff hear exactly what the park speakers are playing, on their own phone, with about a second of delay or less.
where: Park page (park.ether-cast.com/<your-station>) → LISTEN, under MUTE. Settings: Preferences → Audio → Park page — Listen
since: OVEVENTS build 2026-10-13
audience: operator
tour: true
---

# Park page — Listen

## What it is

**Listen** lets park staff who are logged in to the Park page hear the park speakers on their own phone. They hear
exactly what the speakers get: everything the park hears, on the main output and on AUX (music, announcements,
commercials, sound effects, carts):
- after the park sound fader and MUTE;
- with the carts and the announcements, whichever output they play on.

When someone moves the fader, presses MUTE or plays a cart, they hear it.

It plays only on that one phone. Staff set how loud they hear it with their **phone's own volume buttons**. That never
changes the park's sound; only the Park page fader and MUTE do.

## When to use it

- Checking what the park sounds like from somewhere you can't hear the speakers.
- Making sure a cart or announcement really played.
- Setting the park level by ear.

## Set it up (once per station, in Ether)

Open **Preferences → Audio → Park page — Listen** for the station. Nothing has a value until you set it. Listen
stays off for the station until all four are set. (What Listen sends isn't a setting: it is always everything the park
hears, MAIN and AUX together, after MONITOR and MUTE.)

1. **Listen quality (kbps):** how much sound detail is sent.
   - Higher sounds better and uses more data on the staff phone.
2. **Channels:** Mono or Stereo.
   - Mono puts all of the quality setting into one channel, so a low kbps still sounds clear. It is plenty for
     checking what the park hears.
3. **Frame length (ms):** how the sound is cut into packets.
   - Shorter means less delay and a little more data.
4. **Listener buffer (ms):** how much the staff phone holds before playing.
   - More means fewer dropouts on weak phone signal, but more delay.
   - 0 lets the phone decide. 0 is a setting like any other.

Each setting has its own **Save** button. After you press it, the line under the settings says what was saved and for
which station (for example "Saved for halloVeen: Listener buffer 0 ms"), or why it wasn't.

The line under the settings says whether Listen is available. While someone is listening, it also shows the sender's
state (for example **live**).

## Use it (Park page)

1. Log in on the Park page with your Ether username and PIN.
2. Tap **LISTEN** (under MUTE). It changes to **LISTENING** and the park sound plays on your phone.
3. Tap **LISTENING** to stop.

It never starts by itself. It stops if you log out, close the page, or lose signal for a while; tap LISTEN again to
pick it back up.

## What it never does

- It never changes what the park hears, and never changes the radio stream.
- If it fails (bad signal, the relay down), the park speakers, playout and the stream carry on untouched.
- Nothing is sent from the station unless someone is listening.

## If it doesn't work

- **"Listen isn't set up on this station":** set all four settings above in Ether, pressing **Save** by each.
- **"Station offline":** the computer that plays the park isn't connected. Listen can't start until it is.
- **No sound but LISTENING is lit:** check the phone's volume and silent switch, then the park sound fader and MUTE.
- **Hold to talk pauses Listen on the same phone** while you talk (so the phone doesn't hear itself); it comes back when
  you let go.
