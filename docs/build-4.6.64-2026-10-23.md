# Build 4.6.64 — 2026-10-23

**`C:\openair\dist-electron\Ether Setup 4.6.64.exe`** · 216,338,598 bytes · sha256
`35c7f01111a630e57582c218e67236a438c8becff207bc5ca4da6edfc47f70b5` · built from `6c83518` (clean tracked tree) on branch
release/1019 · `--publish never` · not pushed, not tagged · unsigned (as 4.6.63).

**NOT REPORTED READY: release check 3 (real launch) did not pass cleanly. See below.**

Jeff, 2026-10-23: "Build 4.6.64 with everything since 4.6.63: these two, the restore message fix, failed-file logging, and
the case-distinct files. Gates, three release checks, path, name and sha256."

## What is in it (on top of 4.6.63, c3f5256)

| Commit | What |
|---|---|
| `82aedea` | Restore screen shows the download job's real count (read `result.done`, which never existed) |
| `9a1d380` | Every failed catalogue file + reason to ether-startup.log; pruned cloud-list entries counted as cleanup, not errors |
| `1723276` | Names that differ only in case are separate files (case-alt names); the catalogue pull settles |
| `69fd54e` | Deleted songs never return: inbound mirror respects tombstones, sync never clears a song tombstone, launch repair retires the ghosts (31 on OVEVENTS) |
| `2350fce` | Library edits change only the field edited (May bug 486b861: artist edit cleared album, other edits cleared artist) |
| `6c83518` | Version 4.6.64 |

Docs: docs/halloveen-join-61-file-errors-2026-10-23.md, docs/library-category-and-rename-2026-10-23.md.

## No schema change

Newest migration still v68. No ALTER/CREATE/DROP TABLE, CREATE INDEX or schema_version write in
`git diff 38a1791 6c83518 -- electron audiod src` outside test files. Wire format unchanged. Sync BEHAVIOUR changes for
songs: an inbound insert/update for a song this machine holds as deleted is not applied (69fd54e). A 4.6.62/4.6.63 peer
still applies such updates, so the guarantee holds only on 4.6.64 machines.

## Gates (on 6c83518)

tsc 0 · vitest 120 files / 1003 tests · test:sync 14 files / 60 tests · test:db-release ALL PASS · verify:schema PASS ·
test:ipc-contract PASS · test:preload-bridge PASS · test:undefined-calls PASS · test:case-distinct PASS · test:catalogue-r2
PASS · test:one-switch: 1 failure, the same old test-file finding (`src/audio/attach-restore-sequence.test.ts:37`).

## Release checks

1. **Contents vs 4.6.63** (`scripts/verify-package-contents.js`, 4.6.63 win-unpacked saved before the build): packages
   217 = 217, PASS. app.asar 15,096 → 15,098 entries: added `electron/track-edit.js`, `scripts/smoke-case-distinct.js`;
   renderer bundles renamed (hash). Nothing missing. app.asar.unpacked: 905 = 905 files, identical list.
2. **Size:** installer 216,338,598 bytes vs 4.6.63 216,329,609 (+9 KB, 0.0%), PASS. Unpacked 861 MB.
3. **Real launch: NOT PASSED.** Packaged Ether.exe, LOCALAPPDATA/APPDATA in a temp folder, `--user-data-dir` temp, on a
   copy of the OVEVENTS database (account/licence/link/ops keys removed, sync_enabled=false, stream password and
   owner_license_key cleared). Live DB untouched (last written 19:50, before the test).
   - **Run 1 (pid 27536, 21:11:28):** started, window "openair" responding, staged engine matched (native 9efb1764a140),
     daemon spawned + connected, board restored, heavy startup work done in 0.1 s. The boot repair retired exactly the 31
     Library ghosts in the copy (0 left). Then at **21:12:06 the app quit**: `.ether-clean-exit` written by before-quit,
     daemon `cmd shutdown` at 04:12:06.743Z. Every quit path in main.js is a person's action (close box → Stop & Quit,
     tray → Quit Ether, Ctrl+Q). The log does not say which; nobody was warned that a test window would appear.
     UNVERIFIED whether a person closed it or something else did.
   - **Run 2 (pid 27472, 21:18:28):** started, responding at 21:18:31; then Claude Code killed the sampling script for low
     system memory and the app with it (log stops mid-boot at 04:18:31, no clean-exit, no daemon shutdown). Inconclusive.
   - Not done: the 4-minute Responding sample, health-events main-stall review over that window.
   - As before: Electron's Chromium profile, ether-startup.log and ether-audiod.log landed in the REAL `%APPDATA%\Ether`.
     The daemon opened this computer's audio devices; boot auto-resume was suppressed, so nothing played.

Next step: re-run check 3 with nobody at the keyboard (or with Jeff told first), the copy at
`scratchpad\launch` is ready and still valid.
