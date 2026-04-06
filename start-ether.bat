@echo off
cd /d C:\openair

:: Start Vite dev server in background
start "Ether - Vite" /min cmd /c "npm run dev"

:: Wait until Vite is actually responding before opening Electron
echo Waiting for Vite...
:wait
timeout /t 2 /nobreak >nul
curl -s http://127.0.0.1:1420 >nul 2>&1
if errorlevel 1 goto wait

echo Vite ready. Starting Ether...
npm run electron:start
