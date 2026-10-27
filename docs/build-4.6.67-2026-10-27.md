# 4.6.67 built (2026-10-27)

- **Installer:** `C:\openair\dist-electron\Ether Setup 4.6.67.exe`
- **Size:** 216,366,388 bytes
- **sha256:** `f8da13584d43c153af21a92f5326796904a92cd282ff4e6cb7ac5dcfe8485b53`
- **Built from:** `0990711`, `--publish never`, unsigned.
- Installed on OVEVENTS (the dev machine) only. Not pushed, tagged or deployed.
- No schema change (v68).

**Why:** 4.6.66 broke OV, where the queue never filled; OV went back to 4.6.65 and "rotation is back on 4.6.65".
Cause: `docs/engine-missing-catalogue-4.6.66-2026-10-27.md`.

## Commits (each with its test)

- `188d132` The engine ships every app file it loads, transitively (`daemonAppFiles`): electron/catalogue.js, the
  asset-delete chain (sync/handlers/asset-mirror.js → library_asset.js → asset-types.js → shared/asset-types.json),
  plus the four it already had. In asarUnpack, staged, and in the engine fingerprint. `shared/` is now packaged at all;
  until now the packaged app's asset-types degraded to SONG-only.
- `8f78a23` A missing required engine file fails the build (afterPack: "ENGINE FILES NOT PACKAGED") and the stage; it is
  never optional. A stage also checks every file before copying, so a failure no longer leaves a half-written engine for
  the fallback to run.
- `a29a279` The file check at engine.js:1956 logs its own failure ("✗ catalogue check FAILED — <cause> — every file
  reads as unplayable …"; once per cause, again every 10 min) via audiod/catalogue-check.js.
- `93f642d` Test: every relative require in the engine is in the engine stage manifest. It passes on this tree. On 4.6.66
  (f901541) it fails, naming electron/asset-types.js, electron/catalogue.js, electron/sync/handlers/asset-mirror.js,
  electron/sync/handlers/library_asset.js and shared/asset-types.json.
- `5e7e073` The installer stops the old app, watchdog and engine cleanly before installing
  (build-resources/stop-ether.ps1 + `--stop-and-quit`; backstop taskkill now includes ether-engine.exe). Log:
  `%TEMP%\ether-installer-stop.log`.
- `8e18fa2` Release check: the side-by-side launch can prove the queue fills (`ETHER_SMOKE_FILL_STATION`);
  `scripts/engine-fill-check.js`.
- `673af2f` Version 4.6.67.
- `d5497ce` afterPack names a package with no engine; the HA pack test's fixture carries a minimal engine.
- `0990711` The fill-mode smoke waits for the daemon handover before judging daemon_started (cold-stage race; the
  first launch filled 20 but read daemon_started before the handover).

## Before / after on OVEVENTS (item 6)

`scripts/engine-fill-check.js`, station 2 (halloVeen), the same stripped copy of this computer's database:

| Engine | Queue after `fill` | Engine log |
|---|---|---|
| installed 4.6.66 staged engine (code 9f922c0b) | **0** | nothing about why |
| control: same runtime, a tree with catalogue.js | 20 | "logreader refill: 20 pending from log" |
| packaged 4.6.67 (win-unpacked, code 006c126b) | **20** | "logreader refill: 20 pending from log" |
| installed 4.6.67 staged engine (code 006c126b) | **20** | "logreader refill: 20 pending from log" |

## Gates

- tsc: 0 errors.
- vitest: 135 files, 1,121 tests pass.
- test:db-release, test:sync, verify:schema, test:ipc-contract: pass.
- The build's afterPack: "every app file the engine loads is unpacked".
- audiod/verify-packaged.js: RELEASE GATE PASS.

## Release checks

1. **Contents: PASS.**
   - app.asar has 15,115 entries. Added since 4.6.66: audiod/catalogue-check.js, scripts/engine-fill-check.js and
     shared/asset-types.json. Nothing removed.
   - app.asar.unpacked has 911 files (4.6.66: 905). The 6 added are catalogue-check.js, catalogue.js, asset-types.js,
     asset-mirror.js, library_asset.js and shared/asset-types.json.
   - The native engine is unchanged (9efb1764a140).
2. **Size: PASS.** 216,366,388 bytes (+12 KB).
3. **Real launch, side by side, queue filling: PASS.**
   - Setup: packaged win-unpacked Ether.exe, `ETHER_SMOKE=1`, `ETHER_SMOKE_FILL_STATION=2`, `--user-data-dir` and
     LOCALAPPDATA / APPDATA in `%TEMP%\ether-rc-4667`, on a stripped copy of this computer's data (no account, licence or
     link keys; sync off).
   - The engine was staged into the temp folder; its manifest includes electron\catalogue.js and shared\asset-types.json.
   - The engine listened on `\.\pipe\ether-audiod-smoke-31384`; handover to the daemon at 22:10:31Z.
   - Engine log: `logreader refill: 20 pending from log`. Startup log: `[SMOKE] fill station 2: queue 20 item(s) — first:
     Black Magic — Little Mix`.
   - `[SMOKE] PASS — react_mounted=true … daemon_started=true daemon_log_staged=true station_count=5 air_isolated=true
     fill_station=2 queue=20 no_account=true` (22:10:35Z).
   - Its engine was stopped by path; 0 test processes left.

## Installed over the running 4.6.66 on OVEVENTS (item 5's runtime receipt)

- `Ether Setup 4.6.67.exe /S`: exit 0 after 93 s; the installed version is 4.6.67.0.
- `%TEMP%\ether-installer-stop.log`:
  - asked app pid 30544 to Stop & Quit. 4.6.66 has no `--stop-and-quit`, so it was still running after 20 s;
  - `.ether-clean-exit` written; the app and its helpers ended;
  - **engine: asked to shut down over \.\pipe\ether-audiod → exited on its own**;
  - nothing left.
- Installed 4.6.67 launched:
  - version 4.6.67; the engine runs code 006c126b (the install's);
  - boards re-applied for all 5 stations; startup background work done in 0.1 s;
  - 0 error lines in the session;
  - the staged engine holds all 8 electron files and shared\asset-types.json.

From 4.6.67 on, a running app quits itself on the installer's `--stop-and-quit`; that path is tested in source, and
gets its runtime receipt on the next install over 4.6.67.

## Jeff, after install

"4.6.67 is working great"
