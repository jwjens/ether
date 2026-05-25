'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Mirrors Electron's app.getPath('userData') = %APPDATA%\<productName>.
// productName is "Ether" (electron-builder.json). Single source of truth for the
// sentinel + log paths — must match what main.js writes via app.getPath.
function userDataDir() {
  const appData = process.env.APPDATA
    || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Roaming');
  return path.join(appData, 'Ether');
}

// Force-kill the whole process tree. Electron spawns GPU/renderer/utility
// children; /T takes them all so a respawn isn't blocked by a survivor holding
// the single-instance lock / port 3400.
function killHard(pid) {
  if (!pid) return;
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* best effort */ }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── Phase 3: startup registration (per-user Scheduled Task at logon) ──────────
// Why a Scheduled Task and not HKCU\...\Run: a task gives a logon delay, a
// restart-on-failure backstop, an unlimited execution-time-limit (Run keys are
// fire-and-forget), and battery/idle policy — all of which matter for a 24/7
// supervisor. Per-user + InteractiveToken + LeastPrivilege → no admin, no stored
// password; it runs only inside the operator's interactive session, which is
// exactly where Ether's session-scoped audio + per-user data live.
const TASK_NAME = 'EtherHAWatchdog';

// Current user as DOMAIN\User for the trigger/principal. `whoami` is the
// canonical source; fall back to the env if it's ever unavailable.
function currentUserId() {
  try {
    const r = spawnSync('whoami', [], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch { /* fall through */ }
  const domain = process.env.USERDOMAIN || os.hostname();
  const user = process.env.USERNAME || os.userInfo().username;
  return `${domain}\\${user}`;
}

// The command the task runs to launch the watchdog. Dev (electron in
// node_modules) needs the app root as the first arg so Electron loads main.js,
// which then self-dispatches into the watchdog on seeing --ether-watchdog.
// Packaged: process.execPath IS Ether.exe → just pass the flag.
function defaultLaunchSpec() {
  const command = process.execPath;
  const isDev = /node_modules[\\/]electron/i.test(command);
  const appRoot = path.resolve(__dirname, '..', '..');
  const args = isDev ? `"${appRoot}" --ether-watchdog` : '--ether-watchdog';
  return { command, args, isDev };
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildTaskXml({ command, args, userId, delaySeconds }) {
  const delay = `PT${Math.max(0, Math.round(delaySeconds || 0))}S`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Ether HA watchdog — supervises Ether and restarts it on crash or hang. Launches at user logon.</Description>
    <Author>Ether</Author>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
      <Delay>${delay}</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

// Register (or replace, via /F) the logon task. Returns a structured result so
// the IPC layer can surface schtasks output instead of throwing across the wire.
// `opts.command` / `opts.args` override the computed launch spec (tests / future
// callers); `opts.delaySeconds` overrides the 15s logon delay.
function registerStartup(opts = {}) {
  const spec = defaultLaunchSpec();
  const command = opts.command || spec.command;
  const args = opts.args != null ? opts.args : spec.args;
  const userId = opts.userId || currentUserId();
  const delaySeconds = opts.delaySeconds != null ? opts.delaySeconds : 15;
  const xml = buildTaskXml({ command, args, userId, delaySeconds });

  // schtasks /XML wants a UTF-16LE file; declare UTF-16 + write a BOM to match.
  const xmlPath = path.join(os.tmpdir(), `ether-ha-task-${process.pid}-${Date.now()}.xml`);
  try {
    fs.writeFileSync(xmlPath, '﻿' + xml, { encoding: 'utf16le' });
    const r = spawnSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'], { encoding: 'utf8' });
    const ok = r.status === 0;
    return {
      ok, taskName: TASK_NAME, command, args, userId,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim() || (r.error ? r.error.message : ''),
    };
  } finally {
    try { fs.unlinkSync(xmlPath); } catch { /* best effort */ }
  }
}

// Idempotent: a missing task is treated as success (already in the target state).
function unregisterStartup() {
  const r = spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const ok = r.status === 0 || /cannot find the file|does not exist|specified task name/i.test(out);
  return { ok, removed: r.status === 0, taskName: TASK_NAME, output: out };
}

// Whether the logon task currently exists. Used by ha:status.
function startupStatus() {
  const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], { encoding: 'utf8' });
  return { registered: r.status === 0, taskName: TASK_NAME };
}

module.exports = {
  userDataDir, killHard, isProcessAlive,
  registerStartup, unregisterStartup, startupStatus,
  currentUserId, // Phase 4: ha:enable passes DOMAIN\User to the auto-logon helper
  TASK_NAME, buildTaskXml, // exported for tests
};
