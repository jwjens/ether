'use strict';
/**
 * Watchdog logic tests. Runs the REAL watchdog.js (pure Node — no Electron API)
 * pointed at watchdog/test/mock-ether.js via the WATCHDOG_TEST_CMD seam, with an
 * isolated temp userData and fast tunables. Asserts on the watchdog's own log
 * output. Windows-first (uses taskkill for teardown).
 *
 * Run:  node watchdog/test/run-tests.js
 */
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const WD   = path.resolve(__dirname, '..', 'watchdog.js');
const MOCK = path.resolve(__dirname, 'mock-ether.js');
const NODE = process.execPath;

const FAST = {
  WD_POLL_MS: '500', WD_TIMEOUT_MS: '500', WD_MISS_MAX: '3',
  WD_GRACE_MS: '6000', WD_KILL_CONFIRM_MS: '4000',
};

let passed = 0, failed = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freshUserData() {
  const d = path.join(os.tmpdir(), 'wd-test-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function killTree(pid) { try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {} }

// Spawn the watchdog with a mock child; collect stdout for `runMs`; resolve with
// the full log + whether the watchdog process exited on its own.
function runWatchdog({ behavior, env, runMs }) {
  return new Promise((resolve) => {
    const userData = freshUserData();
    const wd = spawn(NODE, [WD], {
      env: {
        ...process.env, ...FAST, ...env,
        WATCHDOG_USER_DATA: userData,
        WATCHDOG_TEST_CMD: NODE,
        WATCHDOG_TEST_ARGS: `${MOCK} ${behavior}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    wd.stdout.on('data', d => { out += d; });
    wd.stderr.on('data', d => { out += d; });
    let exited = false;
    wd.on('exit', () => { exited = true; });
    setTimeout(() => { killTree(wd.pid); setTimeout(() => resolve({ out, exited, userData }), 400); }, runMs);
  });
}

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else      { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  console.log('\n=== Watchdog logic tests ===\n');

  // 1 + 2. Crash → respawn (and backoff logged)
  {
    const { out } = await runWatchdog({ behavior: 'crash:1200', runMs: 7000 });
    console.log('--- [crash] ---'); process.stdout.write(indent(out));
    check('crash: detected', /unexpected exit → CRASH/.test(out));
    check('crash: respawn scheduled with backoff', /respawning after crash in \d+ms/.test(out));
    check('crash: actually respawned (2nd spawn)', (out.match(/Ether spawned pid/g) || []).length >= 2);
  }

  // 3. Hang (alive but /health unresponsive) → kill + respawn (exercises the
  //    kill-confirm gate that protects against the single-instance lock)
  {
    const { out } = await runWatchdog({ behavior: 'hang:800', runMs: 9000 });
    console.log('--- [hang] ---'); process.stdout.write(indent(out));
    check('hang: misses accumulate', /health miss 3\/3/.test(out));
    check('hang: HANG declared + force-kill', /HANG declared — force-killing/.test(out));
    check('hang: kill confirmed then respawn', /respawning after hang/.test(out));
    // Regression: a watchdog-initiated kill must NOT also trip the crash path
    // (that caused a double-spawn → two instances fighting the single-instance lock).
    check('hang: no crash-path double-respawn', !/unexpected exit → CRASH/.test(out) && !/crash-restart/.test(out));
  }

  // 1 (user quit). Clean-exit sentinel → stand down, watchdog exits, NO respawn
  {
    const { out, exited } = await runWatchdog({ behavior: 'clean-exit:1000', runMs: 5000 });
    console.log('--- [clean-exit] ---'); process.stdout.write(indent(out));
    check('clean-quit: sentinel honored, standing down', /clean-exit sentinel → intentional user quit/.test(out));
    check('clean-quit: watchdog exited itself', exited);
    check('clean-quit: did NOT respawn', !/crash-restart|Ether spawned pid \d+[\s\S]*Ether spawned pid \d+/.test(out));
  }

  // 4. Update relaunch → expected-restart; do NOT fight it; resume when it returns
  {
    const userData = freshUserData();
    const wd = spawn(NODE, [WD], {
      env: { ...process.env, ...FAST, WATCHDOG_USER_DATA: userData, WATCHDOG_TEST_CMD: NODE, WATCHDOG_TEST_ARGS: `${MOCK} expected-restart:800` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; wd.stdout.on('data', d => out += d); wd.stderr.on('data', d => out += d);
    // Simulate the app self-relaunching: after the mock exits (~0.8s), bring a
    // healthy /health server back up on :3400.
    await sleep(1500);
    const healthy = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, audio: { alive: true } })); });
    await new Promise(r => healthy.listen(3400, '127.0.0.1', r));
    await sleep(4000);
    console.log('--- [expected-restart] ---'); process.stdout.write(indent(out));
    check('relaunch: expected-restart sentinel honored', /expected-restart sentinel → update\/relaunch/.test(out));
    check('relaunch: waited for self-relaunch (did not immediately respawn)', /Waiting for self-relaunch/.test(out));
    check('relaunch: resumed monitoring when app returned (no extra spawn)', /app self-relaunched and healthy — resuming monitoring/.test(out));
    killTree(wd.pid); healthy.close(); await sleep(300);
  }

  // 6. Crash loop → backoff exhausted → halt + alarm marker
  {
    const { out, userData } = await runWatchdog({ behavior: 'crash:300', env: { WD_MAX_RESTARTS: '3', WD_BACKOFF_MS: '0,0,0,0,0' }, runMs: 6000 });
    console.log('--- [crash-loop] ---'); process.stdout.write(indent(out));
    check('crash-loop: tripped + halted', /CRASH LOOP: .* HALTING auto-restart/.test(out));
    check('crash-loop: alarm marker written', fs.existsSync(path.join(userData, '.ether-ha-alarm')));
    check('crash-loop: stopped respawning (<=3 spawns)', (out.match(/Ether spawned pid/g) || []).length <= 3);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();

function indent(s) { return s.split('\n').map(l => l ? '    ' + l : l).join('\n') + '\n'; }
