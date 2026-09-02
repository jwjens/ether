# v4.4.234 crash — widened search: the dangling object is not ours

Third report. Prior: `crash-4.4.234-investigation-2026-09-02.md`,
`crash-4.4.234-updater-hypothesis-2026-09-02.md`.
Signature: exit `0x80000003` (STATUS_BREAKPOINT), Chromium dangling-`raw_ptr` guide URL on stderr,
intermittent, ~8s after AUTH COMPLETE. Read-only; nothing changed.

## Correction carried forward

The 12 window-send guards committed earlier are **hygiene, not the fix**, and the evidence argues
against them being the fix: `webContents.send()` on a destroyed window throws a JS `TypeError`,
which `process.on('uncaughtException')` (`main.js:97`) would have written to the startup log as
`UNCAUGHT:`. **There is no `UNCAUGHT:` line.** Those sites did not fire.

---

## Item 2, 3, 4 — swept, no app-code candidate found

Every Chromium-side surface the app touches, and whether it can dangle post-auth:

| Surface | Where | Verdict |
|---|---|---|
| `session.defaultSession.clearStorageData()` / `clearCache()` | `main.js:1167-1168` | Only inside `_wipeLocalIdentityAndData` — factory reset / sign-out wipe. Not a post-auth path. |
| `webRequest.onHeadersReceived` | `main.js:2535` | Registered ONCE in `createWindow`. Never re-registered. |
| `setPermissionCheckHandler` / `setPermissionRequestHandler` | `main.js:2684, 2692` | Registered once in `createWindow`. |
| `setDisplayMediaRequestHandler` | `main.js:6635` | Registered once, on demand. |
| `powerMonitor.on(suspend/resume/lock/unlock)` | `main.js:3348-3351` | Plain JS scheduler calls. |
| `desktopCapturer.getSources` | `main.js:6605, 6637, 7883` | Renderer-initiated only. |
| `protocol.handle` / `register` / `intercept` | — | **Not used anywhere.** |
| `utilityProcess` | — | **Not used anywhere.** |
| `MessageChannelMain` / `MessagePortMain` | — | **Not used anywhere.** |
| `webFrameMain` | — | **Not used anywhere.** |
| `session.fromPartition` | — | **Not used anywhere — there is NO per-account session swap after sign-in.** |
| `setWindowOpenHandler` | — | Not used. |

**Item 4 is answered negatively and specifically:** there is no partition/session swap post-login.
The only session-scoped handlers are attached once in `createWindow` and never torn down or
re-registered.

**Item 3 is answered:** the `ffmpeg.exe` child at 04:31:10 is spawned with plain
`child_process.spawn` / `execFile` (`main.js:6670, 6708, 6775, 9721`, `video-engine.js:169, 184`).
No `utilityProcess`, no `MessagePort` attached. It is a bare OS child process and carries no
Chromium lifetime — out of scope for this crash class.

**Item 2, the two timers, re-examined:**

- `main.js:1712` (8000 ms race) lives inside **`_swapDatabaseFileGated`** — the cloud-restore /
  database-swap path. It does not run at startup or after sign-in; it runs only on an explicit
  restore. Touches `audiodClient` and `better-sqlite3`, nothing Chromium.
- `main.js:3164/3165` `runLibrarySync` (4 s, then 30 s) — `fetch` + SQLite only.
- `main.js:3292` `setInterval(tick, 8000)` — member-sync. An 8-second cadence that starts after
  account resolution, so it *is* timing-plausible, but `tick` is `SyncEngine.syncCycle()`:
  HTTP + SQLite. No Chromium object.

Nothing scheduled in the 04:31:05–04:31:15 window touches a Chromium-side lifetime.

---

## Item 1 — the lead, and it is a strong one

### Installed version, hard data

```
package.json  devDependency:  electron ^41.1.0
package-lock:  node_modules/electron => 41.1.0
installed:                             41.1.0
```

Published 41.x line (npm, 2026-09-02):

```
41.0.0 41.0.1 41.0.2 41.0.3 41.0.4 41.1.0 41.1.1 41.2.0 41.2.1 41.2.2 41.3.0
41.4.0 41.5.0 41.5.1 41.5.2 41.6.0 41.6.1 41.7.0 41.7.1 41.7.2 41.8.0 41.9.0
41.9.1 41.9.2 41.10.0 41.10.1 41.10.2 41.10.3 41.10.4 41.10.5 41.10.6 41.10.7
```

**41.1.0 is the 6th of 32 releases in its own major. The newest is 41.10.7.** The declared range
`^41.1.0` already permits 41.10.7 — only the lockfile is holding it at 41.1.0. This is 26 patch
releases of un-picked-up fixes, available with no semver change at all.

**Electron 41 is also end-of-support.** Electron supports the latest three majors; 44 has shipped.
41.x receives no further fixes.

### The matching upstream bug

**PR #52546 — `fix: dangling rawptr NativeWindow::primary_web_contents_view_`**, merged 2026-07-30.
The dangling pointer is `NativeWindow::primary_web_contents_view_`, left dangling **after the
`electron::api::WebContents` was destroyed**. The fix replaces manual `raw_ptr` management with
`views::ViewTracker` so the view's lifetime is tracked automatically.

Why this fits our signature point for point:

- It is a **Chromium-internal lifetime** (`NativeWindow` → destroyed `WebContents` view), not a JS
  object — so it produces **no JS exception and no `UNCAUGHT:` line**, exactly what we observe.
- The dangling-`raw_ptr` detector fires as a **`CHECK`**, aborting with `STATUS_BREAKPOINT`
  (`0x80000003`) — our exact exit code — and prints the `unretained_dangling_ptr_guide.md` URL.
- It is a **teardown race**, so it is intermittent — matching "does not reproduce every run".
- No WER event and no Crashpad report is consistent with a deliberate `CHECK` abort rather than an
  unhandled structured exception.

**Shipped in: `43.4.1` (2026-08-18) and `44.0.0-alpha.9`. Backported only to `43-x-y` (#52939) and
`44-x-y` (#52570). Never backported to 41.x — and it never will be, because 41 is EOL.**

---

## What I can and cannot claim

**Cannot:** that #52546 is our crash. There is no symbolized frame naming `NativeWindow` (the frames
are misattributed in the stripped build, per the brief), so this is a signature match plus an
exhaustive negative on our own code — not proof.

**Can:** the app runs an **end-of-support Electron, 26 patch releases behind inside its own major**,
which is a defect independent of this crash; and the one upstream bug whose description matches this
crash class exactly is fixed in 43.4.1 and absent from every 41.x build.

## Recommended sequence

**Step 1 — free, no semver change.** `npm i -D electron@41.10.7` (or delete the lockfile pin and
reinstall). Same major, same APIs, 26 patch releases of fixes. **Does NOT contain #52546.** Worth
doing regardless of this crash.

**Step 2 — the actual candidate fix.** Upgrade to **43.4.1+** (or 44.x) to pick up #52546 and return
to a supported line. This is a major upgrade across two majors and needs its own test pass —
Chromium, V8 and Node all move.

Do **not** do both at once if the goal is to learn which one mattered.

## Verification protocol (Jeff's, recorded so it is not skipped)

An intermittent bug cannot be cleared by one clean run. For any change:

```
npm run electron:build:win        # unsigned, local
```

Launch **10 times**, sign in each time, record survival past the ~63s mark. Run the identical
protocol on the **unfixed** build for a baseline in the same session, on the same machine. Report
survival counts, not impressions. A build that survives 10/10 against a baseline that dies 3/10 is
evidence; one clean run is not.

Sign-in is required each time, so this needs a human at the keyboard.
