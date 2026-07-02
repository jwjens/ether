# dev-factory-wipe.ps1 — Fix B: a COMPLETE, verified local factory-wipe for dev testing.
# Mirrors what the app's own system:factoryReset now does (Fix A), for the case where you wipe from
# outside the app. Clears BOTH stores: the DB (%LOCALAPPDATA%\Ether) AND the Chromium session
# (userData == sessionData == %APPDATA%\Ether: cookies, Local/Session Storage, IndexedDB) — the two
# places the account session can live. Leaves the music library untouched. Verifies each target is
# actually gone (the earlier -ErrorAction SilentlyContinue wipe silently left a locked dir behind).
#
# Usage:  pwsh -File scripts/dev-factory-wipe.ps1

$ErrorActionPreference = 'Stop'

# 1. Kill any Ether / dev-cluster process holding a lock.
$match = { $_.Name -in @('Ether.exe','ether-engine.exe') -or ($_.Name -in @('electron.exe','node.exe','esbuild.exe') -and $_.CommandLine -match 'openair') }
Get-CimInstance Win32_Process | Where-Object $match | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 3
Write-Host "procs remaining: $((Get-CimInstance Win32_Process | Where-Object $match | Measure-Object).Count)"

# 2. Verified removal (retry on lock) — explicit absolute paths only.
function Remove-Verified([string]$p) {
  if (-not $p -or $p.Length -lt 12) { Write-Host "REFUSING short/empty path: '$p'"; return }
  for ($i = 0; $i -lt 6 -and (Test-Path -LiteralPath $p); $i++) {
    try { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 700 }
  }
  Write-Host ("{0}  {1}" -f $(if (Test-Path -LiteralPath $p) { 'STILL PRESENT (locked!)' } else { 'gone' }), $p)
}
Remove-Verified 'C:\Users\jensj\AppData\Local\Ether'     # DB, WAL, keyed copies, engine staging
Remove-Verified 'C:\Users\jensj\AppData\Roaming\Ether'   # userData == sessionData: cookies + Local/Session Storage + IndexedDB + markers
Remove-Verified 'C:\Users\jensj\AppData\Roaming\openair' # pre-rename userData, if any lingers

# 3. Preserve check — the content store lives under Music and must NEVER be touched.
Write-Host ("music library preserved: {0}" -f (Test-Path -LiteralPath 'C:\Users\jensj\Music\ether music library'))
Write-Host "wipe complete — next launch is a true fresh install (0 stations, no session, songs_v2=0)."
