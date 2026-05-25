; Ether NSIS customizations.
;
; Phase 4 HA teardown (roadmap Item 3, decision #6): when the app is uninstalled,
; clear Windows auto-logon so the machine doesn't keep logging itself in after
; Ether is gone. ha-setup.exe writes HKLM + the LSA secret, so it needs elevation —
; ExecShell "runas" elevates it. This is BEST-EFFORT and never blocks the
; uninstall: a per-user uninstaller may not be elevated, and we don't wait on the
; result. The guaranteed teardown is the in-app "Keep My Station On Air → Disable"
; button, which always elevates and confirms the result before clearing config.

!macro customUnInstall
  IfFileExists "$INSTDIR\resources\ha-setup.exe" 0 +2
    ExecShell "runas" "$INSTDIR\resources\ha-setup.exe" 'disable --result "$TEMP\ether-ha-uninstall.json"' SW_HIDE
!macroend
