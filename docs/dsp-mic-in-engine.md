# The mic as a real engine input (proposal, 2026-09-26)

**Status:** PROPOSAL, nothing built. Dev only, branch `log-reader-flip`.

**Jeff's ruling:** the mic must be a real engine input, so that the channel rack (slice 5), the meters
(slice 2), the ON/OFF cut, the ducker and, in slice 6, the gate and compressor all apply to it.

**Governing docs:**
- `docs/mic-routing-verdict-2026-07-09.md`: the mic is Web Audio only and never reaches the mixer or the
  stream.
- `docs/dsp-channel-rack-eq.md`: the channel rack, the one-path Params rule and the timing gate.
- `docs/dsp-meter-bus.md`: pre-fader taps.
- `docs/showplus-device-layer-design-2026-07-27.md`: renderer capture has no device broker.
- Memory rules:
  - **"faders are generic, no dedicated deck for anything"**;
  - **"device pickers belong in Preferences"**;
  - **"build the sense, not the scaffold"**;
  - **"robustness: never strand a user on a migration"**.

---

## What is there today (receipts)

| Where | What |
|---|---|
| `MicChannel.tsx:40` (deck type `mic`) | `getUserMedia` → gain → `ctx.destination`. Its volume is React state only (`:13`, `:72`). It never reaches the engine. |
| `MicDeck.tsx` (`App.tsx` widgets) | `getUserMedia` → a 10-band Web Audio EQ → `ctx.destination`. This is the "mic input EQ (browser audio)". |
| `SourceChannelStrip.tsx:285-286` (a source channel patched to a mic) | Captures in Web Audio too, and meters `micLevel` in the renderer. **The strip has an engine slot, but the mic audio never enters it.** |
| `ctx.destination` | The browser's **default** output, not the station's output device. The mic reaches the operator's speakers, and **never the programme bus, the stream or the air chain**. |
| Engine | **There is no cpal input stream anywhere** (`grep build_input_stream` returns nothing). |
| A deck's feed (`rt.rs:84` `DeckFeed`) | Already a lock-free ring, with `eof` telling an **underrun** (the producer is late) apart from the **end** (the producer is done). |
| Clock-domain precedent | The AUX output (`audio.rs:2425-2560`) already crosses two device clocks. It resamples on the consumer side and nudges the ratio at most ±0.3 % toward a target ring fill, never dropping samples. |

---

## 1 · Capture in the daemon

### Which slot: a generic source channel, not a MIC slot

**The mic is a patch point on a source channel (D–F, S1–S5), exactly as a jukebox or an announcement is.**
There is no dedicated MIC slot.
- This follows the standing rule (faders are generic, the Wheatstone model) and the concept the UI already
  has: `SourceChannelStrip`'s patch dropdown already offers "mic".
- **What the slot gets for free:**
  - its kind is `Source`, so it can **arm the ducker**;
  - it gets its own pre-fader meter tap, its own channel rack, and its ON/OFF cut;
  - it gets its own reported state. This relies on today's fix `6977334`; before it, an S slot reported as
    deck B.
- **Several mics:** each mic is a separate source channel (up to 8 today: D–F and S1–S5). That removes
  MicChannel's separate "up to 6 mics" machinery.

### The feed: a *live* `DeckFeed`

- **The same ring type a decoded file uses**, with the producer swapped: the **cpal input callback** instead
  of a decoder worker.
- **`eof` is never set**, so an empty ring is always an **underrun**: counted, drawn as silence, and it never
  ends the channel. The deck loop already treats an underrun this way.
- **Mono ring.** A mic is mono. The input callback pushes the **one chosen input channel**, and the mixer
  spreads it to L and R at equal level; the fader law does the rest. A stereo pair (a line input) is a later
  option, not v1.

### Sample rate: the device rate → 44.1 k, on the consumer side

- **Where:** the ring carries **device-rate** samples. The mixer callback pulls them through a **resampler
  owned by that slot**. This is the AUX pattern, reversed.
- **Drift handling:** the step is nudged by at most ±0.3 % toward a **target fill**, so two free-running
  clocks never drift into an underrun or into growing latency. **No samples are dropped.**
- **Why not a middle thread:** a worker between the input and the mixer adds a thread wake-up of latency,
  and a non-RT thread on the air path. The consumer-side resampler costs no thread and no latency.
- **Quality:** a **polyphase windowed-sinc** (for example 32 taps; the table is precomputed when the stream
  is opened), not the linear interpolation the AUX monitor uses.
  - The mic goes **to air**. Linear 48 → 44.1 k interpolation leaves imaging near −40 to −50 dB. That is fine
    for a monitor feed and not for a voice on air.
  - The cost is measured (§7); by arithmetic it is small, about 15 k multiply-adds per slot per buffer.
  - **→ Decision Q2.**
- **Stale audio:** if the output stream stops (a device reopen), the input keeps writing and the ring fills.
  - That overrun is counted, and further input is discarded, not queued.
  - **When the mixer resumes, it discards down to the target fill before playing.** A mic must never come
    back seconds late.

### RT safety

**The input callback:**
- runs under `RtScope` + `FtzScope`, like both output callbacks;
- only converts the device sample format (i16, i32 or f32) per sample, picks the channel, and calls
  `push_iter` into the ring;
- allocates nothing and takes no lock;
- on a **full ring** it drops the **incoming** block and increments an **overrun** counter. A producer
  cannot drop the oldest samples.

**The mixer callback:**
- the resampler state, taps and history are preallocated per slot, **when the input is opened on the
  dispatch thread**;
- the callback only runs them.

**Opening and closing are commands:**
- Opening a device, building the stream and allocating the ring happen on the **dispatch thread**.
- The consumer end reaches the callback in the existing `RtCmd::Load`-style handoff: a `DeckFeed` in a Box,
  with the old one returned as `Garbage` and dropped off the audio thread.
- This is the Slice 1 one-path rule, unchanged.

---

## 2 · Latency

All numbers here are **ESTIMATES** from the buffer arithmetic. The first build measures them (§6). A
one-way path is **input buffer + ring target + mixer/output buffer + output device buffer**. The rack is
IIR (biquads) and adds **no** latency.

| Stage | Default (cpal `BufferSize::Default`, WASAPI shared) | Fixed 480 frames |
|---|---|---|
| Input period | ~10 ms (the Windows engine period) | 480 @ 48 k = 10.0 ms |
| Ring target fill (drift headroom) | ~1 mixer buffer ≈ 10.9 ms | ≈ 10.9 ms |
| Resampler group delay | ~0.3 ms (32-tap) | ~0.3 ms |
| Output buffer (mixer runs per output buffer) | ~10–20 ms | 480 @ 48 k = 10.0 ms |
| **Mic → speakers/headphones** | **≈ 30–45 ms** | **≈ 30 ms** |

- **What that means for talent.** Hearing your own voice late in headphones:
  - under ~10 ms is not noticed;
  - 10–20 ms sounds hollow or phasey;
  - **over ~25–30 ms is a distracting echo**.

  Shared-mode WASAPI can't go much below ~20–25 ms, because the Windows engine period is ~10 ms each way.
  **Engine-path headphone monitoring is therefore not good enough for talent self-monitoring**, at any
  buffer size in shared mode.
- **Can PFL / monitor be "direct" while air is processed?** Not usefully, inside the engine. The latency is
  the **buffers**, not the processing: the rack costs nothing in time, and slice 6's gate and compressor
  should be zero-lookahead for the same reason. A "direct" in-engine path would skip the rack and save
  **~0 ms**.
- **The real low-latency path is the interface's hardware direct monitor**, where talent hears the mic
  in-hardware, near zero, mixed with the programme return.
  - **Recommendation:** document it in the help as the way to monitor your own voice.
  - The engine's monitor/PFL of the mic stays for the **operator**: checking the processed sound, not
    speaking into it.
  - **→ Decision Q3.**
- **Air latency** (mic → stream) adds the stream's own buffering, which is seconds. It doesn't matter to
  listeners. It only matters when talent monitors **off air** (the stream), which they must not do.
- **Today's Web Audio path:** its latency is **UNVERIFIED**. It is Chromium's default "interactive" latency
  on the default device, unmeasured. The new path is measured before it replaces it.

---

## 3 · What the mic's channel gets, and what goes

| The mic's source channel gets | How |
|---|---|
| Pre-fader meter (slice 2) | `ch[i]`, post-trim and pre-rack. It is the engine's measurement, so `micLevel` in the renderer goes. |
| Channel rack (slice 5) | Filters + PEQ, exactly as any fader. **Slice 6's gate and compressor follow**, and the gate is what makes an open mic usable. |
| ON / OFF cut | `SetMuted`, the same as every channel. |
| Ducker as a source | `Source` kind. **The duck detector reads the post-rack, post-fader signal** (`audio.rs:3598`, the same `lv/rv` as the mix). So **slice 6's gate will govern ducking by construction**, and room noise under the gate cannot hold the music down. |
| **Input gain (mic trim)** | **NEW.** `gain_db` today is a *file's* loudness trim, carried by a load (`audio.rs:2705`). A mic has no load, so it needs an operator **input gain** before the rack, for example −10 to +40 dB. **→ Decision Q4** on the range. |

**Removed:**
- `MicChannel.tsx`;
- `MicDeck.tsx` and its "mic input EQ (browser audio)" GraphicEQ (ruling);
- the Web Audio capture and `micLevel` in `SourceChannelStrip`.

The dedicated `mic` deck type then has no reason to exist.

**Migration (never strand a user):**
- A deck config of type `mic` on a **lettered** slot becomes a **source channel on the same slot, patched
  to its mic**.
- The dedicated `mic` slot (no engine slot) moves to the **first free source channel**. If none is free,
  the strip says so and offers the channel to free. It never silently drops the mic.
- The device each one had (`localStorage ether_mic_device_<slot>`, already machine-local) seeds the new
  machine-local key once.
- The `eq_deck_mic` bands are **not** migrated into the channel rack. It is a different EQ (10-band graphic,
  not the PEQ), and a guessed translation would change the sound. The help says so. **→ Decision Q5.**

---

## 4 · Device selection, persistence, loss, exclusive mode

- **Where it is chosen: Preferences → Audio I/O** (the "I/O config in Preferences" rule).
  - For each source channel patched to a mic: the **input device** and the **input channel** (1, 2, …).
  - The strip's patch dropdown then names what it carries ("MIC · Shure MV7 · in 1"). It doesn't pick
    hardware.
  - **Channel default:** 1, **shown** as the current value, never a hidden choice.
- **Persistence: per machine, never synced.** A device name belongs to a machine: another install doesn't
  have "Focusrite USB (2- 2i2)".
  - Proposed: a `station_config_kv` key family `mic_input_<slot>` = `{device, channel, gain_db}`, as a
    **LOCAL_ONLY prefix** (`electron/sync/handlers/station_config_kv.js:73`).
  - Written only through the sanctioned `set-local` writer (`:84`).
  - The daemon reads it in its 3 s poll, the same way it reads `rack_ch_*`, and re-opens on every engine
    start.
- **⚠ FINDING — the brief's premise does not hold in the tree.** "The same machine-local rule as the output
  device": **the output device is not machine-local in the code.**
  - It is stored as `station_config_kv` `audio_output_device` (written at
    `AudioRoutingPanel.tsx:131` and `StationMonitorMixer.tsx:75`; read at `AudioRoutingPanel.tsx:96` and
    `StationMonitorMixer.tsx:43`).
  - That key is **not** in `LOCAL_ONLY_KEYS` (`station_config_kv.js:69`), so by the code **it syncs**: one
    install's device choice would be pushed to the other, where that name may not exist.
  - Runtime **UNVERIFIED**. The check is two installs on one station, set the device on one, and read the key
    on the other.
  - **Not fixed here.** The mic key must not copy it. **→ Decision Q6:** make `audio_output_device`
    LOCAL_ONLY too, as its own change.
- **Identity:** cpal gives a device **name**, not a stable ID. The output device already lives with this.
  - Two identical USB mics can have the same name. Windows usually numbers them ("2- …"), but the number
    can change across replugs.
  - v1: match by the exact name, and **say so** when the saved name isn't present ("MV7 not found, the
    channel is silent"). Never fall back to the default input: a wrong mic on air is worse than none.
- **Device loss: counted, reported, never silent.**
  - cpal's input **error callback** (DeviceNotAvailable etc.) is counted.
  - The **ring runs dry**: counted as an underrun, drawn as silence on that channel. The channel is not
    ended, so the programme continues. **The music never stops because a mic was unplugged.**
  - A **re-open loop** runs on the dispatch thread (the output device already retries): it retries every few
    seconds, and re-opens the same device name when it returns.
  - **Senses (built in, in v1, per the standing rule).** Each mic channel reports:
    - device;
    - rate;
    - ring fill;
    - underruns, overruns, losses;
    - last reopen;
    - a **digital-silence detector**.

    These go to the Health Monitor and the ledger, and the strip shows a **NOT FED** hatch (slice 2's
    visual), not a flat zero.
  - **The Windows privacy trap: why the digital-silence detector exists.** When "Let desktop apps access your
    microphone" is off, Windows opens the stream **successfully and delivers exact zeros**.
    - The daemon is its own desktop process, not Chromium, so this setting applies to it separately.
    - Exact digital zero for ~5 s on an open input is reported as its own state: "the mic delivers pure
      digital silence: Windows microphone privacy, or the input is muted".
    - A real mic always has a noise floor, so exact zeros are a reliable tell.
- **Exclusive vs shared mode:**
  - **cpal 0.15 (`Cargo.toml:39`) opens WASAPI in shared mode.** I'm stating this from cpal's WASAPI
    backend, not from a test here.
  - **Shared is the right v1:**
    - Show+, voicetracking, Zoom and Chromium can all open the same mic at the same time;
    - the format is the Windows device format (typically 48 k), which the resampler handles.
  - **Costs of shared mode:**
    - the ~10 ms engine period each way (§2);
    - Windows **capture enhancements** (noise suppression, AGC) may run on the mic. The help tells operators
      to turn them off in Sound settings.
  - **Exclusive mode, or ASIO (cpal has an ASIO host behind a feature flag), is the lower-latency path**
    (~3–5 ms). It **locks the device** from every other app. Not in v1. **→ Decision Q7.**
- **Two stations, one mic:** each station's engine opens its own input stream (shared mode allows it). **One
  input stream per (station, device):** two channels in one station on the same device read the same
  stream. v1 allows **one channel per device per station**, and says so in the picker.

---

## 5 · Show+ and voicetracking

**Recommendation: leave Show+ and the voicetracker on Web Audio in v1.**

- **Show+** needs the mic inside a `MediaStream` together with the camera, for WebRTC and recording. The
  engine has no path from the engine to a MediaStream. Its device collisions are the separate broker design
  (`showplus-device-layer-design-2026-07-27.md`), not built.
- **VoiceTracker, StudioPro and ClipEditor** record to files through Web Audio / MediaRecorder. Nothing in
  them needs the engine to go live.
- **Shared mode is what makes this safe.** Chromium and the daemon can both hold the mic at once, on
  Windows shared-mode WASAPI. **UNVERIFIED on OV's managed box (McAfee);** check it there before shipping.
- **The follow-up worth doing (a later slice):**
  - voicetracks recorded from the engine's **post-rack mic tap**, written to WAV by a non-RT thread;
  - then a voicetrack carries **the same EQ, gate and compression as the live mic**, and a VT and a live
    break sound alike.
  - This is the only reason to move a recorder onto the engine, and it's a clean add-on once the live input
    exists.

---

## 6 · Verification

| Claim | How | Bar |
|---|---|---|
| **Level is right** | A loopback: a −18 dBFS 1 kHz tone from an output into the mic input (a loopback cable, or a virtual cable such as VB-Cable on the dev box). Read the mic channel's pre-fader meter. | Within ±0.5 dB of the level measured at the input with the input gain at 0 dB. The device's analog gain is the operator's, so calibrate once. |
| **The rack applies** | The same tone; HPF 100 Hz and PEQ +6 at 1 kHz on the mic channel; read IN vs OUT (`chPost`) and the programme. | The slice 5 values: +6.0 ± 0.1 dB at 1 kHz. |
| **Round-trip latency, measured** | The engine plays a click on a test deck → output → loopback → mic input → back into the programme. Record the programme bus and measure the lag between the click and its return. | A number, reported at the default buffers and at 480. No pass/fail until Jeff sets one (Q3). |
| **Drift is absorbed** | 60 min on the loopback at two different device clocks. | Ring fill bounded; 0 underruns after settling; ratio nudge within ±0.3 %. |
| **Unplug** | Pull the USB mic during playout on the dev box. | The loss is counted and reported in the Health Monitor and on the strip; **the programme keeps playing**; the mic channel is silent, not ended; replugging re-opens it. |
| **Privacy zeros** | Turn off "desktop apps may access the microphone". | The digital-silence state is reported within ~5 s. |
| **Nothing else changed** | No mic configured. | The 43 goldens bit-exact: no live feed means today's exact path. |

---

## 7 · Blast radius, harness, trap, timing

| Area | Change |
|---|---|
| `native/src/rt.rs` | A live `DeckFeed` (a ring with a producer handle, never EOF); input counters (underrun, overrun, loss, digital silence). |
| `native/src/audio.rs` | Per-station input streams (open, close, re-open on the dispatch thread); the consumer-side polyphase resampler with drift nudge in the deck loop, for live feeds only; the mono → L/R spread; the input gain; stale-flush on resume. |
| `native/src/lib.rs` | `audio_list_input_devices`, `audio_set_mic_input(station, slot, device, channel, gain_db)`, `audio_input_state(station)`. |
| `audiod/*` | The poll reads `mic_input_*` (LOCAL_ONLY) and re-opens on engine start; health events. |
| `electron/sync/handlers/station_config_kv.js` | `mic_input_` as a LOCAL_ONLY prefix. |
| `electron/main.js`, `preload.js` | IPC for the list, set and state. |
| `src/` | Preferences → Audio I/O mic inputs; `SourceChannelStrip` loses its Web Audio capture; `MicChannel.tsx` and `MicDeck.tsx` are removed; the deck-type `mic` migration; Health Monitor rows; help (`help-mic-input.md` new; channel EQ, meters and faders updated). |

- **Harness: there is no input device.** A unit test **proves the path from the ring onwards**, with a
  synthetic producer thread standing in for the cpal input callback:
  - a 1 kHz tone generated at **48 000 × (1 + 300 ppm)** (a deliberately wrong clock) into the live ring;
  - the level at `ch[i]` equals the generated level (±0.05 dB);
  - resampler spurs are below a stated bar (for example −90 dBFS for a −18 dBFS tone);
  - the fill stays bounded over 10 simulated minutes, with 0 underruns after settling;
  - the rack on the live slot measures as in slice 5;
  - stopping the producer counts **one** loss and underruns, the slot draws silence, and the **other slots
    stay bit-identical**;
  - an all-zero producer trips the digital-silence state;
  - new deterministic goldens for "a live source on S1" renders.

  **What a unit test cannot prove:** that cpal opens a real device, the real latency, Windows privacy, and
  unplug behaviour. Those are the §6 runtime receipts.
- **Allocation trap:**
  - `RtScope` wraps the **input callback** too;
  - 0 allocations over 10 simulated minutes, in both the input and the mixer callbacks;
  - opening and closing a device happens off the audio thread, so it isn't in the trap's scope.
- **Timing:** the slice 5 table gains rows for **1 and 5 live inputs, racks IN**. The gate stays p99 ≤ 1 ms
  per buffer, and the resampler's own cost is reported separately, as for the rack.

---

## Decisions for Jeff

1. **The slot.** A generic source channel patched to "mic" (recommended: the faders-are-generic rule), or a
   dedicated MIC slot?
2. **Resampler quality.** A polyphase windowed-sinc for the air path (recommended), or reuse the AUX's linear
   interpolation?
3. **Talent monitoring.** Hardware direct-monitor for your own voice (recommended, and documented), with the
   engine's monitor for the operator? Also: the latency bar the measured round-trip must meet, if any.
4. **Input gain range.** −10 to +40 dB proposed.
5. **`eq_deck_mic`.** Not migrated (recommended; a different EQ), confirm.
6. **`audio_output_device` syncs** (the finding): make it LOCAL_ONLY as its own change?
7. **Exclusive / ASIO.** Out of v1 (recommended)?
8. **Show+ / voicetracker** stay on Web Audio in v1 (recommended), with the post-rack VT recording as a
   later slice?

## What this deliberately does NOT build

- A stereo input pair.
- More than one channel per device per station.
- Exclusive mode or ASIO.
- An engine → MediaStream bridge for Show+.
- Engine-side voicetrack recording.
- Slice 6's gate and compressor. They arrive in their own slice and apply to this channel unchanged.


---

## Rulings (Jeff, GO 2026-09-26)

1. A normal source channel patched to "mic" (faders are generic).
2. The higher-quality sample-rate converter.
3. Talent monitors their own voice through the interface's **hardware direct monitor**. The engine's PFL is
   for hearing the processed sound. Document it. No latency limit yet: measure and report.
4. Input gain −10 to +40 dB.
5. The old mic EQ settings are not carried over.
6. The output device becomes machine-local, as its own commit first (`de8d833`).
7. Shared mode for v1.
8. Show+ and the voicetracker stay on browser audio. "Record voicetracks from the engine mic post-rack" is
   filed as a follow-up (`docs/backlog.md`).

## Build — commit 1: the output device is machine-local (`de8d833`)

- `audio_output_device` joins `LOCAL_ONLY_KEYS`, with the reason in the source.
- **What a synced value did:** the engine falls back to the **system default** when this machine has no device
  of that name, so another install's choice could silently re-route this machine's playout.
- **Both writers move to `set-local`** and read its answer. `upsertByKey` silently skips a local-only key, so
  leaving them would have lost every device choice without a sound.
- **Gates:** tsc 0 errors; vitest 468/468; undefined-calls, preload-bridge, ipc-contract and one-switch PASS.
- No engine change, so the goldens don't apply.

## Build — the engine

### `native/src/micin.rs` (new)

- **The input callback body (`input_block`):**
  - converts f32, i16, i32 or u16 per sample and picks the patched input channel;
  - pushes a mono device-rate ring;
  - `RtScope` + `FtzScope`; no allocation, no lock;
  - a block that doesn't fit is **dropped and counted** (overrun);
  - a run of exact digital zero is counted.
- **The consumer (`LiveIn::pull`, in the mixer callback):**
  - a polyphase windowed-sinc: 48 taps, Kaiser β 8, 256 phases interpolated, each row normalised to DC gain 1;
  - drift correction: the ratio is nudged at most ±0.3 % toward a target fill;
  - the fill is read through a **4 s average**. The fill jitters at the ~8 Hz beat between 10 ms input blocks
    and 10.9 ms pulls. A fast average turned that jitter into FM of the voice: **measured, spurs only 53 dB
    down**. At 4 s it is 93.5–95 dB down;
  - input gain −10 to +40 dB, ramped across one buffer (no zipper);
  - priming before the first sound;
  - **starvation = one counted event**, the rest of the buffer decays to silence, then it re-primes. It never
    ends the channel;
  - **stale audio** (the output stopped while the input kept writing) is discarded down to the target, so the
    mic never comes back late.
- **The manager (`MicInputs`, dispatch thread):** it owns every cpal input `Stream`, built and dropped on that
  thread.
  - **Opening:** by the exact device name, and **never falling back to the default input**.
  - **Refused opens:** "not_found", "bad_channel" (an input number the device doesn't have), and
    "unsupported" / "open_failed".
  - **Loss detection:** an error callback, or no input for 1.5 s, means the stream is dropped, counted and
    logged, and re-opened every 2 s.
  - **Digital silence:** exact zeros for 5 s is its own state. This is the Windows microphone privacy trap.
  - **Deck commands** (load, play, pause, stop) aimed at a mic slot are refused and logged once: the patch owns
    the slot.
  - Everything is logged as `[MIC] Station N Sx: …`.
- **The board:** a per-station registry of atomics and status, read by `audio_mic_state` without touching the
  engine.

### Other native changes

- **`rt.rs`:** `DeckFeed.live: Option<Box<LiveIn>>`, and `DeckFeed::live()`.
- **`audio.rs`:**
  - the deck loop's one pull point: a live feed fills `feed` and never ends. Files take the unchanged path;
  - `AudioCmd::SetMicInput`;
  - the dispatch thread's `MicInputs` (it outlives output-device reopens) and its tick;
  - `apply_mic_actions`: install = one `RtCmd::Play` carrying the feed; unpatch = `Stop`.
- **`lib.rs`:**
  - `audio_list_input_devices`;
  - `audio_set_mic_input(station, slot, device, channel 1-based, gain_db)`, which refuses A/B/C and CART
    (rotation/sweeper);
  - `audio_mic_state`.

### Wiring

- **`audiod/mic-input.js` (new, shared):** the key `mic_input_<slot>` = `{device, channel, gainDb}`, on source
  slots D–F and S1–S5, clamped.
- **`engine.js`:** a 3 s poll delivers patches; a fresh engine re-applies them; an unpatch unpatches; a refused
  patch is reported once.
- **`ether-audiod.js`:** `listInputDevices`, `setMicInput`, `micState`. They come from the daemon's cpal, never
  Web Audio.
- **main:** `mic:list-devices`, `mic:get`, `mic:set` (engine first, then `set-local`), `mic:state`.
- **preload:** `audio.listInputDevices`, `getMicInputs`, `setMicInput`, `micState`.
- **LOCAL_ONLY prefix `mic_input_`.**

### Receipts

**No mic configured:**
- goldens `[null]` 43/43 bit-exact; `[rack-null]` 43/43; `[ch-out-null]` 43/43;
- NAPI on the fresh `.node` `4397f024…3039`: **43/43**.

**Allocation trap, both callbacks:**
- the input callback body plus the live-feed pull × 2000 buffers (f32 and i16 input): **0**;
- the mic through the real `mixer_callback`: **0**;
- every timing row: 0.

**The wrong-clock drift test**, 10 simulated minutes, with the device clock deliberately wrong:

| Device | Clock error | Underruns | Overruns | Fill | Controller nudge |
|---|---|---|---|---|---|
| 48 k | +300 ppm | 0 | 0 | 19.8–30.5 ms | **+299 ppm** |
| 48 k | −300 ppm | 0 | 0 | 14.9–26.1 ms | **−299 ppm** |
| 44.1 k | +150 ppm | 0 | 0 | 18.6–29.7 ms | +149 ppm |
| 16 k headset | −200 ppm | 0 | 0 | 15.8–27.1 ms | −207 ppm |

The target fill is 22.9 ms in every case.

**Level and resampler cleanliness:**
- A 1 kHz −18 dBFS tone reads **−21.010 dBFS RMS**, exactly a −18 dBFS-peak sine, from 48 k, 44.1 k and 16 k.
- Spurs + noise: **95.0 / 93.5 / 93.5 dB below the tone** (bar 90).
- Analysis: a Kaiser β 20 FFT, with a measured floor 151.9 dB down. The ±16 Hz around the tone counts as the
  tone.

**Through the real mixer, the mic on S1 (48 k):**
- pre-fader meter −20.999 dBFS;
- programme (the stream) −21.010;
- **rack PEQ +6 @ 1 kHz → +6.000 dB**;
- input gain +12 → meter +12.000 dB and programme +12.000 dB, so the gain is pre-meter and pre-rack;
- two runs bit-identical.

**Loss:**
- 300 buffers with no input: silence (peak 0), **1** starvation event (not 300);
- input returns: full level again.

**Stale audio:** the output stalled 300 ms with the ring at 321 ms; it was flushed to 23.8 ms (the target) in
one flush.

**Channel pick, zero run, overrun, i16:** all asserted. **Gain:** 0 → +20 dB ramps across one buffer. **Range:**
−10 to +40 dB.

**Timing** (`test:rust` run, 2 threads, 480-frame buffers):

| Row | median | p99 | worst | rack CPU max |
|---|---|---|---|---|
| (a) 4 faders, racks IN | 0.075 | 0.128 | 0.540 | 0.075 |
| (b) 4 faders, 1 crossfading | 0.080 | 0.142 | 0.374 | 0.085 |
| **4 faders + 1 MIC (48 k), racks IN** | **0.108** | **0.215** | 0.374 | 0.102 |
| **4 faders + 5 MICS (48 k), racks IN** | **0.224** | **0.457** | 0.742 | 0.140 |

- A single-threaded run of the same test read 0.108 / 0.151 (1 mic) and 0.230 / 0.333 (5 mics).
- A mic costs about 0.03 ms per 10 ms buffer.
- **Gate p99 ≤ 1 ms: PASS.**

**Other gates:**
- `npm run test:rust`: 77 + 7 + 2 doctests;
- tsc 0 errors; vitest 469/469;
- `test:mic-input` 17/17 (new smoke);
- `test:rack-eq` 31/31; meter contract 30/30;
- undefined-calls, preload-bridge, ipc-contract and one-switch PASS;
- leak guard 13/13.

### Latency: the estimate corrected by the build

The ring target the controller holds is **one pull + the largest input block + 2 ms: 22.9 ms** at 480 / 480.
That's more than the §2 estimate of ~10.9 ms: the ring must hold a whole input block on top of a pull, or the
clocks' phase starves it.

| Path | Estimate at 480 in / 480 out |
|---|---|
| Mic → local output | input 10 + ring ~23 + output 10 ≈ **~43 ms** |

This is still an estimate. **The real number is the hardware loopback test (§6).** It confirms ruling 3:
talent hears their own voice through the interface's hardware direct monitor.

### What a unit test cannot prove (the hardware test)

- that cpal opens this machine's mic;
- the real round-trip;
- Windows privacy zeros;
- unplugging.

These are Jeff's hardware test on the dev app.
