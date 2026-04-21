@echo off
REM ── Ether launcher ─────────────────────────────────────────
REM Double-click this file to start Ether in dev mode.
REM Drag it to your taskbar or copy a shortcut to your Desktop
REM for one-click launching.
REM ──────────────────────────────────────────────────────────

title Ether - Broadcast Studio

REM Always run from the project folder regardless of where the .bat lives
cd /d C:\openair

REM Friendly banner
echo.
echo ================================================
echo   ETHER - Broadcast Studio
echo ================================================
echo.
echo   Starting Vite dev server + Electron...
echo   First boot can take ~10 seconds.
echo.
echo   Close this window to stop Ether.
echo.

REM Make sure dependencies are present (only installs if missing)
if not exist "node_modules\" (
  echo Installing dependencies for the first time...
  call npm install
  echo.
)

REM Launch Ether — runs Vite + Electron together
call npm run electron:dev

REM If Ether crashes or exits, hold the window open so you can read errors
echo.
echo ================================================
echo   Ether has closed.
echo ================================================
echo.
pause
