# The board is never asleep: local build and how to test it (2026-10-11)

Branch `fix/monitor-local-output`, commit `12b3f1d` (+ docs `6040d37`). **No version bump, not pushed, release held.**
Diagnosis and audit: `docs/board-state-on-connect-diagnosis-2026-10-11.md`.

## The installer

- **File:** `C:\openair\dist-electron\Ether Setup 4.6.59.exe`, 215,936,788 bytes, built 2026-10-11 14:46 PDT from `12b3f1d`.
- **sha256:** `34e622c3dc280abcf4464349b5db6c20966eab4e13ec53d4151f44376e4628f3`
- **Engine (native) sha256:** `2bc9ffcf8de137c95fd20b98d8deb3105fec7ed4186f0d67302ddb3c3a55f662`. It is a local build, so this
  is the hash every confirmation line shows. A CI build compiles its own engine (different bytes, same source).
- Previous local installer renamed: `Ether Setup 4.6.59 - engine-staging 692dffc 7fcc8fa7 - SUPERSEDED.exe`.

## Gates (all run on this tree)

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `vitest` (full) | 91 files, **808/808** (20 new: board-state 12, board-sync 6, board-log 3 — incl. window-before-engine, fallback→handover) |
| Real daemon + engine, no app, start AND restart (`npm run test:board-restore`) | **22/22**: the saved board is live in the control copy and in what the callback mixed with |
| Rust, alone, `-j 1 --test-threads=1` | **165/165** (150 passed + 4 ignored; bench/timing 11; doc 2) incl. `a_late_saved_board_brings_a_source_fader_to_air_stream_and_room_with_no_touch` |
| show presets smoke | 52/52 |
| CI test-job guards (window/station, copy-on-import, catalogue, sign filter, leak guard, audio statics, local playback) | all PASS |
| Packaged release gate | **PASS** — engine identity: daemon reports `2bc9ffcf…`, code `9ff0895c…` = the package |

## Test steps (OVEVENTS, nothing on air)

1. **Quit Ether from the tray** (Quit Ether). Check Task Manager: no `Ether.exe`, no `ether-engine.exe`.
2. Run the installer above, then open Ether. **Touch nothing on the board.**
3. Confirm the engine:
   ```powershell
   $want='2BC9FFCF8DE137C95FD20B98D8DEB3105FEC7ED4186F0D67302DDB3C3A55F662'; $i="$env:LOCALAPPDATA\Programs\Ether\resources\app.asar.unpacked\native\ether-audio.node"; $s="$env:LOCALAPPDATA\Ether\engine\native\ether-audio.node"; $m=(Get-Process ether-engine).Modules | ? ModuleName -eq 'ether-audio.node'; foreach ($r in @(@('installed',$i),@('staged',$s),@('loaded',$m.FileName))) { $h=(Get-FileHash $r[1]).Hash; "{0,-9} {1}  {2}" -f $r[0],$h,$(if ($h -eq $want) {'OK'} else {'MISMATCH'}) }; Get-Content "$env:APPDATA\Ether\ether-startup.log" -Tail 8000 | Select-String '\[board|engine-check|HANDOVER|fallback' | Select -Last 12
   ```
   Expect three `OK` lines. The log lines show `[board] saved board re-applied on connect` and a
   `[board] s2 live board matches the saved board`, or `LIVE ≠ SAVED: …` naming what differs.
   This first launch after an install may start on the in-process fallback (the cold re-stage). If it does, you also
   see `saved board applied to the in-process engine`, then `HANDOVER`, and
   `queued board changes delivered`. **That is the 2026-10-11 failure path, now covered.**
4. **The report, retested, no touch:** fire a cart on each Source fader (S1, D, F…) and let a sweeper fire.
   Each is heard in the room at its saved AUX level, and the music ducks as before.
5. **Health Monitor → Live events:**
   - Expect **no** red *Board state mismatch error*, except one known item: the Sweeper channel (E) listed as
     **channel type**, saved "jingle → sweeper", live "source". That is the open ruling below, shown on purpose.
   - Anything else listed is a defect. The row names it by fader letter, with saved and live values.
6. **The AUX-row question:** move one AUX row in Master Out → AUX monitors and touch one fader. Then check the daemon log
   (`%APPDATA%\Ether\logs\ether-audiod.log`) for lines like `[board s2] setAuxMonitor S1=0.6 → true` and
   `[board s2] setVolume E=… → true`. Every setter the engine receives is now on record with its answer. If a row move
   ever again fails to reach the engine, this line is the receipt.
7. **MONITOR is saved:** set MONITOR to about 30%, quit from the tray, reopen. The MONITOR fader shows ~30% and the room
   is at that level **without touching it**.

## Open ruling (Jeff)

**Slot kind is never sent to the engine, by any shipped path.** A fader the board shows as Sweeper (saved
`kind:"jingle"`) runs in the engine as Source: it reaches the room only through its AUX row and triggers the duck. Sending
the saved kind would make it a Sweeper, summed into the programme and **no longer ducking the music**. That changes air,
so this build compares and flags it but does not apply it. Your call: apply the saved kind, or keep Source behaviour
and correct the saved kind.

## What this build does NOT include

- The announcements editor fix (approved; next).
- Channel racks, processing, mic inputs, link and PFL dim/cue are still reconciled by the daemon's poll **only while a
  station's playout engine runs**. PFL dim and cue device are now also in the start-up apply; the racks, processing,
  mic and link are not (unchanged from before).
