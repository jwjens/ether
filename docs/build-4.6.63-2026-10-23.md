# Build 4.6.63 — 2026-10-23

**`C:\openair\dist-electron\Ether Setup 4.6.63.exe`** · 216,329,609 bytes · sha256
`f46d944ca9841ee1e243b19dffe6235598752a23fb98a5b52ca8fc2036bbf2cf` · built from `c3f5256` (clean tree) on branch
release/1019 · `--publish never` · not pushed, not tagged · unsigned (as 4.6.62).

Jeff, 2026-10-23: "Build 4.6.63 now with what's done: the database-release fix and the Admin greeting fix, plus cap the
startup log so it can't grow past a set size. The Library bug goes in the next build. Confirm 4.6.63 has no schema change,
so my jensj work PC can run 4.6.63 while OV and OVEVENTS stay on 4.6.62. Gates, three release checks, path, name and
sha256."

## What is in it (on top of 4.6.62, built from e4d7562)

| Commit | What |
|---|---|
| `491f62c` | Sync / station swap closes every connection Ether holds to the station database first; the message names who holds the files (docs/db-release-on-swap-2026-10-21.md) |
| `52decf4` | Shift screen starts as the person who signed in, not the lowest user id — Admin login greeted Shawna (docs/admin-greets-shawna-2026-10-21.md) |
| `c3f5256` | ether-startup.log capped: rotates at 20 MB into ether-startup.log.1 (last 20 MB kept), so at most ~40 MB; an oversized log from an older build (OVEVENTS: 1.87 GB) is cut to its newest 20 MB at the first write. Version 4.6.63 |

## No schema change

Newest migration is still v68 (`scripts/migrate-play-log-machine-name-phase-sync-68.js`, in 4.6.62). No
`ALTER/CREATE/DROP TABLE`, `CREATE INDEX` or `schema_version` write in `git diff e4d7562 c3f5256 -- electron audiod src`.
No sync wire-format change. 4.6.63 and 4.6.62 can run side by side on one account.

## Gates

tsc 0 · vitest 118 files / 984 tests pass · test:db-release ALL PASS (11) · test:sync 55/55 · verify:schema PASS ·
test:ipc-contract PASS · test:preload-bridge PASS (3 ratcheted channels, unchanged) · test:undefined-calls PASS ·
test:one-switch: 1 failure, the same old test-file finding as 4.6.62 (`src/audio/attach-restore-sequence.test.ts:37`).

## Release checks

1. **Contents vs 4.6.62** (installed 4.6.62 app.asar vs this build): 15,090 → 15,096 entries. Added:
   `electron/db-holders.js`, `electron/file-lockers-win.js`, `electron/log-cap.js`, `scripts/check-sync-items.js`,
   `scripts/copy-db-readonly.js`, `scripts/smoke-db-release.js`. Changed names only: the hashed renderer bundles. Nothing
   missing. app.asar.unpacked: identical file list.
2. **Size:** installer 216,329,609 bytes (4.6.62: 216,307,158, +22 KB). Unpacked 902.8 MB (4.6.62 installed: 903.0 MB).
3. **Real launch: NOT RUN.** Ether is on air on OVEVENTS. A second Ether connects to the one daemon pipe
   (`\.\pipe\ether-audiod`, electron/audio-daemon-client.js:24) and re-applies the saved board on connect, and the new
   log cap would rotate the live startup log. Needs Ether closed on this computer, or run on the jensj PC.
