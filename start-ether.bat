start "Vite" cmd /k "cd C:\openair && npm run dev"
timeout /t 8
start "Electron" cmd /k "cd C:\openair && npm run electron:start"
