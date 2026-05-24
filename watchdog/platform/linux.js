'use strict';

// Linux platform layer — STUB (Windows-first; implemented in a later phase).
// Core loop is OS-agnostic; only these primitives are per-OS. Auto-login on
// Linux is display-manager specific (gdm/lightdm autologin), handled when
// Linux ships.

function userDataDir() {
  // Electron default on Linux: $XDG_CONFIG_HOME/<productName> or ~/.config/<productName>
  const path = require('path');
  const base = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  return path.join(base, 'Ether');
}

function killHard(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* best effort — does not kill the tree */ }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function registerStartup()   { throw new Error('registerStartup: Linux not implemented yet'); }
function unregisterStartup() { throw new Error('unregisterStartup: Linux not implemented yet'); }

module.exports = { userDataDir, killHard, isProcessAlive, registerStartup, unregisterStartup };
