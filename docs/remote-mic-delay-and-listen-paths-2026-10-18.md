# Laptop mic to the park speakers: seconds of delay (read-only findings, 2026-10-18)

Jeff (verbatim): "I talked into the laptop mic using the remote link to the local playout on ovowforestmusic and heard my
voice out of the OV machine's output (the Bose in the park) a few SECONDS later. That path should be well under a second
(Park mic measured ~0.7 s; Remote Link was built for under 200 ms)."

**The defect is: seconds of delay, laptop mic to the Bose in the park.**

Nothing was changed. Files were read and `git log` / `git show` were run. There were no builds, no network calls and no DB access.

## Summary in plain words

- **Which path:** "the remote link to the local playout" matches the product's **Remote Link**: Ether running on the laptop,
  **SEND FEED TO** ovowforestmusic, a fader there set to **Link**, Opus over plain UDP 9760, direct with no relay. The only
  other way a laptop mic reaches that speaker is the **Park page** in the laptop's browser (TAP TO TALK, WebRTC to MediaMTX, then
  RTSPS to the station). Code can't tell which button Jeff pressed. **UNVERIFIED: Jeff says which.**
- **The build:** `1278bdeb` and `62a389ec` are **installer sha256 prefixes, not commits**. 1278bdeb = `Ether Setup 4.6.59
  park-mic-warm 1278bdeb 6558e57.exe` (commit 6558e57). The docs put it on ovowforestmusic as of 10/17. It carries every
  low-delay Park mic change, plus the 120 ms Park mic buffer. No commit on any branch has changed the mic, link or talk
  code since 6558e57. So whichever build is on the box now (1278bdeb or 615c4632), this path is the same code.
- **Where seconds can come from:** I found **no buffer on either path that can grow to seconds and stay there**. Every
  queue on the way to the local output has a hard bound, and the backlog is dropped above it. With default settings the Remote
  Link's worst case is about 0.5–0.7 s. With the jitter buffer turned to its 1000 ms maximum it is about 1.5 s. The
  multi-second buffers in Ether are the 8 s profanity delay, the 4 s stream ring and the Icecast 16.7 s burst, and **all of them are on the
  stream path only**. That means either (a) a setting on ovowforestmusic is turned up (jitter buffer / Park mic buffer, max 1000 ms
  each), (b) the voice did not come through the direct path at all (e.g. something in the park plays the *stream*), or (c) a
  stage outside Ether (how the Bose is connected; sound travelling across the park). **Each one is settled by one reading
  on ovowforestmusic during a talk (see "What Jeff must measure").**
- **Listen:** the Park page Listen is **WebRTC (WHEP) through MediaMTX**, measured at 152–157 ms on a local rig. The Remote
  admin app (app.ether-cast.com) **has no player of its own**. Its only listen is a link to the public listener page, and
  that page plays **Icecast** (measured 10/13 at about 17.5 s for a Chrome listener because of the 16.7 s burst).
- **Plan:** one shared WHEP player module plus one ticket endpoint, used by every Ether surface. The public listener stays on
  Icecast. It needs **one stream-server change** (add `https://app.ether-cast.com` to MediaMTX `webrtcAllowOrigins`), with a
  backup first and only with Jeff's OK. It also needs a backend endpoint for account-login tickets, and a choice from Jeff of what that listen carries
  (the park mix as today, or the air mix).

## 1. Which path, and which build

### "The remote link to the local playout": the UI
- **Remote Link** (help: `docs/help-remote-link.md`; design: `docs/remote-link-design-2026-09-28.md`).
  - Door at the sender (the laptop): hamburger menu → Remote Link (`src/App.tsx:3104-3113`), the SEND FEED button on the master
    section (`src/components/MasterOutput.tsx:206-207`), and Preferences → Broadcast → Remote Link (`src/components/SettingsPanel.tsx:3295`,
    `src/components/RemoteLinkSettings.tsx`).
  - Door at the station (ovowforestmusic): a fader's source → "Link (network feed)" (`src/components/SourceChannelStrip.tsx:94,239,247`).
  - What travels is the **laptop's whole board (its PGM)**, not just the mic. The laptop mic has to be on a fader of the laptop's board, up, ON, with To stream on, because the tap
    is the air sum (see hop 3).
  - Direct UDP only: "The relay on the Ether server … comes next. This version sends directly: the studio's router must
    forward UDP 9760" (`help-remote-link.md`, "Not in this version"). The OV direct path was **never measured**
    (`remote-link-design-2026-09-28.md:279`, IT ticket D6 deferred). So a laptop can reach ovowforestmusic only on the OV LAN or through a
    forwarded port. **UNVERIFIED where the laptop was.**
- **The Park page** (`C:\ether-park`, `park.ether-cast.com/<slug>`): TAP TO TALK on a staff login works in a laptop browser too.
  It is the "Park mic" path that Jeff measured at ~0.7 s by ear (`docs/park-mic-build-2026-10-16.md`, "First real talk", 3:07 PM 10/16).
  - Found while checking: the warm-line Park page (`ether-park 008a5fa`) and server (`ether-backend 61852fc`) exist only on the
    local branches `feat/park-talk`. The backend's `origin/main` ref here is `84a4a6b`, which sends `park:talk` with a `url` and no
    `warmId`. A 6558e57 station refuses that ("No phone line for this talk.", `audiod/talk.js:55-63`). If the server
    really is still 84a4a6b, **a Park page talk to the 1278bdeb station cannot work at all**, and that points to Remote Link for
    Jeff's test. **UNVERIFIED** (local refs can be stale). Check: the Railway deployment list for ether-backend.
- **Not a path:** the Remote admin app (`C:\ether-dashboard`) has no microphone code (no `getUserMedia` / WebRTC in `src/`).

### The build on ovowforestmusic
- `docs/playout-change-audit-2026-10-17.md:17`: "ovowforestmusic … **1278bdeb (commit 6558e57)**, not the new 615c4632".
  The same is in `docs/scheduler-rotation-playout-design.md:250`.
- Installers in `C:\openair\dist-electron` (names = version, label, sha256 prefix, commit):
  - `Ether Setup 4.6.59 park-mic-tap-lowdelay 62a389ec d9fcba6.exe`: sha256 `62a389ec3eaf…`, 10/16 3:30 PM
    (`park-mic-build-2026-10-16.md:339-351`).
  - `Ether Setup 4.6.59 park-mic-warm 1278bdeb 6558e57.exe`: commit 6558e57 (10/16 16:25), Ether.exe dated 16:28.
  - `Ether Setup 4.6.59 halloveen-playout 615c4632 10348f4.exe`: not run on either machine as of 10/17 6:52 PM (audit doc §0).
- **Does 1278bdeb carry the low-delay Park mic changes? Yes.** These are all ancestors of 6558e57 (`git merge-base --is-ancestor`):
  `4c33ad6` (receiver ffmpeg `-flush_packets 1 -max_delay 0 -reorder_queue_size 0`) and `d9fcba6` (10 ms pieces, 30 ms
  backlog drop). Then `6558e57` itself **replaced the 30 ms drop with `park_mic_buffer_ms`** (starts at 120 ms, range 20–1000), "in the
  queue target and backlog bound". So the Park mic in 1278bdeb sits about 0.1 s deeper than in 62a389ec, by design (Jeff: "even if the
  delay goes up a little").
  - All Remote Link commits (`37ca805 … f2c4103`) are also in 6558e57.
- **After 6558e57, on every branch:** `git log --all -- audiod/talk.js audiod/link.js native/src/micin.rs native/src/link.rs
  native/src/linknet.rs electron/park-talk.js` shows nothing newer than 6558e57. `git diff 6558e57 10348f4` touches only
  `audiod/engine.js, loggen.js, playlog.js, sim-hour-change.js`. **So the mic/link path is identical in every build since.**
- **UNVERIFIED** that ovowforestmusic still runs 1278bdeb today. Check: Help → About, or the date of the installed Ether.exe.

## 2. The delay at every hop

### A. Remote Link (the likely path): laptop Ether → UDP → ovowforestmusic fader → Bose

| # | Hop | Configured | Where | Worst case | Can it grow to seconds? |
|---|---|---|---|---|---|
| 1 | Laptop mic capture (cpal, not getUserMedia) | `BufferSize::Default` (WASAPI ~10 ms) | `native/src/micin.rs:821` | device block (a Bluetooth headset mic adds ~0.1–0.2 s) | No |
| 2 | Laptop mic ring → its fader (LiveIn) | target = one pull + largest input block + 2 ms; stale above target + **100 ms** is dropped; ring 0.5 s; drift ±0.3 % | `micin.rs:43,47,55,257-260,273-279` | ~target + 100 ms | No: dropped at target + 100 ms. (`in_block_max` only grows, `:424`, so one huge device block raises the target until the mic is re-patched; the ring caps it at 0.5 s) |
| 3 | Laptop board → SEND tap | the PGM: post-EQ, post-master, **pre-processing, pre-profanity-delay** | `native/src/audio.rs:4887-4890` | one callback block | No. Only faders with To stream ON are in this sum (`audio.rs` on_air, ~4640) |
| 4 | Tap ring → link thread | 0.5 s ring; thread drains every ~5 ms | `native/src/linknet.rs:33-34, 346-399` | ~5 ms; a full ring drops the buffer (`tap_overruns`) | No |
| 5 | Resample 44.1→48 k + Opus encode | 20 ms frames, 128 kb/s, FEC on, look-ahead 6.5 ms | `native/src/link.rs:25-35`; `linknet.rs:47-50` | ~27 ms | No |
| 6 | Network | plain UDP 9760, direct, no relay, no TCP | `link.rs:34`; `help-remote-link.md` | LAN ms; never measured to OV (`remote-link-design…:279`) | No (UDP has no queue; a lost packet is FEC'd or concealed) |
| 7 | ovowforestmusic jitter buffer | target **120 ms** (setting 20–1000); stale above target + **10 frames (200 ms)** is dropped; slots 5.12 s | `link.rs:35,39,353-357,459-470` | target + 200 ms (**320 ms** default; **1.2 s** at the max setting) | No: dropped |
| 8 | Decode → live ring → Link LiveIn | decodes on demand only while the ring is below LiveIn's target; ring stale above target + 100 ms; drift nudge ±0.3 % on the total vs the jitter target | `linknet.rs:35-39,709-741`; `micin.rs:331-345` | ~25 ms + 100 ms | No |
| 9 | Fader / board | no delay line on any fader. **Profanity delay is in the stream drain thread only** | `audio.rs:276-283` (comment: "STREAM path only … the local monitor stays live"), FIFO at `audio.rs:5343-5345` inside `drain_program_bus` | 0 | No |
| 10 | Main output (MONITOR) | the mixer runs **inside the cpal output callback** (pull, no ring); `BufferSize::Default` | `audio.rs:3122-3143` (`mixer_callback`), `localout.rs` `write_device` | device buffer (WASAPI ~10–30 ms) | No |
| 10b | AUX output (if the Link fader is an AUX/Source slot to a second device) | ring capped at **0.125 s**, drops above it | `audio.rs:2904-2909, ~5199-5217` | 125 ms | No |
| 11 | Outside Ether: the Bose's connection, and sound across the park | not in code | n/a | Bluetooth ~0.2 s; a Wi-Fi/cast speaker 1–2 s+; sound travels **~0.3 s per 100 m** | **Possibly** |

Design budget ≈ 200 ms (`remote-link-design-2026-09-28.md:179-186`). Measured with two Ether boxes on one network: **120–142 ms**
(`remote-link-design…:339`). The strip itself shows the measured end-to-end figure: "LINK · <sender> · 128 ms" (help, state table).

### B. Park page in a browser (the alternate path)

| # | Hop | Configured | Where | Worst case |
|---|---|---|---|---|
| 1 | getUserMedia | mono, `latency: 0` hint, echo/noise/AGC from the station's settings | `C:\ether-park\src\talk.ts:41` | browser capture ~10–40 ms |
| 2 | WebRTC Opus (browser default 20 ms) → MediaMTX WHIP over nginx 443, ICE UDP/TCP 8189 | `relay-ports-check-2026-10-15.md:68-76` | browser drops rather than queues |
| 3 | MediaMTX → station: RTSPS **over TCP** 8322 | `audiod/talk.js:72` (`-rtsp_transport tcp`) | TCP can hold a backlog during a stall and release it in a burst. The engine drops the burst (hop 6) |
| 4 | ffmpeg on the station | `-fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0 -max_delay 0 -reorder_queue_size 0 … -flush_packets 1` | `audiod/talk.js:66-75` | measured: without flush, lumps up to 256 ms; with it, 85 ms (`park-mic-build…`, 3:07 PM section) |
| 5 | Daemon (Node) pipe → 127.0.0.1 TCP → engine Park port | relay of each chunk, no queue of its own | `talk.js:136-155` | stalls if the daemon's event loop blocks; then the audio arrives in a burst and is dropped |
| 6 | Park mic LiveIn | 10 ms pieces; target = pull + 10 ms + 2 ms + **park_mic_buffer_ms 120**; backlog above target + **120 ms** dropped | `micin.rs:57-78, 257-264, 598` | ~0.25 s default; ~2 s at the 1000 ms max (target + 1000 + bound 1000) |
| 7–8 | board, output | as A9–A10 | | |

Jeff's by-ear ~0.7 s was on 62a389ec's predecessor at 3:07 PM 10/16. "The delay was not re-measured after these changes"
(`park-mic-build…:369`).

### Where SECONDS could come from (ranked)
1. **A setting turned up on ovowforestmusic:** the Link jitter buffer (Preferences → Broadcast → Remote Link → Feed in) or the Park mic
   buffer (Preferences → Park page — Talk). Max 1000 ms each → ~1.3 s (Link) / ~2 s (Park). Read the two numbers.
2. **Not the direct path:** if anything in the park plays the *stream* (a player on the public page or Ether Cast), the voice arrives
   ~6–17 s late through Icecast. That happens if the laptop's own Ether is the broadcast owner with its mic on. Two machines aired HalloVeen on 10/17
   (audit doc §0).
3. **Outside Ether:** a Wi-Fi/cast Bose, and distance (100 m of air ≈ 0.3 s).
4. **Not found in code:** no unbounded queue, no replay on reconnect (the jitter buffer re-anchors after a starve, `link.rs:406-407`;
   ffmpeg restarts read live), no profanity delay on the local output, no HLS leg, and no warm line that buffers into the
   engine (between talks, the samples are read and dropped, `talk.js:136-145`; `micin.rs:533-535`).

## 3. The two listen paths

- **Park page Listen (near-instant):** the station engine copies the **post-MONITOR park mix** (`audio.rs:5266-5270`) into a
  1 s ring (`LISTEN_BUF`, `audio.rs:3903`), which is emptied on connect (`drain_listen`, `audio.rs:5287-5305`). One ffmpeg
  (`audiod/listen.js:59-68`) encodes it to Opus (`-application lowdelay`, OV: 24 kb/s mono 20 ms) and publishes it **RTSP/TCP to MediaMTX**
  `park/<station uuid>`. The phone plays it with **WHEP** (`ether-park/src/listen.ts:38-60`), with `jitterBufferTarget` = the station's
  Listener buffer (OV: 0 ms). The ticket comes from `POST /public/ops/:slug/listen` (`ether-backend/src/index.js:6030-6076`,
  staff login). Measured on a local rig: **152–157 ms** at buffer 0 (`park-listen-plan-2026-10-13.md:185-192`).
- **Remote admin app (~6 s):** `C:\ether-dashboard` has **no audio player** (no `<audio>`/WebRTC in `src/`, nor in the built
  `dist/a3`). The only listen is the **"Public page" link** (`src/components/StationDetail.tsx:183, 294-295`) and the embed
  snippets (`:303, :340`). Both go to `listen.ether-technologies.com` (`ether-listener`). That page plays the **Icecast** mount in a plain
  `<audio>` (`ether-listener/src/App.tsx:118-127, 382`; http mounts are proxied by `functions/api/stream.ts`). The delay is the
  Icecast **burst-on-connect 256 KB = 16.7 s** plus the player's ~2.3 s ahead buffer, ≈ 17.5 s in Chrome (`docs/stream-delay-2026-10-13.md`).
  Jeff's ~6 s is less than that. The muted pre-prime and live-edge logic (`App.tsx:124-140`) may account for it. **UNVERIFIED** which
  button Jeff used for "listen" in the Remote app.
- **Why the gap:** Icecast is a TCP byte stream with a large server burst and a player prebuffer that never catches up. WebRTC is
  real-time UDP with a jitter buffer of tens of ms that drops late audio.

## 4. Plan: one relay listen for every Ether app (nothing built)

**The rule:** one player module and one ticket endpoint. Every Ether surface calls them. Nothing is copied. The public listener (`ether-listener`,
`ether-cast`) stays on Icecast.

**Listen surfaces today:**

| Surface | File:line | Today | Change |
|---|---|---|---|
| Park page Listen | `ether-park/src/listen.ts:30-75` | WHEP | becomes the first user of the shared module (its code moves into the module, then it imports it) |
| Remote admin app (app.ether-cast.com) | `ether-dashboard/src/components/StationDetail.tsx:294` (link only) | Icecast via the public page | a **LISTEN** button on the station page, using the module. The public-page link stays as "public page" |
| Desktop app | none (no stream player; `src/audio/localOutput.ts` is local media only) | n/a | only if one is wanted (e.g. a standby machine hearing the owner): the same module, imported by the renderer |
| Public listener / Ether Cast | `ether-listener/src/App.tsx`, `ether-cast/index.html:114` | Icecast | **no change** |

**The module:** one small TypeScript file (`relayListen`: ticket → RTCPeerConnection recvonly → WHEP POST → renew every 15 s →
stop), published once and imported by ether-park, ether-dashboard and (if wanted) the desktop app. For example as a shared package in one
repo, or served as one script from the Park origin. It reports honest states (connecting / playing / reconnecting / relay down) and
its own measured delay (`getStats` jitter-buffer delay).

**Backend:** one endpoint family that both logins can use. The account JWT (Remote app) or the Park staff login returns the same
ticket shape (`ticket`, `whep`, `buffer_ms`) from the same ticket book as `/public/ops/:slug/listen`. The station is routed by
`station uuid` → `park/<uuid>`. The listen command goes to the **broadcast owner** machine only (a standby machine never
publishes; `docs/` broadcast-owner rule).

**What it carries:** today's Listen carries the **park mix** (post-MONITOR, `listen_which` MAIN/AUX/both). It is not the air. A
Remote admin listener probably wants the **air mix** (pre-profanity-delay). **Jeff's decision.** Air would need a second
engine tap (like the Link tap at `audio.rs:4890`) and its own relay path (e.g. `park/<uuid>/air`). That means an installer, and one
more path rule on the relay.

**Relay needs:**
- **Origin:** `webrtcAllowOrigins` is only `https://park.ether-cast.com` (`park-mic-build…`, relay path check). Adding
  `https://app.ether-cast.com` is **a stream-server change: Jeff's OK, back up `/etc/mediamtx/mediamtx.yml` first** (as done on 10/16).
- **Path rule:** none for the park mix (the `park/<uuid>` rule exists). One line for an air path, if chosen.
- **Capacity:** one publish per station, no transcoding on the relay. Each listener is about 24–64 kb/s of WebRTC egress. Tens of staff
  are small for Lightsail. **UNVERIFIED:** Lightsail plan transfer limits and MediaMTX CPU at that count.
- **Auth:** today's `authHTTPAddress` → backend `/internal/mediamtx/auth` with tickets. Tickets per listener, short-lived, renewed.
- **Networks that block UDP:** ICE-TCP 8189 is open (`relay-ports-check…:57-63`). There is no TURN. A network that blocks both fails.
- **Failover:** relay down / ICE fails → the module says so plainly and offers the Icecast stream, labelled "stream, about N s
  behind". It never switches silently.

**Risks:**
- The air machine's uplink: one extra Opus publish per station while anyone listens.
- The listen ffmpeg publishes over RTSP/**TCP**. During an uplink stall, the 1 s engine ring caps what Ether holds, but
  ffmpeg and the TCP buffers can hold more, so the delay could creep for a while (**UNVERIFIED**, not measured). The module's
  own delay reading would show it.
- Park mix ≠ air: with MONITOR down, the Remote listen is silent. Faders with To stream OFF are heard there and not on air. It must be labelled.
- Hearing pre-delay (live) audio on the Remote app while DELAY is on means staff hear what the stream hasn't aired yet. Label it.
- Every surface depends on one relay box. Failover must be honest, as above.

**Server changes needed:** yes, one line in `mediamtx.yml` (the origin), plus one path rule if the air mix is chosen. Backup first, Jeff's OK
first. A backend deploy (Railway) for the account-login ticket. A Park page deploy and a dashboard deploy. An installer only if the air mix is
chosen.

## What Jeff must measure or send

1. **Which button:** Ether on the laptop with SEND FEED (Remote Link), or the Park page TAP TO TALK in the laptop's browser?
2. **During one talk, on ovowforestmusic, a screenshot of:** the Link fader's strip ("LINK · <laptop> · NNN ms") and Health
   Monitor → Remote Link (latency, jitter target, buffer depth, ring ms, drift, stale flushes). For the Park page instead: Preferences
   → Audio → Mic Inputs for the Park mic fader (target ms, fill, stale flushes) and the Park mic buffer value. If the strip says
   ~150 ms while the ear says seconds, the seconds are outside Ether (hops A11 / "not the direct path").
3. **One timing test:** a single phone recording that hears both the talker's clap at the laptop and the Bose, at a measured distance
   from the Bose (subtract ~0.3 s per 100 m). Do it once with Remote Link and once with the Park page.
4. **What the Bose is connected to** on ovowforestmusic (analogue / USB / Bluetooth / Wi-Fi), and whether anything in the park plays the
   public stream.
5. **Help → About on ovowforestmusic** (the build), and the Remote Link jitter-buffer value in Preferences.
6. For the Remote app's ~6 s: which control was pressed (the "Public page" link or an embed).
