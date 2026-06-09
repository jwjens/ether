#Requires -Version 5.1
Set-StrictMode -Version Latest

# --- Configuration ---
$EXPECTED_SIZE = 83673088
$APPDATA_DIR   = $env:APPDATA
$OV_FOLDER     = "$APPDATA_DIR\com.ether.radio"
$OV_BAK_FOLDER = "$APPDATA_DIR\com.ether.radio.bak"
$OV_DB         = "$OV_FOLDER\openair.db"
$BACKUP_DB     = "$OV_FOLDER\openair-backup-2026-05-19.db"
$ETHER_EXE     = "C:\openair\dist-electron\win-unpacked\Ether.exe"
$TS            = Get-Date -Format "yyyyMMdd-HHmmss"
$APP_LOG       = "C:\openair\fresh-install-app-$TS.log"
$APP_ERR_LOG   = "C:\openair\fresh-install-app-$TS.stderr.log"
$WRAPPER_LOG   = "C:\openair\fresh-install-wrapper-$TS.log"
$SCHEMA_LINE   = '[DB] Schema ready'
$TIMEOUT_SEC   = 30

# --- Helpers ---
"" | Set-Content $WRAPPER_LOG -Encoding UTF8

function wLog([string]$msg) {
    $line = "$(Get-Date -Format 'HH:mm:ss.fff')  $msg"
    Add-Content $WRAPPER_LOG -Value $line -Encoding UTF8
    Write-Host $line
}

function Bail([string]$reason, [string]$ovDataAt = "") {
    wLog "*** STOP: $reason"
    Write-Host ""
    Write-Host "===================================================" -ForegroundColor Red
    Write-Host "  STOPPED -- action required" -ForegroundColor Red
    Write-Host "  $reason" -ForegroundColor Red
    if ($ovDataAt -ne "") {
        Write-Host "" -ForegroundColor Yellow
        Write-Host "  YOUR OV DATA IS AT: $ovDataAt" -ForegroundColor Yellow
        Write-Host "  DO NOT let anything overwrite that folder." -ForegroundColor Yellow
        Write-Host "  Manual restore:" -ForegroundColor Yellow
        Write-Host "    1. Remove '$OV_FOLDER' if it exists" -ForegroundColor Yellow
        Write-Host "    2. Rename-Item '$ovDataAt' 'com.ether.radio'" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Wrapper log: $WRAPPER_LOG" -ForegroundColor Cyan
    Write-Host "===================================================" -ForegroundColor Red
    exit 1
}

# --- PRE-FLIGHT ---
wLog "=== fresh-install-test wrapper started ==="
wLog "PRE-FLIGHT: verifying OV DB and backup are both $EXPECTED_SIZE bytes"

if (Test-Path $OV_BAK_FOLDER) {
    Bail ".bak already exists at $OV_BAK_FOLDER -- leftover from a prior run. Remove it manually before proceeding."
}
if (-not (Test-Path $OV_DB)) {
    Bail "OV DB not found: $OV_DB"
}
$ovSize = (Get-Item $OV_DB).Length
if ($ovSize -ne $EXPECTED_SIZE) {
    Bail "OV DB size mismatch: got $ovSize, expected $EXPECTED_SIZE -- aborting before touching anything."
}
wLog "PRE-FLIGHT: OV DB OK  size=$ovSize  path=$OV_DB"

if (-not (Test-Path $BACKUP_DB)) {
    Bail "Safety-net backup not found: $BACKUP_DB"
}
$bakSize = (Get-Item $BACKUP_DB).Length
if ($bakSize -ne $EXPECTED_SIZE) {
    Bail "Backup size mismatch: got $bakSize, expected $EXPECTED_SIZE -- aborting before touching anything."
}
wLog "PRE-FLIGHT: Backup OK  size=$bakSize  path=$BACKUP_DB"

if (-not (Test-Path $ETHER_EXE)) {
    Bail "Ether.exe not found: $ETHER_EXE"
}
wLog "PRE-FLIGHT: Ether.exe OK  path=$ETHER_EXE"
wLog "PRE-FLIGHT: all checks passed"

# --- STEP 1: Rename OV folder to .bak ---
wLog "STEP 1: Rename $OV_FOLDER -> $OV_BAK_FOLDER"
try {
    Rename-Item -LiteralPath $OV_FOLDER -NewName "com.ether.radio.bak" -ErrorAction Stop
} catch {
    Bail "Rename failed: $_ -- OV folder untouched at $OV_FOLDER"
}
if (-not (Test-Path $OV_BAK_FOLDER)) {
    Bail "Rename reported success but .bak folder not present -- check $APPDATA_DIR manually."
}
wLog "STEP 1: .bak confirmed at $OV_BAK_FOLDER"

# --- STEP 2: Launch Ether, redirect ALL output to files ---
wLog "STEP 2: Launching Ether"
wLog "STEP 2: stdout -> $APP_LOG"
wLog "STEP 2: stderr -> $APP_ERR_LOG"

$proc = $null
try {
    $proc = Start-Process `
        -FilePath               $ETHER_EXE `
        -RedirectStandardOutput $APP_LOG `
        -RedirectStandardError  $APP_ERR_LOG `
        -PassThru `
        -ErrorAction Stop
} catch {
    wLog "STEP 2: Launch failed: $_"
    Bail "Ether failed to launch: $_" -ovDataAt $OV_BAK_FOLDER
}
wLog "STEP 2: Launched PID $($proc.Id)"

# --- STEP 3: Poll log for schema-ready line (or timeout) ---
wLog "STEP 3: Polling for '$SCHEMA_LINE' up to ${TIMEOUT_SEC}s"
$found    = $false
$deadline = [DateTime]::Now.AddSeconds($TIMEOUT_SEC)

while ([DateTime]::Now -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) {
        wLog "STEP 3: Ether exited early -- exit code $($proc.ExitCode)"
        break
    }
    if (Test-Path $APP_LOG) {
        try {
            $fs = [System.IO.File]::Open(
                $APP_LOG,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite)
            $reader = New-Object System.IO.StreamReader($fs)
            $txt = $reader.ReadToEnd()
            $reader.Close()
            $fs.Close()
            if ($txt.Contains($SCHEMA_LINE)) {
                $found = $true
                break
            }
        } catch {
            # file momentarily locked -- will retry
        }
    }
}

if ($found) {
    wLog "STEP 3: '$SCHEMA_LINE' confirmed in log"
} else {
    wLog "STEP 3: WARN -- '$SCHEMA_LINE' not seen within ${TIMEOUT_SEC}s (review app log after restore)"
}

# --- STEP 4: Kill Ether and all children ---
if ($null -ne $proc -and -not $proc.HasExited) {
    wLog "STEP 4: Killing PID $($proc.Id)"
    try {
        Stop-Process -Id $proc.Id -Force -ErrorAction Stop
        $exited = $proc.WaitForExit(5000)
        wLog "STEP 4: PID $($proc.Id) killed  WaitForExit=$exited"
    } catch {
        wLog "STEP 4: Stop-Process error (may have already exited): $_"
    }
} else {
    $code = if ($null -ne $proc) { $proc.ExitCode } else { "n/a" }
    wLog "STEP 4: Process already exited  code=$code"
}
$lingering = Get-Process -Name "Ether" -ErrorAction SilentlyContinue
foreach ($p in $lingering) {
    wLog "STEP 4: Killing lingering Ether PID $($p.Id)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

# --- STEP 5: Restore ---
wLog "STEP 5: Starting restore"

if (-not (Test-Path $OV_BAK_FOLDER)) {
    Bail "RESTORE IMPOSSIBLE: .bak folder missing at $OV_BAK_FOLDER. Do not run Ether. Check $APPDATA_DIR manually."
}
wLog "STEP 5: .bak present"

if (Test-Path $OV_FOLDER) {
    $throwawayDb = "$OV_FOLDER\openair.db"
    if (Test-Path $throwawayDb) {
        $tsz = (Get-Item $throwawayDb).Length
        wLog "STEP 5: Throwaway DB size=$tsz (fresh init, will be deleted)"
    } else {
        wLog "STEP 5: Throwaway folder exists but contains no openair.db"
    }
    wLog "STEP 5: Removing throwaway $OV_FOLDER"
    try {
        Remove-Item -LiteralPath $OV_FOLDER -Recurse -Force -ErrorAction Stop
        wLog "STEP 5: Throwaway removed"
    } catch {
        Bail "Cannot remove throwaway at $OV_FOLDER : $_ -- .bak is safe." -ovDataAt $OV_BAK_FOLDER
    }
} else {
    wLog "STEP 5: No throwaway folder present. OK."
}

wLog "STEP 5: Renaming $OV_BAK_FOLDER -> $OV_FOLDER"
try {
    Rename-Item -LiteralPath $OV_BAK_FOLDER -NewName "com.ether.radio" -ErrorAction Stop
} catch {
    Bail "RESTORE RENAME FAILED: $_ -- .bak still at $OV_BAK_FOLDER." -ovDataAt $OV_BAK_FOLDER
}

if (-not (Test-Path $OV_DB)) {
    Bail "RESTORE VERIFY FAILED: rename succeeded but $OV_DB not found. Check $APPDATA_DIR."
}
$restoredSize = (Get-Item $OV_DB).Length
if ($restoredSize -ne $EXPECTED_SIZE) {
    Bail "RESTORE SIZE MISMATCH: $OV_DB is $restoredSize bytes, expected $EXPECTED_SIZE. Check $APPDATA_DIR immediately."
}
wLog "STEP 5: $OV_DB size=$restoredSize matches $EXPECTED_SIZE  RESTORE COMPLETE"

# --- SUMMARY ---
wLog "=== ALL DONE ==="
wLog "App stdout : $APP_LOG"
wLog "App stderr : $APP_ERR_LOG"
wLog "Wrapper log: $WRAPPER_LOG"
if ($found) {
    wLog "RESULT: PASS -- '$SCHEMA_LINE' seen in fresh-install log"
} else {
    wLog "RESULT: INCONCLUSIVE -- schema-ready line not observed; review app log"
}
Write-Host ""
Write-Host "OV database restored and verified." -ForegroundColor Green
