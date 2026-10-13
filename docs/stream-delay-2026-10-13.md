# Stream delay — Ether to the listener app (HalloVeen, measured live 2026-10-13)

## Jeff's report (verbatim)

> "Dancing in the Dark" started in Ether, and the listener app didn't start its time animation until exactly 25 seconds later.

Measured live on HalloVeen, listen-only: one extra listener on the public stream, plus the listener app's song feed, for 12 minutes (09:11–09:23 UTC, five songs). I also read the stream server's settings. Nothing was changed anywhere.

## What I measured

### 1. Audio delay: Ether playing a song → the listener hearing it

| Stage | Seconds | How it was measured |
|---|---|---|
| Ether's encoder + the stream server + the internet, for a listener already connected | **0.13 – 0.29** (5 of 5 songs) | Each song's audio found inside the recorded stream by matching it against the song file (match 0.87–0.99, checked twice at two different points in each song), then the arrival time of that audio compared with Ether's own start time ("deck X LIVE" in the engine log, to the millisecond, same clock) |
| **The stream server's "burst on connect"** | **16.7** | The moment a listener connects, the server sends 267,400 bytes at once: the last 16.7 s of audio, already played. Every listener starts that far behind and stays there. The server's own setting is `<burst-size>262144</burst-size>` (256 KB = 16.4 s at 128 kbps), six times Icecast's default of 64 KB |
| The app's player (Chrome, plain `<audio>`) | **0.65** to start; holds ~2.3 s ahead of what it plays | A muted copy of the stream in Chrome: playback began 0.65 s after connecting, and the browser kept a steady 2.3 s decoded ahead. That 2.3 s is **inside** the 16.7 s burst, not added on top |
| Ether's profanity delay (DELAY button) | 0 when off, **8 when pressed** | Stream path only. The 8 s is written in code (`src/App.tsx` `DELAY_SEC = 8`), not a setting |
| **Total for a Chrome listener** | **≈ 17.5 s** | 16.7 + 0.65 + ~0.2. It grows by the length of every stall on a poor connection, because a plain stream player never catches up |

- iPhone/Safari and Firefox were not measured. The research found no reliable published figure for them (UNSOURCED below), so treat their totals as unknown until measured on a phone.
- A listener who connected long ago and had network stalls is behind by 17.5 s **plus** every stall since.

### 2. Display delay: when the app's song title and time bar change

| Compared with | Seconds | Measured |
|---|---|---|
| (a) Ether starting the song | **2.7 – 6.6** after (5 songs) | The app's live song feed (`/public/station/halloween/stream`), timed against the engine log |
| (b) The listener actually hearing the song | **~11 – 15 s *ahead*** of the audio | 17.5 s audio delay minus 2.7–6.6 s display delay |

**The display runs ahead of the audio, not behind it.** A Chrome listener sees "Disturbia" and its time bar start about 15 s before they hear it.

**Why the display takes 2.7–6.6 s:**
- Ether checks what's playing every 3 s, and a second 3 s loop sends it to the server.
- During a segue both songs are "playing", and Ether reports the first deck in A-B-C order rather than the one that just started. When the new song is on a later deck (B → C), the old title is shown until the old song's tail ends: "I Will Wait" took 6.6 s.

**The listener app** shows the title the moment the server pushes it, and starts its time bar from Ether's real start time (`src/components/NowPlaying.tsx`, `src/hooks/useNowPlaying.ts` in `C:\ether-listener`). It makes no allowance for the audio delay.

### Jeff's 25 seconds, "Dancing in the Dark"

- "Dancing in the Dark" started at **09:04:43.4 UTC**, at the first launch after the install. Ether was told to start the stream at **09:04:45.1**.
- Ether only reports a song to the server while that station's stream is live (`src/App.tsx`, the `ss.live` gate). So the app's title and time bar waited for the stream to connect, then for the next 3 s + 3 s report.
- That fits a 25 s gap, but the stream's "live" moment isn't logged, so **the exact split is UNVERIFIED**. One check would settle it: time a song change while the stream is already running. In today's five measured changes the display followed Ether by 2.7–6.6 s.

## What professional stations run (sources)

Research done for this doc. Every number below is from the cited source; my arithmetic is marked.

**Typical delays**
- **Icecast itself:** about 1.5 s source-to-player at 128 kbps without burst, 3 s with the default burst. — https://icecast.org/docs/icecast-2.3.0/config-file.html
- **Triton Digital (a large commercial streaming platform):**
  - Normal streams use "a buffer of 30 seconds or more". Low Delay streams run 3–10 s.
  - Super Low Delay runs about 1 s with a 100 ms burst, and Triton warns it is vulnerable to network problems.
  - https://help.tritondigital.com/docs/latency-management
- **Typical delay by technology:** HLS defaults are 18–30 s or more, tuned HLS/DASH 8–12 s, low-latency HLS about 2–3 s, WebRTC 1–2 s. — https://www.wowza.com/blog/low-latency-technology-options ; https://datatracker.ietf.org/doc/html/rfc8216 (§6.3.3) ; https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices
- **A web-player maintainer:** "anything under 30 seconds latency is considered ok and about 2 seconds is around the best you'll get". — https://groups.google.com/g/jplayer/c/S_UuRPVcqFU

**Icecast's own settings**
- `burst-size`: default 64 KB, settable per mount, must be smaller than `queue-size`. — https://icecast.org/docs/icecast-2.4.1/config-file.html
- At 128 kbps (16,000 bytes/s): 64 KB ≈ 4.1 s; this server's 256 KB ≈ 16.4 s. (my arithmetic)

**The trade-off with dropouts**
- An Icecast developer: the two main factors in delay are the player's prebuffer and Icecast's burst. Make both as small as you can get away with; the cost is that listeners "become more susceptible to network lag". — https://lists.xiph.org/pipermail/icecast/2005-March/008765.html
- One reported Android Chrome case: a 64 KB burst made playback slow to start (10–20 s). About 1 MB fixed the start time but added delay. — https://www.internet-radio.com/community/threads/very-slow-buffering-in-android.20139/
- Our 256 KB burst is very likely there for the same reason. Fast starts on phones are what a smaller burst puts at risk.

**Players that keep the title in step with the audio**
- **icecast-metadata-player:**
  - Has a `bufferLength` setting, default 1 s.
  - Reads the song title carried *inside* the stream ("ICY" metadata) and announces it "when metadata is synchronized with the audio", i.e. when the listener hears it.
  - Supports iOS 12.4+.
  - https://github.com/eshaz/icecast-metadata-js/tree/main/src/icecast-metadata-player
- **Triton** aligns titles to the audio with an offset and recommends cutting audio delays first when they are large. — https://help.tritondigital.com/docs/cue-point-alignment-on-the-triton-digital-platform

**UNSOURCED:** published figures for iPhone Safari and Firefox buffering, a published minimum mobile buffer in seconds, and how iHeart/TuneIn/StreamGuys sync titles.

## Proposal: how to tighten it (nothing changed — Jeff approves first)

**The rule: every buffer amount becomes a visible setting.** None of these numbers lives in code.

### On the stream server (Icecast, Lightsail)

1. **Burst on connect: 256 KB (16.4 s) → 64 KB (4.1 s)**, Icecast's own default. This alone cuts a new Chrome listener's delay from ~17.5 s to ~5 s.
   - Per mount, so it can be tried on HalloVeen's `/halloween` first.
   - Shown on the Remote page as **"Listener start buffer (seconds)"** with its current value, the server's file kept in step with it.
   - **Risk:** slower starts on weak phone connections (the Android report above). Measure on a phone before rolling it to every station.
2. **Queue size** (512 KB, how far a slow listener may fall behind before being dropped): leave as is, shown beside the burst.

### On the air machines (Ether) — needs an installer

3. **Report song changes at once.** Today two 3-second loops give 2.7–6.6 s. Instead, report the moment a deck starts, so the display follows Ether by well under a second.
4. **During a segue, report the song that just started**, not the first deck in A-B-C order.
5. **Profanity delay:** make the 8 seconds a setting ("Profanity delay (seconds)"). It only applies while DELAY is on.
6. **Song titles in the stream itself** (ICY metadata). The stream server shows no title for HalloVeen right now (`title: null` in its status), so in-stream titles aren't reaching it. Needed for item 8. Not yet diagnosed.

### In the listener app (Cloudflare Pages)

7. **A player with a set buffer** (icecast-metadata-player in its MSE mode):
   - **"Player buffer (seconds)"**: a setting, starting at the value we choose, e.g. 2 s.
   - Phones that can't use it fall back to today's player.
8. **Title and time bar change when the song is HEARD:**
   - Taken from the title carried in the stream, synchronized by the player, so the display matches the audio exactly.
   - Until item 6 is fixed: delay the display by the player's own measured lag (how far behind live it is playing), not by a fixed number.

### What delay we can reach safely

| Setup | Expected air-to-listener | Basis |
|---|---|---|
| Today | ~17.5 s (Chrome), more after stalls | measured |
| Burst 64 KB, today's player | ~5 s | 4.1 s burst + ~0.65 s start + 0.2 s (arithmetic from the measurements) |
| Burst 64 KB + a 2 s player buffer | **~4–6 s — the recommended target** | Inside Triton's "Low Delay" 3–10 s band. The one known risk (slower starts on weak Android connections) is testable before rollout |
| Burst ~16 KB + a 1 s player buffer | ~2–3 s | Possible. Triton's ~1 s tier is described as fragile on poor networks, so not recommended for a park on mobile data |

**Measure again after each step**, with the same capture (scripts in the session scratchpad, listen-only). Phones especially: iPhone and Android on mobile data.

## Not done

- **Phones:** the browser figure is Chrome on this machine only. iPhone, Android and Firefox weren't measured.
- **The 25 s case:** its exact split is UNVERIFIED (see above).
- **Missing stream titles:** why HalloVeen's title doesn't reach the stream server isn't diagnosed.
