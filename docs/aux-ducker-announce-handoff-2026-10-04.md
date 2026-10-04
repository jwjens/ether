# Handoff: aux recovery, ducker, and announcement seconds/repeats (2026-10-04)

**Nothing committed, built, tagged or installed. No golden re-captured.** The source handoff is
`P:\ether-aux-sources-handoff-2026-10-04.md`. Full diffs are in `P:\ether-diffs-2026-10-04\`.

## Two branches (both uncommitted, both based on b4da7b5)
- **`fix/aux-monitor-recovery`** in `C:\openair`. **SHIP TONIGHT.** 14 files changed.
  `native/ether-audio.node` was already modified before this work started and has not been rebuilt.
- **`feat/announce-seconds-repeat`** in the git worktree `C:\openair-announce`. Moved off the ship branch.
  It has no `node_modules`; to run its tests, install there or run them from `C:\openair` after merging.

## Ship branch: what it fixes (each with a test)
1. **The aux stream never reopened.** `MonOut` (`native/src/audio.rs`) now runs `outwatch::StallWatch` on its
   frame counter plus the cpal error callback, then reopens the SAME device. It never falls back to another one.
   Covers the AUX and PFL cue outputs. `mon_plan` is pure. Tests: `audio::monout_tests`.
2. **A dead aux was invisible.**
   - Levels frame: `aux_device`, `aux_state`, `aux_open`, `aux_stalls`, plus `aux_routed` on each deck.
   - Meters frame: `auxState`, `auxDevice`, `auxRouted` (bitmask).
   - Health Monitor: RED after 5 s, with `aux-down` / `aux-restored` / `aux-reopened` in the ledger.
   - Strip meters: an aux-routed slot draws NOT FED with ⚠ naming the device (`meter/auxFault.ts`, `ConsoleStrip.tsx`).
   - Carts: `audiod/cart-observe.js`. A cart whose channels are all aux-routed, while the aux is down, is a
     **FAULT, never FIRING**, even when the deck has signal.
   - "No aux device chosen" is the operator's routing, not a fault. Frames from older engines change nothing.
3. **The room leveller pushed ducked music back up.** `processor_room` now gets `set_ride_hold(duck_active)`.
   - Test: `the_room_ride_does_not_turn_the_ducked_music_back_up` (+9.00 dB before the fix).
   - Measured with `measure_room_duck_hold` (ignored diagnostic): over the cart windows, post-fix is −40.97 dB
     vs pre-fix −32.50 dB, a mean **8.47 dB quieter**, reaching **12.00 dB** once the old ride hit its clamp
     at ~9 s. The golden WAV's hash matches the manifest, so "pre-fix" really is the old render.
4. **The ducker went stale after a daemon restart.** The connect handler now calls
   `armAllStationDuckers("daemon-connect", { daemon: true })`.

## Gates (ship branch)
- `tsc`: clean. vitest: **73 files, 656 tests pass.**
- Rust: **137 pass, 4 fail.** All 4 are the room output of the `music__AUXDUCK_LINKED` render (fix 3,
  expected); stream/air is still bit-exact.
- Re-capture needs a commit first (`capture_goldens` refuses dirty `native/src`) and Jeff's say-so.

## v62 (feature branch only): sync risk, proven on DB copies with the real MergeEngine
- **A 4.6.52 peer (v61) receiving from a v62 machine:** EVERY v62-stamped mutation, on every table, is
  **quarantined** (`merge-engine.js:127`). It isn't applied, and the cursor still advances. It drains when that
  peer upgrades (`sync-engine.js drainQuarantine`). So there's no loss, but sync from the v62 machine pauses at
  each old peer. **Upgrade the fleet together.** A v61-stamped payload that happens to carry the new keys is
  applied, and the keys are ignored.
- **A v62 machine receiving from a v61 peer:** inserts get the column defaults (0 s, ×1). Updates now keep local
  values: 35 s ×3 survives an old peer's minutes edit. **A defect was found and fixed here**: the first transformer
  filled in defaults, so old-peer updates reset seconds/×N to 0/×1. It is now pass-through, re-proven.

## Still open
- **Top-of-hour hard cut** (`audiod/engine.js:754`). Jeff is deciding.
- RC3/RC4 (room path and jukebox limited to D/E/F), RC5 (board save-all re-cuts), and the ducker boot race
  (the connect re-arm in fix 4 covers it).

## Install
A native change needs a **daemon** restart: quit from the tray and confirm `ether-engine.exe` has exited.
