# smoke-renderer.ps1 — renderer-mount smoke check. Boots the REAL window with ETHER_SMOKE=1; main.js
# asserts React mounted (#root has children) + no renderer console exception, writes [SMOKE] PASS/FAIL
# to the startup log, and exits. Guards the render/module-load layer (white-screen / packaged blank-
# screen class) in BOTH dev and packaged. This is a standing pre-Monday gate.
#
#   Dev:       pwsh -File scripts/smoke-renderer.ps1 -Mode dev
#   Packaged:  pwsh -File scripts/smoke-renderer.ps1 -Mode packaged -ExePath "C:\path\to\Ether.exe"
param([ValidateSet('dev','packaged')][string]$Mode = 'dev', [string]$ExePath = '')

$ErrorActionPreference = 'Stop'
$startupLog = "$env:APPDATA\Ether\ether-startup.log"       # logStartup target (userData = Roaming\Ether)
$stdoutLog  = "$env:TEMP\ether-smoke-$Mode.out"
if (Test-Path $startupLog) { Add-Content $startupLog "===SMOKE-RUN-MARK===" }  # so we only read this run's lines
Remove-Item $stdoutLog -ErrorAction SilentlyContinue

# 1. Clear the field.
$match = { $_.Name -in @('Ether.exe','ether-engine.exe') -or ($_.Name -in @('electron.exe','node.exe','esbuild.exe') -and $_.CommandLine -match 'openair') }
Get-CimInstance Win32_Process | Where-Object $match | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 2

# 2. Launch in smoke mode.
$env:ETHER_SMOKE = '1'
if ($Mode -eq 'dev') {
  $env:NODE_ENV = 'development'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run electron:dev' -WorkingDirectory 'C:\openair' -RedirectStandardOutput $stdoutLog -RedirectStandardError "$stdoutLog.err" -NoNewWindow -PassThru | Out-Null
} else {
  if (-not $ExePath -or -not (Test-Path $ExePath)) { Write-Host "packaged mode needs -ExePath to an existing Ether.exe"; exit 2 }
  Start-Process -FilePath $ExePath -RedirectStandardOutput $stdoutLog -RedirectStandardError "$stdoutLog.err" -PassThru | Out-Null
}

# 3. Poll the startup log (reliable in dev + packaged) and stdout (dev) for the verdict.
$verdict = $null
$deadline = (Get-Date).AddSeconds(75)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  foreach ($f in @($startupLog, $stdoutLog)) {
    if (Test-Path $f) {
      $raw = Get-Content $f -Raw -ErrorAction SilentlyContinue
      $scan = if ($f -eq $startupLog) { ($raw -split '===SMOKE-RUN-MARK===')[-1] } else { $raw }
      if ($scan -match '\[SMOKE\]\s+(PASS|FAIL)([^\r\n]*)') { $verdict = "$($Matches[1])$($Matches[2])"; break }
    }
  }
  if ($verdict) { break }
}

# 4. Clean up + report.
Get-CimInstance Win32_Process | Where-Object $match | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
if ($verdict) { Write-Host "SMOKE [$Mode]: $verdict"; if ($verdict -like 'PASS*') { exit 0 } else { exit 1 } }
else { Write-Host "SMOKE [$Mode]: NO VERDICT (timeout — treat as FAIL)"; exit 1 }
