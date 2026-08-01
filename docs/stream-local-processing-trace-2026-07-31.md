# Stream/local processing — trace before the build

**Date:** 2026-07-31 · **Mode:** READ-ONLY. Live DB opened `readOnly: true`, Rust + JS source and the
shipped addon binary inspected. Nothing changed.
**Symptom on air:** dialogue-heavy songs (Jack's Lament class) too quiet, loud songs very loud — in a
noisy park.

---

## Verdict — this is not a build. It is a switch that has never been flipped.

**The entire designed feature is already implemented, shipped, and present in the running addon. Both
toggles are OFF on all four stations, and no station has ever had them set.**

```
station_config_kv WHERE key LIKE 'proc_%'  →  NO ROWS ON ANY STATION
```

Every layer of the chain exists:

| Layer | State | Receipt |
|---|---|---|
| Rust DSP | ✅ **real** | `native/src/program_processor.rs` — `ProgramProcessor { ride: LoudnessRide, limiter: TruePeakLimiter }` |
| Loudness ride | ✅ real | ebur128-fed, rate-limited (`rate_db_per_s`), clamped (`clamp_db`) |
| True-peak limiter | ✅ real | `TruePeakLimiter::process` per sample after the ride gain |
| Bus insertion | ✅ **one point, as designed** | `native/src/audio.rs:1110` |
| Per-path taps | ✅ independent | stream `:1138-1140`, device `:1151-1152` |
| NAPI surface | ✅ | `audio_set_processing(station_id, local, stream, target_lufs)` (`lib.rs:144`) |
| Daemon delivery | ✅ | `_applyProcessingFromKv` (`engine.js`) — 3 s poll, 15 s re-assert |
| Meters | ✅ | `_emitProcMeters` — IN/OUT LUFS, gain reduction, IN/OUT peak |
| **UI toggles** | ✅ **built** | `SettingsPanel.tsx:709-767` — two toggles + target LUFS |
| **In the running addon** | ✅ **yes** | `audioSetProcessing` present in the staged `ether-audio.node` (2026-07-31 11:46) |
| **Turned on** | ❌ **never** | zero `proc_*` rows |

**This is the opposite of the empty-deck refusal.** That one needs an addon rebuild to become live. This
one is already in the binary the daemon is running — the DSP is one KV write away from being audible.

## 1. What the processing actually does today

`_applyProcessingFromKv` (`audiod/engine.js`) is not a stub. Every 3 s it reads three keys from
`station_config_kv` and pushes them to Rust:

```js
SELECT key, value FROM station_config_kv
 WHERE station_id=? AND key IN ('proc_local','proc_stream','proc_target_lufs')
…
A.audioSetProcessing(this.stationId, local, stream, target);   // target clamped to [-30, -6]
```

It re-asserts every 15 s while on, so a daemon respawn cannot silently drop the setting. Defaults are
`local=false, stream=false, target=-14.0` — **exactly the −14 LUFS the design called for.**

The Rust side, `audio.rs:1110-1128`, computes the processed bus **once** if either path wants it:

```rust
let (proc_l, proc_r) = if bus.proc_local || bus.proc_stream {
    let mut pl = out_l.clone(); let mut pr = out_r.clone();
    if let Ok(mut p) = bus.processor.try_lock() {
        p.set_target(target);
        p.process_planar(&mut pl, &mut pr);     // ride → limiter, in place
        Some((p.in_lufs(), p.out_lufs(), p.gain_reduction_db()))
    } …
```

**`try_lock` only, never blocking air** — a missed lock falls back to the clean bus. With both toggles
off the whole block is skipped and both taps are **bit-identical to today**. That is why turning it on is
low-risk: the off path is not a code path with the processor bypassed, it is the absence of the block.

## 2. The fork — one insertion point, exactly as designed

```
                         mix → EQ → out_l/out_r  (clean)
                                      │
                    :1110  proc_l/proc_r = process(clean)   ← computed ONCE
                                      │
              ┌───────────────────────┴───────────────────────┐
   :1138  use_proc = bus.proc_stream            :1151  bus.proc_local
          → ffmpeg → Icecast                           → device monitor out
```

**Both paths tap the same processed buffer, independently.** The design's requirement — "on the program
bus at the fork root so stream AND local get the same processed sound, with per-path toggles" — is met by
the code as it stands. There is nothing to re-architect.

## 3. The park question — which path feeds the speakers

```
s1 Open Format         local="(default)"   mount=/opportunity-village
s2 halloVeen           local="(default)"   mount=/halloween
s3 Magical Forest      local="(default)"   mount=/magical-forest
s4 Christmas in Jully  local="(default)"   mount=/christmas-in-july
```

**Every station's local output is the system default device** — none has a specific `audio_device_output`
set. So on this box all four stations' local monitors sum to the same default Realtek out, and the park
speakers are fed by whichever station's monitor is turned up (the OV manual-mode procedure).

**This matters for which toggle to set.** If the park is fed from the **local device**, `proc_local` is
the one that fixes the complaint. If the park is fed from a **stream receiver** pointed at the mount,
it is `proc_stream`. **I cannot tell from here which it is** — that is a fact about cabling in the park,
not about the software, and it is the one thing I need from you before recommending a specific switch.

**Safest answer: turn both on for the affected station.** They are independent, both feed from the same
processed buffer, and the cost of enabling the unused one is a `clone()` that already happens whenever
either is on.

## 4. The build, in phases

**Phase 0 — flip the switch (no build at all).**
Settings → the station → Audio Processing: **Local ON, Stream ON, target −14 LUFS**. Watch the
processing meters (IN/OUT LUFS + gain reduction) confirm the ride is working, and listen to a
Jack's-Lament-class track against a loud one. **This is the whole fix for the reported complaint, if the
DSP behaves on real park content.** Nothing is Rust-side, nothing is JS-side, nothing needs a release.

**Phase 1 — what Phase 0 teaches, then tune.** The knobs that exist but are not exposed:
`rate_db_per_s` (how fast the ride moves) and `clamp_db` (how far it may push). A park needs a *faster,
harder* ride than a music station — quiet dialogue must come up quickly and stay up. If Phase 0 shows the
ride is too gentle, exposing those two is a **small JS + KV change plus a `set_*` on the processor**;
the DSP itself does not change. **Rust-side only if the setters do not already exist** — I have not read
far enough into `LoudnessRide` to say, and I am not going to guess.

**Phase 2 — multiband.** Genuinely new DSP in `program_processor.rs`, and **the only phase that needs an
addon rebuild** (the same boat as the empty-deck refusal). Worth deferring until Phase 0/1 data says
broadband is not enough — for the stated complaint (dialogue vs loud songs, a level problem) broadband
loudness normalization is the textbook answer and multiband is not obviously required.

**Nothing here is JS-vs-Rust in the way the question assumed**, because the Rust is already built and
already shipped. The split is: **Phase 0 = a setting; Phase 1 = probably JS + existing setters; Phase 2 =
Rust + rebuild.**

## What I have not verified

- **That the DSP sounds right on real content.** It is bench-proven per the v4.4.91 notes and present in
  the binary, but no station has ever run it on air. Phase 0 *is* that test.
- **Which physical path feeds the park speakers** (§3) — needs your answer.
- **Whether `rate_db_per_s`/`clamp_db` have runtime setters.** `set_target` does; I did not read the rest
  of `LoudnessRide`.

## Scope note

Read-only. Live DB opened `readOnly: true` and closed; Rust and JS source read; addon binaries inspected
with `grep -c` only. No file in `C:\openair` changed, nothing committed, nothing built.
