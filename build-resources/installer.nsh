; Ether NSIS customizations.
;
; Phase 4 HA teardown (roadmap Item 3, decision #6): when the app is uninstalled,
; clear Windows auto-logon so the machine doesn't keep logging itself in after
; Ether is gone. ha-setup.exe writes HKLM + the LSA secret, so it needs elevation —
; ExecShell "runas" elevates it. This is BEST-EFFORT and never blocks the
; uninstall: a per-user uninstaller may not be elevated, and we don't wait on the
; result. The guaranteed teardown is the in-app "Keep My Station On Air → Disable"
; button, which always elevates and confirms the result before clearing config.

;
; ONLY ON A REAL UNINSTALL. An update runs the OLD version's uninstaller with --updated
; (electron-builder installUtil.nsh), and the template inserts customUnInstall unconditionally
; (uninstaller.nsh), so without this guard every update of an install that holds ha-setup.exe raised a
; UAC prompt to DISABLE auto-logon (docs/ha-setup-installer-check-2026-10-05.md). ${isUpdated} is set by
; that --updated flag; an update now leaves auto-logon exactly as it was.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\resources\ha-setup.exe" 0 +2
      ExecShell "runas" "$INSTDIR\resources\ha-setup.exe" 'disable --result "$TEMP\ether-ha-uninstall.json"' SW_HIDE
  ${endIf}
!macroend

;  STOP THE OLD ETHER — APP, WATCHDOG AND AUDIO ENGINE — BEFORE INSTALLING (2026-10-27).
;
; Jeff: "The installer stops the old audio engine and the watchdog cleanly before installing, so a new version never
; runs on an old engine." This used to force-close Ether.exe only and deliberately leave the detached audio engine
; (ether-engine.exe) playing for a "gapless update", so a new version could start on the old engine. Now
; build-resources/stop-ether.ps1 asks the app to Stop & Quit (--stop-and-quit, 4.6.67+), stands the watchdog down with
; .ether-clean-exit, asks the engine to shut down over its pipe, and only then ends whatever is left; every step goes to
; %TEMP%\ether-installer-stop.log. The taskkill lines below are the backstop if PowerShell cannot run. Hidden, before
; electron-builder's own running-app check, on every install and update (silent ones included).
!macro customInit
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop-ether.ps1" "${BUILD_RESOURCES_DIR}\stop-ether.ps1"
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-ether.ps1"'
  nsExec::Exec 'taskkill /F /T /IM Ether.exe'
  nsExec::Exec 'taskkill /F /IM ether-engine.exe'
  Sleep 1000
!macroend
