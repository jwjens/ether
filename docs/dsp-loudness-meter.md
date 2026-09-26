# DSP slice 3 — full BS.1770 loudness meter + GR per branch (PROPOSAL)

**Status:** proposed 2026-09-25; GO with rulings 1–7; engine BUILT 2026-09-26 (§8). UI: §9 when committed.
**Branch:** `log-reader-flip`, dev only. No push, no tag.
**Governing sources:**
- spec §4, slice 3: "Short-term (3 s), integrated (gated), LRA and TP on both branches. Ride GR and
  limiter GR shown separately. EBU Tech 3341 test signals read within ±0.1 LU; a known −23 LUFS file
  reads −23.0 I."
- spec §3 gap table: "M/S/I + LRA + TP per branch, with reset and start/stop tied to show start";
  "Separate GR for ride and limiter on each branch".
- `docs/dsp-inventory.md` §3.2 and §4: OUT LUFS is an estimate, the meter is momentary only, and the
  ceiling reads −1.0 but acts at about −2.2.
- `docs/dsp-rt-callback.md`: nothing that allocates may run in the callback.
- `docs/dsp-meter-bus.md`: extend the meter bus; no second path.
- The standards, fetched and quoted rather than recalled: EBU Tech 3341 (Nov 2023) and EBU Tech 3342
  (Nov 2023).

---

## Summary

1. **The meter state lives on a per-station meter thread, not in the callback.** I measured it (§1.3):
   - `ebur128` in histogram mode is allocation-free (0 allocations over 2 h). That is the easy half.
   - But reading S / I / LRA costs **0.2 ms median and up to 5.2 ms**, and the LRA step spikes the add
     to **0.5 ms**. That can't go in a callback with a 10 ms budget, and will be far less at small
     device buffers.
   - So the callback does only what it can do in microseconds: it pushes each branch's **post-limiter
     output** into a preallocated lock-free ring and tracks GR per window. The meter thread owns the
     BS.1770 state.
2. **OUT LUFS becomes a measurement.** `out_lufs_est` is deleted. The existing `outLufs` key keeps its
   name, so its five readers show the truth with no code change.
3. **Reset** is a command to the meter thread (an atomic epoch). It never touches the audio thread.
   There is **no show-start signal anywhere in the engine or daemon today**, so a show-boundary reset
   is a decision for Jeff (§7 Q2).
4. **GR per branch, ride and limiter separately**, on the meter bus at 30 Hz. Limiter GR becomes the
   window **max**, not the last sample of the buffer. LOCAL's GR comes from whichever processor
   actually fed the device. Today it can come from the wrong one (§3.1).
5. **The ceiling label will say what it does:** "−1.0 dBTP set · limits at −2.2 dBTP". The ×1.15
   (+1.21 dB) margin is not changed in this slice. The new TP readout shows where the output really
   lands.
6. **Verification:** Tech 3341 cases 1–5, 9, 11, 12, 14 and 15–23 are unit tests; Tech 3342 cases 1–4
   too. A −23 LUFS file is added to the corpus, referenced by an independent meter (ffmpeg's
   `ebur128`). Tones are also run through the **real callback**. The goldens must null (meters are
   taps), and the callback allocation trap must read 0.

---

## 1 · What is measured, where, and where the state lives

### 1.1 The two measurement points (post-limiter, per branch)

The branch structure today (`native/src/audio.rs`, current line numbers):

| Branch | The samples that actually leave | Receipt |
|---|---|---|
| **STREAM** | `str_l/str_r` when STREAM processed (`proc_stream && stream_m.is_some()`), else `out_*` clamped to ±1.0. This is exactly what is pushed to the encoder ring. | `audio.rs:3704-3730` |
| **LOCAL** | `dl/dr`, the device feed. It is **one of three sources**: the room chain (`processor_room`) when an aux deck is live, `loc_*` (the LOCAL processor) when `proc_local`, or clean clamped to ±1.0. It is taken before the monitor knobs and the resample. | `audio.rs:3790-3801` |

The meter measures **those exact samples**:

- **STREAM** is measured **every callback, whether or not an encoder is connected.** Otherwise the
  meter goes dead during rehearsal, before the stream is up. The wire carries `connected`, so the panel
  can say "not on air".
  - Today the stream tap is computed only inside `if stream_connected` (`:3704`). Slice 3 computes the
    clamped clean samples once and uses them for both the ring and the meter. That is identical
    arithmetic, so the goldens are unaffected.
- **LOCAL** is measured at `dl/dr`, the same place as the slice 2 `MONITOR` bus tap (`:3804`). It is the
  loudness of the programme leaving for the local device, **before** `monitor_vol × master_monitor_vol`.
  The monitor knob is a room level, not the programme's loudness (§7 Q6).

### 1.2 What each branch reports (BS.1770-4 / EBU Mode)

| Reading | Definition | ebur128 |
|---|---|---|
| **M** momentary | 400 ms window, ungated | `loudness_momentary()` |
| **S** short-term | 3 s window, ungated | `loudness_shortterm()` |
| **I** integrated | 400 ms blocks at 75 % overlap; absolute gate −70 LUFS, relative gate −10 LU; since the last reset | `loudness_global()` (`Mode::I`) |
| **LRA** | Tech 3342: 3 s short-term blocks, −70 absolute / −20 relative gate, 10th–95th percentile; since reset | `loudness_range()` (`Mode::LRA`) |
| **TP** | true peak, 4× oversampled (BS.1770 Annex 2 filter in the crate); per channel, max since reset, plus a per-window value | `true_peak()` / `prev_true_peak()` (`Mode::TRUE_PEAK`) |

- The IN meter (the ride's own `Mode::M` detector on the processor input) stays exactly as it is. It is
  already a real measurement, and it already lives in the callback, allocation-free (Slice 1 trap: 0).
- **The DSP is not reimplemented.** It is the same `ebur128` 0.1.10 crate the engine already links
  (`native/Cargo.toml:18`, `Cargo.lock`). What's new is only *which modes*, and *where it runs*.

### 1.3 Where the state lives — receipts

These come from a scratch probe outside the repo (`scratchpad/lufs-probe`): `ebur128` = "=0.1.10", a
counting global allocator, 44 100 Hz, fed in the engine's 441-frame buffers, with every readout taken
every 100 ms.

**Allocations** (2 h of signal, 720 000 buffers):

```
HIST   allocations during 720,000 buffers:      0   per-buffer µs: median 13.60 …   (reset(): 0 allocations)
queue  allocations during 720,000 buffers:  71976   per-buffer µs: median 14.40 …   (reset(): 0 allocations)
```

That confirms the brief's premise from the other side: `Mode::I` without `HISTOGRAM` keeps a `VecDeque`
history (`ebur128-0.1.10/src/history.rs:160-179`) that grows with the programme.

**Cost, with add and readout timed separately** (30 min):

```
full HIST                      add µs: med 14.00 p99 201.30 p99.9 500.00  |  readout(M,S,I,LRA) µs: med 208.80 p99 888.30 max 3838.10
M only (today's ride meter)    add µs: med 4.10 p99 12.60 p99.9 86.80
I|S|LRA HIST, no TP            add µs: med 4.20 p99 191.90 p99.9 408.00  |  readout(M,S,I,LRA) µs: med 204.90 p99 842.50 max 5190.30
```

What drives the cost:
- `loudness_shortterm()` sums a full 3 s window, 132 300 frames × 2, on every call (the ~0.2 ms
  readout).
- The LRA history takes one such 3 s sum per second inside `add_frames` (the p99 spikes).
- True peak adds ~10 µs/buffer.

This is arithmetic, not allocation. But **up to 5 ms of work in a 10 ms callback, per branch, is not
RT-safe.** At a 128-frame buffer (2.9 ms), a single readout could overrun.

**Decision in this proposal: a meter thread fed by a lock-free ring.** The alternative the brief offered
("histogram mode in the callback, proved allocation-free") is proven allocation-free and **rejected on
cost.**

### 1.4 The design

**In the callback** (added work per buffer is a copy and a max):

- Each measured branch (§1.1) is pushed into its own **preallocated SPSC ring**. This is `ringbuf` 0.4,
  already the stream ring's crate (`audio.rs:5`, `:512`). The push is interleaved f32, 2 s capacity
  (705 KB per branch), and **`try_push` only**.
- A full ring **drops and counts** (`RtCounters::meter_drops`, beside `underruns`/`overruns`). It never
  blocks.
- **GR per window** is accumulated in `MeterBlock` (§3).

**On the meter thread** (one per station, spawned with the station's mixer, like the Slice 1 decode
workers):

- It owns one `EbuR128` per branch: `Mode::I | S | LRA | TRUE_PEAK`, queue history (§7 Q1).
- It drains the rings every 20 ms and feeds the samples to `add_frames_f32`.
- It publishes a `LoudnessFrame` through a triple buffer (the Slice 1 `TripleWriter` / `TripleReader`,
  `rt.rs`) at 10 Hz.
- The whole state machine is a plain struct, `loudness::LoudnessMeters`, with `drain()` and `publish()`.
  The live engine wraps it in a thread. **`render_offline` calls `drain()` inline after every callback**,
  so the harness is deterministic and runs the same code.

**Readout:** `audio_get_meters` (the slice 2 NAPI, `lib.rs`) reads the latest `LoudnessFrame` beside the
`MeterFrame` and emits both in the same JSON. It is the same daemon timer and the same `audio:meters`
IPC, only for subscribed stations. **No second path.**

**Dropped samples are never silent:**
- A drop means the meter thread fell behind, and the integrated value is missing that audio.
- The frame carries `drops` (seconds of audio dropped since reset), and the panel shows
  "incomplete: N s not measured".
- The integrated value is never presented as whole when it isn't.

### 1.5 OUT LUFS: the estimate is deleted

- `LoudnessRide::out_lufs_est` (`program_processor.rs:191`, `:265`, `:275`, `:323`) and
  `ProgramProcessor::out_lufs()` (`:365`) are **deleted**.
- The legacy wire fields `proc_out_lufs` / `proc_stream_out_lufs` are filled in `audio_get_levels` from
  the **measured M** of the branch that the field describes:
  - `proc_*` = LOCAL, falling back to STREAM when only the stream processes. This is the existing rule
    (`audio.rs:3675-3694`).
- The daemon's `procmeters.outLufs` (`ether-audiod.js:587`, `:599`) therefore becomes a measurement
  **with no change to the key.** Its five readers get the truth unedited:
  `HealthMeters.tsx:127/176/185`, `HealthMonitor.tsx:485`, `ProcessingMeters.tsx:93`,
  `SettingsPanel.tsx:784/854`, `useProcessorParams.ts:115/122`.
- **Behaviour change, stated:** with processing OFF, OUT used to equal IN (the estimate). It now reads
  what actually leaves: the clean branch, which differs from IN by the ±1.0 clamp only. With processing
  ON, it now includes the limiter's effect, which the estimate never did.
- **AUX:** `aux_proc_out_lufs` is the same estimate, on the aux chain (§7 Q4).

---

## 2 · Reset of I / LRA / TP-max

**On demand:**
- A **Reset** button on the loudness panel, per branch, plus "Reset both".
- Path: `ipcMain.handle("audio:loudness-reset", {stationId, branch})` → daemon `loudnessReset` →
  NAPI `audio_loudness_reset(station_id, branch)`.
- That increments an `AtomicU64` reset epoch per branch in the station's shared block.
- The meter thread sees the epoch change at its next drain and calls `EbuR128::reset()` (0 allocations,
  measured; `ebur128.rs:547`). It also clears TP-max and `drops`, and stamps `since` with wall time.
- **The audio thread is not involved at all.**
- The frame echoes `epoch` and `since`, so the panel shows "integrated since 14:02:11". That observed
  state comes from the engine, not a UI copy.

**At a show boundary:**
- There is **no show-start signal today.** `audiod/engine.js` has no show-change event, and no
  `showStart` / `currentShow` exists in `audiod/`, `electron/main.js` or `src/lib`.
- The engine side is the same command, so wiring it later is one call. The question is where "a show
  started" comes from (§7 Q2).

---

## 3 · GR per branch — ride and limiter, separately

### 3.1 Which instance's GR (a defect found while designing)

- **STREAM:** GR comes from `processor_stream`, which is what the stream carries.
- **LOCAL is not always `processor`.** When an aux deck is live, the device plays the **room chain**, run
  through `processor_room` (`audio.rs:3747-3786`, `:3790-3791`). But the legacy
  `proc_gr_db` / `proc_ride_gain_db` / `proc_in_lufs` are always written from `processor`
  (`:3679-3683`).
- So today, **with an aux deck playing, the LOCAL readings describe an instance whose output is not
  what the device plays.** That's static reading; runtime is **UNVERIFIED**.
- Slice 3 publishes LOCAL GR from **the instance that fed `dl/dr`** this window. The wire says which one:
  `src: "local" | "room" | "clean"`.

### 3.2 What is published (per branch, per 30 Hz window, callback-side)

| Key | What | How |
|---|---|---|
| `ride` | the ride's applied gain, dB, **signed** (a boost is +) | `ride_gain_db()` at window end (it is one step per buffer) |
| `lim` | limiter gain reduction, dB (≥ 0) | **max over the window.** `TruePeakLimiter` tracks the per-buffer max beside `gr_db` (one `max` per sample; `gr_db` stays last-sample for the legacy fields) |
| `run` | whether the branch's processor ran this window (off, or lock missed → clean) | flag |

- These are appended to `MeterBlock` as `gr: [GrTap; 2]` (LOCAL, STREAM).
- `GrTap { ride_db: f32, lim_max_db: f32, ran: u8 }` is a fixed-size `repr(C)` addition. The pinned
  layout test changes, with the new size stated.
- The ride is labelled **RIDE** and drawn **bipolar** (±clamp): it is a corrective gain, not a
  reduction. The spec's "Ride GR" is honoured as a separate meter, but a +4 dB boost is not drawn as
  reduction.

### 3.3 The ceiling says what it does

- The limiter detects at `tp × 1.15` (`program_processor.rs:142`). That is 20·log10(1.15) = **+1.214 dB**,
  so a −1.0 dBTP setting limits at **−2.21 dBTP**.
- This slice changes the **label**, not the sound:
  - **"Ceiling −1.0 dBTP · limits at −2.2 dBTP (1.2 dB detection margin)"**, computed from the same
    constant, which is named in one place and shared with the UI through the wire (`ceilingEff`).
  - The loudness panel's **TP** readout shows where the output really lands.
- Whether the margin should stay is a sound decision. After slice 3 it can be made with a measurement
  in hand (§7 Q3).
- `docs/help-audio-processing.md:79` still says "The limiter ceiling (−1 dBTP) is fixed". It has been
  adjustable since the rack shipped, and it is corrected in this slice.

---

## 4 · Wire, contract, UI

### 4.1 Wire (additive to the slice 2 meter frame, `v` stays 1)

```
"ld": {
  "local":  { "m", "s", "i", "lra", "tp": [l, r], "tpMax", "since", "epoch", "drops", "src" },
  "stream": { "m", "s", "i", "lra", "tp": [l, r], "tpMax", "since", "epoch", "drops", "connected" }
},
"gr": { "local": { "ride", "lim", "run" }, "stream": { "ride", "lim", "run" } },
"ceil": { "local": { "set", "eff" }, "stream": { "set", "eff" } }
```

- LUFS values are dB. `-inf` / below-gate is emitted as `null` and drawn as "—", never as −70 dressed
  as a reading.
- `i` is `null` until the first gated block exists.

### 4.2 Contract rules (`audiod/smoke-meter-contract.js`)

- **RULE 8:** every `ld.*` / `gr.*` / `ceil.*` key the daemon forwards is emitted by
  `audio_get_meters`'s `json!`. This is the same seam as RULES 1 and 6.
- **RULE 9 (the estimate stays dead):**
  - `program_processor.rs` defines no `out_lufs_est` and no `fn out_lufs`;
  - `audio_get_levels` fills `proc_out_lufs` / `proc_stream_out_lufs` from the loudness frame;
  - no line in `native/src` computes an OUT loudness as `in + gain`.
- **RULE 10:** `ceil.*.eff` is derived from the limiter's named margin constant, not a second literal.

### 4.3 UI (Processor page now; built to move into the rack in slice 4)

- **`src/components/meter/LoudnessPanel.tsx`** goes on the Processor page (`ProcessorRack.tsx`, per
  branch column: LOCAL | STREAM).
  - **Numerics first:** M, S, I, LRA, TP-max, each labelled with its unit, plus "since hh:mm:ss",
    **Reset**, and "incomplete: N s" when `drops > 0`.
  - **Bars for M and S** use the shared meter's visual language (`PeakAvgMeter`'s bar / peak-hold /
    NOT FED hatching, `meterBallistics` tokens) on a **loudness scale** with **the branch's target line**
    drawn across both bars.
  - Scale per Tech 3341 §2.7, which is quoted: *"An 'EBU Mode' meter shall offer two scales … 'EBU +9
    scale' … 'EBU +18 scale' … The 'EBU +9 scale' shall be used by default"* (§7 Q5 on the reference
    point).
- **Two GR meters per branch:** RIDE (bipolar, ±clamp) and LIMITER (0 to −12 dB, window-max with the
  2 s hold from `meterBallistics`). They are drawn **OFF** (hatched, labelled) when the branch's
  processor isn't running, never as 0 dB.
- The existing single GR bar (`ProcessorRack.tsx:318-323`) is replaced by these; its `OUT` numeric
  (`:325`) now reads the measured value.
- The panel subscribes through the slice 2 `useMeterSubscription`, reading frames outside React.
  **One component, keyed by branch, with no page-specific state**, so slice 4 moves it into the master
  rack unchanged.
- **Help:**
  - new `docs/help-loudness-meter.md`, written to the template: what M / S / I / LRA / TP mean, when to
    reset, what "incomplete" means, and why TP can sit below the ceiling setting;
  - `help-audio-processing.md` corrected (the "fixed" ceiling line; OUT is now measured);
  - `help-meters.md` linked.
  - The door is the existing Processor button; no new door is needed.

---

## 5 · Verification

The tolerances are quoted from **EBU Tech 3341 (Nov 2023) Table 1** and **EBU Tech 3342 (Nov 2023)
Table 1**: loudness ±0.1 LU/LUFS; true peak "+0.2/−0.4 dBTP"; LRA ±1 LU. "The loudness meter shall be
reset before each measurement."

### 5.1 Unit: `native/src/loudness.rs` tests (the meter struct, no callback)

Signals are synthesized at 44.1 kHz in code, from the table's definitions. They are fed in the engine's
real buffer sizes, **441, 480, 128 and 1024 frames, and a mixed sequence**, so buffer size provably does
not matter.

| Case | Signal (Tech 3341 / 3342, quoted) | Assert |
|---|---|---|
| 3341 #1, #2 | 1 kHz stereo sine, −23.0 / −33.0 dBFS, 20 s | M, S, I = −23.0 / −33.0 ±0.1 |
| 3341 #3, #4, #5 | tone sequences (−36/−23/−36; −72/−36/−23/−36/−72; −26/−20/−26 with 20.1 s) | I = −23.0 ±0.1 (gating) |
| 3341 #9 | (1.34 s @ −20, 1.66 s @ −30) × 5 | S = −23.0 ±0.1, constant after 3 s |
| 3341 #11 (live) | 20 tones, 3 s at −38+i dBFS with the stated silences | successive max S = −38 … −19 ±0.1 |
| 3341 #12 | (0.18 s @ −20, 0.22 s @ −30) × 25 | M = −23.0 ±0.1, constant after 1 s |
| 3341 #14 (live) | 20 tones, 400 ms at −38+i dBFS | successive max M = −38 … −19 ±0.1 |
| 3341 #15–18 | fs/4, fs/6, fs/8 sines, 0.50 FFS, at the stated phases, 10 ms tapers | max TP = −6.0 +0.2/−0.4 |
| 3341 #19 | fs/4, 1.41 FFS, 45° | max TP = +3.0 +0.2/−0.4 |
| 3341 #20–23 | fs/6 at 0.50 FFS with one fs/4 period at 1.00, synthesized at 4·fs, lowpassed, decimated at offsets 0–3 | max TP = 0.0 +0.2/−0.4 |
| 3342 #1–4 | tone pairs 10, 5 and 20 LU apart; 5 segments −50…−20 | LRA = 10 / 5 / 20 / 15 ±1 |

**Not applicable:**
- 3341 #6 is 5.0-channel; the engine is stereo.
- 3341 #7 and #8, and 3342 #5 and #6, are EBU's downloadable programme files. They could be added from
  the EBU site (§7 Q7).
- 3341 #10 and #13 are the file-based variants of #11 and #14.

**Pre-build evidence** from the scratch probe, same crate and rate, 441-frame buffers. Queue mode is
the recommended one:

```
3341 #1   queue  I -22.991  lastM -22.991  lastS -22.991
3341 #2   queue  I -32.991
3341 #3   queue  I -23.011        3341 #4   queue  I -23.011        3341 #5   queue  I -22.976
3341 #9   queue  lastS -22.984    3341 #12  queue  lastM -22.958
3342 #1   LRA 10.000   #2 LRA 5.000   #3 LRA 20.000   #4 LRA 15.000
3341 #15  TP  -6.021   #16 -6.052   #17 -6.004   #18 -6.019   #19 +2.953   (all PASS)
```

Histogram mode read the same cases up to **+0.064 LU high**: #5 gave −22.936, #1 gave −22.950 against
queue's −22.991. That is within ±0.1, but it is why §7 Q1 recommends queue mode. Cases #11, #14 and
#20–23 were not in the probe; they are written with the build.

### 5.2 Through the real callback (the parity harness, `render_offline`)

- New corpus inputs, generated by a checked-in script and hashed into `manifest.json`:
  - `3341_01` (−23 dBFS 1 kHz, 20 s);
  - `3341_05` (the gated sequence);
  - `3341_15` (TP −6);
  - **`ref_m23`**, the "known −23 LUFS file".
- Each is rendered with processing OFF and with processing ON (LINKED), and the test reads the
  `LoudnessFrame` that the real callback path produced for **both** branches.
- With processing OFF, both branches carry the clean signal:
  - I, M and S are asserted to ±0.1;
  - TP #15 is asserted to +0.2/−0.4.
- The ±1.0 clean-path clamp doesn't touch 0.5 FFS.
- Cases 19–23 (+3 and 0 dBTP) are **unit-only**: the clean tap clamps at ±1.0, so they can't pass
  through the product unaltered. That's by design, and stated rather than hidden.
- **The known −23 LUFS file** (`ref_m23`):
  1. Take the corpus music input (`native/goldens/inputs`, already hashed).
  2. Measure it with **ffmpeg's `ebur128` filter**. That's libavfilter's implementation, independent
     of the `ebur128` crate, and it ships in `node_modules/ffmpeg-static/ffmpeg.exe`, where the filter
     list confirms it is present.
  3. Apply the gain that brings it to −23.0 by that reference, and write it as 32-bit float (no
     requantization).
  4. Record ffmpeg's I reading in the manifest.
  5. The test asserts that our I reads **−23.0 ±0.1** on both branches, and prints the difference from
     ffmpeg to 3 decimals.

### 5.3 The standing gates

| Gate | Expectation |
|---|---|
| Harness null | Meters are taps, so the 43 goldens must stay bit-exact. The STREAM clamp is computed once and shared (§1.1), with identical arithmetic. |
| Allocation trap | 0 inside the callback. The ring push and GR tracking are the only callback additions. The meter thread is outside the trap. It allocates only in queue mode, only when its history grows, and never in the callback. |
| Timing | C5-style callback median and p99 with both branches metered, against the slice 2 figure (callback median 0.167 ms, meter work 0.050 ms). Plus meter-thread CPU per station. |
| Contract | `smoke-meter-contract` RULES 8–10. |
| Frontend | vitest (the loudness-scale mapping and GR drawing pinned like `meterBallistics`), tsc 0, the no-audio smokes, the leak guard (the new IPC carries `stationId` renderer→main only, like `subscribe-meters`). |
| Runtime | UNVERIFIED until Jeff sees it on screen. The check: a −23 file played on a deck reads I −23.0 on both branches, and RIDE and LIMITER move separately when processing is on. |

---

## 6 · Blast radius

| Area | Change |
|---|---|
| `native/src/loudness.rs` (new) | `LoudnessMeters`: rings (consumer side), `EbuR128` per branch, reset epochs, `LoudnessFrame`, the thread wrapper, tests (§5.1) |
| `native/src/audio.rs` | per-branch ring push; STREAM clamp computed once; LOCAL source tracking (`src`); `GrTap` accumulation; `meter_drops` counter; spawn the meter thread with the mixer; `MetersHandle` gains the loudness reader |
| `native/src/program_processor.rs` | **delete** `out_lufs_est` / `out_lufs()`; add the limiter window-max GR; name the 1.15 margin as a constant shared with the wire |
| `native/src/rt.rs` | `GrTap` in `MeterBlock` (layout test re-pinned); `LoudnessFrame` |
| `native/src/lib.rs` | `audio_get_meters` emits `ld` / `gr` / `ceil`; `audio_loudness_reset`; `audio_get_levels` fills `proc_*out_lufs` from the measurement |
| `native/src/offline_render.rs` | drives `LoudnessMeters::drain()` inline; the harness reads it |
| `native/goldens` | 4 new inputs + manifest entries (generator script checked in; WAVs gitignored as now) |
| `audiod/ether-audiod.js` | forward the new keys in the `meters` event; `loudnessReset` command |
| `electron/main.js`, `preload.js`, `levels-scope.js` | `audio:loudness-reset` handle + in-process path; `resetLoudness()` |
| `src/components/meter/` | `LoudnessPanel.tsx`, `GrMeter.tsx`, loudness-scale functions + tests |
| `src/components/ProcessorRack.tsx` | panel + two GR meters per branch; the ceiling label |
| `audiod/smoke-meter-contract.js` | RULES 8–10 |
| `docs/` | `help-loudness-meter.md` (new), `help-audio-processing.md` corrected; this document gets a build section |

- **Not touched:** the 10 Hz `levels` frame shape, the `procmeters` keys, the ride and limiter
  arithmetic, and any sound-affecting value.
- **Threads:** +1 per running station.
- **Memory:** 2 rings × 705 KB per station, plus the queue history (§7 Q1).

---

## 7 · Decisions for Jeff

1. **Integrated history: queue (exact) or histogram (bounded).**
   - The meter thread may allocate, so either works.
   - **Queue** matches the reference to about 0.01 LU (#1 −22.991, #3 −23.011). But it grows by
     8 bytes per 100 ms block, plus the LRA history: about 6.9 MB per branch per 24 h without a reset.
   - **Histogram** is fixed at 16 KB, but reads up to +0.064 LU high, so a −23.0 file can display
     −22.9 or −23.0 depending on rounding.
   - **I recommend queue, with `set_max_history` at 24 h.** After 24 h without a reset, I and LRA become
     a sliding 24 h, and the panel says so.
2. **Show-boundary reset.** Nothing in the engine knows a show started.
   - **I recommend: v1 ships the button and the command. The show hook waits for the log-reader flip,**
     whose time-anchored playhead reads `generated_schedule` rows that carry the show. It would be one
     `loudnessReset` call at the boundary, behind a visible per-station "Reset integrated at show start"
     setting, default OFF (no hidden defaults).
   - Or name another source of "show start".
3. **The ×1.15 margin.**
   - **I recommend: label only in slice 3** ("set −1.0 · limits at −2.2").
   - Decide whether to shrink or remove the margin after the TP meter shows what the output actually
     does. Changing it changes the sound.
4. **AUX OUT estimate** (`aux_proc_out_lufs`, same estimate, deck row in the Health Monitor). Either:
   - **(a) measure it:** a third ring and meter, M + TP only; I recommend this, because the estimate
     must not survive anywhere; or
   - **(b) retire the field:** the aux row shows IN, RIDE and LIMITER only.
5. **Loudness scale reference.**
   - EBU Mode fixes 0 LU = −23 LUFS. Our targets are −14, −16 and so on. On the absolute +9 scale
     (−41…−14 LUFS), a −14 target sits on the top edge.
   - **I recommend absolute LUFS with the +9 / +18 ranges centred on the branch's own target**, with the
     target line drawn and a +9/+18 selector, labelled as target-relative.
   - The numerics are the compliant part in every case.
6. **LOCAL measurement point:** the device feed **before** the monitor knobs (recommended; the knob is
   room level, not programme loudness) or after them.
7. **Authentic programme cases** (3341 #7/#8, 3342 #5/#6). Add EBU's downloadable files to the corpus
   inputs (a download from tech.ebu.ch, stored like the existing inputs), or leave them out of slice 3.

## What this deliberately does NOT build

- No change to ride or limiter behaviour, the margin, or any on-air number.
- No loudness per channel. The rack's per-slot GR is slices 4–6.
- No show presets and no show-start detection (§7 Q2).
- No logging of integrated loudness to the ledger or a compliance report. That's a natural follow-on,
  but not asked for.
- No second meter transport.

---

## 8 · Build report — engine (2026-09-26)

Built on Jeff's GO with rulings 1–7:
1. queue mode, 24 h cap;
2. Reset button now, show-start later;
3. label-only ceiling;
4. AUX OUT measured;
5. scales on the branch's own target;
6. LOCAL at the device feed;
7. the EBU set in the corpus.

### What was built
- **`native/src/loudness.rs`** (new).
  - `LoudTaps` is the callback end: planar SPSC rings, 2 s per lane, all-or-nothing per buffer, and
    drop-and-count when full.
  - `LoudnessMeters` is the meter end: one `EbuR128` per branch (LOCAL/STREAM:
    `I | S | LRA | TRUE_PEAK`, queue history capped at 24 h; AUX: `M | TRUE_PEAK`), reset epochs, and a
    `LoudnessFrame` published through the Slice 1 triple buffer.
  - `spawn_meter_thread` drains every 20 ms, publishes every 100 ms, and exits when the station's state is
    dropped.
- **`audio.rs`.**
  - The STREAM output is built every buffer, clean-clamped or processed, and metered whether or not an
    encoder is connected. It uses the same arithmetic as before, and the harness nulls.
  - LOCAL is pushed at `dl/dr`; AUX at the aux tap.
  - `GrTap` per branch: signed ride and window-max limiter, and `src` (own / room / clean). LOCAL comes
    from the ROOM processor while an aux deck owns the device feed, which was the §3.1 defect.
  - The estimate fields are deleted from `BusState` and `MeterFrame`. GetLevel fills the legacy
    `*_out_lufs` from the **measured** momentary value (floor −70 for their readers).
  - The meter thread is spawned in `start_station_mixer`.
- **`program_processor.rs`.**
  - `out_lufs_est` and `out_lufs()` are **deleted**.
  - `DETECT_MARGIN` (1.15) is named once, with `detect_margin_db()`.
  - `gain_reduction_max_db()` (the per-buffer max) is added.
- **`rt.rs`:** `GrTap` in `MeterBlock`, re-pinned at 488 B.
- **`lib.rs`:**
  - `audio_get_meters` emits `ld` / `gr` / `ceil` / `margin` / `ldSeq` (null for "no reading");
  - `audio_loudness_reset(station, "local" | "stream" | "aux" | "all")`.
- **`offline_render.rs`:** drives the same meter inline after every callback (`Render::loud`).
- **Daemon, main, preload:**
  - the `meters` event forwards the new keys;
  - `loudnessReset` command;
  - `audio:loudness-reset` IPC and `resetLoudness()`.
- **Contract:** `audiod/smoke-meter-contract.js` RULES 8–10. RULE 6 now also sees camelCase keys.
- **Corpus:** `scripts/make-loudness-corpus.js` writes `native/goldens/manifest-loudness.json` (tracked).
  - `ref_m23.wav` is 24-bit, from `music.wav`, and reads −23.000 by ffmpeg 6.1.1's `ebur128` (0.001 LU
    precision).
  - The EBU loudness test set v5.0 (70 WAVs) is unpacked into `inputs/ebu/`.
  - All WAVs are gitignored; their FNV hashes are pinned. The FNV uses the harness's own offset basis,
    1469598103934665603.

### Found while building
- **The crate trap (ebur128 0.1.10).** `set_max_history` pads the queue with 0.0 energies, which bypass
  the −70 gate.
  - Measured: Tech 3341 #3 read I **−24.153** (should be −23.011), and Tech 3342 #4 read LRA **30**
    (should be 15).
  - `new_meter` resets right after capping, and `capped_history_is_reset_before_use` pins bit-equality
    with an uncapped meter.
- **The path's resampler.** The ffmpeg-referenced file read by the meter directly (48 kHz) gives
  **−22.995** (Δ +0.005 LU from ffmpeg). Through the callback, where the deck path resamples 48 → 44.1 kHz,
  it gives **−23.078** (Δ −0.084 LU from the file). Within ±0.1. Noted, not investigated.

### Receipts
- **Tech 3341 / 3342, synthesized at 44.1 kHz**, fed in 441 / 480 / 128 / 1024 / mixed buffers; the
  reading is bit-identical across buffer plans.

  | Case | Reading | Tolerance |
  |---|---|---|
  | #1 / #2 | −22.991 / −32.991 | ±0.1 |
  | #3 / #4 / #5 | −23.011 / −23.011 / −22.976 | ±0.1 |
  | #9 (S) | −22.984 | ±0.1 |
  | #12 (M) | −22.958 | ±0.1 |
  | #11 / #14 | −37.99 … −18.99 | ±0.1 |
  | TP #15–19 | −6.021, −6.052, −6.004, −6.019, +2.953 | +0.2/−0.4 |
  | TP #20–23 | −0.130, −0.083, −0.181, −0.083 | +0.2/−0.4 |
  | 3342 #1–4 (LRA) | 10.000, 5.000, 20.000, 15.000 | ±1 |

- **The EBU's own files (48 kHz): 28 of 28 applicable cases PASS.**

  | Case | Reading |
  |---|---|
  | #1 | −22.954 |
  | #2 | −32.960 |
  | #3 / #4 / #5 | −23.014 / −23.014 / −22.979 |
  | #7 | −22.986 |
  | #8 | −22.998 |
  | #9 | −22.986 |
  | #10 (×20 segment files) | −22.993 |
  | #11 | −37.99 … −18.99 |
  | #12 | −22.960 |
  | #13 (×20 segment files) | −22.994 |
  | #14 | −37.99 … −18.99 |
  | TP #15–19 | −6.000, −6.033, −5.985, −5.998, +2.977 |
  | TP #20–23 | −0.130, −0.086, −0.181, −0.086 |
  | 3342 #1–6 (LRA) | 10.001, 4.999, 19.995, 14.999, 4.975, 14.993 |

  3341 #6 (5.0 / 6-ch) is N/A.
- **Through the real callback, processing OFF, both branches:**

  | Case | Reading |
  |---|---|
  | 3341 #1 | I −22.996 |
  | 3341 #3 | I −23.011 |
  | 3341 #5 | I −22.981 |
  | 3341 #15 | TP −6.021 |
  | ffmpeg-referenced −23 file | I −23.078 |

  With processing ON (LINKED and SPLIT), the meter equals an independent BS.1770 measurement of each
  branch's delivered tap to 0.000 LU / 0.000 dB.
- **Harness:** 43/43 renders bit-exact (`cargo test`), and 43/43 through a freshly built `.node`
  (`4b07e9e6…55cc`). The tracked `.node` is untouched (`4876be79…4aa8c`).
- **Allocation trap:** 0 across the 43 renders. 0 in `callback_timing_with_loudness`. 0 for `LoudTaps::push`
  × 3 × 2 000 buffers.
- **Timing** (A, B, C, CART playing, LOCAL+STREAM processing, loudness taps on, 480-frame buffers):
  - callback median **0.121 ms**, p99 **0.410 ms**, worst **0.758 ms** per 10 ms buffer (first run);
    **0.090 / 0.445 / 0.917 ms** (the final full `npm run test:rust`). The Slice 2 test in the same final run
    read median 0.134 ms and worst 0.779 ms. These are host-load dependent: same box, different minutes;
  - the added work alone (3 ring copies + 3 GR folds): median **0.0009 ms**, p99 0.0138 ms (first run);
    **0.0008 / 0.0048 ms** (final). That is 0.008–0.009 % of the budget.
  - Final `npm run test:rust`: 45 passed / 0 failed / 1 ignored (harness pass), 7 passed (bench pass).

### Deviations from the proposal, stated
- The EBU programme files (#7/#8, 3342 #5/#6) are run through the meter at their own rate, not also
  through the callback. The callback path's programme case is `ref_m23`, which is the same material class
  with an independent reference.
- AUX is `M | TRUE_PEAK` only (no I/LRA), as §7 Q4(a) proposed.
- **Memory:** each LOCAL/STREAM meter preallocates its 24 h history when the cap is set, about 6.9 MB. That
  is ~14 MB per running station, on the meter thread, never in the callback.
