'use strict';

const path = require('path');
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

// Phase 3 — startup registration. Stubbed; not used in Phase 2.
function registerStartup()   { throw new Error('registerStartup: not implemented until Phase 3'); }
function unregisterStartup() { throw new Error('unregisterStartup: not implemented until Phase 3'); }

module.exports = { userDataDir, killHard, isProcessAlive, registerStartup, unregisterStartup };
