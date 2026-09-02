# v4.4.234 crash — electron-updater self-update hypothesis: DISPROVEN

Follow-up to `docs/crash-4.4.234-investigation-2026-09-02.md`.
Death window 21:31:12.9–21:31:15.5 local, ~8s after AUTH COMPLETE. Read-only throughout;
nothing changed.

**Verdict: the app did not self-update. Seven independent findings rule it out.**

---

## 1. Updater cache — a real download, but 16 minutes BEFORE the crash session

`%LOCALAPPDATA%\openair-updater\` (cache dir name confirmed by `resources\app-update.yml`:
`updaterCacheDirName: openair-updater`):

```
2026-08-11 17:15:11    206,345  current.blockmap
2026-08-11 17:15:11    206,345  pending/current.blockmap
2026-08-11 17:15:26  203,918,740  pending/Ether-Setup-4.4.186.exe
2026-08-11 17:15:26        169  pending/update-info.json
2026-09-01 21:14:03  283,356,912  installer.exe
```

`installer.exe` **is** the 4.4.234 installer — byte-identical to the published asset:

```
97aca74866bb3e7a602c7ce987a5efe094db5c3dc6927b18c87e9e67fd9d1080  openair-updater\installer.exe
97aca74866bb3e7a602c7ce987a5efe094db5c3dc6927b18c87e9e67fd9d1080  Ether-Setup-4.4.234.exe (from the release)
```

But its mtime is **21:14:03 — sixteen minutes before the crash session began (21:30:25)**, and it was
not rewritten during the session. `pending/` still holds only the stale 4.4.186 from 2026-08-11.
Nothing was downloaded while the app was dying.

## 2. There was nothing to update TO

```
v4.4.234  draft=false  pre=false  latest=true   2026-09-02T03:22:31Z
v4.4.233  draft=false  pre=false  latest=false
v4.4.231 ... v4.4.186
```

No drafts, no prereleases, no tag above v4.4.234 (`git ls-remote --tags`, version-sorted). The
published feed the app reads says:

```yaml
version: 4.4.234
path: Ether-Setup-4.4.234.exe
size: 283356912
```

Installed ProductVersion is **4.4.234.0**. Equal versions — electron-updater has no update to offer.

## 3. The app cannot auto-download, and cannot auto-install without a download

`electron/main.js:6343-6349`:

```js
let autoUpdater = null;
  const { autoUpdater: au } = require("electron-updater");
  autoUpdater = au;
  autoUpdater.autoDownload = false;          // ← no background download
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;                 // ← answers item 2: there is NO updater log, by design
```

`quitAndInstall()` appears exactly once (`:6387`) and only inside an IPC handler — renderer-initiated,
never on a timer. `checkForUpdates()` likewise (`:6357`). Nothing schedules either.

## 4. No installer executed at 21:31 — but one did at 21:28

McAfee's on-execute scanner records process launches. Across 04:25–04:40Z the only Ether installer
execution is:

```
04:28:10.447Z  Action Taken on File C:\Users\jensj\Downloads\Ether-Setup-4.4.234.exe ...
```

That is Jeff installing **manually from Downloads at 21:28:10**, which matches the install
completing at 21:29:57. **Nothing runs an installer at 21:31.**

## 5. Nothing on disk was rewritten at 21:31

An NSIS update replaces files. Install-directory timestamps (directories, since NSIS preserves file
stamps from the package):

```
21:29:50  locales
21:29:56  resources\app.asar.unpacked
21:29:57  resources
21:29:57  resources\native
21:29:57  <install root>
```

All 21:29:5x. A recursive scan for any file with `LastWriteTime >= 21:30:00` returns **nothing**.

## 6. Item 3 — the exhaustive grep, and an honest correction

The prior report's grep was **targeted** (a fixed term list, `electron/main.js` only), not
exhaustive. Stated plainly because it matters. Re-run across `electron/`, `audiod/`, `watchdog/`:

| Location | Call | Excluded because |
|---|---|---|
| `main.js:316` | `app.quit(); process.exit(0)` | single-instance bail, startup only; logs `POINT-2b` first — absent |
| `main.js:1271` | `app.exit(0)` | accountSignOut — writes `.ether-clean-exit` FIRST |
| `main.js:2601` | `app.exit(ok?0:1)` | SMOKE mode, gated on `ETHER_SMOKE === '1'` |
| `main.js:5413` | `app.exit(0)` | factoryReset IPC — writes `.ether-clean-exit` FIRST |
| `main.js:5423` | `app.relaunch(); app.exit(0)` | `app:relaunch` IPC — `markHaExpectedRestart()` writes `.ether-expected-restart` FIRST |
| `main.js:5935` | `app.relaunch(); app.exit(0)` | `relaunch` IPC — same sentinel first |
| `main.js:6386` | `app.relaunch(); app.exit(0)` | only when `!autoUpdater` |

**`app.exit()` genuinely does bypass `before-quit`** — it is the one call shape that would produce
the six negatives. But **every such path writes a sentinel before exiting**, and both sentinels are
stale (`.ether-clean-exit` 12:08:24 that day; `.ether-expected-restart` 2026-08-15). So no in-app
exit path ran. The watchdog's hard kill (`watchdog/platform/win32.js:22`, `taskkill /F /T`) is also
out: the daemon recorded `watchdog (none)` and the app logged `watchdogSpawned=false`.

## 7. Item 5 — Security log: INCONCLUSIVE, not negative

No 4688/4689 events in the window — but `auditpol /get` returned *"A required privilege is not held
by the client"* (needs elevation), so whether process auditing is even enabled could not be
established. **Absence here proves nothing.** (Unlike the WER check, where the registry confirmed
logging was enabled and Ether crashes had been archived before — there the silence was meaningful.)

---

## New observation: McAfee rates this build "Most Likely Malicious" — but did NOT act

```
04:28:10.447Z  Action Taken on File ...\Ether-Setup-4.4.234.exe with reputation 15 is: Would Block
04:28:10.450Z  Action Details:: File: Ether-Setup-4.4.234.exe , Mode: Enforce ,
               Scanner: On-Execute Scan , Detection Name: ATP/Suspect!f81ff250c479 ,
               Reputation: 15 [Most Likely Malicious] , ActionTaken: Would Block  Rule id: 265
```

**"Would Block" is observe-mode — it did not block.** Context that keeps this in proportion: the same
scanner says the same thing about Microsoft's own signed PowerShell twice in the same window
(`pwsh.exe`, reputation 15, `ATP/Suspect!8e874a450117`, "Would Block"), and pwsh is plainly still
running. The rule is reporting, not enforcing, and its verdict is noise here.

Worth flagging for the OV deployment regardless: if that rule is set to **Enforce** rather than
observe on a managed McAfee box, an Ether installer could be blocked outright. That is a deployment
risk, not this crash.

## Also worth recording: true process lifetime is ~63s, not ~50s

McAfee logged `ML Protect ... process id 15544` at **04:30:10.597Z**, but the app's own
`=== SESSION START ===` is at 04:30:25.776Z — **15 seconds** between process creation and the first
log line, on a 712 MB asar with an on-execute scanner attached. Process create 04:30:10 →
death ~04:31:13 = **~63 seconds**.

---

## Where this leaves the investigation

Ruled out so far: the `win.files` exclusion globs (prior report), electron-updater self-update
(this report), every in-app exit path, the HA watchdog, and McAfee enforcement.

Still true: the process vanished leaving no WER event, no Crashpad dir, no handler output, and no
sentinel — and it did so ~8s after AUTH COMPLETE, with a `ffmpeg.exe` child spawned ~2s prior.

The unchanged next measurement is **stderr from a terminal run**, which needs a human to sign in:

```
& "$env:LOCALAPPDATA\Programs\Ether\Ether.exe" 2>&1 | Tee-Object -FilePath "$env:TEMP\ether-stderr.log"
```

Sentry stays deprioritised, and the reasoning is now firmer than "probably": `Crashpad\` does not
exist, and no sentry directory or queued envelope exists under `%APPDATA%\Ether\`.
