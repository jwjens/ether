# Build 4.6.60 (2026-10-20)

## Jeff's request (verbatim)

> Finish 4.6.60 now. OVEVENTS is the dev machine; building and the isolated launch check are fine here.
> 1. Settle the 5 failing engine reference tests: re-record them, or explain each one, before trusting the seek change.
> 2. Test and commit the seek work and the machine-designation work.
> 3. Copy the new compiled engine into native/ether-audio.node.
> 4. Run the gates, build the 4.6.60 installer, and run the three release checks (contents, size, isolated real launch).
> 5. Report path, name, sha256, and the list of what's in it (including the Carts window, Program Log layout, sweepers fix, hour rules, rotation fix, regenerate from the next song, UUID sync fix).

Added mid-task: "Play Log window: I can't scroll up or down to see earlier rows (this morning). … Include it in 4.6.60."

## The installer

- **Path:** `C:\openair\dist-electron\Ether Setup 4.6.60.exe`
- **sha256:** `a9dfd41b94ac134c9f37e5a9637820b79af6fe0e1ca7fcbfa74b3ac782ebf546`
- **Size:** 216,188,619 bytes · built 2026-10-20 11:26:46 PDT · commit `ee43be3` on `release/1019` · `--publish never` · local only, not pushed, not tagged.
- Engine inside: `app.asar.unpacked/native/ether-audio.node` sha256 `9efb1764a140c931970562bc03b9333908a3eb95f2cf338572e059601edab4ad` (compiled on OVEVENTS from `016750c`).

## What is in it (on top of b02a58b, the build installed on OVEVENTS)

| Commit | What |
|---|---|
| c2c9409, f435c3c | UUID sync fix — references travel by UUID (songs no longer land one category off; artists created on arrival; one-time re-file) |
| 7b0566d, e9d6100 | Carts window (push-up in the Carts window's colours, no gaps; Screen Builder Carts = the Carts window) |
| 4f78b4a | Program Log layout (Title column no wider than a title; bigger, brighter calendar, day line, Today's Shows) |
| d1252f3 | Hour rules from the 3 PM on OV, incl. **regenerate from the next song** |
| 11736e4 | Sweepers fix — the dropdowns decide; none means none; every change saved and live |
| c32f459 | No generate switch (every show's log built before it starts) + rotation fix ("rotation no worse"); version 4.6.60 |
| 016750c | **New:** stall resume at the exact spot (engine `audio_load_from`, rebuilt engine) |
| af85263 | **New:** the log builder follows the existing machine designation |
| ee43be3 | **New:** Play Log scrolls; a day lists every play back to midnight |

## Gates (on ee43be3)

tsc 0 · vitest 118 files / 1026 tests (1028 → 1026: c32f459 removed 5 switch tests, added 3) · verify:schema PASS · test:three-pm 38/38 · sweeper-assignments 22/22 · uuid-refs 30/30 · sync 55/55 · programlog-reads 11/11 · programlog-writes 110/110 · hour-rollover 7/7 · autopost-switch 11/11 · sweeper-sense 9/9 · designation ALL PASS · window-station, copy-on-import, catalogue-r2, sign-filter 12/12, undefined-calls, ipc-contract, preload-bridge, spot-edge, queue-rows, stale-rows, calendar-anchor PASS.
Failing as before, not touched: **test:one-switch** (hand-rolled INSERT in `src/audio/attach-restore-sequence.test.ts:37`); **scheduler gate** T3 (station 1: 131, station 3: 131), T15, T18 (335 of 336).
Engine (`cargo --lib`): 155 passed, 5 failed, 5 ignored — the 5 golden tests, explained in `docs/play-log-scroll-and-golden-tests-2026-10-20.md`, identical with and without the seek change; not re-recorded (waiting on Jeff's ear, 2026-10-13 rule).

## Release checks

1. **Contents:** `verify-package-contents.js` vs 4.6.59 (unpacked from `Ether Setup 4.6.59.exe`): 215/215 packages, **PASS**. Today's changes confirmed inside the package: engine sha256 above; `audiod/engine.js` `_loadFrom`; `ether-audiod.js` `audioLoadFrom`; `generation-designation.js` new rule; `main.js` `stall-resumed-at-position`; renderer Play Log query without the cap for a day.
2. **Size:** 216.2 MB vs 216.2 MB (0.0%), **PASS**.
3. **Real launch (isolated):** `win-unpacked\Ether.exe` with LOCALAPPDATA/APPDATA pointed at an empty temp folder. **PASS**: window "EtherCast", responding, account **sign-in** screen (screenshot); daemon connected; engine-check running native `9efb1764…` = installed; profile `_pending` DB in the temp folder; engine staged in the temp folder. Closed via the "Close Ether?" box → Stop & Quit Ether: 1.8 s, 0 processes left. Temp folder deleted.
   - **Finding:** the APPDATA override did not isolate everything. Electron took its user-data folder from Windows itself, not from the variable: the test app's Chromium profile and the daemon log used this machine's real `C:\Users\jensj\AppData\Roaming\Ether` (the log has the test's lines, 18:30–18:32 UTC). The database and the staged engine did go to the temp folder. No station DB was opened; nothing went on air.
   - Daemon first connect missed the 5 s boot window (in-process fallback, then handover at 4 s) — the known cold-stage race (memory: cold-stage daemon race), not new.

## Open for Jeff

- **Fall VIbes (station 9) has no designated machine**, and nothing in the app can designate one; after install it is never built automatically (yellow; Fill Day works).
- **Goldens:** listen to `C:\openair\native\goldens\review-4.6.59\` and approve or not; then re-capture.
- **Play Log fix is runtime-UNVERIFIED** — the isolated launch cannot sign in; it is proven when the Play Log is opened in the installed build.
- Install is yours (STOP before install).

## Architecture compliance

- Seek: decode/seek stays off the audio thread (`build_source_at` in the dispatch thread; the callback only receives samples and an `RtCmd::SetPosition` through the existing lock-free queue — docs/dsp-rt-callback.md §4). `audio_load` path unchanged (start 0 → `build_source_at(…, 0.0)`, proven sample-identical by `seek_tests`). Physical deck rule: the stalled song reloads on its own deck only (smoke 5h).
- Designation: pure decision in `generation-designation.js`, writers unchanged (sanctioned writers only); status honest in the Health Monitor (yellow, named).
- Play Log: a scroll region in the panel itself; hosts unchanged (one change, not three).
