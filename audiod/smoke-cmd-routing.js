// Proves the daemon scopes commands by stationId — the property that makes execCmd's Slice 4
// daemon-direct routing safe (a command for station A's id must touch ONLY A) — and that the new
// stopAll command is wired. SAFE: throwaway pipe + DB + station ids 91/92, and it NEVER calls
// automationStart, so initAudioEngine / the output device is never touched and nothing ever plays.
// It cannot reach the three live stations (different pipe/db/ids, no streaming, no playout).
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PIPE = process.platform === "win32"
  ? "\\\\.\\pipe\\ether-audiod-cmdtest"
  : path.join(os.tmpdir(), "ether-audiod-cmdtest.sock");
const DB = path.join(os.tmpdir(), "ether-cmdtest-" + process.pid + ".db");

const daemon = spawn(process.execPath, [path.join(__dirname, "ether-audiod.js")], {
  env: { ...process.env, ETHER_AUDIOD_PIPE: PIPE, ETHER_DB_PATH: DB, ETHER_DAEMON_DEV: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let dlog = "";
daemon.stdout.on("data", (d) => { dlog += d.toString(); });
daemon.stderr.on("data", (d) => { dlog += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0; const pending = new Map();
function cmd(sock, c, args = {}) {
  return new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); sock.write(JSON.stringify({ id: myId, cmd: c, ...args }) + "\n"); });
}

(async () => {
  // Wait for the daemon to announce it's listening (no fixed-sleep guesswork).
  for (let i = 0; i < 40 && !/listening on/.test(dlog); i++) await sleep(100);
  if (!/listening on/.test(dlog)) throw new Error("daemon did not start\n" + dlog.slice(-500));

  const sock = net.connect(PIPE);
  await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); }
    }
  });

  let pass = 0, fail = 0;
  const check = (n, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); c ? pass++ : fail++; };

  // continuous=false → no DB refill on the throwaway empty DB. http URLs are treated as playable
  // (can't probe, trusted) so they stay in the queue, but NOTHING is ever played (no automationStart).
  await cmd(sock, "setContinuous", { stationId: 91, value: false });
  await cmd(sock, "setContinuous", { stationId: 92, value: false });

  // A command addressed to 91 affects ONLY 91; to 92 ONLY 92 — the isolation dcmd({stationId}) relies on.
  await cmd(sock, "enqueue", { stationId: 91, items: [{ filePath: "http://t/a1.mp3", title: "A1" }, { filePath: "http://t/a2.mp3", title: "A2" }] });
  await cmd(sock, "enqueue", { stationId: 92, items: [{ filePath: "http://t/b1.mp3", title: "B1" }] });
  const q91 = await cmd(sock, "getQueue", { stationId: 91 });
  const q92 = await cmd(sock, "getQueue", { stationId: 92 });
  check("command for station 91 affects only 91 (queue 91 = 2)", Array.isArray(q91) && q91.length === 2);
  check("command for station 92 affects only 92 (queue 92 = 1)", Array.isArray(q92) && q92.length === 1);

  // The new stopAll command is registered and returns ok (functional command-surface check).
  const stopRes = await cmd(sock, "stopAll", { stationId: 91 }).then(() => "ok").catch((e) => "err:" + e.message);
  check("stopAll is a wired daemon command (returns ok)", stopRes === "ok");

  // stopAll on 91 must not disturb 92.
  const q92b = await cmd(sock, "getQueue", { stationId: 92 });
  check("stopAll on 91 left 92 untouched (queue 92 still 1)", Array.isArray(q92b) && q92b.length === 1);

  // An unknown command is rejected per station — never cross-applied.
  const unknown = await cmd(sock, "no_such_cmd", { stationId: 91 }).then(() => "ok").catch(() => "rejected");
  check("unknown command rejected (not silently cross-applied)", unknown === "rejected");

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"} (${pass} passed, ${fail} failed)`);
  sock.end();
  daemon.kill();
  await sleep(200);
  try { fs.unlinkSync(DB); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.message); console.error(dlog.slice(-600)); try { daemon.kill(); } catch {} process.exit(1); });
