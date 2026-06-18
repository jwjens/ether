@echo off
title Reset Ether - Delete All Data On This Computer
echo.
echo  ============================================================
echo   RESET ETHER
echo  ============================================================
echo.
echo   This DELETES all Ether data on THIS computer:
echo     - stations, library list, schedule, users, settings
echo.
echo   Your actual audio files (the music) are NOT deleted.
echo   Other computers on your account are NOT affected.
echo.
echo   After this, Ether opens fresh at the sign-in screen.
echo.
set /p ok="  Type YES and press Enter to wipe (anything else cancels): "
if /I not "%ok%"=="YES" goto :cancel

echo.
echo  Closing Ether...
taskkill /F /IM Ether.exe /T >nul 2>&1
taskkill /F /IM ether-engine.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Deleting data...
rmdir /S /Q "%LOCALAPPDATA%\Ether" 2>nul
rmdir /S /Q "%APPDATA%\openair" 2>nul
rmdir /S /Q "%APPDATA%\com.ether.radio" 2>nul

echo.
echo  ============================================================
echo   Done. All Ether data on this computer has been wiped.
echo   Reopen Ether for a clean first-time setup.
echo  ============================================================
echo.
pause
exit /b 0

:cancel
echo.
echo  Cancelled. Nothing was deleted.
echo.
pause
exit /b 0
