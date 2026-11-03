# ha-setup.exe and the published Windows installers — read-only check

**Date:** 2026-10-05 · **Type:** READ-ONLY. The release was not changed; nothing was rebuilt or re-tagged.
**Trigger:** the v4.6.57 Windows CI log line `file source doesn't exist from=…\native\ha-setup\target\release\ha-setup.exe`.

## 1. The log line, the step that expects the file, and where it should come from
- **Log:** CI run `37395606743`, job "build (windows-latest, win)", step **"Build and publish (Windows, SIGNED — v* tag push only)"** (`npx electron-builder --win --config electron-builder.signed.json --publish always`). It appears twice: 00:49:25.31Z and 00:49:25.53Z.
- **What expects it:** `electron-builder.json:42-47` `extraResources` copies `native/ha-setup/target/release/ha-setup.exe` to `resources\ha-setup.exe`. electron-builder only **warns and skips** when the source is missing.
- **Where it should come from:** `cargo build --release` inside `native/ha-setup` (its own crate: `native/ha-setup/Cargo.toml`, `src/main.rs`).
  - **No CI step builds it.** The Windows job's only Rust build is the audio addon (`.github/workflows/build.yml:185-188` "Build native audio addon").
  - No commit to `build.yml` has ever mentioned `ha-setup` (`git log -S"ha-setup" -- .github/workflows/build.yml` → empty).
  - The extraResources entry arrived in `16414c4` ("feat(ha): auto-logon installer (Phase 4)").
- **What it is:** the elevated helper behind Settings → "Keep My Station On Air". It writes the HKLM Winlogon auto-logon values and the LSA `DefaultPassword` secret (`native/ha-setup/src/main.rs:7`, `:30`, `:119`), and `disable` clears them (`:133-136`). The app launches it from `process.resourcesPath\ha-setup.exe` when packaged (`electron/main.js:4133-4137`).

## 2. v4.6.52 versus v4.6.57
- **CI logs:** v4.6.52 (run `36607204225`, Windows job) has the **identical** warning twice (17:51:40Z). **Not a regression in 4.6.57.**
- **Published installers** (downloaded to scratchpad, listed with `7za l`):

| Installer | Executables inside | ha-setup entries |
|---|---|---|
| `Ether-Setup-4.6.52.exe` (217,742,336 B) | `Ether.exe`, `resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe`, `resources\elevate.exe` | **0** |
| `Ether-Setup-4.6.57.exe` (216,106,768 B) | same three | **0** |

- **Conclusion:** CI-built installers don't ship `ha-setup.exe`. **Locally built** installers do: this dev machine's installed Ether (`%LOCALAPPDATA%\Programs\Ether`, ProductVersion **4.6.57.0**, a local build) has `resources\ha-setup.exe` (dated 2026-10-04 20:15, Authenticode **NotSigned**).

## 3. What happens on update

**Two kinds of field installs:**

**(a) Installed from a CI installer (4.6.52 → 4.6.57):**
- The old install has no `ha-setup.exe`, so the uninstall hook is a no-op. The new install also lacks it.
- **Existing auto-logon keeps working.** It's Windows state (HKLM Winlogon, the LSA secret, the per-user Scheduled Task), not a file in the install folder.
- **Enable / Disable / Repair in "Keep My Station On Air" can't work** on such a machine, because the helper path doesn't exist (`main.js:4133-4137`; the spawn fails).
- Unchanged from 4.6.52.

**(b) Installed from a LOCAL build that included `ha-setup.exe`** (this machine; possibly others such as OV, **UNVERIFIED**):
- electron-builder's update runs the **old** version's uninstaller with `--updated` (`node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh:206`, `:224`; v26.8.1).
- The uninstaller inserts `customUnInstall` **unconditionally** (`templates/nsis/uninstaller.nsh:156-157`), before its own `${isUpdated}` branch (`:164`).
- Ether's hook (`build-resources/installer.nsh:11-14`) has **no `${isUpdated}` guard**:
  ```
  !macro customUnInstall
    IfFileExists "$INSTDIR\resources\ha-setup.exe" 0 +2
      ExecShell "runas" "$INSTDIR\resources\ha-setup.exe" 'disable --result "$TEMP\ether-ha-uninstall.json"' SW_HIDE
  !macroend
  ```
- **So updating such a machine (to 4.6.57 or to any version) launches `ha-setup.exe disable` through a UAC prompt.**
  - If someone approves it, auto-logon is switched off (`AutoAdminLogon=0` and the LSA secret deleted, `main.rs:133-136`). The station then won't log itself back in after a reboot.
  - After an update to a CI build, the new install has no helper to turn it back on.
  - The install is per-user (`electron-builder.json:105-111`, no `perMachine`), so the uninstaller isn't elevated and the UAC prompt is the only gate. `ExecShell` doesn't wait, so declining doesn't block the update.
  - Whether the prompt appears on an unattended box is **UNVERIFIED** at runtime.
- **This is a latent bug in the hook itself.** It predates 4.6.57, and it fires on local→local updates too.
- **Mitigating fact:** updates are operator-initiated. `autoUpdater.autoDownload = false` (`electron/main.js:7644`), so nothing installs unattended.

## 4. Recommendation
1. **Build the helper in CI.** Add a Windows-only step before packaging: `cargo build --release --manifest-path native/ha-setup/Cargo.toml`. It's then picked up by `extraResources`, and signed by the existing Azure Trusted Signing pass (it's a `.exe`).
2. **Fail the release gate when it's missing.** Add `resources\ha-setup.exe` to the packaged-verify gate, so a warning can never ship silently again.
3. **Guard the uninstall hook:** wrap it in `${ifNot} ${isUpdated}` … `${endIf}`, so only a real uninstall clears auto-logon and an update never does.
4. **Ship both in 4.6.58** (version bump, tag, CI).
5. **Do not pull 4.6.57 back to draft.**
   - It isn't a regression: v4.6.52, the release it replaced, ships exactly the same installer contents.
   - Pulling it would just make 4.6.52 "Latest", with the same gap and the same update hazard.
   - What protects stations now is advice. Before updating a machine that was installed from a local build with HA enabled (check `resources\ha-setup.exe` and Settings → Keep My Station On Air), the operator should **decline the UAC prompt** during the update, or wait for 4.6.58.

**Temporary tooling:** both installers were downloaded to the session scratchpad for listing. Nothing persistent.

## 5. Fix built — 4.6.58 (GO 2026-10-05; LOCAL ONLY: not pushed, tagged or released)

**Commit:** `d17f911` on `fix/ha-setup-ci`, branched from `main` `6b2dcba` (P0b is not included).

**Changes:**
- `build.yml` Windows-only "Build HA helper" step (`cargo build --release --manifest-path native/ha-setup/Cargo.toml`) before packaging.
- `engine-pack.js` `afterPack` throws on win32 if `resources\ha-setup.exe` is missing or isn't PE.
- `verify-packaged.js` exits 1 if it's missing.
- The `installer.nsh` disable call is wrapped in `${ifNot} ${isUpdated}`.
- Version 4.6.58.

**Gates:** tsc 0 errors; vitest 85 files / 746 tests; smoke window-station, copy-on-import, catalogue-r2, sign-filter (12/12) and undefined-calls PASS; pre-commit hook PASS.

**Local unsigned build:**
- `dist-electron\Ether Setup 4.6.58.exe`: 215,899,786 B, sha256 `5611b51f…7067dc`, built 2026-10-05 18:40 from `d17f911`.
- The NSIS script compiled with the guard.
- `afterPack` logged "packaged HA helper OK: resources\ha-setup.exe (pe)".
- The installer now lists **`resources\ha-setup.exe`** (140,800 B) beside `Ether.exe`, `ffmpeg.exe` and `elevate.exe`.
- `node audiod/verify-packaged.js` → **RELEASE GATE PASS**.

**A local-4.6.57 machine updating to 4.6.58 still sees the disable prompt once:**
- The 4.6.58 installer finds the existing install through its registry `UninstallString` (`app-builder-lib/templates/nsis/include/installUtil.nsh:155-167`).
- It copies **that** uninstaller out (`:209-210`) and runs it with `/S /KEEP_APP_DATA --updated _?=<install dir>` (`:224`, `:230`).
- That's the **4.6.57** uninstaller, compiled from 4.6.57's unguarded hook (`build-resources/installer.nsh:11-14` at `6b2dcba`).
- It finds `resources\ha-setup.exe` and runs the elevated `disable` (`uninstaller.nsh:156-157`).
- So **yes, the operator still sees the disable UAC prompt on that one update**, and declining it is the safe answer.
- Every update **from** 4.6.58 onward runs 4.6.58's guarded uninstaller: no prompt.
- CI-installed machines (no helper in the old install) see no prompt either way.

**Possible one-time mitigation (NOT built; needs testing on a VM):**
- 4.6.58's `customInit` runs in `.onInit` right after `initMultiUser` (`templates/nsis/installer.nsi:77-80`) and before the old uninstaller is called.
- It could delete or rename `$INSTDIR\resources\ha-setup.exe` there, so the old hook's `IfFileExists` misses.
- Whether `$INSTDIR` already points at the existing install at that moment is **UNVERIFIED**.
- If the install is cancelled after `.onInit`, the current install is left without its helper until the next install.
