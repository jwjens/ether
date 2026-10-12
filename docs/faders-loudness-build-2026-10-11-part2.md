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

**Proposal (for approval — changes air):** replace the short detector with an accurate BS.1770-4 (Annex 2) true-peak
detector — 4× oversampling with a 48-tap-per-phase (or longer) polyphase filter, which reads within ~0.1 dB of a full
meter — and set the margin to **1.0** (none). Effect on air: limited peaks land **at** the ceiling instead of ~0.33 dB
under it; heavily limited material is up to ~0.3 dB louder; nothing below the ceiling changes. Cost: the detector does
~6× the multiplies — measured against the CPU gate on an idle machine before it ships. Test: a battery of worst cases
(full-scale sines near fs/4 at several phases, clipped noise, real programme) — output true peak within
[ceiling − 0.1, ceiling] dB whenever the limiter acts. Until approved, the margin stays as it is.
