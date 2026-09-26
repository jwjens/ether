# DSP slice 5 — channel rack v1: HPF/LPF + 4-band parametric EQ (PROPOSAL)

**Status:** PROPOSAL, 2026-09-26. Nothing is built. It builds on GO.
**Branch:** `log-reader-flip`, dev only. No push, no tag.

**Governing sources:**
- Spec §4, slice 5: *"Instanced per fader, pre-fader, default bypassed. Parameter smoothing. Ranges from §2.
  — Bypassed: null holds. HPF at 100 Hz removes rumble by ear; sweep shows −3 dB at 100 Hz, 24 dB/oct."*
- Spec §2, the ranges. These are quoted from the Wheatstone E-6 guide ("family reference values, not
  confirmed Strata specs"):
  - **PEQ:** ±14 dB, centre 16.1 Hz–20.2 kHz, width 0.2–3.0 octaves (≈ Q 7.2–0.40; I checked the conversion),
    LOW and HIGH bands switch to shelving.
  - **HPF:** 24 dB/oct Butterworth, 16.1–500 Hz, own IN/OUT.
  - **LPF:** 24 dB/oct Butterworth, 1–20.2 kHz, own IN/OUT.
- Spec §5, the EQ view: 20 Hz–20 kHz log × ±15 dB, each band its own colour, filters drawn opaque when IN,
  separate EQ / HPF / LPF IN, two fingers set bandwidth.
- `docs/dsp-rack-framework.md`: the `ChannelModule` type, the rack document (`rack_ch_<slot>`), and the one
  Params block.
- **Jeff's ruling:**
  - The deck and mic EQ knobs that hit station 1's master EQ are replaced by this.
  - There is one channel rack per fader (A–F, S1–S5, CART), post-trim and pre-fader.
  - It defaults to BYPASSED and empty, so the harness nulls and nothing changes on air until an operator
    adds a module.

---

## Summary

1. **Two channel modules, both in the existing rack model:**
   - **Filters:** HPF + LPF, each its own IN, each a 4th-order Butterworth made of two cascaded biquads.
   - **PEQ:** four RBJ bands, with bands 1 and 4 switchable to shelves; the slot's IN is the PEQ's IN.

   `ChannelModule` gains exactly these two variants, and still no ride. Both proofs of the type rule carry
   over unchanged.
2. **Coefficients are computed on the dispatch thread** (f64, RBJ cookbook) and delivered in the Params
   block, like every other operator value. The callback runs biquads and nothing else.
   - **Changes are crossfaded:** 20 ms, old coefficients → new, both running on the same input. IN/OUT is a
     20 ms dry/wet fade.
   - This is proven with a 1 kHz tone and a band-gain step: the click residual must stay below −80 dBFS, and
     a hard switch is shown to exceed it, so the test can see a click.
3. **Placement:** post-trim, pre-fader, pre-duck, in the deck loop.
   - **A channel with nothing IN keeps today's exact arithmetic** (`l × (volume × trim)`), so all 43 goldens
     null by construction. A rack that is merely present, or OUT, changes nothing.
   - The Slice 2 pre-fader meter stays **pre-rack** (the spec). A new **post-rack** tap shows what the EQ did.
4. **The door is an EQ button on every fader strip.** It opens the same Rack window at that channel, with a
   curve editor (draggable nodes, wheel or pinch for width) and the header "editing: S2 · PEQ".
5. **The dead deck EQ is removed** (it never processed a deck). **The mic's EQ is different:** it is real,
   but in Web Audio, where the engine rack can't reach. Only its bad send is removed (§6, a decision for
   you).

---

## 1 · DSP

### 1.1 The filters (all biquads, transposed direct form II, **f64 state and coefficients**)

| Block | Design | Parameters (range) | Coefficients |
|---|---|---|---|
| **HPF** | 4th-order Butterworth = two 2nd-order sections, Q₁ = 1/(2 cos π/8) = **0.5412**, Q₂ = 1/(2 cos 3π/8) = **1.3066** | freq 16.1–500 Hz, IN | RBJ HPF per section. The cascade is −3.01 dB at fc and 24 dB/oct. |
| **LPF** | same pair of sections | freq 1–20.2 kHz, IN | RBJ LPF per section |
| **PEQ band 1** | RBJ **peaking**, or **low shelf** when switched | freq 16.1 Hz–20.2 kHz, gain ±14 dB, width 0.2–3.0 oct | Q = √(2^BW) / (2^BW − 1); RBJ shelf with the same Q |
| **PEQ bands 2–3** | RBJ **peaking** | same | same |
| **PEQ band 4** | RBJ **peaking**, or **high shelf** when switched | same | same |

- **Why f64:** a 16 Hz HPF at 44.1 kHz puts its poles about 0.002 from the unit circle. f32 coefficients
  and state there drift and add noise, which is audible on the very rumble this filter exists to remove.
  f64 is the standard remedy. The cost is measured (§1.4), not assumed.
- A band at 0 dB is **skipped** (its coefficients are an exact identity), so an untouched band costs nothing.
- The Nyquist edge: centres above 0.45·fs are clamped to 0.45·fs, a stated clamp beside the others. 20.2 kHz
  at 44.1 kHz is above it.

### 1.2 Coefficients off the audio thread, delivered in the Params block

- **The dispatch thread** (`Control`, where every other operator value is clamped) computes the coefficients
  when a channel rack arrives (`SetChannelRack`), in f64, using `rack.rs` functions.
- They are written into `Params.ch_rack[slot]`: `{ slots, coeffs: [Biquad; 8], version }` (8 = 2 HPF +
  2 LPF + 4 PEQ).
- **The callback adopts a channel's block only when its `version` changes.** The trigonometry never runs on
  the audio thread.
- **Size:** 12 channels × (8 biquads × 5 × 8 B + module parameters) ≈ **5.5 KB** added to the Params block.
  The block is boxed on the dispatch thread (allocation off-RT, as today). The callback copies a channel's
  coefficients only when that channel's version changes.

### 1.3 Smoothing: no zipper noise, stated and proven

| Change | What the callback does | Time |
|---|---|---|
| A coefficient change (freq, gain, width, shelf, or HPF/LPF freq) | Run the **old** and the **new** coefficient sets on the same input. The new state is seeded from the old state at the switch. Crossfade **linearly per sample**, old → new. | **`EQ_XFADE_MS = 20`** (882 samples at 44.1 kHz) |
| A change arriving *during* a fade (a slider drag) | Held; the **latest** is applied when the running fade ends | ≤ 20 ms added latency on a drag, never a jump |
| IN ↔ OUT (the PEQ slot, HPF IN, LPF IN) | Dry/wet crossfade | 20 ms |

- During a fade that channel runs twice the biquads (§1.4 includes this worst case).
- **Proof** (a unit test on the channel DSP, then through the callback on a source channel):
  - a 1 kHz sine at −12 dBFS;
  - PEQ band 2 at 1 kHz stepped 0 → +12 dB mid-buffer;
  - the output, high-passed at 8 kHz (4th-order, so the 1 kHz tone and its gain change are removed and only
    a discontinuity's broadband energy is left), must peak **below −80 dBFS**.
- **The control:** the same step applied with no crossfade must peak **above −80 dBFS**, so the test is
  shown to see a click.
- **A second case:** a 30 Hz stream of gain changes (a slider drag), same bar.
- **Denormals:** the callback runs under Slice 1's `FtzScope` (FTZ/DAZ), which covers these biquads.
  A test feeds 10 s of tone and then 10 s of silence through an active rack, and asserts that the
  per-buffer time in the silent tail doesn't rise (a denormal stall would).

### 1.4 Cost — measured in the build, and gated

The build measures, C5-style, one channel with Filters + PEQ both IN (4 + 4 biquads, stereo, f64):
- steady state;
- crossfading;
- **12 channels crossfading at once**, the worst case, reported as a share of the 10 ms budget.

Rough arithmetic, to be replaced by the measurement:
- 8 biquads × 2 channels × 441 frames ≈ 7 k biquad-samples per channel-buffer;
- about 20–40 µs per channel, ×2 while fading;
- 12 channels fading at once ≈ 0.5–1 ms.

The measurement is the receipt. **If the 12-channel fading worst case exceeds 1 ms, I stop and report** rather
than ship it.

---

## 2 · Where it runs, and the meters

**In the deck loop** (`audio.rs`, where each deck's frames become `lv = l * vol`):

```
feed (the deck's frames) → × trim → [ PRE-RACK METER TAP (Slice 2, unchanged) ]
                         → CHANNEL RACK (Filters → PEQ, in slot order)
                         → [ POST-RACK METER TAP (new) ]
                         → × fader (0 when cut) → mix / core / room / src / det / aux (unchanged)
```

- **Post-trim, pre-fader, pre-duck.** The duck detector (`det`) and the sums hear the EQ'd channel. The
  duck acts later on the sums, as today.
- **Bit-exactness, by construction.**
  - Today the air sample is `l * (volume × trim)`: one multiply by a fused gain.
  - A rack stage in the middle computes `((l × trim) → EQ) × volume`. That rounds differently even through
    a unity EQ.
  - So **a channel whose rack has nothing IN, and no fade in progress, takes today's exact expression**,
    untouched. Empty racks, racks with modules OUT, and every existing golden are bit-identical.
  - The moment a module is IN, the new arithmetic applies. That is the processing the operator asked for.
- **Meters.** The Slice 2 `ch[i]` tap stays **pre-rack**: the spec's "post-trim, pre-rack", and what the
  strips show. A new **`ch_post[i]`** tap after the rack (so +288 B in `MeterBlock`, re-pinned) goes on the
  wire as `chPost`. The rack window's pinned column shows **IN (pre-rack) and OUT (post-rack)** for the
  selected channel: what the EQ did. The strips keep the pre-fader, pre-rack meter (Slice 2 ruling 3: one
  meter per strip).

---

## 3 · Persistence

- `station_config_kv` key **`rack_ch_<slot>`** (e.g. `rack_ch_A`, `rack_ch_S2`, `rack_ch_CART`): the
  framework's document, `{ "v": 1, "sections": { "ch": [ …slots… ] } }`.
  - Same table, same sync (station-scoped), same `rack:get` / `rack:set` path, extended with a `rack` name.
  - The engine answers first and it is stored only if accepted, as for the master.
  - **No write-back:** there are no legacy keys for channel EQ that anything reads (§6).
- **The daemon's poll** reads the station's `rack_ch_*` keys and calls `audioSetChannelRack(station, slot,
  json)` on change and on every engine start. That is the same mechanism that now re-applies the master
  GEQ.
- **The rack belongs to the fader (the slot), not to the source.** Racks that follow a source ("the host
  mic's EQ") or a source class are presets, in slice 7. Nothing syncs differently.

---

## 4 · UI

- **The same `Rack` component, parameterized by rack kind:** `master`, or `channel(slot)`. The Processor
  window gains a **rack selector row** (MASTER | A B C D E F | CART | S1…S5); each tab shows that rack's IN
  lamp.
- **The door:** an **EQ** button on every fader strip (`ConsoleStrip`), lit when that channel's rack has
  something IN. It opens the rack window at that channel (the same `ether.rack.select` mechanism Master Out
  uses for the GEQ).
- **The channel rack:**
  - The strip starts empty, and says so ("empty · add").
  - **Add** offers **Filters** and **PEQ** (one of each, from `ChannelModule`'s type list, so the ride can
    never be offered).
  - **A newly added module starts OUT (bypassed):** the spec's "default bypassed". Adding a module changes
    nothing on air until its IN is pressed.
  - **Order is Filters → PEQ.** The spec's Trim → Filters → Gate → EQ → Comp has room for slice 6's gate
    and compressor. Filters can be dragged after the PEQ: the first real use of Slice 4's reorder rules,
    with nothing pinned in a channel rack.
- **The editor: the EQ curve** (`EqCurve.tsx`, SVG, 20 Hz–20 kHz log × ±15 dB, spec §5):
  - **The drawn curve is computed from the same coefficients the engine runs.** A TS port of the coefficient
    functions, pinned against the Rust ones by a shared test vector (§5).
  - Each PEQ band has **its own colour** (`--band-1` … `--band-4`, new tokens) and a **draggable node**:
    horizontal = frequency, vertical = gain. The **mouse wheel or a two-finger pinch sets the width.**
    Nodes are ≥ 44 px targets.
  - **HPF and LPF are drawn as opaque shaded regions when IN**, outlined when OUT.
  - **Separate IN buttons for HPF, LPF and PEQ.** A **shelf** toggle on bands 1 and 4.
  - Numbers beside every node: frequency, gain, width in octaves.
  - The header reads **"editing: S2 · PEQ"** (the channel is always named, the Strata/LXE convention).
- **Colours:** Filters `--slot-filter` (green), PEQ `--slot-eq` (blue), both from Slice 4. The per-band
  tokens are new, with values for all four themes.

---

## 5 · Verification

| Claim (spec) | Test | Bar |
|---|---|---|
| **Bypassed → the harness nulls** | The existing 43/43. Plus **channel-rack-path renders**: the same 43 with a Filters + PEQ rack present on deck A but **OUT**, delivered through the daemon's document path. | bit-exact to the **existing** goldens |
| **HPF 100 Hz: −3 dB at 100 Hz** | Steady sines through the real callback on a source channel, HPF IN at 100 Hz. Measured after the fade and the filter's settling. | 100 Hz: **−3.01 ± 0.1 dB** |
| **24 dB/oct** | Same, at 50 Hz and 25 Hz. Butterworth-4 theory: 10·log₁₀(1 + (fc/f)⁸) = 24.08 / 48.16 dB; the RBJ sections at 44.1 kHz, computed: **−24.100 / −48.165 dB** (and −3.010 at 100 Hz) | 50 Hz −24.1 ± 0.3; 25 Hz −48.2 ± 0.5 |
| **"Sweep shows it"** (the spec's own receipt) | The existing corpus sweep (`sweep_20_20k_m18`) rendered through the rack, magnitude from a windowed analysis at 100 / 50 Hz | the same bars, ± 0.5 dB (sweep analysis is coarser than steady tones) |
| **PEQ 1 kHz +6 dB → +6 at 1 kHz, 0 at 100 Hz and 10 kHz** | Steady sines, band 2 at 1 kHz, +6 dB, **width 1.0 oct** (the RBJ bell's own residual, computed: 0.033 dB at 100 Hz, 0.022 dB at 10 kHz — inside the bar by theory) | +6.00 ± 0.1; 0.00 ± 0.1; 0.00 ± 0.1 |
| **LPF** mirrors the HPF | 10 kHz LPF: −3.01 at 10 kHz, −24.1 at 20 kHz | same bars |
| **Shelves** | Band 1 low shelf +6 dB at 200 Hz: +6.0 ± 0.1 at 40 Hz, 0.0 ± 0.1 at 4 kHz | stated |
| **No zipper** | §1.3 | < −80 dBFS; the control above |
| **TS curve = engine** | A fixture of 50 parameter sets → coefficients in Rust and in TS | ≤ 1e-9 relative |
| **Type rule holds** | `ChannelModule` now has `Filters` and `Peq`. The `compile_fail` doctest (`ChannelModule::Ride` → E0599), the parse rejection, and the TS `@ts-expect-error`, all unchanged | as Slice 4 |
| **Allocation trap** | 12 channels active and crossfading, 2 000 buffers | 0 |
| **Timing** | §1.4 | one channel; 12 channels worst case |

---

## 6 · The dead deck/mic EQ: removed, or routed here

What exists today (static reading; runtime of the old behaviour UNVERIFIED):

| Where | What it did | Proposal |
|---|---|---|
| **`OnAirDeck.tsx`** (deck A/B/C: canvas `DeckWidget`, the pop-out) | A 10-band `GraphicEQ` drawer. Stored `eq_deck_<X>` and called `setEq(deckId, …)`, which main applied as **station 1's master EQ**. It **never processed the deck.** Since Slice 4 the send is refused. | **Remove** the drawer, the send and the `eq_deck_*` read. Its **EQ button becomes the door to that deck's channel rack.** Stored `eq_deck_A/B/C` values are **not** migrated: they never affected audio, so seeding a rack from them would change the sound. |
| **`MicDeck.tsx`** (`App.tsx`, canvas `Widgets`) | A 10-band `GraphicEQ` that **really does EQ the mic**, via Web Audio `BiquadFilter`s on the mic's own graph (`MicDeck.tsx:55-75`). It also sent `setEq("mic")`, the station-1 master EQ hit. | **Remove only the bad send.** The mic never enters the Rust engine (there's no input stream), so the channel rack **can't process it**. Its Web Audio EQ is the mic's real EQ until the mic becomes an engine input. See §8 Q1. |

---

## 7 · Blast radius, trap, timing

| Area | Change |
|---|---|
| `native/src/rack.rs` | `ChannelModule::{Filters(FilterParams), Peq(PeqParams)}`; the doc parser and clamps; coefficient functions (RBJ, Butterworth sections) in f64; the TS-parity fixture |
| `native/src/chdsp.rs` (new) | `ChannelDsp`: biquad chain state, the crossfade engine, dry/wet IN fades. Preallocated per slot (12), no heap. |
| `native/src/rt.rs` | `Params.ch_rack: [ChannelRackParams; SLOT_COUNT]`; `MeterBlock.ch_post` (re-pinned) |
| `native/src/audio.rs` | The deck loop: the exact old path when nothing is IN, else trim → rack → post tap → fader; `SetChannelRack`; `ChannelDsp` state in `BusState`; timing tests |
| `native/src/lib.rs` | `audio_set_channel_rack(station, slot, json) -> {ok, reason}`; `chPost` on the meters wire |
| `native/src/offline_render.rs` | Channel-rack renders (rack present but OUT), the HPF/PEQ tone and sweep measurements |
| `audiod/engine.js`, `rack-seed.js`, `ether-audiod.js` | The poll reads `rack_ch_*` and delivers them (and re-applies at engine start); `setChannelRack` |
| `electron/main.js`, `preload.js` | `rack:get` / `rack:set` take a rack name (`master` or `ch:<slot>`) |
| `src/components/rack/` | `Rack` parameterized by kind; the rack selector; `EqCurve.tsx`; the channel `rackModel` additions and tests; the TS coefficient port and its parity test |
| `ConsoleStrip.tsx` | The EQ door button + IN lamp |
| `OnAirDeck.tsx`, `MicDeck.tsx` | §6 |
| `src/index.css` | `--band-1…4` (all themes) |
| `docs/` | `help-channel-eq.md` (new); `help-processor-rack.md` and `help-meters.md` (post-rack meter) updated |

- **Bit-exact:** every existing golden, plus rack-present-but-OUT renders. **Not** bit-exact, by design:
  a channel with a module IN.
- **Trap:** 0, with 12 channels crossfading.
- **Timing:** one channel steady and fading; 12 channels fading (worst case). A stop-and-report gate at
  1 ms (§1.4).

---

## 8 · Decisions for Jeff

1. **The mic's EQ.** It is real, but in Web Audio (the mic isn't in the engine).
   - **I recommend: keep it as the mic's EQ, remove only the station-1 send, and label it** ("mic EQ — in
     the mic's own chain") until the mic becomes an engine input.
   - The alternative is to remove it for one EQ language, which leaves the mic with no EQ.
2. **Smoothing time.** I propose 20 ms for the coefficient crossfade and the IN/OUT fade: long enough to be
   inaudible, short enough that a drag feels immediate. A different value?
3. **f64 filters** (§1.1): the precision the 16 Hz HPF needs, at a cost the build measures. Or f32, with the
   HPF floor raised?
4. **`eq_deck_A/B/C`** (§6): discard. They never touched the audio, so migrating them would change the
   sound. Confirm.
5. **Adding a module starts it OUT** (the spec's "default bypassed"), so an operator presses IN to hear it.
   Or should Add go straight to IN?

## What this deliberately does NOT build

- No gate or compressor (slice 6).
- No source-following racks and no show presets (slice 7).
- No mic in the engine.
- No change to the master rack.
- No change to the strip meter (it stays pre-fader, pre-rack; the post-rack meter lives in the rack view).

---

## Build — engine (2026-09-26)

**Jeff's GO rulings:**
1. Mic EQ: keep it, labelled "mic input EQ (browser audio)", and remove only the send to station 1.
2. Smoothing is 20 ms.
3. 64-bit coefficients and filter state.
4. Discard `eq_deck_*`.
5. New modules start OUT.

**Timing rulings:**
- Gate on p99 ≤ 1 ms.
- Attribute any spike by thread-CPU time and per channel.
- Gate rows (a) and (b), what OV runs: p99 ≤ 1 ms AND rack CPU max ≤ 0.5 ms.
- The 12-all-crossfading row is recorded as the extreme, not gated.

### Receipts

| Receipt | Result |
|---|---|
| Goldens (`[null]`) | 43/43 bit-exact |
| Rack path (`[rack-null]`) | 43/43 bit-exact |
| **Racks present but OUT on all 12 faders** (`[ch-out-null]`) | 43/43 bit-exact, 0 allocations |
| NAPI, fresh `.node` `854f51f2…0880` | `[napi] 43/43 renders bit-exact to the manifest` |
| Allocation trap | `ChannelDsp` set + process × 3000 buffers: **0**; every timing row: 0; the 43 renders: 0 |
| No click (1 kHz −12 dBFS, band 2 steps 0 → +12 dB) | crossfaded **−137.3 dBFS** · hard-switch twin **−66.8 dBFS** (the test sees a click) · floor −155.2 · bar −80 |
| Slider drag (33 changes/s) | −143.6 dBFS |
| Type rule | `compile_fail` doctest on `ChannelModule` passes (a ride can't be built as a channel module); a `ride` in a channel doc is refused at parse ("unknown variant `ride`") |
| Suite | `npm run test:rust`: 64 + 7 + 2 doctests pass (1 ignored = `capture_goldens`) |

**Measured through the callback vs computed (f64 RBJ / Butterworth):**

| Filter | Point | Measured | Computed |
|---|---|---|---|
| HPF 100 Hz | 100 Hz | −3.030 | −3.010 |
| | 50 Hz | −24.114 | −24.100 |
| | 25 Hz | −48.170 | −48.165 |
| PEQ 1 kHz +6 dB, 1 oct | 1 kHz | 5.982 | 6.000 |
| | 100 Hz | 0.013 | 0.033 |
| | 10 kHz | 0.004 | 0.022 |
| LPF 2 kHz | 2 kHz | −3.028 | −3.010 |
| | 4 kHz | −24.837 | −24.819 |
| Corpus sweep through HPF 100 Hz | 100 Hz | −3.065 | −3.010 |
| | 50 Hz | −24.183 | −24.100 |

### Timing: 480-frame (10.9 ms) buffers, 1900 measured per row, release build, 5 runs

"Rack CPU" is thread cycles (`QueryThreadCycleTime`) × ms/cycle, calibrated per run on a 200 ms busy loop
(≈ 4.03e-7 ms/cycle). `GetThreadTimes` was the ruling's example. It ticks at the ~15.6 ms scheduler
quantum, coarser than one buffer, so the cycle counter is the thread-CPU measure used. Preemption adds
wall time but not cycles.

| Row | median | p99 (5 runs) | rack CPU max (5 runs) | Gate |
|---|---|---|---|---|
| 12 playing, no racks (baseline) | 0.057–0.059 | 0.073–0.078 | — | — |
| 1 fader, rack IN, steady | 0.029–0.034 | 0.038–0.084 | 0.009–0.025 | — |
| 1 fader, rack IN, crossfading | 0.036–0.039 | 0.045–0.089 | 0.016–0.036 | — |
| **(a) 4 faders, racks IN, steady** | 0.071–0.078 | **0.086–0.148** | **0.045–0.071** | **PASS** |
| **(b) 4 faders, racks IN, 1 crossfading** | 0.080–0.082 | **0.113–0.132** | **0.047–0.077** | **PASS** |
| 12 faders, racks IN, steady | 0.165–0.169 | 0.195–0.278 | 0.130–0.162 | recorded |
| 12 faders, ALL crossfading (extreme) | 0.226–0.416 | 0.527–0.579 | 0.313–0.363 | recorded |

The timed racks are Filters (HPF + LPF) plus a PEQ with all 4 bands non-zero: the full 8 biquads, stereo, f64.

### Attribution: the 12-crossfading wall spikes are the machine, not the rack

**The spikes are wall time without CPU time.** Worst rack wall per run, against the rack CPU in that
same buffer:

| Run | Rack wall (ms) | Rack CPU, same buffer (ms) |
|---|---|---|
| 1 | 0.523 | 0.335 |
| 2 | 0.573 | 0.246 |
| 3 | 0.483 | 0.307 |
| 4 | 0.498 | 0.330 |
| 5 | 0.482 | 0.313 |

The excess wall time is time the thread was not running.

**A spike lands on ONE channel, never all 12.** The worst rack buffer, by channel:

| Run | Spiked channel (ms) | Other 11 channels (ms) |
|---|---|---|
| 1 | ch 0: 0.256 | 0.024 each |
| 2 | ch 4: 0.370 | 0.011–0.031 |
| 3 | ch 7: 0.187 | ~0.022 |
| 4 | ch 6: 0.128, ch 8: 0.134 | ~0.018–0.039 |
| 5 | ch 5: 0.241 | ~0.024 |

Every channel runs identical work. One channel taking 10–15× the others, with no matching CPU, is
preemption, not DSP.

**The steady rows show the same pattern:**

| Row | Run | Spiked channel (ms) | Other channels (ms) | Rack CPU, that buffer (ms) |
|---|---|---|---|---|
| (a) 4 steady | 4 | 0.258 | 0.007 | 0.032 |
| 12 steady | 5 | 0.214 | 0.007 | 0.094 |

**The rack's own CPU is steady.** Its maximum on the extreme row is 0.31–0.36 ms, about 12 × 0.022 ms
plus overhead, well under the 0.5 ms attribution bar even there. On (a) and (b) it is ≤ 0.077 ms.

Note: the extreme-row median (0.23–0.42 ms) is higher than before this instrumentation (0.23–0.25 ms).
The test now makes two `QueryThreadCycleTime` syscalls per channel call. Test builds only; none of this
compiles into the product.

### "Stop running the old chain once its crossfade weight is zero"

**Taken literally, this is a no-op here.** The fade is a raised cosine, and old's weight
(1 + cos θ)/2 reaches 0 only on the fade's final sample. That sample already ends the fade, and the old
chain stops.

**What was implemented instead is the exact saving that exists.**
- During a fade, the leading stages the old and new chains share (same stage id, same coefficients, and
  identical state because the new chain is seeded from the old) are computed once. Their output feeds
  both chains' remainders.
- Editing a PEQ band therefore no longer runs the HPF/LPF front twice: 4 of 8 stages are shared in the
  timed rack.

**It is exact, not approximate.** Test `the_shared_front_is_bit_identical_to_running_both_chains`:
- 3 s of tone, a PEQ change every 7 buffers;
- sharing ON vs both chains computed in full: **bit-identical, 4 stages shared**.

The no-click tests, the goldens and the ch-OUT null all still pass.

### Wiring

**Daemon** (`audiod/engine.js`, `_applyChannelRacksFromKv`):
- Reads THIS station's `rack_ch_*` every 3 s and calls `audioSetChannelRack` on change.
- Re-applies on every fresh engine.
- Re-asserts every 15 s only racks with something IN, the same no-device-window reason as the master.
- Never sends a fader with no document.
- A refused rack is logged, not retried every 3 s.

**Shared helper** (`audiod/rack-seed.js`): `CHANNEL_SLOTS`, `channelKey`, `channelRack`,
`channelRackActive`.

**Daemon command:** `setChannelRack` (`ether-audiod.js`).

**Meters:** the meters event forwards `chPost`. Contract RULE 6 now requires it.

**Main / preload:**
- `rack:get(stationId, rack)` and `rack:set({stationId, doc, rack})` take `"master"` (the default) or
  `"ch:<slot>"`.
- A channel rack goes to the engine first and is stored (`rack_ch_<slot>`) only if accepted.
- No seed, no write-back.

**Smoke:** `npm run test:rack-eq` §6 (8 checks):
- station-scoped delivery by slot;
- another station's rack is never sent;
- a change lands within one poll;
- nothing IN → no re-assert;
- a respawn re-applies;
- main delivers by slot.

**Gates:**
- `tsc --noEmit` 0 errors;
- vitest 452/452;
- undefined-calls, preload-bridge and ipc-contract all PASS;
- leak guard 13/13 (baseline holds);
- meter contract 30/30.
