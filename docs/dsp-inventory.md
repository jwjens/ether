# DSP inventory — every piece of audio processing Ether v1 actually runs

**Date:** 2026-09-23 · **Stage:** 1 of the rack arc (READ-ONLY audit) · **Tree:** `log-reader-flip` @ `b72b8ef` (4.6.49)
**Author:** Claude Code · **Scope:** static analysis only. No edits outside `docs/`, no build, live DB not opened.

> **Evidence rule for this doc.** Every claim has a `file:line`. A `file:line` proves **what the source
> says**, not what the running app does. Wherever a claim is about runtime behaviour it is marked
> **UNVERIFIED**, with the one check that would settle it. Nothing here was observed on a running install.

---

## Summary: what matters for Stage 2

1. **One engine, two hosts.** All program-bus DSP is in the Rust addon (`native/src/audio.rs` +
   `program_processor.rs` + `eq.rs`). The daemon and the in-process fallback load **the same addon and
   call the same `start_station_mixer`** (`native/src/lib.rs:27-32`). The only difference is which JS
   layer drives it. OV is on the daemon by default (`electron/main.js:346-350`). Whether OV is on the
   daemon *right now* is **UNVERIFIED**.
2. **Monitor and stream do NOT hear the same processed audio. They have not since 2026-09-07.** Each
   branch has its own `ProgramProcessor` instance, its own toggle and its own parameter set
   (`audio.rs:2641-2672`). The two branches are bit-identical only when both toggles are on **and**
   `proc_split` is off, because the daemon then mirrors the local parameters into the stream set. C7
   asserts that on the sample bits (`program_processor.rs:555-594`). Both toggles default OFF
   (`audio.rs:693-694`).
   - With an aux deck (D/E/F/S1–S5) producing audio, the room is fed by a **third** instance,
     `processor_room` (`audio.rs:2735-2778`).
   - With an aux deck producing audio and processing on, the aux monitor is fed by a **fourth**,
     `processor_aux` (`audio.rs:2825-2844`).
3. **"OUT LUFS" is not a measurement.** It is `in_lufs + ride gain_db` (`program_processor.rs:265`),
   computed before the limiter. "IN LUFS" is **momentary** (400 ms, `Mode::M`), sampled every ~100 ms
   (`program_processor.rs:218, 222, 235`).
4. **Tier 1 is PARTIAL, and the headline claim in the record may be false.** Import does measure
   loudness and store `songs.lufs_measured` / `peak_db` / `gain_db` (`src/audio/songAnalysis.ts:107-124`,
   `src/components/ImportDialog.tsx:110`). The mixer does apply `gain_db` pre-fader
   (`audio.rs:2362-2365`). But **no daemon queue builder selects or carries `gain_db`**
   (`audiod/loggen.js:160-172`, `:433`, `:460`; `audiod/engine.js:1702`). So automation loads reach Rust
   with `gainDb ?? 0`. `docs/library-normalization-2026-09-06.md:30` says "what reaches the bus is −14";
   **statically, that does not hold on the daemon path.** Runtime is **UNVERIFIED**. The check: the
   daemon's `[mix sN]` heartbeat prints each deck's live trim as `g=` (`audiod/engine.js:201`). Look at
   it while a song with a non-zero `gain_db` is airing.
5. **The audio callback is not realtime-safe.** Per buffer it makes about 20 heap allocations. It
   decodes and reads files inside the callback. On natural end it frees a decoder and prints a log
   line. It stamps the clock with `SystemTime::now()`. It never sets flush-to-zero. Every lock *in* the
   callback is `try_lock` (the good part). But a lock miss on the bus outputs a **silent buffer** and
   pushes nothing to the stream (`audio.rs:2279-2282`), and the command thread holds that same lock
   while it allocates (`audio.rs:2046-2068`). Section 6 has the full list. **A rack cannot be added
   safely without fixing this first.**
6. **An offline parity harness is ~one function away.** `mixer_callback` is already a pure function
   that the Rust tests drive with no sound card (`audio.rs:1116-1165`). The stream tap is readable from
   the ring consumer. Section 8 gives the smallest change.

---

## 0 · The record: prior rulings and designs

Searched `docs/` and `CHANGELOG.md`. Only binding decisions and designs of record are listed here;
passing mentions are left out. **Conflicts between docs** are at the end of this section. Where this
audit's code reading **contradicts** a doc, it is flagged ⚠ inline.

### 0.a Loudness ride, limiter, program processor
| Ruling / design | Receipt |
|---|---|
| "The limiter becomes an adjustable feature alongside the Master EQ. No workarounds — I'm not normalizing my way around a processor I can't control." No blank fields, no hidden defaults. | `docs/audio-processing-controls-2026-09-06.md:8-10` |
| Chain order: bus → ride (one gain per buffer) → true-peak limiter. No compressor, multiband or clipper. | same doc `:39`, `:42` |
| Exposure table. Ceiling −3.0…−0.1, never ≥ 0. Look-ahead, attack, ×1.15 headroom and oversampling are NOT exposed. | same doc `:83-93` |
| "No adjustable parameter may resize a buffer." | same doc `:100` |
| Storage is `station_config_kv`, station-scoped and synced, and must NOT be in LOCAL_ONLY_KEYS. | same doc `:133` |
| An unconfigured station shows the preset "Ether v1 (shipped)". The first preset is read-only. "· modified" is derived from values, never from a flag. | same doc `:147-150`, `:185-187`, `:198-203` |
| A second instance, `processor_stream`, was proposed. It is now built (see §2). | same doc `:209-233` |
| The controls "will not make both songs audible during the overlap". | same doc `:255-258` |
| The ×1.15 detection headroom makes the effective ceiling "nearer −2.2 dBTP than −1.0". | `docs/hidden-decisions-inventory-2026-09-07.md:54-59` |
| Bypass is a test tool and is never persisted. A bypassed stage reads 0 ("the limiter's rule"). | `docs/ride-meter-honesty-and-processor-popout-2026-09-07.md:50-65`; code `program_processor.rs:83-88`, `:238-255` |
| Bypass has its own command so the 15 s re-assert cannot clear it. | `docs/bypass-dead-button-trace-2026-09-07.md:155-158`; code `audio.rs:362-369` |
| Both toggles OFF by default, bit-identical passthrough, `try_lock` only. | `docs/stream-local-processing-trace-2026-07-31.md:12-16`, `:65-67`; `docs/help-audio-processing.md:27-28` |
| The aux bus goes through "the processor that's already in preferences": same toggle, same target, its own instance. | `docs/aux-bus-clipping-fixes-2026-08-18.md:47-61` |
| The room chain gets `processor_room`. The ride and limiter are non-linear, so room ≠ air − aux. | `docs/aux-monitor-bus-design-2026-08-18.md:54-61`, `:98-102` |
| Phase 2 multiband density is deferred. Its seam is "before the limiter in this same chain". | `docs/stream-local-processing-trace-2026-07-31.md:115-129`; code `program_processor.rs:16` |

### 0.b Import-time loudness / normalization / loudness report
| Ruling / design | Receipt |
|---|---|
| **"It does not touch files. It must stay that way … Any future normalization work writes `songs.gain_db` and nothing else."** | `docs/library-normalization-2026-09-06.md:46`, `:64`, `:170-171` |
| No measurement means no trim ("never invent a measurement"). | same doc `:95-97`; code surfaces it as `isUnmeasured` at `src/App.tsx:158-167` |
| A target change is "a column update", not a re-measure. | same doc `:78` |
| Open recommendation, **not a ruling**: normalize to −18 and ride at −16. Proposes a `normalization_target_lufs` kv key. | same doc `:153`, `:162-164` |
| Loudness report = one line per minute per station in `health-events.jsonl`. No retention policy. | `docs/processing-meters-and-records-2026-08-19.md:75-115` |
| ⚠ The doc says "true peak → `songs.peak_db`" and calls it "a real K-weighted measurement". **The code stores the SAMPLE peak** (`native/src/audio_engine.rs:459-465`). Its "K-weighting" is an approximation (§5). | `docs/library-normalization-2026-09-06.md:36-44` |
| ⚠ The doc says "what reaches the bus is −14". **Statically false on the daemon path** (§5). | same doc `:30` |
| ReplayGain, LKFS: zero hits in docs/. | — |

### 0.c Crossfade / segue
| Ruling / design | Receipt |
|---|---|
| Segue overlap, 0–10 s. "NO fader automation — ever … songs carry their own mastered fade-outs." | `CHANGELOG.md:42-50`; code `audiod/engine.js:114-126` |
| The manual crossfade (X key, XFADE, slider, AUTO-X) was **removed** 2026-09-07. "There is no crossfade anywhere in Ether any more." | `docs/backlog.md:981-1003` |
| The renderer engine still has a timed force-stop at `crossfadeDuration*1000+500`. | `docs/backlog.md:961-979`; code `src/audio/engine-rodio.ts:872` |

### 0.d Ducking
| Ruling / design | Receipt |
|---|---|
| APPROVED design of record. The duck is on the mix path, not in the processor, so it works with processing OFF. | `docs/aux-channel-ducker-announcements-design-2026-08-21.md:19`, `:421-431` |
| §B.3a amendment: a ride HOLD instead of a music-only meter. "While duckGain < 1, LoudnessRide.gain_db does not move." | same doc `:386-417`; code `program_processor.rs:192-209`, `audio.rs:2654` |
| "DUCK IS A CHANNEL FUNCTION, FULL STOP", including the mic. Never hide the DUCK button. Params are per-station, in Preferences → Ducker. | `docs/asset-type-fixed-vs-configurable-2026-08-26.md:118-134` |
| "Ducking never stops or starts anything." | ducker design `:454` |
| Mic-to-program-bus is not implemented. The mic is Web Audio only. | `docs/mic-routing-verdict-2026-07-09.md:5`; still true in code (§1, stage 7) |

### 0.e Metering
| Ruling / design | Receipt |
|---|---|
| One shared `ProcessingTrio`: IN, OUT, RIDE, plus limiter text. A Health Monitor "Decks · aux D–F" row. | `docs/processing-meters-and-records-2026-08-19.md:59-69` |
| "Observed, never claimed." | `docs/build-report-health-monitor-v3-2026-08-14.md:112` |
| ⚠ `docs/help-audio-processing.md:50-60` calls OUT loudness a reading, "not a prediction". **OUT LUFS is computed, not measured** (§4). | — |

### 0.f Conflicts already inside the record (not introduced by this audit)
1. **Is the ceiling fixed?** `docs/help-audio-processing.md:79` says it is fixed. It became a control in 4.6.9 (`docs/ride-meter-honesty-and-processor-popout-2026-09-07.md:144-146`; code `ProcessorRack.tsx:270`). **The help doc is stale.**
2. **Is the ceiling −1 dBTP?** The help doc (`:24`) says yes. `hidden-decisions-inventory:54-59` says ≈ −2.2 effective, because of the ×1.15 at `program_processor.rs:142`.
3. **Duck depth has three values.** The design says −12 (`ducker design:443-452`). The UI and main.js boot fan-out say −22 (`src/components/DuckerSection.tsx:27`, `electron/main.js:5337`). **The engine boots at −28** (`native/src/audio.rs:730`). The comment beside it says "-22 dB, not -12" (`:726`). `DuckerSection.tsx:25` claims the UI defaults are "kept in step" with `BusState::new`. **They are not.** Which depth applies at runtime depends on whether a kv row exists and whether the fan-out ran (§3).
4. **Is the ducker per channel or per station?** The design says per channel (`:443`, `:452`). As built it is per station (`audio.rs:353-355`).
5. **The help docs still describe the manual crossfade** (`docs/help-segue-overlap.md:12`, `:41`; `docs/help-deck-on.md:58-59`, `:86`). It was removed on 2026-09-07 (`backlog.md:998-999`).
6. **Where is segue overlap stored?** `docs/help-segue-overlap.md:45` says "remembered on this machine". The code reads synced `station_config_kv` `segue_overlap_sec` (`audiod/engine.js:1038-1040`).
7. Cart/sweeper duck rulings were reversed across docs (`ducker design:18, :24` vs `operator-closing-screen-and-source-routing-2026-08-31.md:9-11, :291`). The residual is filed in `docs/backlog.md:741-752`.
8. **Where the air-bus clamp lives.** The ruling at `audio.rs:2557-2576` says there is no clamp upstream of the processor. **But the EQ contains a hard ±1.5 clamp when any band is non-zero** (`native/src/eq.rs:241-242`). It sits upstream of the limiter, and the ruling does not mention it.

---

## 1 · The chain, in order

### 1.0 Engines and processes
| Layer | What it is | Receipt |
|---|---|---|
| Rust addon `ether-audio.node` | All sample processing. One `start_station_mixer` per station, i.e. one cpal output stream, one mixer callback and one program-bus ring. | `native/src/lib.rs:27-32`, `native/src/audio.rs:1533` |
| Legacy `start_audio_thread` | rodio `Sink` per deck, with fake levels. **Not called**; `lib.rs` imports only `start_station_mixer`. | `audio.rs:783`, `:929-930`; `lib.rs:18` |
| Daemon `audiod/ether-audiod.js` + `audiod/engine.js` | Hosts the addon out of process and drives automation (segue, jingles, processing delivery). **The default on Windows.** | `electron/main.js:346-350` |
| In-process fallback | Electron main loads the same addon. The renderer's `src/audio/engine-rodio.ts` drives automation. Used when `ETHER_AUDIO_DAEMON=0` or the daemon can't connect. | `electron/main.js:340-350`; memory "cold-stage daemon race" (first launch after an update) |
| Renderer Web Audio | Mic, source-strip capture, editors (StudioPro, CueEditor, ReelSplitter…). **None of it reaches the program bus.** | §1 stage 7 |

**Which does OV run?** The default is the daemon. The in-process fallback exists and is used on the
cold-stage race. **UNVERIFIED for OV today.** Check: OV's `ether-audiod.log` carries `[mix sN]` lines
(`audiod/engine.js:203`), or the Health Monitor's engine field.

**The two hosts differ in DSP delivery, not DSP (static):** only `DaemonEngine._applyProcessingFromKv`
ever calls `audioSetProcessing` (`audiod/engine.js:361`; there are no other callers in `electron/` or
`src/`). So **on the in-process fallback, the processing toggles are never delivered, and the bus stays
at its boot default of OFF** (`audio.rs:693-694`), whatever the kv says. The same is true on the daemon
for a station with no `DaemonEngine`, because the call sits in `DaemonEngine.poll` (`engine.js:557`).
**UNVERIFIED at runtime.** Check: with `proc_local=1` in kv, run with `ETHER_AUDIO_DAEMON=0` and read
the Health Monitor processing panel (it should say "off on both paths" if this holds).

### 1.1 Signal path (all stages in the Rust cpal output callback unless marked)
Mixing runs at `PROGRAM_RATE` 44 100 Hz stereo (`audio.rs:1524`), whatever the device rate is.

| # | Stage | Where | Receipt |
|---|---|---|---|
| 1 | **Decode + resample.** rodio `Decoder` (symphonia) → `UniformSourceIterator` to 2 ch / 44 100. The decoder is *built* on the command thread, but it is a lazy iterator: **decoding and file reads happen inside the callback** on `src.next()`. | built: command thread; pulled: callback | `audio.rs:2212-2228` (build), `:2394-2396` (pull) |
| 2 | **Cue / intro / outro.** **None applied to audio.** No seek or start offset exists in `Load` or the mixer; playback always starts at sample 0. `intro_end`/`outro_start` are carried as metadata only (`loggen.js:169`). Sweeper timing uses `post_ms`/`cut_end_ms` to decide *when* to fire, not what samples play. | daemon JS (timing only) | `audio.rs:1806-1832` (Load: no offset); grep: no `seek`/`skip_duration` in `native/src/audio.rs`, `lib.rs`; `loggen.js:428-437` |
| 3 | **Per-deck trim** `gain_db` → `10^(g/20)`, clamped [0.1, 4.0] (−20…+12 dB). Applied pre-fader. Delivery is broken on the daemon path (§5). | callback | `audio.rs:2362-2364` |
| 4 | **Channel fader + ON (board gate).** `vol = muted ? 0 : volume × trim`. Fader is linear and set only by `SetVolume`; cut is a separate flag. The source still advances while cut. | callback | `audio.rs:2365`, `:1889-1900` |
| 5 | **Sum.** Every active slot is added into `mix`. Non-Source slots also go into `core` (air base) and `room` (× per-slot `room_gain`). Source slots also go into `src`, and into `det` if duck-armed. Immune (`!duckable`) shares go into `imm`/`imm_room`. Aux monitor tap = `lv × aux_monitor_gain` (post-fader, post-cut). | callback | `audio.rs:2338-2441` |
| 6 | **Sweeper / imaging overlay.** No separate stage. A `SlotKind::Sweeper` slot sums into `core` with the music, is ducked with it, and cannot arm the duck. | callback | `audio.rs:1050-1067`, `:2372`, `:2401-2413` |
| 7 | **Mic / AUX D–F inputs.** **AUX D–F (and S1–S5) are playback decks, not inputs**: `SlotKind::Source` slots that play files. There is **no audio input stream in Rust** (grep: no `build_input_stream`/`input_devices` in `native/src/`). **The mic is Web Audio only** → `ctx.destination`. It never reaches the program bus or the stream. | renderer | `audio.rs:1068-1069`; `src/components/MicChannel.tsx:40-52`; `docs/mic-routing-verdict-2026-07-09.md:5` |
| 8 | **Ducker.** Peak detector on the armed-source sum `det`. One-pole attack and release, hold timer, floor = depth. Applied to `core` and `room` (duckable part only), then `mix = core + src`. Skipped entirely (bit-identical) when nothing is armed and gain ≥ 0.999. Runs **before** EQ and processing, whether or not processing is on. The mic cannot trigger it (stage 7). | callback | `audio.rs:2486-2555` |
| 9 | **Master EQ.** 10-band RBJ peaking biquads, Q 1.0. **Hard clamp ±1.5 when any band ≠ 0.** Also feeds a 2048-pt FFT spectrum analyser, run inside the callback every 1024 samples. `try_lock`; on a miss the buffer passes un-EQ'd. | callback | `audio.rs:2577-2590`; `eq.rs:233-258`, `:241-242`, `:159-210` |
| 10 | **Master out** `master_vol`, clamped 0..1. Unity is skipped. | callback | `audio.rs:2602-2608`, `:2100-2104` |
| 11 | **Metering tap: master VU.** Post-EQ, post-master, **pre-processor** peak, with VU release 0.82 per buffer. Per-slot post-fader peaks go into `bus.peaks`. | callback | `audio.rs:2611-2619` |
| 12 | **Loudness ride → limiter, per branch.** LOCAL instance if `proc_local`, STREAM instance if `proc_stream`. Each branch works on its own clone of the clean `out`. `try_lock`; on a miss that branch falls back to the clean tap. The ride is held while ducking. | callback | `audio.rs:2641-2672`; `program_processor.rs:333-342` |
| 13 | **Processor meter taps.** in/out LUFS, GR, ride gain and out peak, per branch. Legacy `proc_*` fields = LOCAL, falling back to STREAM when only the stream is on. | callback | `audio.rs:2678-2693` |
| 14 | **Split → stream.** Only while an Icecast client is connected (`stream_connected`). Takes STREAM-processed if `proc_stream`, else **clean clamped to ±1.0**. `try_push` into a 4 s SPSC ring (drops when full). | callback | `audio.rs:2703-2720`, `:1525` |
| 15 | **Drain → encoder.** Separate thread. Ring → optional **broadcast (profanity) delay** FIFO (stream only), with an 0.80 consume-ratio rebuild through near-silence (`peak < 0.02`) → f32le over TCP localhost. ffmpeg → Icecast downstream. | drain thread + ffmpeg | `audio.rs:2929-3111`, `:3040-3047`; `audiod/stream.js` |
| 16 | **Split → room (monitor).** If any aux deck is producing: `room` → `eq_room` (**hard clamp ±1.0 on the way in**) → master_vol → `processor_room` (if `proc_local`). Otherwise the LOCAL-processed buffer if `proc_local`, else clean clamped to ±1.0. | callback | `audio.rs:2735-2796` |
| 17 | **Aux monitor bus.** `aux` sum → `processor_aux` (if `proc_local`, same params as LOCAL) → aux ring → **second cpal stream** on the operator-chosen device. Linear resample 44.1k → device rate, with ±0.3 % drift nudge. Silence when no device is chosen. | callback + aux callback | `audio.rs:2825-2883`, `:1593-1733` |
| 18 | **Room VU + monitor gains.** `room_peak` from the device feed (pre-knob), then × `monitor_vol × master_monitor_vol`, then linear-interp resample 44.1k → device rate. Mono devices get (L+R)/2. | callback | `audio.rs:2885-2923` |
| 19 | **Headphones / PFL.** **There is no PFL/cue bus in the engine.** The aux monitor was a true PFL until 2026-08-18, then deliberately made post-fader (`audio.rs:2373-2383`). The only "cue headphones" path is the **mic** cue in Web Audio (`MicChannel.tsx:75-88`, `setSinkId`). | — | — |
| 20 | **Multi-output.** Per station: one main device + one optional aux device. The per-station output device is chosen by name, with a fallback to the default device for main but **never** for aux. | — | `audio.rs:2169-2210` |

**Crossfade: there is none.** Segue = the incoming deck starts at full level `segueOverlap` seconds
before the outgoing ends. There is no gain ramp on either deck, and the outgoing plays to its natural
end (`audiod/engine.js:114-126`, `:1079-1110`, `:2492-2518`). A SPOT edge gets no overlap
(`engine.js:2510-2513`). An operator take-over hard-stops the outgoing after `SAFETY_CUT_MS` = 300 ms
(`engine.js:35`, `:1101-1107`). On the renderer (in-process) path there is still a timed
`audio_stop` at `crossfadeDuration*1000+500` = 3.5 s after the rotate (`src/audio/engine-rodio.ts:158`,
`:872`). The daemon removed exactly that timer because it clipped segued songs
(`engine.js:1082-1094`). **So the in-process fallback can still cut the end off a segued song.**
Runtime **UNVERIFIED**.

---

## 2 · Where the loudness stage sits

**Post-sum, post-duck, post-EQ, post-master-fader, per branch, per station.** It is not per deck, not
per channel, and not inside the encoder. Call graph:

```
cpal callback (audio.rs:1775)
 └ mixer_callback(data,…)                          audio.rs:2268
    ├ sum decks → mix/core/room/src/det            :2338-2441
    ├ ducker (core/room in place, mix rebuilt)     :2486-2555
    ├ eq.process_stereo → out_l/out_r              :2577-2590
    ├ × master_vol                                 :2602-2608
    ├ run_branch(processor, LOCAL params)          :2662-2666   ← clones out_* (:2645-2646)
    │   └ ProgramProcessor::process_planar(pl,pr)  program_processor.rs:333
    │       ├ scratch ← interleave(pl,pr)          :335-336
    │       ├ LoudnessRide::update(scratch)        :229  (ebur128 Mode::M add_frames_f32 :230)
    │       └ per sample: TruePeakLimiter::process(l*g, r*g) → pl/pr   :338-341
    ├ run_branch(processor_stream, STREAM params)  :2668-2672
    ├ stream tap: str_l/str_r → ring_prod          :2703-2720
    ├ [aux present] processor_room over room chain :2757-2767
    ├ [aux present & proc_local] processor_aux     :2825-2844
    └ device write from dl/dr                      :2783-2923
```

The ride applies **one gain per callback buffer** (`program_processor.rs:337-340`): a step, not a
per-sample ramp. At the default 1.5 dB/s the step is at most 0.15 dB per 100 ms eval tick (`:261`).

### Do monitor and stream hear the SAME processed audio?
**No, as of the 2026-09-07 split. They match only in one configuration.**

| proc_local | proc_stream | proc_split | aux deck live | Monitor hears | Stream hears | Same samples? |
|---|---|---|---|---|---|---|
| off | off | – | no | clean, clamped ±1 (`:2792`) | clean, clamped ±1 (`:2715`) | **Yes** (same `out`, same clamp) |
| on | off | – | no | LOCAL processed | clean, clamped | No |
| off | on | – | no | clean, clamped | STREAM processed | No |
| on | on | **off** (linked) | no | LOCAL processed | STREAM processed | **Yes, bit-identical by construction** (same params, same input, fresh-equal state; C7 `program_processor.rs:555-584`), *if both instances have run over identical history* |
| on | on | on | no | LOCAL params | STREAM params | No |
| any | any | any | **yes** | `room` sum (aux excluded, per-slot room gains) → eq_room (clamp ±1) → processor_room | `mix` (aux **included**) → STREAM or clean | **No — different sums** |

Caveats that break "linked = identical" at runtime (static reasoning, **UNVERIFIED**):
- **State divergence.** Each instance runs only while its own toggle is on (`audio.rs:2662`, `:2668`).
  If the operator turns `proc_local` on 10 minutes after `proc_stream`, the two ride integrators and
  meters hold different state. They reconverge only at the ride rate. C7 starts both instances fresh.
- **`try_lock` misses** are per instance (`:2648`). One branch can fall back to clean for a buffer
  while the other processes.
- **Monitor gain and resample.** The monitor is further scaled by `monitor_vol × master_monitor_vol`
  and linear-resampled to the device rate (`:2893-2923`). The stream is 44.1k f32 into ffmpeg. So even
  with identical processed samples, what reaches the ear and what reaches the encoder differ by gain and
  resampler. **The parity test must tap before `mvol`/resample**: `dl/dr` at `:2783` vs the ring push
  at `:2717`.
- **Broadcast delay** time-shifts the stream (`:2970-3081`) and, below target, time-stretches it through
  near-silence (ratio 0.80, `:3046`). A parity harness must run with delay off.

---

## 3 · Every constant

"UI" = operator-changeable from the app. "DB" = persisted key. The engine clamp is what Rust accepts;
the UI range is what the control offers.

### 3.1 Loudness ride (`LoudnessRide`)
| Constant | Value | Receipt | Changeable? |
|---|---|---|---|
| Target | −14 LUFS default | `audio.rs:695`, `:709`; `program_processor.rs:283-292` | **UI** Target slider −30…−6 step 1 (`ProcessorRack.tsx:253`); DB `proc_target_lufs` / `proc_stream_target_lufs`; engine clamp −30…−6 (`audio.rs:2125`, `:2131`, `:2147`) |
| Meter mode | EBU R128 **momentary** (`Mode::M`, 400 ms) | `program_processor.rs:218` | No |
| Eval / integration cadence | every `fs × 0.100` frames (~100 ms), evaluated only when a buffer crosses it | `:222`, `:232-234` | No |
| Gate | measurement ignored unless `m > −70` and finite; ride frozen below | `:236` | No |
| Rate | 1.5 dB/s | `:221`; `audio.rs:700` | **UI** 0.3…6 step 0.1 (`ProcessorRack.tsx:256`); DB `proc_ride_rate`; engine 0.1…12 (`program_processor.rs:309`) |
| Max gain up/down | ±12 dB | `:221`, `:263`; `audio.rs:701` | **UI** Clamp 3…18 (`ProcessorRack.tsx:259`); DB `proc_ride_clamp`; engine 0…24 (`program_processor.rs:310`) |
| Gain application | one scalar per buffer (step) | `:337-340`, `:347-351` | No |
| Duck hold | ride frozen while duck gain < 0.999 | `audio.rs:2546`, `:2654` | No |
| Bypass | live only, never persisted | `program_processor.rs:210-214`; `audio.rs:702-705` | **UI** (rack), not stored |

### 3.2 True-peak limiter (`TruePeakLimiter`)
| Constant | Value | Receipt | Changeable? |
|---|---|---|---|
| Ceiling | −1.0 dBTP | `program_processor.rs:20`; `audio.rs:698` | **UI** −3…−0.1 step 0.1 (`ProcessorRack.tsx:270`); DB `proc_ceiling_dbtp`; engine −12…−0.1 (`program_processor.rs:130`, `audio.rs:2136`) |
| Detection headroom | ×1.15 (≈ +1.2 dB) → effective ≈ −2.2 dBTP | `:142` | No (deliberate, `:297-299`) |
| Look-ahead | `round(fs × 0.0015)`, min 8 → 66 samples at 44.1k ≈ 1.5 ms | `:116` | No (sizes buffers, `:128-129`) |
| Attack | one-pole, τ = la/2 samples (completes within look-ahead) | `:118` | No |
| Release | 120 ms one-pole | `:119`; `audio.rs:699` | **UI** 30…500 ms step 10 (`ProcessorRack.tsx:273`); DB `proc_release_ms`; engine 5…2000 (`program_processor.rs:131`) |
| Oversampling | 4× polyphase, 8 taps/phase, Hann-windowed sinc, unity-DC per phase | `:26-57` | No |
| Band split | **none** (wideband) | — | — |
| Output latency | `la` samples when the limiter is active; 0 when bypassed (delay line not advanced) | `:137-140`, `:361-362` | No |
| Bypass | live only, never persisted | `:83-88` | **UI**, not stored |

### 3.3 Ducker (per station)
| Constant | Engine boot | UI / main.js default | Receipt | Changeable? |
|---|---|---|---|---|
| Depth | **−28 dB** | **−22 dB** | `audio.rs:730` vs `DuckerSection.tsx:27`, `electron/main.js:5337` | UI 0…40 dB down; DB `duck_depth_db`; engine −60…0 (`audio.rs:1942`) |
| Threshold | 0.0056 (≈ −45 dBFS) | −45 | `audio.rs:725`; `DuckerSection.tsx:28` | UI −70…−10; DB `duck_threshold_db`; engine −90…0 |
| Attack | 30 ms | 30 | `audio.rs:731` | UI 1…300; DB `duck_attack_ms`; engine 1…1000 |
| Hold | 700 ms | 700 | `audio.rs:732` | UI 0…3000; DB `duck_hold_ms`; engine 0…5000 |
| Release | 500 ms | 500 | `audio.rs:733` | UI 50…3000; DB `duck_release_ms`; engine 1…5000 |
| Detector | peak of armed-source sum, per sample | `audio.rs:2504` | No |
| Coeff update | per buffer | `audio.rs:2491-2494` | No |
| Arm (per channel) | `deck_configs.duck` | `electron/main.js:5296-5311` | UI (source strip) |
| Duckable (per deck) | `deck_configs.duckable`, default 1 | `audio.rs:724`; `main.js:5296` | UI |

**Depth at runtime depends on path (static; UNVERIFIED).** The boot fan-out sends params only for
stations with a `type='source'` deck, falling back to −22 when the kv key is absent
(`main.js:5328-5343`). A station that has no source deck at boot keeps the engine's −28.

### 3.4 Crossfade / segue
| Constant | Value | Receipt | Changeable? |
|---|---|---|---|
| Crossfade curve | **none**: no gain ramp exists | `audiod/engine.js:114-118` | — |
| Segue overlap | default 0 until kv arrives; range 0…10 s, integer | `engine.js:126`, `:1042-1044` | **UI**; DB `segue_overlap_sec` (synced) |
| `crossfadeDuration` | 3 s: preload cadence on the daemon; a **stop timer** on the renderer path (3.5 s) | `engine.js:113`, `:1099`; `engine-rodio.ts:158`, `:872` | No UI since 2026-09-07 |
| Operator take-over cut | 300 ms | `engine.js:35` | No |

### 3.5 Per-deck trim, faders, monitor
| Constant | Value | Receipt | Changeable? |
|---|---|---|---|
| Trim clamp | 0.1…4.0 linear (−20…+12 dB) | `audio.rs:2363` | No |
| Import trim clamp | −12…+12 dB, rounded to 0.1 | `audio_engine.rs:548`, `:554` | No |
| Import target | −14 LUFS | `audio_engine.rs:457`; `lufs.rs:10` | **No**: hard-coded in two places |
| Master out | 0…1 | `audio.rs:2103` | UI |
| Monitor strip | 0…4 | `audio.rs:2098` | UI; DB `monitor_volume` |
| Master monitor | 0…1 | `audio.rs:2106` | UI |
| Aux slot level | 0…4 | `audio.rs:1956` | UI |
| VU release | 0.82 per buffer (time constant depends on buffer size) | `audio.rs:2617` | No |
| Clean-tap clamp | ±1.0 (hard) | `audio.rs:2715`, `:2792` | No |
| EQ clamp | ±1.5 (hard, only when EQ active) | `eq.rs:242` | No |
| Room EQ clamp | ±1.0 (hard) | `audio.rs:2744-2751` | No |
| EQ Q | 1.0 | `eq.rs:18` | No |
| EQ band gains | 10 bands | `eq.rs:11-14`, `:214-221` | UI; DB `eq_master` (`main.js:2035`) |
| Aux resample drift nudge | ±0.3 %, target fill 40 ms | `audio.rs:1646`, `:1666` | No |
| Broadcast delay rebuild | ratio 0.80 below peak 0.02; FIFO cap 15 s | `audio.rs:3046`, `:2963` | Delay seconds: UI |

---

## 4 · Measured vs applied

- **−14 is a target the ride drives toward, not just a meter.** `desired = target − in_lufs`, and
  `gain_db` walks toward it at `rate`, clamped to ±`clamp` (`program_processor.rs:260-263`). It is
  applied as `db_to_lin(gain_db)` to the buffer (`:271`, `:337-339`).
- **Source of each reading.** Everything below comes from one path: callback writes `bus.*` →
  `GetLevel` on the command thread copies into `AudioLevels` (`audio.rs:1967-2071`) → NAPI
  `audio_get_levels` sends `GetLevel`, then **reads the previous snapshot** (it does not wait:
  `lib.rs:311-312`), and hand-builds JSON (`lib.rs:330-380`) → daemon station loop every **100 ms**
  (`audiod/ether-audiod.js:529`, `:594`) → `procmeters` event (`:549-587`) → renderer / Health Monitor.
  So the meters are **the same numbers the processor uses** (the same fields on the same instance). They
  are not a separate meter path. The cadence is 10 Hz, up to one tick stale. Docs say ~15 Hz
  (`processing-meters-and-records-2026-08-19.md`; `engine.js:375`); the live emitter is 100 ms.

| Reading | What it is | Tap | Receipt |
|---|---|---|---|
| **IN LUFS** | EBU R128 **momentary** loudness of the processor's input: post-EQ, post-master, post-duck | ride meter | `program_processor.rs:230`, `:235-237`; `audio.rs:2657` |
| **OUT LUFS** | **ESTIMATE** = `in_lufs + gain_db`. Pre-limiter, never measured on output. Equals IN when bypassed. | computed | `program_processor.rs:265`, `:255` |
| **TARGET** | the target the engine is running (echoed), not the UI copy | bus field | `audio.rs:1995`, `:2022` |
| **RIDE** | `ride.gain_db`, the applied corrective gain (signed). 0 when bypassed. | ride state | `program_processor.rs:359`; `audio.rs:1999` |
| **Limiter (GR)** | `−20·log10(gain)` of the limiter's current smoothed gain, **last sample of the buffer** | limiter state | `program_processor.rs:176`, `:360` |
| IN / OUT peak | IN = master VU peak (post-master, pre-proc, sample peak); OUT = sample peak of the processed buffer. Both with 0.82 release. **Sample peak, not true peak.** | callback | `audio.rs:2611-2613`, `:2656`, `:2680-2681` |
| **DECKS AUX D–F** row | `aux_proc_*` from `processor_aux`: same fields, same semantics (OUT is also an estimate). Shown only when `aux_peak > 0` or aux out > −69. | aux instance | `audio.rs:2829-2843`; `ether-audiod.js:581-585` |
| Duck gain | smoothed linear duck gain, end of buffer | callback | `audio.rs:2542`, `:1986` |

**The LUFS meter is momentary (400 ms)**, not short-term and not integrated (`Mode::M`,
`program_processor.rs:218`; `loudness_momentary()`, `:235`). The only integrated measurement in the
product is the import analyser (§5) and the bench's `Mode::I` (`:398`).

---

## 5 · Tier 1 today: import loudness → catalogue → deck gain

**Verdict: PARTIAL. Measured and stored, yes. Applied on air, statically NO on the daemon path.**

| Piece | Status | Receipt |
|---|---|---|
| Analyzer at import | **Built.** `ImportDialog` → `analyzeAndSave` → NAPI `analyze_song` → `measure_loudness` | `src/components/ImportDialog.tsx:110`; `src/audio/songAnalysis.ts:107-128`; `native/src/audio_engine.rs:905-932`, `:456-540` |
| Columns | `songs.lufs_measured`, `songs.peak_db`, `songs.gain_db`, `songs.is_processed` (synced scalars) | `songAnalysis.ts:115-121`; `electron/sync/synced-tables.js:152` |
| Batch pass | `processLibrary` (Settings / Processing panel / Smart Scheduler) | `songAnalysis.ts:136-150`; `SettingsPanel.tsx:11`, `ProcessingPanel.tsx:2` |
| ffmpeg | **Not used.** The analysis is in Rust (symphonia). **The checklist's "via ffmpeg" does not describe the code.** | `audio_engine.rs:854-900` |
| Target −14 | hard-coded | `audio_engine.rs:457` |
| Loudness report | Library view shows `lufs_measured`/`gain_db` (`ProcessingPanel.tsx:24`) and the "unmeasured" warning with median trim (`App.tsx:158-172`); `library-health.js:312` median trim | built (display) |
| **Applied as deck gain at load** | Rust applies `slot.gain_db` pre-fader (`audio.rs:1827`, `:2362-2365`). **But the daemon never supplies it:** `loggen.js`'s `SELECT` has no `gain_db` (`:160-161`), `toItem` has no `gainDb` (`:167-173`), neither do the sweeper/spot item literals (`:433-436`, `:460-461`), and `engine.js:1702` passes `item.gainDb` → `undefined` → `?? 0` (`:439`). No file in `audiod/` names `gain_db` except the heartbeat print (`engine.js:201`). Renderer queue builders don't map it either; `gainDb` is only passed through (`engine-rodio.ts:1040`). | **Statically NOT applied on automation loads. UNVERIFIED at runtime.** Check: `[mix sN] … g=+x.x` (`engine.js:201`) during automation playback of a song whose `gain_db ≠ 0`. `g=+0.0` on every deck confirms it. |

**Two analysers disagree. Neither is the one the docs describe.**
- `native/src/audio_engine.rs:measure_loudness` (**the one import uses**). Its "K-weighting" uses the
  **48 kHz BS.1770 coefficients at any sample rate** (`:568-579`; wrong at 44.1k). It resets filter
  state on every 400 ms block (`:591`, `:600`). It measures a **mono downmix** (`:585-588`), where
  BS.1770 sums per-channel energy. It gates with the **arithmetic mean of dB values**, where R128
  averages energy (`:520-531`). It falls back to **−23** when nothing measures (`:508`, `:517`). Its
  `peak_db` is **sample peak** (`:460`). ⚠ `library-normalization-2026-09-06.md:36-44` calls it "a real
  K-weighted measurement" and "true peak".
- `native/src/lufs.rs:analyze_file` (the correct `ebur128` `Mode::I`). It is reached only by the
  "Analyze LUFS" button (`src/App.tsx:5350-5359` → `electron/main.js:6265-6267`). **It returns a
  GAIN, and on any error both layers return `-14`** (`lib.rs:673`; `main.js:6267`), which is then
  **written as `gain_db = −14 dB`** (`App.tsx:5356`). That button also selects only rows with
  `gain_db = 0` (`:5352`).

---

## 6 · Realtime safety of the audio callback

Scope: `mixer_callback` (`audio.rs:2268-2927`), everything it calls, the closure around it
(`:1775-1779`) and the aux callback (`:1650-1692`).

### 6.1 Heap allocation / deallocation per buffer
| Line | What |
|---|---|
| `audio.rs:2293-2294` | `vec![0; prog_frames]` × 2 (mix) |
| `:2305-2312` | × 8 (room, imm_room, core, aux) |
| `:2322-2323` | × 2 (src) |
| `:2328-2331` | × 4 (imm, det) → **16 allocations before any audio is touched** |
| `:2578-2579` | `Vec::with_capacity` × 2 (EQ out) |
| `:2589` | `mix_*.clone()` × 2 (EQ lock miss) |
| `:2606-2607` | `.collect()` × 2 when master ≠ 1.0 |
| `:2645-2646` | `out_*.clone()` × 2 **per processed branch** |
| `:2740-2741`, `:2750-2751` | room EQ vecs × 2 (aux present) |
| `:2792-2793` | clean-tap clamp `.collect()` × 2 |
| `program_processor.rs:335-336` | `scratch.push`: capacity 8192 (`:288`). **Grows (allocates) when a buffer exceeds 4096 frames.** |
| `audio.rs:2445` | `source = None` **drops the decoder Box** (free + file handle close) on natural end |
| `audio.rs:2394-2396` | `src.next()`: symphonia decode **inside the callback**. It allocates per packet, depending on the codec (**UNVERIFIED**, third-party). |
| `program_processor.rs:230` | `ebur128::add_frames_f32`: whether it allocates is **UNVERIFIED** (third-party crate). |

### 6.2 Syscalls / blocking I/O / logging
| Line | What |
|---|---|
| `audio.rs:2394` (via `build_source` `BufReader<File>`, `:2220-2221`) | **File reads in the callback**, whenever the BufReader refills |
| `audio.rs:2454` | `eprintln!` on natural end (stderr write, takes the stderr lock) |
| `audio.rs:1778` → `:20-25` | `SystemTime::now()` on **every** callback |
| `audio.rs:1680`, `:1693` | `eprintln!` in cpal error callbacks (not the data path) |

### 6.3 Locks
| Line | Lock | Behaviour |
|---|---|---|
| `audio.rs:2279` | bus `try_lock` | On a miss: **output silence and push nothing to the stream ring** for that buffer (`:2281`). The stream is not zero-filled, so a gap becomes ring underrun downstream. |
| `:2577`, `:2739` | eq / eq_room `try_lock` | miss → un-EQ'd buffer |
| `:2648`, `:2759`, `:2829` | processor `try_lock` | miss → clean for that branch |
| `:2925` | `playing.try_lock` | miss → stale flag |
| **Contention sources (not in the callback):** `GetLevel` holds the bus lock **and** the levels lock while it builds 12 `DeckTel` with `to_string()` allocations (`audio.rs:1971-2071`), at 10 Hz per station from the daemon. `Load` holds the bus lock while it assigns (and drops the old) decoder (`:1810-1830`). `SetEq` locks the bus twice (`:2088-2095`). Every one of these is a window in which the callback outputs a **silent buffer**. How often it happens is **UNVERIFIED**. Check: count buffers where `frames_consumed` fails to advance while playing. |

### 6.4 Channels
The callback sends on no channel. The ring pushes are lock-free `try_push` that drop when the ring is
full (`audio.rs:2717-2718`, `:2879-2880`).

### 6.5 Float denormals
**No flush-to-zero or denormals-are-zero is set anywhere** (grep: no `denormal`/`flush_to_zero`/`MXCSR`
in `native/src/`). Recursive state that can decay into subnormals on silence or fade tails:
- EQ biquads, 10 in series × 2 channels × 2 chains (`eq.rs:233-240`), when the EQ is active
- the oversampler FIR history (`program_processor.rs:60-76`)
- the aux underrun decay `cur * 0.5` repeated (`audio.rs:1678`)

(The limiter gain, ride and duck envelopes converge to 1.0, not 0, so they are low risk.) On x86 SSE a
subnormal is 10–100× slower per operation. **Whether it is measurable here is UNVERIFIED.**

### 6.6 Other callback-thread work
- The EQ spectrum analyser runs a 2048-point FFT **inside the callback** every 1024 samples
  (`eq.rs:249-253`, `:159-166`). Its scratch is preallocated (`:117`, `:146`); `mags` is a 4 KB stack
  array (`:175`).
- **EQ sample-rate mismatch.** The EQ is re-tuned to the **device** rate (`audio.rs:1756`,
  `eq.rs:223-228`) but processes **44 100 Hz** program audio (`audio.rs:2581`). On a 48 kHz device every
  band is ~8.8 % sharp. `eq_room` is never re-tuned (stays 44 100, `audio.rs:745`), so **air and room EQ
  differ on 48 kHz devices** whenever an aux deck is live. The spectrum `bin_hz` uses the same wrong
  rate (`eq.rs:169`). Runtime is **UNVERIFIED**. Check: the device rate in the `[RUST] Station N device:`
  log line (`audio.rs:2190`).

### 6.7 Verdict for the rack
The processor module itself was built to the rule "no heap allocation, no new lock"
(`program_processor.rs:7-11`), and C3/C5 bench it at ~0.03–0.06 ms per 10 ms block
(`audio.rs:2634-2636`). **The callback around it breaks that rule on every buffer** (6.1–6.3). Adding
rack stages into this callback **before** hoisting the buffers into preallocated `BusState` scratch,
moving decode off the audio thread (a decode-ahead ring per deck), dropping decoders off-thread and
setting FTZ/DAZ would stack new work onto an unsafe base. Which of these actually causes xruns on OV
is **UNVERIFIED**.

---

## 7 · Persistence and scope

| Setting | Where | Scope | Syncs? | Receipt |
|---|---|---|---|---|
| `proc_local`, `proc_stream`, `proc_target_lufs`, `proc_ceiling_dbtp`, `proc_release_ms`, `proc_ride_rate`, `proc_ride_clamp`, `proc_split`, `proc_stream_*` (×5) | `station_config_kv` | per station (integer `station_id`) | **Yes**: not in `LOCAL_ONLY_KEYS` | `audiod/engine.js:311-327`; `electron/sync/handlers/station_config_kv.js:69` |
| Bypasses | engine memory only | per station, per process | never persisted | `program_processor.rs:83-88`; `audio.rs:702-705` |
| Ducker params `duck_*` (×5) | `station_config_kv` | per station | Yes | `main.js:5328-5343`; `DuckerSection.tsx:37-40` |
| Duck arm / duckable | `deck_configs.duck` / `.duckable` | per channel row | Yes (`deck_configs` synced) | `main.js:5296` |
| Master EQ `eq_master` (+ `eq_deck_*`) | `station_config_kv` | per station | Yes | `main.js:2035` |
| Segue overlap `segue_overlap_sec` | `station_config_kv` | per station | Yes | `engine.js:1038-1040` |
| Monitor volume `monitor_volume` | `station_config_kv` | per station | Yes | `StationMonitorMixer.tsx:43` |
| **Output device `audio_output_device`, aux device `aux_monitor_device`** | `station_config_kv` via `upsertByKey` | per station | **Yes. A machine-local value on the synced path.** | `AudioRoutingPanel.tsx:131`; `AuxMonitorSlots.tsx:53`, `:190`; not in `station_config_kv.js:69` |
| Per-song trim | `songs.gain_db` / `lufs_measured` / `peak_db` | per song row | Yes | `synced-tables.js:152` |
| Import target | code literal | global | n/a | `audio_engine.rs:457` |

**Does the Sep 4 machine-local problem apply?** `docs/design-machine-local-paths-2026-09-04.md` is
about absolute file paths in `blob-ref` columns crossing machines (`:13-17`). **The processor numbers
are machine-independent values, so they do not have that problem.** The same class of defect does
apply to **`audio_output_device` and `aux_monitor_device`**: sound-card names synced from one machine
to another. On the receiver the main device falls back to the default (`audio.rs:2182`), and aux stays
silent (`audio.rs:1714-1723`). Noted in one line per the scope rule; not investigated further.

A second scope caveat: kv rows are keyed by the **local integer `station_id`** (`engine.js:311-313`), and
the known peer-sync identity defect is integer-vs-UUID (memory: "Peer-sync station identity defect").
Whether processor settings land on the right station across installs is **UNVERIFIED**.

**What a per-station rack preset should key to.** `station_config_kv(station_id, key)`, like every
processor number today. That matches the ruling at `audio-processing-controls-2026-09-06.md:133` and
the "Ether v1 (shipped)" preset at `:147-150`. The station row's UUID should be the identity if presets
must survive the peer-sync defect. Suggested shape (a proposal, not a ruling): one key per branch
holding a named preset plus overrides, e.g. `proc_preset` / `proc_stream_preset`. That way
"· modified" stays derived from values (`:198-203`). Bypass must stay out of it.

---

## 8 · Test surface

### 8.1 What exists, and what each one proves

**Rust, real `mixer_callback` and real processor, synthetic sources.** No npm script runs them; they
are run by hand with `cd native && cargo test --lib <module> -- --nocapture`
(`program_processor.rs:366-367`). `Cargo.toml:7-8` builds `cdylib` only. There is no `native/tests`,
no `benches` and no `[[bin]]`. `eq.rs`, `lufs.rs` and `audio_engine.rs` have **no tests**.

| Test | Proves | Receipt |
|---|---|---|
| `slice1_regression::abc_cart_bit_identical_with_no_source_channels` | With A/B/C/CART playing PRNG sources, the device output checksum equals `GOLDEN_7_SLOT` | `audio.rs:1140-1165`, `:1295-1303` |
| `slice1_regression::room_chain_bit_identical_across_the_room_gain_split` | With an aux deck up, the room chain (eq_room → master → processor_room → monitor gains) equals `GOLDEN_ROOM` | `audio.rs:1180-1221` |
| `slice1_regression::aux_monitor_single_pass_regression` | The aux ring with `proc_local` on equals `GOLDEN_AUX_SINGLE_PASS`. It is proven to detect the old double pass. | `audio.rs:1233-1282` |
| `duck_regression::*` | Engage / hold / release to the configured floor; a track gap does not snap; off = no duck; immune decks; Rotation/CART cannot arm; ride frozen while ducked | `audio.rs:1306-1522` |
| `program_processor::bench` C1 | Quiet and hot inputs converge to within 1.2 LU of each other, and within ±1.5 of −14 (settled tail) | `program_processor.rs:425-441` |
| C2 | **Trivial**: compares a clone to itself. It proves nothing about the mixer. | `:444-452` |
| C3 / C5 | Block time under budget; two instances < 1 ms median | `:455-466`, `:597-646` |
| C4 | Cart burst on the bus is held ≤ −0.95 dBTP | `:649-663` |
| C6 | Both-bypassed = bit-identical; ceiling held at four corner settings (BS.1770 true peak); bypassed ride reports 0 | `:476-544` |
| C7 | Two linked instances = one shared instance, bit-identical; different params do differ | `:555-594` |
| `deck_finished_key_tests` | Slot → finished-key mapping, bounds-safe | `audio.rs:1096-1111` |

**audiod smokes (`node audiod/<file>`): JS state contracts. The addon is stubbed and no audio flows.**
| Smoke | Proves |
|---|---|
| `smoke-xfade-contract.js` | Deck ON goes through `_advance`; safety cut; rapid-press safety (`:1-12`, asserts ~`:60-90`) |
| `smoke-seam-stop.js` | The outgoing deck is never stopped while it still reports playing |
| `smoke-dead-air.js` | Advance/recue chain; an emptied deck is refused, not played silent |
| `smoke-deck-position.js` | frames_played is the position authority over the wall clock (frames are injected) |
| `smoke-meter-contract.js` | **Source contract**: every levels key a consumer reads is emitted in `lib.rs`'s `json!` (reads `native/src/lib.rs`, `:39`) |
| `smoke-manual-mode.js`, `-deck-identity`, `-deck-snapshot`, `-autopost-arm`, `-enginestate(-wire)`, `-autofit`, `-queue-classes`, `-topofhour`, `-logreader-anchor` | Engine state / scheduling contracts, no audio |

**Realtime, real device, gated `--i-am-off-air`. None of them capture samples:**
- `audiod/smoke-test.js` (levels > 0.001, `:5`, `:9`), `smoke-automation.js`, `smoke-playlog.js`,
  `accept-offair.js`, `accept-detach.js`, and `smoke-stream.js` (ffmpeg lifecycle).
- `scripts/test-segue-overlap.js` and `scripts/test-fader-invariant.js`: overlap and fader invariants,
  read from the levels meter.
- `scripts/spike-ffmpeg-from-programbus.js`: the **only** encoder-tap capture. It is realtime, needs a
  device, writes an MP3, and only checks size plus MP3 sync.

**Other:** `npm run check:audio-isolation` (a static grep for global audio statics, `package.json:23`),
`scripts/diag-c5-artifact.js` (processor bench through NAPI `audio_bench_processor`, `lib.rs:403-463`,
timing only), `scripts/diag-bypass-roundtrip.js`. `debug-stream.f32le` in the repo root has **no
writer in history**: only its `.gitignore:60` entry was ever committed.

### 8.2 Can a file be rendered offline through the live chain today?
**No.** `mixer_callback` is reached only from the cpal output callback (`audio.rs:1773-1776`). With no
device, the thread sleeps and retries (`:1745-1750`). No null device and no render entry point exist.
The Rust tests prove the mixer is **drivable offline**, but:
- they feed synthetic iterators, never `build_source(file)`;
- they discard the program-bus consumer (`let (prod, _cons)`, `:1142`);
- they never set `stream_connected = true`, so the stream tap at `:2703` is never written.

### 8.3 The smallest change that enables it (the parity-harness prerequisite)
Everything needed already exists in `audio.rs`. It only has to be put together:

1. A `pub fn render_offline(path, cfg) -> (Vec<f32> /*monitor tap*/, Vec<f32> /*stream tap*/)` in
   `native/src/audio.rs`, inside the module that owns the private `mixer_callback`:
   - build `HeapRb::<f32>::new(PROGRAM_BUS_BUF)` and keep **both** halves;
   - `BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(true)))`, so `stream_connected` is on and
     the device rate equals `PROGRAM_RATE` (no resample on the monitor path);
   - apply `cfg` to the bus fields (`proc_local`/`proc_stream`/params/`proc_split` mirror, master,
     `monitor_vol = master_monitor_vol = 1.0`, `gain_db`);
   - `decks[0].source = build_source(path, 44100)`, with `active = true, paused = false, volume = 1.0`;
   - loop `mixer_callback(&mut data /*480×2*/, 2, &bus, &fin, &playing)`, and after **every** call
     append `data` (monitor tap, post-`mvol`) and drain `cons.pop_slice` (stream tap), so the 4 s ring
     never fills and drops samples at `:2717`. Stop when `fin.take("A")` fires plus one look-ahead of
     tail.
2. Expose it either as a `#[cfg(test)]` test that writes WAV/f32 to a temp dir (no product surface,
   zero risk to air), or as `#[napi] audio_render_offline(path, cfg_json, out_dir)` so node scripts can
   run the same `.node` that ships. The NAPI form is what lets the harness run against the **packaged
   artifact**.

Properties this gives Stage 2 for free:
- It is faster than realtime: nothing paces the loop.
- It is deterministic: the callback holds no clock or RNG, as the golden tests already rely on at
  `:1116-1120`.
- It gives the monitor and stream taps side by side for the parity question in §2.

What it **does not** cover:
- device resampling (only runs when device sr ≠ 44 100, `:2903-2923`);
- the broadcast delay (drain thread);
- ffmpeg/encoder coloration;
- `try_lock`-miss fallbacks, which never happen single-threaded.

Those need a separate realtime check.

---

## 9 · The operator's list: numbers in this path Jeff cannot see or change

### Front panel (belongs beside target / ceiling / on-off)
| Number | Today | Receipt |
|---|---|---|
| **Import normalization target** −14 | hard-coded twice | `audio_engine.rs:457`, `lufs.rs:10` (proposed kv key: `library-normalization-2026-09-06.md:162-164`) |
| **Whether the per-song trim is applied on air** | statically not on the daemon path; nothing on screen says so | §5 |
| **Effective ceiling** ≈ −2.2 dBTP vs a displayed −1.0 | the ×1.15 is not shown | `program_processor.rs:142` |
| **OUT LUFS is an estimate** | presented as a reading | `program_processor.rs:265` |
| **Which meter mode** (momentary 400 ms) | not labelled | `program_processor.rs:218` |
| **Duck depth actually running** (−28 engine boot vs −22 UI default) | UI shows its own default, not the engine's | `audio.rs:730`; `DuckerSection.tsx:27` |

### Advanced drawer (timing, gate, band behaviour)
| Number | Receipt |
|---|---|
| Ride eval cadence 100 ms | `program_processor.rs:222` |
| Ride gate −70 LUFS | `:236` |
| Limiter look-ahead 1.5 ms (would need a realloc path) | `:116`, `:128-129` |
| Limiter attack (τ = la/2) | `:118` |
| EQ Q 1.0 | `eq.rs:18` |
| Import trim clamp ±12 dB vs mixer trim clamp −20/+12 | `audio_engine.rs:548`; `audio.rs:2363` |
| Broadcast-delay rebuild ratio 0.80 / silence threshold 0.02 | `audio.rs:3046` |
| Segue-overlap granularity (integer seconds) | `engine.js:1042` |

### Should stay fixed (with reason)
| Number | Reason | Receipt |
|---|---|---|
| ×1.15 detection headroom | lowering it lets true peaks past the ceiling (show it; don't expose it) | `program_processor.rs:297-299` |
| 4× oversampling / 8 taps | CPU/quality trade, "not a sound anyone chooses" | same |
| Clean-tap ±1.0 clamp | last-resort safety for an unprocessed station | `audio.rs:2570-2573` |
| Ceiling floor −0.1 (never 0) | encoder inter-sample overs clip at the listener | `audio.rs:2133-2136` |
| Program rate 44 100 | ffmpeg contract | `audio.rs:1524`, `:2222-2223` |
| Aux drift nudge ±0.3 % | below the pitch-shift audibility threshold, monitor-only | `audio.rs:1660-1666` |
| VU release 0.82 per buffer | display ballistics only (but note it is buffer-size dependent) | `audio.rs:2617` |
| **EQ ±1.5 clamp and room-EQ ±1.0 clamp** | **not a keep, and not a control either**: they contradict the "no clamp upstream of the limiter" ruling at `audio.rs:2557-2576`. Listed here because they must not become knobs. The decision whether to remove them is Jeff's. | `eq.rs:242`; `audio.rs:2744` |

---

## 10 · Show+ device-layer audit

**Yes, it exists, but not with the words "16 getUserMedia call sites".** The count is 16 sites across
`getUserMedia` / `getDisplayMedia` / `enumerateDevices` together:
- `docs/showplus-device-layer-design-2026-07-27.md:26`: "Device-acquisition map (16 sites, the
  evidence)". `:15-19` say there is no broker. `:111` marks it design of record.
- `docs/backlog.md:150-151`: "(16 sites mapped)".
- The follow-up build: `docs/build-report-device-acquisition-service-2026-07-29.md:1-20` (`deviceService.ts`
  for the camera). `:144-146` says two momentary `getUserMedia` calls remain outside it.

That audit was not repeated here.

---

## Incidental (one line each, not investigated)
- The help docs are stale on the ceiling and the manual crossfade (§0.f items 1 and 5).
- `analyze_lufs` returns `-14` on failure, and the caller writes it as `gain_db = −14 dB` (§5).
- The in-process fallback never receives the processing toggles (§1.0).
