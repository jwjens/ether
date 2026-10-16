---
feature: park-hold-to-talk
title: Park page — Hold to talk (Park mics)
summary: Logged-in park staff press and hold a button on the Park page and talk from their phone over the park speakers (and on air too, if that fader's MAIN is lit).
where: Park page (park.ether-cast.com/<your-station>) → HOLD TO TALK, under LISTEN. In Ether: a fader's source → Mic → Park Mic 1 / Park Mic 2. Settings: Preferences → Audio → Park page — Hold to talk
since: Ether build 2026-10-16
audience: operator
tour: true
---

# Park page — Hold to talk (Park mics)

## What it is

**Hold to talk** turns a staff member's phone into a microphone for the park. They press and hold **HOLD TO TALK** on
the Park page, talk, and let go.

The voice arrives in Ether on a **Park mic**. There are two, **Park Mic 1** and **Park Mic 2**. They are inputs like a
sound-card mic: you put each on a fader. It plays in the park like every fader, and **that fader's buttons decide the
rest**:
- **MAIN:** lit = the voice also goes on air; not lit = the park only;
- **DUCK:** lit = the music dips under the voice;
- the fader's level and its channel **ON** switch, as on every fader.

So one Park mic can go on air while the other stays in the park only. Any processing of the voice (EQ, compressor)
goes in that fader's own rack, like every other fader; nothing is added for you.

## When to use it

- Talking to visitors over the park speakers from anywhere in the park.
- A Park mic with **MAIN** lit when what is said is part of the show; not lit for park-only messages.

## Set it up (once per station, in Ether)

1. **Put a Park mic on a fader.** On the board, set a fader's source to **Mic** and pick **Park Mic 1 (Park page)**
   (or **Park Mic 2**). They are listed with this computer's other inputs.
   - The first time you do this, Hold to talk's starting values go into Preferences: longest talk **20 s**, phone echo
     cancellation **ON**, noise suppression **ON**, automatic gain **OFF**. You can change every one.
2. **Set the fader's buttons:** **MAIN** (on air too, or park only) and **DUCK**; bring the fader up and turn it ON.
3. **Name the Park mics** in **Preferences → Audio → Park page — Hold to talk**, for example "Front gate". The phone
   shows these names.
4. Check the line at the bottom: **"Hold to talk is available on this station's Park page…"**.

## Use it (Park page)

1. Log in on the Park page with your Ether username and PIN.
2. If there are two Park mics, pick one by its name above the button.
3. **Press and hold HOLD TO TALK.** It shows **CONNECTING…** (amber). Keep holding.
4. When it shows **TALK NOW** (green), talk. The station is receiving your voice. A bar shows your level, and the
   button counts down the time left.
5. **Let go** to stop. It also stops by itself at the longest talk.

The first time on a phone, the phone asks for the microphone. That first press only turns the microphone on; press
and hold again to talk.

**Hold the phone close to your mouth and away from the speakers.** The phone's echo cancellation only removes what the
phone itself plays, not the park speakers. If you are listening on the same phone, Listen pauses while you talk.

## What you see in Ether

- **By the Park mic's fader:** "Talking now: Ryan (Park page) · 6 s" while someone talks, with a **STOP TALK** button
  that ends the talk at once. Afterwards, "Last: Ryan, 8:42 PM, 14 s", plus how it ended if it didn't end with a
  release (cut at the limit, stopped in Ether, locked by the studio, phone gone).
- **The fader's state line:** PARK MIC 1 · ready — nobody talking, or live while a voice arrives.
- **Health Monitor events:** park-talk-start, park-talk-stop (with seconds), park-talk-cut (limit or lock),
  park-talk-no-audio (started but no voice arrived), park-talk-refused.

## The rules

- **Logged-in staff only.** The button isn't shown to anyone who isn't logged in.
- **One person per Park mic.** While Ryan talks on Front gate, other phones show **"Ryan is talking"** on that mic. The
  other Park mic is free.
- **The studio lock.** When the station strip's **Park page control** is OFF, Hold to talk is locked too ("Controls
  locked by the studio"). Turning the lock on while someone talks cuts them off within a second or two.
- **MUTE.** Park MUTE silences the voice in the park, like everything else there. When the park is muted and the Park
  mic goes to the park only (MAIN not lit), the button says **"Park is muted. Unmute to be heard."** When MAIN is lit,
  the button says only the stream will hear you.
- **Longest talk.** The phone, the server and the station each stop at the longest talk, so a stuck button or a
  dropped phone can't hold the park open.

## If it doesn't work

- **"Hold to talk isn't set up on this station":** put a Park mic on a fader (step 1). Check that the bottom line in
  Preferences says it is available.
- **"… isn't on a fader in Ether":** that Park mic was taken off its fader; put it back.
- **"… fader is OFF in Ether":** turn the fader's channel ON.
- **"Microphone is blocked for this page":** the steps for that phone are shown under the button (iPhone: aA →
  Website Settings → Microphone → Allow; Android: the icon left of the address → Permissions → Microphone → Allow).
  Then reload.
- **Stuck on CONNECTING…, or "No voice reached the park":** the phone or the station lost the connection. Let go and try
  again. The Health Monitor shows park-talk-no-audio.
- **"Station offline":** the computer that plays the park isn't connected.
