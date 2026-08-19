# AUX bus — clipping/crackle fixes

**Date:** 2026-08-18 · **Report:** Jeff — the aux monitor "sounds like clipping", and separately
"September sounds ok", i.e. not uniformly broken. **Status: fixed in the tree, addon installed,
runtime UNVERIFIED — see §6.**

Context: `docs/aux-monitor-bus-design-2026-08-18.md` (the bus itself and the earlier rulings).

---

## 1 · Four causes, in the order they matter

### 1.1 · The producer sheared the waveform mid-buffer — the crackle

```rust
if prod.occupied_len() >= high { break; }   // dropped the REST of the buffer
```

Once the aux ring reached its high-water mark the mixer stopped mid-buffer and threw the remaining
samples away. That is a hard discontinuity in the waveform — a click — and it repeated for as long as
the two device clocks disagreed, which is continuously: the station device and the aux device run on
independent clocks and never agree exactly.

**Removed.** The producer's only job is now to hand over every sample it made.

### 1.2 · Clock drift is absorbed inaudibly instead of by dropping samples

Something has to absorb the difference between two independent clocks. Dropping samples does it
audibly; nudging the resample ratio does it inaudibly. The aux callback now measures ring fill against
a ~40 ms target and adjusts the resample step by at most **±0.3%** — well under the ~1% where pitch
shift becomes audible.

That is the standard monitor-bus answer, and it removes the need to discard anything.

### 1.3 · Underrun stepped to zero — itself a click

The underrun path set the next sample to `(0.0, 0.0)`, which is a hard jump to zero mid-waveform.
Silence was the right intent; a step is the wrong way to reach it. It now decays (×0.5 per sample) and
stays at silence — and it never repeats a tail, which was the other thing worth ruling out.

### 1.4 · The "safety clamp" was itself a clipper — and the real answer was already in the product

The first revision bounded the aux sum with `clamp(-1.0, 1.0)`. A hard clamp **is** a hard clipper: the
moment the sum passed full scale it produced exactly the distortion it was supposed to prevent, and it
did nothing whatsoever for quiet material.

**Jeff's correction: "this should be going through the processor that's already in preferences."**
Correct, and it matters operationally —

> *"we have disney songs with dialogue that is too quiet to hear in the park without the loudness
> limitor and processing"*

So the aux bus is not merely peak-protected, it is **processed**: the same loudness ride and −1 dBTP
limiter the operator already configures, on the same **"Process local output"** toggle and the same
target LUFS. Nothing new, no second control. The clamp is gone entirely — peak control lives in one
place.

## 2 · One system, three taps — why there is a separate instance and not a separate implementation

The aux uses `crate::program_processor::ProgramProcessor`, the existing type. It holds its **own
instance** for one reason: the processor is stateful (a loudness integrator and a limiter with
history), and the air chain has already run its instance over a different sum in the same callback.
Running one instance across two different signals corrupts its state.

This is the identical pattern already in the tree — `bus.eq` and `bus.eq_room`. One system, one set of
settings, several taps.

**Also removed at Jeff's direction** (added by me, not asked for, and duplicating capability the
product already has): the `aux_drops` / `aux_underruns` ring counters and a 1 kHz test-tone harness.
Zero references remain in `audio.rs` or `lib.rs`.

## 3 · What the aux path looks like now

```
deck D/E/F source
  → channel cut + track trim + FADER              (post-fader, post-cut — Jeff's earlier ruling)
  → × slot level                                   (the AUX slot's MONITOR control)
  → program processor: ride + −1 dBTP limiter      (Preferences → Process local output, same target)
  → aux ring                                       (no shear, no clamp)
  → aux output stream on the CHOSEN device         (±0.3% drift correction, fade on underrun)
```

Everything that can stop it still stops it: fader down, channel off, slot `(none)`, deck stopped,
OUTPUT `(none)`. That kill chain was proven separately and is unaffected by these changes
(`aux-monitor-bus-design-2026-08-18.md` §9.4).

## 4 · Files

| File | Change |
|---|---|
| `native/src/audio.rs` | producer shear removed · consumer drift correction · underrun fade · aux sum through `processor_aux` · clamp removed · counters removed |
| `native/src/lib.rs` | counter fields removed from the levels JSON |
| `native/ether-audio.node` | rebuilt and installed |

Backups on disk: `.bak-pre-def-telemetry-20260818`, `.bak-pre-auxmonitor-20260818`,
`.bak-pre-auxdevice-20260818`, `.bak-pre-postfader-20260818`, `.bak-pre-auxproc-20260818`.

## 5 · Gates

`cargo build --release` → clean. **No version bump.** Renderer untouched by this pass.

## 6 · Verification status — honest

**I have no runtime receipt that the crackle is gone.** I had built one (a 1 kHz tone plus ring drop /
underrun counters, to report artifacts per minute rather than an opinion) and removed it at Jeff's
instruction, so what remains is:

- the shearing code is gone — that defect cannot occur, by construction;
- peak control is a limiter rather than a clipper;
- neither claim has been heard.

**Jeff's ears are the test:**

1. AUX MONITORS → OUTPUT → real speakers
2. jukebox on deck D, fader up → should be clean
3. quiet-dialogue material → the ride should lift it (Preferences → *Process local output* ON)
4. fader down → silent · AUX OUTPUT `(none)` → silent

**If it still crackles**, the next suspect is the resampler itself rather than the ring — the
persistent-phase interpolation, which is linear and would show as harmonic distortion rather than
clicks. That is a different fix and worth saying before touching it, because at that point the honest
move is to measure rather than guess again.

## 7 · Outstanding, not built

The Health Monitor deck section Jeff asked for — "the original volume, processing volume and the
difference", the same as the stations have now. Deliberately not started here: it must extend the
existing processing section and its existing meters, not introduce a parallel one. Named so it is not
forgotten.
