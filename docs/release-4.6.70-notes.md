# Ether 4.6.70 — release notes

Everything since 4.6.57, the last published version. (4.6.58 to 4.6.69 were test builds and were never published, so
all of it arrives together here.)

**Important when updating:** close Ether fully (including the tray icon) and open it again after the update, so the
audio engine starts fresh.

---

## Signing in

- **The account sign-in screen comes first when you open Ether.** Once Ether is running, the sign-in renews quietly in
  the background, so nobody is signed out and no sign-in screen pops up. A restart while you're on air goes straight
  back on air.
- **Your sign-in is kept in this computer's protected storage**, no longer in the station database or in any backup.
- **No more license keys.** You sign in with your Ether account's email and password. The "Enter License Key" option is gone.
- Plans now show their current names and prices: Local, Live 128, Live 320 and Network.
- If there's a problem with a trial or a payment, a small notice appears at the top right with what to do. The same
  notice shows once a day at most; a new, more serious one shows right away. It never stops playout.

## The board

- **Patch Bay (☰ → Patch Bay):** every output and input in one place.
  - Outputs: send Master, Cue (headphones) and Aux to any device and channel pair, up to four devices at once.
  - Inputs: connect sound-card inputs, Park mics and the Remote Link feed to the board's faders. The fader's SOURCE
    choice and the Patch Bay always agree.
  - A missing device is named in red. It is never quietly swapped for another one.
  - A device that keeps stopping is shown as stalled and retried. A setting decides whether the Master output then
    switches to the Windows default device; unless you turn that on, Ether never switches by itself.
  - If no Master device is open, the station keeps its own clock, so the stream to listeners keeps going.
- **Faders feel like a real console:** proper fader caps, double-click for 0 dB, grab without jumping, Shift for fine moves.
- **The board never gets cut off:** it scrolls sideways with Master Out pinned, and a FADERS overview shows them all.
- **Decks A, B and C can fold into one strip** that follows whichever deck is playing.
- The thin play-progress bar is back on the source faders.
- The "−" button removes a source channel in one click, and it stays removed.
- MONITOR now controls every local output, AUX and window playback included.
- The limiter's peaks land exactly on the ceiling you set.

## Remote Link

- **Through Ether's relay:** pick the computer and station. There's no address, port or router setup.
- The receiving computer approves a new sender once and remembers it.
- You can still type an address for a direct connection under "Advanced".

## Streaming

- **Stream Manager (☰ → Stream Manager):** the live stream's status, time on air, real bitrate and listener count, the
  listen link, and your server settings, all in one place.
- **Stream Metadata Outputs (Settings → Broadcast):** every song that starts is sent as "Artist - Title" to your Icecast
  mount, Shoutcast, TuneIn AIR, a webhook, or an RDS encoder.
- **Remote Access (Settings → Broadcast):** a phone remote on this computer's Wi-Fi (now playing, Up Next, Skip, Stop all,
  AUTO on/off), protected by a 6-digit code.
- The stream format you choose (MP3, AAC or OGG) is the one that's sent. Before, it was always MP3.
- A server address with its own port (for example :8443) is used exactly as written. A failing stream says why, and you
  can stop it while it retries.

## Playout and the log

- **No song airs twice by mistake.** Each deck keeps its own place in the log.
- **The hour plays through:** the song playing at the top of the hour finishes, then the new hour starts. The show
  schedule decides where shows begin, and the log plays as built.
- **Every computer builds its own log** for each station, before each show starts.
- Rotation rules now take effect: STRICT and SOFT rules and "Max songs in a row from same category." When no song fits,
  the one that has waited longest goes in.
- Program Log → **Why this song** explains each pick.
- If audio stalls, Ether picks up the same song at the same spot.
- Announcements: you choose how late a line may still play. A skipped line says it was skipped and why.

## Library and files

- **Songs play from where they're stored:** the catalogue by default, or the file you chose. Ether never moves,
  downloads or repoints a file without asking you first.
- Choose the catalogue folder in Settings. You can also choose whether missing files download into it automatically.
- Import Music finds songs you already have before copying anything (Skip, Replace, or decide for each song).
- Deleted songs stay deleted on every computer.
- Editing one field of a song changes only that field.
- Songs move between computers in the right categories, with their artists.

## Multiple computers, backups and users

- Sync is per station, with one switch per computer.
- The Play Log shows which computer aired each song, and you can filter it by computer.
- Backups follow a schedule you set on each computer, both local and cloud. Every backup is listed so you can restore from it.
- Users and their PINs (now stored more securely) are the same on every computer.

## Settings and screens

- "Preferences" is now called **Settings**. It opens at once: no more freeze while it counts sync numbers.
- Remote Link, Jukebox, Park Page and Audio Devices each have their own section.
- Settings → **Links** lists every public page of your account and stations, each with Open and Copy.
- New ☰ menu entries: Patch Bay, Stream Manager, EAS Logbook and Voice Tracker.
- **Update window → Details** shows what's new in each version since yours.
- **Help → Documentation opens the Ether User Manual**, a PDF that comes with Ether, so it works without the internet.
- The ON AIR button and the web dashboard say **Start streaming**.
- Sign-in and setup screens fit your screen.
- The screen no longer jumps while lists update, and switching screens no longer slows the board.

## Park page and mics

- Hold to talk on Park mics, with a To stream switch.
- The station sees what the park speakers play (the complete local mix) and can mute it.
- A Park mic stays on until you turn it off. There's no time limit.

## Fixes across the app

- Voice tracking uses the mic you picked, and Send to Deck loads the take.
- Show+ DAW: To Deck loads the mix; Load session, Export and CLIP saving work.
- Saving files (DAW exports, Play Log CSV) writes the file you choose.
- EAS Logbook dates and times show your local time.
- Up Next reordering stays where you put it.
- View → Deck A/B/C/Mic Deck show or hide those decks.
- Phone Desk → CART works.
- Cloud Log Backup saves its description.
- Song Analysis → Reset clears only the current station's songs, after asking.
- Every "are you sure?" uses Ether's own window. Reloading keeps you signed in.
- Check for Updates always answers. About shows this version's notes.
- Keyboard: one shortcut list with only real keys. Single-key shortcuts ignore Ctrl/Alt.
- Iris is hidden until it ships.

## Under the hood

- Ether reports its version when it signs in, so support can see which version each computer runs.
- On Windows, the installer closes the old app and audio engine cleanly before installing.
- The audio engine always matches the app (fixed for Intel Macs), and a build with a missing engine file is refused.
