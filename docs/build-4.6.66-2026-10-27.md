# 4.6.66 built (2026-10-27)

- **Installer:** `C:\openair\dist-electron\Ether Setup 4.6.66.exe`
- **Size:** 216,353,979 bytes
- **sha256:** `122a0a53168136ab9c14d39e381e45b130e8b85f03a8f55e354ee3a766cdb813`
- **Built from:** `f901541` (release/1019), `--publish never`, unsigned like every local build.
- Not installed, pushed or tagged.

## On top of 4.6.65

- `70d64bc` Catalogue folder: the default is created at launch; `music:get-dir` reports the real default.
- `637824e` Version.
- `d1e2065` Isolated launch keeps its own `--user-data-dir` and its own engine pipe (below).
- `f901541` Settings → Audio: the dead "Where music plays" picker is removed; "Cue / headphone output" becomes "Track
  Editor preview player" (`docs/audio-output-selectors-wiring-2026-10-27.md`).

No schema change: the newest migration is still v68 (the stripped copy reported 68).

## Why the first 4.6.66 launch check "quit on its own within 90 seconds with no startup log"

From `%TEMP%\ether-diag.txt`, pid 23420:
```
17:47:32.102Z POINT-2: before requestSingleInstanceLock
17:47:32.259Z POINT-2b: lock NOT acquired — exiting (another instance running)
```
- The check ran beside the on-air 4.6.63. main.js sets userData to `<app.getPath("appData")>\Ether`, which is the Windows
  known folder: it ignores the `%APPDATA%` and the `--user-data-dir` the check set.
- So the test copy asked for the live app's single-instance lock, lost it, and quit before the startup log opens.
- The lock is right: two Ethers must never drive one engine. The build was not broken; the launch method was.
- The designed side-by-side mode (`ETHER_SMOKE=1` + `--user-data-dir`) had the same two leaks:
  - It wrote to the live userData (startup log, window state).
  - It would have connected to the live engine's pipe.
- Fixed in `d1e2065`: an isolated run keeps its own userData and gets `ether-audiod-smoke-<pid>` as its engine pipe.
  Test: `electron/smoke-isolation.test.js` (3 of 5 fail on the previous commit).

## Gates

- `tsc --noEmit`: 0 errors.
- vitest: 130 files, 1,088 tests, all pass.
- `test:db-release`: ALL PASS.
- `test:sync`: 64 pass.
- `verify:schema`: PASS.
- `test:ipc-contract`: PASS.

## Release checks

1. **Contents: PASS.**
   - app.asar has 15,111 entries, the same as the first 4.6.66 build.
   - Against the installed 4.6.63: the 15 files added since then are present, and nothing is missing.
   - The packaged main.js carries the isolation fix.
   - The bundle has "Track Editor preview player" and no "Where music plays".
   - The 905 unpacked files are the same list.
   - The native engine is unchanged (9efb1764a140).
2. **Size: PASS.** 216,353,979 bytes against 4.6.65's 216,333,547 (+20 KB).
3. **Real launch (side-by-side mode): PASS.**
   - Setup: the packaged `win-unpacked\Ether.exe` (the files the installer lays down), launched with `ETHER_SMOKE=1`,
     `--user-data-dir` and LOCALAPPDATA / APPDATA all in `%TEMP%\ether-rc-4666b`, and an empty profile (0 stations, so
     nothing can air). No pipe was set by the check.
   - pid 30108 at 19:55:28Z:
     - userData: the temp folder;
     - `[catalogue] folder: …\Music\ether music library (the default) — present`;
     - the engine staged into the temp LOCALAPPDATA and listened on `\\.\pipe\ether-audiod-smoke-30108`;
     - connected; handover to the daemon complete.
   - `[SMOKE] PASS — react_mounted=true root_children=1 renderer_error=false daemon_desired=true daemon_started=true
     daemon_log_staged=true station_count=0 air_isolated=true` at 19:55:48Z. The app then exited itself.
   - Its detached test engine (pid 30376, in the temp folder) was stopped by path. 0 test processes left.
   - **Live Ether untouched:**
     - its startup log has no line from the test (pids, `[SMOKE]`, the temp path);
     - the same 10 live processes before and after;
     - its window responding.

Not covered: an install through the NSIS installer. It would run the installer's close-Ether step against the on-air app,
so it is not run on this computer.

## Installed on OVEVENTS (the dev machine, not on air) — 2026-10-27 20:46–20:49Z

- Jeff closed 4.6.63 with Stop & Quit (clean-exit marker 20:46:25Z, 0 Ether/engine processes).
- `Ether Setup 4.6.66.exe /S` exited 0 after 73 s; the installed Ether.exe reports 4.6.66.0.
- Launched the installed app (pid 30544, 20:48:42Z). Startup log, from `=== SESSION START ===`:
  - `version: 4.6.66  packaged: true`
  - `[catalogue] folder: …\Local\Ether\catalogue (chosen by the user) — present`
  - saved board applied for all 5 stations (s1, s2, s3, s4, s9)
  - engine: a fresh daemon (pid 21968), daemon code `9f922c0b…` (4.6.63's was `9eb099f0…`), the same native engine
    `9efb1764a140`; handover to the daemon complete; every station's live board matches the saved board
  - startup background work done in 0.1 s
- Scan of all 54 session lines for ✗ / ERROR / FAIL / failed / exception / SQLITE / corrupt / not found: none. Daemon
  log since 20:48: no ERROR / WARN / fail / panic. Window responding.
- One pre-existing line, also logged by 4.6.63 every hour today: `[link] key #2 NOT shared: your sign-in has expired`.
- The window shows the **account sign-in screen** (screenshot), because this computer's Ether account session had
  already expired under 4.6.63. The station's data loads underneath (boards, engine, station 1 adopted), but the
  station screen itself is behind sign-in and was not seen. Signing in is Jeff's step.
