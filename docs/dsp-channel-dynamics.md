# Slice 6 — channel dynamics: expander/gate + compressor (proposal, 2026-09-26)

**Status:** PROPOSAL, nothing built. Dev only, branch `log-reader-flip`.

**Governing:**
- `docs/strata-to-ethercast-build-spec.md`:
  - §2 ranges (`:88-99`);
  - §4 slice 6: order HPF/LPF → expander → EQ → compressor, a GR meter per slot, and the verification;
  - §5 the dynamics view (a transfer graph, the unity diagonal grey, the curve orange, expander and compressor
    overlaid, separate INs, magenta for dynamics).
- `docs/dsp-channel-rack-eq.md`: the channel rack, the 20 ms raised-cosine crossfade, the stage-id state seeding,
  the shared-front optimisation, the type rule, and the timing gate.
- `docs/dsp-mic-in-engine.md`: the mic is a source channel, and the ducker detects **post-rack**.
- The Slice 3 `GrTap` pattern for the meter bus.

---

## 1 · DSP

### Where it runs

- **In the existing `ChannelDsp`, as stages.** Today a `ChainSpec` is up to 8 biquads with stage ids.
  - It becomes up to **10 stages**: HPF ×2, LPF ×2, **Gate**, PEQ ×4, **Comp**.
  - Each stage is a biquad or a dynamics block, with a **stable stage id**.
- **Order (the spec's):** Filters → Gate → PEQ → Comp. As in Slice 5, a slot can be dragged; nothing is pinned.
- **Everything else is Slice 5's, unchanged:**
  - **Parameter changes** are computed on the dispatch thread and delivered in the Params block.
  - **Crossfades:** every change runs the old and new chains together for **20 ms**, raised cosine.
  - **State seeding:** the new chain's state is seeded from the old by stage id. For dynamics that means the
    detector level, the current gain reduction, and the gate's open/hold state.
  - **The shared front:** the leading stages both chains have in common run once.
  - **A rack running nothing** keeps today's exact arithmetic.
- **Why this counts as "parameter changes smooth like the EQ":**
  - A threshold, ratio, knee, **makeup** or depth change is a new plan, crossfaded over 20 ms.
  - Makeup and depth have no ballistics of their own, so without the crossfade a makeup step would be a click.

### The compressor: feed-forward, soft knee, log-domain

**Detector: RMS, not peak. I recommend it for voice (→ Q1).**
- **Why RMS:** a peak detector reacts to plosives and sibilance, so it grabs and pumps on a voice. An RMS
  detector (a one-pole mean-square, **~5 ms**) follows *loudness*, which is what voice compression is for.
- **Peaks** belong to the master true-peak limiter, which already exists.
- **Stereo-linked:** the mean square of L and R, with one gain for both, so the stereo image never shifts. A mic
  is dual-mono, so it's the same either way.

**The gain computer**, in dB (Giannoulis–Massberg–Reiss), with threshold T, ratio R and knee W:

| Input level x | Output level y |
|---|---|
| 2(x−T) < −W | y = x |
| \|2(x−T)\| ≤ W | y = x + (1/R − 1)(x − T + W/2)² / 2W |
| 2(x−T) > W | y = T + (x − T)/R |

- Gain reduction: **GR = x − y**.
- Makeup is added after.

**Ballistics on the GR, in dB:** a branching one-pole. Attack when the GR is rising, release when falling:
- attack 0.10–330 ms;
- release 50 ms–3 s.

**No lookahead**, deliberately.
- The mic already costs ~40 ms round trip, and lookahead would add to it.
- A voice transient overshoots by the attack time; the master limiter catches true peaks.

**Control rate:** the log and exp run every **4 samples** (0.09 ms), with the linear gain interpolated between.
The detector runs on every sample. That keeps the cost at about a quarter, and it still honours a 0.1 ms attack
(→ Q3; the timing test decides).

**Ranges (§2):**

| Control | Range |
|---|---|
| Threshold | −40…+10 dB |
| Ratio | 1:1–20:1 |
| Attack | 0.1–330 ms |
| Release | 50 ms–3 s |
| Makeup | 0–36 dB |
| Knee | 0–12 dB (→ Q2) |

The spec's text is inconsistent about makeup (36 vs "up to 20"). I use your 0–36.

### The expander/gate: downward, with hysteresis

**Detector:** peak-ish and fast. A one-pole on |x| with ~1 ms attack, so the first syllable opens it, and a
~50 ms decay. Stereo-linked.

**Curve:** below threshold T, the gain is −(T − x)(R − 1) dB, **capped at −depth**.
- Ratio 1:1–1:5. **1:3–1:5 is gating**, per the spec's guidance.
- Depth 0–40 dB. The spec's guidance: **14 dB is enough, 20 dB tops.** The editor marks 14 and 20.

**Hysteresis, so it doesn't chatter:**
- It **opens** at T and **closes** only below **T − H**, with H 0–10 dB (→ Q5).
- **Hold** (0–500 ms) keeps it open after the level drops, riding through the gaps between words.
- Then **release** (close) runs 50 ms–3 s, the spec's range. **Open** (attack) runs 0.1–50 ms.

It is the same control-rate, one-pole-in-dB machinery as the compressor.

**Why it matters beyond noise:** the ducker detects each channel **post-rack**. A gated mic's room noise
therefore can't hold the music down (`dsp-mic-in-engine.md` §3), and there's a test for that (§4).

### Cost (to be measured, not assumed)

- Per dynamics block per sample: a detector multiply-add. Every 4 samples: one log, one exp, the gain computer.
- **Estimate:** ~5 µs per block per 480-frame buffer, doubled while fading.
- The timing test gates it (§4).

---

## 2 · The GR meter per slot, and the dynamics view

**On the meter bus:** each channel gets a dynamics tap, in the master `GrTap` pattern:
- `ch_dyn[i] = { gate_gr_max, comp_gr_max, comp_gr_sum, gate_open_frames }`, a 16-byte tap × 12.
- `MeterBlock` grows by 192 B, **776 → 968, re-pinned**.
- On the wire as `chDyn`. The daemon forwards it, and contract RULE 6 requires it.

**In the rack:**
- **The slot tile:** the GATE and COMP tiles each show a live **GR bar** (magenta, the `--slot-dynamics` colour)
  and IN/OUT.
- **The strip:** it shows a small GR lamp when the channel's compressor is working (→ Q7: lamp or no lamp).

**The editor: the transfer curve** (`DynCurve.tsx`, SVG, the spec's Wheatstone dynamics view):
- **Axes:** input dB (x, −70…+10) against output dB (y).
- **Lines:** the **unity diagonal in grey**, and the **resulting curve in orange**, with the expander and the
  compressor **overlaid**.
- **Marked:** threshold, knee and ratio. Each threshold is a draggable handle, with the depth floor shown and the
  14 / 20 dB guidance marks.
- **The live operating point:** a dot at the channel's current pre-dynamics level and its GR, moving at meter
  rate.
- **Controls:** separate IN switches for GATE and COMP, and sliders for every parameter with their numbers.
- **Parity:** the curve comes from a **TS port of the gain computer**, pinned to Rust by a shared fixture (as the
  EQ is).

---

## 3 · Presets: "Voice" and "Off"

**Channel presets are whole channel racks**, stored like the master's:
- the built-ins in code;
- the user's in `station_config_kv` **`rack_ch_presets`** (station-scoped; it syncs like the master's);
- applied with **Arm → Take**, crossfaded;
- **Save / Save As** for your own.

Per-source-class presets ("the host mic's EQ follows the host") stay slice 7.

**The built-ins:**
- **Off:** the **empty** rack. Nothing runs, and it's bit-identical (→ Q6: empty, or all OUT).
- **Voice** — a starting point to adjust by ear:

| Module | State | Settings |
|---|---|---|
| Filters | IN | HPF 80 Hz; LPF OUT |
| Gate | IN | threshold −45 dBFS, depth 15 dB, ratio 1:4, open 1 ms, hold 100 ms, release 150 ms, hysteresis 3 dB |
| PEQ | IN | flat (all bands 0 dB) |
| Comp | IN | 3:1 at −20 dB, attack 10 ms, release 150 ms, knee 6 dB, makeup 0 dB ("to taste": shown as 0, never an automatic makeup) |

Values not in your brief are marked as mine (→ Q8).

**Slice 5's "a new module starts OUT"** still holds for *Add*. **A preset is taken as it is written**: Voice
arrives with its modules IN, because that's what taking a preset means (→ Q9).

---

## 4 · Verification: through the real callback, plus unit tests

| Claim | Test | Bar |
|---|---|---|
| **−10 dBFS over 4:1 at −20 → ~7.5 dB GR** (spec) | A steady 1 kHz sine at **−10 dBFS RMS** (the detector's level; with a peak detector it would be a −10 dBFS-peak sine, Q1), knee 6 dB (10 dB over is past the knee), through the real `mixer_callback` on S1. Read the channel's **GR tap** and the output level. | GR **7.50 ± 0.1 dB**; output −17.5 dBFS RMS + makeup |
| **The gate drops idle room noise by the set depth** (spec) | Pink noise at −60 dBFS RMS on S1; gate −45 / depth 15 / 1:5. Measure the output after release. | **−75 ± 0.5 dBFS** |
| Speech is untouched when open | A −20 dBFS tone burst through the same gate | within 0.1 dB of dry after the open time |
| **No chatter** | A tone swept slowly ±1 dB around the threshold, with hysteresis 3 dB | ≤ 1 open/close transition |
| **No click on a threshold step** (same bar as Slice 5) | A steady 1 kHz −12 dBFS tone. Step the comp threshold −10 → −30 (a 15 dB GR step) **and** makeup 0 → +12 dB, attack 0.1 ms (the worst case). The 8th-order 8 kHz high-pass residual. | **< −80 dBFS**, against the measured floor |
| …and the test can see a click | **Twin:** the same steps with the crossfade off (a hard switch) | must read above the bar |
| **A gated mic doesn't duck the music** | Mic room noise at −55 dBFS, DUCK ON (threshold −45): gate IN → the duck never engages; gate OUT → it does | engaged vs not |
| **Bypassed → the harness nulls** | The 43 goldens with racks absent, **plus** the channels-OUT run extended to Filters+Gate+PEQ+Comp present but OUT on all 12 faders | **bit-exact** to the existing goldens |
| **Allocation trap** | Gate + comp set/process × 3000 buffers, and the mixer with 12 channels crossfading | **0** |
| **TS curve = engine** | A 50-case fixture of gain-computer points, Rust ↔ TS | ≤ 1e-9 |
| **Timing** | New rows: **4 faders + 1 mic with Filters+Gate+PEQ+Comp IN** (gated: p99 ≤ 1 ms, rack CPU ≤ 0.5 ms), plus 12 faders, full rack, all crossfading (recorded) | the gate |

**Receipts** will report the measured numbers and floors, as in Slices 3–5.

---

## 5 · Type rule, blast radius

**Type rule:** `ChannelModule` gains `Gate` and `Comp`; `BranchModule` stays ride + limiter. It still holds:
- the `compile_fail` doctest (`ChannelModule::Ride` → E0599);
- the parse rejection;
- the TS `@ts-expect-error`s (a ride in a channel slot; and a new twin: a channel `comp` is not a branch module).

**The master's loudness modules stay where they are, and a channel compressor is not a loudness module.**

| Area | Change |
|---|---|
| `native/src/rack.rs` | `ChannelModule::{Gate(GateParams), Comp(CompParams)}`, clamps to §2, the doc parser (one of each); the plan gains dynamics stages (`ChainSpec` → a stage kind + params per slot, up to 10) |
| `native/src/chdsp.rs` | Dynamics stages: detector, control-rate gain computer, ballistics, gate state and hold; state seeded by stage id across the crossfade; GR accumulation per buffer |
| `native/src/rt.rs` | `MeterBlock.ch_dyn` (re-pinned 776 → 968) |
| `native/src/audio.rs` | The GR fold into `meters_acc`; timing rows; the callback tests (§4) |
| `native/src/lib.rs` | `chDyn` on the meters wire |
| `native/src/offline_render.rs` | The channels-OUT run extended to all four modules |
| `audiod/*` | `chDyn` forwarded (RULE 6) |
| `src/components/rack/` | Channel-kind Add (Filters, Gate, PEQ, Comp), `DynCurve.tsx`, the dynamics editor, GR bars, the TS gain-computer port and its fixture test, the channel preset bar (Arm → Take, Save / Save As), `channelRack.ts` model and tests |
| `src/index.css` | Uses the existing `--slot-dynamics`; curve colour **orange** (the spec's), as a new `--dyn-curve` token in all themes |
| `docs/` | `help-channel-dynamics.md` (new); `help-channel-eq.md` and `help-mic-input.md` updated (Voice preset, gate vs ducking) |

---

## Decisions for Jeff

1. **Compressor detector: RMS (~5 ms, recommended for voice)**, or peak. This also fixes what the spec's
   "−10 dBFS" means in the test.
2. **Knee:** settable 0–12 dB, default 6 dB (shown). Or fixed?
3. **Control rate:** gain every 4 samples (honours a 0.1 ms attack at a quarter of the cost), or every sample.
   The timing test decides if you prefer.
4. **Makeup range:** 0–36 dB (your brief; the spec also says "up to 20").
5. **Gate hysteresis** 0–10 dB (default 3) and **hold** 0–500 ms (default 100): acceptable ranges and defaults?
6. **"Off" preset:** the **empty** rack (bit-identical, recommended), or every module present but OUT.
7. **A GR lamp on the fader strip** when the compressor is working, or GR only in the rack?
8. **Voice preset values** I chose beyond your brief: gate ratio 1:4, open 1 ms, hold 100 ms, release 150 ms,
   hysteresis 3 dB; HPF 80 Hz IN; comp knee 6 dB. Confirm or change.
9. **Taking a preset puts its modules IN** (as written), while *Add* still starts a module OUT. Confirm.

## What this deliberately does NOT build

- No lookahead.
- No side-chain filter or external key.
- No de-esser.
- No automatic makeup.
- No source-class presets (slice 7).
- No multiband.
- The master rack is untouched.


---

## Rulings (Jeff, GO 2026-09-26)

1. RMS detection.
2. Knee adjustable 0–12 dB, default 6.
3. The gain is recomputed every 4 samples and interpolated between.
4. **Makeup 0–24 dB** (the E-6 manual's 36 was its own inconsistency).
5. Hysteresis 0–10 dB (default 3); hold 0–500 ms (default 100).
6. "Off" = an empty rack.
7. **A small GR lamp on the fader strip.**
8. The Voice values are accepted.
9. Taking a preset switches its modules IN; adding a single module starts OUT.

## Build — the engine

### `rack.rs`

- **Modules:** `ChannelModule::Gate(GateParams)` and `Comp(CompParams)`, clamped to the ranges above.
  - Gate threshold −80…0 dBFS (the spec gives none), open 0.1–50 ms, release 50 ms–3 s.
  - One of each module per rack.
- **The plan:** it carries **stages**, `kind` (biquad / gate / comp) with the biquads (`bq`) or dynamics
  coefficients (`dy`). `CHAIN_MAX` 8 → 10. Stage ids: GATE 8, COMP 9.
- **`DynCoef`:** detector and ballistics coefficients computed on the dispatch thread. The comp RMS window is
  5 ms; the gate detector is 1 ms attack / 50 ms decay.
- **The static curves**, the source the TS graph is pinned to:
  - `comp_gr_db` (Giannoulis–Massberg–Reiss soft knee);
  - `gate_gr_db` ((t − x)(r − 1), capped at depth).

### `chdsp.rs`

**Per stage state:** a biquad's s1/s2, or a dynamics block's detector, smoothed GR, interpolated gain, GR max,
gate open/hold. It is seeded across a crossfade by stage id like a biquad's.

**`dyn_step`, per sample:**
- the detector (comp: a mean square of L+R, linked; gate: a peak envelope);
- every 4 samples, `dyn_control`:
  - the gain computer with hysteresis + hold (gate);
  - ballistics as a one-pole on the GR in dB (comp: rising = attack; gate: falling = opening = its attack);
  - makeup;
- the linear gain interpolated across the block;
- one gain for both channels.

**`take_gr()`** gives the meter the running chain's gate GR max, comp GR max, and gate open, allocation-free.

**Every parameter change is a new plan, crossfaded 20 ms.** That is what makes a makeup or depth step clickless.

### Plumbing

- **`rt.rs`:** `DynTap { gate_gr, comp_gr, gate_open, runs }`, 16 B × 12 → `MeterBlock` **968 B** (re-pinned).
- **`audio.rs`:** the deck loop folds `take_gr()` into `ch_dyn`, then into `meters_acc`.
- **`lib.rs`:** `chDyn` on the meters wire: [gate GR, comp GR, open fraction] per channel.
- **The daemon** forwards `chDyn`; contract RULE 6 requires it.
- **`offline_render.rs`:** the channels-OUT document now carries **Filters + Gate + PEQ + Comp**, all OUT.

### Receipts (dev app stopped)

**The spec case, through the real callback.** A 1 kHz sine at −10 dBFS RMS on S1, 4:1 at −20 dB, knee 6:

| Measure | Result | Bar |
|---|---|---|
| GR tap | **7.536 dB** | 7.50 ± 0.1 |
| Output | **−17.536 dBFS RMS** | −17.5 |

The tap reports the window's maximum, so the RMS detector's small ripple on a steady sine sits just above 7.5.

**The gate, through the real callback.** Room noise at −60 dBFS RMS (Gaussian), gate −45 / depth 15 / 1:5:

| Measure | Result | Bar |
|---|---|---|
| Output | −59.95 → **−74.95 dBFS** | −75 ± 0.5 |
| GR tap | 15.00 dB | — |
| Open | 0 % of the time | — |
| A −20 dBFS speech-level tone | **Δ +0.000 dB** | untouched |

**No click.** A 1 kHz −12 dBFS tone, attack 0.1 ms (the worst case), floor −155.2 dBFS, bar −80:

| Step | Crossfaded | Hard-switch twin |
|---|---|---|
| Threshold −10 → −30 (an 11.25 dB GR step) | **−119.7 dBFS** | −49.4 |
| Makeup 0 → +12 dB | **−116.3 dBFS** | −43.5 |

The twins show the test can hear a click.

**Ducking.** Mic room noise at −52 dBFS RMS, DUCK ON, programme on A. The lowest duck gain after 3.3 s:
- **ungated: 0.043** — it ducks;
- **gate −40 IN: 0.999** — it doesn't.

**No chatter.** A level wandering ±1 dB around the threshold for 10 s: **1** transition with hysteresis 3 dB +
hold 100 ms, against **10** for the twin with neither.

**Goldens:**
- racks absent: `[null]` 43/43;
- `[rack-null]` 43/43;
- **all racks OUT (Filters+Gate+PEQ+Comp on all 12 faders): 43/43**;
- NAPI on `156e9afc…7d0c`: 43/43.

**Transfer graph vs engine:** the committed fixture (50 cases × 9 levels) equals Rust to 3.6e-15 dB. The TS side is
checked in the UI commit (bar 1e-9).

**Allocation trap:**
- gate/comp set + process + take_gr × 3000: **0**;
- the mixer callback, every timing row and the 43 renders: **0**.

**Timing** (480-frame buffers):

| Row | median | p99 | rack CPU max | Gate |
|---|---|---|---|---|
| **4 faders + 1 mic, FULL rack IN (Filters+Gate+PEQ+Comp)** | 0.326 | **0.529** | 0.327 | **PASS** (p99 ≤ 1 ms, rack CPU ≤ 0.5 ms) |
| (a) 4 faders, racks IN | — | 0.107 | — | — |
| (b) 4 faders, 1 crossfading | — | 0.115 | — | — |
| 12 faders, FULL rack, ALL crossfading | 0.752 | 1.289 | — | recorded, not gated |

**The extreme row is over 1 ms.** Twelve full racks all crossfading at once is not an operating state. It is
reported here so it isn't discovered later.

**Suite:** `test:rust` 88 + 7 + 2.

**Gates:**
- tsc 0 errors; vitest 477/477;
- meter contract 30/30 (RULE 6 with `chDyn`);
- rack-eq, mic-input and pfl smokes pass;
- undefined-calls, preload-bridge, ipc-contract and one-switch PASS;
- leak guard 13/13.
