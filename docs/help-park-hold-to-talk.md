---
feature: park-hold-to-talk
title: Park page — Talk (Park mics)
summary: Logged-in park staff tap TAP TO TALK on the Park page to talk from their phone over the park speakers (and on air too, if that fader's MAIN is lit), and tap again to stop. Only a person turns it off.
where: Park page (park.ether-cast.com/<your-station>) → TAP TO TALK, under LISTEN. In Ether: a fader's source → Mic → Park Mic 1 / Park Mic 2. Settings: Preferences → Audio → Park page — Hold to talk
since: Ether build 2026-10-16
audience: operator
tour: true
---

# Park page — Talk (Park mics)

## What it is

**Talk** turns a staff member's phone into a microphone for the park. They tap **TAP TO TALK** on the Park page, wait for
green (**TALK NOW**), talk as long as they like, and tap again to stop.

**You are in charge of on and off.** Ether never decides you've finished: it doesn't listen for talking, never stops
because of silence, and has no time limit. A talk ends only when the talker taps it off, or a person presses **STOP
TALK** in Ether, or the studio lock is turned on.

The voice arrives in Ether on a **Park mic**. There are two, **Park Mic 1** and **Park Mic 2**. They are inputs like a
sound-card mic: you put each on any fader (it can be a different fader any day). It plays in the park like every fader,
and **that fader's buttons decide the rest**:
- **MAIN:** lit = the voice also goes on air; not lit = the park only;
- **DUCK:** lit = the music dips under the voice;
- the fader's level and its channel **ON** switch, as on every fader.

## Set it up (once per station, in Ether)

1. **Put a Park mic on a fader.** On the board, set a fader's source to **Mic** and pick **Park Mic 1 (Park page)**
   (or **Park Mic 2**). They are listed with this computer's other inputs.
   - The first time, the starting values go into Preferences: phone echo cancellation **ON**, noise suppression **ON**,
     automatic gain **ON** (so holding the phone a little closer or further doesn't change the level much), and a
     **Park mic buffer** of **120 ms**. You can change every one.
2. **Set the fader's buttons:** **MAIN** (on air too, or park only) and **DUCK**; bring the fader up and turn it ON.
3. **Name the Park mics** in **Preferences → Audio → Park page — Hold to talk**, for example "Front gate". The phone
   shows these names.
4. Check the line at the bottom: **"Hold to talk is available on this station's Park page…"**.

**Park mic buffer:** how much voice Ether holds before playing it, to ride out uneven phone internet. More = a steadier
voice on a weak signal and a little more delay; less = less delay, but the voice can cut in and out. 120 ms is the
starting value.

## Use it (Park page)

1. Log in on the Park page with your Ether username and PIN.
2. If there are two Park mics, pick one by its name above the button.
3. **Tap TAP TO TALK.** The first time, the phone asks for the microphone; allow it.
4. The button shows **CONNECTING…** (amber) until the line is open all the way to the park, then **TALK NOW** (green).
   **Start talking when it's green** — from then on every word is heard. Take your time; it stays open.
5. **Tap again** to stop.

After the first time, the phone keeps its line to the park open while the page is open (muted between talks, using
almost no data), so the next taps go green right away. **Turn the microphone off** under the button closes it.

**If it shows DISCONNECTED** (red), the phone lost its line during a talk. The talk is still on; tap to reconnect, or
tap off when it's back.

**Hold the phone like a walkie-talkie, close to your mouth, away from the speakers.** The phone's echo cancellation only
removes what the phone itself plays, not the park speakers. If you are listening on the same phone, Listen pauses while
you talk.

## What you see in Ether

- **By the Park mic's fader:** "Talking now: Ryan (Park page) · 6 s" while someone talks, with a **STOP TALK** button
  that ends the talk at once. Afterwards, "Last: Ryan, 8:42 PM, 14 s", plus how it ended if a person in Ether ended it
  (stopped in Ether, locked by the studio).
- **The fader's state line:** PARK MIC 1 · ready, or live while voice arrives.
- **Health Monitor events:** park-talk-start, park-talk-stop (with seconds), park-talk-cut (STOP in Ether or the studio
  lock), park-talk-line-dropped (the phone's line dropped during a talk; it stayed on), park-talk-line-never-opened,
  park-talk-refused.

## The rules

- **Logged-in staff only.** The button isn't shown to anyone who isn't logged in.
- **One person per Park mic.** While Ryan talks on Front gate, other phones show **"Ryan is talking"** on that mic. The
  other Park mic is free.
- **Only a person ends a talk:** the talker's tap, **STOP TALK** in Ether, or the studio lock (**Park page control**
  OFF on the station strip, which also refuses new talks: "Controls locked by the studio").
- **MUTE.** Park MUTE silences the voice in the park, like everything else there. When the park is muted and the Park
  mic goes to the park only (MAIN not lit), the button says **"Park is muted. Unmute to be heard."** When MAIN is lit,
  the button says **"Park is muted — on air only (MAIN)"**.

## If it doesn't work

- **"Talk isn't set up on this station":** put a Park mic on a fader (step 1). Check that the bottom line in Preferences
  says it is available.
- **"… isn't on a fader in Ether":** that Park mic was taken off its fader; put it back.
- **"… fader is OFF in Ether":** turn the fader's channel ON.
- **"Microphone is blocked for this page":** the steps for that phone are shown under the button (iPhone: aA → Website
  Settings → Microphone → Allow; Android: the icon left of the address → Permissions → Microphone → Allow). Then reload.
- **Stays on CONNECTING…:** the line to the park hasn't opened. Check the phone's signal; tap to stop and try again.
- **The voice cuts in and out:** raise the **Park mic buffer** a little (for example to 200 ms).
- **"Station offline":** the computer that plays the park isn't connected.
