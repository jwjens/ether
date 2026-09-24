# Wheatstone Strata / Virtual Strata → EtherCast Build Spec

> Transcribed verbatim from `strata-to-ethercast-build-spec.md.pdf` (Jeff, 2026-09-23) into this path, which
> the Stage 2a brief names as the spec's home. Tables re-flowed to Markdown; wording unchanged.

Date: 2026-09-23. Research summary for the DSP/console arc. Sources: Wheatstone Strata product page and
spec list, Strata 32 user manual, LXE manual, E-6 technical guide (2007), Virtual Strata setup guide,
Wheatstone TV mix engine and Blade pages, trade press; ITU-R BS.1770, EBU R128, ATSC A/85, AES TD1008;
Lawo, Calrec, Axia, Orban/Omnia public docs; Ross Bencina, "Real-time audio programming 101".

The Strata is a control surface. All mixing and processing runs in a separate mix engine (Blade 4 TVE, or
Gibraltar on older units). EtherCast already has the same split: the UI plays the surface and the
out-of-process "blade" daemon plays the engine. So the job is not to copy a TV console. It is to add, in
order: a real-time-safe callback, a parity harness, meters (pre-fader, integrated BS.1770, per-branch GR),
a pre-fader channel rack (HPF/LPF → gate → 4-band EQ → compressor), and full per-station show presets.
Subgroups/VCAs, mix-minus and automix come after that. Physical faders, 5.1 and AES67/2110 hardware do
not carry over.

## TL;DR

- Reference model: Strata's DSP for all 64 input channels, 8 submix groups and 8 VCA groups sits in the
  mix engine. The surface only sends control data over primary and secondary "Mixer Links". EtherCast's
  UI/blade split already matches this. Treat the UI as disposable and the daemon as the sole owner of
  audio state.
- Biggest gaps: no per-channel processing, no pre-fader meters, only a momentary loudness meter (Strata
  has a full BS.1770-3 meter), no GR meter per branch, no show presets. Every Strata processing block
  (4-band parametric, HPF/LPF, compressor/limiter, expander gate, delay) can become one channel rack
  instanced per fader.
- Build order: offline null-test harness → make the callback real-time safe → meters → channel rack
  (default bypassed, pre-fader) → integrated loudness and GR per branch → show presets keyed by station
  UUID → subgroups/VCAs → mix-minus → automix. Keep loudness normalization post-sum only, and host no
  third-party plugins in the live chain. *(Order of the first two amended 2026-09-23 — see §4.)*

## 1. Strata / Virtual Strata feature set in engineering terms

| Feature | What it does | Why an operator uses it |
|---|---|---|
| Input channels / control layers | 32 motorized faders switch between two banks (ch 1–32 / 33–64). Motorized faders jump to the stored position when the layer changes. Any network source can go on any channel. | Keeps a 40" frame usable for a 64-source show; no channel blocking by input type. |
| Subgroups (8, mono/stereo/5.1) | Audio busses: channels are summed into a group, and the group has its own fader and processing before the master. | One fader rides "all mics" or "all music". Processing can be applied to the group once instead of per channel. |
| VCA groups (8) | Control-only groups. Moving the VCA fader offsets the gain of each member channel; no audio is summed. | Lowers a set of channels together while keeping each one's post-fader sends and individual balance. |
| Aux sends (16) | Per-channel, level-controlled feeds to separate busses (pre or post fader). | Builds foldback, IFB, records and alternate mixes that differ from program. |
| Mix-minus busses (16) + per-channel mix-minus with TB interrupt | Each channel gets a mix of its bus minus its own signal ("all active faders on its selected source bus, except for itself"). TB (talkback) interrupt replaces or overlays that feed with the operator's talkback mic. | Callers, codecs and remote talent hear the show without their own echo delayed back to them; the operator can talk to them off-air. |
| Track outputs | Routable direct output per channel. | Multitrack recording and ISO feeds. |
| Monitor outputs with source presets | Control Room, Studio 1 and Studio 2 outputs, each with 16 source presets. | One-button switching of what the room hears (PGM, AUX, off-air, a return). |
| Wild (programmable) switches | 2 per input and 3 global, assignable to any function or logic. | Site-specific actions: cough, salvo, fire a device, route change. |
| Per-channel processing | 4-band parametric EQ (two bands can switch to shelving), HPF/LPF, compressor/limiter, expander gate, and programmable delay "up to 20 frames per channel", applicable to all inputs and bus outs. | EQ corrects the tone of a mic or source. HPF removes rumble and handling noise. The compressor evens out voice level. The gate/expander cuts room noise when a mic is open but idle. Delay puts audio back in sync with late video (20 frames ≈ 667 ms at 29.97 fps, 800 ms at 25 fps). |
| Metering | Pre-fader input meter on each channel OLED; peak/average meters for all bus outputs; a BS.1770-3 loudness meter; GR metering on master outputs. | Pre-fader meters show gain staging before the fader hides it. Loudness meters are for compliance. GR meters show how hard the dynamics are working. |
| Automixer | 16-channel automixer with 4 group assigns and onscreen weight control. | Panel shows with several open mics: gain is shared automatically so only active talkers are up, and noise and comb filtering stay down. |
| Show presets (99) | Full console recall. ("99 show presets for complete recall" is on the Arcus and Tekton 32 pages, which run on the same TVe mix engine family.) | Switch between the newscast, sports and talk configurations in one step. |
| Automation control interfaces | Interfaces with newsroom/production automation (Grass Valley, Sony, Ross) over IP. | Lets an automation system drive fader, ON and preset changes. |
| Integrated clip player | Plays stored clips; controllable over the network through ACI. | Stingers and opens without a separate playout device. |
| WheatNet-IP / AES67 / SMPTE 2110 | All I/O over the network; no audio connectors on the surface. PTPv2 at 48 kHz. | Any source on any fader; interoperability with video plants. |
| Virtual Strata multi-touch EQ | Touch EQ curve; two fingers adjust bandwidth. | Faster than knobs for broad tonal moves. |
| Remote access from any PC touchscreen | Windows front end talking to a Debian 11 Linux backend, licensed via a WheatNet-IP license server; real-time fader tracking with the physical surface. | Remote mixing, or a small "extension of the automation system" for occasional level trims. |
| Fail-safe redundancy | Redundant network, AC and power supplies; optional dual mix engines synchronized in real time with a heartbeat that triggers failover. | The show stays on air when hardware fails. |

## 2. Wheatstone architecture as the reference model

### Where DSP runs, and the surface/engine split
- The engine owns the audio. The surface controls "the operation of the Gibraltar IP Mix Engine's DSP,
  which contains the mixing and signal processing power" for all channels, groups and VCAs. Current Strata
  ships with a 1RU Blade 4 TVE that handles all mixing and processing. The engine is shared by Arcus,
  Tekton 32 and the virtual interfaces.
- Control links: surface and engine connect through two Mixer Links (primary and secondary), up to 100 m
  apart, further over fiber.
- Virtual front end: backend (Debian 11 Linux PC) + Windows front end + license server. Wheatstone's VMX
  platform (announced March 2026) generalizes this as a single mixing backend for multiple LXE, Glass LXE,
  Strata and Virtual Strata surfaces, runnable on a commercial server or PC.
- Network resilience: each Blade can take over as Route Master, and each Blade can recover settings for
  the entire studio.

### What happens to audio when a surface disconnects
Not explicitly published. Inferred from the architecture: audio keeps passing with its last state, because
DSP lives entirely in the engine and there are redundant control links. The published failover mechanism
targets engine failure (dual engines with heartbeat), not surface failure.

EtherCast requirement: the blade must keep running the last-known mix if the Electron UI crashes or
reloads. On reconnect, the UI reads its state back from the blade rather than pushing its own.

### How presets and processing are stored
Not clearly documented. LXE: configuration changes are uploaded to the Surface Host via Apply; an Event is
armed then Taken. Two behaviours worth copying:
- The LXE option that stops a recalled Event from immediately changing channels that are already ON; their
  ON buttons flash to show a pending change.
- The E-6 SAVE form that stores EQ and dynamics "to a channel, a source, an event, the headphones, or a
  preset" — processing can follow the source (a given mic) or the show.

### Processing parameter ranges (Wheatstone E-6 Technical Guide, Dec 2007 — family reference values, not confirmed Strata specs)

| Block | Range | Notes |
|---|---|---|
| Parametric EQ (4 band) | ±14 dB gain; centre 16.1 Hz–20.2 kHz; width 0.2–3.0 octaves (≈ Q 7.2–0.40) | LOW and HIGH bands switch to shelving. EQ graph spans 20 Hz–20 kHz log and ±15 dB. |
| HPF | 24 dB/oct Butterworth, 16.1–500 Hz, own IN/OUT | High order for "decisive removal" of rumble, hum and footsteps. |
| LPF | 24 dB/oct Butterworth, 1–20.2 kHz, own IN/OUT | |
| Compressor | Threshold −40 to +10 dB; ratio 1:1–20:1; attack 0.10–330 ms; release 50 ms–3.0 s; makeup 0–36 dB | The manual also says "up to 20dB" makeup — internally inconsistent. Soft knee on LXE/Strata. |
| Expander/gate | Ratio 1:1.0–1:5.0; close 50 ms–3.0 s; threshold, open/close, depth | Guidance: depth of 14 dB, 20 dB tops, is enough; use 1:3–1:5 ratios for gating. |
| Delay | Up to 20 frames per channel | |
| Metering style | Peak-over-average: a peak dot riding over an average bar, with an Over indicator | |

### Metering and loudness standards

| Standard | What it specifies |
|---|---|
| ITU-R BS.1770 | K-weighting, mean square over 400 ms blocks with 75% overlap, −70 LUFS absolute gate and −10 LU relative gate. True peak by oversampling. |
| EBU R128 | Integrated target −23 LUFS (±1 LU allowed for live), max −1 dBTP. EBU Mode: momentary 400 ms, short-term 3 s, integrated, LRA. |
| ATSC A/85 (CALM Act) | −24 LKFS, −2 dBTP, dialogue-anchor based. |
| AES TD1008 (streaming) | −18 LUFS speech/assorted, −16 LUFS music, −17 compromise for mixed real-time streams; ≤ −1 dBTP at the input of a lossy codec. |
| Platform normalization | Spotify −14 LUFS (published); Apple ≈ −16 (third-party reported). EtherCast's −14 default is platform-loud, not AES-recommended. |

Implication for EtherCast: the ride is driven by a momentary meter. Compliance is judged on integrated
loudness, so add short-term and integrated readouts alongside the ride. Offer targets of −23, −24,
−16/−17/−18 and −14.

## 3. Gap analysis: Strata vs EtherCast today

| Strata capability | EtherCast status | Minimum viable software form / reason |
|---|---|---|
| Input channels (64) | Already has (A/B/C, D/E/F, S1–S5 with fader, ON and trim) | — |
| Control layers | N/A | Hardware fader-count limit; a scrolling UI solves it. |
| Motorized fader recall | N/A (physical) | On-screen faders jump on preset recall. |
| Subgroups (8) | Missing | Named summing busses ("Music", "Voice") with a fader and a rack slot, feeding the master pre-ride. |
| VCA groups (8) | Missing | Gain-offset groups: member gain = channel fader + VCA offset (dB). No audio path. |
| Aux sends (16) | Missing | Per-channel pre/post send levels to N aux busses. Start with 2 (record, foldback). |
| Mix-minus + TB interrupt | Missing (needed only if callers/remote talent are carried) | Auto N-1 per channel from a chosen bus, plus a TB key. |
| Track / direct outputs | Missing | Per-channel post-rack tap for recording. |
| Monitor outputs + source presets | Partial (monitor branch exists; no source selector) | Monitor source selector (PGM / pre-ride / stream / any channel / cue) with 8–16 presets. |
| Wild switches | Missing | User-assignable macro buttons bound to engine commands. |
| 4-band parametric EQ (per channel) | Missing (10-band GEQ on master only) | 4-band parametric in the channel rack; bands 1 and 4 switchable to shelf. |
| HPF/LPF | Missing | 24 dB/oct Butterworth, HPF 16–500 Hz, LPF 1–20 kHz. |
| Compressor/limiter | Missing per channel (master TP limiter exists) | Soft-knee feed-forward compressor with GR output. |
| Expander gate | Missing | Downward expander with a depth limit (12–20 dB). |
| Programmable delay | Missing; low priority | Up to 1 s per channel from a preallocated buffer. Only for A/V sync. |
| Pre-fader input meter per channel | Missing | Peak + RMS tapped after trim and before the rack. |
| Peak/average bus metering | Partial (IN/OUT meters) | Peak-over-average meters on every bus and branch. |
| BS.1770 loudness meter | Partial (momentary only) | M/S/I + LRA + TP per branch, with reset and start/stop tied to show start. |
| GR metering on outputs | Partial (single GR meter) | Separate GR for ride and limiter on each branch (monitor and stream). |
| Automixer | Missing (the ducker is a partial analogue) | Gain-sharing automix over S1–S5 with per-channel weight. |
| Show presets (99, full recall) | Missing (one Processor preset) | Full snapshot per station UUID: fader/ON/trim, racks, master, routing. Recall safety for live channels. |
| Automation control interfaces | N/A (EtherCast is the automation) | Equivalent: an external control API (OSC/HTTP/WebSocket). |
| Integrated clip player | Already has (decks exceed it) | — |
| WheatNet-IP / AES67 / SMPTE 2110 | N/A for now | Needs PTP-disciplined NICs and a hardware clock. Revisit only if a customer plant requires it. |
| 5.1 subgroups / master | N/A | Radio and streaming are stereo. |
| Multi-touch EQ curve | Missing | Drag nodes for frequency and gain, pinch/two-finger for Q. |
| Remote access from any PC | Missing | Blade exposes a control socket; a second UI instance attaches read/write with fader tracking. |
| Fail-safe redundancy | Partial (out-of-process blade) | Confirm audio survives a UI crash; watchdog restarts the blade with the last state. Dual engines out of scope. |

## 4. Recommended build order

Ordering rules:
1. No new DSP until the callback is safe.
2. Every change is proven against a golden render.
3. Meters come before knobs.
4. One visual language for channel and master racks.
5. Channel processing is pre-fader.
6. Loudness normalization stays at program level (post-sum).
7. All settings keyed by station UUID.
8. No third-party plugin hosting in the live chain.

Real-time rules (Bencina): if you don't know how long it will take, don't do it on the audio thread — no
(de)allocation, no mutex locks, no disk I/O, no calls that may block. Preallocate; talk to the callback
through lock-free FIFOs.

> **Amended 2026-09-23 (Jeff's ruling, Stage 2a):** slices 0 and 1 swapped — the parity harness is slice 0 and the
> RT-safe callback slice 1, because rule 2 (every change is proven against a golden render) requires the goldens to
> exist before the callback changes.

| # | Slice | Scope | Verification |
|---|---|---|---|
| 0 | Offline parity harness | Run the engine headless over fixed test files (speech, music, silence, sweeps, −1 dBFS intersample test) and compare against golden renders. | Null test: output minus golden below −120 dBFS (or bit-exact) for the current "Ether v1" chain. |
| 1 | RT-safe callback | Decode and file I/O to worker threads feeding lock-free rings. Preallocate all buffers. Parameters via lock-free SPSC queue or atomics. No logging in the callback. Allocation trap in debug builds. | 8 h soak at smallest buffer size while loading tracks and moving sliders: zero xruns, no clicks. |
| 2 | Meter bus + pre-fader meters | Engine publishes peak/RMS per channel (post-trim, pre-rack), per bus and per branch at ~30 Hz over a lock-free queue. Common meter component. | −18 dBFS RMS 1 kHz tone into S1: channel meter reads −18 RMS / −15 peak, fader does not move it. |
| 3 | Full BS.1770 meter + GR per branch | Short-term (3 s), integrated (gated), LRA and TP on both branches. Ride GR and limiter GR shown separately. | EBU Tech 3341 test signals read within ±0.1 LU; a known −23 LUFS file reads −23.0 I. |
| 4 | Rack framework (slot metaphor) | Generic rack of preallocated slots with bypass, same UI for channels and master. Move existing master GEQ, ride and limiter into master slots with no DSP change. | Parity harness still nulls; master rack shows the same values as the old Processor window. |
| 5 | Channel rack v1: HPF/LPF + 4-band PEQ | Instanced per fader, pre-fader, default bypassed. Parameter smoothing. Ranges from §2. | Bypassed: null holds. HPF at 100 Hz removes rumble by ear; sweep shows −3 dB at 100 Hz, 24 dB/oct. |
| 6 | Channel dynamics: gate/expander + compressor | Order: HPF/LPF → expander → EQ → compressor. GR meter per slot. | Speech at −10 dBFS over 4:1 / −20 dB threshold shows ~7.5 dB GR. Gate drops idle room noise by the set depth. |
| 7 | Show presets | Full station snapshot keyed by UUID. Arm then Take. Channels that are ON are protected until OFF, with a flashing indicator. Stored and applied by the blade, not the UI. | Recall preset B mid-song: live deck unchanged; change lands when that deck goes off. Cold restart restores identical state (harness nulls). |
| 8 | Monitor source presets + aux/track sends | Monitor selector with presets; 2 aux busses; per-channel direct out. | Monitor → "stream" plays post-limiter audio on headphones; stream meters match monitor meters. |
| 9 | Subgroups and VCAs | Summing busses feeding master pre-ride; VCA offsets. | "Music" VCA down 6 dB: every member drops 6 dB on its meter, faders stay put. |
| 10 | Mix-minus + TB (if calls/remotes in scope) | N-1 per channel, plus a TB key. | Caller on S3 hears program without themselves (null of S3 in its return). TB puts operator mic in the return only. |
| 11 | Automix | Gain-sharing over mic channels with weights. | Two open mics, one talker: idle mic drops ~6+ dB, program level stays constant. |
| 12 | Remote/second UI + touch EQ | Blade control socket; second UI attaches with fader tracking; drag/pinch on EQ curve. | Fader on UI A moves on UI B within 100 ms. Killing both UIs leaves audio running. |

## 5. UI reference: proven conventions to copy

**Wheatstone Strata / LXE / E-6**
- One central touchscreen with View Select buttons (EQ, DYN…) showing the selected channel; channel chosen
  with SEL/SET, channel number always shown upper-left. EtherCast: one editor pane with a persistent
  "editing: S2 – Host Mic" header.
- EQ view: frequency-response graphic, 20 Hz–20 kHz log × ±15 dB, each band its own colour; separate EQ,
  HPF and LPF IN/OUT toggles; filters drawn opaque when IN; two fingers set bandwidth.
- Dynamics view: transfer graph with the unity diagonal in grey and the resulting curve in orange,
  expander and compressor overlaid; separate IN switches.
- Meters: peak-over-average bars, pre-fader meter on each strip, a Wild Meter on the master for
  spot-checking any source.
- Presets: Events armed then Taken, pending-change indication on live channels.

**Lawo (ruby / sapphire / crystal, VisTool)**
- Preconfigured multi-touch screens for channel EQ, dynamics, bus routing, inputs and faders; true loudness
  metering; full-screen, docked or windowed. Per-function colour coding (blue EQ, magenta dynamics). Adopt a
  fixed colour per slot type.

**Calrec Argo**
- Channel signal-flow graphic: Inserts → EQ → Dynamics → Path Delay. Variable filter/shelf slopes. Built-in
  ducker and stereo automixer. Mix-minus source selectable per channel, different output when the fader is
  closed. User wild panels. Copy the explicit signal-flow strip above the rack.

**Axia (iQ / iQx / iQs, SoftSurface, Pathfinder)**
- Processing attached to the source profile: EQ and voice dynamics saved with sources for automatic recall.
  Show Profiles; Pathfinder can load a profile on a schedule. iQs is HTML5 on any device. Lesson: a rack can
  belong to a source (the host mic) as well as to a show preset.

**Orban / Omnia**
- Optimod 8685 shows BS.1770-4 and CBS short-term meters side by side. Orban XPN-AM "BS.1770 Safety
  Limiter" constrains integrated loudness to a preset value with 10 s attack / 3 s release — a reference for
  the ride. Keep meters visible while editing presets. Omnia.9's remote client is identical to the front
  panel; toolbox includes loudness metering, oscilloscope, FFT, RTA. For EtherCast: meters pinned during
  edits; remote UI identical to local.

Not covered: DHD and SAM Cast screen documentation not retrieved.

**Recommended EtherCast rack layout (synthesis)**
- Top: signal-flow strip (Trim → Filters → Gate → EQ → Comp → Fader) with per-slot IN/bypass and colour.
- Centre: editor for the selected slot. EQ: curve with draggable band nodes. Dynamics: transfer curve plus
  GR bar.
- Right: pinned meter column — IN (pre-fader) peak/avg, GR, OUT.
- Master rack: same component, plus M/S/I/LRA/TP loudness panel and ride/limiter GR per branch.
- Preset bar: current show, Arm, Take, pending indicator.

## Caveats
- Numeric processing ranges are from the E-6 manual, not the Strata manual; E-6 makeup gain is internally
  inconsistent (36 vs 20 dB).
- "99 show presets" is documented on Arcus and Tekton 32 (same TVe engine); not confirmed in Strata text.
- Surface-disconnect behaviour and preset storage location are inferred; Wheatstone does not state them.
- Strata cites BS.1770-3; build to the current revision — single-programme stereo results are unchanged
  across revisions.
