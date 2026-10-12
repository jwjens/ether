# Every hard-coded number that shapes the sound — audit (2026-10-11)

Jeff's standing rule: "nothing baked into code. Every number that shapes the sound is a visible, settable value in the
UI, stored in settings, with the current value shown." Read-only audit of the engine (native/src), the daemon (audiod/)
and main's audio defaults. Line numbers are as of the tree on 2026-10-11 (the board/loudness work moves audio.rs lines).
**Nothing here changes air; every proposal below waits for Jeff's approval.**

About 95 sound-shaping numbers. About 50 are exposed (a saved setting, a fallback for one, or a clamp on an exposed
control). About 45 are not; most of those are DSP structure (filter taps, Q values, detector constants).

## Exposed today (a fallback for a saved setting, or a clamp on a visible control) — no action

Program/stream processor target, ceiling, release, ride rate/clamp (rack knobs, `proc_*`/`rack_master`); ducker
threshold/attack/hold/release/depth (`duck_*`, Preferences → Ducker); PFL dim (`pfl_dim_db`); mic gain
(`mic_input_<slot>`); Link bitrate/jitter; segue overlap (`segue_overlap_sec`); Icecast bitrate (`icecast_bitrate`);
channel-rack gate/comp/filter defaults; **new in this build:** loudness target (`loudness_target_lufs`) and fader
smoothing (`fader_smoothing_ms`), both in Preferences → Loudness & fader smoothing.

## Not exposed and affecting air — proposed settings (for approval)

| # | Where | Number | What it does on air | Proposed setting |
|---|---|---|---|---|
| 1 | `program_processor.rs:26` `DETECT_MARGIN` | 1.15 | the limiter acts ~1.2 dB **below** the operator's ceiling (−1 set → −2.2 dBTP) | `limiter_detect_margin_db` on the rack limiter (or remove and document) |
| 2 | `program_processor.rs` ride `Mode::M` | 400 ms window | what the loudness ride reacts to | `ride_window` (momentary / short-term) on the rack ride |
| 3 | `program_processor.rs:258` ride gate | −70 LUFS | below it the ride freezes | `ride_gate_lufs` |
| 4 | `program_processor.rs` ride step | 100 ms | how often the ride moves | `ride_eval_ms` (low priority) |
| 5 | `program_processor.rs:129/131` limiter look-ahead / attack | 1.5 ms / ~0.75 ms | limiter transparency | `limiter_lookahead_ms`, `limiter_attack_ms` (look-ahead needs a re-init path) |
| 6 | `audio.rs` per-deck trim clamp | −20…+12 dB | the range loudness normalization can apply | `track_trim_range_db` (shown with the loudness target) |
| 7 | `engine.js:39` `SAFETY_CUT_MS` | 300 ms | overlap before a hard stop on operator take-over | `takeover_cut_ms` (Preferences → Playout) |
| 8 | `engine.js:2184` `_ARM_WINDOW_S` | 90 s | caps how far ahead a sweeper can arm | `sweeper_arm_window_sec` |
| 9 | `engine.js:2446` jingle tail weave | 150 ms | whether the incoming song weaves under a jingle tail | `sweeper_min_tail_ms` (low priority) |
| 10 | `stream.js:81` codec, `stream.js:49` sample rate | MP3, 44 100 | the encoder | wire the stored `icecast_format`; add `icecast_sample_rate` |
| 11 | `main.js:11892` legacy in-process stream | `-b:a 128k` | ignores `icecast_bitrate` on the fallback path | use `icecast_bitrate` |
| 12 | `main.js:8209` RTMP | AAC 128k / 44.1k | video-stream audio | `rtmp_audio_bitrate` |
| 13 | `eq.rs:18` GEQ Q | 1.0 | master GEQ band width | `geq_q` on the rack GEQ |
| 14 | `eq.rs:160` post-GEQ clip | ±1.5 FS | a hard clipper inside the GEQ | remove or document |
| 15 | `audio.rs` clean-tap clamp (processing off) | ±1.0 FS | a clipper when processing is off | document (it is the only peak control then) |
| 16 | `rack.rs:313` comp detector | 5 ms RMS | channel compressor feel | `comp_detector_ms` (low priority) |
| 17 | `localout.rs` mono fold | (L+R)/2 | −6 dB on a mono room device | `mono_fold_gain` (low priority) |
| 18 | `audio.rs` aux/cue resampler target fill | ~40 ms | latency of the AUX and cue outputs | `aux_device_latency_ms` (machine-local) |
| 19 | `faderLaw.ts` the segment below 5% | −60 → −90 dB → off | the very bottom of every fader | part of the law — shown as marks; no separate setting unless Jeff wants one |

## Inconsistencies found (bugs, for approval)

1. **Duck depth fallback:** `audio.rs` boot default −28 dB; everything else (main, DuckerSection, show presets, the comment
   above it) says −22. Only matters before the saved value is applied — which the board restore now does at engine
   start. Proposed: make the literal −22.
2. **A failed per-song LUFS analysis turns a song down 14 dB:** `lib.rs` `analyze_lufs` / `main.js` return −14.0 on
   failure, stored as `songs.gain_db`. That per-song gain is **no longer used** by the engine after this build (one
   normalization for every source ignores it) — so this is now dead, but the stored values are wrong. Proposed: retire
   `songs.gain_db` analysis.
3. **The legacy in-process Icecast path ignores the bitrate setting** (#11 above).
4. **`icecast_format` is stored but never used** (#10).

## Internal and staying internal (no setting proposed)

Filter taps and Q values, oversampler phases, resampler kernels, detector smoothing constants, VU/RTA/meter ballistics
(meter-only), ring and queue sizes, stall thresholds (non-sound), `PROGRAM_RATE` 44 100.
