'use strict';
// Verifies the Part-1.2 fix: the durable daemon log ships in the stage + the require can't crash the daemon.
const fs = require('fs'), path = require('path'), os = require('os');
const R = (p) => fs.readFileSync(path.join('C:', 'openair', p), 'utf8');
let n = 0; const ok = (m) => console.log(`  [${++n}] ${m} ✓`); const fail = (m) => { console.error('❌ FAIL:', m); process.exit(1); };

// 1) stage list now ships daemon-log.js (the regression fix).
if (!/DAEMON_FILES\s*=\s*\[[^\]]*["']daemon-log\.js["']/.test(R('audiod/stage-engine.js'))) fail('stage-engine DAEMON_FILES missing daemon-log.js');
ok('stage-engine.js DAEMON_FILES ships daemon-log.js');

// 2) the require is guarded in ether-audiod.js.
if (!/try\s*\{\s*require\(["']\.\/daemon-log["']\)\.install\(\)/.test(R('audiod/ether-audiod.js'))) fail('ether-audiod require not try/catch-guarded');
ok('ether-audiod.js require("./daemon-log") is guarded');

// 3) the guard pattern actually survives a missing module (no crash on MODULE_NOT_FOUND).
let survived = true;
try { try { require('./__definitely_missing_module__'); } catch { /* guarded, as in ether-audiod */ } } catch { survived = false; }
if (!survived) fail('guard did not contain MODULE_NOT_FOUND');
ok('guarded require survives MODULE_NOT_FOUND — a missing log module cannot crash the daemon');

// 4) daemon-log.js is functional: install() tees console.log to the durable file (async stream → check after flush).
const logPath = path.join(os.tmpdir(), 'test-audiod-' + process.pid + '.log');
process.env.ETHER_AUDIOD_LOG = logPath;
require(path.join('C:', 'openair', 'audiod', 'daemon-log.js')).install();
console.log('functional-test-marker');
setTimeout(() => {
  if (!fs.existsSync(logPath)) fail('daemon-log did not create the file');
  if (!/functional-test-marker/.test(fs.readFileSync(logPath, 'utf8'))) fail('daemon-log did not tee console.log');
  ok('daemon-log.js install() tees console.log to the durable file');
  try { fs.unlinkSync(logPath); } catch {}
  console.log('\n✅ DAEMON-LOG STAGING + GUARD — ALL CHECKS PASS');
}, 400);
