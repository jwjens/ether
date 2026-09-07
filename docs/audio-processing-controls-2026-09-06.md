# The program processor becomes an instrument you can play

**Date:** 2026-09-06 · **Status:** DESIGN ONLY — nothing built. Jeff rules before any code.

**The trigger, on Jeff's ears, not reasoned:** with the processing toggles OFF a song plays through the
overlap cleanly. With them ON the incoming song buries the outgoing.

**The ruling this is written under:** *"The limiter becomes an adjustable feature alongside the Master
EQ. No workarounds — I'm not normalizing my way around a processor I can't control."* And: every current
value displays as the current value. No blank fields, no hidden defaults.

**§10 is the honest answer to "does this actually fix it".** Read that first if you read nothing else.

---

## 1 · The limiter as it exists

`native/src/program_processor.rs`, `struct TruePeakLimiter`. Every parameter it has:

| parameter | current value | where it lives | changeable today |
|---|---|---|---|
| Ceiling | **−1.0 dBTP** | `CEILING_DBTP` const, `:20` | **no** — compile-time |
| Look-ahead | **1.5 ms** (`sample_rate * 0.0015`, min 8) → 66 samples @44.1k | `:91` | **no** |
| Attack | completes within the look-ahead — `exp(-1/(la*0.5))` | `:93` | **no** |
| Release | **120 ms** — `exp(-1/(fs*0.120))` | `:94` | **no** |
| Detection headroom | **×1.15** applied to the measured true peak | `:106` | **no** |
| Oversampling | **4×**, 8 taps per phase, windowed-sinc Hann polyphase | `PHASES` / `TAPS_PER_PHASE`, `:27-28` | **no** |
| Knee / ratio | none — brickwall. `req = ceiling / tp` when over | `:107` | n/a |
| Gain reduction | **observed output**, `gr_db` | `:118` | read-only |

**Nothing about the limiter can be changed today, by anyone, without recompiling Rust.** There is no
command, no setting, no key.

## 2 · The whole chain, in order

`ProgramProcessor::process_planar` (`:219-231`) — the order is exactly two stages:

```
program bus  →  [1] LOUDNESS RIDE (one gain per buffer)  →  ×g  →  [2] TRUE-PEAK LIMITER (per sample)  →  out
```

There is nothing else. No compressor, no multiband, no clipper, no de-esser. (A multiband density stage
is a documented future seam at `:16`, *before* the limiter — not built.)

### Stage 1 — Loudness ride

| parameter | current value | where | changeable today |
|---|---|---|---|
| Target | **−14 LUFS** | `station_config_kv.proc_target_lufs` → `SetProcessing` → `bus.proc_target_lufs` → `set_target()` per buffer (`audio.rs:1976`, `:2461`) | **YES — the only adjustable parameter in the entire chain** |
| Rate | **1.5 dB/s** | `rate_db_per_s`, `:160` literal | no |
| Clamp | **±12 dB** | `clamp_db`, `:160` | no |
| Evaluation interval | **100 ms** | `eval_every`, `:161` | no |
| Meter | EBU R128 **Mode::M** (400 ms momentary) | `:158` | no |
| Duck hold | runtime, set per buffer from `duck_active` | `:212`, `audio.rs:2465` | not a setting |

How it moves: every 100 ms it computes `desired = target − in_lufs` and steps `gain_db` toward it by at
most `1.5 × 0.100 = 0.15 dB`, clamped to ±12 (`:181-186`).

### Stage 2 — True-peak limiter

As §1. Fast: attack completes inside 1.5 ms; release 120 ms.

### What each does during your overlap

Two hot masters sum. Measured on the three songs at the Bad Romance seam: `lufs_measured` **−6.2 to
−7.8**, `peak_db` **0**. Summing two of those is roughly **+3 to +6 dB**.

- **The limiter reacts instantly** and holds −1 dBTP, so it pulls the *sum* down within milliseconds.
- **The ride reacts too, and over a 5-second overlap it is not negligible.** `desired` moves by the same
  3–6 dB; at 1.5 dB/s the ride can travel **up to 7.5 dB in 5 s** and typically most of the way. Then it
  walks back up afterwards, which is the pumping.

Both act on the **whole programme**. Neither can distinguish the outgoing from the incoming. The incoming
is at full level while the outgoing is in its mastered fade-out, so the shared gain reduction lands on a
mix the incoming already dominates — and the outgoing's tail ends up further below the reduced programme
than it was before. **Nothing is stopped, no fader moves, and the outgoing is still summed at full level
(`audio.rs:2194`).** It is being masked, not removed.

## 3 · What should be adjustable, and what is dangerous

| parameter | expose? | range | the danger, stated plainly |
|---|---|---|---|
| Ride target | **yes** (already) | −30 … −6 LUFS | none beyond taste |
| Ride rate | **yes** | 0.3 … 6 dB/s | fast rates pump audibly; that is a sound, not a fault |
| Ride clamp | **yes** | 3 … 18 dB | **a large clamp on quiet material boosts the noise floor and shoves far more into the limiter.** 12 is already generous |
| Ride bypass | **yes** | on/off | none — and it is the A/B you want |
| Limiter ceiling | **yes** | −3.0 … **−0.1** dBTP | **never allow ≥ 0.** Above about −0.3 dBTP, MP3/AAC encoding for Icecast produces inter-sample overs that clip on the *listener's* decoder — audible distortion you cannot hear locally |
| Limiter release | **yes** | 30 … 500 ms | very short = bass distortion and pumping; very long = the programme stays ducked after a transient |
| Limiter bypass | **yes** | on/off | **with the limiter off nothing holds the ceiling.** The clean tap is clamped at the point of use (`audio.rs:2481-2487`) but the processed path is not — a bypassed limiter with a ride boost can clip the stream |
| Limiter look-ahead | **NO — read-only display** | — | it *is* the processing latency (`latency_samples()`), so changing it shifts local against stream. Worse: the delay lines are `vec![0.0; la]`, so changing it **reallocates on the audio thread** — the exact hot-path violation this file's own header forbids (`:6-10`, the 2026-07-10 mixer-callback wedge). If it is ever adjustable it must rebuild the limiter off-thread and swap |
| Limiter attack | **NO** | — | derived from look-ahead. Exposed separately it lets peaks through the ceiling — a control whose only effect is clipping |
| Detection headroom (×1.15) | **NO** | — | a correctness margin for true-peak estimation, not a programming decision |
| Oversampling 4× / 8 taps | **NO** | — | detection quality vs CPU. Not a sound you choose |

**Can any of this take the station off air?** Not by crashing — every proposed control is a plain scalar
field set from the settings snapshot, which is what the hot-path discipline requires. The two real
dangers are **audible, not fatal**: a ceiling near 0 dBTP distorting on listeners' decoders, and a
bypassed limiter with ride boost clipping the stream. Both should carry the warning inline, not in a doc.

**One rule for the implementation:** no adjustable parameter may resize a buffer. That is why look-ahead
is excluded from v1.

## 4 · Where the controls go

**The same shape as the Master EQ, because that shape already works here.**

Today: `MasterOutput.tsx:671-685` holds `eqBands`, loads from `station_config_kv` key `eq_master`, writes
on change *and* pushes live to the engine (`ether.audio.setEq("master", bands)`), and opens
`MasterEQRack.tsx` — a `FloatingWindow` rack with a live spectrum. It derives an **active** flag from the
values themselves: `eqActive = eqBands.some(g => Math.abs(g) > 0.05)`.

Proposal: a **PROCESSOR** button beside EQ in Master Out, opening `ProcessorRack.tsx` in the same
`FloatingWindow` chrome:

```
PROCESSOR — [ LOCAL | STREAM ]  tabs                      preset: [ Ether v1 (shipped) ▾ ]  ● modified
 ┌ LOUDNESS RIDE ───────────────────────┐  ┌ LIMITER ──────────────────────────────┐
 │ Target      −14.0 LUFS   [ slider ]  │  │ Ceiling     −1.0 dBTP   [ slider ]    │
 │ Rate         1.5 dB/s    [ slider ]  │  │ Release      120 ms     [ slider ]    │
 │ Clamp       ±12.0 dB     [ slider ]  │  │ Look-ahead   1.5 ms     (fixed)       │
 │ [x] enabled                          │  │ [x] enabled                           │
 └──────────────────────────────────────┘  └───────────────────────────────────────┘
 IN −7.2 LUFS   RIDE −4.1 dB   GR ▓▓▓▓▓▓░░ 6.2 dB (peak 9.4)   OUT −13.9 LUFS  −1.0 dBTP
```

Every field renders its current value on load — including the ones that have never been stored, which
show the shipped value and say which preset it came from (§5, §7). The Settings→Audio Processing section
keeps the two on/off toggles and gains a "Open processor…" link; it does not grow a second copy of these
controls.

## 5 · Storage

**Confirmed: `station_config_kv`, station-scoped, synced — the same treatment as `segue_overlap_sec`.**
`eq_master` already lives there, so this matches both precedents. It is not in `LOCAL_ONLY_KEYS` and must
not be: a processor setting is a decision about your sound, and it should follow the account to any
machine the PD signs in on.

Keys, with the local/stream split of §8:

```
proc_local, proc_stream                    (existing booleans)
proc_preset_active                         "ether-v1" | "<user preset name>"
proc_presets                               JSON — the operator's saved presets
proc_local_params, proc_stream_params      JSON — the live values for each branch
```

**A machine with no value yet.** It shows the **shipped chain's real numbers**, labelled as the preset
they come from — not blanks, and not silence. That is exactly what §7's first preset is for: the values
in §1 and §2 *are* "Ether v1 (shipped)", so an unconfigured station is not unconfigured — it is running a
named preset, and the panel says which.

Worth knowing: `proc_target_lufs` is stored on **station 2 only**. Stations 1 and 4 have `proc_local=1`
and `proc_stream=1` but **no target row**, so they run −14 from an unsurfaced default in
`engine.js:_applyProcessingFromKv`. That is a hidden default shaping air on two stations right now, and
this design removes it by making the shipped values a visible preset.

## 6 · Metering — GR is already there

Nothing new has to be plumbed. The chain already computes and publishes it:

- `TruePeakLimiter.gr_db` (`program_processor.rs:118`) → `gain_reduction_db()` (`:245`)
- → `bus.proc_gr_db` (`audio.rs:2472`)
- → the dedicated ~15 Hz `audio:proc-meters` event, as `grDb`
- → already rendered by `ProcessingTrio` in `SettingsPanel.tsx`

**So GR is on screen today — in Settings, not where you work.** Showing it in the processor rack is
subscribing to the same `onProcMeters` feed the Settings section already uses. Two additions worth making
while it moves:

1. **Peak-hold with a decay**, plus **max GR in the last 10 s** as a number. A seam lasts 5 seconds; a
   15 Hz needle you have to be staring at is not evidence. A held number lets you look *after* you hear it.
2. **Per-branch meters**, once §8 splits the chain — one set of numbers for two different processors would
   be a meter that lies.

One caution carried from the toggle bug fixed today: a 15 Hz feed re-renders whatever component subscribes
to it. The meters belong in their own child component so the sliders above them are not rebuilt 15 times a
second.

## 7 · Presets

**Where they live.** `station_config_kv`: `proc_presets` (JSON array of `{name, local, stream}`) and
`proc_preset_active` (the name). Built-ins ship in code and cannot be deleted or overwritten; user presets
live in the kv. Same store as `eq_master`, so nothing new is invented.

**The first preset is the current chain, captured as-is.** `"Ether v1 (shipped)"` — every value in §1 and
§2, written down rather than compiled in, so you can A/B your own settings against exactly what has been
on air. It is read-only; editing it creates a copy.

**Saving one.** "Save as…" takes the live values of *both* branches and names them. A preset is a complete
snapshot — local and stream together — because A/B-ing half a chain against the other half proves nothing.

**Switching.** Selecting a preset writes every parameter at once, sets `proc_preset_active`, and pushes to
the engine in one command. It is one action, so an A/B is one click each way.

**Saying what is actually running — the part you asked for explicitly.** The header shows the active
preset name, and compares the live parameter set against that preset's stored values on every render:

- identical → `preset: Ether v1 (shipped)`
- any parameter differs → `preset: Ether v1 (shipped) · modified` with the changed fields marked

This is the `eqActive` pattern generalised: derive the badge from the values, never from a flag someone
remembered to set. A panel that claims a preset it is not running is the defect this clause exists to
prevent.

## 8 · Local and stream are separate

### 9 · What is shared today, per parameter (answered first, as asked)

There is **ONE** `ProgramProcessor` per station on the program bus (`audio.rs:478`, constructed `:618`),
and **one** processed buffer, computed if *either* toggle is on (`:2458`):

```rust
let (proc_l, proc_r) = if bus.proc_local || bus.proc_stream { ... p.process_planar(&mut pl, &mut pr) ... }
```

Each branch then chooses that buffer or the clean one. So:

| parameter | shared between local and stream today? |
|---|---|
| Ride target (`proc_target_lufs`) | **SHARED** — one value, one `set_target()` |
| Ride gain state / rate / clamp / meter | **SHARED** — one `LoudnessRide` instance |
| Limiter ceiling / look-ahead / attack / release | **SHARED** — one `TruePeakLimiter` instance |
| Limiter gain + GR at any instant | **SHARED** — literally the same samples |
| Duck hold | **SHARED** |
| All metering (`proc_in_lufs`, `proc_gr_db`, peaks) | **SHARED** — one set of numbers |
| **Which tap the branch uses** | **INDEPENDENT** — `proc_local` / `proc_stream`, two booleans |

**Only the two on/off booleans are independent. Everything that shapes the sound is one instance.** When
both are on, your monitor and your listeners hear bit-identical processed audio.

### The split

A second instance: `processor_stream` beside the existing `processor`, each with its own parameter set,
its own ride state, its own limiter state and its own meters. `proc_l/proc_r` becomes two optional buffer
pairs, each computed only if its own branch is on.

**This is architecturally routine here — the codebase already runs three instances per station:**
`processor` (`:478`), `processor_aux` (`:567`) and `processor_room` (`:583`). A fourth is the same move.

**What a second instance costs.** Per sample, per instance, the limiter does:

- oversampling: 4 phases × 8 taps × 2 channels = **64 multiply-adds**
- look-ahead minimum: a scan of the whole `req_ring` — **66 comparisons** at 44.1 kHz (`:110-111`)

≈ 130 operations per sample → **≈ 5.7 million ops/sec per instance** at 44.1 kHz, plus the ride's ebur128
meter. A second instance roughly doubles the processing cost of a station that has both branches on.

**I have not measured it, and I am not going to guess a percentage.** The bench already exists —
`cd native && cargo test --lib program_processor::bench -- --nocapture` — and a timing run over a fixed
buffer count would give a real number before any of this is built. Two things make me want that number
rather than an estimate: this runs on the **audio callback thread**, where the cost of being wrong is a
wedge, not a slowdown; and that per-sample `req_ring` scan is an O(look-ahead) loop that a monotonic deque
would make O(1) — worth fixing *before* doubling it, not after.

## 10 · Does this actually fix the overlap? — **No. It lets you see and choose the artifact.**

You asked to be told plainly, so: **adjustable limiter controls will not make both songs audible during
the overlap.**

The arithmetic doesn't move. Two masters at −6 to −8 LUFS with 0 dBFS peaks, summed, sit several dB above
any ceiling you would be willing to set. There is no setting of ceiling, release or ratio that makes 2×
full-scale material fit under −1 dBTP without gain reduction — that is what a limiter *is*. And the ride
is measuring true loudness, so it correctly pulls down a programme that genuinely got louder. Both stages
are working exactly as designed.

What the controls genuinely buy you, and it is not nothing:

- **You can hear the artifact and prove its source** — bypass the ride, bypass the limiter, A/B a preset.
- **You can choose its character** — a slower ride pumps less across a seam; a longer release trades
  density for movement; a lower ceiling trades loudness for headroom.
- **You can stop the local monitor and the stream fighting each other** (§8), which is a real defect today.
- **You can see GR** instead of inferring it (§6).

### CORRECTION, 2026-09-06 — the catalogue is ALREADY normalized

An earlier draft of this section said the real fix was normalization, and that the files were "around −6
to −8 LUFS". **That was wrong, and it was wrong in the way that matters.** `lufs_measured` is the file's
own loudness; `gain_db` is the trim already applied per deck (`audio.rs:2192-2194`). Measured across all
443 music rows on halloVeen:

```
lufs_measured + gain_db  ·  p05 = -14.0   median = -14.0   p95 = -14.0
```

**Every song is already normalized to −14 LUFS**, and has been since import. There is no missing
normalization pass. What the decks actually put on the bus:

| | |
|---|---|
| post-trim peak per deck (`peak_db + gain_db`), median | **−6.2 dBFS** |
| p05 … p95 | −8.3 … −2.5 dBFS |
| two decks summing, incoherent (typical) | ≈ **−3.2 dBFS** |
| two decks summing, coherent (worst case) | ≈ **−0.2 dBFS** — over the −1 dBTP ceiling |

So during an overlap the programme is roughly **+3 LU** above the ride's target, not +9. The ride walks
toward −3 dB at 1.5 dB/s (about two seconds to get there), holds for the rest of the overlap, then walks
back up over the *head* of the incoming song. The limiter engages on transients, where two post-trim peaks
line up near the ceiling.

That is a smaller effect than this document originally claimed — but it is exactly the shape of what was
heard: everything ducks for the overlap, and the new song's first seconds arrive under a ride that has not
released yet.

**The remaining headroom lever is the normalization TARGET, not the existence of normalization.** Going to
a lower target (−18, say) would put two summed songs near −15 — under the ride's target — so the ride would
barely move and the limiter would rarely engage at a seam. That costs 4 dB of programme level, which the
ride then has to make back on single-song passages. It is a real trade and it is Jeff's to make.

**It is a separate piece, proposed separately** (`docs/library-normalization-2026-09-06.md`), because it
changes the level of every song on the station.

**And to be explicit about scope:** if you build §1–§9 and nothing else, the overlap will still lose the
outgoing song when processing is on. The controls are worth building; they are not a fix for the thing
that sent you here.

---

## What this document does not claim

§1, §2, §6, §8 and §9 are read from source with `file:line` and from the live `station_config_kv` values.
The per-song loudness figures are measured from `songs.lufs_measured` on halloVeen. **Everything from §3
onward is a proposal, and nothing has been built.** The CPU cost of a second instance (§8) is arithmetic on
the operation count, **not a measurement** — the bench that would settle it is named. No claim is made here
about how the proposed chain sounds; that is Jeff's ear, on a build that does not exist yet.
