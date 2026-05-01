# Phase A — Amendment 4: Ether Bus Architecture

**Status**: Locked  
**Authored**: 2026-05-01  
**Supersedes**: Audio routing approach in Amendments 1–3; Pieces 1/2/2.5 audio device model reframed below  
**Next action**: Phase B1 implementation (after doc review)

---

## Section 1 — Why This Amendment Exists

### The current state is architecturally confused

The investigation conducted immediately before this document produced the following findings. They are stated plainly because the fix must be grounded in the actual state of the code, not an idealised version of it.

**Playout decks** have a working Rust audio engine path. Each station has one `OutputStream` (via rodio + cpal) and three `Sink`s (decks A/B/C). The per-station output device is selectable and hot-swappable (Pieces 1/2/2.5). This is the only audio path in Ether that actually works end-to-end.

**CueEditor, StudioEditor, and StudioPro** all use the browser's `AudioContext` API. They route to `ctx.destination`, which is whatever the OS default output device is at runtime. There is no isolation between editor playback and the broadcast chain. An operator editing content in StudioPro while a deck is on air shares the same output device as the deck — there is no architectural boundary preventing editor audio from conflating with the broadcast signal.

**MicDeck** opens a `getUserMedia` mic stream and routes it through a Web Audio EQ chain into an `AnalyserNode` for level metering. The `AnalyserNode` is not connected to `ctx.destination`. The mic audio goes nowhere: the operator does not hear it, and it does not reach the streaming encoder. The comment in the source *"Also send to native engine for actual broadcast path"* calls `ether.audio.setEq("mic", bands)`, which sends EQ parameter values, not audio. The `audioSetEq` function is not exported from the Rust NAPI module. The mic deck is meters-only.

**Master EQ (`eq.rs`)** is a complete and correct 10-band graphic EQ implementation with biquad peaking filters and a real-time FFT spectrum analyzer (`EqChain`), plus a rodio `Source` adapter (`EqSource<S>`). None of it is connected to the audio pipeline. In `audio.rs`, decoded audio goes directly from `UniformSourceIterator` into `Sink::append()` without passing through `EqSource`. `audioSetEq` is not exported as a `#[napi]` function. The MasterEQRack UI sends values into a silent void.

**Streaming** has no working path. The file-based streaming architecture (ffmpeg reading tracks directly from disk, hardware-independent) that was functional at commit `531b2b3` was removed during Piece 3. Piece 3 replaced it with a Windows DirectShow device-capture approach that is architecturally incorrect — DirectShow captures physical input devices, not output devices, and does not function on development machines without virtual audio cable software. The streaming feature is currently broken.

**MultiOutputPanel.tsx** is aspirational UI built ahead of its backend. It has the right conceptual model — per-deck routing plus Monitor and Master outputs. It calls `invoke("list_audio_output_devices")` and `invoke("set_deck_output", ...)`. Neither IPC handler exists in `main.js`. The component saves a routing JSON blob to `station_config_kv`, which nothing reads. The UI data model it describes is exactly what this amendment formalises; the component itself will be superseded.

**The "Audio Devices" section in SettingsPanel** presents a device picker for "Where music plays" and "Your microphone." Clicking a device sets React local state and shows an "ACTIVE" badge. There is no persistence call, no IPC call, no effect on the Rust engine. The selection is lost on remount. This section is cosmetically functional and operationally inert.

### The principle

Ether is a broadcast system. Real broadcast systems have bus architecture. At minimum: Program, Audition/Cue, and Monitor buses have been standard in broadcast consoles since the 1970s. Their purpose is physical safety separation — cue audio cannot reach listeners; editor audio cannot reach listeners; these are architectural properties, not operator policies.

The current single-output-per-station model conflates Program Bus (what listeners hear) with Studio Monitor Bus (what the operator hears) into one undifferentiated stream. This is unsafe for a system positioning itself as professional broadcast automation software.

### The constraint

Ether's job is to be compatible with whatever soundcards are connected. Ether enumerates hardware via cpal, exposes the device list to the operator, lets the operator route buses to devices, and gets out of the way.

Ether does not invent virtual cables. It does not require special drivers. It does not assume professional audio infrastructure beyond what the operator's machine actually has. A customer with a prosumer interface, a broadcast card, or an AoIP card all run the same Ether binary — the software adapts to what cpal sees.

A customer with a single onboard Realtek chip gets fewer routing options (one physical output means Program Bus and Studio Monitor Bus land on the same speakers), but the software still works correctly and makes the constraint visible. A developer machine with one audio output can still stream via the in-memory path — streaming has no hardware dependency.

---

## Section 2 — The Bus Model

Per station, Ether maintains the following in-memory audio buses. Each bus is an independent mix with its own gain, EQ, limiter, metering, and output routing.

### Program Bus

The live broadcast feed. The **only** input the streaming encoder sees. Listeners hear exclusively what is routed to this bus.

- **Default sources**: playout decks, mic when operator is live
- **Streaming**: mandatory consumer — Program Bus samples go to ffmpeg via in-memory pipe
- **Hardware output**: optional — an operator may route Program Bus to a device for transmitter feed or external monitoring, or may leave it hardware-unrouted
- **Safety property**: Program Bus is the only bus the streaming encoder reads from. This is architectural. There is no code path from Cue Bus or Editor Bus to the streaming encoder.

### Studio Monitor Bus

What the operator hears in the room.

- **Default sources**: follows Program Bus sources by default; operator can configure independently
- **Hardware output**: required for this bus to be audible — operator selects their main speakers or broadcast console in Audio Settings
- **No streaming**: Studio Monitor Bus output never reaches the encoder

### Cue / Pre-listen Bus

Audition audio for cuing tracks, aligning transitions, and previewing edits before air.

- **Default sources**: cue editor playback, sources flagged "send to cue"
- **Hardware output**: operator's headphones (typically a different device from Studio Monitor)
- **Safety property**: Cue Bus cannot reach the streaming encoder. Architecturally impossible.

### Editor Bus

DAW and editor playback for content production. Isolated from broadcast.

- **Default sources**: StudioPro, StudioEditor playback
- **Hardware output**: operator's choice — often same device as Studio Monitor in single-operator setups, but can be separate
- **Safety property**: Editor Bus cannot reach the streaming encoder. Architecturally impossible.

### Video Broadcast Bus (Video Program)

The audio that accompanies a live YouTube / Twitch / RTMP video stream. May carry the same content as Program Bus or be independently configured.

- **Default sources**: same as Program Bus (playout decks + mic) — operator can override to route differently from the audio-only stream
- **Hardware output**: optional — can route to a device the external video encoder captures from, or fed in-memory directly to Ether's video encoder pipeline (same architectural pattern as Program Bus streaming: in-memory, no hardware involvement required)
- **RTMP destinations**: per-station, up to 4 RTMP destinations (consistent with the existing video studio implementation)
- **Relationship to Program Bus**: independent mix. An operator running music radio + video commentary can send deck audio to Program Bus and a different source mix (mic-heavy, music underneath) to Video Broadcast Bus. Or they can be identical.
- **Safety property**: Video Broadcast Bus is consumer-facing like Program Bus, but its consumers are RTMP video encoders, not audio-only Icecast. The streaming encoder for Icecast reads only Program Bus; RTMP video reads only Video Broadcast Bus.

### Per-bus features

Every bus has:
- Independent gain control
- Independent EQ (MasterEQRack wired per-bus; default applies to Program Bus)
- Independent limiter/clipper
- Independent metering and VU
- Independent hardware device routing (zero or one cpal output stream)

---

## Section 3 — Sources and Routing

An audio source is any component in Ether that produces audio samples. Each source has routing controls specifying which buses receive its output.

**Current sources:**

| Source | Logical bus | Default routing |
|---|---|---|
| Playout Deck A | Program + Studio Monitor | Program Bus + Studio Monitor Bus + Video Broadcast Bus |
| Playout Deck B | Program + Studio Monitor | Program Bus + Studio Monitor Bus + Video Broadcast Bus |
| Playout Deck C | Program + Studio Monitor | Program Bus + Studio Monitor Bus + Video Broadcast Bus |
| Cue Editor | Cue | Cue Bus |
| Studio Editor | Editor | Editor Bus + Studio Monitor Bus |
| StudioPro | Editor | Editor Bus + Studio Monitor Bus |
| Mic Deck | Program + Video when live | Program Bus + Video Broadcast Bus when operator engages mic; off otherwise |
| Video Suite | Video Broadcast | Video Broadcast Bus + Studio Monitor Bus; Program Bus when operator routes it |

**Planned future sources**: jingle carts, satellite feed, network audio receiver, additional mic inputs, plugin instruments.

Defaults are sane for common workflows. An operator can override per source. The UI for overrides is per-source bus-flag controls (bus send toggles alongside each source panel). These are collapsed by default; the defaults cover the majority of setups without operator configuration.

---

## Section 4 — Bus Output (Consumers)

Each bus's mixed output goes to zero or more consumers:

### Hardware device (cpal Stream)

The bus's mixed samples are written to a chosen physical audio output device. This is optional per bus. A bus may have no hardware output — Program Bus in a streaming-only configuration is hardware-unrouted and feeds only the streaming encoder.

Device routing uses the hot-swap mechanism from Pieces 2/2.5: a `SwitchDevice` command sent to the bus's dispatch thread causes the `'outer: loop` to reopen with the new device without tearing down the bus state.

### Streaming encoder (Program Bus only)

Program Bus samples go to ffmpeg via an in-memory pipe (process stdin or a local loopback socket). ffmpeg encodes to MP3 (128 kbps, 44100 Hz, stereo) and pushes to the station's Icecast mount.

This path is entirely hardware-independent. It works on a headless server, a cloud instance, or a development laptop with one audio device. The streaming encoder never reads from a hardware device. There is no DirectShow, no dshow capture, no virtual cable requirement.

### RTMP video encoder (Video Broadcast Bus only)

Video Broadcast Bus samples feed into Ether's video encoder pipeline via the same in-memory tap pattern as Icecast streaming. The video encoder combines the audio feed with the video source and pushes to up to 4 RTMP destinations per station (YouTube, Twitch, custom RTMP, etc.).

This path is also hardware-independent. The audio component of the video stream never passes through a hardware device unless the operator explicitly routes Video Broadcast Bus to one (for external encoder capture scenarios). In-memory is the default and preferred path.

### Future consumers

File recording to disk, secondary audio stream (different codec/bitrate), send-to-monitoring-system. These are not in scope for Phases B1–B6 but the bus tap architecture accommodates them naturally.

---

## Section 5 — Audio Settings UI Restructure

The current "Audio Devices" section in SettingsPanel.tsx is replaced by a bus-oriented layout. This is Phase B5 work (see Section 6), but the target state is specified here to make implementation intent clear.

### Target layout (per station)

```
Audio Outputs

  Program (Live Broadcast)         [▼ device or "(unrouted)"]
  Goes to the Icecast streaming encoder. Listeners hear ONLY this
  bus. Optionally also outputs to a device for transmitter
  monitoring. Leaving this unrouted is normal for streaming-only
  setups.

  Video Broadcast                  [▼ device or "(unrouted)"]
  Audio for YouTube / Twitch / RTMP video stream. Independent
  mix from Program — can carry the same sources or different.
  Feeds the video encoder pipeline in-memory. Optionally routes
  to a device for an external video encoder to capture.

  Studio Monitor                   [▼ device]
  Your main room speakers. What you hear while on air.

  Cue / Pre-listen                 [▼ device]
  Headphones for cueing tracks and previewing edits before air.

  Editor                           [▼ device]
  DAW and editor playback. Isolated from broadcast.

Audio Inputs

  Microphone                       [▼ device]
  (Additional inputs: added as implemented)

Source Routing    [▼ collapsed by default]
  Shows which buses each source feeds. Adjustable per source.
```

### What this replaces

- "Where music plays" / "Your microphone" in the current SettingsPanel Audio section — removed
- `MultiOutputPanel.tsx` — superseded; its data model is absorbed into the bus matrix
- `AudioDevices.tsx` — superseded
- `AudioRoutingPanel.tsx` (Pieces 1/2/2.5) — reframed as Studio Monitor Bus device picker; its implementation (DB key `audio_output_device`, `audio_set_output_device` NAPI call) is reused for the Studio Monitor row

The database schema does not change for Phase B5. Studio Monitor device selection continues to write `audio_output_device` to `station_config_kv`. Other bus device selections write new keys (`program_output_device`, `cue_output_device`, `editor_output_device`, `video_broadcast_output_device`) in the same table.

---

## Section 6 — Implementation Phases

Phases are independent pieces with independent verification gates. Each phase ships when verified; subsequent phases do not depend on a specific release date.

### Phase B1 — Rust bus architecture core (v3.1.0 target)

**Scope**: Replace `audio.rs`'s single-output model with a `BusMixer` that maintains Program Bus and Studio Monitor Bus as independent mix paths per station. Wire `EqChain` into the Program Bus path so MasterEQRack produces audible effect. Restore streaming via in-memory pipe (Program Bus → ffmpeg → Icecast).

**Changes**:
- `native/src/audio.rs`: Introduce `BusMixer` struct. Each source (deck A/B/C) feeds samples to its routed buses. Program Bus has a ring buffer tapped by the streaming thread. Studio Monitor Bus feeds a cpal `OutputStream`.
- `EqSource` from `eq.rs` wired into Program Bus signal path.
- `native/src/lib.rs`: Add `audio_set_bus_device(station_id, bus_name, device_name)` NAPI function (Studio Monitor Bus replaces the existing `audio_set_output_device` semantics).
- `electron/main.js`: Restore file-based streaming as an interim consumer of the Program Bus tap (ffmpeg reads decoded PCM from the ring buffer drain thread). Remove dshow code entirely.
- Existing `SwitchDevice` command preserved; now applies to the named bus.

**Verification gate**:
1. Deck plays, audible on Studio Monitor device.
2. Stream goes live → ffmpeg receives samples via in-memory pipe → Icecast serves audio → listener browser plays it.
3. Dragging MasterEQ band slider produces audible frequency change in the output.
4. Switching Studio Monitor device mid-play does not interrupt playback (Piece 2.5 behaviour preserved).

### Phase B2 — Cue path through Rust

**Scope**: CueEditor stops using browser `AudioContext`. Decoded audio samples are sent to Rust via NAPI. Rust routes them to Cue Bus. Cue Bus outputs to operator headphones device.

**Changes**:
- `CueEditor.tsx`: Replace `AudioContext` playback with IPC calls to a new `audio_cue_play` / `audio_cue_stop` NAPI surface.
- `native/src/lib.rs`: Add cue source management to `BusMixer`. Cue Bus device configurable.

**Verification gate**: Cue editor plays through the configured headphones device only. Audio is absent from Studio Monitor output. Audio is absent from the stream.

### Phase B3 — Studio Editor / StudioPro path through Rust

**Scope**: StudioEditor and StudioPro stop using browser `AudioContext`. Decoded mix is sent to Rust. Rust routes to Editor Bus.

**Changes**:
- `StudioEditor.tsx`, `StudioPro.tsx`: Replace `AudioContext` with a streaming PCM send mechanism to Rust. The export (OfflineAudioContext → WAV) path in StudioEditor is unaffected.
- `native/src/lib.rs`: Add editor source to `BusMixer`. Editor Bus device configurable.

**Verification gate**: DAW playback through Editor Bus device. No audio on stream. An operator can edit a session while a deck is on air without the edit audio affecting the broadcast.

### Phase B4 — Mic Deck through Rust

**Scope**: Fix the broken MicDeck. Wire the captured mic stream into Rust (via NAPI audio buffer push). Rust routes to Program Bus when operator engages mic.

**Changes**:
- `MicDeck.tsx`: Keep `getUserMedia` for capture and level metering. Add a PCM push loop that sends captured mic frames to Rust.
- `native/src/lib.rs`: Add mic source to `BusMixer`. Mic routes to Program Bus when active; off otherwise. Mic EQ (`eq.rs`) wired here for the mic path.

**Verification gate**: Operator activates mic → voice is audible in stream → voice is audible on Studio Monitor → voice is absent from Cue Bus and Editor Bus playback.

### Phase B5 — Audio Settings UI restructure

**Scope**: Replace current cosmetic "Audio Devices" section with the bus matrix UI described in Section 5. Connect to Rust bus routing. Remove `MultiOutputPanel.tsx` and `AudioDevices.tsx`.

**Changes**:
- `SettingsPanel.tsx`: New bus matrix section (Program/Studio Monitor/Cue/Editor device pickers).
- DB: New `station_config_kv` keys for `program_output_device`, `cue_output_device`, `editor_output_device`. Existing `audio_output_device` key maps to Studio Monitor.
- `AudioRoutingPanel.tsx`: Merge into the new settings section or keep as a separate quick-access widget in the sidebar (decision at implementation time).
- Delete `MultiOutputPanel.tsx`, `AudioDevices.tsx`.

**Verification gate**: Each bus device picker selects a device and the audio actually routes there. Settings persist across restarts. UI is coherent and labels are honest about what each bus does.

### Phase B6 — Per-source send control UI

**Scope**: Operator-facing controls for adjusting which buses each source feeds. The defaults from Section 3 are the sane starting point; this phase adds override capability.

**Changes**:
- Per-source bus-send toggle UI (small, collapsed by default).
- Persisted to `station_config_kv` per source.
- `BusMixer` routing table updated when operator changes sends.

**Verification gate**: Operator removes Deck A from Program Bus → deck plays on Studio Monitor only, absent from stream. Operator restores it → stream resumes with Deck A.

---

## Section 7 — What This Replaces and Deprecates

**Replaced by the bus matrix (Phase B5)**:
- `SettingsPanel.tsx` "Audio Devices" section — cosmetic device picker, operationally inert
- `MultiOutputPanel.tsx` — aspirational UI with no backend; data model absorbed
- `AudioDevices.tsx` — earlier iteration of device enumeration UI

**Reframed, not removed**:
- `AudioRoutingPanel.tsx` and the `audio_set_output_device` NAPI call — these target what Phase B1 calls the Studio Monitor Bus device. The code is preserved; the framing changes from "the engine output" to "Studio Monitor Bus device." The DB key `audio_output_device` is preserved.
- `SwitchDevice` command in `audio.rs` — preserved, extended to operate per named bus.

**Removed**:
- DirectShow (dshow) streaming code introduced in Piece 3 — fundamentally wrong architecture
- `_streamFile()`, `_streamSilence()` file-based streaming (working but gap-prone) — superseded by Program Bus in-memory tap in Phase B1
- `playout:track-started` IPC listener used for file-based streaming — removed
- Any remaining TCP+amix streaming code — removed

The `eq.rs` module and all its types (`EqChain`, `EqSource`, `SharedEq`, `new_shared_eq`) are **not** removed — they are wired into Phase B1 for the first time.

---

## Section 8 — Constraints

These are absolute. They do not bend for implementation convenience.

- Ether enumerates output and input devices via cpal. Ether exposes that list to the operator. Ether routes buses to whatever the operator selects. Period.
- No virtual cable installation is required or assumed.
- No special audio drivers are required beyond what cpal supports out of the box (WASAPI on Windows, CoreAudio on macOS, ALSA/PipeWire on Linux).
- No professional audio infrastructure is assumed. An operator with a single onboard audio chip gets fewer routing options; the software still works and makes the constraint legible.
- The streaming path involves zero hardware devices. It is entirely in-memory (Program Bus ring buffer → drain thread → ffmpeg stdin → Icecast). It works on headless servers, cloud VMs, and development machines with no audio output at all.
- An AoIP card (Dante, Ravenna, AES67) appears to cpal as one or more standard output devices. Ether treats it identically to a USB audio interface.
- A machine with multiple physical outputs (broadcast console with separate mix bus outputs, USB audio interface with 8 channels exposed as multiple stereo pairs) is supported naturally: each appears as a selectable device.
- A developer running on a laptop with Realtek onboard audio can stream (in-memory path) and hear Studio Monitor on the laptop speakers. The architecture degrades gracefully, not catastrophically.

---

## Section 9 — Version Targets

| Version | Phase | What ships |
|---|---|---|
| v3.1.0 | B1 | Program Bus + Studio Monitor Bus in Rust. EQ wired. Streaming via in-memory pipe. Decks verified end-to-end. |
| v3.2.0 | B2–B4 | All audio sources through Rust. Cue / Editor / Mic bus separation real and verified. |
| v3.3.0 | B5–B6 | Audio Settings UI restructure. Per-source send controls. |

Phase B1 is the critical path. Phases B2–B4 are independent of each other and can be parallelised or reordered. Phase B5 depends on B1–B4 for the device pickers to have real backends. Phase B6 depends on B5.

---

*End of Amendment 4*
