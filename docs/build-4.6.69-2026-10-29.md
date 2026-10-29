# Build 4.6.69 (2026-10-29)

**Jeff (verbatim):** "Build 4.6.69 from release/1019 with the sign-in fix and the Settings freeze fix (3255f59). First fix
the test:one-switch failure (src/audio/attach-restore-sequence.test.ts:37) at its root cause, as its own commit; all checks
must pass. Then run the release checks: installer contents, size, the engine fingerprint check, and a real launch in
side-by-side mode that shows the queue filling from today's log on a station that has rows for the current hour, and the
sign-in screen coming first. Give me the installer path and stop. Don't install it anywhere."

**Installer:** `C:\openair\dist-electron\Ether Setup 4.6.69.exe` — 216,406,609 bytes, sha256 `2354fa07a99b6595…`, built
10:58 local from `136d882`. Local, unsigned, not published, not installed anywhere. Not pushed, not tagged.

## In it (on top of 4.6.68)

- `2f3126a` — opening Ether shows the account sign-in screen first, as before 2026-10-28.
- `3255f59` — Settings opens at once: the sync journal counts run on the screen-read worker
  (docs/settings-freeze-2026-10-29.md).
- `f9591b2` — test:one-switch: the attach-restore fixture writes station settings through the sanctioned writer.
  Root cause: the fixture built a `station_config_kv` shaped unlike the real table (no `uuid`) and filled it with a
  hand-rolled positional INSERT, bypassing the one writer §9 protects. It now has the real columns and uses
  `stationConfigKvSetLocal`, as electron/board-watch.test.js does — no exemption.
- `136d882` — version and changelog.

## Gates (on `136d882`)

- `tsc --noEmit`: 0 errors. (My first version of `f9591b2` failed it — a station list typed as mixed numbers and text;
  fixed inside that commit before the build.)
- vitest: 153 files, 1,257 tests, all pass.
- `test:sync` 75/75 · `test:one-switch` PASS · `test:db-release` ALL PASS · `verify:schema` PASS ·
  `test:ipc-contract` PASS · `test:preload-bridge` PASS.
- `test:rust` (full engine suite): 173 + 12 + 2 pass, 0 fail.
  - The first run failed one timing gate, `channel_rack_cost_one_and_twelve_channels` (row (a) p99 1.50 ms > 1 ms; on
    4.6.68 it was 0.29 ms), with no engine source change. At that time McAfee's scanner (`mcshield`) used ~50% of the
    processor and an installed Ether was running. Jeff: "Ether is closed on OVEVENTS; it's not a live machine, so never
    keep an installed Ether running here during tests." On a quiet machine (Ether closed, scanner 0%, total 5%): row (a)
    p99 0.115 ms, (b) 0.115 ms — PASS; then the whole suite again: PASS.

## Release checks

1. **Contents: PASS** (against the installed 4.6.68): app.asar 15,120 entries on both; the only differences are the
   renamed renderer bundles (4 in, 4 out). app.asar.unpacked: the same file list. In the package: no `isSetUp` start-up
   skip in the renderer; the on-air restart path present; Settings calls `sync:preflight-journal`; main.js has that
   handler; `syncJournal` is in electron/screen-read-queries.js.
2. **Size: PASS.** 216,406,609 bytes (+413 bytes on the 4.6.68 rebuild).
3. **Engine fingerprint: PASS** — `native/ether-audio.node built from this engine source (4c5e4ca6a1c3bd65)`; packaged
   engine `pe, engine source 4c5e4ca6a1c3bd65`; every app file the engine loads unpacked; HA helper present.
4. **Real launch, side by side: PASS.**
   - Packaged `win-unpacked\Ether.exe`, `ETHER_SMOKE=1`, `ETHER_SMOKE_FILL_STATION=2`, `--user-data-dir`, LOCALAPPDATA and
     APPDATA in `%TEMP%\ether-rc-4669`, on a stripped copy of this computer's database (sign-in, licence, account, Link,
     stream, cloud and AI keys removed with secure_delete; sync off; no JWT-shaped bytes). No installed Ether running.
   - **A station with rows for the current hour:** read-only check of the live database at 18:02Z — halloVeen (2) had 36
     pending rows in the 18:00Z hour (all four stations had rows).
   - **Queue from today's log:** `[SMOKE] fill station 2: queue 20 item(s)`; engine `[engine s2] logreader refill: 20
     pending from log (mode=on-time, queue=20)`.
   - **Sign-in screen first, on a set-up computer:** the copy was given a kept sign-in — an expired old-style pass with a
     fake signature in its `auth.bin`, encrypted with the copy's own protected storage. The build's own
     account-session.js on that copy: `isSetUp=true has=false` — exactly the case the first 4.6.68 sent straight to the
     station. The test window, read through its own debugging port (no input sent):
     `+4.9s window text: Sign in with your Ether account to get started. Sign in Sign up Remember me Sign in Forgot
     password?` — the first and only screen until the smoke closed. (The screenshot call returned nothing before the
     smoke exited; the window's text is the receipt.)
   - `[SMOKE] PASS — react_mounted=true root_children=1 renderer_error=false daemon_desired=true daemon_started=true
     daemon_log_staged=true station_count=5 air_isolated=true fill_station=2 queue=20 no_account=true`; exit 0.
   - No test process left; the copy deleted.

## UNVERIFIED (first use of the installed build)

- Settings on the installed 4.6.69: the ledger should show no `main-stall` naming `sync:preflight` /
  `sync:preflight-journal` and no `watchdog-late` when Settings opens (before: 8,836 ms and 9,962 ms on 4.6.68).
