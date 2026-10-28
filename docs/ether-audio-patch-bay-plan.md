# Ether audio Patch Bay — plan (2026-10-27) — PLAN ONLY, nothing built

**Jeff (verbatim):** "Plan only, no code. Write docs/ether-audio-patch-bay-plan.md covering four parts that work together,
so a user never needs Voicemeeter. Keep my four earlier Outputs answers (docs/outputs-section-plan-2026-10-27.md).
A. Patch Bay … B. Any app's sound as a source … C. Ether as a microphone other apps can pick … D. Remote Link as the VBAN
replacement … For each part: what already exists in the code, what's new, what the engine needs (including one output to
several devices), the risks, how it would be tested, and the questions I need to answer. No content or programming
decisions. The engine is compiled only when this computer is off air. Then stop and wait for me."

Governing docs: `docs/outputs-section-plan-2026-10-27.md` (Jeff's four answers, kept below unchanged),
`docs/audio-output-selectors-wiring-2026-10-27.md`, `docs/dsp-mic-in-engine.md`, `docs/remote-link-design-2026-09-28.md`,
the MONITOR rule (`docs/monitor-bypass-diagnosis.md`, 2026-10-07: every local output passes MONITOR; only PFL to a cue
device is exempt), and "faders are generic" (the SOURCE dropdown is the user's choice).

All "today" facts below are from the source tree (file:line). How the running app behaves is **UNVERIFIED** unless a
runtime receipt is named.

## Jeff's Outputs answers (2026-10-27) — kept, they bind Part A
1. **Master** is the existing main/monitor output, after the MONITOR fader, one per station. Renamed Master. No new output.
2. **Stalls:** a setting, "If the output device stalls, switch to the Windows default", on or off. Until the user sets
   it, warn on screen and keep retrying; never switch on its own.
3. **AUX** moves into Outputs (now: into the Patch Bay).
4. **Compile the engine only when this computer is off air.** Compiling with no installer is allowed then.
Plus: any device, channel pairs on devices with more than two channels, saved per computer, the screen shows the device
the engine actually opened, a missing device = a clear on-screen warning naming it, **no fallback**.

---

## Today, in one table (receipts)

| Thing | Today | Receipt |
|---|---|---|
| Audio API | cpal 0.15, WASAPI shared only. No ASIO (feature not compiled), no exclusive mode | `native/Cargo.toml`; `native/src/micin.rs:501` |
| Engines | One per station, all inside ether-audiod | `native/src/lib.rs:36-46`; `audio.rs:2914` |
| Master (today "Monitor", Station Monitors → OUTPUT) | One device. Its callback runs the station's mixer, so it is the station's clock. **Missing → Windows default, silently** | `audio.rs:3069`, `:3831-3855` (`found.or_else(default_dev)` `:3844`), callback `:3138` |
| AUX | One device; honest (`not_found`, retries, never another device) | `audio.rs:3026`, `:3933-4115` |
| PFL cue | One device, or "" = over Master; honest | `audio.rs:3027`, `:3325-3331` |
| Air | No device; ring → ffmpeg → Icecast | `audio.rs:2973-2980`; `audiod/ether-audiod.js:348` |
| Channels | Every output opened at the default config, capped at 2: `channels().min(2)` | `audio.rs:3849-3851`, `:4194-4196`; writers `localout.rs:97-104` |
| One output → several devices | **No.** One stream per bus; the AUX/cue thread services a fixed two-element array | `audio.rs:3025-3031`; board state `{output, aux, cue}` `:3388` |
| Device list | Names only, no channel counts | `lib.rs:971-983` |
| Stall switch | Two failures → Windows default (the 4.6.51 OV fix) | `outwatch.rs:19,23,86` |
| "What the engine opened" | Board state reports the REQUESTED name, not the opened one | `audio.rs:3388`; `audiod/board-state.js:269-270,365` |
| OS device-change notices | None subscribed; detection = stall/error/retry only | — |
| Inputs | A mic = one input channel of one device on a generic slot (D, E, F, S1-S5), never a fallback | `micin.rs:1-20`, `:417-436`, `:783-835`; `audio.rs:441-443` |
| Stereo inputs | Only the Link feed | `micin.rs:333-337` |
| Per-app / loopback capture in the engine | **None** | — (browser-side whole-system loopback exists for Captions/video only: `Captions.tsx:21-26`, `main.js:9614-9631`) |
| Virtual audio device | **None** | — |
| Pickers for the same outputs | Station Monitors → OUTPUT (`StationMonitorMixer.tsx:228`), **and a second one, the Pro "Multi-Output Audio Routing" panel** (`AudioRoutingPanel.tsx:182`, mounted `App.tsx:3228-3231`, `PopoutRenderer.tsx:284`), AUX rows (`AuxMonitorSlots.tsx:277`), PFL (`PflSettings.tsx:90`), mic (`MicInputsSettings.tsx:77,84` and the fader SOURCE dropdown `SourceChannelStrip.tsx:181-218`), Link (`RemoteLinkSettings.tsx`, `LinkPairPicker.tsx`) | — |
| Machine-local keys | `audio_output_device`, `aux_monitor_device`, `pfl_cue_device`, `master_monitor_volume`; prefixes `mic_input_`, `link_` — never synced | `electron/sync/handlers/station_config_kv.js:91,105` |
| Browser-only pickers (never reach the engine) | voice-track mic, phone hybrid input, Track Editor preview, Captions mic, PhoneDesk, Show+ output | `SettingsPanel.tsx:3159-3216`; `Captions.tsx:82`; `ShowPlus.tsx:1949-2042` |

---

## A. Patch Bay

### What it is
A pop-out window (the existing popout mechanism, `PopoutRenderer.tsx`), reachable from the hamburger menu (doors before
rooms) and from a pointer line where each removed picker used to be. Two grids:

- **Outputs grid.** Rows = Ether's outputs: Master, Cue/PFL, Aux, per station (Jeff's answer 1: Master is the existing
  output, one per station). Columns = every output channel pair on every device on this computer (a stereo device = one
  column "1-2"; an 8-channel interface = "1-2, 3-4, 5-6, 7-8"). Click a crosspoint to connect. One row may connect to
  several columns (several devices at once).
- **Inputs grid.** Rows = sources: each device input channel (and pair), app audio (Part B), Remote Link feeds (Part D),
  Park mics (`park:1`/`park:2`, already pseudo-inputs, `main.js:6776-6786`). Columns = source channels (D, E, F, S1-S5).
- Each connected crosspoint shows its state from the engine, naming the device: **live**, **opening**, **missing — <device
  name>**, **failed — <reason>**, **stalled**. No silent fallback anywhere.
- Saved per computer (machine-local keys, same rule as today). The daemon re-applies them on connect
  (`audiod/board-state.js:223-226`).
- **It replaces every other output and input picker** for engine audio: Station Monitors → OUTPUT, the Pro
  Multi-Output Audio Routing panel, the AUX device select, the PFL device select, Preferences → Mic inputs, the input
  devices on the fader SOURCE dropdown, the Link sender pickers. Each becomes a one-line pointer "Patched in the Patch Bay
  → <current patch>". Level/mute controls stay where they are (Jeff: keep Master's level and mute, including the Park
  page, working exactly as now).

### What's new
- Engine: per-output **list of destinations** (device + channel pair) instead of one device.
- Engine: real channel counts; write L/R into the chosen pair, silence into the rest.
- Engine: per-destination status (requested, opened, pair, state, rate, stalls), on the model of `CueStatus`
  (`audio.rs:3861-3891`), read by a new `audio:patch-state` and logged on each change (Health Monitor row + ledger).
- Engine: Master's not-found stops falling back; the stall switch becomes Jeff's setting (answer 2), off until set.
- Device list with channel counts (`audio_list_output_devices` / inputs).
- A stereo input pair as a source (today: one channel only).
- OS device-change notification (WASAPI `IMMNotificationClient`) so plug/unplug shows within a second instead of at the
  next stall. (Proposed; detection by stall still works without it.)
- Data: one machine-local patch document per station, e.g. `patch_outputs` = `{master:[{device,pair}], cue:[…],
  aux:[…]}`, `patch_inputs` = `{D:{kind:'device'|'app'|'link'|'park', …}, …}`; a one-time read of today's keys
  (`audio_output_device`, `aux_monitor_device`, `pfl_cue_device`, `mic_input_*`, `link_input`) so nobody's routing changes on
  update.
- UI: the Patch Bay window; removal of the old pickers (test: no second caller of the set-device calls in `src`).
- Help: `docs/help-patch-bay.md`.

### What the engine needs: one output to several devices
Today Master's device callback **is** the station's clock: it runs the mixer (`audio.rs:3138`). With several devices, only
one can be the clock.
- **Proposal:** the mixer runs on its own timer thread (or on the first Master destination as "clock device"); every
  destination, Master's first included, is fed through a ring like AUX/cue are today (`LocalRing`, consumer-side
  resampling with the ±0.3% drift nudge, `audio.rs:4058-4077`). Each device then drifts independently and is corrected
  independently; a missing or stalled device can never stop the mixer or the other devices.
- Cost: each extra destination adds one ring's latency (today's AUX/cue figure applies; to be measured).
- This is the biggest engine change in the plan. It touches the station clock, and therefore the stream. It needs the
  DSP parity harness (`npm run test:rust`, offline render through the real mixer callback) to prove the stream output is
  bit-identical before/after for a single destination.

### Risks
- Moving the station clock off the Master device is a playout-core change; a regression is dead air or stream drift.
  Mitigation: parity goldens, an isolated engine proof (own pipe, empty DB, nothing scheduled — `d1e2065`), off-air
  compile only.
- Two outputs on one device and pair (e.g. Master and Aux both to "Speakers 1-2"): WASAPI shared mixes them. Allow and
  show it, or refuse? → question.
- Removing "no fallback" from Master: if a box loses its only device, Master is silent instead of playing on the laptop
  speakers. That is Jeff's rule; the on-screen warning must be loud. The stream is unaffected (air has no device).
- 5 of 159 engine tests already fail on stale goldens (`docs/engine-compile-requirements-2026-10-19.md`); they must be
  re-baselined before they can gate this.
- Memory on OVEVENTS for a release+LTO compile (2.9 of 15.7 GB free when last checked).

### How it would be tested
- Rust unit tests: destination list; pair mapping (L/R to 3-4, silence elsewhere); missing name → no stream, state
  `missing`, never the default; one destination missing does not stop the others or the mixer.
- Parity harness: single-destination render bit-identical to today.
- Isolated engine on OVEVENTS, off air: every plugged-in device and pair, an unplugged name, unplug during play; read back
  `audio:patch-state` and the log lines.
- App launch, Patch Bay window screenshot with live / missing crosspoints (a UI claim needs the real screen).
- Migration test: today's keys → the patch document, nothing changes on first launch.

### Questions for Jeff (A)
1. Patch Bay saved **per station** (each station's Master/Cue/Aux) or one patch for the whole computer?
2. Same device + same pair on two rows (Master and Aux into Speakers 1-2): allow (Windows mixes them) or refuse?
3. Should the Patch Bay also take over the browser-only pickers (voice-track mic, phone hybrid input, Track Editor
   preview, Captions, Show+), or only engine audio?
4. Inputs: patch a **stereo pair** to one source channel (e.g. a mixer's 1-2 into S1 as stereo)? Today a mic is mono.
5. Who may open the Patch Bay? (Roles table row "Audio routing / Patch Bay", proposed Admin only.)

---

## B. Any app's sound as a source (per-app capture)

### What it is
On a source channel's patch (Patch Bay inputs grid), pick a running app — Zoom, a browser, Discord. Its audio comes in on
that fader. Uses Windows' **process loopback** capture (`ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, include-process-tree mode): no virtual cable, no driver, no admin rights.

### What already exists
- Nothing in the engine. Browser-side **whole-system** loopback exists for Captions and video (`Captions.tsx:21-26`,
  `main.js:10861-10913`, `main.js:9614-9631`). It is not per-app and never reaches the engine.
- The slot side exists: a generic source slot already accepts a live input through `LiveIn` (resampling, drift nudge),
  and refuses Load/Play on a live slot (`audio.rs:3206-3207`). An app feed would be a new kind of live input on the same
  path as a mic or a Link.

### What's new
- Engine (Rust, `windows` crate; cpal has no process-loopback API): a capture thread per app source, activated by
  process id, stereo float at a requested format (the API does not offer a mix format; we ask for 48 kHz stereo float).
  Feeds the slot's stereo live ring (as Link does).
- An app list: running processes that have an audio session (WASAPI session enumeration), shown by app name and icon.
- Re-attach by **executable name**, not process id: the patch stores "zoom.exe", the engine finds the current process.
- States: live, **app not running — <name>** (silent, waiting), **app has no sound yet**, **not supported on this Windows**.
- Source kind label (`sourceKinds.ts`) "App audio"; Patch Bay inputs grid shows one row per patched app.

### Windows versions
- Microsoft documents process loopback with the **ApplicationLoopback** sample, which states **Windows 10 build 20348 or
  later** (Windows 11 and Windows Server 2022 qualify).
- Windows 10 21H2/22H2 (builds 19044/19045) are **below** 20348. Whether the API works there is **UNVERIFIED**. Plan for
  "not supported on this Windows" on Windows 10 and test it on a real Windows 10 box.
- This computer: Windows 11, build 26300, so it qualifies. **OV's Windows version is unknown** (the backend stores only
  "Win32"). → question.

### App closes or restarts
- When the process exits, the capture stops delivering. The fader goes silent and shows "app not running — Zoom". No
  other app is ever substituted.
- When an executable with that name starts again, the engine re-attaches. Detection: a poll of the session list on a
  short interval, or session-created notifications (`IAudioSessionNotification`).
- Several processes with one name (several Chrome windows): include-tree mode on the main process captures all its
  children. Which one counts as "the app" → question.

### Risks
- Version coverage: on Windows 10 machines the feature may be unavailable. That has to be honest in the UI, not a silent
  fail.
- Browsers and Electron apps play audio from a child process (Chrome's audio service). Include-tree mode on the parent is
  expected to cover it; **UNVERIFIED**, test per app.
- Echo: an app that also *hears* Ether (Zoom with Ether as its mic, Part C) and is captured back onto a fader loops
  unless the return is a mix-minus. Part C's mix-minus is the answer; until then, refuse or warn → question.
- Managed boxes (OV, McAfee): process loopback needs no driver and no admin. Endpoint security could still flag
  per-process audio capture. **UNVERIFIED.**

### How it would be tested
- Rust: activation succeeds and fails cleanly with the "not supported" state. Re-attach by name after a process
  restart, using a test tone process.
- On OVEVENTS, off air, isolated engine: capture a browser tab tone, Zoom test call audio and Discord. Close and reopen
  each, read the state transitions, and listen.
- On a Windows 10 box, if there is one: confirm the honest "not supported" (or that it works).

### Questions for Jeff (B)
1. What Windows version is OV's computer? Is there any Windows 10 box this must work on?
2. An app with several windows or processes: capture all of them as one source, or pick one?
3. Until mix-minus exists: refuse to capture an app that is using Ether as its mic, or allow it with a warning?

---

## C. Ether as a microphone other apps can pick

### What it is
Zoom, Teams and OBS list **"Ether"** as a microphone. Selecting it gives them an Ether output: the programme, or a
mix-minus for a caller (everything except that caller's own channel). This **requires a virtual audio device**: Windows
has no supported way for an ordinary app to create a microphone that other apps can choose.

### What already exists
- No virtual device and no mix-minus in the engine. The Strata spec lists mix-minus as missing
  (`docs/strata-to-ethercast-build-spec.md:42,124,179`). The Remote Link design defers it (`remote-link-design-2026-09-28.md:236`).
- Ether can already send audio to any output device (Part A), so once a virtual device exists, feeding it is just one
  more Patch Bay column.

### What's new, whichever way is chosen
- The virtual device appears as a **playback** endpoint that Ether writes to, plus a **recording** endpoint ("Ether")
  that other apps read from. Inside the driver the two are joined.
- Engine: **mix-minus buses**. Each is "the programme minus channel X" (an N-1 per source), selectable as a Patch Bay
  output row. This is new mixer work in the callback.
- Installer: the device is installed with admin rights. Uninstall removes it.
- Patch Bay: the virtual device shows as columns like any device, and its state comes from the same status as Part A.

### Two ways — for Jeff to decide

| | 1. Our own Microsoft-signed audio driver | 2. License and bundle VB-Audio's virtual cable |
|---|---|---|
| What it is | A Windows kernel-mode audio driver (starting point: Microsoft's SysVAD virtual audio sample), named "Ether" | VB-Audio's VB-CABLE driver, installed by the Ether installer under a redistribution license |
| Device name users see | "Ether" (ours to choose) | "CABLE Input / CABLE Output" unless VB-Audio's license offers a renamed build → ask them |
| Signing | Needs an **EV code-signing certificate** and a **Microsoft Partner Center** hardware account. The driver is submitted for **attestation signing** (enough for Windows 10/11 desktop) or full WHQL (HLK test lab) | Already signed by VB-Audio. Nothing for us to sign beyond our installer |
| Cost (approximate; confirm before deciding) | EV certificate, about a few hundred USD a year. Partner Center registration. Developer time, a kernel audio specialist if not in-house. Ongoing upkeep across Windows updates | The VB-Audio license fee. **Unknown, they quote on request.** Bundling is not allowed without a license (their site sells redistribution licenses for developers) |
| Time (estimate, UNVERIFIED) | Months: driver, signing pipeline, install/uninstall and test matrix | Weeks: license, installer step and Patch Bay integration |
| Risk | **A kernel bug can blue-screen an on-air machine.** Driver installs can be blocked on managed boxes (OV, McAfee). We own every Windows-update breakage | Depends on a third party's driver, release cadence and license terms. Users who already have VB-CABLE get a version clash, or two of them. Same managed-box install risk. Not our name in the device list |
| Control | Full: channel count, latency, several "Ether" devices (e.g. one per caller) | What VB-Audio ships: one cable per product. More cables are separate products (VB-CABLE A+B, etc.) |
| macOS (USPH) | Separate work (an Audio Server plug-in, user space, no kernel) | VB-Audio has a Mac version; licensing again |

Not covered by either way: a user-mode virtual microphone. As far as I know there is no supported API for one on
Windows 10/11 (**UNVERIFIED** against the newest Windows 11 releases; worth one check before committing to a kernel driver).

### Risks
- Both ways put a driver on air machines. On OV's managed box an install may need IT's approval.
- Mix-minus needs a definition per caller source, and a talkback (TB) interrupt if the operator should talk to them
  off air. The Strata spec has it; Jeff hasn't asked for it here → question.

### How it would be tested
- Driver (either way): install and uninstall on a clean VM and on OVEVENTS off air. Zoom, Teams and OBS each list "Ether"
  (or CABLE) and record the programme. Then a reboot, sleep/resume, and a Windows update on a VM.
- Mix-minus: a null test. A caller on S3 hears the programme with S3 nulled out (a render-harness test in Rust).

### Questions for Jeff (C)
1. Which way: our own signed driver, or a VB-Audio license? (Before deciding: I can request VB-Audio's licensing terms
   and price, which is outward-facing, so only on your go.)
2. How many "Ether" microphones: one (programme, or one chosen mix-minus), or one per caller?
3. Mix-minus: in scope now? With a talkback key?
4. macOS (USPH): needed at the same time?

---

## D. Remote Link as the VBAN replacement

### Starting point: what was approved
- `docs/remote-link-design-2026-09-28.md`. Rulings GO 2026-09-28 (:259-271):
  - D1: Link is its own patch type.
  - D2: UDP first, then SRT.
  - D3: tap before processing.
  - D4: on loss, silent + NOT FED; auto-cut is off by default.
  - D5: 128 kb/s, UDP 9760, 120 ms buffer.
  - D6: build both routes, relay first.
- Ruling B, 2026-09-29 (:293-318): the sending machine makes the key.
- **The 2026-10-04 pairing ruling** is recorded in code and commits, not in a design doc: "the link key is never copied or
  typed by hand" (`ether-backend/src/lib/link-pairing.js:2`; openair `f2c4103`; backend `d160f2c`;
  `src/components/LinkPairPicker.tsx:1-5`).
  - Same account: each machine publishes its key. The receiver lists the account's machines and picks one.
  - Guest: an 8-character one-use code, valid 10 minutes.

### What's built (shipped in v4.6.52 / v4.6.57 / v4.6.59)
- Engine:
  - `native/src/link.rs`: Opus 48 kHz stereo, 20 ms frames, 128 kb/s, in-band FEC, ChaCha20-Poly1305 bound to both machine
    ids, replay window, jitter buffer with PLC.
  - `native/src/linknet.rs`: UDP sockets. One receive port per machine for every station, demultiplexed by station tag.
  - Received audio lands on a source slot via `LiveIn` (`audio.rs:445-447,3058,3580-3596`).
- Daemon / config: `audiod/link.js`. Machine-local keys `link_input` / `link_send` (the `link_` prefix, never synced).
- Main / IPC: `main.js:6908-7084`, covering get, key line, mint key, set input / set send, account machines, pair machine,
  pair code, redeem, state. Account-paired faders re-fetch their sender's key every 60 s, and the machine re-publishes
  its key hourly.
- UI: `LinkPairPicker.tsx` (account machines dropdown, guest code, advanced paste). `RemoteLinkSettings.tsx` is the
  sender. `RemoteLinkHealth.tsx` is the Health row. Source kind "Link (network feed)" (`sourceKinds.ts:56`).
- Backend: `src/lib/link-pairing.js` (machines, key, pair-code, pair-redeem) with 7 tests. **It is live:** `d160f2c` is in
  `84a4a6b` and in today's `2cf4037`, both deployed from `main`, and `/api/link/machines` answers 401 without auth, so the
  route exists. Each commit message says "NOT DEPLOYED"; that was true when written.
- Measured: 120-142 ms end to end over 127.0.0.1, 0 lost (design :339). Not measured between two real machines.

### What's missing for "no IP addresses, stream names or ports"
1. **Finding the other machine.** Pairing exchanges keys only. **The sender still types the receiver's public address
   and a router-forwarded port** (`RemoteLinkSettings.tsx:248-250`; SEND is disabled until a host is typed, `:275`).
   Nothing publishes or looks up endpoints.
2. **The relay on the Ether server** (design :115-135; D6 "relay first"). Not built in either repo. This is what makes
   "no IPs, no ports" work through any router. "No Lightsail in this run" (2026-09-28) means it needs a go and a host.
3. **NAT traversal** as a direct-path optimisation: STUN plus hole punching. Not built. The relay is the guaranteed path;
   a direct path is a latency saving when both routers allow it.
4. **SRT** (D2). Not built; the fallback field is shown disabled (`audiod/link.js:43-44`).
5. **Receiver picks the sender in the Patch Bay.** Today the receiver picks in `LinkPairPicker` on the fader. The sender
   picks a target computer and station, then types the address. The VBAN-style flow is inverted: the receiving side
   picks "OVEVENTS · HalloVeen programme" in the Patch Bay inputs grid. The relay tells the sender to start. The
   sender's operator does nothing, unless Jeff wants a consent step → question.
6. **Several streams.** One `link_input` per station holds one slot, and one `link_send` holds one target. A second sender
   is refused as BUSY. VBAN users often run several streams → question.
7. **What a sender can offer.** Today, the programme bus before processing (D3). In a Patch Bay world the sender's offer
   could be any Ether output row (Master, Aux, a mix-minus) → question.
8. **Security issues still open** (`docs/multitenancy-audit.md`):
   - H5: "the account" includes any license with the same email, and email is never verified, so a stranger could
     read or replace link keys.
   - M1: `link_keys` is keyed by machine_id only.
   - Both must be closed before discovery makes machines easier to find.
9. **Help doc is stale:** `docs/help-remote-link.md` describes only paste-a-key and typing the address. Its `since:` line
   is wrong.
10. **Link Test button** (1 kHz marker, design §6.2): not found in the code.

### What the engine needs
- A relay transport: the same packets (already encrypted end to end, so the relay never sees audio) sent to the
  relay's address with a session id, in place of the peer's address. The receive side is unchanged, because it already
  follows the source address (`linknet.rs:671`).
- Several Link inputs per station (one per patched slot), and several sends.
- Sender tap points beyond the programme bus, if question 3 says so.

### Risks
- The relay is a new always-on server that carries live audio. Its cost scales with streams × 128 kb/s × 2, its latency
  depends on where it is hosted, and it is a new outage point. The link already goes silent with NOT FED on loss (D4),
  so a relay outage is visible, not hidden.
- Direct paths through corporate firewalls (OV) are likely blocked. Plan for the relay as the normal path at OV.
  **UNVERIFIED**: measure.
- H5 has to be closed first, or discovery widens a known hole.

### How it would be tested
- The existing self-test (two engines on one machine, `ETHER_LINK_SELF_TEST`) through a local relay process.
- Two real machines on the same account, behind different routers: pick the sender in the Patch Bay, with no address
  typed. Measure end-to-end latency, loss and recovery after pulling the network cable.
- The backend relay: unit tests for session setup, the right account only (H5 fixed), and teardown.
- Then OVEVENTS ↔ ovowforestmusic, **only on Jeff's go**. OV is live; this plan never touches it on its own.

### Questions for Jeff (D)
1. Relay: approve building it, and where should it run (Railway next to the backend, or Lightsail next to Icecast)?
   "No Lightsail in this run" was the 2026-09-28 ruling.
2. Does the sending machine's operator need to approve a new receiver, or is anyone on the same account allowed?
3. What can a machine send: only the programme (today, pre-processing), or any output row (Master, Aux, a mix-minus)?
4. How many Link streams per station, in and out?
5. SRT: still wanted after the relay, or does relay plus UDP replace it?
6. Close H5 and M1 first? (Recommended.)

---

## How the four parts fit, and an order (proposal)
1. **A first, outputs only.** This is Jeff's Outputs answers plus several destinations per output and the Patch Bay
   window. Everything else plugs into its grid.
2. **A, inputs grid.** Today's mic and Link patches move into it, and stereo pairs are added.
3. **D.** Close H5/M1, build the relay, and pick the sender in the Patch Bay. This replaces VBAN between Ether machines.
4. **B.** App audio as a source. It doesn't depend on C, but echo safety wants C's mix-minus.
5. **C.** Once Jeff has chosen the driver route: the virtual device plus mix-minus.

Every engine step is compiled only when this computer is off air (Jeff's answer 4), and is proved on an isolated engine
before anything reaches a station. Each step is its own commit with a test, and its help entry is `docs/help-patch-bay.md`
(plus updates to `help-remote-link.md`).

**Stopped here, waiting for Jeff.**
