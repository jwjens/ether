# Faders show the engine, generic faders, one loudness, one fader law — build report (2026-10-11)

Jeff's rulings 1–4 (2026-10-11), built on `fix/monitor-local-output`. **No version bump, nothing pushed, release
held.** The installer is NOT built yet: Jeff asked to see station 2's final restored levels first (below).
Background: `docs/fader-kind-loudness-taper-2026-10-11.md`, `docs/board-state-on-connect-diagnosis-2026-10-11.md`.
Audit (ruling 5): `docs/audio-numbers-audit-2026-10-11.md`.
Engine (native) sha256 for this build: `0c3c5c949fbe4d208fa7d4fefc4633f35972510c539d78fd3bd208def37af5c8`.

## Station 2 — the final restored level of every fader (read-only, from the DB now)

`board_levels` for station 2 is now `{"A":1}` (written 20:58Z today). The old B 0.0013 / C 0 / E 0.153 were **overwritten
by the current CI build** — after its restart the blade's mirror was empty, so the first fader move saved a map
holding only A. (This build fixes that: the restore fills the mirror with every fader before anything can save it.)
So **B and C are already 0 dB — no write to the database is needed** for the ruling, and E is 0 dB too.

| Fader | Restored level | ON | Local output | Ducks music | Ducked by others | Local row |
|---|---|---|---|---|---|---|
| A | 0.0 dB | — | MAIN | off | on | — |
| B | 0.0 dB | — | MAIN | off | on | — |
| C | 0.0 dB | — | MAIN | off | on | — |
| D (announcements) | 0.0 dB (not saved) | on | AUX | **on** | off | −1.7 dB |
| E (sweepers) | 0.0 dB (not saved) | on | AUX | **on** | off | −5.5 dB |
| F (link) | 0.0 dB (not saved) | on | AUX | off | off | −4.4 dB |
| G (carts) | 0.0 dB (not saved) | on | AUX | **on** | off | −3.7 dB |
| MASTER | 0.0 dB (not saved) | | | | | |
| Station 2 MONITOR strip | −2.7 dB | | | | | |
| Master MONITOR | 0.0 dB until the window moves the saved −6.7 dB into the database (see below) | | | | | |
| Fader smoothing | 20 ms | | | | | |
| Loudness target | −16 LUFS | | | | | |

The routing columns are exactly how the engine behaves today; the one-time migration writes them into each fader's
own settings so **nothing changes on air or in the room at the update**.

**One known first-start effect:** the master MONITOR level has only ever been saved in a window's localStorage. The
first time the new build opens, the engine starts the room at MONITOR 0 dB until the Master Out panel loads and moves
the saved value (−6.7 dB) into the database — a few seconds, room only, never air. From then on it is restored at engine
start like everything else.

## What changed

**1 · The faders show what the engine applies.** After every restore the daemon reads the engine's own fader values
back (`getBoardState`) and puts them in the board's mirror (`ShowBlade.mirrorEngine`), so each fader is drawn at the
level the engine is running.

**2 · Faders are generic.** Three settings on every fader, on the strip (MAIN/AUX, DUCKS, DUCKED) and in the Ducker
section:
- engine: `Params.local_aux` + `duck_enabled` + `duck_duckable` decide everything, on every fader; the mixer no longer
  reads a type or a position. Boot defaults are today's layout. Removed every refusal by position: AUX/local row
  (`SetAuxMonitor`, `show::set_room`), mic input, Link input. New commands `SetLocalOutput`, `SetFaderSmoothing`.
- storage: `deck_configs.duck` / `duckable` (now read the same way for every fader) + kv `fader_local`. A one-time
  migration per station (`audiod/board-state.js routingMigration`, run at app start through the sync-aware writers)
  writes today's effective behaviour in; until it runs, the applier reads the effective behaviour, so the order of
  daemon-restore vs migration cannot move anything.
- `armAllStationDuckers` now uses the same reading (it used to send the raw `duckable`, which under the generic mixer
  would have started ducking every source fader).
- AUX monitors lists the faders whose local output is AUX.

**3 · One loudness for every source.** `audiod/loudness.js`: every file loaded on any fader — through the daemon's three
load paths and main's three in-process ones — gets gain = the station's `loudness_target_lufs` − the file's measured
integrated loudness (ffmpeg ebur128). Measured once per file content (sha256), in a background worker at low priority,
on import and as a backfill 30 s after the daemon starts; cached in `loudness-cache.json` beside the database, shared by
the daemon and main. A per-item gain is ignored (`songs.gain_db` is no longer used). A file not yet measured plays at
0 dB trim and raises a yellow `loudness-unmeasured-skipped`; one outside the engine's trim range (−20…+12 dB) raises
`loudness-gain-limited-skipped`. Setting: Preferences → Loudness & fader smoothing.

**4 · One console fader law** (`src/lib/faderLaw.ts`) on every fader — channel faders, MASTER, MONITOR, station MONITOR
strips, AUX rows, MixerChannelStrip: 100% +10 dB, 75% 0 dB, 50% −10, 35% −20, 25% −30, 15% −40, 5% −60, 0% off,
straight in dB between points (below 5%: −60 → −90 → off). dB marks and a dB readout on every fader. Stores hold GAIN,
so nothing saved changes level. Engine clamps raised to +10 dB (MASTER, master MONITOR, applier). **Smoothing** on every
level: faders and MASTER already ramped; MONITOR and the AUX/room rows now ramp too; the time is the setting
`fader_smoothing_ms` (20 ms default). At rest every stage takes its old constant-gain arithmetic (bit-identical).

**MASTER above unity:** the ruling puts MASTER on the same law, so MASTER can now reach +10 dB on air. Above unity the
programme can exceed full scale ahead of the stream limiter (with processing off, the clean tap clamps at ±1). Nothing
raises it but the operator's hand.

## Gates

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `vitest` (full) | **93 files, 827/827** — new: fader law (6, incl. station-2 migration keeps every gain), loudness (9), routing + migration (4 more in board-state) |
| Real daemon + new engine, no app, start + restart (`npm run test:board-restore`) | **36/36** — levels, cuts, local output, ducks/ducked, rows, MONITOR, smoothing, loudness measurer |
| show presets smoke | 52/52 |
| CI guards (window/station, copy-on-import, catalogue, sign filter, **station-identity leak guard** (back at baseline 13 after moving the new events to station UUIDs), audio statics, local playback) | all PASS |
| Rust, single-threaded, pass 1 (everything but bench/timing), on the final engine | **154 passed, 0 failed, 4 ignored** (169 with the 11 bench/timing) |
| Rust bench/timing gate (Jeff's ruling 2026-09-26: p99 ≤ 1 ms) | **FAILS on this machine for BOTH the previous and the new engine** — A/B below |
| Rust doc tests | 2/2 |

New Rust tests: `local_output_follows_the_faders_setting_not_its_position`, `ducking_follows_the_faders_settings_on_every_fader`,
`every_source_on_any_fader_passes_the_same_chain_and_lands_within_1_lu_of_target` (A −5.6, CART −26.6, D −10.7,
S1 −21.1 LUFS files → **−16.00 LUFS on air each**; the same input on four faders airs bit-identical samples with
processing on), `every_fader_reaches_air_and_the_room_output_its_setting_names` (12 faders × MAIN/AUX),
`a_fader_ducks_the_music_only_when_its_own_ducks_music_setting_is_on`, `the_local_row_is_accepted_on_every_fader`,
`the_update_moves_nothing_the_boot_defaults_are_todays_layout`. Three tests that pinned the removed position rules were
rewritten to pin the new rule (not deleted). **Every golden passed unchanged** — the routing rewrite is bit-identical to
today's mixer for today's settings.

### The CPU gate — A/B on this machine, same conditions (Ether + Chrome running)

Row "4 faders + 5 MICS (48 k), racks IN", p99 (median), ms:

| Engine | run 1 | run 2 | run 3 |
|---|---|---|---|
| previous (`00891e4`) | 1.017 (0.523) | 1.183 (0.546) | 1.314 (0.668) |
| new | 1.075 (0.538) | 1.385 (0.697) | 1.247 (0.555) |

Both fail the 1 ms gate here and the ranges overlap; the same gate passed 11/11 earlier today. This machine's load
decides it, so it is **not certified either way** — it needs a run on an idle machine (Ether quit). Hot loops were
restructured so a static level takes the old loop with no per-sample branch.

## Test steps (before installing: check the table above)

1. Quit Ether from the tray. Install. Open. **Touch nothing.**
2. Faders: each fader is drawn at the level in the table; the cap reads its dB; the scale shows +10 / 0 / −10 … ∞.
3. Health Monitor → Live events: no red *Board state mismatch error*. Expect a burst of yellow *Loudness unmeasured
   skipped* for the first songs after the update — the backfill measures the library over the first minutes; they stop
   once files are measured.
4. Loudness: Preferences → Loudness & fader smoothing shows −16 LUFS and the count measured. Fire a cart, a sweeper and a
   song once each file is measured: they are the same loudness on air.
5. Routing: on any fader press MAIN/AUX — the room output moves, air does not. DUCKS on a music fader makes it duck the
   others. The Ducker section's DUCKED boxes match the strips.
6. Fader law: halfway on a channel fader is −10 dB and clearly audible; drags are smooth (no zipper).
7. Daemon log: `[board s2] saved board applied (engine start)`, `[board s2] fader routing migrated …` in the startup log,
   `[loudness] backfill: N file(s) queued`.
