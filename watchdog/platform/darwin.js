'use strict';

// macOS platform layer — STUB (Windows-first; implemented in a later phase).
// The core watchdog loop is OS-agnostic; only these primitives are per-OS.
// Auto-login on macOS is a different mechanism entirely (loginwindow /
// `kcpassword` / MDM), handled when mac ships.

function userDataDir() {
  // Electron default on macOS: ~/Library/Application Support/<productName>
  const path = require('path');
  return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Ether');
}

function killHard(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* best effort — note: does not kill the tree */ }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function registerStartup()   { throw new Error('registerStartup: macOS not implemented yet'); }
function unregisterStartup() { throw new Error('unregisterStartup: macOS not implemented yet'); }

module.exports = { userDataDir, killHard, isProcessAlive, registerStartup, unregisterStartup };
