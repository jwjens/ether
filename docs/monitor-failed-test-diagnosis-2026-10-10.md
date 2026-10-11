# MONITOR failed test — diagnosis (2026-10-10)

**Jeff's report (verbatim):** "with MONITOR all the way down, ALL faders still play out of the local speakers, not just
announcements." Rule: every sound reaching any local output passes through MONITOR; only exception is PFL to a dedicated
cue device.

Read-only. Nothing changed. Machine inspected: hostname **OVEVENTS** (user `jensj`, the box with `C:\openair`). It is
currently airing station s2 (daemon log shows segues/spots through 05:43Z), so no commands were sent to the engine.

## 1. What is installed and running — the fix is NOT on this machine

| Thing | Receipt | Verdict |
|---|---|---|
| Installed app | `C:\Users\jensj\AppData\Local\Programs\Ether\` · Ether.exe ProductVersion 4.6.59 · `app.asar` 260,388,000 B, mtime **2026-10-06 18:17:06** | Matches the **ANNOUNCE-WIP 6f54afe** build (installer 18:18:13 10/6, sha256 `0efb3b70…`), not the fix build (11:41 10/7) |
| Fix code in installed asar | `grep -c local-output-sense app.asar` → **0** (fix build's `dist-electron\win-unpacked` asar → 4) | Fix renderer/main code absent |
| Installed native engine | `app.asar.unpacked\native\ether-audio.node` 6,089,216 B, sha256 `0ebf6ccb…` = `git show 515698c^:native/ether-audio.node` | **Pre-fix** (fix = 6,095,360 B, `9f7d7079…`) |
| Running daemon | `ether-engine.exe` PID 12696, parent Ether.exe 33072, started **2026-10-10 15:23:36** (same launch as the app, 15:23:34) — so it WAS restarted with the app | |
| Native the daemon loaded | `%LOCALAPPDATA%\Ether\engine\native\ether-audio.node` (staged copy, mtime 2026-10-05 20:05), sha256 `0ebf6ccb…` | **Pre-fix** |
| Stage marker | `%LOCALAPPDATA%\Ether\engine\version.txt` = `4.6.59`, written 2026-10-06 09:22 | |
| Uninstall registry | HKCU `Ether 4.6.59`, no install date | Can't tell builds apart (all are "4.6.59") |

**So on OVEVENTS, MONITOR-down → all faders audible is the pre-fix engine behaving as before.** The test did not run
against `e34a3d36…`.

## 2. Second defect: installing the fix build would NOT have updated the daemon anyway

`audiod/stage-engine.js:95` — the daemon runs from the staged copy under `%LOCALAPPDATA%\Ether\engine`, and staging
is skipped when `version.txt === app version`:

```js
if (fs.existsSync(t.exe) && fs.existsSync(t.script) && readText(marker) === version) return t;
```

The fix build is labelled **4.6.59** (no bump, by policy), and the marker already says `4.6.59`. Result: install
`e34a3d36…`, fully close, reopen → the daemon still loads the **pre-fix `ether-audio.node`** (and pre-fix daemon .js).
The renderer half of the fix would be live; the engine half (AUX × MONITOR, `native/src/audio.rs`, `localout.rs`)
would not. That would reproduce "nothing changed" even on a correct install. The same-version-unbumped-build policy
(2026-10-05) and this version-keyed staging conflict.

Also latent at `audiod/stage-engine.js:113`: the native `.node` copy is `cpSoft` — if a detached daemon survives the
app close, the old native stays loaded/locked and is silently kept, even across a version bump.

## 3–4. Not done (machine is on air)

Live `master_monitor_vol` / per-station `monitor_vol`, device mapping (main / AUX / PFL / Windows default), and
other programs on the device were **not** read: that needs commands to the running daemon on an airing box. Moot for
this machine (the pre-fix engine is loaded), but **UNVERIFIED** for wherever Jeff actually tested if that was another box.

## Open question for Jeff

Was the failed test on **OVEVENTS**, or on another machine? If another, item 1 needs re-running there (same three
hashes: installed `ether-audio.node`, staged `%LOCALAPPDATA%\Ether\engine\native\ether-audio.node`, `version.txt`).

## Proposed fix (not built — awaiting approval)

Make staging content-keyed, not version-keyed: re-stage when the installed `ether-audio.node` / daemon .js hash differs
from the staged one (or stamp the marker with version + build sha), and surface "daemon engine ≠ installed engine" as a
Health Monitor sense. Then re-test with the fix build after a full close/reopen and confirm the staged native hash is
`9f7d7079…` before touching MONITOR.

Side note (one line, not investigated): `ether-startup.log` has a flood of `daemon cmd timeout: getState` at 04:48Z.
