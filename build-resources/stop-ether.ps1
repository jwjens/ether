# stop-ether.ps1 - run by the installer (installer.nsh customInit) BEFORE anything is installed: stop the running Ether,
# its keep-on-air watchdog and its audio engine, cleanly where they let us, so a new version never runs on an old engine.
#
# Jeff, 2026-10-27: "The installer stops the old audio engine and the watchdog cleanly before installing, so a new version
# never runs on an old engine." (4.6.66 on OV: the install left the old engine running; the old installer said so on
# purpose - "gapless update". docs/engine-missing-catalogue-4.6.66-2026-10-27.md)
#
#   1. The app: if the main Ether app is running, start "<its Ether.exe> --stop-and-quit". 4.6.67+ receives that as a second
#      instance and does its own Stop & Quit (stands the watchdog down, shuts its engine, writes .ether-clean-exit). Older
#      versions ignore the flag (they only raise their window). Wait up to 20 s for the app to exit.
#   2. The watchdog: write .ether-clean-exit (its "the user quit - do not respawn"), then end any Ether.exe still running.
#   3. The engine: send the daemon its own "shutdown" over its pipe; wait up to 15 s for ether-engine.exe to exit; end it
#      only if it is still there.
#   4. Verify nothing is left. Every step is written to %TEMP%\ether-installer-stop.log. Never fails the install.
$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'ether-installer-stop.log'
function Say($m) { $line = "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) $m"; Add-Content -Path $log -Value $line -ErrorAction SilentlyContinue }
function Procs { Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in 'Ether.exe', 'ether-engine.exe' } }
function Kind($p) {
  $c = [string]$p.CommandLine
  if ($p.Name -eq 'ether-engine.exe' -or $c -match 'ether-audiod\.js') { return 'engine' }
  if ($c -match '--ether-watchdog') { return 'watchdog' }
  if ($c -match '--type=') { return 'helper' }
  return 'app'
}
function WaitGone([scriptblock]$what, [int]$sec) {
  $end = (Get-Date).AddSeconds($sec)
  while ((Get-Date) -lt $end) { if (-not (& $what)) { return $true }; Start-Sleep -Milliseconds 500 }
  return -not (& $what)
}

Say "=== installer: stopping Ether before install ==="
$all = @(Procs)
foreach ($p in $all) { Say ("running: {0} pid {1} ({2}) {3}" -f $p.Name, $p.ProcessId, (Kind $p), $p.ExecutablePath) }
if (-not $all.Count) { Say "nothing running"; exit 0 }

# 1. The app - its own Stop & Quit.
$app = @($all | Where-Object { (Kind $_) -eq 'app' }) | Select-Object -First 1
if ($app -and $app.ExecutablePath) {
  Say "app pid $($app.ProcessId): asking it to Stop & Quit ($($app.ExecutablePath) --stop-and-quit)"
  try { Start-Process -FilePath $app.ExecutablePath -ArgumentList '--stop-and-quit' -WindowStyle Hidden | Out-Null } catch { Say "could not ask: $($_.Exception.Message)" }
  $ok = WaitGone { @(Procs | Where-Object { (Kind $_) -eq 'app' }).Count } 20
  Say ($(if ($ok) { "app: exited on its own" } else { "app: still running after 20 s (a version without --stop-and-quit, or busy)" }))
}

# 2. The watchdog - told the user quit, then anything left of Ether.exe ends.
try {
  $ud = Join-Path $env:APPDATA 'Ether'
  if (Test-Path $ud) { Set-Content -Path (Join-Path $ud '.ether-clean-exit') -Value ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) ; Say "watchdog: .ether-clean-exit written (stand down, do not respawn)" }
} catch { Say "watchdog: sentinel not written: $($_.Exception.Message)" }
$left = @(Procs | Where-Object { $_.Name -eq 'Ether.exe' -and (Kind $_) -ne 'engine' })
foreach ($p in $left) { Say ("ending {0} pid {1} ({2})" -f $p.Name, $p.ProcessId, (Kind $p)); try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }

# 3. The engine - its own shutdown, over its pipe.
if (@(Procs | Where-Object { (Kind $_) -eq 'engine' }).Count) {
  try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'ether-audiod', [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(3000)
    $w = New-Object System.IO.StreamWriter($pipe); $w.AutoFlush = $true
    $w.WriteLine('{"id":1,"cmd":"shutdown"}')
    Start-Sleep -Milliseconds 400
    $pipe.Dispose()
    Say "engine: asked to shut down over \\.\pipe\ether-audiod"
  } catch { Say "engine: its pipe did not answer ($($_.Exception.Message))" }
  $ok = WaitGone { @(Procs | Where-Object { (Kind $_) -eq 'engine' }).Count } 15
  if ($ok) { Say "engine: exited on its own" }
  else {
    foreach ($p in @(Procs | Where-Object { (Kind $_) -eq 'engine' })) { Say "engine: still running after 15 s - ending pid $($p.ProcessId)"; try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
  }
}

# 4. Verify.
Start-Sleep -Milliseconds 500
$rest = @(Procs)
if ($rest.Count) { foreach ($p in $rest) { Say ("STILL RUNNING: {0} pid {1} ({2})" -f $p.Name, $p.ProcessId, (Kind $p)) } }
else { Say "stopped: no Ether, watchdog or engine process left" }
exit 0
