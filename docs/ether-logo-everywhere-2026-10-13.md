# Ether logo everywhere — why the taskbar showed Electron's (2026-10-13)

## Jeff (verbatim)

> the Windows taskbar shows the Electron logo for Ether. Every place Ether appears must show the Ether logo, never
> Electron's: the taskbar, every window and pop-out window, the system tray, the desktop and Start menu shortcuts, the
> installer and uninstaller, Task Manager, and the audio engine/daemon process if it shows anywhere. Find which ones use
> the Electron icon today and why. Use the real Ether logo from the repo; if there's no proper multi-size .ico, tell me
> and don't make one up. Fix it in the next installer and show me a screenshot of the taskbar after.

> For the app id change: make sure it doesn't break anything tied to the old id (taskbar pins, notifications,
> auto-start, the single-instance lock, a running daemon finding the app). Remove the leftover "Electron" Start menu
> shortcut on OVEVENTS only, since it's from the dev copy. Air machines never had it. Confirm the taskbar shows the
> Ether logo on a clean install.

## The logo in the repo

`build-resources/icon.ico` (= `electron/assets/icon.ico`, same bytes): a proper multi-size .ico, 16/32/48/64/128/256 px,
32-bit PNG images, the purple Ether atom. Used as-is; nothing new was made.

## Each place, OVEVENTS 2026-10-13 (4.6.59 installed), checked read-only

| Place | Shows | Why |
|---|---|---|
| **Taskbar button** | **Electron logo** (pale blue atom, screenshot 09:54) | see below |
| Ether.exe itself | Ether logo | electron-builder `win.icon` = build-resources/icon.ico |
| Main window | Ether logo | `icon: WINDOW_ICON` (assets/icon.ico) |
| Pop-outs, splash | Ether logo | no own icon → the exe's icon (Ether) |
| System tray | Ether logo | assets/tray-icon.png (purple atom) |
| Start menu "Ether" shortcut | Ether logo | Ether.exe,0; app id com.ether.radio |
| Desktop shortcut | Ether logo | made by the installer, Ether.exe |
| Installer / uninstaller, Apps list | Ether logo | NSIS uses win.icon; DisplayIcon = Ether.exe,0 |
| Task Manager | "Ether", Ether logo | FileDescription "Ether", exe icon |
| Audio engine (ether-engine.exe) | "Ether", Ether logo | a byte-identical copy of Ether.exe (same sha256) |

**Why the taskbar was wrong:** Windows draws a taskbar button with the icon of the shortcut that carries the running
app's id (AppUserModelID). Ether declared `app.setAppUserModelId("ether")` (electron/main.js). The installer stamps its
shortcuts with electron-builder's appId, `com.ether.radio`. The only shortcut on OVEVENTS with the id `ether` was a
leftover dev shortcut, `Start Menu\Programs\Electron.lnk` → `C:\openair\node_modules\electron\dist\electron.exe`
(created 2026-04-17), so the taskbar drew Electron's logo for Ether.

**Fix (commit ce58ead):** `app.setAppUserModelId("com.ether.radio")`, the same id as the installed shortcuts.

## Nothing else used the old id

- Single-instance lock: Electron's lock is the user-data folder, not the app id.
- Auto-start (`autostart:enable`): `setLoginItemSettings` → a Run entry with Ether.exe's path.
- Audio daemon: found over the named pipe `\\.\pipe\ether-audiod`.
- Watchdog / HA auto-logon: start Ether.exe by path.
- Notifications: Ether shows none (no `new Notification` in electron/ or src/).
- Taskbar pins: none on OVEVENTS. A pin made on another machine while Ether ran under the old id would show as a
  separate button once; unpin it and pin Ether again.

## Leftover shortcut removed (OVEVENTS only)

`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Electron.lnk` moved out of the Start menu (kept in the session
scratchpad as `Electron.lnk.removed-from-start-menu`, not deleted).

## Still to confirm

The taskbar screenshot after Jeff installs the new build on OVEVENTS. With the stale shortcut gone, OVEVENTS is the
clean-install case (the only shortcut carrying Ether's id is the installer's own).
