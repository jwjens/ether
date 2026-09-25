# Slice 2 — meter bus + pre-fader meters: PROPOSAL

**Date:** 2026-09-25 · **Branch:** `log-reader-flip` @ `ed1cd91` · **Status:** PROPOSED — no code. Build on Jeff's GO.
**Governs:** `docs/strata-to-ethercast-build-spec.md` §4 slice 2. The spec's text: *"Engine publishes peak/RMS per
channel (post-trim, pre-rack), per bus and per branch at ~30 Hz over a lock-free queue. Common meter
component."* Its verification: *"−18 dBFS RMS 1 kHz tone into S1: channel meter reads −18 RMS / −15 peak,
fader does not move it."* It also draws on §5 (peak-over-average, a pre-fader meter on each strip, the
Wild Meter, the pinned meter column).
**Builds on:** `docs/dsp-rt-callback.md` S3. This **extends the existing triple-buffer meter path**
(`native/src/rt.rs:229-300`; `BusState::publish_meters`, `audio.rs:1003`). It does not add a second one.

---

## 0 · What exists today

| Path | What it carries | Rate | Receipt |
|---|---|---|---|
| Rust `bus.peaks[12]`, `master_peak`, `room_peak`, `aux_peak` | **post-fader** sample peaks, with ballistics **in the engine** (`VU_RELEASE = 0.82` per buffer) | every buffer | `audio.rs:3199`, `:3385-3386`, `:3619`, `:3657` |
| `MeterFrame` (triple buffer) | the above + processor meters + deck telemetry + the adopted `Params` | written every buffer | `rt.rs:241`; `audio.rs:976-1006` |
| daemon `levels` event | `audio_get_levels` JSON (54 keys) | **10 Hz** | `audiod/ether-audiod.js:529`, `:536`, `:594` |
| in-process fallback | main polls `audioGetLevels` | 33 ms | `electron/main.js:3584-3605` |
| renderer | `VUMeter` (7 users) with its own ballistics (`lib/vuMeter.ts:39-42`: attack 12 ms, decay 270 ms, hold 1 400 ms); `HealthMeters` with different ones (hold 1.2 s, fall 20 dB/s, `HealthMeters.tsx:45`) | — | — |

**What does not exist:**
- any **pre-fader** tap;
- **RMS** anywhere;
- per-bus meters for the **stream** tap or the **monitor (device) tap**;
- one meter component. There are two, with two different ballistics, and the engine adds a third
  (`VU_RELEASE`).

---

## 1 · What the engine publishes

### 1.1 Taps (all are READS of buffers the callback already computes — nothing is added to the signal path)

**Per channel: 12 slots** (A, B, C, D, E, F, CART, S1–S5).
- Tapped **post-trim, PRE-cut, PRE-fader, pre-rack**: `l * trim`, `r * trim` inside the deck loop, beside
  the existing `lv = l * vol` (`audio.rs:3143`). All line numbers are at `ed1cd91`.
- There is no rack yet (slice 5). When there is, the rack's input is this same point, so the tap stays
  "pre-rack".
- **Pre-cut** means the meter moves while the channel is OFF, so an operator can check a source's level
  before opening it. That is how Strata and LXE pre-fader meters behave. **This is a decision for you
  (§7 Q1).** The alternative, post-cut/pre-fader, would read silence while OFF.
- Frames the deck did not supply (not active, paused, underrun) contribute **nothing**. The window's
  frame count is shared across all taps, so a starved deck reads as quiet in that window rather than as
  a stale level.

**Per bus / branch: 6 taps.**

| # | Bus | Buffer | Receipt |
|---|---|---|---|
| 0 | **PGM** | the clean programme: post-sum, post-duck, post-EQ, post-master, pre-processor (the existing `master_peak` basis) | `out_l/out_r` after the master multiply (`audio.rs:3370-3373`) |
| 1 | **LOCAL** | the LOCAL branch's processed output (zeros when processing is off, and flagged as such) | `loc_l/loc_r` (`audio.rs:3431`) |
| 2 | **STREAM** | exactly what is pushed to the program-bus ring (processed, or the clean ±1 clamp) | the values passed to `ring_prod.try_push` (`:3490`) |
| 3 | **MONITOR** | the device feed `dl/dr`, pre-`mvol`, pre-resample (the harness's monitor tap) | `dl/dr` (`audio.rs:3553`) |
| 4 | **ROOM** | the room chain's output when an aux deck is live (else zeros, flagged) | `room_out_l/r` (`audio.rs:3508`) |
| 5 | **AUX** | the aux monitor feed after its processor (the existing `aux_peak` basis) | `aux_l/aux_r` after `process_planar` (`audio.rs:3603`) |

The existing LUFS / GR / ride / proc-peak fields in `MeterFrame` are **unchanged**.

### 1.2 One read window, exactly — accumulate until the reader acknowledges

The callback runs about 100 times a second; the reader reads about 30 times a second. A triple buffer
keeps only the latest frame, so **publishing per-buffer peaks would silently drop two out of every three
buffers' peaks.** Instead:
- The callback **accumulates** into each tap: max `|sample|` per channel side, and a running `Σ sample²`
  (f64) per side, plus one shared frame count.
- It publishes the running totals every buffer, tagged with an **epoch**.
- When the meter reader reads epoch *e*, it stores *e* into a new `RtShared::meter_ack: AtomicU64`.
- At the top of its next buffer, the callback sees `meter_ack ≥ epoch`, zeroes the accumulators and
  starts epoch *e+1*.

So every read reports the peak and RMS of **exactly the audio since the previous read**, never a
sample-and-hold of one buffer.

This costs one Acquire load per buffer and one Release store per read: no lock, no allocation. With no
meter reader running (a headless station), the accumulators run on and are harmless: `max` saturates,
and f64 `Σ` cannot overflow in any realistic run.

### 1.3 The struct (added to `MeterFrame`; `#[repr(C)]`, `Copy`)

```rust
#[repr(C)] #[derive(Clone, Copy, Default)]
pub(crate) struct MeterTap {
    pub peak:  [f32; 2],   // max |sample| since the window opened, L/R — linear, sample peak
    pub sumsq: [f64; 2],   // Σ sample² since the window opened, L/R
}                          // 24 bytes (align 8)

#[repr(C)] #[derive(Clone, Copy, Default)]
pub(crate) struct MeterBlock {
    pub epoch:  u64,                    // window id (see §1.2)
    pub frames: u64,                    // frames accumulated in this window (RMS = sqrt(sumsq / frames))
    pub ch:     [MeterTap; SLOT_COUNT], // 12 × 24 = 288 bytes — PRE-fader, post-trim
    pub bus:    [MeterTap; 6],          //  6 × 24 = 144 bytes — PGM, LOCAL, STREAM, MONITOR, ROOM, AUX
    pub bus_live: u8,                   // bit n set = bus n was actually fed this window (LOCAL/ROOM/AUX can be absent)
}                                       // 16 + 288 + 144 + 1, padded to 8 → 456 bytes
```

- `MeterFrame` grows by **456 bytes**. The triple buffer holds three copies, so **+1 368 bytes per
  station**, allocated once when the station starts.
- The size is pinned by a test (`assert_eq!(size_of::<MeterBlock>(), 456)`), so it cannot drift silently.
- Publishing copies it with the rest of the frame: one ~1.4 KB memcpy per buffer.
- **Accumulator scratch:** the running `MeterBlock` lives in `BusState`, a fixed field. The per-sample
  work is two `abs`/`max` and two f64 multiply-adds per tap, only for **active** channels and only for
  buses that ran this buffer. C5-style timing is re-measured in the build, and the budget is checked.
- **No new allocation and no new lock in the callback.** The S6 allocation trap enforces the first: the
  harness asserts 0 allocations on all renders.

### 1.4 Getting it out at ~30 Hz without adding load where it once caused an OOM

`levels` is heavy (54 keys plus a 12-entry deck array) and runs at 10 Hz. A renderer OOM was once
traced to a ~90 Hz levels flow (`audiod/engine.js:375` comment). So meters get **their own compact frame
and their own subscription**:
- **NAPI `audio_get_meters(station_id) → string`.** It reads the latest `MeterFrame` through the **same
  TripleReader**. The reader moves from `Control` into an `Arc<Mutex<TripleReader>>` shared by
  `Control` (GetLevel) and this call. That mutex is between two non-audio threads only; the callback
  never sees it. It acknowledges the epoch (§1.2) and returns:
  `{"v":1,"e":<epoch>,"n":<frames>,"ch":[[pkL,pkR,rmsL,rmsR]×12],"bus":[[pkL,pkR,rmsL,rmsR]×6],"live":<bits>}`
  - These are **raw linear values**: RMS = `sqrt(sumsq/n)`, computed here, off the audio thread.
  - That is 74 numbers, about 600 bytes.
- **The daemon** gets a 33 ms timer that emits `event: "meters"` **only for stations a client has
  subscribed to** (new command `metersSubscribe {stationIds}`). A renderer showing one station's strips
  costs one station's meters, not every station's.
- **The in-process fallback:** main's existing 33 ms interval (`main.js:3587`) also calls
  `audioGetMeters` for the active station. Main forwards `audio:meters` scoped by station UUID, exactly
  as `scopeLevelsFrame` does for levels.
- **The Health Monitor** gets meters decimated to 1 s in the fleet health frame, the same rule as the
  proc meters (`main.js` fleet-frame comment: *"a 1-SECOND SAMPLE of it, never the stream"*).

---

## 2 · Ballistics — in the renderer, never the engine

The engine publishes raw window peak and RMS (§1). **All ballistics live in one pure TS module,
`src/components/meter/meterBallistics.ts`, unit-tested like `meterScale.ts`.**

| Element | Behaviour | Value | Basis |
|---|---|---|---|
| **Peak bar / dot** | digital **sample peak** (not true peak — that stays on the loudness panel, slice 3); instant attack; return at a fixed dB rate | fall **20 dB in 1.7 s** (≈ 11.8 dB/s) | modelled on the IEC 60268-10 Type I PPM return time. ⚠ **The standard's exact figures are UNVERIFIED here** — I don't have the text, and quote it from memory as "about 20 dB in ~1.5–1.7 s". The value is a named constant, so it can be matched to the text. |
| **Peak hold marker** | holds the highest peak, then falls at the peak rate | **hold 2.0 s** | operator convention (Strata "peak dot riding over an average bar", spec §2 metering style) |
| **Average bar** | RMS through a one-pole average | **300 ms** time constant | VU-like integration (IEC 60268-17 VU ≈ 300 ms — ⚠ same caveat: from memory). This is **not** loudness; LUFS stays separate. |
| **RMS reference** | **plain RMS**: a sine's RMS reads 3.01 dB below its peak | −18 dBFS RMS sine ⇒ −18.0 RMS / −15.0 peak | this is exactly the spec's verification line (−18 RMS / −15 peak), so it is the arithmetic RMS, **not** AES17's sine-referenced RMS (which would read −15). §7 Q2 confirms. |
| **OVER** | lights when window peak ≥ 0 dBFS (1.0) | holds **2.0 s** | on the clean taps (clamped ±1), OVER means "at the clamp", i.e. clipping happened. On the unclamped PGM/pre-fader taps it means over full scale. |
| **Scale** | dBFS, **−60 … 0**, with ticks at −40/−20/−18/−12/−6/−3/0 | — | `meterScale.ts` `dbToPercent(floor −60)` already maps this. **−18 is marked**: it is the alignment level in the spec's own test. |

- **Rate independence:** every ballistic is computed from elapsed wall time since the last draw (the
  `1 − exp(−dt/τ)` form `lib/vuMeter.ts:45-49` already uses), so a meter at 30 Hz frames and one at 1 Hz
  (Health Monitor) move at the same speed.
- **The engine's `VU_RELEASE` ballistics on the old post-fader fields stay as they are.** Those fields
  are an existing wire contract, and changing them would move numbers other consumers read (the health
  sense, the daemon heartbeat). The new meters simply do not use them.

---

## 3 · One meter component

**`src/components/meter/PeakAvgMeter.tsx`** (+ `meterBallistics.ts`, `meterScale.ts` reused). Props:

```ts
{ peak: [number, number]; rms: [number, number];   // raw linear, from the frame
  label?: string; orientation?: "v" | "h"; stereo?: boolean;
  live?: boolean;                                   // false → drawn as "not fed" (hatched), never as silence
  size?: "strip" | "master" | "compact" }
```

- **Drawing, per the spec's rack layout** (§5 "Right: pinned meter column — IN (pre-fader) peak/avg, GR,
  OUT"): an **average bar** (solid) with a **peak dot** riding above it, a **hold tick**, and an **OVER**
  cap.
- **Colours:** existing tokens only. Bar green to −18, amber −18 to −6, red above −6. The peak dot is
  white. OVER is red. The brand purple (`#8868D8`) is used for the label only, since purple is the
  accent, not a level colour. Dark/light themes come from the existing CSS variables.
- **Where it goes (one component everywhere):**
  - **Every channel strip:** a new **pre-fader** meter on `ConsoleStrip`, `SourceChannelStrip` and
    `FaderSection` strips. The post-fader meter stays until you rule on it (§7 Q3).
  - **Master:** `MasterOutput` shows **PGM / LOCAL / STREAM / MONITOR** as a meter column.
  - **Health Monitor:** each station card's `peak` bar becomes this component at `size="compact"` (1 Hz).
  - **The Wild Meter** (spec §5, "a Wild Meter on the master for spot-checking any source"): one extra
    meter on the master with a selector over the 12 channels and 6 buses. It is the same component; the
    selector only chooses which tap it draws. There is no new engine work.
  - **`VUMeter`** (7 users) becomes a thin wrapper over `PeakAvgMeter`, so those screens get the one
    ballistics without being re-plumbed. Whether they show pre- or post-fader stays as it is today.
- **Doors and help:**
  - The meters appear on screens that already exist, so there's no new door to build. **The Wild Meter
    selector sits on the master strip** where it is visible.
  - A new help entry, `docs/help-meters.md`, covers:
    - what pre-fader and post-fader mean;
    - how to read a peak dot against an average bar;
    - what OVER means;
    - the −18 alignment mark;
    - why a channel that's OFF still shows level (if §7 Q1 is pre-cut).

---

## 4 · Fader independence — proven, not asserted

A **Rust unit test** runs through the real `mixer_callback`, using the S4 prefilled-ring source:
- **Input:** a 1 kHz sine at **−18.00 dBFS RMS**, i.e. peak amplitude `10^(−18/20)·√2` = −14.99 dBFS, fed
  to **S1** (slot 7, as the spec's verification names it). The render is 100 buffers.
- **It runs three times, identically, except:**
  1. fader 1.0, channel ON;
  2. **fader 0.5**, channel ON;
  3. fader 1.0, **channel OFF** (only if §7 Q1 = pre-cut).
- **Asserts:**
  - the S1 **pre-fader** `peak` and `sumsq` are **bit-identical** across all three runs;
  - calibration: RMS reads −18.00 ± 0.05 dB and peak −14.99 ± 0.05 dB;
  - the **post-fader** peak (the existing field) drops by 6.02 dB at fader 0.5, which proves the test
    can see a fader.
- **A second test** covers the §1.2 window: a burst lasting one buffer, between two reads, must appear
  in the next read's peak. That is the case a latest-wins buffer would drop.
- **The renderer side:** a vitest on `meterBallistics.ts` pins the peak return rate, hold time, 300 ms
  average, the OVER hold and rate independence (the same input at 30 Hz and 1 Hz reaches the same value
  at the same wall time).

---

## 5 · Wire keys

- **`audio_get_levels` json!: no keys added.** The meters travel in their own frame (§1.4), which keeps
  the 10 Hz levels contract untouched.
- **New `audio_get_meters` json!** keys: `v`, `e`, `n`, `ch`, `bus`, `live`. The layout is documented at
  the function and versioned by `v`.
- **`audiod/smoke-meter-contract.js` gains two rules:**
  - **RULE 6:** every key a meters consumer reads (`mt.<key>` in `ether-audiod.js`, and the main
    forward) is named in `audio_get_meters`'s json!. This is the same seam-based check as RULE 1, and the
    same defect class that shipped twice.
  - **RULE 7:** the `ch` and `bus` arrays hold exactly 12 and 6 entries of 4 numbers each, checked
    against the `SLOT_COUNT` and `MeterBlock` constants in the source, so layout drift fails the build.

---

## 6 · Blast radius — and it is all bit-exact

| File | Change |
|---|---|
| `native/src/rt.rs` | `MeterTap`, `MeterBlock`, `RtShared::meter_ack` |
| `native/src/audio.rs` | accumulate at the taps (deck loop, bus taps); epoch reset at the top of the buffer; `MeterFrame` carries the block; `Control`'s reader becomes shared |
| `native/src/lib.rs` | `audio_get_meters` |
| `native/src/offline_render.rs` | none needed. Optionally, expose the block so the harness can print meter readings next to the taps. |
| `audiod/ether-audiod.js` | 33 ms `meters` event for subscribed stations; `metersSubscribe` |
| `electron/main.js`, `electron/preload.js` | forward `audio:meters` (UUID-scoped); in-process poll; `ether.audio.onMeters` / `subscribeMeters` |
| `src/components/meter/*` (new), `VUMeter.tsx`, `ConsoleStrip.tsx`, `SourceChannelStrip.tsx`, `FaderSection.tsx`, `MasterOutput.tsx`, `src/audio/health.tsx` | the one component, the pre-fader strip meters, the master column and Wild Meter, the Health Monitor compact meter |
| `docs/help-meters.md` (new) | help entry |

**Bit-exact:** the meters only **read** buffers the callback already computes. No sample value, order
of operations, or processor/duck/EQ state changes.
- **Gate 1:** all **43 harness renders null bit-exact** against the S7 goldens (`cd8862d`).
- **Gate 2:** the three mixer goldens, the command-path golden and all S3/S4 tests pass unchanged.
- **Gate 3:** the allocation trap stays at **0** across all renders.
- **Gate 4:** the §4 fader-independence and window tests.
- **Gate 5:** C5-style timing, per-buffer median with meters on, reported against the S6 baseline.
- Then smokes (incl. the extended meter-contract), vitest, and tsc 0.
- **Runtime:** a screenshot of a strip's pre-fader meter holding still while its fader moves.

---

## 7 · Decisions for Jeff

1. **Pre-cut or post-cut.** Should the pre-fader channel meter also be **pre-cut** (it moves while the
   channel is OFF; Strata/LXE behaviour, lets you check a source before opening it)? I recommend
   pre-cut. The alternative is post-cut, which is silent while OFF.
2. **RMS convention.** Plain arithmetic RMS (−18 RMS / −15 peak for a sine, which matches the spec's
   verification line) or AES17 sine-referenced RMS (the same sine reads −15 / −15)? I recommend plain,
   because the spec's numbers require it.
3. **The old post-fader strip meter.** Keep it beside the new pre-fader meter (two meters per strip),
   or replace it (one meter showing pre-fader, with the fader position visible on the fader itself)?
   Strata shows the pre-fader meter on the channel. I recommend **replace on strips** and keep
   post-fader data on the wire for the health sense.
4. **Ballistic constants.** Peak fall 20 dB / 1.7 s, hold 2.0 s, average 300 ms, OVER hold 2.0 s.
   Accept them as named constants, or supply the values you want. They're from memory of the IEC
   texts, which I haven't verified against the documents.
5. **Build order.** The engine side first (taps, block, window, NAPI, wire, contract, all gates), then
   the renderer (component, strips, master, Health Monitor, help), as two commits within the slice.
   Or engine-only now, with the UI as slice 2b?

## What this deliberately does NOT build
- **No loudness meter changes.** Short-term and integrated LUFS, LRA and true peak are slice 3.
- **No GR-per-slot.** There are no channel racks yet (slices 5–6).
- **No change to the 10 Hz `levels` frame** or the engine's legacy `VU_RELEASE` fields.
- **No new transport.** Meters ride the existing daemon pipe and IPC, gated by subscription.

---

## 8 · UI build notes (2026-09-25) — what was built, and where it departs from §3

Rulings applied: pre-cut (1), plain RMS (2), one pre-fader meter per strip with post-fader data left on
the wire and buses post-fader (3), and constants named in `src/components/meter/meterBallistics.ts`, with the
two IEC-referenced ones marked UNVERIFIED (4).

**Built**
- **Ballistics:** `meter/meterBallistics.ts`, pure and wall-time driven, pinned by 8 vitest cases:
  - −18/−15 calibration;
  - peak fall;
  - hold;
  - one-pole;
  - rate independence at 30 Hz vs 1 Hz;
  - no decay without data;
  - OVER;
  - zones.
- **Meter store:** `meter/meterStore.ts`. One `audio:meters` listener; the newest frame per station UUID
  is held outside React. `useMeterSubscription(ids)` renews every 2 s against the daemon's 5 s TTL.
- **The meter component:** `meter/PeakAvgMeter.tsx`.
  - Its own rAF loop writes the DOM through refs, so it never re-renders React at meter rate.
  - It draws L/R average bars, a peak dot, a hold tick, an OVER cap and the −18 mark.
  - A stale feed, an absent bus (`live` bit clear) or a missing slot is drawn hatched as **NOT FED**,
    never as silence.
- **Master column:** `meter/MasterMeters.tsx`. PGM / LOCAL / STREAM / MONITOR plus WILD, whose selector
  covers 6 buses and 12 channels (the choice is remembered per viewer in localStorage). The collapsed
  master rail shows PGM.
- **Strips:** `ConsoleStrip` meters `ch[slot]` (the pre-fader tap) for any engine slot, and the `level`
  prop for strips with no slot (mic, guest).
  - The letter-routing chain and the three `isPlaying` gates are removed; the tap needs no gating.
  - An id with no engine slot (the old `"MIC"` id that faked `master × 0.6`) is drawn **NOT FED**.
- **Health Monitor:** each station card's post-fader `peak` bar is now a compact horizontal PGM meter.
- **Help:**
  - new: `docs/help-meters.md`;
  - corrected: `help-channel-faders.md`, which said "a cut channel shows no movement at all", now false
    under pre-cut;
  - corrected: `help-master-monitor-faders.md` and `help-health-monitor.md`.

**Deviations from §3, stated**
1. **Component props.** It takes a source descriptor (`{stationUuid, ch}` / `{stationUuid, bus}` /
   `{external}`), not `peak`/`rms` arrays. It reads its source every animation frame; passing arrays as
   props would re-render React at 30 Hz.
2. **`VUMeter` is not converted.** It has **3** users (MicDeck, MixerChannelStrip, OnAirDeck), not the 7
   the proposal said. Converting it is deferred; those screens are unchanged.
3. **The Health Monitor subscribes at 30 Hz** to every reporting station while it is open, rather than
   using the 1 s fleet-frame decimation. The ballistics are rate-independent, so it reads the same. Closing
   the panel lets the subscription lapse. The fleet frame was not touched.
4. **The subscription lives in the meter's owner.** Each engine-metered `ConsoleStrip`, `MasterMeters` and
   the Health Monitor subscribe themselves; `FaderSection` does not. This keeps canvas and other hosts
   correct with no parent wiring.
5. **`MasterVU` is retired, not kept beside the column.** It drew one mono post-fader value as two bars
   and invented the L/R difference with a sine "wobble". A stereo meter that doesn't measure stereo can't
   stay next to one that does.
6. **Pre-cut applied to the two `level`-prop strips too.** `MicChannel` dimmed its level to 35 % when
   OFF, and the guest strip zeroed it. Both now pass the raw input level.
7. **Engine-commit regression fixed in `233b1c9`.** `a77f55e`'s daemon `meters` broadcast carried the
   integer `stationId`, the 14th emit over the leak-guard ratchet (baseline 13). It was migrated, not
   exempted: main supplies each station's UUID on subscribe and the daemon emits `stationUuid`.

**Runtime: UNVERIFIED.** Nothing here has been seen on screen. The check that settles it is Jeff's, in the
running app:
- a strip's meter holds still while its fader moves;
- it keeps moving with the channel OFF;
- PGM and STREAM move with MASTER, and MONITOR moves only with MONITOR;
- LOCAL reads NOT FED when no local device is set.
