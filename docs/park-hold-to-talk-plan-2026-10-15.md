# Park page "Hold to talk": plan and mock (2026-10-15)

Nothing is built. This is the plan, for approval.

## Jeff (verbatim)

> Also start the "Hold to talk" plan now (the staff idea: hold a button on the Park page, talk into the phone's mic, it plays over the park speakers). Plan and mock only, don't build: how it uses the Listen relay in reverse, delay, music ducking under the voice (settings visible), input limiter, feedback/echo handling, maximum talk time (setting), logged-in only, blocked by the studio lock, who/when logged in Ether, two people pressing at once, iPhone/Android mic permission. Tell me what's needed to turn on the relay (the Lightsail ports) so both Listen and Hold to talk can go live.

Mock: `hold-to-talk-mock.html`, published separately. It has a state switcher for:
- the phone: idle, connecting, talking, busy, locked, mic blocked;
- Ether: Preferences → Park page — Hold to talk, and the who/when line by the strip.

## Governing docs and what they decide

- **`docs/park-listen-plan-2026-10-13.md`.** Listen built the relay:
  - MediaMTX on the stream server takes RTSPS on :8322 and WebRTC (WHEP) through nginx 443 → 8889, with media on UDP+TCP 8189.
  - Every publish and read is checked by `ether-backend` `/internal/mediamtx/auth`.
  - **Hold to talk is the same relay, run in reverse.** No new server program and no new ports.
- **`docs/aux-channel-ducker-announcements-design-2026-08-21.md`:**
  - Phase 2: the **PCM-in path** puts samples from somewhere other than a file onto a source channel. The ducker "triggers on source-channel audio regardless of where the samples came from".
  - The talk voice is the first network feeder for that path. It is not a one-off.
- **Faders are generic** (project rule). The voice arrives as a normal **source** that the operator patches on any source fader. DUCK, room level, ON and the channel rack all apply to it as to any source. Nothing is a dedicated "talk deck".
- **MONITOR is master of all local output** (project rule). The voice reaches the park speakers through the source fader's room (aux) level × MONITOR. A muted park therefore mutes the voice too: same rule, no exception. (Question 3.)

## How it works: the Listen relay, in reverse

```
Listen (built):  Ether engine ─► ffmpeg (Opus, RTSPS publish :8322) ─► MediaMTX ─► WebRTC ─► phone plays
Talk  (plan):    phone mic ─► WebRTC publish (WHIP, UDP/TCP 8189) ─► MediaMTX ─► ffmpeg on the station (RTSPS read :8322)
                 ─► 127.0.0.1 port ─► engine PCM-in ring ─► the source fader patched to "Park talk" ─► room level × MONITOR ─► park speakers
```

1. **Press.** The page asks `POST /public/ops/:slug/talk`. The server checks three things, then hands out a **talk ticket** and the WHIP address:
   - the staff member is logged in;
   - the studio lock is off;
   - nobody else is talking.

   It tells the owning station `park:talk on` with a lease. This is the same aiming and lease pattern as `park:listen` (`ether-backend src/index.js:6017-6033`, `lib/park-listen.js`).
2. **Phone sends.** The phone publishes its mic to MediaMTX path `park/<station>/talk` with WHIP, using the ticket. MediaMTX asks `/internal/mediamtx/auth` (`index.js:6085-6096`), which gets a new `talk` case.
3. **Station receives.** The daemon starts one ffmpeg that reads `rtsps://…:8322/park/<station>/talk` with a station read token. It decodes Opus to the engine's own format (f32le, 44.1 kHz) and writes to a local port. This mirrors `audiod/listen.js`, which publishes the other way.
   - The engine pulls from that port into a source slot through a ring: `try_pop` on the audio thread, never a wait. This is the same safe pattern as the Listen and stream taps (`park-listen-plan` §What Ether has today).
4. **Release.** The page stops publishing and calls `/talk/stop`, and the station is told `park:talk off`.
   - If the page vanishes, the ticket lapses on the server and the station's lease stops the receiver by itself.

**What Ether needs that does not exist:**
- the engine **PCM-in source path** (Phase 2 deliverable 1; the `network` kind is a placeholder today, `src/lib/sourceKinds.ts:58-59`);
- a source kind **"Park talk"**;
- the daemon receiver.

Remote Link already decodes Opus into a source channel (`native/src/link.rs`), but over its own sealed UDP wire. It cannot read from MediaMTX, so the ffmpeg receiver is the simpler path, and it matches Listen.

## Delay

**Estimate, NOT MEASURED:** about **0.3–0.7 s** from mouth to park speaker.
- phone capture + Opus 20 ms frame: ~40–60 ms;
- phone → Lightsail over 4G/5G or Wi-Fi: ~30–100 ms;
- MediaMTX forwards (no transcoding);
- Lightsail → the park machine: ~20–60 ms;
- ffmpeg read buffer (`-fflags nobuffer`, as Listen): ~50–200 ms;
- engine ring + device buffer: ~20–60 ms.

Listen's local rig measured 152–157 ms one way with no internet in the path (`park-listen-plan` §Local delay).

**Measured the same way after building:** a beep from the phone, matched against Ether's output.

The phone shows **TALK NOW** only once the station reports that voice is arriving. So the first words are never lost to the connection time, which can be ~0.5–1.5 s.

## Music under the voice (ducking): every number visible

- Patch "Park talk" on a source fader with **DUCK ON**. The station's ducker pulls the music down while the voice is above its threshold.
- The ducker's numbers already live in **Preferences → Ducker** (`src/components/DuckerSection.tsx:31-37`): depth dB, threshold dB, attack ms, hold ms, release ms. Nothing is chosen in code (`docs/duck-from-preferences-2026-10-13.md`).
- The Hold to talk settings page shows those five numbers read-only, with a link to edit them. It does not make a second copy.

**Question 2.** The ducker works on the programme bus, which feeds both the park and the internet stream (`aux…design` B.3). So a talk that ducks music in the park also dips the stream, and the voice is not on the stream if its board fader is off.

## Input limiter

**Station side:**
- The source fader's channel rack already has a compressor (`native/src/rack.rs` KIND_COMP, run in `chdsp.rs`).
- The talk fader gets a **limiter** preset whose numbers are settings, shown on that strip's rack: ceiling dBFS, attack ms, release ms. There is a starting value in Preferences, written once, like the ducker's.
- It catches a shout or a phone bumped against the mic before the park speakers.

**Phone side:** the browser's automatic gain (`autoGainControl`) can be ON or OFF, as a setting sent to the page. ON makes quiet talkers louder, but it also lifts background noise.

## Feedback and echo

The phone is often near the park speakers, which play the voice back ~0.5 s later.
- **Feedback loop:** the mic hears the speaker, sends it again, and the result howls or echoes.
- **Talker's own echo:** hearing yourself late is hard to talk over.

**What helps:**
- **Push to talk itself.** Audio flows only while the button is held. A loop cannot build up between presses.
- **Browser processing.**
  - `echoCancellation`: removes only what *the phone itself* plays. It does **not** remove the park speakers.
  - `noiseSuppression`: helps with crowd and wind.
  - `autoGainControl`: see Input limiter.
  - Each is a setting, sent to the page.
- **Listen pauses while talking.** If the same phone is listening, its Listen playback is silenced while the button is held. A phone speaker feeding its own mic is the most direct loop, so this cuts it.
- **A plain warning** on the page, the first time and in help: "Hold the phone close to your mouth and away from the speakers."
- **The limiter** caps a howl before it gets loud.

**What cannot be solved in software:** a mic held up to a PA speaker hears the PA. Distance from the speakers is the real fix.

## Maximum talk time (a setting)

- **Preferences → Park page — Hold to talk → "Longest talk (seconds)"**. It is not prefilled: Hold to talk is off until every number is set (the Listen rule).
- The page counts it down while talking ("12 s left") and stops at 0, even if the button is still held.
- Enforced in two places: by the server (the ticket ends) and by the station (the receiver stops at the limit even if the server goes quiet). So a stuck button or a dropped phone cannot hold the park open.

## Logged-in staff only

- Uses `parkActor` (`ether-backend src/index.js:5690-5714`), exactly like Listen (`listenStation`, `:6036-6043`).
- A session login is required; the long `?k=` key is refused. The button is not shown to viewers who are not logged in.

## Blocked by the studio lock

- "Park page control: OFF" in Ether locks talk too, through the same `parkLocked` check and the same 423 "Controls locked by the studio" (`index.js:5717-5724`).
- The page greys the button with that sentence.
- **The station refuses `park:talk` while locked too**, as it does for MUTE and carts.
- Turning the lock on **while someone is talking cuts them off within a second**, and the page says so.

## Who and when, in Ether

- **By the "Park talk" strip** in Ether, like the park-sound line (`src/lib/parkSound.ts`):
  - **"Talking now: Ryan (Park page)"**, live, while it happens;
  - then **"Last talk: Ryan, 8:42 PM, 14 s"**.
- **Park page activity log:** every press goes to the existing `park_audit` (`index.js:5747-5752`):
  - "started talking", with the length, or with "cut at the limit" / "locked";
  - "talk refused: busy".

## Two people pressing at once

- **One talker per station.** The server holds a **talk floor** for that station (in memory, like `ListenBook` in `lib/park-listen.js`).
  - The first press gets it. A second press gets 409 and its page shows **"Ryan is talking"**, greyed until the floor is free.
  - The floor ends at release, at the time limit, or when the ticket lapses (phone gone).
- **Ether can always talk over it.** The station's own board is never locked out.

## iPhone and Android mic permission

- **HTTPS is required** for the mic. `park.ether-cast.com` is HTTPS.
- **The first use asks for the mic.**
  - The first tap on the button only turns the mic on ("Allow microphone"), after an explanation.
  - Holding to talk works from the next press.
  - The ask must come from a tap; browsers refuse a mic request that isn't one.
- **iPhone (Safari, and every iOS browser, which all use Safari's engine):**
  - Safari may ask again on each visit unless the person sets Settings → Safari → Microphone → Allow, or the site setting (aA → Website Settings → Microphone → Allow). The help entry says so.
  - A long press can select text or open a menu. The button blocks that (`touch-action: none`, no callout or selection).
  - **UNVERIFIED:** whether Listen's playback moves to the earpiece or changes volume while the mic is open, a known iOS audio-session behaviour. Check: an iPhone with Listen on, then hold to talk.
- **Android (Chrome):** asks once, and the answer is remembered for the site.
- **Blocked:** the page says "Microphone is blocked for this page" plus the exact steps for the phone it is on (iPhone or Android). The button stays greyed until the mic is allowed.

## Honest state and built-in sense (v1, not later)

**Button states:**
- Idle;
- Connecting… (amber);
- **TALK NOW**: shown only when the **station reports voice arriving**, never when the phone merely started sending;
- Busy;
- Locked;
- Mic blocked;
- Station offline.

**Level meter:** while talking, a meter shows the phone's own mic level, so the talker sees they're being heard by the phone.

**Health ledger** (`_healthEvent`):
- `park-talk-start`, `park-talk-stop` (with seconds);
- `park-talk-cut` (time limit / lock);
- `park-talk-no-audio`: started, but no voice arrived within the connect window;
- `park-talk-refused`.

**Health Monitor:** a "Park talk" row: last talk, failures today, receiver state.

## Where the button goes (the door)

- **Park page, middle column, under LISTEN** (logged-in only), same size as the other buttons: **HOLD TO TALK**.
- **In Ether:**
  - **"Park talk"** in the source dropdown on every source fader;
  - the settings in **Preferences → Audio → Park page — Hold to talk** (next to Listen).
- **Help:** `docs/help-park-hold-to-talk.md`, written at build time.

## Settings

All live in Preferences → Park page — Hold to talk, per station.

**Shown, from elsewhere (not copied):**
- music under the voice: the five ducker numbers, shown read-only, edited in Preferences → Ducker.

**Off until every number below is set:**
- Longest talk (seconds)
- Limiter: ceiling (dBFS), attack (ms), release (ms)
- Phone mic processing: echo cancellation on/off, noise suppression on/off, auto gain on/off
- Receive buffer (ms): the station's ffmpeg/ring buffer, a trade of smoothness against delay

## Turning the relay on: Listen and Hold to talk

**What is there today:**
- MediaMTX v1.21.2 is installed and running on the stream server (`park-listen-plan` §Built).
- **nginx answers** `https://stream.ether-technologies.com/park/` (HTTP 404 from MediaMTX's path, checked 2026-10-15).
- **TCP 8322 and TCP 8189 time out from here (closed)**, checked with `curl` 2026-10-15. UDP can't be probed with curl.
- The server code is live: `f7d720e` is on `ether-backend` main. Listen needs three Railway env settings.
  - Whether they're set is **UNVERIFIED**. The live `listen.ready` is false, but that is also false while the station's own Listen settings are unset.
  - Check: `railway variables` (it prints secrets, so it needs Jeff's OK).

**Jeff does:**
1. **Lightsail firewall:** Lightsail console → the stream server → Networking → IPv4 firewall → Add rule, three times:
   - **TCP 8322**: the station sends Listen and receives Talk;
   - **TCP 8189**: phones, when UDP is blocked;
   - **UDP 8189**: phones.
   - Hold to talk needs **no extra ports**.
2. **Railway → ether-backend → Variables** (or tell Claude to, with OK to see secrets):
   - `PARK_LISTEN_RTSP_BASE = rtsps://stream.ether-technologies.com:8322`;
   - `PARK_LISTEN_WHEP_BASE = https://stream.ether-technologies.com/park` (the nginx path to MediaMTX's WebRTC);
   - `MEDIAMTX_AUTH_SECRET` = the same secret as in MediaMTX's auth URL on the stream server.
3. **On the park machine, in Ether:** Preferences → Park page — Listen, and set all four settings (which output feeds the park speakers, quality, mono/stereo, frame length, buffer).

**Claude does, after Jeff's OK:**
4. Check from outside that 8322 and 8189 answer, and that a Listen session plays.
5. Measure the real Listen delay (still owed from 2026-10-13).
6. **UNVERIFIED (checked on the server with Jeff's OK):** whether MediaMTX advertises the server's **public** IP for WebRTC media. The setting is `webrtcAdditionalHosts`; Lightsail sits behind a NAT. Without it, phones can connect but receive no audio.
7. For Hold to talk, at build time:
   - one MediaMTX path rule (`park/<station>/talk`: the phone publishes over WebRTC, the station reads over RTSPS);
   - the auth case in `ether-backend`.

## What it needs, by place

| Place | Work |
|---|---|
| Station installer | Engine PCM-in source path (Phase 2 #1); "Park talk" source kind; daemon receiver (ffmpeg RTSPS → port); `park:talk` with lease + time limit + lock refusal; limiter preset; who/when line; settings; health senses |
| Server | Talk floor + ticket; `/public/ops/:slug/talk` (+ `/stop`); auth case; lock check; audit; `talk` state in `/public/ops` (busy / who) |
| Park page | HOLD TO TALK button and states; WHIP publisher; meter; countdown; permission flow and blocked steps; Listen paused while talking |
| Relay | Firewall (above); one MediaMTX path rule |

## Questions for Jeff

1. **The voice and the internet stream.** Should the voice be on the stream?
   - Talk is park-only by default: room level up, board fader off. But the ducker dips the programme bus, so the stream's music dips too, with no voice on it.
   - Options: (a) accept the dip; (b) the voice on the stream too; (c) a later engine change to duck only the park speakers.
2. **Ducking.** Use the station ducker's numbers (one set for every ducking source), or does Hold to talk need its own set?
3. **MUTE.** When the park is MUTED, should talk still be heard? MONITOR is master today, so a muted park is silent to talk too.
4. **Ether's own say.** Should Ether be able to stop a talk in progress (a button on the strip)?
5. **Who may talk.** Every logged-in staff member, or a per-user permission?

## Jeff's answers (verbatim, 2026-10-15)

First message:

> (1) The Park page mic voice goes out on BOTH the park speakers and the internet stream; it's part of the show. Announcement audio also stays on the stream as it is now. Only the announcement TITLES stay off the public listener page and its queue. (1) The PARK TALK fader on the board gets a visible "To stream: ON/OFF" switch, saved like other fader settings. ON = park speakers + internet stream; OFF = park speakers only. Start it ON. Announcement audio stays on the stream as now; only announcement TITLES stay off the public listener page and its queue.

Second message, a few minutes later:

> 4. Hold to talk answers: (1) park only, never on the stream; (2) its own duck settings, starting at the station's current numbers; (3) talk follows MUTE: when muted it's silent and the button says "Park is muted. Unmute to be heard."; (4) yes, a stop button in Ether by the PARK TALK strip; (5) every logged-in staff member. Longest talk 20 s, echo cancellation and noise suppression ON, auto gain OFF. Build after the clocks fix.

### Plan as answered

1. **The stream: DECIDED (Jeff, final):**

   > Stream answer, final: the PARK TALK fader gets a visible "To stream: ON/OFF" switch, saved like other fader settings, starting ON. ON = park speakers + internet stream; OFF = park only. Ignore "park only, never on the stream".

   (The earlier conflict is kept below as history.) The two messages conflicted. The first says both the park and the stream, with a "To stream" switch
   that starts ON. The second says "park only, never on the stream". Waiting for Jeff to say which stands.
   - Announcement audio stays on the stream as now in either case. Only announcement TITLES stay off the public listener
     page and its queue (already so).
2. **Its own duck settings:** depth, threshold, attack, hold and release for talk, set once from the station ducker's
   current numbers when Hold to talk is first saved, then edited only here. The read-only ducker copy above is replaced
   by these five settings.
   - **Jeff: "if it needs an engine change, tell me what it involves and the risk before building. Don't change the engine without my OK."**
   - **UNVERIFIED, engine question:** the ducker today is one per station, on the programme bus
     (`aux…design` B.3). A second set for talk means the engine must run two duck sources with their own numbers. To be
     designed at build time, inside that design.
3. **Talk follows MUTE:** when the park is muted, talk is silent (MONITOR stays master) and the button says
   **"Park is muted. Unmute to be heard."**
4. **Stop button in Ether** by the PARK TALK strip. It ends the talk, frees the floor, and logs "stopped in Ether".
5. **Every logged-in staff member** can talk. No per-user permission.

**Settings, as Jeff set them:**
- Longest talk: **20 s**.
- Echo cancellation: **ON**.
- Noise suppression: **ON**.
- Auto gain: **OFF**.
- Still to set at build time: the limiter's three numbers and the receive buffer.

**Order:** build after the clocks fix.
