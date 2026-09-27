# Slice 8 — live RTA behind the channel EQ (proposal, 2026-09-26)

**Status:** GO given 2026-09-26. Engine built; UI to follow. Dev only, branch `log-reader-flip`.

## Jeff's rulings (verbatim)

1. "4096-point FFT, 2048 hop."
2. "Third-octave, 31 bands."
3. "Peak hold off by default, with a toggle."
4. "Retire the old audio_get_spectrum and the levels-frame spectrum; the master analyser leaves the audio thread
   entirely."
5. "Both lanes pre-fader."

**Where the proposal below is superseded:**
- §2's "2048 points" is now 4096 with a 2048 hop.
- **The coarse limit:** §2 estimated "~100 Hz"; the build publishes **160 Hz**. A band is coarse when it holds fewer
  than **3** bins, the width a Hann main lobe needs (see the build).
- **Peak hold** is the view's (ruling 3). The engine publishes the attack/release display only.

**Jeff's ruling:** the EQ curve must sit over a live spectrum of the channel, so the operator sees the audio change
as the bands move. Pre-rack and post-rack.

**Governing:**
- `docs/dsp-meter-bus.md`: one meter reader per station; taps only read.
- `docs/dsp-loudness-meter.md`: the per-station meter thread, rings from the callback.
- `docs/dsp-rt-callback.md`: no allocation, no locks and no FFT on the audio thread.
- `docs/dsp-channel-rack-eq.md` §4: the EqCurve draws from the engine's own coefficients.

---

## What is there today (receipts)

**The only spectrum is the master's, and it runs on the audio thread.**
- `eq.rs` `EqChain::process_stereo` writes a mono ring every sample and runs a **2048-point FFT every 1024
  samples** (`update_spectrum`, `FFT_SIZE`/`FFT_INTERVAL`, eq.rs:131-132, :258-265).
- It publishes a smoothed **10-band** magnitude at the GEQ centres (0…1, normalised to a running peak, so
  **not** dBFS).
- **It runs in two instances.** `bus.eq` (air) and `bus.eq_room` (the room chain, audio.rs:4170) both feed their
  own ring and run their own FFT. Only `bus.eq`'s result is ever read (audio.rs:3974 → `bus.spectrum`), so **the
  room instance's FFT is computed for nothing, ~43 times a second.**

**Its one consumer** is the master GEQ editor.
- `Rack.tsx:396-405` polls `audio.getSpectrum` every 100 ms and draws ten translucent bars behind the faders
  (main.js:5408 → `audio_get_spectrum`).
- Nothing else in `src/`, `electron/` or `audiod/` reads `spectrum`. The levels frame carries it along unread.
  StudioPro's analyser is its own Web Audio node, not this.

**The channel racks have no spectrum at all.**
- `EqCurve.tsx` draws the curve from the engine's coefficients over an empty grid.

**The meter thread already exists per station** (`loudness.rs` `spawn_meter_thread`).
- It drains the callback's rings every 20 ms (`LOUD_TICK_MS`) and publishes every 100 ms (`LOUD_PUBLISH_MS`)
  through a triple buffer.
- Its rings are preallocated with the station state (`loud_channels`).

---

## 1 · The tap: one channel at a time, nothing when no rack view is open

**Selection.** A new `Params.rta: Option<RtaTarget>` holds `Channel(slot)`, `Master` or `None` (the default).
- It is set by a new command, `AudioCmd::SetRta`, through the one Params block like every operator value.
- **It is also held by a lease, not just by the UI.**
  - The rack view **subscribes** through the daemon (`rtaSubscribe(stationId, target)`) and renews every 2 s,
    the same TTL pattern as `metersSubscribe`.
  - When the last renewal is more than 5 s old, the daemon sends `SetRta(None)`.
  - So a closed window, a crashed renderer or a station switch **turns the tap off by itself**, not only when a
    component unmounts cleanly.

**The rings.** Two SPSC rings of mono `f32`, **pre** and **post**, 8192 frames each.
- They are created with `BusState`, like the loudness rings, and handed to the meter thread.
- Mono = (L+R)/2, matching the current analyser. A stereo-difference view is out of scope.

**In the callback (the only audio-thread work):**
- **For a channel,** inside the existing deck loop, only for `i == rta slot`:
  - **pre** = `feed × trim`, the same samples the pre-fader meter reads (pre-cut, pre-rack);
  - **post** = the rack's output lanes (`rack_l/rack_r`) when the rack runs, otherwise the pre samples;
  - both are **pre-fader**, like the rack view's IN/OUT meters. The spectrum shows what the EQ does, not where
    the fader is.
  - One `push_slice` per lane per buffer. A full ring drops samples and counts them (`rta_dropped`), never blocks.
- **For the master:**
  - **pre** = the programme mix before the GEQ;
  - **post** = after the GEQ, before the master fader;
  - the same two pushes.
- **When `rta` is `None` the cost is one branch per buffer.** No copy, no ring touch. That is the "idle cost is
  zero" requirement, stated as what it is.
- **Never on the audio thread:** no FFT, no windowing, no band maths.

## 2 · The analysis: on the meter thread

A new `native/src/rta.rs`, run by the existing per-station meter thread (the slice 3 thread) on its 20 ms tick.

**FFT:** 2048 points (46 ms at 44.1 kHz), Hann window, via rustfft with preallocated scratch.
- Hop 2048 = **21.5 updates/s**, at or above the requested ~20 Hz.
- The plan and buffers are made when the thread starts.

**Bands:** ISO **1/3-octave, 31 bands, 20 Hz–20 kHz** (recommended), or 1/6-octave (61 bands).
- Each band's level is the power sum of the FFT bins inside its edges. A bin that straddles an edge is split
  pro rata.
- It is expressed in **dBFS, calibrated so a full-scale sine reads 0 dB in its band**. The Hann window's power
  gain is corrected, so a −18 dBFS sine reads −18 dB.
- This replaces the old 0…1 "normalised to the running peak" bars, which could not be compared with anything.
- **The honest limit of 2048 points** (see Q1):
  - the bins are 21.5 Hz wide;
  - below ~100 Hz a 1/3-octave band is narrower than one bin, so the 20 / 25 / 31.5 / 40 / 50 / 63 Hz bands read
    the one or two bins that cover them;
  - they are drawn **hatched as "coarse"** below the frequency where a band holds fewer than two bins, so a
    reading is never shown as finer than it is;
  - at 1/6-octave the coarse region reaches ~200 Hz.

**Ballistics:**
- **attack instant** (a rising band takes the new value);
- **release 300 ms** (a falling band decays exponentially in dB with τ = 300 ms);
- **peak hold** optional, 2 s, off by default (Q3).

**Publication:** the thread writes an `RtaFrame { seq, target, fed, coarse_below_hz, pre: [f32; 31], post:
[f32; 31], dropped }` to its own triple buffer. It is published at the 21.5 Hz hop. The loudness frame's 100 ms
publish is not slowed or merged.

**On the wire:**
- `audio_get_rta(station)` returns it.
- The daemon's existing ~30 Hz **meter bus** frame gains an **`rta`** key. It is present only while a
  subscription is live, and `fed: false` when the target produced no audio.
- `smoke-meter-contract` gains RULE 6's check for the new key (the daemon forwards it).

## 3 · The drawing: behind the curve, on the same log axis

**In `EqCurve.tsx` (channel racks):**
- a canvas under the SVG curve, on the **same 20 Hz–20 kHz log axis** and a dB axis aligned to the curve's 0 dB
  line;
- **pre-rack:** a faint filled spectrum (`--rta-pre`, low alpha);
- **post-rack:** a brighter filled spectrum (`--rta-post`), drawn over pre;
- **the EQ curve stays on top,** unchanged. Its drag handles keep their hit areas; the spectrum takes no
  pointer events;
- bands below `coarse_below_hz` are drawn hatched; `fed: false` draws **NOT FED** rather than a flat floor;
- new tokens `--rta-pre` and `--rta-post` in all four themes.

**The master GEQ view (`Rack.tsx`):** the same component draws the same two layers behind the ten faders, on the
same log axis. **Both racks then read the same instrument.** The 100 ms `getSpectrum` poll is replaced by the
meter-bus `rta` key.

**Can the `eq.rs` analyser leave the callback entirely? Yes.**
- Its one consumer is the master GEQ view, which this slice moves to the RTA path.
- **Removed from `EqChain`:** the ring write per sample, the FFT, the window, the scratch, `spectrum()` and
  `peak`.
- **What goes with it:** two FFTs every 1024 samples (air and room), ~86 FFTs/s, plus a ring write per sample
  per instance.
- **The audio is untouched,** because the analyser never altered the samples. The goldens stay bit-exact.

**`audio_get_spectrum` / `levels.spectrum` (Q4):**
- **Recommended: retire them.** Keep `audio_get_spectrum` answering `[0…]` with a deprecation note for one release,
  so an older renderer against a newer engine doesn't throw.
- Or keep a 10-band summary derived from the RTA frame. But it would only be live while a rack view subscribes,
  which is a worse meter than none.

**The cost claim is UNVERIFIED until measured.** Two 2048-point FFTs every 1024 samples is estimated at tens of
µs per buffer. The timing rows (§4) measure the callback **before and after the removal** and report the real
number.

## 4 · Verification

**Through the real callback and the real analysis (Rust):**

| Claim | Test | Bar |
|---|---|---|
| **The right frequency moves** | A −18 dBFS log sweep 20 Hz→20 kHz on S1, RTA on S1, frames analysed by the real `rta.rs` | The loudest band tracks the sweep: each band's peak lands while the sweep is inside it. The peak reads **−18 ± 0.5 dB** in every band ≥ 2 bins wide. |
| **The rack's effect shows, by the filter's own curve** | Pink noise on S1, Filters HPF 100 Hz IN | For each band, post − pre = the HPF's own magnitude response at the band centre (the same coefficients `EqCurve` draws), **± 1 dB** in bands ≥ 2 bins wide. At and above 200 Hz: **0 ± 0.3 dB**. |
| **Master too** | GEQ band 1 kHz +6 dB IN, pink noise | post − pre at 1 kHz = +6 ± 0.5 dB; flat elsewhere by the GEQ's own curve |
| **Nothing when not asked** | `rta = None` for 3000 buffers | Zero samples pushed; `dropped` 0; the meter thread publishes `fed: false` |
| **One channel at a time** | S1 selected, S2 playing | S2's audio never reaches the rings |
| **Allocation trap** | Callback with the tap on, 12 channels playing, racks crossfading | **0** |
| **Timing unchanged** | The existing timing rows, plus "tap on" and "analyser removed" rows | Tap on: p99 within the existing gate. With `eq.rs`'s analyser gone, the median **drops**, and the new number is reported. |
| **Harness nulls (taps only)** | The 43 goldens with no tap; with the tap on S1; with the analyser removed | **bit-exact** in all three |
| **The lease** | Daemon smoke: subscribe, stop renewing | `SetRta(None)` sent within 5 s; a renewal after that re-arms it |

**The meter thread's work** (pure, unit-tested in `rta.rs`):
- the band edges and bin splits;
- the Hann power correction (a full-scale sine reads 0 dB);
- attack and 300 ms release;
- peak hold.

**UI:**
- vitest for the axis mapping: the spectrum and the curve share one frequency→x function, **the same function,
  not a copy**;
- a static smoke: both racks draw the RTA layer under the curve, the lease renews, `--rta-*` in 4 themes, the
  help exists.

**Not covered:** how it looks and feels while dragging a band. That is Jeff's screen check.

## 5 · Blast radius

| Area | Change |
|---|---|
| `native/src/rt.rs` | `Params.rta`; `RtaFrame`; the two rings in `BusHandles`/`BusState` |
| `native/src/audio.rs` | `AudioCmd::SetRta`; the tap in the deck loop (selected slot only) and at the master; tests and timing rows |
| `native/src/rta.rs` (new) | FFT, bands, ballistics, peak hold, calibration; unit tests |
| `native/src/loudness.rs` | the meter thread also drains the RTA rings and runs `rta.rs` on its tick |
| `native/src/eq.rs` | **remove the analyser** (ring, FFT, window, `spectrum()`); DSP untouched |
| `native/src/lib.rs` | `audio_set_rta`, `audio_get_rta`; `audio_get_spectrum` deprecated (Q4) |
| `audiod/ether-audiod.js` | `rtaSubscribe` with a TTL lease; `rta` on the meter-bus frame |
| `audiod/smoke-meter-contract.js` | the `rta` key |
| `electron/main.js`, `preload.js` | `audio:rta-subscribe`; the `getSpectrum` route retired or deprecated |
| `src/components/rack/EqCurve.tsx` | the RTA canvas under the curve (shared axis) |
| `src/components/rack/Rack.tsx` | the GEQ view reads the RTA; the 100 ms `getSpectrum` poll removed |
| `src/components/rack/ChannelRackView.tsx` | subscribes for its channel while open |
| `src/index.css` | `--rta-pre`, `--rta-post` × 4 themes |
| `docs/` | `help-channel-eq.md` and `help-processor-rack.md` (reading the spectrum); this doc's build sections |

---

## Decisions for Jeff

1. **FFT size:** 2048 as specified (46 ms, lows coarse below ~100 Hz and drawn hatched), or **4096** (93 ms,
   usable to ~50 Hz, still updated at ~21 Hz with a 2048 hop)? Recommended: **4096 with a 2048 hop**. The low end
   is where a mic's HPF and proximity effect live.
2. **Band resolution:** **1/3-octave, 31 bands** (recommended: readable, and every band is ≥ 2 bins from ~100 Hz
   at 4096), or 1/6-octave (61 bands, finer, coarse to ~200 Hz)?
3. **Peak hold:** off by default with a toggle in the rack view (recommended), or on?
4. **`audio_get_spectrum` / `levels.spectrum`:** retire (recommended; nothing else reads them), or keep a 10-band
   summary from the RTA?
5. **Pre-fader for both lanes** (recommended: the spectrum shows the EQ, not the fader), or post-fader post-rack?

## What this deliberately does NOT build

- More than one channel's spectrum at a time.
- An RTA on the board strips.
- A stereo or side-chain view.
- Analysis on the audio thread.

---

## Build — the engine (2026-09-26)

**Status:** built and proven through the real callback and the real analysis. Nothing draws it yet (UI commit).

### What was built

- **`native/src/rta.rs` (new).** Callback end:
  - `RtaTarget` (None / Channel / Master) rides the Params block (`Params.rta`, adopted by the callback like
    every value);
  - two 16 384-frame SPSC rings, pushed in lockstep: a buffer goes into both or neither, and a full ring is
    counted as `dropped`, never waited on;
  - `serve()` stores the target once, only when it changes;
  - `pushed` and `dropped` counters.
- **Meter-thread end, `RtaAnalyzer`:**
  - a 4096-point Hann FFT every 2048 samples (21.5 frames/s), everything preallocated;
  - 31 ISO third-octave bands: edges from the exact base-2 series, each band the overlap-weighted power sum of
    its bins;
  - calibrated so a full-scale sine reads 0 dB in its band;
  - instant attack; release exponential in power, τ = 300 ms (0.672 dB per hop);
  - **a target change clears the history and discards what is queued**, so a new channel never shows the old
    one's spectrum;
  - published through a triple buffer as `RtaFrame`.
- **`audio.rs`:**
  - `AudioCmd::SetRta`;
  - **the channel tap**, in the deck loop for the one selected slot only: pre = `feed × trim` (what the pre-fader
    meter reads), post = the rack's output, or pre when the rack runs nothing;
  - **the master tap**: pre = the mix before the GEQ, post = after it;
  - both lanes pre-fader (ruling 5);
  - the meter thread (`spawn_meter_thread`) now drains the RTA each 20 ms tick.
- **`lib.rs`:** `audio_set_rta(station, "" | "master" | fader)`, `audio_get_rta(station)` →
  `{ v, seq, target, fed, centres, coarseBelowHz, pre[31], post[31], pushed, dropped }`.
- **Retired (ruling 4):**
  - `audio_get_spectrum`, the levels-frame `spectrum`, `MeterFrame.spectrum` and `BusState.spectrum` are gone;
  - **the `eq.rs` analyser has left the audio thread entirely.** `EqChain` is now only its ten filters: no ring, no
    window, no FFT, no `spectrum()`;
  - main's `audio:getSpectrum` and the daemon's `getSpectrum` answer an inert `[]` until the UI commit removes the
    view that polls them.

### Receipts (dev app stopped)

```
[rta-sweep] every band ≥ 160 Hz: peak −18 -0.03 dB at worst (bar ±0.5), and it peaked while the sweep was inside it: all 31 − coarse
            (each band's peak: 160:-18.03 200:-18.00 … 20000:-18.00; coarse: 20:-23.49 25:-23.03 31.5:-21.49 40:-21.45 50:-20.70 63:-19.35 80:-18.81 100:-18.45 125:-18.11)
[rta-hpf]   pink noise on S1, Filters HPF 100 Hz IN, 40 s — bands ≥ 160 Hz: worst error -0.02 dB against the filter's own curve (bar ±1); ≥ 200 Hz within -0.02 dB of 0
            (coarse, measured/expected: 20:-48.0/-55.9 25:-44.3/-47.8 31.5:-36.9/-39.8 40:-29.5/-31.8 50:-22.4/-23.8 63:-15.6/-15.9 80:-8.1/-8.5 100:-3.2/-3.1 125:-0.8/-0.7)
[rta-geq]   pink noise on A, master GEQ 1 kHz +6 dB IN, RTA on the MASTER: the 1 kHz band reads +5.89 dB (the GEQ's own curve over that band: +5.89; its peak at 1 kHz: +6.00)
[rta-idle]  12 faders playing, RTA unsubscribed, 3000 buffers: 0 frames pushed, 0 dropped, 0 allocations · S1 chosen (silent) with S2 playing pink noise: loudest band -120.0 dB (the floor)
[rta-trap]  12 faders playing, all 12 racks crossfading every 20 buffers, the RTA switching between S1 and the master: 0 allocations over 600 buffers
[rta-cal]   1 kHz at 0 dBFS reads +0.000 · at −18 reads −18.000 · 315 Hz and 8 kHz at −18 read −18.000
[rta-ballistics] release 0.672 dB per 46 ms hop (14.5 dB/s)
[rta-coarse] bins 10.77 Hz; bands below 160 Hz are narrower than 3 bins → COARSE
```

**Timing, before and after removing the in-callback FFTs.** Same rows on both trees: the pre-slice tree measured
from a worktree at `2b9f1cf`. Three runs each:

| Row | Before (analyser in the callback) | After |
|---|---|---|
| The master EQ stage alone, 480 frames, flat GEQ | median 0.0011–0.0031 ms · **p99 0.0076–0.0245 ms** (the FFT blocks) | median 0.0004–0.0005 · **p99 0.0009–0.0011 ms** |
| Callback, A/B/C playing | median 0.0292–0.0330 · p99 0.0401–0.0546 | median 0.0266–0.0284 · p99 0.0411–0.0449 |
| Callback, A/B/C + aux D (room chain + its EQ) | median 0.0376–0.0415 · p99 0.0563–0.0708 | median 0.0322–0.0327 · p99 0.0596–0.0630 |
| Callback, A/B/C + S1, no tap | median 0.0361–0.0420 · p99 0.0568–0.1058 | median 0.0319–0.0323 · p99 0.0491–0.0567 |
| Callback, A/B/C + S1, **RTA tap ON S1** | — | median 0.0369–0.0381 · p99 0.0465–0.0697 |

**What that says:**
- With the analyser gone, the callback median drops **~0.003 ms** (A/B/C) and **~0.007 ms** (with the room chain,
  which ran a second, unread FFT).
- The EQ stage's p99, where the FFT blocks landed, drops about tenfold.
- **The tap itself costs ~0.005 ms** at the median while it is on, and nothing while it is off (`[rta-idle]`).

**Goldens:**
- `[null]` 43/43 bit-exact (`taps not bit-exact: []`), `[rack-null]` 43/43, `[ch-out-null]` 43/43;
- `[trap] 43 renders, 0 allocations`;
- NAPI: `[napi] 43/43 renders bit-exact to the manifest` on the fresh build (sha256 `29ad0b97…`).

**Suite:**
- 108 lib tests pass; bench 7 and doctests 2 pass (run on their own; see below);
- the export check: `audioSetRta` and `audioGetRta` are functions, `audioGetSpectrum` is undefined, and a bad
  target is refused with its reason.

**JS gates:**
- tsc 0; vitest 494/494;
- show-presets 52, rack-eq 30, mic-input 25, pfl 22, dynamics 10, meter contract 30;
- undefined-calls, preload-bridge, ipc-contract, one-switch, audio-isolation PASS;
- leak guard OK; build OK.

### One gate failed, and it fails on the tree before this slice too

`channel_rack_cost_one_and_twelve_channels` (Jeff's slice 5/6 gate: rack CPU max ≤ 0.5 ms, p99 ≤ 1 ms) failed in
the full suite run on a mic row: rack CPU max 0.550 ms.
- **Alone on this tree:** 2 of 3 runs pass; one fails on a different row (5 mics, 0.534 ms).
- **Alone on the pre-slice-8 tree** (worktree at `2b9f1cf`, 4 runs): **2 of 4 fail the same way**, with worse
  numbers (0.829 ms, 0.939 ms, and a p99 of 1.126 ms).
- **This slice doesn't touch the rack DSP** the row times: the tap sits outside `chdsp` and is off in that test.

It is a worst-case CPU figure that is noisy on this box today, not a slice 8 regression. **Reported, not
loosened.** Because `test:rust` stops at the first failure, the bench and doctests were run on their own.
