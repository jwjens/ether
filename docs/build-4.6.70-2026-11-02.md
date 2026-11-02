# Build 4.6.70 — 2026-11-02

**Scope:** Jeff's scope freeze: release 4.6.70 only, skipping 4.6.69. It includes, beyond what was in flight:
- the user manual PDF, shipped in the installer and opened by Help → Documentation;
- the ON AIR tooltip saying "start streaming".

**Branch:** `release/4.6.70`, from `billing-new-prices`.
- Plus the docs-only commits from `feat/park-talk` / `fix/halloveen-playout`.
- Tag `v4.6.70` on `e1220ba`.
- CI run 41491823599.

**Release:** a DRAFT. `electron-builder.json` `publish.releaseType: "draft"`, and CI also sets `EP_DRAFT: true`. Jeff publishes it.

## Inventory (everything since 4.6.57, by name)

Every item on Jeff's list was checked against the commits since `v4.6.57`:

| Item | In 4.6.70 | Commits (examples) |
|---|---|---|
| Patch Bay outputs, inputs, devices per output (up to 4), stall setting | yes | ba05e69, 1fab6c6, 82cdc4a, 51d3efe; stall switch in PatchBay.tsx |
| Board: fader caps, double-click unity, fader banks, A·B·C collapse, progress strip | yes | 6768cb2, a757045, 60f8029, 4eb1a83 |
| Settings freeze fix; Preferences → Settings | yes | 3255f59, 1c07fd0 |
| Sign-in first on launch, silent renewal, never signed out while running | yes | 7029763, 136d882 (4.6.69 work) |
| Remote Link relay; sender (computer · station) dropdown; typed IP box | yes | 517cf8c, 529a34e. The typed address sits under "Advanced" (code; runtime UNVERIFIED) |
| Mac engine fix; queue/catalogue fixes; library location choice | yes | 3e97d50; catalogue commits 10-23..10-27; Settings → catalogue folder (93fb1e9, 101/102 in the list) |
| User manual PDF + Help → Documentation | **added today** | fc59036 |
| Update Details popup | yes | 3b95e7e |
| Stream Manager, metadata outputs, phone remote, voice-tracking mic | yes | e74524f/c372210, b60fad5, f0fcf70, 185834f |
| Show+ To Deck, IRIS hidden, 44-item fixes, EAS Logbook in ☰, "Start streaming" | yes / partial | 39c0d1c, 6c37cdc, 6ea9e95; 44-item list partly done (docs/after-4.6.70.md); ON AIR tooltip fixed today |
| Billing popups, plan names and prices, app version reporting | yes | 854b1a9, b742856, 43de8cf, e613866 |

The old October branches were not merged because their work was rebuilt later in the release line (docs/after-4.6.70.md).

## Tests (release/4.6.70)

**Main gates:** tsc 0 errors · vitest 203 files / 1491 tests pass · verify:schema pass.

**CI's gate:**
- The six suites CI runs: tsc, vitest, window-station, copy-on-import, catalogue-r2 and sign-filter.
- Locally, sign-filter fails only on the "real win-unpacked" part. It read an old local build that had an unsigned serial-port binary. CI has no win-unpacked, so its run is fixture-only.

**All ~80 suites:**
- 54 pass outright.
- The 5 on-a-copy suites were re-run on a read-only database copy; all 5 still fail, on timing by a few ms or on data the copy lacks.
- The others are failures outside CI's gate, none build-breaking: stale tests; scheduler-gate T3/T15/T18, failing since 4.6.60; engine timing gates p99 1.13–1.18 ms > 1 ms with Chrome open. There has been no engine audio-path change since 4.6.69. Each is one line in docs/after-4.6.70.md.

## Release checks on the local Windows build

The local build was unsigned, made with `--publish never`.

1. **Packaged:**
   - engine `pe`, engine source `d4a2c71b654d31da` (matches `native/`);
   - every engine file unpacked;
   - HA helper present;
   - **user manual OK: resources\Ether-User-Manual.pdf (1233 KB)**.
2. **Contents vs the last good build (4.6.59 win-unpacked):** PASS. 234 vs 215 packages; every old package is present. The only new ones are `@serialport/*`.
3. **Size:** PASS. 217.9 MB vs 216.1 MB (+0.8%).
4. **Real launch, side by side:** `ETHER_SMOKE=1`, its own `--user-data-dir`, LOCALAPPDATA and APPDATA.
   - **Fresh profile:**
     - window text `Sign in with your Ether account to get started. Sign in Sign up Remember me Sign in Forgot password?`;
     - engine started from its staged copy.
     - The smoke said FAIL only because the fill station had no stations (an empty profile).
   - **Stripped copy of this computer's database** (sign-in, keys, credentials and sync removed with secure_delete; the live DB was only read):
     - sign-in screen first;
     - `[SMOKE] fill station 2: queue 20 item(s) — first: Pink Elephants on Parade`;
     - **`[SMOKE] PASS`** (react mounted, daemon started from the staged engine, 5 stations, air isolated, queue 20).
   - Both throwaway engines were stopped and the temp folders removed.

## CI build, signing and draft

- **CI run 41491823599: success on every job** (test, Linux, Windows, Mac), 2026-11-02 17:30–17:55Z.
- **Azure signing works.** "Trusted Signing completed successfully". `ha-setup.exe signature: Valid — CN=Jeffrey Jens, O=Jeffrey Jens, L=Las Vegas, S=nv, C=US`; electron-builder "signing with Azure Trusted Signing" on the app's files.
- **Downloaded `Ether-Setup-4.6.70.exe`** (218,158,720 bytes, SHA-256 `49CC29CCED9017D7460DFC0F8F72D73E3DBA14D861BA58D5A477890C3610F0F6`):
  - Authenticode **Valid**, Jeffrey Jens;
  - timestamped by Microsoft Public RSA Time Stamping Authority.
- **The user manual was packaged on every platform:** `user manual OK … (1233 KB)` on Windows, Linux, and both Mac arches. Both Mac engines were packaged (`macho:x64`, `macho:arm…`).
- **Draft release `4.6.70`:** title "v4.6.70 — Patch Bay, Stream Manager, sign in with your account, and the user manual"; body = docs/release-4.6.70-notes.md.
  - 11 assets: the Windows exe and blockmap, two dmgs and their blockmaps, the AppImage, the .deb, and latest.yml / latest-mac.yml / latest-linux.yml.
  - **Not published** (waits for Jeff).

## Install check on OVEVENTS (never OV)

1. **The signed CI installer, silent install (`/S`):** exit 0.
   - Installed `Ether.exe` 4.6.69.0 → **4.6.70.0**.
   - `Ether.exe` **Valid**, `resources\ha-setup.exe` **Valid**.
   - `resources\Ether-User-Manual.pdf` present.
2. **Started the installed Ether normally** and read its window through its debugging port (no input sent):
   - first screen: **"Sign in with your Ether account to get started."**
   - Startup log: `version: 4.6.70 packaged: true`; `clean launch — boot auto-resume SUPPRESSED … stations idle until AUTO` (nothing played or streamed).
   - The engine attached after the in-process fallback and took over at a song boundary; all five stations' live boards match the saved boards.
   - One `applySavedBoard` command timed out during that handover; the next check found every board matching. This is the known first-launch-after-update engine race (memory: cold-stage daemon race).
3. **Help → Documentation in the installed app:** the menu was not clicked (no input sent on Jeff's screen). The file it opens is in place and the code path is tested. The click itself is **UNVERIFIED**.

Ether 4.6.70 is left running on OVEVENTS at the sign-in screen.
