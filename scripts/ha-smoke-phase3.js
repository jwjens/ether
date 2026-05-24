'use strict';
/**
 * In-session HA smoke test (Phase 3 + 2.5). Drives the REAL dev app through the
 * full supervision loop and reports pass/fail. Windows-only (schtasks/taskkill).
 *
 *   1. `electron . --enable-ha`  → registers the logon Scheduled Task + spawns a
 *                                  watchdog that ADOPTS this app
 *   2. assert: Scheduled Task exists
 *   3. assert: watchdog adopted us (watchdog.log)
 *   4. assert: /health responds
 *   5. CRASH Ether (kill the app)        → watchdog respawns it (/health returns)
 *   6. KILL the watchdog                 → app relaunches it, new pid adopts (2.5)
 *   7. `electron . --disable-ha`         → unregisters the task + kills watchdog
 *   8. assert: Scheduled Task removed
 *
 * SAFETY: aborts if :3400 is already in use (won't stomp a running Ether). Runs
 * the spawned watchdog with a low crash-loop ceiling (WD_*) so a fault halts fast
 * instead of storming. A finally{} sweep always kills tracked pids, deletes the
 * task, and clears the pid file — so a mid-run failure can't leave HA armed.
 *
 * NOTE: launches real Electron windows (the dev renderer won't load without Vite;
 * that's fine — this validates the MAIN process: /health, watchdog, registration).
 *
 * Run:  node scripts/ha-smoke-phase3.js
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT      = path.resolve(__dirname, '..');
const ELECTRON  = require('electron'); // path to the electron binary when require()d from node
const platform  = require('../watchdog/platform/win32');
const USER_DATA  = platform.userDataDir();
const WD_LOG     = path.join(USER_DATA, 'watchdog.log');
const PID_FILE   = path.join(USER_DATA, '.ether-watchdog.pid');
const TASK_NAME  = platform.TASK_NAME;
const HEALTH_URL = 'http://127.0.0.1:3400/health';

// Low crash-loop ceiling for the spawned watchdog (propagates through the app to
// the watchdog via env): if anything goes sideways it halts after 3, never storms.
const WD_SAFE_ENV = { WD_MAX_RESTARTS: '3', WD_WINDOW_MS: '120000' };

const tracked = new Set();     // every electron pid we spawn → killed in finally
let passed = 0, failed = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else      { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function health() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
async function waitForHealth(want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await health() === want) return true; await sleep(1000); }
  return false;
}
function taskExists() {
  return spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], { encoding: 'utf8' }).status === 0;
}
function readWatchdogPid() { try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0; } catch { return 0; } }
function readLog()         { try { return fs.readFileSync(WD_LOG, 'utf8'); } catch { return ''; } }
function killPid(pid, tree) {
  if (!pid) return;
  const args = tree ? ['/F', '/T', '/PID', String(pid)] : ['/F', '/PID', String(pid)];
  try { spawnSync('taskkill', args, { stdio: 'ignore' }); } catch { /* best effort */ }
}
// The watchdog respawns the app under a pid we never see, so identify whatever is
// serving :3400 by its listening socket and kill that tree. Used to free the port
// before --disable-ha (which needs a clean single-instance slot) and in teardown.
function pidsOnPort(port) {
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
        const pid = Number(line.trim().split(/\s+/).pop());
        if (pid) pids.add(pid);
      }
    }
    return [...pids];
  } catch { return []; }
}
function killPort(port) { for (const pid of pidsOnPort(port)) killPid(pid, true); }
// Launch the dev app with a flag. detached so it survives this script; tracked
// for teardown. Returns the child (its pid is the Electron main / app pid).
function launchApp(extraArgs) {
  const env = { ...process.env, ...WD_SAFE_ENV };
  const child = spawn(ELECTRON, ['.', ...extraArgs], { cwd: ROOT, env, stdio: 'ignore', detached: true });
  child.unref();
  if (child.pid) tracked.add(child.pid);
  return child;
}

async function main() {
  console.log('\n=== HA Phase 3 + 2.5 in-session smoke ===\n');
  console.log(`userData: ${USER_DATA}`);

  if (await health()) {
    console.error('\nABORT: something is already serving :3400 (a running Ether?). Stop it first.\n');
    process.exit(2);
  }
  // Clean slate so log assertions are unambiguous.
  try { fs.unlinkSync(WD_LOG); } catch { /* none */ }
  try { fs.unlinkSync(PID_FILE); } catch { /* none */ }

  // 1–4. Enable HA, then prove registration + adopt + health.
  console.log('\n[1] electron . --enable-ha');
  const app1 = launchApp(['--enable-ha']);
  ok('health up after --enable-ha', await waitForHealth(true, 40000));
  await sleep(4000); // give handleHaBootstrapFlags time to register + spawn the watchdog
  ok('scheduled task registered', taskExists());
  const wd1 = readWatchdogPid();
  ok('watchdog pid file written', wd1 > 0, `pid=${wd1}`);
  ok('watchdog adopted the app (no fresh spawn)', /adopted existing Ether pid \d+ \(healthy\)/.test(readLog()) && !/Ether spawned pid/.test(readLog()));

  // 5. Crash the app → watchdog should respawn it. Kill ONLY the app's main
  //    process (the :3400 listener), NOT /T — a tree-kill would also take the
  //    detached watchdog (it's still in the app's descendant tree on Windows),
  //    which is a test artifact, not what a real crash does.
  console.log('\n[5] crash Ether (kill app main only) → expect watchdog respawn');
  const appPid = pidsOnPort(3400)[0];
  console.log(`    app pid on :3400 = ${appPid}, watchdog pid = ${readWatchdogPid()}`);
  killPid(appPid, false);
  tracked.delete(app1.pid);
  ok('health drops after crash', await waitForHealth(false, 12000));
  ok('watchdog respawned Ether (health returns)', await waitForHealth(true, 60000));
  await sleep(2000);

  // 6. Kill the watchdog → app should relaunch it (Phase 2.5). New pid, adopts.
  console.log('\n[6] kill watchdog → expect app to relaunch it (Phase 2.5)');
  const wdBefore = readWatchdogPid();
  killPid(wdBefore, false); // NO /T — its child is the app; only kill the watchdog
  // App monitor polls every 10s; allow a couple cycles + new-watchdog spawn + adopt.
  let wdAfter = 0;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    wdAfter = readWatchdogPid();
    if (wdAfter && wdAfter !== wdBefore && platform.isProcessAlive(wdAfter)) break;
    await sleep(2000);
  }
  ok('app relaunched a NEW watchdog', wdAfter && wdAfter !== wdBefore && platform.isProcessAlive(wdAfter), `before=${wdBefore} after=${wdAfter}`);
  // The relaunched watchdog re-adopts the still-running app → a SECOND "adopted"
  // line in the log, and no fresh spawn (which would be the storm we guard against).
  ok('app relaunched watchdog re-adopted (no storm)', (readLog().match(/adopted existing Ether/g) || []).length >= 2);
  ok('app still healthy through 2.5 relaunch', await waitForHealth(true, 8000));

  // 7–8. Disable HA. Must run from a STOPPED state (single-instance lock), so kill
  // the live watchdog + app first to free :3400, then --disable-ha unregisters.
  console.log('\n[7] electron . --disable-ha → expect task removed');
  killPid(readWatchdogPid(), false);  // stop supervision FIRST so the app isn't respawned
  await sleep(1500);
  for (const pid of [...tracked]) { killPid(pid, true); tracked.delete(pid); }
  killPort(3400);                     // kill whatever app holds :3400 (incl. watchdog-respawned)
  await waitForHealth(false, 15000);
  const app2 = launchApp(['--disable-ha']);
  ok('health up after --disable-ha', await waitForHealth(true, 40000));
  await sleep(4000);
  ok('scheduled task removed', !taskExists());
  killPid(app2.pid, true);
  tracked.delete(app2.pid);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
}

(async () => {
  let code = 1;
  try { await main(); code = failed ? 1 : 0; }
  catch (e) { console.error('\nSMOKE ERROR:', e && e.stack || e); code = 1; }
  finally {
    // Always disarm HA, no matter how we got here.
    console.log('\n[teardown] killing tracked processes, removing task + pid file');
    killPid(readWatchdogPid(), false);  // watchdog first, so it can't respawn the app
    await sleep(1000);
    for (const pid of tracked) killPid(pid, true);
    killPort(3400);                     // any app instance still serving :3400
    try { spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'ignore' }); } catch { /* none */ }
    try { fs.unlinkSync(PID_FILE); } catch { /* none */ }
    process.exit(code);
  }
})();
