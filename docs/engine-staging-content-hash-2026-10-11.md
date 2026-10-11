# Engine staging by content + engine-mismatch sense (2026-10-11)

Follows `docs/monitor-failed-test-diagnosis-2026-10-10.md`. The failed MONITOR test on OVEVENTS ran the pre-fix engine.
The staged engine was reused because `version.txt` already said 4.6.59. Branch `fix/monitor-local-output`, uncommitted,
no version bump, not pushed.

## Changes

- **`audiod/engine-fingerprint.js` (new):** sha256 of `ether-audio.node`, plus one sha256 over the daemon's runtime .js
  and the `electron/` modules it requires. Every side uses this one derivation.
- **`audiod/stage-engine.js`:** every staged file is compared with the installed one by sha256 on every stage.
  `version.txt` is still written but decides nothing.
  - The native engine and the daemon code are hashed on both sides each time.
  - The big runtime files are hash-cached by size + mtime in `stage-manifest.json`.
  - Daemon .js files that are no longer installed are removed.
  - **A file in use (was line 113):** renamed aside (`*.old-<time>`), and the installed one is copied in. The running
    daemon keeps its old copy and is not touched; the next start loads the new one. Old copies are swept later. If even
    the rename fails, the old file stays, a log line names both hashes, and the next stage retries.
- **`audiod/ether-audiod.js`:** at startup the daemon fingerprints what it loaded. It reports this through the new
  `engine` command and in `hello`.
- **`electron/daemon-engine.js` (new, pure) and `electron/main.js` `checkDaemonEngine()`:** run on every daemon connect.
  - Mismatch, or a daemon too old to report → red **`daemon-engine-mismatch-error`** in the Health Monitor, naming the
    running and installed hashes.
  - It also writes an `[AUDIO] engine-check:` startup-log line with full hashes, and arms the existing reload. That
    reload fires only when no on-air engine is live (`fireDaemonReload` / `anyOnAirEngineLive`): never mid-broadcast.
  - If the respawn still loads the same old engine, it is not re-armed, so there is no reload loop.
  - A return to a match → green `daemon-engine-match`.
- **`audiod/verify-packaged.js` (release gate):** new ENGINE IDENTITY check. The packaged daemon must report the packaged
  engine's sha256 over the pipe.
- **Help:** `docs/help-health-monitor.md` → "Daemon engine mismatch error".

## Gates run

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx vitest run` (full) | 88 files, **787/787 passed**: 10 new stage-engine tests, 6 new engine-match tests |
| Mutation check | old version-keyed fast path put back → **9 of 10** stage-engine tests fail; restored |
| Real Windows lock test | a running `ether-engine.exe` is renamed aside, keeps running, and the new one is staged: PASS |
| `test:local-playback`, leak-guard, audio-statics | PASS |
| Rust suite (`-j 2`, `--test-threads=1`) | **INCOMPLETE**: killed by Claude Code for low system memory after 79 tests ok, 0 failed. Native code is unchanged in this change |
| Installer build | **NOT PRODUCED**: vite built OK; electron-builder killed for low memory mid-packaging. `dist-electron\win-unpacked` is TORN, do not use |

Ether (PID 33072) and the daemon (PID 12696) on OVEVENTS kept running throughout.

## Expected engine hash

`native/ether-audio.node` (committed at 515698c, unchanged): `9f7d7079f4e70383a9528d48203c3cf7b53b2909600d69a87a4d4e77a9ea3ab8`.
