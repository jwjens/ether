# Faders & loudness build — part 2: MONITOR silent until known, group tops, audit fixes, limiter (2026-10-11)

Follows `docs/faders-loudness-build-2026-10-11.md` (rulings 1–4, first set). Jeff's rulings of the same evening, second
set. Branch `fix/monitor-local-output`. **No version bump, not pushed, release held.**

## 2 · First-launch MONITOR: silent until the saved level is known

"The local output (main speakers and AUX) stays silent until the saved master MONITOR level is known, then applies it.
Never play the room at 0 dB as a placeholder. Air is unaffected."

- **Applier** (`audiod/board-state.js`): master MONITOR is one level per machine, so a station without its own key
  takes any station's saved value. If none is saved anywhere, it is **0 (silent)**, and the applier sends it **first**,
  before any other setting. The daemon runs this at engine start, so the room is silent from the first buffer.
- **main**: window playback starts at 0 and takes the saved level as soon as the database is open (boot step); unknown
  stays 0 and is logged ("the local output stays silent until it is set").
- **Windows** (`src/audio/localOutput.ts`): level 0 until main answers.
- **MONITOR fader**: shows the saved level; if none was ever saved, **off** (the old hidden 0.8 is gone). An old
  localStorage value is moved into the database once.
- **Air**: MONITOR never touches air (the Rust test `local_output_obeys_monitor` already proves the stream is
  bit-identical at MONITOR 0 and 1).
- **Tests:** applier: unknown → 0 sent first; known on another station → that level; known here → first. Real daemon +
  engine with no MONITOR saved anywhere → engine holds master MONITOR at 0, control and applied
  (`npm run test:board-restore`, 39/39).

## 3 · The two audit bugs

- **Duck depth:** the engine's boot default was −28 dB; everything else said −22. Now −22 in the engine, and main's duck
  fan-out reads the applier's defaults instead of its own copy. `audiod/duck-defaults.test.js` pins the engine, the
  applier, show presets, the Ducker panel and main to the same five numbers. Duck render tests 10/10.
- **In-process stream bitrate:** the fallback stream path hard-coded `-b:a 128k`. Both stream paths now take the
  station's `icecast_bitrate` through `electron/stream-args.js`. `electron/stream-args.test.js` (4).

## 4 · MASTER and MONITOR top out at unity; every group's top is a setting

"MASTER and MONITOR top out at unity (0 dB at the top of travel, same curve below). Channel faders and AUX rows keep
+10 dB at the top. The maximum for each fader group is a visible setting."

- `src/lib/faderLaw.ts`: ONE curve, slid so its top equals the group's maximum. A 0 dB-top fader reads 100% = 0 dB,
  75% = −10, 50% = −20, 35% = −30, 25% = −40, 15% = −50, 5% = −70, 0 = off. **Interpretation of "same curve below": the
  curve's shape is kept and shifted down, so each step of travel is the same number of dB as on a channel fader.** The
  unity mark moves with it (top of travel on MASTER/MONITOR).
- Settings (per station, Preferences → Loudness & fader smoothing → Fader maximum): channel +10, AUX rows +10, MASTER 0,
  MONITOR 0 (MONITOR covers the master MONITOR and each station's MONITOR strip), each 0…+10 dB, current value shown.
- Enforced: every restored level is held at or below its group's top (applier); every live setter is clamped to it
  (main). The engine's own ceiling stays +10 dB.
- **Saved levels:** gains, unchanged. Master MONITOR −6.7 dB now draws at 83.3%; station 2's MONITOR strip −2.7 dB at
  93.2%; MASTER at 0 dB at the top.

### What the limiter does when MASTER is above 0 dB (only possible if MASTER's maximum is raised)

The chain after MASTER (audio.rs): programme mix → master GEQ → **MASTER** → PGM tap → **stream processor** (loudness ride,
then the true-peak limiter) → the stream. With "Process stream" ON:
- the **limiter** holds every peak at its ceiling — fast gain reduction — so raising MASTER cannot push the stream past
  the ceiling (measured today: −1.0 set → output −1.35 dBTP, see §5);
- the **loudness ride** (1.5 dB/s, up to 12 dB) slowly pulls the overall level back toward the target, so a raised MASTER
  is loudness-corrected over seconds; it holds still while the ducker is pulling the music down.
With "Process stream" OFF there is no limiter: the clean stream is hard-clipped at full scale (±1.0) — distortion. MASTER
defaults to a 0 dB top, so this needs the operator to raise it deliberately.

## 5 · Why the limiter acts below the ceiling — measured, and the proposal (NOT built)

`native/src/program_processor.rs:20–28, :151`: the limiter compares `true_peak × DETECT_MARGIN (1.15)` with the ceiling,
i.e. it acts **1.214 dB** below the setting. **Why the margin exists:** its true-peak detector is short — 4× oversampling
with only **8 taps per phase** (`:34–35`) — and under-reads inter-sample peaks; the margin keeps a full BS.1770 true-peak
meter from reading above the ceiling.

**Measured** (the existing ceiling test, full BS.1770 true-peak meter on the output, `criterion_6`):

| Ceiling set | Output true peak | Below the setting |
|---|---|---|
| −3.0 dBTP | −3.32 | 0.32 dB |
| −1.0 dBTP | −1.35 | 0.35 dB |
| −0.1 dBTP | −0.46 / −0.42 | 0.36 / 0.32 dB |

So on real material the detector under-reads by ~0.85 dB and the 1.214 dB margin over-corrects by about **0.33 dB**: the
stream peaks ~⅓ dB below what the operator set.

**Proposal (APPROVED by Jeff 2026-10-11 and BUILT — see §5b below):** replace the short detector with an accurate BS.1770-4 (Annex 2) true-peak
detector — 4× oversampling with a 48-tap-per-phase (or longer) polyphase filter, which reads within ~0.1 dB of a full
meter — and set the margin to **1.0** (none). Effect on air: limited peaks land **at** the ceiling instead of ~0.33 dB
under it; heavily limited material is up to ~0.3 dB louder; nothing below the ceiling changes. Cost: the detector does
~6× the multiplies — measured against the CPU gate on an idle machine before it ships. Test: a battery of worst cases
(full-scale sines near fs/4 at several phases, clipped noise, real programme) — output true peak within
[ceiling − 0.1, ceiling] dB whenever the limiter acts. Until approved, the margin stays as it is.

## 1 · CPU gate A/B on an idle machine (2026-10-11, evening)

Conditions: Ether and Chrome fully quit (no ether-engine, no Ether, no Chrome processes; nothing above 1% CPU before the
runs). Previous engine = `00891e4` (165 tests), built in its own worktree and target dir; new engine = `277e750`
(169 tests). Test `audio::channel_rack_timing::channel_rack_cost_one_and_twelve_channels`, `--test-threads=1`, run
interleaved previous/new, three rounds. Gate (Jeff, 2026-09-26): p99 ≤ 1 ms and rack CPU ≤ 0.5 ms on "4 faders + 5 MICS".

**Gate row — 4 faders + 5 MICS, racks IN (ms):**

| Engine | Median r1 / r2 / r3 | p99 r1 / r2 / r3 | Rack CPU max r1 / r2 / r3 |
|---|---|---|---|
| Previous 00891e4 | 0.2241 / 0.2225 / 0.2234 | 0.3114 / 0.5670 / 0.3316 | 0.109 / 0.209 / 0.135 |
| New 277e750 | 0.2269 / 0.2274 / 0.2267 | 0.3125 / 0.3191 / 0.3109 | 0.102 / 0.105 / 0.118 |

**Both engines pass the gate in all six runs** (p99 ≤ 0.57 ms against 1 ms; rack CPU ≤ 0.21 ms against 0.5 ms).

**Other rows (median, ms):** 12 faders no racks — prev 0.0574/0.0585/0.0582, new 0.0578/0.0580/0.0590 (same).
12 faders racks steady — prev 0.1736/0.1705/0.1704, new 0.1725/0.1750/0.1737 (~+1%). 12 faders full rack all
crossfading — prev 0.3933/0.3936/0.3936, new 0.3925/0.3976/0.3930 (same).

**Reading:** on the gate row the new engine's median is consistently ~0.004 ms (≈1.6%) higher in all three rounds —
small but repeatable, so by the letter of the ruling it is measurable. Its p99 and rack CPU are equal or lower. The
likely source is the per-fader routing branch and the MONITOR/row ramp bookkeeping added per buffer (a static level
takes the old constant loop). Stopped here for Jeff's call before the Rust suite and installer.

Jeff accepted the 1.6% median difference ("p99 and rack CPU are no worse") and approved the limiter (ruling 5).

## 5b · The exact-ceiling limiter — BUILT (commit 7e218ca)

- **Detector:** the BS.1770-4 Annex 2 interpolator — 48 taps (4 phases × 12), Hann-windowed sinc, coefficient for
  coefficient the reference meter's (ebur128 `Mode::TRUE_PEAK`). Phase 0 is the real sample. `DETECT_MARGIN` = 1.0.
- **Gain path:** required gain → sliding-minimum hold (la + 13 samples) → box-average attack (la = 1.5 ms) → release
  (operator's setting). Audio delay la + 11 samples, so every sample within the interpolator's support around a peak
  leaves with exactly that peak's gain. **Latency 72 → 83 samples (1.50 → 1.73 ms at 48 kHz).**
- **Why it was short before (now fixed):** the old detector under-read (8 taps, per-phase normalised, never sampled the
  real sample), and the one-pole attack had covered only ~86% of the way when the peak left the delay.
- **Test `peaks_land_on_the_set_ceiling_within_0_1_db`** (program_processor.rs): 10 worst cases × 4 ceilings (−0.1, −1,
  −3, −6). The cases are 12 kHz sines at 4 phases, an 11.9 kHz beating sine, 997 Hz, 19 kHz, clipped noise at +6 dB,
  hot bursty programme, and isolated clicks. Output measured by the reference BS.1770 meter: **all 40 land on the ceiling
  within 0.001 dB** (requirement: [ceiling − 0.1, ceiling + 0.01]).
- **criterion_6 now:** −3.00 / −1.00 / −0.10 / −0.10 dBTP (was −3.32 / −1.35 / −0.46 / −0.42).
- **Limiter cost** (C5, one instance, 10 ms block): median 0.033 ms (0.3% of the budget).
- **On air:** limited peaks now sit at the ceiling instead of ~0.33 dB under it; heavily limited material is up to
  ~0.3 dB louder. Material under the ceiling is unchanged. The ceiling label reads "limits at" the setting (the engine
  reports margin 0).

## 1b · CPU gate with the limiter in (2026-10-12)

The gate never ran the stream processor, so two **gated** rows were added with "Process local output" and "Process
stream" ON (ride + limiter on both branches): "4 faders + 5 MICS, racks IN, PROCESSING ON" and "4 faders, racks IN,
1 crossfading, PROCESSING ON".

- **A first attempt was void:** Chrome (≈1.4 GB) was running; the *unchanged* 5-mic row read 0.51 ms median against its
  0.227 idle value. Not used.
- **The valid runs:** Ether closed; one idle Chrome window left (0.3% of a core). The unchanged 5-mic row read
  0.2225 ms median in all three runs, matching the idle baseline, so the machine was quiet.

| Row (ms) | Median r1/r2/r3 | p99 r1/r2/r3 | Rack CPU max r1/r2/r3 |
|---|---|---|---|
| 4 faders + 5 MICS | 0.2225 / 0.2222 / 0.2225 | 0.370 / 0.377 / 0.446 | 0.163 / 0.177 / 0.202 |
| 4 faders + 5 MICS, PROCESSING ON | 0.3169 / 0.3216 / 0.3174 | 0.559 / **0.992** / 0.544 | 0.116 / 0.300 / 0.172 |
| 4 faders, 1 crossfading, PROCESSING ON | 0.1684 / 0.1685 / 0.1681 | 0.387 / 0.393 / 0.392 | 0.090 / 0.110 / 0.096 |
| (a) 4 faders steady | 0.0701 / 0.0713 / 0.0719 | 0.157 / 0.132 / 0.208 | 0.108 / 0.074 / 0.102 |
| (b) 4 faders, 1 crossfading | 0.0750 / 0.0759 / 0.0747 | 0.150 / 0.158 / 0.163 | 0.094 / 0.089 / 0.085 |

**PASS in all three runs.** Processing ON adds ~0.095 ms to the median. **Thin margin:** the 5-mic processing-ON row's
p99 reached 0.992 ms in run 2, 0.008 ms under the gate; the other runs were 0.56 and 0.54. That row has never been
measured with the old limiter, so this is not a measured regression. But it is the closest the gate has come.

## 6 · Full Rust suite, single-threaded (2026-10-12, at 7e218ca)

- Pass 1 (`--release -j 1 -- --test-threads=1 --skip bench --skip timing`): **149 passed, 5 failed, 4 ignored**.
- Pass 2 (bench + timing): **12/12**. Doc tests: **2/2**.

**The 5 failures are the parity goldens and the AUX single-pass checksum.** These are bit-exact records of the old sound,
and both of tonight's approved air changes move them. Proven, not inferred:

| Failure | Cause | Proof |
|---|---|---|
| `null_vs_golden`, `rack_path_…`, `channel_racks_present_…`, `link_tap_attached_…`: renders `music__AUXDUCK_LINKED` / `music__AUXDUCK_OFF` (monitor + stream, Δmax 0.031; aux exact) | Engine duck-depth boot default −28 → −22 dB (277e750, ruling 3). These renders set no depth, so they take the engine default. | At 277e750 the same 4 tests fail on exactly these 4 taps. With only that default put back to −28 (throwaway worktree), **14/14 parity + AUX tests pass**. |
| The same 4 tests, every processing-ON tap; `aux_monitor_single_pass_regression` checksum | The exact-ceiling limiter (7e218ca, ruling 5) | Unprocessed taps still null bit-exact. The AUX checksum passes at 277e750. 7e218ca changes no mixer code (audio.rs: only the two gate rows), so no second limiter pass. |

**Not re-captured.** offline_render.rs: "Capture goldens (only on Jeff's say-so — goldens are the contract every later
change is held to)." If Jeff says so, the procedure is:
1. `ETHER_GOLDEN_RECAPTURE=1 cargo test --release --lib offline_render::parity::capture_goldens -- --ignored --nocapture`
   at the final commit. This archives the 6bd33e6/cd8862d manifest as `manifest-<commit>.json`.
2. Set `GOLDEN_AUX_SINGLE_PASS` to the new value (`13288168936620410458` = `0xb8690f3e7ea3c65a`, as the failing assertion printed it).

## 7 · Build

Engine `native/ether-audio.node` rebuilt from 7e218ca: sha256 **7598aef6be66488d5120688d8a4f67bbdb582965a87999227908a4925225658c**
(6,146,048 bytes).
