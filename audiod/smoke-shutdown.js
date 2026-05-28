// Item 10 Phase 2 Step 6 check: the daemon's `shutdown` command (sent by the HA watchdog on a
// clean user-quit) makes the daemon exit. Spawns a private daemon, pings, sends shutdown, then
// confirms the pipe is dead (process gone). No audio.
//   node audiod/smoke-shutdown.js
const net = require("net"), path = require("path"), cp = require("child_process");
const PIPE = "\\\\.\\pipe\\ether-audiod-shutdowntest-" + process.pid;
const daemon = cp.spawn(process.execPath, [path.join(__dirname, "ether-audiod.js")], { env: { ...process.env, ETHER_AUDIOD_PIPE: PIPE }, stdio: "ignore" });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function probe() { return new Promise((res) => { const s = net.connect(PIPE); let d = false; const fin = (a) => { if (d) return; d = true; try { s.destroy(); } catch {} res(a); }; s.once("connect", () => fin(true)); s.once("error", () => fin(false)); setTimeout(() => fin(false), 1000); }); }

(async () => {
  // wait for the daemon to come up
  let up = false; for (let i = 0; i < 20 && !(up = await probe()); i++) await sleep(300);
  if (!up) { console.error("daemon never started"); try { daemon.kill(); } catch {} process.exit(1); }
  console.log("daemon up:", up);

  // send shutdown over the pipe (newline-JSON, like the watchdog does)
  await new Promise((res) => { const s = net.connect(PIPE, () => { s.write(JSON.stringify({ id: 0, cmd: "shutdown" }) + "\n"); setTimeout(() => { try { s.destroy(); } catch {} res(); }, 200); }); s.once("error", () => res()); });
  console.log("sent shutdown");

  await sleep(1200);
  const stillUp = await probe();
  const exited = daemon.exitCode !== null || daemon.signalCode !== null;
  console.log("pipe still up:", stillUp, "| process exited:", exited);
  const ok = !stillUp;
  try { daemon.kill(); } catch {}
  console.log("\n→ STEP 6 shutdown-cmd: " + (ok ? "✅ daemon stops on the shutdown command (pipe gone)" : "❌ daemon still listening"));
  process.exit(ok ? 0 : 1);
})();
