# Release branch `release/build-fixes` — local installer and what to test

**Date:** 2026-10-07 · No version bump (package.json still says 4.6.59, the never-published number). Not pushed, not
tagged. On GO the version is set (4.6.58), then tag, CI, draft.

## Branches
- **`release/build-fixes`** = `main` (`5068390`) + 4 commits, build-system only:
  - `0df3d15` afterSign check runs `pwsh`, or `powershell` with the inherited PSModulePath removed (the 4.6.59 CI
    failure);
  - `94245da` the HA helper must be signed only when the app is (afterSign also runs on unsigned builds);
  - `a504b41` CLAUDE.md: the remote/dashboard domain is `app.ether-cast.com`;
  - `81438bb` CLAUDE.md: licensing rulings.
- **Already on `main`** and therefore in this branch: the HA helper built and **signed** in CI, the afterPack check
  that it is packaged, the uninstall `${isUpdated}` guard (an update never disables auto-logon), and the packaged-build
  gate (`d17f911`, `5068390`).
- **`wip/announce-catchup`** (`6f54afe`): the announcement catch-up, Up Next rows and heads-up, stacked play. **Unreleased**, kept for
  reuse (see `docs/timed-event-engine-plan.md` §6). `fix/aftersign-announce-catchup` points at the same commit.

## The installer
- **File:** `C:\openair\dist-electron\Ether Setup 4.6.59.exe`
- **Built from:** `release/build-fixes` `81438bb`, 2026-10-07 08:45:44 PDT, **215,899,795 bytes**
- **sha256:** `fc8aab8530b154663653cf4207451ed45f222dc6f1438fd55fb92e0f85ede295`
- The announcement WIP build was renamed so it can't be mistaken for this one:
  `Ether Setup 4.6.59 - ANNOUNCE-WIP 6f54afe - NOT FOR RELEASE.exe` (sha256 `0efb3b70…`).
- Unsigned (local build): SmartScreen → "More info → Run anyway". Local builds skip signing, so the helper is unsigned
  here **by design**. The build log says `unsigned build (Ether.exe NotSigned) — HA helper signature not required`. In
  CI the helper is signed and the build fails if it isn't.
- Gates on the branch: tsc 0 errors · vitest 85 files / 765 · announce 28/28 · closing 40/40 · undefined-calls,
  window-station, ipc-contract, preload-bridge PASS · leak-guard 13 · packaged release gate PASS (twice).

## What to test (a machine that is NOT on air)
1. **Install over an existing Ether** (an update, not a fresh install).
   - It must **not** show a UAC prompt to disable auto-logon (the `${isUpdated}` guard).
   - If auto-logon was on before, it stays on: Settings → System → Keep My Station On Air shows it enabled.
2. **The helper is present:** `C:\Users\<you>\AppData\Local\Programs\Ether\resources\ha-setup.exe` exists (or the
   install folder you chose).
3. **Keep My Station On Air works from the download.** File → Preferences → System → Keep My Station On Air.
   - Enable: one UAC prompt (the helper, which is unsigned in this local build), then enabled.
   - Disable: works the same.
   - In the CI-signed build the prompt will show the publisher, Jeffrey Jens.
4. **Normal smoke:** sign in, a station plays, announcements fire as before. Nothing in this branch changes playout or
   announcements; it is the same app code as `main`.
5. **Uninstall (real uninstall, not an update)** disables auto-logon (one UAC prompt). That's the intended behaviour.
