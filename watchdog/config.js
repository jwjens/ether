'use strict';

// Ether HA watchdog — tunables (locked v1). Conservative on purpose: the worst
// outcome is killing a healthy-but-busy Ether mid-broadcast, so detection
// windows bias toward NOT killing. Tune up only after observing real behavior.
const TUNABLES = {
  pollIntervalMs:         5000,   // /health poll cadence
  healthTimeoutMs:        2000,   // per-poll request timeout
  maxConsecutiveMisses:   3,      // misses in a row before declaring a hang (~15s)
  healthUrl:              'http://127.0.0.1:3400/health',
  expectedRestartGraceMs: 60000,  // how long to wait for an update/relaunch to self-return
  killConfirmTimeoutMs:   5000,   // max wait for a killed process + freed port before respawn
  crashWindowMs:          5 * 60 * 1000,
  maxRestartsInWindow:    5,      // > this within the window → halt + alarm
  backoffMs:              [2000, 5000, 10000, 20000, 30000], // by restart index in window
};

// Test-only overrides (watchdog/test sets these to run fast). Prod never sets
// them, so production behaviour is exactly the locked values above.
const envNum = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
TUNABLES.pollIntervalMs         = envNum('WD_POLL_MS',        TUNABLES.pollIntervalMs);
TUNABLES.healthTimeoutMs        = envNum('WD_TIMEOUT_MS',     TUNABLES.healthTimeoutMs);
TUNABLES.maxConsecutiveMisses   = envNum('WD_MISS_MAX',       TUNABLES.maxConsecutiveMisses);
TUNABLES.expectedRestartGraceMs = envNum('WD_GRACE_MS',       TUNABLES.expectedRestartGraceMs);
TUNABLES.maxRestartsInWindow    = envNum('WD_MAX_RESTARTS',   TUNABLES.maxRestartsInWindow);
TUNABLES.crashWindowMs          = envNum('WD_WINDOW_MS',      TUNABLES.crashWindowMs);
TUNABLES.killConfirmTimeoutMs   = envNum('WD_KILL_CONFIRM_MS', TUNABLES.killConfirmTimeoutMs);
if (process.env.WD_BACKOFF_MS) TUNABLES.backoffMs = process.env.WD_BACKOFF_MS.split(',').map(Number).filter(n => n >= 0);

const fs = require('fs');
const path = require('path');

// Optional per-install config (Phase 4 Settings toggle writes this). Default-on
// when the watchdog is actually running; Phase 4 gates whether it runs at all.
function readHaConfig(userDataDir) {
  try {
    const p = path.join(userDataDir, 'ha-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* fall through to default */ }
  return { enabled: true };
}

module.exports = { TUNABLES, readHaConfig };
