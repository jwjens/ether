# EtherCast Operator Manual

*Ether 4.6.50 and the features on branch log-reader-flip · assembled 2026-09-27 from the in-app help (41 topics).*

This manual is the in-app help, gathered into chapters. Each topic says **where** to find the feature. To change the manual, edit the help file (`docs/help-<topic>.md`) and re-assemble — never edit this file by hand.

## Contents

1. [Getting started & accounts](#1-getting-started--accounts)
   - [Switching accounts on one computer](#switching-accounts-on-one-computer)
   - [What Happens When My Trial Ends](#what-happens-when-my-trial-ends)
2. [On air: decks, board & faders](#2-on-air-decks-board--faders)
   - [Starting a Deck — the ON button](#starting-a-deck--the-on-button)
   - [Channel Faders and Channel Cut (ON/OFF)](#channel-faders-and-channel-cut-onoff)
   - [Master and Monitor Faders](#master-and-monitor-faders)
   - [Segue overlap (no dead air between songs)](#segue-overlap-no-dead-air-between-songs)
   - [Show Presets (save and recall the whole board)](#show-presets-save-and-recall-the-whole-board)
3. [Mics & sources](#3-mics--sources)
   - [Mic on Air (the mic as a channel)](#mic-on-air-the-mic-as-a-channel)
4. [Processing, EQ & meters](#4-processing-eq--meters)
   - [Reading the Meters](#reading-the-meters)
   - [Loudness Meter (M / S / I / LRA / True Peak)](#loudness-meter-m--s--i--lra--true-peak)
   - [Audio Processing (Loudness & Limiter)](#audio-processing-loudness--limiter)
   - [The Master Rack (Processor)](#the-master-rack-processor)
   - [Channel EQ (Filters and PEQ on a fader)](#channel-eq-filters-and-peq-on-a-fader)
   - [Gate and Compressor on a channel (and the Voice preset)](#gate-and-compressor-on-a-channel-and-the-voice-preset)
5. [Programming: log, schedule, clocks, rotation](#5-programming-log-schedule-clocks-rotation)
   - ["The Program Log"](#the-program-log)
   - ["Editing the log by hand"](#editing-the-log-by-hand)
   - [Schedule Manager](#schedule-manager)
   - [Rotation Goals](#rotation-goals)
   - [Rotation Analytics](#rotation-analytics)
   - ["Designated generator — which computer builds this station's log"](#designated-generator--which-computer-builds-this-stations-log)
   - [Play Log exports (as-run affidavit, BMI, ASCAP)](#play-log-exports-as-run-affidavit-bmi-ascap)
6. [Imaging, sweepers & spots](#6-imaging-sweepers--spots)
   - [Sweepers](#sweepers)
   - [Imaging](#imaging)
   - [Reel Splitter — cutting a sweeper reel](#reel-splitter--cutting-a-sweeper-reel)
   - [Spots & Promos](#spots--promos)
   - [Spot Artwork](#spot-artwork)
   - [Traffic & As-Run](#traffic--as-run)
   - [Scheduling Announcements](#scheduling-announcements)
7. [Library & files](#7-library--files)
   - [Open File Location](#open-file-location)
   - [Renaming an item (Library, Reel Splitter, sweeper pools)](#renaming-an-item-library-reel-splitter-sweeper-pools)
   - [Deleting a Song](#deleting-a-song)
8. [Stations, sync & backup](#8-stations-sync--backup)
   - [Backing up your station, and putting it on another computer](#backing-up-your-station-and-putting-it-on-another-computer)
   - [Multi-Machine Sync](#multi-machine-sync)
9. [Health & troubleshooting](#9-health--troubleshooting)
   - [Health Monitor](#health-monitor)
   - [Live Activity](#live-activity)
   - ["Warning: the audio engine is running an older build"](#warning-the-audio-engine-is-running-an-older-build)
10. [Tools & windows](#10-tools--windows)
   - [Windows — everything opens beside the live screen](#windows--everything-opens-beside-the-live-screen)
   - [Jukebox (public request wall)](#jukebox-public-request-wall)
   - [Cut and send from the Show+ DAW](#cut-and-send-from-the-show-daw)
   - [The Smart Tool (Show+ DAW)](#the-smart-tool-show-daw)
   - [Park Ops — the closing time, from any phone](#park-ops--the-closing-time-from-any-phone)

---

## 1. Getting started & accounts

### Switching accounts on one computer

*Every account that signs in on this computer gets its own private folder — its own stations, library, logs and settings. Signing out closes Ether; signing back in reopens that account exactly as it was.*

**Where:** File ▸ Sign Out (to switch); Settings ▸ System ▸ Factory reset this computer (to start over)  
**Since:** 4.4.229

**What this is:** every account that signs in on this computer gets its own private folder — its own
stations, library, logs and settings. Signing in opens that account's folder. Signing out closes it.
Nothing is deleted either way.

If you have ever signed out of one account, signed into another, and found your stations gone — that
cannot happen any more.

---

#### Signing in

1. Open Ether. The sign-in screen appears.
2. Enter your email and password, then choose **Sign in**.
3. Ether opens your account's folder and your stations come up.

**The first time an account signs in on this computer,** Ether creates an empty folder for it and
walks you through setting up your first station. Nothing belonging to any other account is touched.

**Every time after that,** Ether re-opens the folder that account already has. Your library, clocks,
categories and settings are exactly where you left them — nothing is downloaded again, and it takes a
moment rather than minutes.

#### Switching to a different account

1. **File ▸ Sign Out.**
2. Confirm. **Ether closes completely**, including the audio engine.
3. Reopen Ether.
4. Sign in as the other account.

Both accounts stay on the computer. Neither can see or change the other's stations, library or logs,
and signing back into either one brings it up exactly as you left it.

> **Why does Ether close instead of going straight back to the sign-in screen?** Because your
> account's files are still open until it does. Closing all the way means the next account signs in
> with nothing holding on to anything — which is what makes switching reliable rather than
> occasionally stuck.

> **What happens to the station that was on the air?** Signing out stops the audio engine. Only the
> account you are signed into runs its stations — a signed-out account is completely dormant: it does
> not broadcast, generate logs, run sweeps, or back anything up. If you are on the air, take the
> station off the air before signing out.

#### What "signing out" does and does not do

| It does | It does not |
|---|---|
| Close Ether completely | Delete your stations |
| Stop the audio engine | Delete your music library |
| Close your account's folder | Delete your settings, clocks or categories |

Signing out is closing a door, not clearing a desk.

#### The first time you update to this version

Ether moves your existing station data into a folder named after your account. This happens once,
automatically, the first time you open the app. It is a move, not a copy, so it is quick and uses no
extra disk space, and your data is never duplicated.

**If the move cannot finish** — usually because the audio engine still has the database open — Ether
leaves everything where it was and carries on exactly as before, with nothing moved and nothing lost.
Close Ether completely (including the audio engine in the system tray), reopen it, and it will try again.

> **Known issue:** a move that could not finish is not shown on screen — it is only written to Ether's
> log. If your data does not seem to have moved, close Ether completely and reopen it.

#### If you are asked to sign in when you did not expect it

Ether shows the sign-in screen whenever it cannot tell which account's folder to open — for example
after a folder has been moved or removed outside the app. It will never guess. Sign in and it will
open the right one.

#### Starting an account completely over

**Settings ▸ System ▸ Factory reset this computer ▸ Factory reset…** You must type your account email
twice to confirm (or the word **RESET**, twice, if no account email is on file). Then press
**Erase & close Ether**.

This erases **only the account you are signed into** — its database, library records, logs and
settings on this computer — then closes Ether completely. Other accounts on the same computer, and
this account on your other computers, are untouched. It is the only thing in Ether that erases a whole
account's data on this computer, and it never happens on its own.

---

**See also:** [Multi-machine sync](help-multi-machine-sync.md) — how one account's stations follow you
between computers.

### What Happens When My Trial Ends

*When a free trial lapses, sign-in shows a "your data is safe — pick a plan" screen with a Choose a plan button. Nothing is deleted; broadcasting resumes the moment you pick a plan.*

**Where:** Account sign-in screen (shown automatically if the trial has lapsed)  
**Since:** 4.4.66

#### What it is

When your **free trial** reaches its end date, EtherCast can no longer load your stations until you
pick a plan. On the next sign-in you'll see a message on the account screen:

> **Your free trial has ended. Your stations and library are safe — pick a plan to keep
> broadcasting.**

This is **not** an error and **not** a lost account. It's a doorway: a trial that lapsed is a
different thing from a bad license key, and EtherCast tells you so plainly.

#### Your data is safe — nothing is deleted

The most important thing: **a lapsed trial never deletes anything.**

- Your **stations**, **categories/clocks/programming**, and **song library** all remain in the
  cloud exactly as you left them.
- Expiry only **gates access** — it stops sign-in from loading the stations. It does **not** touch or
  remove any data, and your uploaded audio in cloud storage is never auto-deleted.
- The moment you pick a plan, **everything comes back** and you can go on air again. There is nothing
  to restore or re-upload.

#### What to do

1. On the trial-ended sign-in screen, click **"Choose a plan →"**. This opens the plan picker
   (normally `signup.ether-technologies.com`) in your web browser.
2. Pick the plan that fits your station and complete checkout.
3. Come back to EtherCast and **Sign in** again. Your stations load and you're broadcasting.

#### If your trial ends while EtherCast is open

EtherCast also checks the trial date when it starts and every 10 minutes while it runs. If the trial has
ended, your plan drops to **Solo (free)** and a window opens: **"Your free trial has ended"**. It gives
you two choices:

- **See plans & subscribe →** — opens the Subscription panel so you can pick a plan.
- **Continue on Solo (Free)** — keep using EtherCast on the free Solo plan.

Your stations, library and settings are saved either way. Already subscribed? Open **Subscription** and
sign in there to restore your plan.

#### If you see a different message instead

- **"Your account's license was rejected… contact support"** — that's a genuinely invalid license
  key, not a lapsed trial. Contact support to restore it.
- **"Couldn't reach the server…"** — that's a network problem on this machine. Check your connection
  and try Sign in again.
- **"This account's devices are full…"** — you've used all your plan's device seats. Free one up
  under Manage Devices, then sign in.

Each message names the actual cause — you never have to guess which one you're looking at.

---

## 2. On air: decks, board & faders

### Starting a Deck — the ON button

*ON is the only start control. It starts a cued deck and takes over from whatever is playing; pressed on a playing deck it turns that channel off. The old XFADE button is gone.*

**Where:** Live panel → each deck's ON button  
**Since:** 4.4.121

#### What it is

**ON is how you put a deck on air, and it is the only button that does it.** It works the way a channel ON
button works on a real broadcast board: press it and that channel goes on. Press it on the channel that is
already on and that channel goes off.

If you used the **XFADE** button before, it is gone — ON does that job now, and does it more safely. You no
longer have to think about which button starts a deck and which one swaps decks. There is one button.

#### When to use it

- You want to **skip to the next track right now** — a wrong track, a bad file, something you need off the
  air immediately. Cue the next deck and press its ON.
- You want to **start the station** from silence.
- You want to **kill a channel** — press ON on the deck that's playing.

You do **not** need to leave AUTO to do any of this. Automation keeps rolling around you.

#### How to use it

##### Start a deck that is cued

1. Make sure the deck has a track loaded on it (the deck shows a title — that's a **cued** deck).
2. Press that deck's **ON**.
3. The deck goes on air. If another deck was playing, it comes **off within about a third of a second**.

That's the whole operation. You don't stop the other deck first — ON does it for you, in the right order.

##### Turn a channel off

Press **ON** on the deck that is currently playing. That channel goes silent immediately.

This is a **stop, not a pause.** There is no resume — the deck goes back to idle. If you want that track
back, load it again.

##### Start from silence

If nothing is playing at all, press ON on any cued deck. It simply starts. Nothing has to come off first.

#### How it behaves on air

- **The handover is a clean cut, not a fade.** When you use ON to take over, the outgoing track is cut
  after about 300 milliseconds. That is deliberate: the reasons you reach for this button in a hurry —
  profanity, the wrong song, a garbled file — are all reasons the current audio needs to be **gone**, not
  fading underneath the new track for another three seconds.
- **Your normal automatic song-to-song segues are unchanged.** Those still use the station's normal
  smooth overlap. The quick cut applies only when *you* press ON.
- **Automation absorbs it and keeps going.** In AUTO, after you take over, the next tracks re-cue behind
  you automatically and the program log continues from where you skipped to. You do not have to re-arm
  anything.
- **In MANUAL, nothing auto-cues.** ON works exactly the same, but no track is loaded onto the standby
  decks afterward. In MANUAL you own the hour — cue every deck by hand, as intended.
- **Pressing it twice does nothing bad.** A second press on a deck that is already going live is ignored,
  not doubled. You cannot put two decks on air by hammering the button.

#### If it doesn't do anything

- **The deck is empty.** ON will not start a deck with no track on it — that would be dead air. Load a
  track first. The deck shows a title when it is genuinely cued.
- **You pressed the deck that's already live.** That's the "already on air" case — nothing to take over.
- **Check the Health Monitor's Live Activity.** Every start is logged there. You will see
  `operator start: deck B LIVE` or `segue: deck B LIVE` with the track name, so you can confirm what the
  station actually did.

#### Not in this version (by design)

- **No fade on the takeover.** It is a hard 300 ms cut. Automation never moves your faders — those are
  your controls, and ON does not touch them.
- **No keyboard shortcut** for ON.
- **No undo.** Channel OFF is immediate and final; reload the track if you need it back.

#### Known issue

- The **Space** and **B** keys still pause, resume or start a deck directly, outside the ON button, and
  the keyboard shortcut list still shows **X** (crossfade) and **Esc** (stop all decks), which no longer
  do that. Use **ON** to start and stop decks.

#### Related

- **MANUAL vs AUTO** — what automation does and does not decide for you
- Health Monitor → Live Activity — the running log of every start, segue and stop

### Channel Faders and Channel Cut (ON/OFF)

*Your fader is your level and nothing moves it but your hand — or a show you TAKE — not a track load, not a device change, not the ON/OFF switch. Your faders come back after a restart, and every level change is smooth. ON/OFF is a channel cut that silences the channel without touching where you set the fader.*

**Where:** Live panel → the mixer strips (decks A–F, CART, SWEEPERS, and the source channels G onward)  
**Since:** 4.4.146

#### What it is

Every channel strip has two separate controls, and they do two different jobs:

- **The fader** — **your level** for that channel, in dB. Where you park it is where it stays.
- **ON / OFF** — the **channel cut**. OFF silences the channel completely. It does **not** move your fader.

This is how a broadcast board works: the switch is the door, the fader is the level. Opening and closing
the door never changes the level you set.

#### Your fader stays where you put it

**Nothing moves your fader but your hand** — and a **show preset you TAKE**, because pressing TAKE is your hand
too (see **Show Presets**). Specifically:

- **Loading a track does not move it.** Ride a deck down, and the next song into that deck plays at the
  level you set — it does not jump back to full.
- **Turning the channel OFF and back ON does not move it.** The audio returns at exactly your level.
- **A sound-card change does not move it.** If the station fails over to another output device mid-show,
  your levels come back untouched.

- **A restart does not move it.** Ether remembers every fader (and the master) for the station and puts them
  back when it starts.

##### Every level change is smooth

When a level changes — your drag, a show you TAKE, TAKE NOW, or the levels coming back at start — the engine
glides it over **20 milliseconds** instead of jumping. A jump in level makes a click on air; the glide doesn't,
and it is too short to hear as a fade. A level that isn't changing is untouched.

##### PENDING on a channel

After you **TAKE** a show, a channel that was **ON** keeps what it has, so nothing changes under a live voice or
a playing song. Its ON button **flashes amber and says PENDING**, with the show's name above it.
- Switch it **OFF** (or let the deck finish) and the show's settings land.
- Or press **TAKE NOW** on that strip to apply them while it stays ON. The level glides; it doesn't jump.

See **Show Presets** ([Show Presets (save and recall the whole board)](#show-presets-save-and-recall-the-whole-board)).

##### What about tracks that are too loud or too quiet?

Each track can carry its **own loudness trim**, worked out from the file itself. That trim is applied
**before** your fader, so it evens out the material *underneath* your hand — quiet songs come up, hot songs
come down, and your fader still means what you set it to mean. The trim belongs to the track; the fader
belongs to you.

#### Cutting a channel (ON / OFF)

Press **ON** to toggle the channel cut.

- **ON (lit)** — audio passes.
- **OFF (unlit)** — the channel is **cut**: nothing from it reaches air. The fader stays exactly where it
  is, and the strip dims to show it is switched off.

A dimmed strip means **off, not broken.** The fader still works while the channel is cut — you can set your
level ahead of time and it takes effect the moment you turn the channel back on.

#### When to use the cut

- **Kill a channel's audio without losing your level** — you'll want it back at the same setting.
- **Run a clean segment with no imaging** — cut the SWEEPERS channel and sweepers stay off air even though
  they still fire on schedule. See **Sweepers** for that channel specifically.
- **Silence a guest or mic channel** between segments.

#### Listening to a channel off air (PFL)

**PFL** ("pre-fader listen") lets you hear a channel **without putting it on air**: check a mic before you open
it, or cue a cart.

1. Press **PFL** on the channel's strip. The button lights **amber** once the audio engine is doing it. The lamp
   is the engine's answer, not just your press.
2. You hear that channel in **this station's local output** (the speakers or headphones the music plays through
   here):
   - **before its fader and before ON/OFF**, so it works with the channel OFF and the fader down;
   - **after its channel EQ**, so you hear the processed sound.
3. **While any PFL is on, the programme in that output dips** so you can hear what you're checking.
   - How far is a station setting: **Preferences → Audio → PFL → Programme dip** (−60 to 0 dB).
   - **−12 dB** until someone changes it.
4. Press **PFL** again to stop.

**Nothing on air changes.** The stream, the programme and every on-air meter are exactly as they were. PFL only
ever reaches the local output.

##### PFL in headphones (a separate PFL output)

By default PFL plays through the **main local output**, and the programme there dips. To keep PFL off the
speakers:

1. Go to **Preferences → Audio → PFL → PFL output**.
2. Pick your **headphones** (or any output on this computer). The default is **Same as main output**.

**Then, while any PFL is on:**
- **the headphones** carry the channel you're checking, plus the programme at the dip level so you keep your
  place;
- **the main speakers are left completely alone.**

With no PFL on, the headphones are silent.

**The PFL output belongs to this computer.** Each computer picks its own; it never syncs.

**If the chosen headphones aren't connected, PFL is silent.** It never falls back to the speakers, where it
would surprise you.
- The strip shows **⚠ cue device not found — PFL silent** while its PFL is on.
- **Health Monitor → PFL Output** says the same.
- Plug the headphones back in and PFL returns by itself within a few seconds.

**A mic on PFL arrives about 40 ms late.** That's the time through the computer and back. It's fine for
checking how the mic *sounds*, but it's too late to talk against. **To hear yourself while you speak, use your
audio interface's direct-monitor.** See **Mic on Air**.

#### If a channel has gone silent

1. **Check its ON button first.** Unlit means you cut that channel — press it to restore.
2. **Check the fader** — it may simply be parked at the bottom.
3. **Check the meter.** The strip meter shows the SOURCE, before the fader and before ON/OFF. If it is
   moving, the source is alive — so a silent channel with a moving meter is cut (ON unlit) or faded down.
   If it is not moving, the source itself is silent. See **Reading the Meters**.

#### Not in this version (by design)

- **The cut is not a fade.** OFF is immediate and ON is immediate — use the fader if you want to ride it.
- **Not every channel remembers its cut.** The SWEEPERS channel, the source channels (G onward) and the
  jukebox channel remember ON/OFF per station — the jukebox channel starts OFF, so a public jukebox is
  never audible until you switch it on. Other channels may start a new session ON; check the ON lamps
  after a restart.

#### Related

- **Mic on Air** ([Mic on Air (the mic as a channel)](#mic-on-air-the-mic-as-a-channel)) — the mic as a channel, and hearing yourself
- **Show Presets** ([Show Presets (save and recall the whole board)](#show-presets-save-and-recall-the-whole-board)) — the whole board saved and recalled, PENDING, TAKE NOW

- **Starting a Deck — the ON button** — the deck ON button also starts and stops playout
- **Sweepers** — cutting the imaging channel, remembered per station
- **Audio Processing** — station-wide loudness on the program bus, after all the faders

### Master and Monitor Faders

*MASTER sets what your listeners hear. MONITOR sets how loud it is in your room. They are separate — turning your speakers down never turns the broadcast down.*

**Where:** Right-hand Master Out panel (MONITOR also in the pop-out Master Output window)  
**Since:** 4.4.154

#### What they are

Two faders at the top of the **Master Out** panel on the right-hand side. They do different jobs, and
the difference matters on air:

- **MASTER** — the **broadcast**. This is your station's output level: what listeners hear on the
  stream and what feeds your transmitter chain. Pull it down and your audience hears it quieter.
- **MONITOR** — the **speakers in your room**. This is your local listening level only. Turn it all the
  way down and your studio goes silent while the station keeps broadcasting at full level.

The rule to remember: **MASTER is heard by everyone. MONITOR is heard by you.**

#### When to use each

**MASTER**
- Trimming your on-air level.
- Dropping the broadcast for a moment without stopping playout.

**MONITOR**
- Turning the room down to take a phone call, or up to hear a mix detail.
- Talking to someone in the studio without touching what airs.

#### How to use them

1. Open the **Master Out** panel on the right.
2. Drag **MASTER** in that panel to set your on-air level. The **PGM, LOCAL and STREAM meters reflect the change** —
   they show what is actually going out, so what you see is what your listeners get.
3. Drag **MONITOR** to set your room level. Only the **MONITOR** meter moves, because your speakers are
   not the broadcast.

Both faders remember where you left them. If the audio engine restarts during a show, they are
re-applied automatically — the station will not jump back to full level, and your speakers will not go
silent, on their own.

#### Reading the meter

The master meters (PGM / LOCAL / STREAM / MONITOR) are measured **after** the faders. That is deliberate:

- If PGM is low and the audio sounds quiet to your listeners, **MASTER** is where to look.
- If your room sounds quiet but PGM is healthy, look at the **MONITOR** meter — your listeners are fine.

How to read the bar, the peak dot and OVER: see **Reading the Meters** ([Reading the Meters](#reading-the-meters)).

#### Things worth knowing

- **MASTER only turns down, not up.** It runs from silence to normal (unity) level. It cannot push the
  station louder than the mix, which prevents accidentally driving the signal into distortion.
- **Channel faders are separate.** Each deck and the mic have their own fader. MASTER applies once, at
  the output, after everything is mixed together — moving MASTER does not move your channel faders.
- **Two monitor controls, one room level.** The MONITOR fader in the panel and the one in the pop-out
  Master Output window both set the same room level.

#### If something looks wrong

- **The broadcast is quiet but I didn't touch anything.** Check MASTER. If it is down, drag it back to
  the top (unity).
- **My speakers are silent but the station is still on the air.** That is MONITOR at zero — which is the
  safe direction. Drag it up.
- **Moving MASTER doesn't change the meter.** Make sure you are moving MASTER in the **Master Out panel**,
  not the pop-out (see Known issue). If it still does nothing, check **Help → About** for your version and
  fully close and reopen Ether after an update.

#### Known issue

- **The MASTER fader in the pop-out Master Output window is not connected to the on-air level in this
  build.** Set MASTER in the Master Out panel. The pop-out's MONITOR fader is connected.

### Segue overlap (no dead air between songs)

*Starts the next song a few seconds before the current one ends, so the two overlap on the outgoing song's own ending and the music never drops to silence. No fades, and your faders never move.*

**Where:** File → Preferences → Audio → Audio Devices → "Segue overlap (auto)"  
**Since:** 4.4.74

#### What it is

Segue overlap starts the **next song a few seconds before the current one ends**, so the two briefly
overlap and the music never drops to silence between tracks. The songs play over each other's natural
endings — there are **no fades and nothing touches your faders**.

It is one setting, **Segue overlap (auto)**, and it applies while the station is running itself
(AUTO / on air).

#### Set it up

1. Open **File → Preferences** → the **Audio** section → **Audio Devices**.
2. Find **Segue overlap (auto)**.
3. Drag the slider (0–10 seconds) to how many seconds early the next song should start:
   - **3s** (default) — a natural, tight segue.
   - **1–2s** — a very short overlap.
   - **4s and up** — a longer overlap (the songs blend more).
   - **0 (off)** — the next song waits for the current one to fully end (a clean hard start).
4. That's it — it takes effect on the next transition.

#### How it works

- The next song **starts at full** while the current song plays out its **own ending** — both are heard for
  the overlap you chose, then the outgoing song finishes on its own. Nothing cuts it short.
- **Your faders never move.** The deck faders are yours; automation never touches them. Songs bring their own
  mastered fade-outs — the overlap just lets the next one begin over that tail.
- **Sweepers ride the same seam.** A sweeper's LEAD is timed against this overlap, so it lands on the start
  of the song it introduces (see **Sweepers**).
- **Never into or out of a spot.** A commercial is exclusive program content: the overlap is not applied at
  a spot's edges, so spots start and end clean.

#### Tips

- If there's a **beat of silence** between songs, raise the overlap a second or two (or check that your next
  track is cued/ready).
- If songs **step on each other** too much, lower it to 1–2s.
- Use **0 (off)** only if you want each song to start cleanly after the last one ends.

#### Where the setting lives

The segue overlap is **stored with the station**, not with this computer. Every machine running the station
segues the same way, and the audio engine reads it automatically — including after an app update or restart.
Each station has its own value.

#### Related

- **Sweepers** ([Sweepers](#sweepers)) — imaging that plays over the seam this setting creates.

### Show Presets (save and recall the whole board)

*Save the whole board as a show — every fader, channel EQ, gate and compressor, the ducker, the room and monitor levels, the master rack — and TAKE it back in one press. Channels that are ON keep what they have until you switch them OFF, so nothing changes under a live voice.*

**Where:** On the board, the SHOW bar above the faders (the dashboard and the pop-out board) → Arm a show… → TAKE. Save / Save As on the same bar.  
**Since:** unreleased (log-reader-flip, after 4.6.50)

#### What it is

A **show preset** is a snapshot of the **whole board** for this station. It holds, for every channel:
- whether the channel is on the board, and what it's patched to ("a mic", "the jukebox", "announcements");
- its fader level;
- its channel rack: filters, gate, EQ, compressor;
- its duck settings;
- its room level.

For the whole station it also holds:
- the master rack;
- the master fader;
- the ducker settings;
- the monitor level.

**Take a show** and the board changes to it in one step, in the same instant.

**One show is built in: Flat.** Every channel EQ empty, every fader at full, the ducker at its standard settings,
and the master at Ether's standard chain. It's always there as a known clean start.

#### Find it

The **SHOW** bar sits **above the faders**, in the dashboard and in the pop-out board. It shows:
- **SHOW Morning Drive**, the show you last took (**—** if you haven't taken one);
- **· modified**, when the board no longer matches it (you moved a fader, changed an EQ, and so on);
- **· waiting: A, G**, the channels still waiting for the show (see PENDING below).

#### Take a show

1. In **Arm a show…**, pick the show. **Nothing changes yet.** Arming only gets it ready.
2. The bar opens **what TAKE will change**:
   - **CHANGES NOW:** everything on channels that are OFF, and the master section.
   - **WAITS — ON NOW:** the changes for channels that are ON right now.
3. Press **TAKE ▸ *name***. Or press **DISARM** to put it away.

**Channels that are OFF change at once. Channels that are ON wait.** A mic that's ON waits even while nobody is
talking, and a deck that's playing waits until it stops. A show never changes anything under a live voice or a
playing song.

**A show never switches a channel ON.** Putting a channel on air is always your press.

#### PENDING and TAKE NOW

A channel that was ON when you took the show:
- keeps everything it had;
- its **ON button flashes amber and says PENDING**, with the show's name above it.

**When you switch it OFF** (or the deck finishes or stops), the show's settings land on that channel.

**TAKE NOW** on that strip applies the show to it right away, while it stays ON. Its level glides over 20 ms, so it
doesn't click.

**Waiting channels are remembered by the audio engine, not the screen.** Close the board, open the pop-out, or
restart Ether, and PENDING is still there.

#### Save a show

- **SAVE** overwrites the show you last took with the board as it is now.
- **SAVE AS…** saves the board under a new name.
- **Flat can't be overwritten.** Use Save As.

Shows belong to the **station**. They travel with it to its other computers, and a show saved for one station can
never be taken on another.

#### What a show does NOT hold (on purpose)

| Not in a show | Why |
|---|---|
| **Which microphone, which sound card, which headphones** | These belong to **this computer**; another computer has different devices. A show says a channel is *a mic*. *Which* mic is this computer's setting (Preferences → Audio → Mic Inputs). The mic's input gain stays with the computer too. |
| **Processing on / off** | A show never switches processing on or off (Preferences → Broadcast). |
| **PFL** | PFL is momentary; the PFL dim and PFL output are your preferences. |
| **The log, what's loaded, AUTO / MANUAL** | A show is the board, not the programme. |

#### Your faders after a restart

Ether remembers where every fader and the master were for each station, and puts them back when it starts.

#### Not in this version (by design)

- **Presets that follow a person** ("the host's mic settings go wherever the host sits") come in a later step.
- **No timed shows:** a show doesn't take itself at a set time.
- **A channel removed from the board while it's PENDING** keeps waiting until that channel is cut.

#### Related

- **Channel Faders** ([Channel Faders and Channel Cut (ON/OFF)](#channel-faders-and-channel-cut-onoff)): PENDING, smooth level changes
- **Channel EQ** ([Channel EQ (Filters and PEQ on a fader)](#channel-eq-filters-and-peq-on-a-fader)) and **Gate and Compressor** ([Gate and Compressor on a channel (and the Voice preset)](#gate-and-compressor-on-a-channel-and-the-voice-preset)): what
  a channel rack holds, and one-channel presets such as Voice
- **Mic on Air** ([Mic on Air (the mic as a channel)](#mic-on-air-the-mic-as-a-channel)): why the mic device stays with the computer

---

## 3. Mics & sources

### Mic on Air (the mic as a channel)

*A microphone is a channel on the board like any other — patch it to an input on this computer, set its gain, and it goes on air with its own meter, channel EQ, fader, ON and ducking.*

**Where:** On the board, a source channel's source dropdown → an input device (or "Mic — pick an input…"). Input number and gain: Preferences → Audio → Mic Inputs. Its live state: the strip, and Health Monitor → Mic Inputs.  
**Since:** unreleased (log-reader-flip, after 4.6.50)

#### What it is

**A mic is a source channel on the board patched to Mic.** It works like every other channel:
- **its own meter**, showing the mic before its fader;
- **its own channel rack:** Filters, a **Gate**, the PEQ and a **Compressor** (see **Channel EQ** and **Gate and
  Compressor**). **Start from the Voice preset**: open the rack (EQ on the strip) → Preset → Voice → TAKE;
- **its fader and ON**;
- **the ducker**: switch DUCK ON and the music drops under your voice.

**It goes on air**, through the same engine as the music. Before this, the mic only played on this computer's
speakers and never reached listeners.

You can have a mic on any source channel: D, E, F, and the extra source channels the + button adds (G onward). Each mic has its own input.

#### Put a mic on the board

1. Find a source channel (a strip with a **SOURCE** dropdown), or add one with **+**.
2. In its **SOURCE** dropdown, under **INPUT DEVICES (this computer)**, choose your microphone or interface.
   - Picking a device patches it at once — on input 1 at 0 dB the first time. Changing to another device later
     keeps your input number and gain.
3. The strip names the device, and the line under the dropdown says how it is: **● IN 1 · +0 dB · live**.
4. Bring the fader up and press **ON**. You're on air.

#### Set the input and the gain

Go to **Preferences → Audio → Mic Inputs** (or click the state line under the strip's dropdown). For each mic
channel you can set:

| Setting | What it does |
|---|---|
| **Input device** | Which input on **this computer** feeds the channel. The list is the one the audio engine sees. |
| **Input number** | For an interface with several inputs (Input 1, Input 2, …). |
| **Input gain** | −10 to +40 dB, before the meter and the channel EQ. Set your preamp first, then trim here. |

**Mic settings belong to this computer.** Another computer on the same station picks its own mic: device
names are different on every machine, so they never sync. The board layout itself (which channel is the mic)
is shared as usual.

#### An open mic and the ducker

If the mic channel's **DUCK** is on, anything it picks up (the room, a fan) can hold the music down. **Put a Gate
on the mic** (the Voice preset has one): the ducker listens *after* the gate, so a closed gate means the room noise
doesn't duck the music, and your voice still does.

#### Hearing yourself

**Use your interface's direct monitor** to hear your own voice in your headphones. It has no delay.

The engine's path back to your headphones takes a few tens of milliseconds. That's fine for **PFL**, to check
how the mic *sounds* through its EQ, but it's too late to talk against: you'd hear an echo of yourself.

#### What the state line means

| It says | What it means |
|---|---|
| **live** | The mic is running and on this channel. |
| **opening** / **starting** | It is opening, then filling its buffer; a moment. |
| **waiting for the engine** | The audio engine has not reported this mic yet. If it stays, fully close and reopen Ether. |
| **device not connected** | The chosen device isn't plugged into this computer. The channel is silent. It never switches to a different mic on its own: a wrong mic on air is worse than none. |
| **device lost — retrying** | It was unplugged or failed. The channel is silent, **the music keeps playing**, and Ether re-opens it by itself when it comes back. |
| **pure digital silence — Windows mic privacy?** | Windows is handing over exact silence. Almost always, Windows **Settings → Privacy → Microphone → "Let desktop apps access your microphone"** is off. It can also be a muted input. |
| **that input is not on this device** | The input number is higher than the device has. Pick another in Preferences. |
| **could not open** | The device would not open. The channel is silent. Pick the device again in Preferences, or choose another. |
| **no input — Preferences → Audio** / **no input patched** | The channel is set to Mic but no input is patched yet. |

When a mic isn't live, its meter is **hatched (NOT FED)** instead of reading zero, so you can't mistake a dead
mic for a quiet one.

**Health Monitor → Mic Inputs** lists every patched mic with its counters: dropouts, times lost, re-opened,
and the clock difference the engine is absorbing.

#### Good to know

- **Turn off Windows "audio enhancements"** for your mic (Sound settings → your mic → Properties): noise
  suppression and automatic gain there change your voice before Ether sees it.
- **Other apps can use the same mic at the same time** (voice tracking, Show+, Zoom). Ether shares it.
- **The old mic strip and its 10-band "mic input EQ" are gone.** They played only on this computer. Your mic
  channel moved to a source channel by itself; if it couldn't (every source channel was in use), the board
  says so. The old EQ settings were not carried over: use the channel EQ.

#### Not in this version (by design)

- Voice tracking and Show+ still record through the browser's audio, not this input (a later change).
- One channel per input device per station.
- No stereo pair input yet (a mic is mono).

#### Related

- **Channel EQ** ([Channel EQ (Filters and PEQ on a fader)](#channel-eq-filters-and-peq-on-a-fader))
- **Gate and Compressor** ([Gate and Compressor on a channel (and the Voice preset)](#gate-and-compressor-on-a-channel-and-the-voice-preset))
- **Reading the Meters** ([Reading the Meters](#reading-the-meters))
- **Health Monitor** ([Health Monitor](#health-monitor))

---

## 4. Processing, EQ & meters

### Reading the Meters

*Every meter in EtherCast is the same meter — a coloured average bar with a white peak dot riding above it, a hold tick, an OVER light and a mark at −18. Channel meters show the source before the fader; the master meters show each output after it.*

**Where:** Live panel → every mixer strip; Master Out → Bus meters and the Wild Meter; Health Monitor → each station card (PGM)  
**Since:** 4.6.50

#### What it is

EtherCast has **one meter**, and you see it in three places:

- **On every channel strip** (decks, SWEEPERS/CART, source channels, mic, guest) — the tall meter beside
  the fader.
- **In Master Out** — a row of four meters labelled **PGM**, **LOCAL**, **STREAM** and **MONITOR**, plus
  the **WILD** meter with a picker under it.
- **In the Health Monitor** — a thin **PGM** bar on every station card.

It reads the same everywhere, moves at the same speed everywhere, and means the same thing everywhere.

#### How to read one meter

Each meter shows the left and right channels side by side. On each side:

1. **The coloured bar is the average level** — roughly how loud it sounds. It moves smoothly.
   - **Green** — below −18.
   - **Amber** — from −18 up to −6.
   - **Red** — above −6.
2. **The white dot is the peak** — the highest single sample. It jumps up instantly and falls back
   steadily (20 dB in 1.7 seconds). The gap between the dot and the bar tells you how punchy the audio is:
   speech and dynamic music show a wide gap, heavily compressed music a narrow one.
3. **The thin grey tick is the peak hold.** It stays at the highest peak for 2 seconds and then falls, so
   you can catch a peak you blinked through.
4. **The purple line is −18.** That is the alignment level. A test tone at −18 sits exactly on it:
   the bar reads **−18** and the dot reads about **−15** (a steady tone's peak is 3 dB above its
   average).
5. **The red cap at the top is OVER.** It lights when the audio reaches full scale (0 dBFS) and stays lit
   for 2 seconds. On a channel it means the source itself is that hot. On STREAM or LOCAL it means the
   output was clipped.

The scale runs from **−60** at the bottom to **0** at the top.

#### Channel meters are BEFORE the fader

A strip's meter shows **the source**, not what the fader lets through:

- **Pull the fader down and the meter does not move.** That is deliberate: you can see a source is
  alive and at the right level before you bring it up.
- **Switch a channel OFF and its meter keeps moving.** OFF (the channel cut) silences the channel's
  contribution to the mix; it does not stop the source. A cut channel whose meter is dancing is a
  channel that is live and cut — press **ON** to put it on the air.
- A mic or guest strip shows the input level the same way: before its fader, whether ON or OFF. A **mic** is
  metered by the audio engine like every channel; when it isn't live (no input, disconnected, lost, or pure
  digital silence) its meter is hatched **NOT FED** instead of reading zero. See **Mic on Air**.
- **A strip's meter is also BEFORE its channel EQ** — it shows the source as it arrives. To see what the EQ
  did, open the fader's rack (the strip's **EQ** button): its **IN** and **OUT** meters are before and after
  the rack. See **Channel EQ**.

#### Master meters are AFTER the fader

The four meters in Master Out show each **output**, as it leaves:

- **PGM** — the programme mix after the MASTER fader. This is what the station is putting out.
- **LOCAL** — the local air output (the sound card the transmitter or console is on).
- **STREAM** — exactly what is sent to the stream encoder.
- **MONITOR** — the studio speakers, after the MONITOR fader.

Moving MASTER moves PGM, LOCAL and STREAM. Moving MONITOR moves only MONITOR, because your speakers are
not the broadcast.

#### The Wild Meter

The **WILD** meter at the end of the Master Out row can show **any** channel or output — pick it from the
list underneath it. Channels are shown before the fader, outputs after. Use it to spot-check one source
without hunting for its strip. Your choice is remembered on this computer.

#### "NOT FED"

A meter that has nothing to measure is drawn **hatched with NOT FED**, never as an empty bar. You see it
when:

- the audio engine is not running, or has stopped sending meter data for more than a second;
- an output does not exist right now — for example **LOCAL** when no local output device is set;
- a strip has no engine channel behind it.

An empty (dark) bar means **silence on a working meter**. Hatched means **the meter is not connected**.
The difference matters: an empty bar is evidence of silence; hatching is not.

#### If something looks wrong

- **A channel's meter moves but nothing is on the air.** Look at its ON button and its fader — the meter
  shows the source before both.
- **PGM moves but STREAM is flat or NOT FED.** The mix is fine; the problem is on the stream side. Open
  the Health Monitor.
- **Every meter says NOT FED.** The audio engine is not reporting. Check the Health Monitor's Engine
  section; if the engine has just updated, fully close EtherCast and reopen it.
- **The Health Monitor card and the master meter disagree.** Both read the same PGM tap, so they should
  match. Check **Help → About** for your version, and fully close and reopen EtherCast after an update.

#### Not in this version (by design)

- **No loudness (LUFS) on these meters.** The average bar is an RMS level, not loudness. Loudness (M / S /
  Integrated / LRA) for each output is in the master rack (**Master Out → Processor → OPEN**), in the meter
  column on the right — see **Loudness Meter**.
- **No true-peak.** The white dot is the sample peak. **True peak max** is in the same loudness panels.
- **One meter per strip.** A strip does not show before- and after-fader side by side; the after-fader
  level of the whole mix is on the master meters.

#### Related

- **Channel EQ** — [Channel EQ (Filters and PEQ on a fader)](#channel-eq-filters-and-peq-on-a-fader) (the before/after-EQ meters)
- **Channel Faders and Channel Cut (ON/OFF)** — [Channel Faders and Channel Cut (ON/OFF)](#channel-faders-and-channel-cut-onoff)
- **Master and Monitor Faders** — [Master and Monitor Faders](#master-and-monitor-faders)
- **Health Monitor** — [Health Monitor](#health-monitor)
- **Loudness Meter** — [Loudness Meter (M / S / I / LRA / True Peak)](#loudness-meter-m--s--i--lra--true-peak)

### Loudness Meter (M / S / I / LRA / True Peak)

*For each output — the Monitor (your local output) and the Stream — EtherCast measures the loudness of what that output actually sent, the way broadcast loudness is judged (ITU-R BS.1770 / EBU R128). Integrated loudness, loudness range and true-peak max run from the last Reset. The ride and the limiter each have their own meter.*

**Where:** Master Out → Processor → OPEN (the master rack) → the pinned meter column on the right  
**Since:** unreleased (log-reader-flip, after 4.6.50)

#### What it is

A loudness meter for each output, measuring **what that output actually sent** — after the ride and the
limiter, so nothing on it is an estimate:

- **Monitor** — your local output (the sound card the station plays on), measured **before** your monitor
  knobs. Turning the room down does not change the reading; it is the programme's loudness.
- **Stream** — exactly what goes to the stream encoder. It keeps measuring when no encoder is connected
  (for example in a rehearsal), and the panel says **"encoder not connected — metering what would be sent"**.

It measures the way broadcast loudness is judged (ITU-R BS.1770, EBU R128), and it was checked against the
EBU's own test signals (Tech 3341 and 3342) and against an independent meter.

#### Where to find it

1. Open **Master Out** (right side).
2. Next to **Processor**, press **OPEN**. The master rack opens in its own window, which you can move to
   another screen.
3. The **meter column on the right** of the rack shows, for each output, a **RIDE** and a **LIMITER** meter
   and a loudness panel. It stays visible while you edit and while you arm presets.

#### Reading it

| Reading | What it tells you |
|---|---|
| **M** (momentary) | Loudness of the last 0.4 s. Jumps around — it is the "now". |
| **S** (short-term) | Loudness of the last 3 s. Steadier; what you watch while riding a show. |
| **Integrated** | The average loudness since the last **Reset**, measured the standard way: silence and very quiet passages are left out so they don't drag it down. **This is the number compliance is judged on.** |
| **LRA** | Loudness range since the last Reset, in LU: how far loud parts and quiet parts are apart. Speech-heavy talk sits low; dynamic music sits higher. |
| **True peak max** | The highest peak since the last Reset, including peaks **between** samples (measured 4× oversampled), in dBTP. |

- The **M** and **S** bars are drawn on a scale **centred on this output's own target** (the purple line).
  **+9** shows 18 LU below to 9 LU above the target; **+18** shows 36 below to 18 above. Pick either with the
  small buttons; the choice is remembered on this computer.
- The bar colour and the word beside it say how far you are from the target: **ok** within 1 LU, **hot**
  within 3 LU, **over** further away in either direction (too quiet is off target too).

#### Reset

Press **RESET** on an output to start **Integrated**, **LRA** and **True peak max** again — for example at the
start of a show you want to measure on its own. The line beside it shows **"since hh:mm:ss"**.

- Reset does not touch the sound at all. It only restarts the measurement.
- After 24 hours without a reset, Integrated and LRA keep measuring the **most recent 24 hours**, and the line
  reads **"24 h window"**.

#### RIDE and LIMITER

- **RIDE** is the loudness ride's correction: how much it is turning the programme **up** (+) or **down** (−) to
  reach the target, drawn around a centre line up to the Clamp you set.
- **LIMITER** is how hard the limiter is holding peaks down: the deepest reduction in each moment, a white tick
  that holds the recent peak for 2 s, and **max 10 s** — the deepest in the last ten seconds, because a seam
  is over before you can read a moving bar.
- **OFF** (hatched) means that output's processing is not running, so there is nothing to show — it is never
  drawn as "0 dB".
- On the Monitor row, **room chain** means an aux deck is playing: the local output then comes from the room
  chain's own processor, and that is the one being metered.

#### The ceiling

The limiter's **Ceiling** label says what it does, for example **"−1.0 dBTP set · limits at −2.2 dBTP"**. The
limiter holds peaks about 1.2 dB below the setting (a safety margin). **True peak max** shows where your
output actually lands.

#### If something looks wrong

- **"incomplete: N s not measured"** — the computer was too busy for the meter to keep up for that long, so
  Integrated is missing that audio. The sound was not affected. Reset to start a clean measurement.
- **NOT FED** (hatched over M and S) — no audio is reaching that output's meter.
- **"no meter data from the engine"** — the audio engine is not reporting loudness. If EtherCast has just
  updated, fully close it and reopen it (the audio engine does not reload on its own).
- **OUT on the rows reads differently from before** — it is now measured on what the output sent; it used to
  be an estimate that never saw the limiter.

#### Not in this version (by design)

- No automatic reset at the start of a show yet — that needs the engine to know when a show starts. It will
  come as a setting, off unless you turn it on.
- No loudness per channel — this measures the outputs.
- No loudness log or compliance report.

#### Related

- **Audio Processing** ([Audio Processing (Loudness & Limiter)](#audio-processing-loudness--limiter)) — the ride, the limiter and their settings.
- **Reading the Meters** ([Reading the Meters](#reading-the-meters)) — the channel and output level meters.

### Audio Processing (Loudness & Limiter)

*Per-station loudness ride to a target (EBU R128) plus a −1 dBTP true-peak limiter on the program bus — opt in for the local monitor, the stream, or both.*

**Where:** Settings → Broadcast → Audio Processing  
**Since:** 4.4.91

#### What it is

Audio Processing keeps your station at a **consistent loudness** and stops it from **clipping**. It works on
the **program bus** — the single mix that feeds both your studio monitor and the stream — so every song, sweeper
and spot lands at the same perceived level instead of some tracks sounding quiet and others jumping out.

Two things happen, in order:

1. **Loudness ride** — the level is measured continuously (EBU R128 / LUFS, the broadcast-standard loudness
   scale) and gently nudged toward your **target** (default **−14 LUFS**, the streaming norm). It rides slowly,
   so you hear even loudness, not pumping.
2. **True-peak limiter** — a final safety catch holds the peaks at **−1 dBTP** so the stream never clips or
   distorts, no matter what the ride does.

Both are **OFF by default**. With both off, the audio passes through **bit-for-bit unchanged** — turning this
on is always your choice, per station.

#### When to use it

- Turn on **Process stream** when listeners tell you the station is too quiet, too loud, or jumps around in
  level between songs.
- Turn on **Process local output** if you want your **studio monitor** to hear the same processed sound the
  stream gets (otherwise your monitor stays clean/unprocessed).
- Leave both off if you already loudness-normalize your library elsewhere and want an untouched signal.

#### Set it up (Settings → Broadcast → Audio Processing)

1. Open **Settings** (gear) → the **Broadcast** category → **Audio Processing**.
2. **Process local output** — apply processing to THIS machine's speaker/monitor output only. The stream is
   unaffected. Use this to monitor the processed sound.
3. **Process stream** — apply processing to the Icecast stream — **what your listeners hear**.
4. **Target loudness** — the loudness the ride aims for (−30 to −6 LUFS). **−14 LUFS** is the streaming
   standard; louder (e.g. −12) is more aggressive, quieter (e.g. −16) is gentler. The limiter holds its
   ceiling regardless (see **The ceiling** below). If the stream is split from the monitor in the
   Processor rack, the stream's target is set there instead.

Each setting is **per station** and takes effect within a few seconds — no restart. Switch stations and set
each one independently.

#### The live meters

When either toggle is on, a **Live meters** panel appears:

- **IN LOUDNESS / OUT LOUDNESS** — the LUFS before and after processing. OUT should sit near your target.
  OUT is **measured** on what the output actually sent, after the limiter.
- **peak … dBFS** (under each loudness figure) — the loudest sample at that stage.
- **RIDE GAIN** — how far the ride is lifting (bar to the right) or lowering (bar to the left) the level,
  in dB. Under it, **limiter clamping −x dB** shows the limiter at work, or **idle** when it is not. A
  little clamping on peaks is normal; constant heavy clamping means your target is set too loud. On the
  Processor page the **ride** and the **limiter** each have their own meter — see **Loudness Meter**.

The meters read live off the engine — they show what's **actually** happening on air, not a prediction. If
they say "waiting for audio…", nothing is playing yet.

#### How it behaves on air

- Processing runs on the program bus, so it covers **everything** — songs, sweepers, announcements, spots.
- It does **not** move any deck fader or change your mix; it only shapes the final program level.
- Changing the target or a toggle applies on the fly; the ride eases in, it doesn't jump.

#### If you don't hear a difference

- Confirm the right toggle is on for what you're checking (**stream** vs **local monitor** are separate).
- Give the ride a few seconds — it moves slowly on purpose.
- Very quiet source material (well below the target) is lifted up to a point, then held; extremely loud
  material is caught by the limiter (watch GAIN REDUCTION move).

#### Not in this version (by design)

- No multiband compression — this is a **loudness ride + true-peak limiter**, not a full processing
  chain. The master **GEQ** lives in the Processor rack (see **The Master Rack**).

#### The ceiling

The **Ceiling** is adjustable in the master rack (Master Out → Processor → OPEN) (−3 to −0.1 dBTP; −1.0 unless you change it). The label
under it says what the limiter **does**, not only what it is set to — for example
**"−1.0 dBTP set · limits at −2.2 dBTP"**. The limiter detects peaks with a safety margin (×1.15, about
1.2 dB), so it holds the output that much below the setting. The **True peak max** reading on the loudness
panel shows where your output really lands.

#### Related

- **The Master Rack** ([The Master Rack (Processor)](#the-master-rack-processor)) — the GEQ, ride and limiter as a rack, with presets.
- **Loudness Meter** ([Loudness Meter (M / S / I / LRA / True Peak)](#loudness-meter-m--s--i--lra--true-peak)) — M / S / I / LRA / true peak for each output.
- **Broadcast delay & DUMP** (Settings → Broadcast) — profanity delay on the stream path.
- **Categories / Clocks** — programming that feeds the program bus this processes.

### The Master Rack (Processor)

*The master processing chain as a rack you can see and play while on air — the master EQ, then for each output (Monitor and Stream) the loudness ride and the true-peak limiter — with the meters pinned beside it and presets you Arm and Take.*

**Where:** Master Out → Processor → OPEN (its own window). Master Out → Master EQ → OPEN opens it with the EQ selected.  
**Since:** unreleased (log-reader-flip, after 4.6.50)

#### What it is

Everything that shapes your station's sound after the mix, laid out left to right in the order the audio goes
through it:

- **PGM** — the **GEQ**, the 10-band master EQ. It shapes the whole programme, before it splits.
- **MONITOR** — your local output: the **RIDE** (loudness ride) then the **LIMITER** (true-peak limiter).
- **STREAM** — what the stream encoder gets: its own RIDE then LIMITER.

While **LINKED**, the stream runs exactly the monitor's settings. **SPLIT** gives the stream its own. Splitting
changes nothing by itself; the stream starts as a copy of the monitor.

Each kind of module always has the same colour: **blue** for EQ, **cyan** for loudness, **magenta** for dynamics
(the limiter), and **green** for filters. Each fader's own channel rack uses the same colours (see **Channel EQ**).

#### Open it

1. Go to **Master Out** (right side).
2. Next to **Processor**, press **OPEN**. The rack opens in its own window, so you can put it on another screen.
3. Or next to **Master EQ**, press **OPEN**. The same rack opens with the **GEQ** already selected.

#### Using it

1. **Tap a module** in the strip. The editor below says what you are editing, for example
   *"editing: MONITOR · RIDE"*.
2. Move the controls. The change is on air straight away, and saved for this station.
   - **GEQ:** ten band faders over a live spectrum, **FLAT**, and **IN/OUT**. Above the faders is a graph like a
     Behringer X32's: 12 spectrum bars per octave (blue → green → yellow, red only at the very top), **dimmed**
     before the GEQ and **full** after it, both before the master fader. The GEQ's own curve is drawn in yellow,
     with a numbered dot at every fader's position (fader 1 = 31 Hz … 10 = 16 kHz). It's the same display as the
     channel EQ (see **Channel EQ → Reading the spectrum**), and it runs only while this view is open.
   - **RIDE:** Target (the loudness it aims for), Rate (how fast it moves), Clamp (how far it may go).
   - **LIMITER:** Ceiling and Release. The line under the ceiling says where it really limits, for example
     *"−1.0 dBTP set · limits at −2.2 dBTP"*.
3. **IN / OUT on the GEQ** is saved with the rack.
4. **BYP on the ride or the limiter** is a **test tool**. It works straight away, the banner warns you, and it
   switches itself off when Ether restarts. It is never saved, so a restart always ends with the ceiling
   held.

**The meters on the right stay put while you work:**
- IN (the programme before processing);
- OUT for each output;
- RIDE and LIMITER for each output;
- the loudness panels (see **Loudness Meter**).

#### Presets

- The bar at the top shows the **active preset**. **· modified** appears when the rack no longer matches it.
- **To change presets without surprises:**
  1. **Arm** one from the list. Nothing changes on air yet.
  2. The rack shows exactly what would change, for example *"both: target −14.0 → −23.0 LUFS"*.
  3. Press **TAKE** to apply it, or **DISARM** to drop it.
- **Save** overwrites your own active preset. **Save as** makes a new one. The built-in presets cannot be
  overwritten.
- **Built-in presets:**
  - **Ether v1 (shipped)** is the default, and it is the −14 LUFS streaming target;
  - **Broadcast −24 (ATSC A/85)**;
  - **EBU −23 (R128)**;
  - **Stream/Podcast −16**.

  Only the target and the ceiling differ between them.
- **A preset never turns processing on or off.** "Process local output" and "Process stream" stay where you
  set them (Preferences → Broadcast → Audio Processing).

#### If something looks wrong

- **A red "the engine did not accept that" line** means the change was refused and **nothing changed on air**.
  The rack shows what is running. If Ether has just updated, fully close it and reopen it (the audio engine
  does not reload on its own).
- **A yellow BYPASSED banner** means a test bypass is on. Press **BYP** again to put the module back **IN**.
- **"This station's rack is built from its existing processor settings"** means you haven't changed anything
  yet. The rack shows exactly what was already running, and it is saved as a rack the first time you change
  something.

#### Not in this version (by design)

- **Nothing in the master rack can be moved.** The EQ comes first, and in each output the limiter is always
  last: it is what holds the ceiling. (Channel racks can be reordered.)
- **The ride and the limiter cannot be removed** (bypass is the test tool). The GEQ can be removed and added
  back.
- **Channel racks live in the same window.** The selector row at the top (MASTER | A–F | CART | G–K, every fader by its board letter) goes to a
  fader's own rack. See **Channel EQ** ([Channel EQ (Filters and PEQ on a fader)](#channel-eq-filters-and-peq-on-a-fader)).
- **A rack preset's Take applies at once**, because the master rack has no channels to protect. Presets for
  the whole board, which do protect live channels, are **Show Presets** — see [Show Presets (save and recall the whole board)](#show-presets-save-and-recall-the-whole-board).

#### Related

- **Channel EQ** ([Channel EQ (Filters and PEQ on a fader)](#channel-eq-filters-and-peq-on-a-fader)) — Filters and PEQ on each fader
- **Loudness Meter** ([Loudness Meter (M / S / I / LRA / True Peak)](#loudness-meter-m--s--i--lra--true-peak))
- **Audio Processing** ([Audio Processing (Loudness & Limiter)](#audio-processing-loudness--limiter)) — turning processing on for each output
- **Reading the Meters** ([Reading the Meters](#reading-the-meters))
- **Show Presets** ([Show Presets (save and recall the whole board)](#show-presets-save-and-recall-the-whole-board)) — presets for the whole board

### Channel EQ (Filters and PEQ on a fader)

*Every fader has its own rack — a high-pass and low-pass filter, and a 4-band parametric EQ — drawn as a curve you can drag, with IN and OUT meters so you can see what it did.*

**Where:** The EQ button on any fader strip (and on the on-air decks A/B/C). In the rack window, the selector row: MASTER | A B C D E F | CART | G…K (each fader by its board letter).  
**Since:** unreleased (log-reader-flip, after 4.6.50)

#### What it is

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

#### Open it

1. On any fader strip, press **EQ**. When the lamp is lit, that fader's rack has something **IN**.
2. The rack window opens at that fader. If it is already open, it switches to that fader.
3. Inside the window, the **selector row** at the top goes to any rack:
   - **MASTER**;
   - **A B C D E F**, **CART**, **G…K**, the same letters as the board. A dot on a tab means that fader's rack has something IN.

On the **on-air decks A/B/C**, the deck's **EQ** button opens the same rack.

#### Using it

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

#### Reading the spectrum

Behind the EQ curve is a **live spectrum of this channel**, drawn like a Behringer X32's RTA.
- **12 bars per octave**, from 20 Hz to 20 kHz, with a small gap between them.
- **Dimmed bars:** the channel **before** its rack. **Full bars:** **after** it, which is what the EQ, filters,
  gate and compressor did.
- Both are taken **before the fader**, so moving the fader doesn't change them.
- **The colours:** every bar is **blue** at its base, then turns teal, green and **yellow** as it gets taller.
  **Red** only appears at the very top of the scale.
- **The yellow line is the EQ.** Numbered boxes along the top mark each PEQ band's frequency; the numbered dots on
  the line are the bands you drag.
- **The grid:** frequencies along the bottom (20, 40, 60, 80, 100, 200 … 10k, 20k); EQ gain on the left
  (−15 to +15 dB); the spectrum's own level on the right, in dBFS.
- **The level scale follows the music:** its top sits a little above the loudest recent level and eases down when
  the music gets quieter, showing the 60 dB below it.
- **The white markers** are PEAK HOLD: each bar's highest level for 2 seconds. They're on by default; the
  **PEAK HOLD** button turns them off.
- **Hatched at the far left (below 160 Hz):** too narrow for the analyser to split finely. Read it as a guide.
- **NOT FED:** nothing is playing on this channel.

It runs only while this rack window shows the curve, one channel at a time. Close the window and it stops.

#### Starting over

These reset buttons change the sound smoothly (20 ms crossfade), like any other edit. They take effect
straight away and are saved.

| Button | Where | What it does |
|---|---|---|
| **FLAT** | the PEQ controls | Every band goes to **0 dB**. Frequencies, widths and shelf settings are kept, so you can bring a band back up where it was. PEQ IN is not changed. |
| **RESET FILTERS** | the Filters controls | **HPF and LPF both OUT**, back to 80 Hz and 18 kHz. The FILTERS tile's IN is not changed. |
| **CLEAR RACK** | the right of the strip | **Empties this fader's rack**: every module (Filters, Gate, PEQ, Comp) is removed, and the fader is untouched again. |

**Clearing a rack:**
1. Press **CLEAR RACK**. It asks first: *"Clear H's rack?"*
2. Press **CLEAR** to empty the rack, or **CANCEL** to keep it.

**Moving a module:** the **⋯** menu on a tile has **Move earlier / Move later**, so Filters can go after the PEQ.
It also has **Remove**.

#### The ranges

| Control | Range |
|---|---|
| HPF | 16.1–500 Hz |
| LPF | 1–20.2 kHz |
| PEQ frequency | 16.1 Hz–20.2 kHz |
| PEQ gain | ±14 dB |
| PEQ width | 0.2–3 octaves |

A new Filters module starts with the HPF at 80 Hz (IN) and the LPF at 18 kHz (OUT), inside a module that is
itself OUT. A new PEQ starts with every band at 0 dB.

#### The mic

- **A mic is a channel like any other now.** Patch a source channel to your mic (see **Mic on Air**), and its
  channel EQ works exactly as described here: Filters to cut rumble and hiss, and a PEQ to shape the voice.
- The old 10-band "mic input EQ (browser audio)" is gone, and its settings were not carried over. Use the
  channel EQ.

#### If something looks wrong

- **A red "the engine did not accept that" line** means **nothing changed on air**, and the rack shows what is
  running.
  - If Ether has just updated, fully close it and reopen it. The audio engine doesn't reload on its own.
  - The same applies if the **OUT** meter is **hatched**: the running engine predates channel EQ.
- **The EQ lamp is lit but you hear no change:** a PEQ can be **IN** with every band at 0 dB. The editor says
  *"nothing IN changes the sound"*.
- **The old deck EQ drawer is gone.** It never processed the deck: its settings went to the master EQ by
  mistake. Those old settings were not carried over, because they never affected the sound.

#### Not in this version (by design)

- No presets that follow a source or a show yet (a later slice). The rack belongs to the fader.

#### Related

- **Gate and Compressor** ([Gate and Compressor on a channel (and the Voice preset)](#gate-and-compressor-on-a-channel-and-the-voice-preset))

- **The Master Rack** ([The Master Rack (Processor)](#the-master-rack-processor))
- **Reading the Meters** ([Reading the Meters](#reading-the-meters))
- **Mic on Air** ([Mic on Air (the mic as a channel)](#mic-on-air-the-mic-as-a-channel))

### Gate and Compressor on a channel (and the Voice preset)

*Every fader's rack can hold a Gate (turns the room down when nobody is talking) and a Compressor (evens out a voice) — with a transfer graph, live gain-reduction meters, a COMP lamp on the fader, and a Voice preset to start from.*

**Where:** The EQ button on any fader strip → the rack window at that fader → + GATE / + COMP, or Preset → Voice → TAKE.  
**Since:** unreleased (log-reader-flip, after 4.6.50)

#### What they do

A fader's rack runs in this order: **Filters → Gate → PEQ → Comp**. You can drag modules to reorder them.

- **GATE** (magenta) **turns the room down when nobody is talking.**
  - Below its **threshold** it lowers the channel by up to its **depth** (14 dB is usually enough, 20 dB tops).
  - It opens the moment you speak.
  - **Why it matters for a mic:** with the gate closed, the room noise and fans don't reach air. They also
    **can't hold the music down if the channel's DUCK is on**, because the ducker listens after the gate.
- **COMP** (magenta, with its orange curve) **evens out a voice.**
  - Above its **threshold** it reduces the level by its **ratio** (3:1 is gentle; 20:1 is close to limiting), so
    loud words come down towards quiet ones.
  - **Makeup** (0–24 dB) brings the whole voice back up.
  - It listens to loudness (RMS), not to single peaks, so plosives don't make it grab.

#### Start from Voice

1. Open the channel's rack (**EQ** on the fader).
2. In **Preset**, choose **Voice**, then press **TAKE ▸ Voice**.
3. The channel now runs, all IN:
   - **HPF 80 Hz**;
   - **Gate** −45 dB, depth 15 dB, 1:4, open 1 ms, hold 100 ms, release 150 ms, hysteresis 3 dB;
   - a flat **PEQ**;
   - **Comp** 3:1 at −20 dB, attack 10 ms, release 150 ms, knee 6 dB, makeup 0 dB.
4. Adjust by ear. The usual moves are the gate **threshold** (just above your room noise) and the compressor
   **makeup**.

**Off** empties the rack: nothing runs, and the channel is untouched. **Save as** keeps your own settings as a
preset for this station.

**Taking a preset switches its modules IN.** Adding a single module with **+ GATE** or **+ COMP** starts it **OUT**,
so nothing changes on air until you press **IN**.

#### The transfer graph

Pick the GATE or COMP tile to open its editor:
- **the grey diagonal** is "no change";
- **the orange line** is what the channel actually does: input level across, output level up;
- **the faint magenta lines** are the gate and the compressor on their own;
- **drag a threshold line** sideways to move it;
- **the dot** is where your channel is right now: its level, and what the gate and compressor are doing to it.

**The sliders beside the graph:**

| Module | Controls |
|---|---|
| Gate | threshold, depth, ratio (1:1–1:5), open time, hold, release, **hysteresis** |
| Compressor | threshold (−40…+10 dB), ratio (1:1–20:1), **knee** (0–12 dB), attack (0.1–330 ms), release (50 ms–3 s), makeup (0–24 dB) |

**Hysteresis** makes the gate close only a few dB *below* where it opened, so it doesn't flutter on a voice
hovering at the threshold.

**Every change is smooth:** a 20 ms crossfade, so moving a threshold or the makeup never clicks on air. There's
**no lookahead**, so nothing is added to the mic's delay.

#### Reading it from the board

- **The fader strip** shows **COMP −x dB** in magenta while that channel's compressor is reducing the level by
  1 dB or more.
- **In the rack,** the GATE and COMP tiles show a live **gain-reduction bar**. The gate tile also says
  **OPEN / CLOSED**.

#### Not in this version (by design)

- **No lookahead**, no side-chain filter, no de-esser, no automatic makeup.
- **Presets belong to the station,** not to a source: "the host's mic settings follow the host" is a later
  step.

#### Related

- **Channel EQ** ([Channel EQ (Filters and PEQ on a fader)](#channel-eq-filters-and-peq-on-a-fader))
- **Mic on Air** ([Mic on Air (the mic as a channel)](#mic-on-air-the-mic-as-a-channel))
- **Channel Faders** ([Channel Faders and Channel Cut (ON/OFF)](#channel-faders-and-channel-cut-onoff)) — PFL to hear the processed sound

---

## 5. Programming: log, schedule, clocks, rotation

### "The Program Log"

*One day of the station's real log — what aired, what is on air, what is coming — with Fill Day, Fill Week, Clear Day and CSV / Print / PDF export.*

**Where:** ≡ menu → Program Log, Schedule → Program Log (its own window), or the PROGRAM LOG tab at the bottom of the dashboard (docked)  
**Since:** 4.6.49

The Program Log shows **one day of the log the station actually airs from** — the same log the
engine reads and airs from. Pick a day on the small calendar at the left; every hour of the
day is a row you can open.

#### Docked or in its own window

- **PROGRAM LOG** on the bottom tab bar docks it under the decks — the live screen stays where it is.
  Drag the divider above it for more room; the left column scrolls if the dock is short.
- **≡ → Program Log** or **Schedule → Program Log** opens it in its own window (drag it to a second
  monitor; it remembers its size and place).
- You can have both open. They show the **same rows**: a Fill, a Clear, an edit in the hour editor, a
  song going to air — each surface updates within about a second. Both open on the last day you
  picked for this station.

#### Reading the day

- **The left column of the mini calendar** shows a green dot under every day this station has a log for.
- **TODAY'S SHOWS** lists this station's shows and how many of their hours have rows.
- **Each hour row** names the show and clock for that hour, how many items it holds and how long they
  run. Open it to see the items.
- **Time** — the first column is the scheduled time, `HH:MM:SS`. When an item has aired, its **actual**
  air time appears underneath in green. That is the as-run receipt.
- **Status** — `pending` (not yet), **`playing`** (on air now, highlighted), `played` (aired, green),
  `missed` (a spot or item that did not air, red).

The summary at the top — *N of M hours scheduled · total programming* — is counted from these rows. M is
the number of hours listed: the hours your shows cover, plus any hour that already has rows.

#### Fill Day

**Fill Day** builds the log for the selected day from your shows and clocks. It fills **from the next top-of-hour to the end of the day**:

- Hours that have already started are never touched. What aired is a record, not a plan.
- Items you placed by hand (they wear the YOURS badge in the hour editor) survive a Fill.
- Filling a day that has already fully aired does nothing and says so.

Fill Day acts on the **station you are switched into**. Switch stations first if you mean another one.

There is no per-hour generate: to rebuild part of a day, clear the hours you want rebuilt (the ✕ on
each hour row) and press Fill Day — it fills the gaps and leaves everything else in place.

#### Fill Week — scheduling weeks ahead

**Fill Week** sits next to Fill Day and builds **seven days in one run: the selected day and the six
days after it.**

To schedule further out, pick the day you want to start from in the mini month and press Fill Week.
There is no limit on how far ahead you can go — a week three weeks out fills exactly like next
week's. Three presses from three different start days gives you three weeks.

Every rule Fill Day follows, Fill Week follows on **each** of the seven days:

- Hours that have already started are never touched — only the first day can have any, since the rest
  are entirely in the future.
- Items you placed by hand (the **YOURS** badge) survive.
- Days that have already fully aired are skipped.

While it runs:

- The **progress bar** moves hour by hour across the whole week, not once per day, so you can see it
  working.
- **CANCEL** stops it at the next hour boundary. **Every day that already finished is kept** — you
  never get half a day. The message tells you how many days were kept.

When it finishes it reports **how many rows it placed across how many days**, and the day on screen
re-reads itself. The other six days are built and waiting; open any of them in the mini month to see
them. If you have the Program Log open in both the dock and its own window, both update.

> **One thing to know about the count.** The number reported is what the scheduler *built*. If a day
> contains rows you placed by hand, the built rows that would have landed on top of them are dropped
> rather than double-booking your slot — so the number shown can be slightly higher than the number of
> new rows actually in the log. Your rows are the ones that win.

#### Clear Day and the hour ✕

**Clear Day** removes what has **not yet aired**: pending items from the next top-of-hour to the end of
the day. It never removes played, playing or missed items — those are the record of what happened —
and it never touches the hour that is on air right now, so the engine is never left with nothing to
play. The **✕** on an hour row does the same for that one hour.

After a Clear, press Fill Day to rebuild — it fills only the gaps.

#### Export

**⬇ CSV**, **🖨 Print** and **📄 PDF Report** (Studio plan) export the day you are looking at.

#### Editing an hour (✎ Edit)

Open an hour and press **✎ Edit**. Every change is saved to the airing log the moment you make it —
there is no Save button, and what you see after each change is what the log now holds.

- **Swap a song** — click a song row, then pick another song from the list on the right (same
  category, searchable). The row takes that song's title, artist, length and file from the Library.
- **Swap two rows' times** — drag a row and drop it onto another; the two trade places. (It is a
  swap, not a shuffle-down: nothing else in the hour moves.)
- **Remove a row** — the **✕** at the right of the row. The slot refills on the next Fill Day.
- **YOURS** on a row means you placed, moved, swapped or edited it — Fill Day will not move, replace
  or remove it.
- A yellow **⚠** under a row after a swap or move is a separation rule the placement bends (artist,
  title or song too close to another play). It tells you; it does not stop you.

**Rows that have aired or are on air cannot be changed.** They are dimmed, cannot be dragged or
deleted, and if you try, the reason is shown: *Already aired — a record, not a plan.*

#### If something looks wrong

- **Every hour says "0 hours" / empty** — the day has no log yet. Press Fill Day, or Fill Week to
  build it and the six days after it at once.
- **An hour you expected is missing from the list entirely** — the Program Log lists the hours your
  shows cover, plus any hour that already has rows. An hour no show covers has no clock, so nothing
  can be scheduled in it and it is not listed. Give that hour a show under **⚙ Shows & Dayparts**,
  then Fill Day or Fill Week.
- **The wrong show name on every hour** — check the station switcher; the panel follows the active
  station.
- **Fill Day says "nothing to fill"** — the whole day has already aired.
- **An hour has no ✕** — that hour has already started; there is nothing left in it to clear.
- **An hour says "No clock for this hour"** — open **⚙ Shows & Dayparts**, give the show a clock, then
  Fill Day.

### "Editing the log by hand"

*How to swap a song, trade two rows' times and remove rows in the Program Log's hour editor, what the YOURS badge means, and why Fill Day never undoes your work.*

**Where:** Program Log → open an hour → ✎ Edit  
**Since:** 4.4.196 (in the Program Log since 4.6.49)

Open the **Program Log**, open an hour, press **✎ Edit**. You get that hour's rows — **Time, Type,
Title, Artist, Length** — and every change you make is saved to the airing log the moment you make it.

#### The one rule worth knowing

**Anything you touch becomes yours, and Fill Day leaves it alone.**

Fill Day only fills the **empty** places. Your rows stay exactly where you put them, no matter how
many times you fill the day again.

#### Swapping a song

Click a song row. A list of songs from the same category opens on the right — search it, click one.
The row now plays that song, with the title, artist, length and file the Library has for it. The row
gets the purple **YOURS** badge.

#### Moving a song

**Drag it onto another row.** The two swap times — the one you dragged goes where the other was, and
that one comes back to where yours started.

> **The song that was there does not vanish, and nothing shuffles down.** The two rows *trade places*.
> Everything else in your hour stays exactly where it is. Moving one song by three minutes would
> otherwise push the whole rest of the day out of place, including your spot breaks and top-of-hour.

Both rows now show **YOURS**.

#### Removing a song

Click the **✕** at the right of the row. The song comes out of the log and leaves a hole.

The next time you press **Fill Day**, that hole is filled with a fresh song chosen by your clock and
your rotation rules — exactly as if the scheduler had picked it in the first place. So "remove it and
fill again" is how you say *"not this one, give me something else"*.

#### The YOURS badge

A purple **YOURS** badge on a row means you placed, moved, swapped or edited it. Fill Day will not
move, replace or remove it.

If most of a day is yours, Fill Day has very little left it is allowed to fill, and it will look like
it is doing nothing. That is not a fault — it is doing what you asked. Remove a few of your rows (✕)
and fill again if you want the scheduler to help.

#### Rule warnings

If a swap or a move puts a song too close to another by the same artist, the same title, or the same
song, an **amber ⚠ note** appears under that row:

> *⚠ Same artist "Fleetwood Mac" 10 min away (rule: 60 min)*

**The change still happened.** This is a heads-up, not a refusal. You know your station and there are
good reasons to break a separation rule — a themed set, an artist feature, a request. Ether tells you
what it noticed and then gets out of your way. The warning uses the same rules Fill Day uses.

#### What you cannot edit

**Rows that have already aired or are on air now.** They are dimmed, cannot be dragged, swapped or
removed, and if you try, the reason is shown at the top of the editor:

> *"…" — Already aired — a record, not a plan*

This is deliberate and it is not negotiable: that row is the **record of what your station actually
broadcast**. It feeds your as-run log and your advertiser affidavits. A log you can edit after the
fact is a log nobody can trust — including you.

#### What moved with the Calendar

The Calendar window is gone; the Program Log is the one log surface. Three of the Calendar's editing
tools did not come across and are not planned: sorting and resizing the day's columns, the 📍 pin
(an edit, swap or move already marks a row YOURS), and double-clicking a title, artist or category to
retype it. If you need one of them, say so.

#### Frequently hit questions

**I filled the day again and my changes are still there. Is that right?**
Yes. That is the whole point.

**I filled the day again and nothing new appeared.**
If every slot is yours, there is nowhere for Fill Day to put anything.

**I deleted a song and it came back.**
It did not — a *different* song was chosen for that gap by your clock and rotation rules. If you want
the slot empty, leave it deleted and do not fill again.

**Can I edit a different station's log from here?**
Only the station you are switched into.

#### Related

- **Program Log** (`help-program-log.md`) — the whole panel: Fill Day, Clear Day, docked or in its own
  window.
- **Health Monitor** — every edit is recorded as a `log-edit` event, and a Fill that preserved your
  rows records how many it kept.

### Schedule Manager

*Shows, Clocks, Categories, Spots, Sweepers, Rotation Analytics, Program Log and Play Log side by side in one window, linked — pick a category and the clocks using it light up; edit anything and every pane refreshes.*

**Where:** ≡ Menu → Schedule Manager (opens in its own window) · or Schedule → Schedule Manager in the menubar  
**Since:** 4.4.172 (Spots and Sweepers panes added 4.4.176)

#### What it is

Shows, Clocks and Categories have always been **tabs** — you could look at one at a time. That is
fine for editing one thing and useless for the question programming actually asks: *does my clock
match what I said I wanted?*

The Schedule Manager puts the whole picture in one window and links it. The default arrangement:

```
┌──────────────┬────────────────────────────┬──────────────────────────────────────────┐
│ SHOWS        │ CLOCKS │ PROGRAM LOG       │ CATEGORIES │ SWEEPERS │ SPOTS │          │
│              │                            │ ROTATION ANALYTICS │ PLAY LOG            │
│ which clock  │ the hour grid for the      │ targets, imaging, breaks, what aired     │
│ airs when    │ selected show's clock      │                                          │
└──────────────┴────────────────────────────┴──────────────────────────────────────────┘
```

There are eight panes: **Shows, Clocks, Categories, Spots, Sweepers, Rotation Analytics, Program Log
and Play Log.** Every one is open in the default arrangement. Program Log rides as a tab behind Clocks
in the middle column; Categories, Sweepers, Spots, Rotation Analytics and Play Log share the
right-hand column as tabs. Click a tab to switch. Drag any tab out if you want it as its own
column — see *Arranging it*.

#### Arranging it

The panes are **dockable**. Drag a tab to move a pane, drop it beside or on top of another to
re-arrange or stack them, and drag the dividers to resize. Panes cannot be shrunk to nothing.

**Your layout is saved automatically, per station, on this machine only.** Switching stations
restores that station's arrangement. It is never synced — how you arrange your screen is yours, not
something that should rearrange a colleague's.

**Layouts**, at the bottom of the Panels menu, are named arrangements for a particular job:

| Layout | Opens (columns, left to right) | For |
|---|---|---|
| **Programming** | Shows · Clocks + Program Log · Categories, Sweepers, Spots, Rotation Analytics, Play Log | Building the hour (the default) |
| **Traffic** | Spots · Clocks · Sweepers, Categories | Spot and break work |
| **Analysis** | Rotation Analytics, Play Log · Categories, Shows · Clocks | Reading what aired |
| **Live** | Shows · Program Log | Reading the hour you are in |

Picking one **replaces your current arrangement** — same as Reset layout, and just as harmless: it
moves panes, nothing else. From that moment it is simply your layout again. Drag it, resize it,
close panes; it saves as normal. Nothing is locked and there is no mode to leave, which is why no
layout is ever shown as "active" — the moment you moved a pane, the name would be a lie.

**Panels** in the header lists every pane with a tick beside the open ones. Closing a pane with its
**✕** is always reversible — tick it in this menu to bring it back. When something is closed the
button turns amber and says how many are hidden, so a missing pane reads as recoverable.

**Reset layout** in the header puts everything back to the default arrangement. No confirmation, no
data affected, and **you stay signed in** — it only moves panes.

When an update adds a new pane, your saved arrangement is rebuilt once so the new pane is not left
invisible. Arrange it again and it will stick.

**Fixed layout** switches to the older non-dockable three-pane view if you prefer it.

#### The linking is the point

| You do this | This happens |
|---|---|
| **Click a category** | The strip at the top names its target and library depth; clocks that use it get an amber border |
| **Click a show** | The Clock pane focuses that show's clock |
| **Edit anything** | Every pane refreshes — one store, one refresh |
| **Add or delete a spot category** | The Clock pane's break rows and segment picker update with it |
| **Assign a sweeper to a category** | The Categories pane picks the change up |

The panes are the **same editors** as the tabs and popouts. Anything you can do there you can do
here, and vice versa; nothing was rebuilt.

#### The loop, in one window

**Rotation Analytics** is a pane here too, which closes the circle:

1. **Categories** — declare what you want: a target of 4 spins/hr.
2. **Clocks** — shape the hour against the inline advisor, which tells you the clock says 11.
3. **Rotation Analytics** — read what actually aired, and whether the log agrees with either.

The numbers there are history. Editing a clock does not change them; press **Refresh** after you
generate. Its tables sort and resize like a spreadsheet — see its own help entry.

#### Spots and Sweepers

**Spots** is the full *Spots & Promos* manager — the same one the SPOTS button in the bottom bar
opens, hosted here so you can build a break without leaving the clock you are building it for. Spot
categories are created, renamed and deleted here.

**Sweepers** is the same panel as the SWEEPERS push-up at the bottom of the screen, which remains its
home. Use it here to see which music categories carry imaging while you look at the clock.

##### Where spot categories live, and what did not move

| Thing | Where it lives | Why |
|---|---|---|
| **Spot categories** (the buckets) | **Spots** pane | They belong to the station, not to any one clock |
| **Timed breaks** ("3 spots at :20") | **Clocks** pane, unchanged | A break belongs to the clock it is on |

In this window the Clocks pane does not carry a Spot Categories card — the Spots pane owns it.
**In the tabbed view and the Fixed layout the card is still there**, because neither of those has a
Spots pane to send you to.

The Clock pane still names categories everywhere it did before — the segment picker, break defaults
and break rows are untouched, including the **⚠ 0 eligible spots** warning on a break that would air
nothing.

#### The inline advisor

Each clock in the middle pane carries its rotation-goals verdict:

> **Feel Good** target 4/hr, 11 slots — over by 7

Those are **the same numbers** Station Health → Rotation goals shows, from the same function. If the
two ever disagree, that is a bug, not a difference of opinion. The verdict updates when you edit the
clock, rather than waiting for the background sense.

A category with **no target declared** never produces a verdict. Not declaring a goal is a choice.

#### Reading the category strip

Select a category and the strip tells you three things:

- **target N/hr** — what you declared, or "no target declared"
- **N songs, needs ~M** — library depth: how many songs exist versus how many the clocks demand.
  **THIN** means the category cannot support its own demand without repeating
- **used by the selected clock** — the context link

Thin plus a high target is the burn signature: the scheduler will be forced to relax separation to
fill the hour.

#### The old surfaces still work

Nothing was taken away. `Schedule → Clocks / Shows & Dayparts / Categories` in the menubar still
opens the tabbed panel, the Shows and Categories windows in the ≡ menu still work, and the embedded
programming panel is unchanged. The Schedule Manager is an additional door onto the same rooms — use
whichever suits the task.

#### What it does NOT do

- **It does not change what airs.** It edits the same shows, clocks, categories, spots and sweepers
  through the same write paths. Generation and playout are untouched.
- **It does not report on itself.** The Rotation Analytics pane reads what already aired; editing a
  clock beside it does not change those numbers. Hit Refresh after you generate.
- **Your layout is not your colleague's.** It is stored per station on this machine and never synced.

#### Known issue

The Sweepers pane's tab (and its entry in the Panels menu) still reads **"Jingles"**. It is the same
Sweepers panel described above.

#### Related

**Station Health → Library & Rotation → Rotation goals** — the same advisor, for every clock at once.
Open Station Health from the health dot in the bottom bar, or Tools → System Health in the menubar.
**Rotation Analytics** — what the log actually did, after generation.
**Spots & Promos** — the same manager the Spots pane hosts.
**Sweepers** — the same panel the Sweepers pane hosts; the push-up is its home.

### Rotation Goals

*Declare how often each category should air, and see where your clocks disagree with you. Reports only — it does not change what plays.*

**Where:** Station Health (the health dot in the bottom bar, or Tools → System Health in the menubar) → Library & Rotation → "Rotation goals" · targets are set in Categories  
**Since:** 4.4.167

#### What it is

Every category can carry a **spins per hour** target — how often you want it to air.

**Rotation goals** compares the target you declared against what your
**clocks actually ask for**, and tells you where the two disagree:

> Morning Drive — Gold target 4/hr, 2 slots (under by 2)

It **reports only**. It does not change one thing about what airs. Your clocks still decide the
music exactly as before.

#### Why the two can disagree

Today a clock controls rotation *positionally*: if you want Gold four times an hour, you place four
Gold slots. The spins-per-hour field is a *statement of intent* that has never been enforced — so
nothing has kept your clocks and your intent aligned, and they drift apart silently.

This panel makes that drift visible. (The same verdict also appears on each clock in the Schedule
Manager, and Rotation Analytics shows what the log actually aired against the target.)

#### Reading it

| What it says | What it means |
|---|---|
| **none declared · 10 categories** | No targets set yet. It shows what your clock actually does instead — e.g. *"Open Format is 73% Feel Good (11 of 15 music slots)"* |
| **12 declared · all clocks match** | Every clock's composition matches its targets |
| **3 mismatches across 2 clocks** | The clocks that disagree are listed underneath (the first few; the rest are counted) |

**under by N** — the clock has fewer slots for that category than the target.
**over by N** — it has more.
**not in this clock** — you set a target for a category the clock never uses.

#### Setting targets

**Schedule → Categories** in the menubar, or **≡ → Categories** → pick a category → set **Spins/hr**.

Start from what your clock already does. If the panel says a clock is *73% Feel Good (11 of 15
slots)*, and that isn't what you intended, it just told you something worth knowing.

A category with **no target — blank or 0 — is never reported.** Not declaring a goal is a legitimate
choice, and this panel treats it as one rather than nagging.

#### What it does NOT do

- **It does not change what airs.** Nothing about song selection, separation, dayparting or clock law
  changes. This release is read-only.
- **It does not fill in your targets for you.** It can see that a clock airs Gold three times an hour,
  but it will not write that in as your goal — inferring your intent from geometry would be inventing
  a decision you never made.
- **It does not enforce the goal.** If a clock is under target, the clock still wins. Making goals
  actually drive the log is a later phase.

#### Talk and specialty clocks

A clock with no music slots at all is skipped entirely. Reporting "Gold under by 4" against a talk
hour would be technically true and completely useless.

### Rotation Analytics

*See how your rotation is actually behaving — spins vs target, artist burn, turnover, and how many log rows carry a recorded pick reason. Read-only; it never changes what airs.*

**Where:** ≡ Menu → Rotation Analytics (opens in its own window) · Schedule → Rotation Analytics in the menubar · or as a pane in Schedule Manager  
**Since:** 4.4.169 (sortable/resizable tables and the Schedule Manager pane, 4.4.177)

#### What it is

Five questions a PD asks about rotation, answered from the log itself:

- **Spins** — how often is each category airing, against the target you declared?
- **Hourly grid** — which hours does each category own?
- **Burn** — which artists are on too often, and how tightly spaced?
- **Turnover** — how much of the library is actually in play, or is a handful of songs carrying it?
- **Why** — how many rows in the log carry a recorded reason for their pick?

It reports only. Nothing in this panel changes what plays.

#### Reading it

##### Spins per hour — actual vs target

| Column | Meaning |
|---|---|
| **Target/hr** | The `spins/hr` you set on the category. **—** means no target declared |
| **Actual/hr** | What the log actually contains, averaged over the window |
| **Δ/hr** | Actual minus target. Amber at ±1 or more |
| **Share** | This category's percentage of all music. Amber at 50% or more |

A category with **no target shows —** and is never counted as a miss. Not declaring a goal is a
legitimate choice, and the panel treats it as one.

A **share of 50% or more** is worth a look. If one category is most of your day, that is your format
whether you intended it or not.

##### Artist burn

**Tightest gap** is the closest any two airings of that artist came. It is compared against **your
station's own artist-separation rule**, not an invented number — so `INSIDE RULE` means the scheduler
had to break your rule, which happens when the fill ladder runs out of compliant songs.

A high spin count with comfortable spacing is a format. A low count with a 15-minute gap is a
listener complaint waiting to happen.

##### Turnover

| Column | Meaning |
|---|---|
| **Library** | Eligible songs in the category |
| **Used** | How many distinct songs actually aired |
| **Coverage** | Used ÷ Library. Low coverage means most of the category never plays |
| **Spins/song** | Near **1.0** = even rotation. **4+** means a few songs are carrying the category |
| **OFF-CATEGORY** | Songs in the log that are no longer in that category — re-filed, deleted or rotation-disabled since it was generated. A sign the log is stale |

Low coverage plus high spins/song is the classic burn signature: a big library, a small slice of it
actually airing.

##### Why was this picked?

Reasons are written **as the log is generated** — the category, how many songs were in the pool, how
many were vetoed and by which rule, and whether any rule had to be relaxed.

This section tells you **how many rows in the window carry a recorded reason** (for example
"412 of 430 rows carry a recorded reason"). The individual reasons are stored on each log row, but
they are not shown on screen yet — not here and not in the Program Log.

**Reasons cannot be reconstructed afterwards.** The vetoed and losing candidates only exist during
the pick, so rows generated before this feature existed show **"0 of N rows carry a reason"** rather
than being given a plausible-sounding guess. Run **Generate** and new rows will carry their reasons.

#### Working the tables

The four tables (Spins, Hourly grid, Artist burn, Turnover) are a spreadsheet-style grid:

- **Click a header to sort.** Click again to reverse it.
- **Shift-click a second header** to sort by that as a tiebreak. The little ▲1 ▼2 marks show which
  is first and which is second.
- **Drag the right edge of a header to resize a column.** Your widths are remembered per station, on
  this machine — they are never synced, because how wide your columns are is not your colleague's
  business.
- Tables open in the **same order they always have** — turnover by coverage, worst first, and so on.
  Sorting is something you do, not something done to you on arrival.

The **artist burn** table lists the 25 most-played artists. When there are more, it says so under the
table — and the export still contains every one of them.

#### Exports

Each section has its own **Export CSV** button, directly under the table it exports. Files open
directly in Excel, Sheets or Numbers.

**Sorting and resizing do not change the file.** The export is defined by the report, not by how you
happen to be looking at it, so two people exporting the same window get the same file.

#### Time range

24 Hours / 7 Days / 30 Days, across the whole panel. Longer ranges are slower on a big library —
30 days on a full station takes a moment. **Refresh** re-reads the log for the current range.

#### What it does NOT do

- It does not change rotation. Everything here is a read.
- It does not schedule or re-schedule anything.
- It does not judge your format. A 70% share is reported, not condemned — whether that is right is
  your call.

#### In the Schedule Manager

Rotation Analytics is also a **pane** in Schedule Manager, beside Categories, Spots and Sweepers. That
completes the loop in one window: declare a target on a category, shape the clock against the
advisor, then read here what actually aired. It is the same panel — the menu entry still opens it
in its own window.

It takes no part in the editing around it. These numbers are **history**, read from the log; editing
a clock beside it does not change them. Re-run the range with **Refresh** after you generate.

#### Related

**Station Health → Library & Rotation → Rotation goals** shows the other half: whether your *clocks*
match your declared targets, before a single song is scheduled. This panel shows what the log actually did.
**Schedule Manager** — the workspace this panel can live in.

### "Designated generator — which computer builds this station's log"

*What the Designated generator rows in the Health Monitor mean, what "None" and "NOT SAVED" tell you, and when to press REFRESH NOW.*

**Where:** Health Monitor → Library & Rotation → each station  
**Since:** 4.4.193

#### What you are seeing

In the **Health Monitor**, in the **Library & Rotation** panel, under each station:

> **Designated generator** — This machine
> *This machine — checked in 12 min ago*
>
> **Log last extended** — 12/08/2026, 09:41:07

And a **REFRESH NOW** button underneath.

#### What it is for

A station's log can be topped up automatically, so you never run out of scheduled music. If your
account runs on more than one computer, they would all happily do that job at once — and two
computers writing the same log is how a schedule ends up with doubled or fighting entries.

So one computer is the **designated generator** for a station. It writes the log. The others watch.

**Designation is never taken automatically.** A machine that is already designated stays designated
until a person changes it. There is no timeout, no election, and no silent handover — those decisions
belong to you, not to a timer.

#### Reading the rows

**Designated generator**

| It says | What it means |
|---|---|
| **This machine** | The computer you are sitting at builds this station's log. |
| A computer's name | That computer does it. This one is only watching. |
| **None** | No machine has auto-generated this station yet. This is normal and not a fault. |
| **Bypassed** | The emergency bypass is on for this station — every switched-on machine generates. |

The colour follows the last check-in, not the name: green within 6 hours, amber after that, red after
a day of silence. **Red means the designated computer has stopped watching** — it may be switched
off, asleep, or offline. That station's log will stop being topped up.

**Log last extended** is deliberately separate. A healthy computer generates *nothing* for days while
the runway is long, so an old date here is not a fault on its own. Check the **Designated generator**
row's colour for that.

#### "Designation record — NOT SAVED"

If a red row appears saying **NOT SAVED**, this computer could not write the designation record to
its database. It tells you the reason on the same line.

This matters because the record is how the machines tell each other apart. Without it, they cannot
agree on who generates, so the safe reading is: **nobody is reliably designated for this station.**

What to do:

1. Note the reason shown on the row.
2. Fully close and reopen Ether — a database that was mid-repair at startup usually clears here.
3. If it comes back, send the reason text to support. It is also written to the health ledger as
   `station-designation-write-failed`, so a look-back can see exactly when it started.

#### REFRESH NOW

Re-reads the designation record and checks in immediately, rather than waiting for the next
half-hourly round. While it works the button reads **REFRESHING…**, and the row updates only when
the read comes back — what you see is always what was actually read, never a guess.

Use it when you have just switched auto-generation on, or when you want to confirm the row on screen
is current. It refreshes **ownership state only** — it does not force a full cloud sync and it does
not generate a log.

When it succeeds you get a green confirmation under the row — **"Designation refreshed – <machine>
is designated"** — which clears itself after a few seconds. If nobody is designated it says so in
neutral grey rather than green, because that is not a success to celebrate; it is just the answer.

The **Designation read** stamp beside the button counts up live, once a second. Note that it also
resets on its own every 30 seconds when the panel re-reads in the background — so the stamp tells you
the reading is fresh, while the green confirmation is what tells you *your click* did something.

If the refresh fails, the reason appears in red on its own line under the row instead of nothing
happening.

#### Designation Activity

Further down the Health Monitor is a **Designation Activity** list — the recent history, newest
first:

- **Last refreshed** — someone pressed REFRESH NOW, and what the answer was.
- **Designation changed** — the station moved from one computer to another, and why.
- **Designation NOT SAVED** — a computer could not write the record, with the reason.

Only deliberate actions and real changes are recorded. The half-hourly check-in is not, or this list
would fill with dozens of identical lines a day and tell you nothing.

**RELOAD** re-reads the list. It is a plain read — it changes nothing.

##### "Auto-gen off – cannot designate"

If **Auto-generate is off** for this station on this computer, the REFRESH NOW button is **greyed
out** and that note sits beside it.

This is not a fault. A computer with auto-generation switched off must never take the designation —
it would then own a station it has been told not to build. So there is genuinely nothing to check
in, and the button says so rather than looking live and doing nothing.

**To designate this computer:** turn **AUTO ON** for the station (Health Monitor → **Log-Reader Flip —
Canary** → the station's **Auto-generate** row), then press REFRESH NOW. The row
flips to **This machine** in green and stays there.

The rows keep updating on their own every 30 seconds regardless, so nothing is hidden from you while
the button is greyed out — if another computer takes the designation, you will still see it appear.

#### It is enforced

**A computer that is not the designated generator will not automatically build that station's log.** It checks in, it
shows you the state, and it leaves the log alone.

Three exceptions, all deliberate:

1. **A station nobody has claimed still gets built.** If no computer is designated, the first one to
   auto-generate claims it. A brand-new station must never sit with an empty log waiting to be
   assigned.
2. **Pressing Generate yourself always works.** The rule applies only to the *automatic* top-up. If
   you are sitting at a computer and press **Generate**, it generates — you are there, and you asked.
3. **The bypass still bypasses.** When the bypass is on for a station (set by support), every
   switched-on computer generates, and the row reads **Bypassed**.

When a computer skips a station for this reason it says so — in the log, in the health ledger as
`auto-extend-skipped-not-designated`, and on the row itself, which reads *"…· this machine will not
auto-generate it"*. Recorded once when it starts, not every half hour.

#### What this does NOT do

- **It does not switch auto-generation on.** A computer with auto-generation switched off will never
  take the designation — it would own a station it has been told not to build.
- **It is not about who is on air.** Any computer can play out. This is only about who writes the
  schedule ahead of time.
- **It does not, on its own, make two computers agree.** Designation is stored per station and
  travels with your account — but only once the two computers are actually syncing. Until then each
  one has its own copy, and each will name itself. See your engineer if two computers are still both
  generating.

#### Related

- **Runway** — the per-station gauge showing how far ahead the log is built. It goes red under a day.
  If a designated machine stops working, the runway is where you will feel it.
- **Health Monitor** — designation changes are written to the health ledger as
  `station-designation-changed`, so you can see when ownership moved and what caused it.

### Play Log exports (as-run affidavit, BMI, ASCAP)

*What each export button produces, which columns an affidavit carries, and why a column can be empty.*

**Where:** Menu → Play Log → the export buttons, top right  
**Since:** 4.4.180 (as-run affidavit rebuilt)

Each export button makes a different document. They are not variations of one file.

| Button | Produces | For |
|---|---|---|
| **Export CSV** | The as-run affidavit — everything that aired, with times and lengths | Advertisers, proof of performance |
| **BMI** | Title, performer, date, time, duration | BMI reporting |
| **ASCAP** | Title, artist, date, start time, duration, source | ASCAP reporting |
| **PDF** | A printable list of the plays on screen: date, time, title, artist | A quick printed log |
| **Export Traffic CSV** (Traffic view) | Every **scheduled spot**, aired or not | Traffic reconciliation |

#### The as-run affidavit — Export CSV

Twelve columns, in this order:

**Start Time · End Time · Duration · Date · Title · Artist · Deck · Category · Advertiser · ISCI ·
Cart Number · Status**

- **Start Time** is when it actually aired. **End Time** is Start Time plus its length. **Duration**
  is that length, as M:SS — a thirty-second spot reads `0:30`.
- **Status** is **Aired** on every row. That is not a placeholder: the play log records what played,
  so every line in it aired. If you need *Scheduled* and *Missed*, that is the **Traffic** export —
  it reads the schedule, where a spot that never aired still has a row.
- **The whole period is exported.** Pick 30 Days and you get 30 days. It is not limited to what is
  visible on screen.

##### Why a column can be empty

An empty cell means Ether does not know, and it will not invent a value:

| Column | Empty when |
|---|---|
| **Advertiser, ISCI, Cart Number** | The spot's record has no such value. Fill them in on **Spots & Promos** and every export after that carries them. |
| **Category** | The item is not a library song in a category — a sweeper, a spot or a cart. |
| **End Time, Duration** | The length was never recorded. These stay blank rather than showing `0:00`, which would claim a zero-length airing. |

> **If ISCI and Cart Number are empty across the board**, nothing is broken — those fields have not
> been filled in on your spots yet. They are the two an advertiser is most likely to ask for, so they
> are worth entering once per spot in Spots & Promos.

#### Known issue

- **BMI, ASCAP and PDF** are built from the list on screen, which holds at most the **200 most
  recent plays** of the period. The **BMI and ASCAP duration column is not the real length** — every
  row carries the same fixed value. Check both before you file a report. **Export CSV** (the as-run
  affidavit) has neither problem: it covers the whole period with real lengths.

#### Related

**Traffic** — scheduled spots and whether they aired ([Traffic & As-Run](#traffic--as-run)).
**Spots & Promos** — where Advertiser, ISCI and Cart Number are entered.
**Rotation Analytics** — how rotation behaved, rather than what a single item did.

---

## 6. Imaging, sweepers & spots

### Sweepers

*Station IDs, stingers and sweepers that fire as an overlay on the seam between songs — assigned per music category.*

**Where:** Bottom bar → SWEEPERS (next to CATEGORIES)  
**Since:** 4.4.57

> **Help corpus template.** First entry in EtherCast's built-in help — plain language, step-by-step, no
> jargon — the format the Iris tour layer reads verbatim. Every feature ships a `docs/help-<feature>.md`
> (a flat file directly in `docs/`, no subfolders) written this way. Keep the section order below.

#### What it is

**Sweepers** are short imaging — station IDs, stingers, "you're listening to…" drops. They don't sit on
a deck and never interrupt the music: they **fire as an overlay** on the seam between two songs, riding
over the tail of the outgoing song and the head of the incoming one. Nothing stops, nothing skips.
There is one kind of imaging — the sweeper — shown in indigo with an **SWP** badge. (Older rows once
tagged as "jingles" are treated as sweepers.)

Imaging is **assigned by category**: you decide, per music category, whether songs in it get imaging —
a **specific** sweeper ("always THIS ID on the Power Gold") or a **rotating pool** (variety, no
burnout). Some categories get imaging, some get nothing.

#### When to use it

Imaging between songs on a per-category basis. A full commercial or scheduled break is a **Spot**, not this.

#### Set it up (bottom bar → SWEEPERS)

The **SWEEPERS** button in the bottom bar (next to CATEGORIES) opens this home. It has two tabs:
**MANAGE** (pools and assignments) and **ADD IMAGING — CUT A REEL** (the Reel Splitter).

1. **Tag your imaging.** In the **Library**, right-click a cut and choose **Mark as Sweeper**. Tagged
   items appear in this panel. (Right-click again → **Unmark Sweeper (→ Music)** to undo.)
2. **Build pools (optional but recommended).** Type a name in **New sweeper pool** (e.g. "Legal IDs"),
   add it, and put several tagged cuts into it. A pool **rotates least-recently-played**, so the same cut
   doesn't repeat too soon — that's your burnout protection. Cuts of different lengths can share a pool
   freely; length is never an input to the seam.
3. **Assign per category — the core.** In **Category assignments**, each music category has an **OVERLAY**
   dropdown: pick **— none (clean segue) —**, a **specific sweeper**, or a **sweeper pool**. Set
   **LEAD (s)** for that category (see below) and **ACTIVE HOURS** (default **Always**) to keep imaging
   out of hours where it doesn't belong.
4. **Fill Day.** Sweepers are placed on the song seams when the log is filled (Program Log →
   Fill Day). On air they fire automatically.

#### LEAD — the one number

Every category row has a **LEAD (s)** box: **how many seconds before the next song starts that this
category's sweeper fires.** That is the only timing decision the engine takes from you, and it is the only
one it needs.

**The sweeper belongs to the song it introduces, not the one it follows.** You assign it to a category, and
it plays ahead of every song in that category — over the tail of whatever happened to come before. That is
what makes the copy mean something: "new music next" is about the record that's starting.

Everything else follows from LEAD. The next song starts exactly when it would with no sweeper on the seam at
all. The sweeper plays on over its opening and **ends when it ends**. Where it lands in the song is
arithmetic, not a setting:

> A song with LEAD 3. The sweeper starts 3 seconds before that song does. If the sweeper runs 6 seconds, it
> ends 3 seconds into the record. A 10-second sweeper on the same seam ends 7 seconds in. Nothing is
> configured for that — it just follows from the sweeper's own length.

So sweepers of every length live happily in the same pool. How a cut sounds over the tail is an imaging
decision — yours and your imaging director's — not something the engine second-guesses.

**A greyed box is the station default, not an empty box.** When a category has no setting of its own, the
box still shows the number that is actually airing (2) in grey, so you can always see what is running. Type
over it and the box brightens: that category now has its own number. Clear the box and it goes back to grey
and follows the station default again.

Changes take effect on the **next Generate** — the number is written onto each placement when the schedule
is built, so a song already scheduled keeps the LEAD it was scheduled with.

Two practical limits:

- **Floor:** the engine checks the deck four times a second, so a LEAD under about **1s** can be missed.
- **Ceiling:** the box stops at **90 seconds minus your segue overlap** — the engine gets a sweeper ready
  90 seconds before the end of a song, so that is the most lead it can honour. Hover the LEAD box to see
  the exact maximum.

#### Fallback (optional)

Under the assignments, **Fallback for unassigned categories** sets a station-level pool for any category you
didn't assign. Leave it **None (clean segue — silence is fine)** and unassigned categories play a **clean
segue** — silence between songs is a legitimate programming choice here, **never an error**. Nothing warns
you; nothing is placed.

#### How it behaves on air

- In **Up Next**, a scheduled sweeper appears as **its own row, directly above the song it introduces**,
  with an **SWP** badge, its title and its length:
  - **Category colour = scheduled** — it is placed for this seam.
  - **White = armed** — the seam is coming up (within about 90 seconds); the sweeper is loaded and ready.
  - **Yellow (blinking) = firing** — the sweeper is on air right now.
  - **at seam** — the element before it is a commercial, so the sweeper starts exactly at the seam
    instead of over the end of the spot.
  - **FILE MISSING — WILL NOT PLAY** (title struck through) — the sweeper's audio is not on this
    computer, so it will be skipped.
- Sweepers are logged in Play History but **kept out of music reports and rotation math** — they never
  count as a song play or block an artist.

#### Turning the imaging channel off (the ON button)

Sweepers and carts reach air through their own board channel. Its **ON** button is a **channel on/off**,
exactly like the OFF switch on any board channel. It is not a play button and not a light.

- **ON (lit)** — imaging and carts pass to air normally.
- **OFF (unlit)** — the channel is **cut**. Sweepers and carts still fire on schedule, but **no audio from
  them reaches air**. Nothing else is affected: music, spots and the decks keep playing untouched.

Use it when you want a clean run with no imaging — a special broadcast, a live remote, a memorial — without
tearing down your pools or assignments. Turn it back ON and imaging resumes on the next fire.

The setting is **remembered per station**. Each station has its own — cutting imaging on one station does
not cut it on another. **If your imaging has gone silent, check this button first.**

When the channel is off the fader dims but stays usable — that is "switched off," not broken. You can still
set the level while it is off; it takes effect when you turn the channel back on, and turning the channel
off and on **never moves your fader**. See **Channel Faders** ([Channel Faders and Channel Cut (ON/OFF)](#channel-faders-and-channel-cut-onoff)) for how this
works on every channel strip.

#### If you don't see any imaging

- **Nothing assigned?** A category with **OVERLAY = none** and no station fallback plays a clean segue by
  design.
- **No tagged cuts / empty pool?** Mark cuts as sweepers in the Library and put them in a pool.
- **Wrong hour?** Check the category's **ACTIVE HOURS** — it may be gated out of the current hour.
- **Did you Generate?** Placements happen at Generate time. Regenerate after changing an assignment.
- **FILE MISSING in Up Next?** The sweeper's audio isn't on this computer; it will not play.
- If a sweeper is armed but the song is skipped or the hour hard-cuts at :00, it cancels cleanly and re-arms
  for the next seam — that's expected.
- **Next to a commercial?** A sweeper after a spot still fires, but **at the seam** (lead 0), never over the
  end of the commercial. If you don't want imaging around a break, that's what **ACTIVE HOURS** and the
  category's **OVERLAY = none** are for.

#### Not in this version (by design)

- **Trailing links** — imaging is *Leading* (introduces what's next). Outro-over-the-tail comes later.
- **Produced / semi / dry variants** — a production practice: drop the different cuts into one pool and
  rotation handles the variety. No separate setting.

#### Known issue

Each pool row also shows a **LEAD-IN s** box. It has no effect on air — the category's **LEAD (s)** is the
number the schedule uses.

#### Related

- **Spots** ([Spots & Promos](#spots--promos)) — scheduled commercials/breaks (different from imaging).
- **Segue overlap** ([Segue overlap (no dead air between songs)](#segue-overlap-no-dead-air-between-songs)) — the seam a sweeper plays over.
- **Reel Splitter** ([Reel Splitter — cutting a sweeper reel](#reel-splitter--cutting-a-sweeper-reel)) — cutting a reel into sweepers (the ADD IMAGING tab).
- **Clocks / Generate** — where the schedule (and sweeper placements) are built.

### Imaging

*The home for everything that fires between songs — the cuts, the pools they sit in, what is assigned where, and what will fire ahead of you.*

**Where:** Hamburger menu → Imaging, opens in its own window (or bottom bar → SWEEPERS → OPEN IMAGING, or Tools → Monitors → Imaging)  
**Since:** 4.6.13

#### What it is

**Imaging** is everything short that goes between the songs — station IDs, sweepers, stingers, the
"you're listening to…" drops, and announcements. It never sits on a deck and never interrupts the music:
it fires on the **seam** between two songs.

IMAGING shows all of it in one screen, including every cut in one list and what is about to fire. The
SWEEPERS push-up at the bottom of the screen is the quick way to the same settings mid-show.

#### How to get there

- **Hamburger menu → Imaging.** This is the main door. It opens in its own window, beside the mixer.
  (Also **Tools → Monitors → Imaging**.)
- **Bottom bar → SWEEPERS → OPEN IMAGING.** The push-up is the quick way in mid-show; this button
  walks you from it to the full picture.

#### The five views

**RACK** — every imaging cut in the library, one row each: its name, its type (SWEEPER or
ANNOUNCEMENT), its length, and which pool it belongs to. If a length shows a dash, that cut has no
duration recorded — the row is incomplete, not broken, and it will still play.

Every cut is available to **every station** — one shared library, the same as your songs. The POOL
column shows only *this* station's pool; a dash there means the cut is not in one of them, not that it
is unavailable.

**POOLS** — the groups a category can draw from. A pool is how you get variety: assign a category to a
pool of ten IDs and it rotates through them instead of playing the same one every time.

A cut can be in **several pools at once**, including pools belonging to different stations — the
library is shared, and adding a cut to one pool takes it out of nothing.

**ASSIGNMENTS** — which music category gets which imaging, the LEAD (how many seconds before the next
song starts the cut fires), and the ACTIVE HOURS it is allowed in. This is the grid that decides what
actually happens.

**ON DECK** — what will fire ahead of you, in log order, with the **specific cut named** against the
song it introduces. This is the view to check before a shift: it tells you what the audience is about
to hear, not what might happen.

**RULES** — where segue bans will live. **Nothing is configured and bans are not built yet.** The view
says so rather than showing controls that do nothing.

#### What you can change here

**POOLS and ASSIGNMENTS are live** — create and name pools, put cuts in them, and set each category's
imaging, LEAD and active hours, right here.

The **SWEEPERS push-up** at the bottom bar does the same job and is unchanged. Mid-show it is faster
than leaving the mixer, so use whichever is closer to hand: both are the same editor, so they can never
disagree about what is set.

**RACK, ON DECK and RULES show no controls at all** — not greyed-out ones. What they will eventually let
you do (swap a placement, write a ban) is not built, so there is nothing there to press.

**Song timing is not set here.** A song's intro is marked where songs are edited: right-click the song
in the Library and choose **Edit Cue Points** (or use the row's **Cue…** button → **Open in Cue
Editor**), then drag **INTRO END** to the first word and Save. See "How imaging fits a song" below.

#### If ON DECK is empty

It tells you which of three things is true, because they need different fixes:

- **"Nothing is scheduled ahead of now."** There is no generated log. Go to the **Program Log** and
  press Fill Day.
- **"N elements scheduled, no imaging placed."** The log exists but carries no imaging. The view names
  the reason — usually that no music category has an overlay assigned and there is no fallback pool.
  Fix it in ASSIGNMENTS, then Generate again.
- **A list.** Imaging is placed and this is what will fire.

Changing an assignment does **not** rewrite a log that is already generated. Generate the day again to
see it take effect.

#### Words you will see

- **Cut** — one piece of imaging audio.
- **Pool** — a group of cuts a category rotates through.
- **Assignment** — the link from a music category to a cut or a pool.
- **LEAD** — how many seconds before the next song starts the cut fires, so it plays over the tail of
  the song that is ending.
- **Active hours** — the hours of the day an assignment is allowed to fire in.

- **Post** — where a song's vocal starts. It is the **INTRO END** marker in the cue editor, and it is
  how much room imaging has before the singing.
- **Ban** — a rule saying a cut may not go somewhere. Not built yet.

#### How imaging fits a song

Imaging fires by the category's fixed **LEAD**: that many seconds before the next song starts.

Marking each song's **post** (INTRO END in the cue editor) is still worth doing, starting with the songs
that play most — it records how much room each song has before the vocal.

#### Not in this version

- **Letting the song's post decide the timing** (a cut chosen to fit the intro and landing on the first
  word) cannot be switched on from the app yet. Every category uses the fixed LEAD.

#### Related

- **Sweepers** (`help-sweepers.md`) — the push-up editor, in detail.
- **Categories** — the music categories that assignments hang off.
- **Program Log** — where the log is filled.

### Reel Splitter — cutting a sweeper reel

*Slice a long imaging reel (sweepers stacked back to back) into individual sweepers, named and pooled in your library, in one screen.*

**Where:** Bottom bar → SWEEPERS → “ADD IMAGING — CUT A REEL” tab  
**Since:** 4.4.58

> Built-in help corpus entry — plain language, step-by-step; the Iris tour layer reads it verbatim.

#### What it is

A **reel** is one long audio file with many sweepers stacked back to back, separated by silence — the way
imaging often arrives from a production house. The **Reel Splitter** is a single dedicated screen that
slices that reel into individual cuts, lets you review them by ear, and adds them all to your library —
**tagged as sweepers and pooled in one step**. It is not a DAW: no tracks, no BPM, no sessions.

#### When to use it

Any time you get a bundle of imaging as one file. If your sweepers are already separate files, just import
them normally and mark them as sweepers in the Library, then manage them in the **SWEEPERS** push-up.

#### Do it (one screen)

1. **Open.** Bottom bar → **SWEEPERS** → the **“ADD IMAGING — CUT A REEL”** tab. **Drag the reel onto the
   drop zone**, or click **Open reel…**.
2. **Auto-cut.** The splitter finds the silent gaps and pre-slices the reel into **numbered regions** on the
   waveform. Too many / too few cuts? Drag the **Silence threshold** slider (−70 to −25 dB) and hit
   **Re-cut** — lower (more negative) dB splits on quieter gaps.
3. **Review (keyboard-first).**
   - **Space** — audition the selected region.
   - **← / →** — move between regions.
   - **Delete** — remove the selected region.
   - Drag a selected region's **left/right edge** on the waveform to fine-tune its boundaries.
   - Row buttons: **▶** audition · **⌥** split in half · **⌄** merge with the next · **✕** delete.
4. **Name.** Each region is pre-named `<reel> 01`, `<reel> 02`… Click **EDIT** on any name to change it.
5. **Commit.** Optionally pick a **pool**, then **Commit N sweepers →**. Each region is rendered to its own
   file and added to the Library as a sweeper, in the pool you picked — ready to assign to a music category
   in the **SWEEPERS** push-up.

#### Where the cuts go

Rendered cuts are written into your audio catalogue folder, one file per cut, named
`<reel>__<name>.wav`, and imported by that path — the normal Library import, no side doors.

#### If something looks off

- **Regions merged / too coarse** — raise the threshold toward −25 dB and Re-cut, or use **⌥ split**.
- **One giant region** — the reel had no clear silence gaps; split by hand with **⌥** and drag edges.
- **A cut has silence on the ends** — drag its edges in tighter; the auto-cut keeps a small pad.
- **Committed to the wrong pool** — the cuts are normal library items; change the pool in the
  **SWEEPERS** push-up.

#### Related

- **SWEEPERS push-up** — assign these cuts to music categories (a specific sweeper or a rotating pool).
- **Library** — where every committed cut lands.

### Spots & Promos

*Commercials, promos, PSAs and sponsorships — scheduled into timed breaks on your clocks, kept out of music rotation and reporting.*

**Where:** Bottom bar → SPOTS · Library right-click → Mark as Spot  
**Since:** 4.4.79

#### What it is

**Spots** are your non-music, scheduled audio — **commercials, promos, PSAs, sponsorships**. Unlike a sweeper
(which fires as an overlay on a song seam), a spot is a full element that plays in a **timed break** on your
clock: "a stop set at :20 past the hour, three spots." Spots are kept **out of music rotation** and out of
music reporting — they're their own content class (amber **SPOT** badge on a library track).

The **Spots & Promos** panel is the traffic manager: each spot carries a **category** (e.g. Local Sponsors,
Top-of-Hour IDs), a **type** (commercial / promo / PSA / sponsorship), and optional **flight dates**, a
**max-plays-per-day** cap, and an **advertiser**. Clocks pull from spot categories at the break times you set.

#### When to use it

Anything that's a scheduled commercial break. Short imaging that rides *over* the music (station IDs,
stingers, sweepers) is **Sweepers**, not this.

#### Two ways in

##### Fast path — Mark a library track as a Spot
The quickest way to turn an existing audio file into a spot:

1. Open the **Library** and **right-click** the track.
2. Choose **Mark as Spot (SPOT)**.
3. In the small dialog, pick a **category** (or type a new one — this is **required**) and a **type**
   (Commercial by default), then **Mark as Spot**. A spot with no category can't be pulled by a break, so
   the dialog won't let you finish until one is set.
4. The track gets an amber **SPOT** badge, leaves music rotation, and a spot record is created carrying its
   title and file. Fine-tune dates, caps and advertiser later in the panel.

*(To undo: right-click → **Unmark Spot (→ Music)** returns it to music rotation.)*

##### Full manager — the Spots & Promos panel
Open **SPOTS** in the bottom bar (or **Library → Spots & Promos** in the top menu):

1. **Add Files** or **Import Folder** to bring in your commercials/promos — or use the Mark-as-Spot fast
   path above. **Import Traffic CSV** reads a traffic system's export (cart/ISCI, title, advertiser,
   agency, length, dates, type) and is the way to bring in cart and ISCI numbers.
2. Organize them into **spot categories** (create categories like *Local Sponsors* or *Station Promos*).
3. Set each spot's **type**, **advertiser**, **flight dates** (start/end), and **max plays per day**.

#### Scheduling the breaks (on your clocks)

Spots don't rotate like music — they air in **timed breaks** you place on a clock:

1. Open **CLOCKS**.
2. On a clock, use the **Timed Spot Breaks** grid: set a break at a minute past the hour (:00, :20, :40…),
   choose which **spot category** it pulls from, and how many spots it plays.
3. Every hour that clock runs, the break airs at that time. Music fills the time around the breaks
   automatically — you don't count songs to fill the hour.

#### Will it air? (the amber cues)

- In the **Spots & Promos** list, any spot that a break **can't pull** wears an amber **⚠ WON'T AIR** flag —
  it's either **inactive** or has **no category**. Open it (Edit) and set an active status + a category to fix.
  This is your at-a-glance check that every spot is schedulable.
- If a **timed break** on your active clock pulls a category with **no eligible spots**, the panel shows an
  amber banner naming each empty break (":20 → Sponsors — add or activate a spot"). If a break points at
  *another station's* category (a leftover after splitting stations), the banner says so and sends you to
  **Clocks → Timed Spot Breaks** to re-pick. The clock break editor shows the same **⚠ 0 eligible spots**
  warning inline, and each category in its dropdown shows its eligible count. A break that would air silence
  is never a silent fact.
- Once a spot is scheduled, its rows render **gold/amber** everywhere the log shows — in the **Program Log**
  (a **SPOT** chip) and in the **live Up Next queue** (amber left-edge + **SPOT** chip) — so a
  commercial break is instantly distinct from music at a glance.

#### How spots air (exclusive program, clean edges)

- A spot is **exclusive program content** — it owns its slot like a song. At a break the spot plays **alone**:
  clean start, clean end, **no music overlap in or out** and **no sweeper over it** (imaging introduces music,
  never a commercial). The next song follows at the spot's natural end.
- Spot length is read from the **actual audio file** on import / Mark-as-Spot (not a guessed default), so the
  log and the break timing are accurate. Existing spots self-repair their length the next time the panel loads.
- **Amber deck flash:** while a deck is holding a spot — from the moment it loads until it finishes airing —
  that deck card pulses an amber/gold frame, readable across the room. Songs never flash; this is separate
  from the sweeper indicator (the white/yellow line under a deck).

#### Taking a spot off the air

A campaign ends, or an advertiser pulls a commercial, and you need it to stop airing. Two ways, and
they now do the same thing:

- **Delete it** — the trash icon on its row.
- **Switch it inactive** — open the spot and turn **Active** off. Use this when the advertiser may be
  back; the spot keeps its artwork, category and play history and can be switched on again later.

Either way Ether does **two** things, and the second one is the one that matters:

1. It stops the spot being placed in any future log.
2. **It pulls the spot out of the log that is already written.**

That second step matters because the airing log is generated ahead of time — often a full day or more.
Without it, a spot you deleted this morning would keep airing all day from the log made last night.

Ether tells you what it pulled: *"Deleted ‘Opportunity Village’ — 14 future airings pulled from the log"*.
If it says **no future airings were pulled** and you can still hear the spot, that is worth reporting —
the message is there so the two can never quietly disagree.

If the delete fails for any reason, the panel says so and the spot stays on screen. It never closes as
though it worked.

##### What is deliberately NOT removed

- **Anything that already aired.** The play log is your advertiser affidavit — proof the commercial ran.
  Deleting the spot never erases a minute of it.
- **The spot playing right now.** If it is on air as you delete it, it finishes. Ether never yanks audio
  off the transmitter mid-play.
- **Rows you placed by hand.** Anything you dropped into the log yourself stays yours.

##### Across two computers

If you run more than one Ether machine on the same account, deleting or deactivating a spot on one of
them takes it off the air on **both** — each machine pulls the spot from its own log as the change
arrives. There is nothing to repeat on the second machine.

##### The one case you still handle by hand

A spot already **loaded on a deck**, or scheduled inside the **current hour**, may air once more. If you
need it gone immediately, remove that entry in the Program Log's hour editor (✎ Edit → ✕), or eject the deck.

#### Notes

- A spot at the **top of the hour** airs exactly at :00; breaks at other minutes drop at the nearest song
  boundary so a song is never cut off mid-play.
- Spots are excluded from music-rotation separation and from the music/plays reporting — they have their own
  play logging for advertiser affidavits.

#### Known issues

- The **Edit Spot** form has no cart number or ISCI field. To set them, use **Import Traffic CSV**.
- Use **Mark as Spot** from the **Library** right-click menu. The same item on a deck or Up Next
  right-click menu tags the track as a spot without the category dialog and without creating the spot
  record, so a break cannot pull it.

#### Related

- **Spot Artwork** ([Spot Artwork](#spot-artwork)) — your own image on a spot.
- **Traffic & As-Run** ([Traffic & As-Run](#traffic--as-run)) — proof each spot aired, exported for billing.

### Spot Artwork

*Pick your own image for a spot, so a commercial stops borrowing album art that has nothing to do with it.*

**Where:** Bottom bar → SPOTS → Edit (on a spot row) → Artwork  
**Since:** 4.4.134

#### What it is

Every spot can carry **your own image** — the client's logo, a campaign graphic, a park photo. You choose it
once per spot and it stays with that spot.

Without one, a spot has no picture of its own, and anywhere artwork is shown the app falls back to whatever it
can find automatically. For music that works fine. For a commercial it often doesn't — an automatic lookup goes
by the spot's **title**, so a spot called "Zombie Nights" can come back wearing a rock band's album cover.
Setting artwork yourself is how you stop that for good.

#### When to use it

- A spot is showing a picture that has nothing to do with it.
- You want a sponsor's logo on screen when their spot plays.
- A campaign has its own graphic and you want it used consistently.

You don't have to set artwork on every spot. Set it on the ones that matter.

#### Where your image goes — read this once

**The image stays on this computer.** When you choose a picture, EtherCast reads it and stores a copy **inside
the spot itself**, in the station's local database. It is **not uploaded to the internet**, not sent to
Cloudflare, and not published anywhere. Choosing an image makes no network connection at all.

This is the same thing the **station logo** in Preferences already does.

Two practical consequences:

- **Your original file is not needed afterward.** The copy lives in the spot. You can move, rename or delete
  the file you picked and the artwork stays. (It also means editing the original later won't update the
  spot — choose the image again to refresh it.)
- **It's saved on this machine.** If your station syncs to other computers, spot artwork travels with your
  other spot data the same way. Anything not covered by that sync stays here.

#### Set it up (bottom bar → SPOTS)

1. Open **SPOTS** from the bottom bar.
2. Find the spot in the list and click **Edit**. The **Edit Spot** form opens.
3. Look to the right of the **Notes** box — that's the **Artwork** panel. A spot with no image shows an empty
   square reading **"No artwork"**.
4. Click **Choose image…** and pick your picture. PNG, JPG, WEBP and SVG all work.
5. The thumbnail updates immediately so you can see what you picked.
6. Click **Save**. Nothing is stored until you save.

#### Changing or removing artwork

- **Swap it:** click **Choose image…** again and pick a different file. Save.
- **Remove it:** click **Clear**, then **Save**. The spot goes back to having no image of its own.
- **Changed your mind mid-edit:** click **Cancel** instead of Save and nothing changes.

**Clear** is greyed out when there's no artwork to remove — that's normal, not a fault.

#### Tips

- **Square images look best.** The thumbnail is square, so a square picture won't get cropped oddly.
- **Sensible file sizes.** A logo at roughly 500×500 is plenty. Very large photos make your database bigger
  for no visible gain.
- **A recognisable image beats a pretty one.** At small sizes a clean logo reads better than a detailed photo.

#### Troubleshooting

**I clicked Choose image… and nothing happened.**
The file picker may have opened behind the main window — check your taskbar. If you cancelled the dialog,
nothing changes, which is expected.

**The picker window is titled "Choose Station Logo."**
Known cosmetic wording — it's the same picker the station logo uses. It selects your spot artwork correctly.

**I picked an image but it's gone.**
It isn't saved until you press **Save** on the Edit Spot form. Re-pick and save.

**The thumbnail is there but the spot still shows the wrong picture elsewhere.**
Artwork you set here is stored on the spot. If somewhere else in the app is still showing an automatic
picture, report it — that's a display problem, not a problem with what you saved.

#### Related

- **Spots & Promos** — creating spots, categories, and timed breaks.
- **Preferences → Station logo** — the station-wide image, stored the same local way.

### Traffic & As-Run

*Prove your spots aired. Scheduled vs actual time for every commercial, with advertiser, cart and ISCI — exported as the CSV your billing runs on.*

**Where:** ≡ Menu → Play Log → Traffic tab · Schedule → Play Log in the menubar · keyboard G  
**Since:** 4.4.166

#### What it is

**Traffic** is the affidavit side of your log. Where **Play Log** shows everything that aired, **Traffic**
shows only the **spots** — commercials, promos, PSAs, sponsorships — and answers the one question a
sales department asks: *did the client's spot actually run, and when?*

For every spot the log placed, Traffic shows the time it was **scheduled**, the time it **aired**, the
**difference between them**, and the advertiser identifiers a billing system needs: **cart number**,
**ISCI code**, **advertiser**, **agency** and **length**.

#### When to use it

- **End of month, before invoicing** — export the period and send it to whoever bills.
- **A client asks for proof** their spot ran. Export the day, hand them the rows.
- **Something looks wrong** — a stop set that didn't fire shows up as **MISSED** with the exact time it
  should have gone.

#### How to get there

Open the **≡** menu and choose **Play Log** (it opens in its own window), or press **G** on the main
screen. Then click the **Traffic** tab beside the title.
The date buttons — Today / 7 Days / 30 Days / All, or a custom from–to range — control both tabs.

#### Reading the table

| Column | What it means |
|---|---|
| **Sched** | When the log placed the spot |
| **Aired** | When it actually played. A dash means it hasn't (yet) |
| **Δ** | Aired minus scheduled, in seconds. Turns amber past two minutes |
| **Status** | **AIRED**, **MISSED**, or **PENDING** (scheduled, not yet due) |
| **Cart / ISCI** | The advertiser's identifiers, from Spots & Promos |
| **Advertiser** | Who is being billed |
| **Len** | Spot length in seconds |

A **Δ of a minute or two is normal** — a spot waits for the song in front of it to finish. A large or
growing Δ means the log is drifting from the clock, which is worth investigating.

**PENDING is not a fault.** If you pick a 7-day range, spots later in the week haven't come due yet. The
**Aired of Due** figure deliberately ignores them, so it never reads as a failure just because you looked
at future days.

#### Exporting

Click **Export Traffic CSV**. You get one row per spot for the selected period:

```
Date, Scheduled Time, Actual Time, Delta (s), Status, Cart, ISCI,
Advertiser, Agency, Title, Length (s), Spot Type
```

It opens directly in Excel, Google Sheets or Numbers, and imports into most traffic systems.

The button is greyed out when there are no spots in the period — that is the honest state, not an error.

#### "No spots scheduled in this period"

Traffic reads the **generated log**, not your spot library. If this is empty but you have spots loaded:

1. Check your **clock** actually contains **spot breaks** (Clocks → the clock → **Timed Spot Breaks**).
2. Open the **Program Log** and press **Fill Day** for the day(s) you want.
3. Come back — the spots will be listed with the time they are due.

#### Blank advertiser, cart or ISCI

If you see the amber notice saying spots have no identifiers on file, they will still export, but with
those columns blank — which most billing systems will reject. Fill them in under **Spots & Promos**:

- **Advertiser** — click **Edit** on the spot and type it in.
- **Cart number and ISCI** — bring them in with **Import Traffic CSV** (a cart/ISCI column in your
  traffic system's export). The import reads one identifier column and fills both Cart and ISCI with it.

Traffic reads these from the spot, so you do not need to regenerate.

##### Known issue

The **Edit Spot** form has no cart number or ISCI field, so a single spot's cart or ISCI can't be typed
in by hand yet. Use **Import Traffic CSV**.

#### As-Run (all content, not just spots)

The **As-Run** button reconciles the *whole* log — music included — showing matched,
missed, unscheduled and pending items with a match percentage. Use Traffic for billing; use As-Run when
you want to see how faithfully the whole day followed the log.

**Unscheduled** means something aired that the log didn't place — a hand-loaded track or a cart fired
live. That is normal in a live-assist shift and is shown so it can't be mistaken for a scheduled element.

#### What it does not do (yet)

- It does not **import** reconciliation back into a third-party traffic system — export only.
- It does not generate an invoice. It produces the proof-of-performance an invoice is built from.

### Scheduling Announcements

*Select dates, build the list, press Apply — Apply commits the editor to the selected date(s), then clears.*

**Where:** Schedule menu → Announcements → the Schedule column  
**Since:** 4.4.230

#### What it is

An announcement is just **the audio** — a name and a file, uploaded in the list at the bottom of the
page. **When it plays is separate**, and it is scheduled against **real calendar dates**. There is no
"every Wednesday": you pick the actual dates.

**One rule: nothing scheduled means nothing plays.**

The panel works in three steps, and **nothing is written until you press Apply**:

> **Select** the date(s) → **Edit** the list → **Apply**

After Apply, the selection and the editor clear, so what you are editing is never in doubt.

#### Edit one day

1. **Click the date** on the calendar. The right column loads exactly what is scheduled on that day.
2. Change what you want — edit a time, add a line, remove one.
3. Press **APPLY**. Only that day changes, and the panel clears.

#### Set up several dates at once

1. **Click each date you want.** The first click loads that date's schedule; every click after that
   just adds the date to the selection — the editor is left alone.
   - To take a whole run, click a **weekday letter** at the top of the calendar. That selects every
     one of them in the visible month.
   - The selection survives moving between months with **‹ ›**, so a whole season can be picked.
2. Build the list on the right: **＋ Add Announcement**, pick the announcement, set its time.
   - Each line plays either **at a set time** or **before closing**. If any line is timed from
     closing, a **close at** time appears above the list — set the closing time there. It is saved
     with the lines when you press Apply, for the selected dates only.
3. Press **APPLY**. Every selected date is set to that list, then the panel clears, ready for the
   next batch.

**Copying a day onto others:** click the day you want to copy (it loads), then click the other dates,
then Apply.

#### What Apply does

**Apply makes each selected date's schedule exactly what is in the editor.** Anything on those dates
that is not in the editor is removed — the line under the button says so. If any selected date already
has announcements, pressing APPLY first asks you to confirm (**Replace** / **Cancel**) and says how many
of the selected dates it would replace.

Applying an **empty** editor clears the selected dates, so nothing plays on them. The panel says so
before you do it.

Lines you did not change keep their place — applying does not disturb an announcement that already
aired today.

#### How to read it

- A date on the calendar showing **♪3** has three announcements on it.
- **unapplied changes** in amber next to the button means you have edited the list and not pressed
  Apply yet. Cancel throws those edits away.
- In the announcements list at the bottom, the **Scheduled** column shows the next date each one
  plays. **not scheduled** in amber means it will never fire — the first thing to check if something
  didn't go to air.

#### Worth knowing

- **Each date owns its own list.** Applying to five dates gives each of them the same five lines;
  from then on they are five independent schedules and any one of them can be edited on its own.
- **Deleting an announcement removes it from every schedule.** You'll be told how many lines go with
  it first.
- **Whether anyone hears it is still the board's call.** The schedule decides *when* an announcement
  fires onto the Announcement channel. The fader and channel ON decide whether it reaches air. If a
  scheduled announcement didn't go out, check the channel before you check the schedule.
- **Ducking is set per station** in Preferences → Ducker, and applies to every source. There is no
  per-announcement duck setting.
- **It syncs.** Your other machines running this station get the same schedule.

---

## 7. Library & files

### Open File Location

*Right-click an item with audio behind it and jump straight to its file in Explorer or Finder — or see why the file isn't on this machine.*

**Where:** Right-click a song in the Library, Up Next or on a deck; a cart tile; a spot; an announcement → Open File Location  
**Since:** 4.6.0

Every item in Ether that plays audio is backed by a real file on your computer. **Open File Location**
takes you straight to it — it opens the folder that contains the file, with the file already
selected, so you can copy it, check it, move it, or see where it actually lives.

It works the same way on every screen that offers it, because it belongs to the item, not to the
screen you happen to be looking at.

#### How to use it

1. **Right-click** the item — a song, a sweeper, a spot, a cart, anything with audio behind it.
2. Choose **Open File Location**.
3. Your file browser opens (Explorer on Windows, Finder on Mac) with that file highlighted.

#### Where you can do it

- **Library** — right-click any song row.
- **Up Next** — right-click any queued song.
- **A deck** — right-click a song loaded on a deck. (An empty deck has no menu.)
- **The cart wall** — right-click a cart tile, then **OPEN FILE LOCATION**. (An empty tile has no menu.)
- **Spots** and **Announcements** — right-click an item.

The Library, Up Next, deck and cart menus also have **Change File Location…**, which points the item at
a different file — the one to use when the audio has moved. It stays available when the file is missing.

#### When it's greyed out

The menu entry is sometimes greyed. Hover it and it tells you why:

| What it says | What it means | What to do |
|---|---|---|
| *the audio isn't on this machine — this item needs re-importing* | The item's row still points at a file, but that file is not on this computer. It may have been moved, deleted, or it may exist only in your cloud library and never have been downloaded here. | Re-import the audio, or wait for the library to finish downloading from the cloud. |
| *this item has no file* | The item has no audio attached at all. | Assign a file to it first. |
| *checking for the file…* | Ether is still looking. | Wait a moment — it resolves immediately. |

**Ether deliberately will not open a folder it knows the file isn't in.** Doing that looks like the app
is broken, when the real answer is that a track needs re-importing. The greyed entry tells you which
of the two it is.

#### Why this is useful

- **Confirm what's actually playing.** The title in Ether comes from the file's tags; the folder shows
  you the file itself.
- **Find missing audio.** If a track won't play, this tells you at a glance whether the file is even
  there.
- **Housekeeping.** Copy a spot to send to a client, back up a sweeper, or tidy a folder without
  hunting through directories.

### Renaming an item (Library, Reel Splitter, sweeper pools)

*Rename a song or sweeper from its Library row, name each cut in the Reel Splitter before you commit it, and rename sweeper pools in the SWEEPERS push-up.*

**Where:** Library → Title column → EDIT; SWEEPERS → ADD IMAGING — CUT A REEL → EDIT on a cut; SWEEPERS → a pool's name field  
**Since:** 4.4.74

You can rename a song or a sweeper right from its row — no need to open a full editor. The rename is
explicit: you click **EDIT**, change the name, and choose **SAVE** or **CANCEL**.

#### In the Library

Songs and sweepers are both Library items, so this is where either is renamed.

1. Open **Library** (bottom bar).
2. Find the row you want to rename.
3. In the **Title** column, click **EDIT**.
4. Type the new name.
5. Click **SAVE** (or press **Enter**). Click **CANCEL** (or press **Esc**) to leave it unchanged.

The new name is saved to the item in the Library.

#### Sweeper pools

In the **SWEEPERS** push-up (bottom bar), each pool's name is a text field. Click into it, type the new
name, and click away — it saves when you leave the field. Individual sweepers are renamed in the
Library, not here.

#### In the Reel Splitter

When you cut a reel into pieces, each cut in the list has a name **before** you commit it:

1. In the region list, click **EDIT** on a cut.
2. Type the name you want that cut saved under, then **SAVE** (or **CANCEL**).
3. When you commit, each cut is saved to your library under the name you gave it.

#### Notes

- If a Library row is from a **borrowed / shared catalog**, its title is read-only and the **EDIT** button
  won't appear — the owning account controls that name.
- Renaming only changes the display name. It does not move the audio file or change which pool/category the
  item belongs to.
- Rows already filled into the **Program Log** keep their own copy of the title, so they may still show
  the old name.

### Deleting a Song

*Deleting a song removes it from the library and pulls it out of every future log — it never airs again, even after you regenerate. What it already aired stays on the books.*

**Where:** Library → right-click a song → Delete  
**Since:** 4.4.151

#### What it is

Deleting a song takes it out of your library **and out of everything scheduled ahead of it**. The song stops
being something the station can play: it won't be picked when you Generate, it won't show up in the queue or
the Program Log, and it won't come back the next time you fill a day.

What it *already* played stays exactly where it is. Your airplay history — the record you'd hand an
advertiser to prove their spot ran — is never rewritten by a delete.

#### When to use it

- A track you don't want on the air any more: wrong format, bad edit, licensing pulled, a duplicate import.
- A song that's damaged or won't play properly.

If you only want a song to *rest* for a while, don't delete it — that's what rotation status and rest rules
are for. Delete is permanent.

#### How to delete a song

1. Open the **Library**.
2. Find the song. (Search matches title, artist, and cart number.)
3. **Right-click** it and choose **Delete**.
4. Confirm.

That's it. There is no second step and nothing to clean up afterwards.

> **Known issue:** if no confirmation appears after you choose **Delete**, the song has not been
> deleted. Search the Library for it to check, and report it to support.

#### What happens the moment you delete

**Removed — the song's future:**

- It disappears from the **Library** and from library search.
- Every **upcoming log entry** for it is pulled — today's and every future day already generated.
- It's dropped from the **queue** and the **Program Log**.
- It's removed from any **pinned** spot, **programming** entry, and its **category assignment**.
- If it was pinned into a **clock** slot or set as a **category's** imaging, that slot or category stays
  exactly where it is — it simply no longer points at the deleted song. Your clocks are not rearranged.
- **Generate will never pick it again**, no matter how many times you regenerate.

**Kept — the song's past:**

- **Airplay history** (what aired, and when) — your advertiser proof.
- The **log entries for plays that already happened**, marked as played.
- **Anything on the air right now stays on the air.** If you delete a song while it's playing, it finishes
  normally. Deleting never cuts live audio.

#### How to check it worked

1. Search the **Library** for the song — no result.
2. Open the **Program Log** and **Fill Day** again.
3. Search the log — the song is not there, and it won't be there after any future Generate either.

#### Things worth knowing

- **The audio file itself is not erased from your computer or your cloud storage.** Deleting removes the song
  from the station's library and programming; it doesn't reach onto your disk and delete the file. If you
  want the file gone, remove it yourself.
- **Deleting is not the same as re-importing.** If you delete a song and later import the same file again, it
  comes back as a new library entry — fresh, with none of its old tags or category.
- **On more than one machine?** The delete travels with your account. Other installs signed into the same
  account stop playing the song too, as soon as they sync.

#### If something looks wrong

- **The song is still in the queue right after deleting.** The queue on screen may show what was already
  handed to the audio engine. It clears at the next break; nothing new will be loaded from that song.
- **A song you deleted seems to still be playing.** If it was already on the air, it finishes normally.
  If it airs again after that, note your version (**Help → About**) and report it to support.
- **You deleted the wrong song.** There's no undo. Re-import the file with the Library's **+ Import Music** button
  and re-tag it.

#### Deleting things that aren't songs (spots, announcements)

The Library lists more than songs. Commercials and announcements appear there too, alongside your
music, because the Library is the one place you say what a file **is**.

**Delete works on all of them.** You don't have to go and find the right panel first — deleting a
commercial from the Library is the same as deleting it from the Spots panel, and does exactly the
same things: it stops being scheduled, and **it is pulled out of the log that was already written**
so it stops airing. Ether tells you what it pulled.

##### "It's in the Library but not in the Spots panel"

That means the commercial's traffic record is gone but its library entry was left behind — a stray,
left over from older builds.

**Deleting the stray from the Library clears it**, and the removal travels to your other machines.
If you have a lot of them, ask for the one-off cleanup rather than clicking through them — it can
retire all of them at once, and it shows you the list before it changes anything.

##### What is still never deleted

Same rules as songs: **your airplay history is kept** — that's the advertiser's proof the commercial
ran — anything **currently on air finishes**, and **the audio file stays on your disk**. Deleting
removes the library entry, not the recording.

---

## 8. Stations, sync & backup

### Backing up your station, and putting it on another computer

*One switch — Keep my stuff synced — keeps your setup and your audio in the cloud. The status card says exactly what is safe and shows the one button you need; any computer you sign into can become your station.*

**Where:** Settings → Backup & Restore  
**Since:** 4.6.49

Your station lives in two parts, and both matter:

- **Your setup** — your song list, clocks, shows, schedule, categories and settings.
- **Your music files** — the actual audio.

A backup is only useful if it has both. A setup without the audio restores onto a new computer looking
perfectly normal, and then the songs won't play.

---

#### Backing up

Open **Settings → Backup & Restore**. The status card at the top tells you exactly where you stand, and
shows the one button you need:

- **✓** *"Everything on this computer is in the cloud — your whole setup and all 511 audio files, as of
  …"*. Everything is safe. This is the only state that means you can rebuild on another computer. There
  is no button, because there is nothing to do.
- **!** *"Your setup is safe. 137 of 511 audio files haven't gone up yet — on another computer those
  would arrive with no sound."* Press **Finish sending** to send the rest.
- *"Nothing is in the cloud yet."*, or *"All 511 audio files are safe. Your setup hasn't gone up yet."*
  Press **Back up now**. It saves your setup to the cloud, then sends any audio that isn't there yet.

The count is read from your actual library every time, so it always reflects what is really in the cloud.

**Songs you've deleted are not backed up.** Deleting a song removes it from your library and your
schedule, so it won't reappear on another computer. The audio file itself stays in the cloud.

##### Automatic backups

There is no separate switch for this. **Keep my stuff synced** is the one switch, and while it is on Ether
sends your setup to the cloud on a schedule and brings new audio down from your other computers, on
every computer signed into your account. Audio added on *this* computer goes up when you send it (see
**Audio arriving from your other computers** below). Leave the switch on.

To change how often your setup goes up, open **Advanced** and use **How often to send your setup** (every
hour up to once a day), then press **Save**. That row only sets the schedule; on and off is the switch
above it. It covers your **setup** only — audio goes up when you send it (see below), not on a timer.

If you've just imported a big batch, send it straight away: press the button on the status card, or
**Send just the audio** under **Advanced**.

##### Checking it really is on (or really is off)

The switch and the machinery behind it read the same setting, so they cannot disagree — but if you
want to see it with your own eyes, open **Advanced**. The first row inside is **Going to the cloud
right now**, with a green **ON** or a grey **OFF** on the right.

That is not a second switch and you cannot click it. Every other label on this screen tells you what
Ether means to do; this one reports what the backup machinery answers when you ask it. It is the one
line that can contradict the big switch, which is exactly why it is there.

If the big switch says off, this must say **OFF**. If it says **ON** while the switch says off,
something is wrong and it is worth reporting.

##### Audio arriving from your other computers

While **Keep my stuff synced** is on, Ether checks the cloud for new audio every few minutes and
downloads anything this computer does not already have. You do not press anything. A sweeper you cut
on the studio machine turns up on the on-air machine on its own, usually within a few minutes.

It only fetches what is missing, so the check costs almost nothing when there is nothing new. While
files are coming down, the Health Monitor says **"N files still arriving"** rather than reporting
them as missing — because they are not missing, they are on their way.

**The two directions are not the same, and it is worth knowing which is which.** Audio comes *down*
on its own. Audio goes *up* when you press **Send just the audio**. So after you import a batch or
record a voice track, send it — until you do, your other computers cannot know it exists. Preferences
→ Backup & Restore → **Advanced** spells both out under **Audio transfer**, including when the last
check ran and what it found.

##### Sending just the music

**Back up now** and **Finish sending** already include your music. To send the audio on its own, open
**Advanced** and press **Send just the audio**. If you're not sure an import made it, tick **Re-send
every file, even ones already uploaded** first, then press **Send just the audio**.

**WHERE YOUR AUDIO LIVES** (under **Advanced**) shows the folder Ether keeps your library in. **Change
folder** moves it. This is
also the folder your music lands in on another computer.

---

#### Setting up another computer

Install Ether, sign in with your email and password, and Ether offers to install your station from the
cloud. It pulls your setup first, then downloads your music, and tells you when to restart.

Everything comes from your account, so any computer you sign into can become your station. You don't move
files by hand.

**Make sure the first computer says "Everything on this computer is in the cloud"** before you set up
the second one.
If the music never finished uploading, the new computer gets a station it can't play.

---

#### Save a copy on this computer

**Save a snapshot** keeps a copy of your setup on this PC only — handy right before a big change so you can
roll back (Settings → Backup & Restore → **Roll back this computer**). Audio files aren't included, and it
doesn't protect you if the computer dies. It's a quick undo, not a backup. Snapshots older than 7 days
are removed automatically.

---

#### If a restore says the backup is damaged

You'll see: *"That backup file is damaged and was not used — your current station is untouched and still
running."*

**Nothing has happened to your station.** Ether checks a backup before it touches anything, so a bad file
is refused rather than half-installed. Keep working.

You may also see: *"The downloaded backup didn't save completely (X of Y bytes) — check free disk space
and try again."* The download didn't finish writing. A restore needs roughly three times the size of your
database free on the drive — for a 450 MB station, about 1.4 GB. Free some space and run it again.

If it keeps happening, back up again from the original computer so there's a fresh copy in the cloud, then
retry.

---

#### What each thing protects you from

| | Covers your setup | Covers your music | Survives the computer dying |
|---|---|---|---|
| **Back up now** (cloud) | yes | yes | yes |
| **Keep my stuff synced** (the switch) | yes | downloads only — send new audio up yourself | yes |
| **Send just the audio** (Advanced) | no | yes | yes |
| **Save a snapshot** | yes | no | no |

### Multi-Machine Sync

*Engineering view of sync between two Ether installs — station UUIDs, what is waiting to sync, whether the sync engine is running, and manual push/pull overrides.*

**Where:** Preferences → Backup & Restore → Advanced — sync diagnostics  
**Since:** 4.4.210

#### What it is

The engineering view of sync between two installs of Ether on the same account. It shows what is
**actually stored and running** — not what is supposed to be — and gives an engineer manual overrides
to force one sync cycle in either direction.

It sits in **Preferences → Backup & Restore**, below the cloud backup controls, under the heading
**Advanced — sync diagnostics**, because both answer the same question: is this machine's work safely
somewhere else. It is not needed in normal use.

#### When to use it

When two machines that share an account disagree — different libraries, different logs, or a
song deleted on one that is still present on the other.

#### Sync runs on its own once it is on

Sync is switched on and off with **Keep my stuff synced**, higher up on the same page (it needs a
Network licence). Once it is on, sync runs **continuously in the background** — pushing about every
10 seconds and pulling about every 30. Enable it once and leave it.

This panel does not switch sync on or off. It shows its state, and its buttons are **manual
overrides** for when a transfer has to land now.

#### Read this before you enable sync on a second machine

**Compare the station UUIDs on BOTH machines first** (press Preflight on each).

If the UUIDs do not match, UUID-based identity cannot merge the two installs, and continuous sync will
**mix the stations up rather than reconcile them — unattended**. That is a much worse problem than the
one you started with, and it affects both machines. Compare first, enable second.

#### What each reading means

- **This machine** — the stable machine id. It is here so you can tell the two dumps apart.
- **Stations — id ↔ UUID** — the comparison above. The number is this machine's *local* id and can
  legitimately differ between installs; the UUID is the one that must match.
- **Waiting to sync** — changes written on this machine that can go up and have not yet. Green at
  zero, amber otherwise, with a progress bar while there is a backlog.
- **Journal only** — shown only when there are some. Local-only records that never leave this
  computer. **Not a backlog** — nothing is stuck.
- **Sync engine** — whether the sync engine is actually running. It is only built when Ether starts,
  and only when sync is enabled *and* an account session and licence resolve. The stored setting
  (`sync_enabled`) is shown beside it, so "enabled but not running" is visible rather than confusing.
- **Ever received** — whether this install has ever taken in a single row **from** another machine.
  This is the reading people miss: an install can have nothing waiting and still have never received
  anything, which means it has never really been in a pair.

#### The controls

- **PREFLIGHT** — re-reads everything above. Changes nothing.
- **PUSH NOW** — forces one immediate push. Reports how many were sent, accepted and rejected, and
  the pending count **before and after**, so you can see the scale of what moved.
- **PULL NOW** — forces one immediate pull and reports how many mutations were applied.
- **Enable UUID-based station identity** — routes station-scoped rows by station UUID instead of by
  this machine's local integer id.

#### About the UUID toggle and the restart

The panel shows this setting twice on purpose: **Stored** and **in the running engine**.

The sync engine reads this flag **once, when it is built at startup**. So the moment you tick the
box, the stored value changes and the running value does not — and the panel says so in amber until
you restart. That is not a warning to be safe; the setting genuinely has no effect on any push or
pull until Ether is restarted. The same is true of **Keep my stuff synced**: the Sync engine reading
changes only after a restart.

**Quit Ether fully from the tray and reopen it.** A window reload is not enough, and the audio
daemon does not reload on its own.

#### Troubleshooting

- **"sync is not running on this install"** — the engine was never built. Check that **Keep my stuff
  synced** is on, that the machine is signed in with a licence that resolves, and that Ether has been
  restarted since you turned it on.
- **Push reports `sent: 0`** — there was nothing waiting. Check **Waiting to sync**.
- **A large Waiting to sync count, and "Ever received: never"** — this install has never synced in
  either direction. Nothing about deletions or any single table explains that; the engine is not
  running or has never successfully reached the backend.
- **A deleted song is still on the other machine** — check that the delete produced a mutation
  before assuming deletion is broken. On an installed copy of Ether, Preflight is the way to check:
  if **Ever received** says *never* and Waiting to sync is large, nothing has ever synced in either
  direction and no deletion-specific problem is involved. (On a machine with the source tree,
  `scripts/diag-song-delete-sync.js` gives the same answer in more detail. It is a local diagnostic
  and is not shipped with the app.)
  Note that deleting a song **never removes its audio from R2**; that is deliberate.

#### Related

- [Backup and Restore](help-backup-and-restore.md) — the cloud backup controls and **Keep my stuff
  synced**, above this section
- `docs/song-delete-sync-diagnosis-2026-08-14.md` — why this panel exists

---

## 9. Health & troubleshooting

### Health Monitor

*One screen that says whether the station is healthy — runway, levels, rotation, breaks and the event ledger — with panels you can rearrange and collapse.*

**Where:** Tools → System Health (pop-out window for a wall display: Tools → Monitors → Station Health)  
**Since:** 4.4.208

#### What it is

The Health Monitor is the **one screen that answers "is my station OK right now?"** It gathers every
measured reading EtherCast has — how much log is left, what the audio is doing, whether rotation is
hitting its targets, whether breaks are firing on time — and puts them in one place.

Everything on it is **measured, never assumed**. If a reading has not been taken, the panel says so
rather than showing a reassuring green. "Not measured" and "measured and fine" are different states
and they never look alike.

#### When to use it

- **Every morning**, as a thirty-second check before the day gets going.
- **When something sounds wrong** on air and you want to know what changed.
- **On a wall display** in the studio, left up all day. Pop it out into its own window
  (**Tools → Monitors → Station Health**) and full-screen it.

#### The top half — at a glance

Four cards across the top, then four panels below them.

- **Runway** — how many days of log this station has left before it runs out. Click it to open the
  Program Log.
- **Designated generator** — which machine builds this station's log. Click to jump to the controls.
- **Rotation health** — your declared rotation goals against what the clocks actually call. Click to
  open Schedule Manager.
- **Queue** — how many items are waiting behind what is on air, and roughly how much time that buys.

Below the cards:

- **Runway trend** — the last 7 days of runway as a chart, so you can see it falling *before* it
  becomes a problem. Gaps in the line are gaps in the data, not zeros.
- **Audio levels** — the decks in dBFS and the program loudness in LUFS. Two different measurements
  on two different scales, labelled as such.
- **Rotation goals** — one bar per category: the target you declared against what actually aired in
  the last 24 hours. If the station was only on air for part of that window, it says so.
- **Live events** — the health ledger, read back. What actually happened, newest first.

##### When a station shows "play refused" or "unplayable row skipped"

The station's card turns red for about a minute and names it — *play refused on deck B — <song> ·
17:33:12* — and the line stays under the card until the next one. It means the engine was asked to
play a deck that had nothing loaded (or a queued song whose file is missing) and **refused**, and
playout moved on to the next queued song instead. Nothing was aired from the refused deck.

- It is counted in **Library & Rotation → Skipped at load** (*N this hour*) (red on any skip) and written to the
  health ledger with the station, deck, song, file and time, so you can see it in **Live events** and
  find it later.
- One or two in a day after a re-cue is the engine protecting air. A run of them, or the same song
  every time, means a file is missing or a deck is being emptied and not re-cued — open **Live
  Activity**, filter **Warnings**, and read the lines around it.
- If the card says *unplayable row skipped*, the song's file could not be found on this machine:
  check the library entry and whether the file has been fetched from the cloud.

##### The station cards

Under the four panels, the live section shows **Engine** (uptime, restarts), **Stations (live)** — one
card per station — and **Level transitions**, the last 20 warning/critical changes.

##### The PGM meter on each station

Each station card has a thin **PGM** meter: the station's programme output after the MASTER fader — the
same meter as Master Out, laid on its side. Coloured bar = average level, white dot = peak, red end =
OVER, purple line = −18. **Hatched with no bar** means the meter is not connected (the engine is not
reporting that station), which is different from an empty bar (silence). See **Reading the Meters**.

##### The "audio engine" line under each station

Every station card ends with a line like *audio engine · underruns 0 · overruns 0 · lock misses 0*.
These are the audio engine's own health counts since it started, and **all three should read 0**.

- **Underruns** — a deck's player fell behind reading its file (for example a slow or sleeping disk).
  For that moment **only that deck goes quiet**; the song does **not** end, its time does not jump, and
  the next song is not started. The count is how you know it happened. A few after the computer wakes
  up is the disk spinning up; a steady climb means the music drive is too slow or too busy.
  (Each deck reads ahead into a 2-second buffer, topping it up whenever it falls below 1.5 seconds
  and checking every 20 ms. An underrun means the disk could not keep 2 seconds ahead.)
- **Overruns** — the sound card asked for audio and the engine answered late. You may have heard a
  tick. A climb means the computer is overloaded while on air.
- **Lock misses** — should always be 0. If it is not, write down the time and tell support.

When any of them goes up, the line turns **amber for a minute** and shows the time, and a line is
written to the health ledger (**Live events**) with how many and for which station. The totals stay
on the card after that, in grey. Hover the line for the full detail (callbacks run, silent frames).

#### The bottom half — the detail

- **Audio Processing** — the loudness chain. IN and OUT loudness lead as figures, then meters for the
  level before and after, the **ride gain** (which moves both ways from centre — right is boosting,
  left is cutting) and the limiter.
- **Spot Schedule** — where your breaks fall in this hour and the next. One lane per hour, so a
  marker's position across the lane **is** its minute. **Hollow markers are still to come, solid ones
  have aired.** The bright vertical line is now. Hover any marker for its exact times.
  Underneath, a **drift bar** per break: centre is on time, right is late. Green within 15 seconds,
  amber within a minute, red beyond. A break that is *going* to be late turns amber **before** it
  misses, not after.
- **Mic Inputs** and **PFL Output** — whether each mic and the headphone (PFL) output are working.
- **Spots that did not air** — breaks that were due and did not play.
- **Core Systems**, **High Availability**, **Library & Rotation**, **Designation Activity**, the
  **Log-Reader** panels and **DMCA Play Log Export** — the underlying detail behind the cards above.

##### High Availability — what the rows mean

- **Watchdog Process** — whether a watchdog (the "Keep My Station On Air" supervisor) is running.
- **Supervising This App** — whether that watchdog is actually watching **this** copy of Ether. The
  watchdog checks in every 5 seconds and signs its check-in; this row shows the last one. *Yes · pid N*
  is the only reading that means you are covered. *STOPPED* means it used to check in and no longer
  does. *Not observed* means no watchdog has ever checked in on this launch — either there is none, or
  it is from an older build that does not sign its check-ins.
- **Crash-Loop Alarm** — the watchdog gives up after 5 restarts in 5 minutes and leaves a marker on
  disk. The row shows **when** it tripped. While it is tripped, auto-restart is off — and if *Supervising
  This App* is not *Yes*, this copy of Ether is running with **no** supervision at all.
- **App uptime** in the header is how long the Ether process itself has been running (with its
  process id) — not how long this panel has been open.

##### Clearing a crash-loop alarm

1. Open the Health Monitor and find **Crash-Loop Alarm** under **High Availability**.
2. Press **CLEAR & RE-SUPERVISE**.
3. Ether removes the marker, stops the halted watchdog if one is still sitting there, and starts a fresh
   watchdog that adopts the running app. The row's small print reports exactly what happened
   (*marker removed · halted watchdog pid N stopped · supervised by watchdog pid M*).
4. Within a few seconds **Supervising This App** should read *Yes · pid M* and the banner should leave
   red. If it does not, the small print says why.

Nothing is restarted and nothing goes off air: the running app is adopted, not relaunched.

#### Rearranging the panels

Every panel below the four cards can be moved and hidden, so you can make the top of the screen show what
*your* station worries about.

1. **To move a panel**, click and hold its **header bar** — the strip with the title and the ⠿ handle
   — and drag it up or down. A green edge shows where it will land. Release to drop it.
2. **To collapse a panel**, click its **title** (or the ▾ arrow next to it). The panel folds down to
   just its header. Click again to open it.
3. **It sticks.** Your order and whatever you collapsed are remembered on this machine and come back
   next time you open the panel — you do not have to arrange it again tomorrow.

Two things worth knowing:

- **Drag by the header only.** The body of a panel holds real controls — switches, REFRESH NOW, the
  export button — so dragging from inside a panel would make those unusable.
- **Panels move only within their own group.** There are three: the four panels under the cards, the
  live Engine / Stations / Level transitions panels, and the detail sections below. You can reorder
  within a group, but not move a panel from one into another. **The four cards at the very top stay
  fixed.**

#### Putting it back

There is no "reset layout" button. To start over, collapse nothing and drag the panels back into the
order you want — or clear the app's saved settings for this machine, which resets the layout along
with other local preferences.

#### Troubleshooting

- **A panel says "not measured" or shows a dash.** That reading has not been taken yet for this
  station. It is not an error and it is not zero — give it a poll cycle (about 30 seconds).
- **Rotation goals says no goals are set.** Set **spins per hour** on a category in Categories. Until
  you do, the bars have nothing to measure against, so the panel tells you what is currently busiest
  instead.
- **Audio levels sit at the floor.** The meters read the live audio engine. If nothing is playing,
  they are correctly showing nothing.
- **Audio Processing says "off on both paths."** Loudness processing is switched off for this
  station, so quiet tracks stay quiet. Turn it on in Preferences if you want the ride and limiter.
- **I dragged a panel and it went back.** The drop only takes effect when you release the pointer
  **over another panel**. Release over the gap between panels and nothing moves.
- **The banner says ALARM but the station is playing fine.** The alarm is a marker left by a watchdog
  that gave up earlier (the row shows when). It does not mean the app is failing now — it means
  auto-restart is off. Read **Supervising This App**: if it is not *Yes*, press **CLEAR & RE-SUPERVISE**
  to put supervision back. If it *is* Yes, the marker is stale and the same button just removes it.
- **Live Activity shows hours-old lines and says STALE.** The feed is honest: the engine has not
  written anything for that long. If the station should be playing, look at the decks and the
  Audio Output row before assuming the feed is broken.

#### Related

- [Audio Processing](help-audio-processing.md) — the loudness chain itself, and its settings
- [Rotation Goals](help-rotation-goals.md) — declaring the targets the goal bars measure against
- [Designated Generator](help-designated-generator.md) — which machine builds the log
- [Live Activity](help-live-activity.md) — the running activity feed
- [Spots](help-spots.md) — scheduling the breaks the Spot Schedule projects

### Live Activity

*A running terminal in the Health Monitor showing what Ether is doing right now — every rotation, segue, stop, spot and warning, as it happens, per station.*

**Where:** Footer → the health status (NOMINAL when all is well) → Health Monitor → right-hand column  
**Since:** 4.4.107

#### What it is

**Live Activity** is a terminal that sits beside the health sections and shows you, line by line, what Ether's
automation is doing **right now** — which deck just went live, which song ended, when a stop was issued, when
a sweeper fired, when a spot went to air. It is the answer to "is it actually doing anything, and what?"

It reads the log the audio engine already writes. It is a **window, not a control** — nothing you do here
changes what is on air.

#### When to use it

- Something sounds wrong and you want to see what the engine just did.
- You want to confirm a station is rotating normally without staring at the decks.
- You're checking whether a spot or sweeper actually fired.
- You're on the phone with support and need to describe what's happening.

#### How to use it

1. Open the **Health Monitor** — click the health status in the bottom-right footer. It reads **NOMINAL**
   when all is well, and **WARN**, **ERROR** or **ALARM** when something needs a look.
2. The terminal is the **right-hand column**. On a narrow window it moves **below** the health sections
   instead.
3. Watch it. Newest lines appear at the bottom and it scrolls itself.

##### Choosing what you see

Three buttons across the middle:

- **Decisions** *(the default)* — only the moments something changed: a deck went live, a song ended, a stop
  was issued, a sweeper or spot fired, automation started or stopped. This is what you want almost always.
- **All activity** — everything, including the engine's four-times-a-second heartbeat. Useful for deep
  troubleshooting, very noisy otherwise.
- **Warnings** — only things worth a second look: a stall, a forced stop, a safety guard firing, a station
  running behind its schedule.

##### Watching one station

The row of buttons above — **All**, plus one button per station that has appeared in the feed (**s1**, **s2** …)
— filters to a single station. Each station also has its own colour, so you can pick one out at a glance
without filtering.

##### Reading without it jumping

Click **Pause** to freeze the view. **Scrolling up also pauses it automatically** — so you can read a line
without the feed yanking you back down. The green dot goes grey while paused.

Click **Resume** to jump back to live. **Nothing is lost while paused** — activity keeps being collected in
the background and appears when you resume.

#### What the lines mean

Each line is: **time · station · what happened**.

| You'll see | It means |
|---|---|
| `segue: deck B LIVE — <song>` | That song just started on deck B — it is what's on air. |
| `deck A ended` | The song on deck A finished. |
| `advance → stop:A` | Deck A was stopped and cleared after handing over. |
| `segue overlap: A→B` | The next song started early over the tail of the last one — a normal segue. |
| `clean spot edge` | A commercial is playing on its own, with no overlap. That's deliberate. |
| `jingle FIRING on …` | A sweeper is playing over the seam. (The engine's log still calls it a jingle.) |
| `top-of-hour HARD CUT` | The top of the hour arrived and the schedule was re-synced to the clock. |
| `liveDeck GUARD — TWO DECKS ON AIR` | **Two songs are playing at once.** Report this. |
| `watchdog: STALL` | Nothing was playing and the engine forced a recovery. |
| `resume-playout: deck B REFUSED by the engine` | The recovery tried deck B but the deck had nothing loaded, so the engine refused to play it. **Nothing went to air from that deck** — the recovery moves on to the next queued song on deck A. Shown in red under **Warnings**; it is also counted in the Health Monitor (see *Library & Rotation* → **Skipped at load · N this hour**, and the station's red line). |
| `[RUST] Play deck B: REFUSED — no content loaded` | The audio engine's own line for the same refusal. |
| `LOG-READER: behind Nm` | The station is running later than its log; the rows it skipped past were marked missed. |

#### Good to know

- The terminal keeps roughly the **last 800 lines**, then drops the oldest. It is not an archive — for the
  permanent record use **Export Play Log CSV** further down the Health Monitor.
- If it says *"Waiting for activity from the audio daemon…"*, the audio engine may not have started yet.
  Give it a moment after launching Ether.
- After an update, **fully close and reopen Ether** — the audio engine does not reload on its own, so its log
  won't restart until you do.
- Empty with a filter on? Switch to **All activity** to confirm the feed is alive.

##### Which file it is reading, and how fresh it is

Under the line count the terminal names the **log file it is following** and **when that file was last
written** — for example *following …\Ether\logs\ether-audiod.log · last write 4s ago*.

- The audio engine tells Ether where it is writing, so this is the engine's own answer, not a guess.
- If the file has not been written for **10 minutes** the line turns red and says **STALE**. Old lines
  on screen are then old lines — the engine is not busy, it is quiet (or not running).
- *"path not confirmed by the daemon"* means the running engine is from an older build that does not
  report its file; Ether falls back to the most recently written engine log. After you **fully close and
  reopen Ether** the new engine reports its path and the note goes away.
- If the engine restarts into a different file, the feed says *— now following … —* and continues from
  the new file's tail.

### "Warning: the audio engine is running an older build"

*What the amber bar at the top of the screen means, why closing the window is not enough, and why some readings may say UNKNOWN until you restart.*

**Where:** Appears by itself at the top of the screen when it applies  
**Since:** 4.4.178

#### What you are seeing

An amber bar across the top of the screen:

> ⚠ The audio engine is running an older build (engine v…, app v…) — **fully close and reopen
> Ether**. Until then some readings may be missing or out of date.

#### Why this happens

Ether is two programs. The **app** is the window you are looking at. The **audio engine** is a
separate program that keeps playing whether or not the window is open — that is deliberate, and it is
why closing the window never takes you off the air.

When Ether updates itself, the window gets the new version. **The audio engine does not** — it is
busy playing, and swapping it mid-song would put dead air to air. So it keeps running the old build
while audio is playing.

If nothing is playing, Ether replaces the engine by itself after a few seconds of silence. While
anything is on air it waits — it will not cut your audio to update itself.

Most of the time the two builds agree and you never see this bar. When they do not, you get told.

#### What to do

If you do not want to wait for a quiet moment:

1. Finish or hand off what is on air — this restarts the audio.
2. **Fully close Ether.** Not just the window: quit it from the tray icon as well, so the audio
   engine stops too.
3. Open Ether again.

The bar disappears on its own once the engine matches. There is nothing to dismiss and nothing to
click — it is a statement about your system, not a notification.

> **Closing only the window is not enough.** The window and the engine are separate programs; the
> engine survives the window closing. That is the entire reason this bar exists.

#### Is anything wrong with what is on air?

**Probably not.** A mismatched engine usually plays exactly as it should. The risk is not silence —
it is that the *screen* may not be able to tell you the whole truth, because a newer app can ask the
older engine for things it does not know how to answer.

That is why the bar says *some readings may be missing or out of date*.

#### Why a reading says UNKNOWN

Where the app needs something the running engine cannot supply, it says **UNKNOWN** rather than
showing a number.

That is on purpose, and it is the safer of the two options. A confident-looking figure that is
actually a stand-in cannot be questioned — it looks like fact. UNKNOWN can be questioned, and it
points at this bar. If a reading you rely on says UNKNOWN, restart as above and it will come back.

The bar itself follows the same rule: if the engine is old enough that it cannot even report its own
version, it says **version unknown** instead of printing a number nobody can stand behind.

#### What it does NOT mean

- **It is not a crash**, and it is not dead air. Your station is playing.
- **It is not an update prompt.** Updating again will not clear it — only a new engine will: either
  the automatic swap during silence, or a full close and reopen.
- **It is not permanent.** One full close and reopen resolves it.

#### Related

**Health Monitor** — the same event is written to the health ledger as `daemon-version`, once when
it starts and once when it clears, so a support look-back can see exactly when the mismatch began.

---

## 10. Tools & windows

### Windows — everything opens beside the live screen

*Every destination in the ≡ menu now opens in its own window instead of covering the mixer, so you never lose sight of what is on air.*

**Where:** ≡ (top-left) → NAVIGATE  
**Since:** 4.6.20

#### What it is

The **≡ menu** used to have two lists. The top one, NAVIGATE, **replaced the live screen**: click Library
and the mixer went away. The bottom one, WINDOWS, opened the same places in **their own window**, beside
the mixer. Same destinations, two different behaviours, and the one you got depended on which list you
happened to use.

There is now **one list**, and **everything on it opens in its own window**. Clicking Library, Schedule,
Imaging, the Program Log, Play Log, Carts, Decks — any of them — leaves the live screen exactly
where it is. Decks keep spinning, levels keep moving, ON AIR stays in front of you.

**Why it works this way:** you should never have to close something to see what is playing.

#### When to use it

Any time you need to work on something while a show is on. That is most of the time.

#### Open a window (≡ → NAVIGATE)

1. Click the **≡** button, top-left.
2. Click any entry in the list — **Library**, **Schedule**, **Imaging**, **Program Log**,
   **Play Log**, **Schedule Manager**, **Rotation Analytics**, **Carts**, **Decks**, **Processor**,
   **Shows**, **Categories**, **Jukebox**, **Show+**, **Show+ DAW**, **Desk**, **Now Playing**, **Phone**.
3. It opens in its own window. The menu closes. **The live screen stays put.**
4. Click the same entry again and the window you already have **comes to the front** — you never end up
   with two Libraries.

Close a window the normal way (its X, or Ctrl+W / Cmd+W) — closing it never touches audio.

#### Where a window lands

**Two monitors:** the window opens on the **second monitor**, out of the way entirely.

**One monitor:** the window opens in the **right-hand portion of the screen, below the top strip** — so
the station name, the clock, the ON AIR state and the left column stay visible behind it. Open a second
window and it steps down and left a little so it doesn't land exactly on the first.

**Move it wherever you like.** Ether **remembers each window's position and size** and puts it back there
next time you open it. If you drag Library onto a second screen and size it, that is where Library opens
from then on.

#### The star

An entry you have opened three or more times gets a **★**. That is just a usage marker — the entries you
actually reach for, easy to spot in the list.

#### What did not change

- **The mixer.** Nothing opens on top of it, and no menu entry takes it away.
- **Your audio.** Opening, moving or closing a window never touches a deck. Esc still never kills audio.
- **The bottom bar.** The bottom-bar buttons behave as they always have.
- **Settings**, and **Live Captions**, still open in the main window (see below).

#### Live Captions is the one that still takes over the screen

**Live Captions** stays in the main window rather than opening beside it. That is deliberate, not a
leftover: captions listen to a **live microphone**, and a second window running its own copy would try to
open the same microphone twice — which fails, and which would leave the two windows disagreeing about
whether captions were even on. When the listening moves out of the window, Live Captions will open like
everything else.

Use **Return to Mixer** at the top of the ≡ menu to come straight back to the live screen.

#### If you unplug the monitor a window was living on

Nothing to do — Ether checks the remembered position against the screens you actually have. If the
monitor it was on is gone, the remembered position is ignored and the window opens on your main screen
in the normal place. Move it back and it is remembered again.

#### The Decks window is the real board

**Decks** opens **the same board the live screen shows** — its channels with their source dropdowns,
DUCK, meters, ON and PFL, the **+** on the right edge for adding a channel, and the master output. Not a
copy of it: the same one.

**What that means in practice:** anything you change in one place shows up in the other. Add a
channel with **+** in the Decks window and it appears on the live screen. Re-dial a source, turn a
channel ON or OFF, arm DUCK — the two always agree, because there is only one board underneath.

**Your ON buttons are remembered.** A channel you switch off stays off through a restart.

#### Also in the ≡ menu

Below the windows, the ≡ menu also holds **Live Captions** (see above), **Theme Studio** and
**Reset Layout**.

#### Related

- `help-live-activity.md` — the live screen itself
- `help-imaging.md` — the Imaging window
- `help-logs.md` — the Play Log window
- `help-schedule-manager.md` — the Schedule Manager window

### Jukebox (public request wall)

*A fullscreen wall of album art the public can browse and request from — each request shows the requester's name and its place in line.*

**Where:** ☰ menu (top right) → Jukebox  
**Since:** 4.4.156

#### What it is

A **second window** you point at a screen the public can see — a wall of big album covers they can
browse, search and pick from. Someone taps a cover, types their name, and their song joins the queue.
The queue is on the right of the screen with each person's **name** and their **place in line**, so
everyone can see their song coming.

You choose exactly what the public may pick from: you tick **categories** in Settings, and their songs
are the whole pool. Nothing else in your library is reachable from the jukebox.

#### When to use it

An event, a bar, a park night, a lobby — anywhere the audience picks the music and staff are nearby.
It is a **display**, not a control surface: nothing on the jukebox screen can change your station's
settings, edit your library, or stop what is on air.

#### Set it up (two minutes)

1. **Choose the music the public can pick.** In the main window open **Settings → Programming →
   Jukebox**. You'll see every category on this station with the number of playable songs in each.
   **Tick the ones you're happy for strangers to choose.** It saves as you tick — there's no Save
   button for the ticks.
   - The count under the list is the real pool ("1,284 songs across 4 categories"). Songs whose file
     isn't on this machine are **left out on purpose** — a request that can't play would be dead air
     in front of an audience.
   - A category showing **"no playable songs"** has nothing the jukebox can use. Ticking it adds nothing.
2. **Name your request page.** In the same place, type a short name into **Request link (QR)** and
   press **Save** — e.g. `party` gives your guests
   **listen.ether-technologies.com/jukebox/party**. Letters, numbers and dashes; the Jukebox builds
   the full address and turns it into a QR code big enough to scan from across the room. Leave it
   empty and the Jukebox simply doesn't show a code.
   - Type a **name**, not a web address. A bare word on its own is not a link — the app adds the rest.
     (If you'd rather paste a full `https://` address, that works too and is used exactly as given.)
   - Guests who scan the code can request from their **phone**. Their requests join the same queue,
     under the same rules, as requests typed at the jukebox screen.
3. **Patch it into a deck.** On the dashboard open the deck configurator and set the source of
   **deck D, E or F** to **Jukebox**. That is the jukebox's channel on your board — bring the fader up
   and it is on air, exactly like a microphone.
   - Only D, E and F are offered on purpose. Automation runs decks A, B and C, so a jukebox deck is
     one your scheduler never touches. Your log, your AUTO/MANUAL state and your clocks are unaffected.
4. **Open the display.** Click the **☰ menu** at the top right → **Jukebox**. It opens as its own window, **fullscreen**, ready to face the public.

#### Using it

- **Browse** — scroll the wall. Covers load as you go.
- **Where the covers come from.** Ether uses the artwork stored **inside your music files** first —
  that is instant, works offline, and is always the art you tagged. For tracks with no embedded cover
  it looks the artwork up **once** from the iTunes catalogue and keeps a copy on this machine, so it
  never has to ask again — including after you close and reopen the window.
  - On a big wall the first run fills in **gradually** rather than all at once. That is deliberate:
    lookups are paced so Ether stays a polite visitor to Apple's service. Tiles without art yet show
    the tinted cover with the song title, never an empty square.
  - A track that genuinely has no cover anywhere is asked about **once** and then left alone.
- **Search** — type in the box at the top. Results narrow as you type; there's no button to press.
- **Request** — tap a cover, type a name, press **PLAY NEXT**. The song joins the queue and the person
  sees their name appear on the right.
- **The strip across the top** shows **NOW PLAYING**: the album artwork on the left, and beside it the
  name, song and artist of what is on the deck right now. The search box sits just below it, and the
  wall of covers below that.
- **The whole right-hand column is the queue** — that is where people look for their name, so it gets
  the room:
  1. **UP NEXT** at the top, drawn larger. If someone is waiting, it is their request; if nobody is, it
     is the song the jukebox has already chosen for itself.
  2. **Everyone waiting behind that**, numbered #2, #3, #4… in the order they arrived.
  As songs play, the column climbs — each person moves up until they are UP NEXT, then on air.
- **Every entry looks the same** — three lines, always in this order: the **person's name**, the
  **song title**, then the **artist**. When the jukebox picked the song itself rather than a person
  requesting it, the name line reads **Unknown** — that is normal, not a fault.
- Requests play **in the order they arrived**, and a request **never cuts a song that is already
  playing** — it starts when the current one finishes.
- **One song at a time per person.** Someone with a request still waiting is told *"You already have …
  waiting"* and can pick another once it has played. A song that played recently can't be requested
  again straight away — the jukebox says roughly how many minutes to wait.
- **Operator controls are off the public face.** Routing ("which deck this jukebox feeds"), the ON AIR
  lamp and the AUTO switch live behind the small **OPERATOR** button at the right of the top strip.
  Click it to open them; it stays shut otherwise, so the public sees a jukebox and not a console. The
  button's dot turns **amber** when something needs attention (not routed, channel off, or fader down),
  so staff can spot a problem without the room being told about decks and faders.
- **AUTO** (behind the OPERATOR button) is the **jukebox's own** AUTO and has nothing to do with the
  station's AUTO/MANUAL:
  - **AUTO ON** — between requests the jukebox keeps music going, shuffled from the categories you
    ticked. A request plays as soon as the current song ends.
  - **AUTO OFF** — only requested songs play. When the queue empties it goes **silent**, on purpose.
- **ON AIR** appears when the jukebox deck is actually playing and its fader is up. It reflects the
  board, not the AUTO button — AUTO on with the fader down is not on air, and the window says so.

#### Moving and closing the window

- **Escape** leaves fullscreen so you get the normal window bar back. **F11** puts it back to
  fullscreen. Escape never stops audio and never closes the window.
- Close it like any window when the night is over. Closing the jukebox does **not** stop your station.
- Drag it to a second monitor and it remembers where you put it.

#### What it does to what's on air

**You decide, at the fader.** The jukebox is a source on its own deck; its audio reaches air only when
that channel is up. It never adds anything to the station's queue, never changes your clocks, rotation
or scheduling, and never touches your AUTO/MANUAL state.

It is an **event tool**, not playout: it airs music only — no commercials, no traffic, no spots, ever.
If you need those, they stay on your normal station decks.

Jukebox songs **are** written to Play History like any other deck play, marked as jukebox plays so you
can tell a public pick from rotation.

#### If something looks wrong

- **"The jukebox isn't set up yet"** — no categories are ticked. Settings → Programming → Jukebox.
- **"No station selected"** — this install has no active station. Sign in and pick a station in the
  main window, then reopen the jukebox. The jukebox will never guess a station for you.
- **The wall is empty but categories are ticked** — the ticked categories have no songs with playable
  files on this machine. Check Settings → Audio → Catalogue Folder & Sync.
- **"The queue is full right now"** — the number of waiting requests hit the cap. It clears as songs
  play. The cap (12 by default) and how soon a song can come round again (60 minutes by default; 0
  allows it straight back) are set in **Settings → Programming → Jukebox → Request limits**, then
  **Save**. They apply to phone requests and the jukebox screen alike.
- **"Not routed to a deck"** — no deck has Jukebox as its source. Set deck D, E or F to Jukebox.
  Requests keep being collected in the meantime.
- **"The fader is down"** — the jukebox is patched in but its channel is not up, so nothing is
  reaching air. The queue keeps filling; bring the fader up when you want it heard.
- **A song won't queue twice** — if it's already coming up, the jukebox says so rather than stacking
  duplicates.

#### Donations (optional)

In **Settings → Programming → Jukebox → Donations** you can connect your organisation's own Stripe
account. The money goes to your Stripe account — Ether takes no cut. The panel shows what Stripe still
needs before it can accept donations. Once connected, pick one:

- **Don't ask for anything** — requests are free.
- **Ask for a donation — the song plays either way** — guests are invited to give after requesting;
  nobody is turned away.
- **Require payment before the request goes through** — a sale, not a donation. Until Stripe can take
  payments, requests go through free.

#### Not included yet

- **Paying to skip the line.** Requests are strictly first-come, first-served, paid or not.

### Cut and send from the Show+ DAW

*Bring a file into the Show+ DAW, cut the piece you want, and send it straight to the Library, a sweeper pool, or a deck — in its own window beside the live screen.*

**Where:** ≡ Menu → Show+ DAW · Tools → Show+ DAW in the menubar · Library → right-click a track → Send to Studio  
**Since:** 4.4.74

The Show+ DAW is where you produce audio: bring a file in, cut the piece you want, and send it
straight to air or your library — **quick import, chop, send to the Library, a sweeper pool, or a deck.**

#### Open it — its own window

The Show+ DAW opens as its **own separate window**, not a takeover of the main screen — so your decks,
meters, Station Health, and queue stay fully visible and live while you produce. Open it from:

- **≡ Menu → Show+ DAW**, or **Tools → Show+ DAW** in the menubar, or
- **Library → right-click a track → Send to Studio** (opens the DAW and drops that track in).

Drag it to a second monitor if you have one. The window **remembers its size and position** for next
time. Closing it is safe — but if you have **uncommitted regions** (audio loaded that you haven't sent to
a deck, the Library, or a pool yet), it **warns you before closing** so you don't lose your work. The
send exits work from this window exactly as they do inline — → Deck loads the real deck, → Sweeper and
→ Library file into the active station.

#### Import audio

Two ways to get audio into the DAW:

- **Drag & drop** — drop an audio file (or several) from your computer onto a track lane. The first lands
  where you drop it; extras land on new tracks below.
- **＋ Import** (top toolbar) — pick one or more audio files. Each opens on its own track.

#### Chop — pick the piece you want

1. **Double-click the region** on the timeline to open it in the **Editor** (the large-waveform drawer at
   the bottom; you can also toggle it with **Editor ⤒**).
2. **Drag the trim handles** (the two bars at the left and right edges of the waveform) to frame exactly the
   part you want to keep. The shaded areas are trimmed off.
3. **▶ Audition** (in the Send bar) plays just your selection so you can hear it before you send. It plays
   on the DAW only — **nothing goes to air while you audition.**

#### Send — three exits

The **Send selection** bar sits under the waveform. Name your cut (click the name to edit), then choose an
exit:

- **→ Library** — imports the cut as a normal library song.
- **→ Sweeper** — pick a **pool** (or leave it **— unassigned —**), then press **Send to Sweepers →**. The
  cut is imported as a sweeper and, if you picked a pool, filed in it.
- **→ Deck** — then pick **A**, **B** or **C** to load the cut straight onto that deck, ready to fire. A deck
  that's playing is protected — the send is refused and it won't be interrupted.

Every send renders your trimmed selection to a real audio file first, so what lands in the library or on
the deck is exactly what you framed.

#### Notes

- The same cut-and-tag engine powers the **Reel Splitter** (the SWEEPERS push-up → **ADD IMAGING — CUT A
  REEL**). One engine, two places — a cut behaves the same wherever you make it.
- Sweepers you send here appear in the SWEEPERS panel's pools and are eligible for automatic seam
  placement, exactly like ones cut in the Reel Splitter.

#### Related

- **Sweepers** ([Sweepers](#sweepers)) — pools and category assignments.
- **Reel Splitter** ([Reel Splitter — cutting a sweeper reel](#reel-splitter--cutting-a-sweeper-reel)) — cutting a whole reel into tagged pieces.
- **The Smart Tool** ([The Smart Tool (Show+ DAW)](#the-smart-tool-show-daw)) — editing clips on the timeline.

### The Smart Tool (Show+ DAW)

*The pointer picks the gesture from where it sits on a clip — trim at the edges, cursor up top, move down low, fade at the corners — so editing no longer means switching tools first.*

**Where:** Show+ DAW → the edit-tools row above the timeline (SMART is the default)  
**Since:** 4.4.223

#### What it is

Editing a clip used to start with a detour: pick **Trim**, drag, pick **Grab**, drag, pick **Fade**,
drag, then remember to go back to **Select** before clicking anything else. Four decisions before the
first useful one.

The **Smart Tool** removes that. It reads **where on the clip your pointer is sitting** and offers the
gesture that belongs there. Move toward a clip edge and it becomes a trim. Slide into the top half and
it becomes a cursor. Drop into the bottom half and it becomes a grab. Ride into a top corner and it
becomes a fade. **The cursor changes before you click** — so the clip tells you what a drag will do
while there is still time to change your mind.

Smart is **on by default**. There is nothing to turn on.

#### The zones

Picture a clip as a small map. Six places, six gestures:

| Where you point | What you get | Cursor |
|---|---|---|
| **Left or right edge** (a thin strip) | **Trim** — drag the clip's start or end | ↔ |
| **Top half, middle** | **Cursor / I-beam** — click to drop the playhead for a precise cut | I-beam |
| **Bottom half, middle** | **Grab** — drag the clip anywhere, including to another track | hand |
| **Top-left corner** | **Fade in** — drag right to lengthen | corner arrow |
| **Top-right corner** | **Fade out** — drag left to lengthen | corner arrow |
| **Bottom corner where two clips meet** | **Crossfade** — drags both sides of the joint at once | ⇹ |

A small white marker paints the zone you're hovering, so the affordance is visible as well as felt.

The crossfade corner only appears **where a neighbouring clip actually meets this one**. On a clip with
open space either side, that corner is simply a trim like any other edge.

#### The one modifier

**Hold Alt while dragging an edge** to *trim with a fade* — the clip's start or end moves, and a fade is
laid over exactly the amount you trimmed away. One drag instead of two.

That is the only modifier. **Ctrl does nothing here** — Ctrl is the timeline's zoom, and a tool that
stole it would break zooming. If you were taught a Ctrl+drag shortcut in an earlier build, it is gone
on purpose.

#### Try it once

The whole thing in a single motion:

1. Open **Show+ DAW** and load a clip onto a track.
2. Put the pointer on the clip's **left edge** — the cursor becomes a trim arrow.
3. Slide right into the **upper middle** — it becomes an I-beam.
4. Slide **down** — it becomes a grab hand.
5. Slide up into the **top-right corner** — it becomes a fade.

Four gestures, one slide, no toolbar. That is the feature.

#### When you want the old way

The five named tools are still there, and they still win when you pick one:

**Select (V) · Grab · Splice · Trim (T) · Fade (F)**

Click one and it applies everywhere on every clip, exactly as before — useful when you're doing one
thing fifty times and don't want the pointer making decisions for you.

**To get back to Smart:** click the active tool a second time, or press its key again (press **T**
while Trim is lit and you're back to Smart). The **Smart** button at the left of the row does the same
thing and shows you which mode you're in.

##### Known issue

**G** and **C** do not pick Grab and Splice: **G** turns snap on and off, and **C** splices the
selected clip at the playhead. Click the **Grab** and **Splice** buttons in the row instead.

#### Undo

Every gesture is **one undo**. A drag that lasted two seconds and repainted forty times still steps
back with a single **Ctrl+Z** — it does not walk backwards through the drag a pixel at a time. A click
that never travelled leaves no undo entry at all.

#### Notes

- Shift-click (or Ctrl-click) a clip still **multi-selects** rather than starting a drag.
- Double-click still opens the clip editor.
- On a very short clip the zones shrink proportionally so a narrow clip never becomes all corner and
  no body — you can always reach its middle.
- If two clips **overlap**, Show+ may also apply its own automatic crossfade over the overlap. It only
  ever lengthens a fade, never shortens one you set by hand.

### Park Ops — the closing time, from any phone

*A web page for the person walking the park — what's on air, today's announcements, and the closing time, editable from the floor. Works from anywhere, on any connection.*

**Where:** park.ether-cast.com/<your-station-slug>  
**Since:** 4.4.232

#### What it is

A web page that answers the three questions the person on the floor actually has at 9pm:

- **What's on air right now?**
- **What is the park about to announce, and when?**
- **What time are we closing tonight — and can I change it from here?**

It opens in an ordinary phone browser. Nothing to install, no login, no app.

#### The address

```
park.ether-cast.com/<your-station-slug>
```

For HalloVeen that is **park.ether-cast.com/halloween** — the same slug the public listener page uses
at `listen.ether-technologies.com/halloween`.

**The page is hosted, so the address always works.** It does not matter whether the studio machine is
switched on, whether Ether is running, or whether the station is on air. If the station is dark the
page still loads and tells you so. You can bookmark the link, text it to staff, and it will not go
stale.

#### Two versions of the link

| Link | Who it's for | Can change the closing time |
|---|---|---|
| `park.ether-cast.com/halloween` | anyone — post it, share it freely | No |
| `park.ether-cast.com/halloween?k=…` | whoever runs the park that night | **Yes** |

The part after `?k=` is an access token. It unlocks the closing time and nothing else — it cannot
touch the music, the log, or any other station. Reading is open on purpose: if someone's phone drops
the query string they should still see the closing time, not an error.

**Where to find your link:** the studio machine prints both versions in its log when Ether starts:

```
[ops] Park Ops (editable): https://park.ether-cast.com/halloween?k=…
[ops] Park Ops (view-only): https://park.ether-cast.com/halloween
```

There is not yet a screen inside Ether that shows this link. That is a known gap, written down in the
backlog — for now, copy it from the log.

#### Using it

1. **Open the link on the phone.** The station name is at the top.
2. **Now playing** — what's on air. If the station isn't running it says so rather than showing
   something stale.
3. **Announcements · today** — everything scheduled for today, in order, each with its time. One
   marked **already played** has fired.
4. **Park closes** — tap it, set the time, save.

#### The notes beside a row

If something looks wrong the page says so **in a sentence beside the row** — it never refuses your
change. You may know something the rule does not: a ride broke down, the fireworks ran late.

You'll see a note when:

- An announcement is **more than six hours** from the closing time — usually a sign the closing time
  itself is wrong.
- An announcement with **"closing" in its name** is due while the park is open for a good while yet.
- **Two announcements sit within a minute** of each other.

Read it, then do what you were going to do.

#### What this version does NOT do yet

Be clear on this, because the page shows times that look live:

- **Times marked "preview" are previews.** Where an announcement is set relative to closing ("20
  minutes before close"), the page shows what it *would* fire at under the closing time you've set.
  **The station still fires the fixed time stored on the announcement.** Changing the closing time
  here does not yet move when those announcements actually air.
- **Changing the closing time sets the station default.** Per-date and per-weekday closing times
  exist in the stored data but aren't editable from this page yet.
- Nothing here starts, stops, or reorders audio. It cannot take the station off air.

#### If the closing time is saved while the studio machine is off

It still lands. The change is held and delivered to the station the moment it comes back online. The
page shows the new time immediately either way.

#### Troubleshooting

**"No park at this address"**
The slug in the URL doesn't match a published station. Check the link, and check the station has a
public page configured in Ether.

**"This station isn't reporting"**
The page loaded fine, but Ether hasn't sent anything for this park yet — the studio machine hasn't
run since Park Ops shipped, or isn't signed in. It fills in on its own once the machine is running.

**"Can't reach Park Ops"**
Your phone's connection, not the park's. The page keeps showing the last update underneath.

**"View only"**
You're using the link without the `?k=` token. Get the full one from the studio machine's log.

#### Related

- Announcements and their schedule: the **Announcements** panel in EtherCast.
- The public listener page for the same station: `listen.ether-technologies.com/<slug>`.

