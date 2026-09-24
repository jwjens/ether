# DSP parity harness — Stage 2a PROPOSAL

**Date:** 2026-09-23 · **Branch:** `log-reader-flip` @ `b72b8ef` · **Status:** GO given 2026-09-23 — building.
**Governing docs:** `docs/dsp-inventory.md` §2 (where the stage sits, what "same audio" means) and §8.3
(smallest change). `docs/strata-to-ethercast-build-spec.md` (the whole spec, transcribed from Jeff's PDF; §4 slice 1 governs this stage).
It has been checked against this proposal; §0 below records the results.

---

## 0 · Checked against the build spec (`docs/strata-to-ethercast-build-spec.md`)

| Spec says | This proposal | Status |
|---|---|---|
| Slice 1: "Run the engine headless over fixed test files (speech, music, silence, **sweeps**, −1 dBFS intersample test)" | The first draft had no sweep. | **Amended:** signal 6 = log sine sweep (§4). |
| Slice 1 null: "output minus golden below **−120 dBFS** (or bit-exact)" | ≤ 1e-6 max abs sample difference | **Same bar.** −120 dBFS = 10^(−120/20) = 1e-6 of full scale. The report states both numbers. |
| Slice 1 target: "the current **'Ether v1'** chain" | Goldens from `b72b8ef`, processor at the shipped params (−14 / −1 dBTP / 120 ms / 1.5 dB/s / ±12, `audio.rs:695-705`) | Match. The manifest labels this config set "Ether v1". |
| **Build order: slice 0 (RT-safe callback) BEFORE slice 1 (harness)** | Harness first, goldens from the current code | **Order differs from the spec's table**, but it follows the spec's own rule 2 ("Every change is proven against a golden render") and your Stage 2a brief ("capture goldens from the CURRENT code before any callback change"). Slice 0 *is* a callback change, so without goldens it could not be proven. **RULED (Jeff, 2026-09-23): harness first. The spec §4 is amended so the harness is slice 0 and the RT-safe callback is slice 1.** |
| Slice 4: "Move existing master GEQ, ride and limiter into master slots with no DSP change. **Parity harness still nulls**" | The first draft ran with the EQ flat only. A flat EQ skips the filters entirely (`eq.rs:234`, `active` false), so the harness would not police the GEQ move. | **Amended:** optional `eq_bands` in cfg, plus config 6 **EQ** (§4). |
| Slice 7: "Cold restart restores identical state (**harness nulls**)" | Needs the harness to accept a full station config | Out of scope for 2a. `RenderCfg` is additive, so slice 7 extends it. |
| Slice 8: "stream meters match monitor meters" | The LINKED ⇒ identical-taps test is the sample-level form of this | Covered at the sample level; meters are slice 2/3. |
| Rule 1: "No new DSP until the callback is safe" | The harness adds **no DSP** to the live callback and does not change it | Compliant. |
| Real-time rules (Bencina) | The harness runs on its own thread, never on an audio thread | Compliant. The harness itself allocates freely; it is not the RT path. |

---

## 1 · What it is

An offline renderer that drives the **real** `mixer_callback` with no audio device, faster than
realtime, and captures the two taps §2 of the inventory named:

| Tap | Where in the live chain | Why here |
|---|---|---|
| **monitor** | `dl/dr` (`audio.rs:2783`), the buffer about to be written to the device | Taken before the monitor gains (`mvol`) and before resampling (`:2893-2923`), so a knob or a sound card's rate cannot make a difference appear. |
| **stream** | what the ring push sends (`audio.rs:2717-2718`), i.e. what ffmpeg receives | This is exactly the encoder input. |

Out of scope, by construction (§8.3 of the inventory): the broadcast delay (drain thread; off),
device resampling, ffmpeg/encoder colouration, `try_lock` misses (they cannot happen single-threaded),
the ducker (no source channel armed), and the aux/room chain (no aux deck loaded).

## 2 · How it taps `dl/dr` WITHOUT changing the callback

**The callback is not modified.** Capturing the goldens "from the CURRENT code" is only honest if the
code under test is byte-for-byte the code that airs. So the harness gets the pre-`mvol` tap from the
device buffer, by pinning the conditions under which that buffer *is* `dl/dr` exactly:

- **Device rate = `PROGRAM_RATE` (44 100).** `BusState::new(…, 44100, …)`, so `prog_frames ==
  device_frames` and the no-resample branch runs (`audio.rs:2287-2288`, `:2894-2902`).
- **`ch = 2`**, so `data[2f] = dl[f]·mvol` and `data[2f+1] = dr[f]·mvol` (`:2896-2898`).
- **`monitor_vol = master_monitor_vol = 1.0`**, so `mvol = 1.0·1.0 = 1.0` exactly (`:2893`). IEEE-754
  multiplication by exactly 1.0 returns the operand bit-for-bit, so `data` **is** `dl/dr`.

The stream tap is the program-bus ring. `stream_connected = true` enables the push (`:2703`), and the
harness keeps the consumer (the existing tests drop it with `_cons`, `:1142`).

## 3 · The code (one new module, three one-word visibility changes)

**`native/src/offline_render.rs` (new):**
```rust
pub struct RenderCfg {            // parsed from cfg_json; absent fields = the shipped defaults (BusState::new)
    pub proc_local: bool, pub proc_stream: bool, pub proc_split: bool,
    // LOCAL params (the linked set)
    pub target_lufs: f32, pub ceiling_dbtp: f32, pub release_ms: f32, pub ride_rate: f32, pub ride_clamp: f32,
    // STREAM params — used ONLY when proc_split; otherwise mirrored from LOCAL exactly as the daemon does
    pub stream_target_lufs: Option<f32>, /* … ceiling, release, rate, clamp … */
    pub master_vol: f32,          // bus.master_vol (clamped 0..1 as SetMasterVolume does)
    pub gain_db: f32,             // decks[0].gain_db — the per-track trim
    pub eq_bands: Option<[f32; 10]>, // master GEQ (dB per band); None = flat. Applied to bus.eq via set_bands,
                                     // exactly as SetEq does (audio.rs:2084-2096); eq_room mirrored the same way
}
pub fn render_offline(path: &str, cfg: &RenderCfg) -> Result<(Vec<f32>, Vec<f32>), String>
```
- **Build.** Build the bus: `HeapRb::<f32>::new(PROGRAM_BUS_BUF)`, keeping both halves. Then
  `BusState::new(new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)))`. Set the
  fields from `cfg`, using the **same clamps** the command arms apply (`audio.rs:2119-2149`, `:2103`),
  so a cfg can't reach a state the product can't.
- **Split mirroring.** Mirror the split exactly as `_applyProcessingFromKv` does
  (`audiod/engine.js:296-336`): with split off, the stream params = the local params.
- **Load the file.** `decks[0].source = build_source(path, 44100)` (the product's own decoder).
  `active = true`, `paused = false`, `volume = 1.0`, `gain_db = cfg.gain_db`.
- **Loop.** Allocate `data = [0f32; 480*2]` and call `mixer_callback(&mut data, 2, &bus, &fin,
  &playing)`. After **every** call:
  - append `data` → the monitor tap;
  - drain `cons` fully → the stream tap. Draining every call keeps the 4 s ring from ever filling, so
    the drop-on-full at `:2717` cannot fire.
- **Stop.** When `fin.take("A")`, render **10 more buffers** (100 ms). That is more than the limiter
  look-ahead (66 samples, `program_processor.rs:116`), so the delayed tail is flushed.
- **Sanity checks.** Assert the two taps have equal length. Assert the render produced something.
  Fail rather than return an empty WAV.
- **`write_wav_f32(path, &[f32])`.** A minimal hand-written RIFF / `WAVE_FORMAT_IEEE_FLOAT` (3), 2 ch,
  44 100 Hz writer, about 30 lines. **No new crate.** The samples are written bit-exact, so a WAV
  round-trip can't blur a null test.

**`native/src/lib.rs`:**
```rust
#[napi] pub fn audio_render_offline(path: String, cfg_json: String, out_dir: String) -> String
```
- Writes `out_dir/monitor.wav` and `out_dir/stream.wav`.
- Returns JSON: `{frames, monitor_hash, stream_hash, monitor_peak, stream_peak, cfg}`, or
  `{error}`.
- Never touches `ENGINES`, never opens a device, never starts a thread. So it cannot disturb a station
  running in the same process. It is still a **diagnostic entry point**, like `audio_bench_processor`
  (`lib.rs:395-403`).
- The hash is over the raw f32 bits. SHA-256 is a hand-rolled ~60 lines, or FNV-1a 64 as the Rust
  goldens already use (`audio.rs:1134-1138`). **Recommend FNV-1a**: already in the tree, no crate, and
  it is only an identity check.

**`native/src/audio.rs`: three visibility words, zero behaviour change.**
- `fn mixer_callback` → `pub(crate) fn mixer_callback` (`:2268`)
- `const PROGRAM_BUS_BUF` → `pub(crate) const` (`:1525`)
- `fn build_source` → `pub(crate) fn` (`:2212`)

The existing goldens (`GOLDEN_7_SLOT`, `GOLDEN_ROOM`,
`GOLDEN_AUX_SINGLE_PASS`) prove the callback's output did not move.

## 4 · Corpus

| # | Signal | Source | Why |
|---|---|---|---|
| 1 | Music | **Jeff to name a file** (see §8 Q2) | real programme: ride + limiter both working |
| 2 | Speech | **Jeff to name a file** | dynamic, quiet: the ride's hardest case |
| 3 | Silence, 10 s | generated | below the −70 LUFS gate: the ride must not move; output must be exact zeros |
| 4 | 1 kHz sine, −18 dBFS, 10 s | generated | steady-state gain: ride converges to target − (−18 dBFS ≈ −21 LUFS); limiter idle |
| 5 | Intersample-peak test, 10 s | generated: sine at fs/4 with 45° phase, sample peak −1 dBFS → **true peak ≈ +2 dBTP** | the samples never exceed −1 dBFS, but the waveform between them does. Clean tap passes it through; limiter must catch it |
| 6 | Log sine sweep, 20 Hz → 20 kHz, −18 dBFS, 10 s | generated | the spec's "sweeps". It exercises the GEQ across the band (config 6) and becomes the reference input for slice 5's "−3 dB at 100 Hz, 24 dB/oct" |

- **Generated signals go through the real decoder.** Signals 3–5 are written as 16-bit PCM WAV and fed
  through `build_source` like any file, so the decoder path is exercised for them too. They are fully
  regenerable from their definition. Signal 5 is 16-bit PCM, not float, because that is what a real
  library holds.
- **Configurations**, 5 per signal:
  1. **OFF**: both toggles off.
  2. **LOCAL**: `proc_local` only.
  3. **STREAM**: `proc_stream` only.
  4. **LINKED**: both on, split off.
  5. **SPLIT**: both on, split on, stream target −16 and ceiling −2.0, so it differs.
  6. **EQ**: LINKED plus a non-flat master GEQ (+4 dB at 63 Hz, −3 dB at 1 kHz, +2 dB at 8 kHz). This
     polices the spec's slice-4 GEQ move. It uses the EQ's own ±1.5 clamp as shipped
     (inventory §0.f item 8).

  All run with `gain_db = 0` and `master_vol = 1`. That is 6 signals × 6 configs = **36 renders, 72
  taps**, plus one trim render (music, OFF, `gain_db = −6`) so the per-track trim is inside the golden.

## 5 · Goldens

**Capture.** Goldens are captured by the harness from the **current code** (`b72b8ef` + the three
visibility words). This happens before any callback change, which is the point: every later rack or RT
fix must null against them or explain why not.

**Where.** `native/goldens/`:
- **`manifest.json` (committed)**:
  - golden commit hash, rustc version, `.node` hash;
  - per input: file name, **input file hash** (so a golden is tied to the exact bytes it came from),
    and generator parameters for the synthetic ones;
  - per render: cfg, frames, per-tap FNV hash, peak, and integrated LUFS (ebur128 `Mode::I`, for a
    human to read).
- **The WAVs**: see §8 Q1. Size is the problem. 10 s × 44 100 × 2 × 4 B = 3.5 MB per tap; 60 synthetic taps
  (signals 3–6 × 6 configs, plus the trim render) come to ~210 MB, and full songs add ~60 MB each per tap.

## 6 · The tests (`cargo test --lib offline_render`)

| Test | Assertion |
|---|---|
| **null vs golden** | for every render: max abs sample diff ≤ 1e-6 per tap. Report **bit-exact** separately (FNV equal). A length mismatch is a failure. |
| **linked ⇒ identical** | LINKED: monitor tap == stream tap, bit-exact, on every signal. This is C7 at the mixer level, through the real callback. |
| **split ⇒ different** | SPLIT: the taps differ on signals 1, 2, 4, 5 and 6. **Signal 3 (silence) is exempt**: zeros in, zeros out, whatever the params. Asserting a difference there would be asserting a bug. |
| **OFF ⇒ identical** | OFF: monitor == stream, bit-exact. Both are the clean `out` clamped ±1 (inventory §2 table row 1). |
| **deterministic** | every render twice, in the same process and in a fresh process via the NAPI → FNV equal on both taps. |
| **not decorative** | LOCAL/STREAM on signal 5: the processed tap's true peak ≤ ceiling + 0.3 dB (C6's slack), and the clean tap's true peak > ceiling. Proves the processor is really in the rendered path and the harness isn't comparing clean to clean. |

**What the goldens can and can't prove.** They are self-referential: they prove *later* code matches
*today's* code. They do not prove today's code is correct. Correctness stays with C1–C7 and the
"not decorative" check above.

## 7 · Gates, and what I'll run

1. **`cargo test --lib`**: the existing Rust tests (goldens, duck, bench C1–C7) plus the new
   `offline_render` tests. New **`npm run test:rust`** = `cd native && cargo test --lib -- --nocapture`
   (the only change outside `native/src`, as you asked).
   - ⚠ Bench C5 gates on a median block time and can flake on a loaded box (`program_processor.rs:640-645`).
     If it fails I'll report it verbatim rather than retry until green.
2. **Smokes: the no-audio set.** `smoke-xfade-contract`, `-seam-stop`, `-dead-air`, `-deck-position`,
   `-deck-identity`, `-deck-snapshot`, `-manual-mode`, `-autopost-arm`, `-enginestate(-wire)`,
   `-autofit`, `-queue-classes`, `-topofhour`, `-logreader-anchor`, `-meter-contract`, `-cmd-routing`,
   `-orphan`, `-shutdown`, `accept-unixsocket`, `accept-fallback`. Plus `npm test` (vitest) and
   `npm run check:audio-isolation`.
3. **`npx tsc --noEmit`**: nothing TS changes, so this is a no-change confirmation.
4. **Rebuild** with `cd native && cargo build --release`, then copy `target/release/ether_audio.dll` →
   `native/ether-audio.node` (same steps as CI, `.github/workflows/build.yml:187-191`). The old one is
   kept as `ether-audio.node.bak-pre-parity-20260923`, following the existing pattern. Report the new
   `.node`'s SHA-256, size and timestamp, and run the NAPI render against **that** file to prove the
   harness works on the built artifact.
5. **Local commit(s)** on `log-reader-flip`. No push, no tag, no version bump (no installer is built
   in this stage).

## 8 · Decisions (RULED by Jeff, 2026-09-23, with GO)

1. Goldens: commit `manifest.json` only. The WAVs are gitignored under `native/goldens/`. No LFS.
2. Music and speech: one music track and one voice/announcement file from this box's catalogue,
   lossless or high-bitrate, copied to `native/goldens/inputs/` (gitignored), with hashes in the manifest.
3. `.node`: rebuild and record the hash; leave the tracked binary alone.
4. Smokes: the no-audio set only.
5. Build order: harness first, then the RT-safe callback. The spec §4 slices are swapped.

The questions as originally asked:


- **Q1. Where do the golden WAVs live?**
  - **(A, recommended)** Commit only `manifest.json` (per-tap hashes, commit hash and input hashes).
    Keep the WAVs in `native/goldens/` but **gitignored**. The null test runs where the WAVs exist; the
    hash check runs anywhere; any machine regenerates them from the recorded commit.
  - (B) Commit the WAVs: ~210 MB for the synthetic set, several hundred MB with music.
  - (C) git LFS: new infrastructure on a repo that has none.
- **Q2. The music and speech files.** Which two library files should I use? Under (A) they are never
  committed; the manifest records their hash. Their licence matters only if you pick (B).
- **Q3. Commit the rebuilt `ether-audio.node`?** It is a tracked file, and CI rebuilds it on every tag
  anyway (`build.yml:187-191`).
  - (Recommended) **don't commit it.** Record its hash in the manifest and the report, and leave the
    tracked binary as it is.
  - Or commit it, as earlier addon changes did.
- **Q4. The off-air smokes** (`smoke-test`, `-automation`, `-playlog`, `-stream`, `accept-offair`,
  `accept-detach`, `scripts/test-segue-overlap.js`, `test-fader-invariant.js`) play real audio through
  this machine's sound card and need `--i-am-off-air`. Run them or skip them? I won't run them without
  your yes. This box isn't airing, but that's your call.
- **Q5. Build order.** The spec's table puts slice 0 (RT-safe callback) before slice 1 (harness).
  Your brief and the spec's rule 2 put the harness first (§0). I recommend harness first. Confirm.

## What this deliberately does NOT build
- No product surface: no IPC handler, no UI, no daemon command. The NAPI export is reachable only from
  a node script.
- No change to what `mixer_callback` computes. The RT fixes (inventory §6) come later and are exactly
  what these goldens will police.
- No room/aux/ducker coverage in v1 of the corpus. Those paths are pinned by the existing Rust goldens
  (`GOLDEN_ROOM`, `GOLDEN_AUX_SINGLE_PASS`, `duck_regression`). The master GEQ **is** covered (config 6).
  Adding the rest to `RenderCfg` is a later, additive change. Slice 7's full-station recall is the
  natural point to do it.

---

## 9 · Build report (2026-09-23)

**Commits (local, `log-reader-flip`, not pushed, no tag, no installer):**
- `7796a0e` docs: inventory, this doc, spec (§4 slices 0/1 swapped)
- `6bd33e6` harness code: `native/src/offline_render.rs`, the `audio_render_offline` NAPI export, the three
  `pub(crate)` words in `audio.rs`, `npm run test:rust`, `scripts/diag-render-offline.js`, `.gitignore`
- this commit: `native/goldens/manifest.json` (captured at `6bd33e6`, clean `native/src`) plus this report

### Corpus (WAVs gitignored in `native/goldens/inputs/`; FNV in the manifest, SHA-256 here)
| Signal | Source | Format | SHA-256 |
|---|---|---|---|
| music | catalogue `Heads Will Roll - A-Trak Remix - Yeah Yeah Yeahs.wav` | 32-bit float, 48 kHz, 163 s (the decoder resamples it to 44.1k) | `a5ea9bd3bfd219863cbcbe7749acff57d9d8d75123eaaf00a6dfb0ac6358f833` |
| speech | catalogue `GC Sponsorship EnglishVersion 15 Secs.wav` | 16-bit, 48 kHz, 15 s | `30fda71b18a1a56f4c4d599a9e7de8c31a660d811041e75b97fed892aaad4785` |
| silence, tone_1k_m18, isp_m1, sweep_20_20k_m18 | generated by the tests (deterministic) | 16-bit, 44.1 kHz, 10 s | FNV in the manifest |

The "speech" file is a produced voice read with a flat level envelope; it is not dry speech. Its 100 ms
RMS stays within about −12 to −20 dB until the tail. The catalogue has no dry-speech file. Treat it as
"announcement", and add a dry voice file when one exists.

### Null results: 37 renders × 2 taps = 74/74 bit-exact (max Δ 0.000, bar 1e-6 = −120 dBFS)
Every cell below is **bit-exact** (max abs difference 0.000e0 against the golden WAV).

| Signal | frames | OFF | LOCAL | STREAM | LINKED | SPLIT | EQ | OFF −6 dB trim |
|---|---|---|---|---|---|---|---|---|
| music | 7 193 280 | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ |
| speech | 670 080 | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | — |
| silence | 445 920 | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | — |
| tone_1k_m18 | 445 920 | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | — |
| isp_m1 | 445 920 | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | — |
| sweep_20_20k_m18 | 445 920 | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | ✓/✓ | — |

(✓/✓ = monitor tap / stream tap.)

**What this null proves, and what it does not.** The goldens were written by the capture process, and
the null ran in a separate `cargo test` process, so the result is a cross-process reproduction. It is
**not** yet a regression result, because no DSP has changed since the capture. It becomes one at slice 1
(the RT-safe callback), which must hold these 74 taps.

### Linked vs split
- **LINKED, OFF, EQ and the trim render: monitor == stream, bit-exact on every signal.** The SPLIT monitor
  tap is also the same bits as LINKED's (e.g. music `c4f6d030c2836a10`), as it should be, since the
  local branch is unchanged.
- **SPLIT: the taps differ on every non-silent signal.** Max Δ monitor vs stream: music 0.133, speech
  0.153, tone 0.041, isp 0.060, sweep 0.046. Silence renders exact zeros on both taps (exempt, as
  designed).
- Hash structure matches the design. LOCAL's monitor = LINKED's monitor; STREAM's stream = LINKED's
  stream. The fresh instances are identical, which is C7 reproduced through the real callback.

### Processor provably in the rendered path (isp_m1)
| Render | Tap | True peak | Ceiling |
|---|---|---|---|
| OFF | stream (clean) | **+2.11 dBTP** | none |
| LOCAL | monitor | −1.33 dBTP | −1.0 |
| STREAM | stream | −1.33 dBTP | −1.0 |
| SPLIT | stream | −2.13 dBTP | −2.0 |

The −1.33 against a −1.0 ceiling is the ×1.15 detection headroom (inventory §3.2) doing what it says.

### Determinism
1. **In-process:** `deterministic_two_runs` re-renders all 37 from scratch; every monitor/stream hash is
   equal to the first run.
2. **Cross-process:** the capture process wrote the goldens and a separate test process nulled them, 74/74
   bit-exact.
3. **Cross-build, fresh processes:** `node scripts/diag-render-offline.js native/target/release/ether-audio.node`
   was run **twice, in two fresh node processes**, against the release cdylib (not the test binary).
   Both runs: **37/37 renders bit-exact to the manifest.** A render takes 0.2–0.6 s for the 10–15 s
   signals and 3–5.5 s for the 163 s music track, i.e. about 30–50× realtime through NAPI.

### The rebuilt `.node` (NOT copied over the tracked binary — ruling 3)
- Path: `native/target/release/ether-audio.node` (a copy of `ether_audio.dll`; `target/` is gitignored)
- SHA-256 `b2912fb4e96c282f71dfa186d487cf97a0540b43ba9fa9a83431a383a7480fed`, 4 398 592 bytes, built
  2026-09-23 21:53:45 −0700 from `6bd33e6`
- Tracked `native/ether-audio.node` is untouched: SHA-256 `4876be7964cd7a8239c8c845cf7fd6981515ad656878702e6a5c896f66f4aa8c`

### Gates
| Gate | Result |
|---|---|
| `npm run test:rust` (release) | **22 passed, 0 failed, 1 ignored** (`capture_goldens`, explicit only). All 16 pre-existing tests pass, including `GOLDEN_7_SLOT`, `GOLDEN_ROOM` and `GOLDEN_AUX_SINGLE_PASS`, so the three `pub(crate)` words changed nothing. C5 did not flake. |
| No-audio smokes (19) | 18 pass. **`smoke-topofhour` FAILS**: `fillFromHour(@7:00) returned 0 item(s)`. This is **pre-existing**: `git diff b72b8ef HEAD -- audiod/ electron/ src/` is empty. The smoke was last touched in 4929e62 (2026-06-12) and `loggen.js` in 928f48e (2026-09-15). Not investigated (out of scope). |
| `smoke-logreader-anchor` (electron-as-node) | 18 passed |
| `accept-unixsocket` | skipped on Windows by design |
| `npx vitest run` | 32 files, 430 tests passed |
| `npm run check:audio-isolation` | passed |
| `npx tsc --noEmit` | 0 errors (no TS changed) |

### Architecture Compliance
- **Spec §4 rule 1 (no new DSP until the callback is safe):** no DSP was added and the callback is
  unchanged. The audio.rs diff is three visibility words (`git show 6bd33e6 -- native/src/audio.rs`).
- **Rule 2 (every change proven against a golden):** the goldens now exist at `6bd33e6`, and slice 1 is
  held to them.
- **Inventory §2 (where the taps are):** monitor = `dl/dr` pre-`mvol`/pre-resample; stream = the ring
  push. The equality argument is in §2 of this doc.
- **No product surface.** No IPC, UI or daemon change (`git diff b72b8ef HEAD -- audiod/ electron/ src/`
  is empty). The NAPI export touches no `ENGINES` and opens no device.
- **Temporary tooling:** none created. No watcher, poller or scheduled task.
