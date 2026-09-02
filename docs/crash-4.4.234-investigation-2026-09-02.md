# v4.4.234 Windows crash — evidence log (2026-09-02)

Report: Ether v4.4.234, installed from the signed NSIS installer, crashes ~30s after launch.
Machine: jensj (Windows 11 Pro for Workstations, McAfee ENS present).
Install: `C:\Users\jensj\AppData\Local\Programs\Ether`, Ether.exe ProductVersion **4.4.234.0**.

**Nothing was changed during this investigation. Read-only throughout.**

---

## STEP 0 — baseline. The "first packaged artifact" premise is FALSE.

Windows installers shipped on three prior releases:

| Release | Windows asset |
|---|---|
| v4.4.229 | `Ether-Setup-4.4.229.exe` |
| v4.4.230 | `Ether-Setup-4.4.230.exe` |
| v4.4.231 | `Ether-Setup-4.4.231.exe` |
| v4.4.233 | **none** (the failed-signing arc) |
| v4.4.234 | `Ether-Setup-4.4.234.exe` |

4.4.234 is the first **signed** Windows build, NOT the first **packaged** one.

Packaged Ether demonstrably ran on THIS machine before, from WER's own archive
(`C:\ProgramData\Microsoft\Windows\WER\ReportArchive`):

```
AppCrash_Ether-Setup-4.1._...   05/18/2026 13:38:19
Critical_Ether.exe_...          05/19/2026 18:48:04
AppHang_Ether-Setup-4.3._...    05/30/2026 09:03:57
Critical_Ether.exe_...          05/31/2026 12:26:02
AppHang_Ether.exe_...           06/23/2026 16:34:23
```

McAfee's EnhancedRemediation log also records `Ether Setup 4.4.229.exe` executing on 2026-08-19.

**Limit of this evidence — stated plainly:** `ether-startup.log` was TRUNCATED on 2026-08-26
(its own first line says so; it had reached 341,942,289 bytes / 1,259,357 lines). Surviving
coverage is 2026-08-26 to now, and within it there are **22 sessions with `packaged: false`**
(dev, Electron 41.1.0) and **exactly one with `packaged: true`** — 4.4.234. So the surviving logs
CANNOT establish whether a recent packaged build ran stably for more than a minute. That answer
has to come from Jeff. What they do establish: packaged builds are not new here, and this machine
has crashed packaged Ether before (May/June).

---

## The death timeline (local times, UTC-7; log stamps are UTC)

| Local | Source | Event |
|---|---|---|
| 21:30:25.776 | ether-startup.log | `=== SESSION START ===` / `version: 4.4.234  packaged: true  pid: 15544` |
| 21:30:25.790 | ether-startup.log | `createSplash() done` |
| 21:30:26.556 | ether-startup.log | `ready-to-show fired`, `did-finish-load fired` |
| 21:30:26.976 | ether-startup.log | `[audiod-client] connected to daemon (probe)` |
| 21:30:27.515 | ether-startup.log | `HANDOVER complete — playout on daemon (AUDIO_DAEMON=true)` |
| 21:30:2x | ether-audiod.log | `[RUST] Station 1..8 audio output opened (48000Hz 2ch)` — native addon loads and runs |
| 21:30:40.927 | ether-startup.log | `15s fallback check — window already visible, no action needed` |
| 21:31:03.923 | ether-startup.log | `SIGN-IN COMPLETE` |
| **21:31:05.812** | ether-startup.log | `AUTH COMPLETE — account signed in + PIN accepted` — **last app log line** |
| 21:31:10.592 | McAfee ATP | ML Protect begins monitoring pid 33936 = `app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe` |
| 21:31:12.915 | filesystem | `Session Storage/000003.log` written — **renderer still alive** |
| 21:31:15.481 | ether-audiod.log | `ORPHANED — owner 15544 / watchdog (none) / spawner 15544 all gone` |
| 21:32:00.978 | ether-audiod.log | `ORPHANED for 45s with no owner — shutting the engine down` |

**Lifetime approx. 50 seconds. Death occurred 7-9 seconds AFTER auth completed**, inside the window
21:31:12.9 to 21:31:15.5. It is not an idle 30-second timer — startup and sign-in both fully
succeeded first.

---

## The death was silent AND abnormal — six independent negatives

| Expected on that failure mode | Handler | Present? |
|---|---|---|
| `UNCAUGHT: <msg>` | `main.js:97` `process.on('uncaughtException')` | **NO** |
| `UNHANDLED_REJECTION: <r>` | `main.js:98` | **NO** |
| `render-process-gone: reason=...` | `main.js:2587` | **NO** |
| WER `Application Error` / `AppHang` event | Windows | **NO** |
| Crashpad report | `%APPDATA%\Ether\Crashpad\` | **directory does not exist** |
| `.ether-clean-exit` refreshed | `main.js:3596` `before-quit` | **NO** — stamped 12:08:24, nine hours earlier |

WER is **enabled** on this box (no `Disabled` / `LoggingDisabled` set) and has archived Ether.exe
crashes before, so its silence here is meaningful rather than vacuous.

`before-quit` never ran, which main.js itself treats as the crash signature:

> `// A crash never runs before-quit, so the daemon survives a crash (audio continues) as intended.`

The daemon behaved exactly that way — never told to shut down, went ORPHANED, timed itself out 45s
later. **The app did not quit. It was killed, or died in a way that bypassed every handler it has.**

The only in-tree path that exits without `before-quit` is the single-instance-lock bail
(`main.js:315-316`, `app.quit(); process.exit(0);`). That runs at startup, not at t+50s, and it
logs `POINT-2b` first — which is absent.

---

## STEP 2 — prime suspect #1 (the `win.files` exclusion globs) is DISPROVEN

Installed `resources\app.asar.unpacked\node_modules\onnxruntime-node\bin`:

```
napi-v3/win32/arm64/onnxruntime.dll
napi-v3/win32/arm64/onnxruntime_binding.node
napi-v3/win32/arm64/onnxruntime_providers_shared.dll
napi-v3/win32/x64/onnxruntime.dll
napi-v3/win32/x64/onnxruntime_binding.node
napi-v3/win32/x64/onnxruntime_providers_shared.dll
```

All six win32 binaries present; `linux/` and `darwin/` correctly absent. The globs did exactly what
they were scoped to do. Also present and intact: `better-sqlite3`, `ffmpeg-static`, `sharp`, and
`ether-audio.node` in BOTH `resources\native\` and `app.asar.unpacked\native\`.

Native loading is proven working at runtime, not merely on disk: the Rust engine opened audio
outputs for eight stations and completed the in-process to daemon handover.

## Suspect #2 (every native addon now Authenticode-signed) — NOT disproven, one thread open

`ffmpeg.exe` was signed for the first time in this build (it appears in the CI signed-file list),
and an `ffmpeg.exe` child was spawned at 21:31:10.592 — about two seconds before the app died.
McAfee logged only `ML Protect cloud scanner will monitor process` for it; **no block, no
containment, no termination** appears in AdaptiveThreatProtection, ExploitPrevention,
DynamicApplicationContainment, SelfProtection, ThreatPrevention or EnhancedRemediation across the
21:30:20-21:31:40 window. McAfee is present and interested, but is not recorded as the killer.

---

## What could NOT be obtained here

- **Sentry (STEP 1a)** — no auth token on this machine, and no queued envelopes on disk
  (`%APPDATA%\Ether\` has no sentry directory), so either events were delivered or the main process
  never initialised Sentry. The dashboard has to be checked by hand.
- **stderr (STEP 1b)** — requires launching the installed exe from a terminal and signing in, which
  needs a human at the keyboard.

## The measurements that would settle it

1. **Sentry dashboard** for 4.4.234 around `2026-09-02T04:31:13Z`.
2. **Run the installed exe from a terminal** and sign in, capturing stderr:
   `& "$env:LOCALAPPDATA\Programs\Ether\Ether.exe" 2>&1 | Tee-Object -FilePath "$env:TEMP\ether-stderr.log"`
3. If both are ambiguous: STEP 4 bisect — `npm run electron:build:win` (unsigned, same commit).
   Stable unsigned plus crashing signed isolates it to packaging/signing.

## Recommendation

**Do not revert the packaging change on this evidence.** Suspect #1 is disproven at the file level
and contradicted at runtime; suspect #2 has a coincidence in time but no logged mechanism.
Reverting `win.files` would restore a hard-failing signing step and would not be aimed at anything
the evidence supports. Get stderr or Sentry first.
