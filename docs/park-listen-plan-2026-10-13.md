# Park page "Listen" — plan for approval (2026-10-13)

Jeff, verbatim: "add the local audio feed so logged-in staff can hear what the park hears. The feed is exactly what goes to the park speakers: the station's MONITOR output, after the park fader and MUTE. Staff must hear their fader moves, mute and carts. Low delay (aim for about 1 second) … don't guess. Tell me the delay you actually measure … Show me where the button goes … tell me what it needs on OVEVENTS (new station build?) and on the server, before deploying or building an installer."

Nothing is built. This is the plan.

## Where the button goes

![Listen button, mock](park-listen-button-mock-2026-10-13.jpg)

- Middle column, directly under MUTE, as the same size of button, in the purple accent.
- Off: "LISTEN — Hear the park speakers on this device". On: "LISTENING".
- Logged-in staff only; never starts by itself.
- The screenshot is the live page with the button drawn in the browser only, not deployed. The page showed MUTED at the time; that was the real state.

## What Ether has today (code read, no change)

- **The park's level is applied at the very end**, just before the speakers: `monitor_vol × master_monitor_vol`, ramped (`native/src/audio.rs:5076-5077`, `native/src/localout.rs:36-38`).
  - The stream is taken earlier (`audio.rs:4879-4885`), so nothing on the monitor side touches what airs.
- **No copy of the after-fader, after-MUTE audio exists to send anywhere.** It only exists inside the speaker write (`localout::write_device`) and the AUX-device ring (`LocalRing::push`).
- **Carts:** carts are "Source" channels.
  - They reach a local output only through the AUX ring, at the MONITOR level (`audio.rs:5067-5082`). They are kept out of the main speaker mix (`audio.rs:4902-4908`).
  - So "what the park hears" = the main MONITOR device feed **plus** the AUX device feed, if both are wired to the park.
  - **Question for Jeff:** which output(s) on OVEVENTS feed the park speakers?
- **The stream already uses a safe pattern:**
  - The audio callback copies into a ring only with `try_push`, and drops when full; it never waits (`audio.rs:4879-4885`).
  - A separate thread serves it on `127.0.0.1` (`audio.rs:5140-5178`).
  - The daemon starts ffmpeg on that port (`audiod/stream.js:76-87`).
- **No WebRTC listen feature exists.** The only WebRTC is the Show+ guest call (`ShowPlus.tsx:540`).

## Research (cited)

**WebRTC is the right transport for about 1 s:**
- Its receive (jitter) buffer defaults to a 60 ms target and a 2 s maximum (NetEQ; [omr.it.com](https://omr.it.com/blog/jitter-buffers-webrtc-playout-delay-tuning/), [webrtcHacks on NetEQ](https://webrtchacks.com/how-webrtcs-neteq-jitter-buffer-provides-smooth-audio/)).
- Typical end-to-end is a few hundred ms ([bloggeek](https://bloggeek.me/webrtcglossary/latency/)). Icecast/MP3 (today's stream) is ~17 s (docs/stream-delay-2026-10-13.md).

**The page can set the buffer:**
- `RTCRtpReceiver.jitterBufferTarget` (Chrome 124+) sets the preferred buffer, 0–4000 ms. It is a request the browser follows within its own limits ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget)).
- This is how the listen buffer becomes a visible setting.

**Standard signalling, so no custom protocol:**
- **WHIP** (publish, IETF RFC 9725, March 2025, [rfc-editor](https://www.rfc-editor.org/rfc/rfc9725)) and WHEP (play).
- FFmpeg gained a WHIP muxer in June 2025 ([Phoronix](https://www.phoronix.com/news/FFmpeg-Lands-WHIP-Muxer)).
  - So the station can publish the way it already streams: a separate ffmpeg reading a local tap, encoding Opus.
  - **To check:** whether Ether's bundled ffmpeg has it.

**A relay server, not station-to-phone:**
- Corporate and 4G/5G networks often block direct WebRTC. About 10–25% of sessions need a relay (TURN) ([forasoft](https://www.forasoft.com/learn/video-streaming/glossary/terms-streaming/nat), [bloggeek TURN](https://bloggeek.me/webrtcglossary/turn/)).
- OVEVENTS sits on a managed corporate network.
- A relay also means the station sends ONE copy however many staff listen, which keeps load off the air machine.

**The relay: MediaMTX** (single program, open source):
- Takes WebRTC publish and play.
- Has a fixed UDP port and an optional TCP port for firewalled clients ([MediaMTX WebRTC docs](https://mediamtx.org/docs/usage/webrtc-specific-features)).
- Supports HTTP/JWT auth, so it can ask our server whether this phone is logged in ([GitHub](https://github.com/bluenviron/mediamtx)).
- Alternatives considered: LiveKit and mediasoup are larger systems built for conferencing ([LiveKit docs](https://docs.livekit.io/transport/self-hosting/benchmark.md)). Not needed for one station → a few listeners.

## Proposed design

```
OVEVENTS                                   Lightsail (next to Icecast)          staff phone
Rust mixer ──try_push──► MONITOR tap ──► ffmpeg (own process, Opus, WHIP) ──► MediaMTX ──WebRTC──► Park page "Listen"
          (after fader + MUTE, + AUX)    127.0.0.1                         auth → ether-backend (logged in?)
```

**Air-chain safety:**
- The tap copies only with `try_push` and drops when full, exactly like the stream tap. It runs only while someone is listening.
- The sender is its own ffmpeg process. If it fails or the internet drops, the speakers, playout and the Icecast stream don't change.
- The DSP parity goldens must still pass bit-exact (the tap reads, never writes).

**Volume:**
- The phone plays with an ordinary audio element, so the phone's own volume keys set it.
- The page sends nothing about volume, ever. The fader and MUTE remain the only park controls.

## What it needs

**On OVEVENTS (a new station build, installed by Jeff):**
1. A MONITOR tap in the Rust engine: after the level and MUTE, the main device plus AUX as Jeff confirms. It is a native change.
2. A "Park listen" sender in the daemon: starts ffmpeg (Opus → WHIP) only when the server says someone is listening, and stops when nobody is.
3. Settings in Preferences (each a visible number): Opus bitrate, sender frame size, and on/off for this station.

**On the server:**
4. MediaMTX on the Lightsail box. Open its UDP port (and a TCP port) in the Lightsail firewall.
5. `ether-backend`:
   - a "listen ticket" for a logged-in Park session;
   - MediaMTX's auth check calls it;
   - it tells the station to start or stop sending.
6. A station setting for the listener's buffer (`jitterBufferTarget`), shown in Preferences and sent to the page.

**On the Park page:**
7. The LISTEN button, the ticket, a WebRTC/WHEP player, and "Listening" while on.

## Delay

- **Expected:** well under 1 s, from the sources above (Opus 20 ms frames, a jitter buffer of tens of ms, plus the network).
- **NOT MEASURED.** It will be measured after building, the same way as the stream delay (docs/stream-delay-2026-10-13.md): match what the phone plays against Ether's own output.

## Needs Jeff

- Which output(s) on OVEVENTS feed the park speakers (main MONITOR device, AUX device, or both)?
- Approval of this plan, of installing MediaMTX on the Lightsail stream server, and of a new OVEVENTS build.
