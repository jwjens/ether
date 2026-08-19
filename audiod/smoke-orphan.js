// audiod/smoke-orphan.js — NO OWNER, NO ENGINE. Run: node audiod/smoke-orphan.js
//
// The 2026-08-18 incident: audio kept playing after the app closed, with no window and no tray icon
// to stop it. docs/orphan-engine-fix-2026-08-18.md is the fix; this is its permanent proof.
//
// It lives here, beside the other smoke tests, ON PURPOSE. The fix originally shipped with a harness
// that was never committed, so its evidence existed only as pasted text in a doc — unreproducible the
// moment anyone wanted to check it. A test proving the worst defect an audio product can have is not
// temporary tooling; it is part of the product's own sense.
//
// ISOLATED: private pipe, stand-in owner process, never touches the live daemon, live pipe or any DB.
// The daemon's loadDb() is lazy and we send only ping — nothing here opens openair.db.
//
//   T1  owner dies            -> daemon must EXIT within grace+poll
//   T2  born ownerless        -> daemon must EXIT (owner pid already dead)
//   T3  a bare socket held    -> must NOT rescue an orphan (the old client-leave bug)
//   T4  hello adopts          -> daemon must SURVIVE past the grace

const cp = require("child_process");
const net = require("net");
const path = require("path");

const DAEMON = path.join(__dirname, "ether-audiod.js");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pipeFor(tag) { return `\\\\.\\pipe\\ether-orphan-verify-${tag}-${process.pid}`; }

function spawnOwner() {
  // A stand-in owner that does nothing but stay alive until killed.
  return cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
}
function spawnDaemon(pipe, ownerPid) {
  const env = { ...process.env, ETHER_AUDIOD_PIPE: pipe, ETHER_DAEMON_DEV: "1" };
  if (ownerPid != null) env.ETHER_OWNER_PID = String(ownerPid);
  return cp.spawn(process.execPath, [DAEMON], { env, stdio: "ignore" });
}
function connect(pipe) {
  return new Promise((res) => {
    const s = net.connect(pipe);
    s.once("connect", () => res(s));
    s.once("error", () => res(null));
    setTimeout(() => res(null), 1500);
  });
}
async function up(pipe) { const s = await connect(pipe); if (s) { try { s.destroy(); } catch {} } return !!s; }

/** Wait until the daemon process is gone, or give up. Returns seconds waited, or null if still alive. */
async function waitExit(proc, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (!alive(proc.pid)) return ((Date.now() - t0) / 1000).toFixed(1);
    await sleep(250);
  }
  return null;
}

let pass = 0, fail = 0;
const ok = (name, detail) => { pass++; console.log(`PASS  ${name}\n        ${detail}`); };
const no = (name, detail) => { fail++; console.log(`FAIL  ${name}\n        ${detail}`); };

(async () => {
  // ── T1: owner dies -> daemon exits ────────────────────────────────────────────────────────────
  {
    const pipe = pipeFor("t1");
    const owner = spawnOwner();
    const d = spawnDaemon(pipe, owner.pid);
    await sleep(2500);
    if (!(await up(pipe))) { no("T1 owner dies -> daemon exits", "daemon never came up; test inconclusive"); }
    else {
      process.kill(owner.pid);
      const secs = await waitExit(d, 20000);
      secs ? ok("T1 owner dies -> daemon exits", `daemon exited ${secs}s after the owner was killed (dev grace 5s + 1s poll)`)
           : no("T1 owner dies -> daemon exits", "daemon STILL RUNNING 20s after its owner died — unstoppable audio path is OPEN");
      try { d.kill(); } catch {}
    }
    try { owner.kill(); } catch {}
  }

  // ── T2: born with a dead owner -> daemon exits ────────────────────────────────────────────────
  {
    const pipe = pipeFor("t2");
    const owner = spawnOwner();
    const deadPid = owner.pid;
    owner.kill();
    await sleep(400);
    const d = spawnDaemon(pipe, deadPid);
    const secs = await waitExit(d, 20000);
    secs ? ok("T2 born ownerless -> daemon exits", `daemon exited ${secs}s after start (owner pid ${deadPid} was already dead)`)
         : no("T2 born ownerless -> daemon exits", "daemon spawned into a dead owner and kept running");
    try { d.kill(); } catch {}
  }

  // ── T3: a bare connected socket must NOT rescue an orphan ─────────────────────────────────────
  {
    const pipe = pipeFor("t3");
    const owner = spawnOwner();
    const d = spawnDaemon(pipe, owner.pid);
    await sleep(2500);
    const sock = await connect(pipe);          // held open for the whole grace, saying nothing
    if (!sock) { no("T3 bare socket cannot rescue", "could not connect; test inconclusive"); }
    else {
      process.kill(owner.pid);
      const secs = await waitExit(d, 20000);
      secs ? ok("T3 bare socket cannot rescue", `daemon exited ${secs}s with a client socket held open the entire time`)
           : no("T3 bare socket cannot rescue", "a silent socket kept the orphan alive — the old client-leave bug");
      try { sock.destroy(); } catch {}
      try { d.kill(); } catch {}
    }
    try { owner.kill(); } catch {}
  }

  // ── T4: hello adopts an orphan -> it keeps playing ────────────────────────────────────────────
  {
    const pipe = pipeFor("t4");
    const owner = spawnOwner();
    const d = spawnDaemon(pipe, owner.pid);
    await sleep(2500);
    process.kill(owner.pid);                   // orphaned...
    await sleep(1500);
    const s = await connect(pipe);
    if (!s) { no("T4 hello adopts an orphan", "could not connect to adopt"); }
    else {
      // THIS process adopts it — exactly what a restarted app does on every attach.
      s.write(JSON.stringify({ id: 1, cmd: "hello", ownerPid: process.pid }) + "\n");
      await sleep(9000);                        // well past the 5s dev grace
      const stillUp = alive(d.pid);
      stillUp ? ok("T4 hello adopts an orphan", `adopted by pid ${process.pid}; still running 9s past the grace`)
              : no("T4 hello adopts an orphan", "daemon exited despite being adopted — an app restart would drop the station");
      try { s.destroy(); } catch {}
      try { d.kill(); } catch {}
    }
    try { owner.kill(); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
