// Smoke test for ether-audiod (Item 10, Phase 1 scaffold): connect over the named pipe,
// drive the engine (init → load → play), and verify real `levels` events stream back —
// proving the IPC + engine end-to-end over the pipe. Plays ~3s of audio → gated.
//   1) node audiod/ether-audiod.js        (in one shell)
//   2) ETHER_SPIKE_FILE="...mp3" node audiod/smoke-test.js --i-am-off-air
const net = require("net");
const PIPE = process.env.ETHER_AUDIOD_PIPE || "\\\\.\\pipe\\ether-audiod";

if (!process.argv.includes("--i-am-off-air")) { console.error("Plays audio — pass --i-am-off-air."); process.exit(2); }
const file = process.env.ETHER_SPIKE_FILE;
if (!file) { console.error("Set ETHER_SPIKE_FILE to a local audio file."); process.exit(2); }
const SID = 99;

let id = 0, maxLevel = 0, levelEvents = 0, buf = "";
const pending = new Map();
const cmd = (c, args = {}) => new Promise((resolve, reject) => {
  const myId = ++id; pending.set(myId, { resolve, reject });
  sock.write(JSON.stringify({ id: myId, cmd: c, ...args }) + "\n");
});

const sock = net.connect(PIPE, async () => {
  console.log("connected to ether-audiod");
  console.log("ping →", await cmd("ping"));
  await cmd("init", { stationId: SID });
  await cmd("setVolume", { stationId: SID, deck: "A", volume: 0.4 });
  await cmd("load", { stationId: SID, deck: "A", filePath: file, title: "Smoke" });
  await cmd("play", { stationId: SID, deck: "A" });
  console.log("program-bus port (via pipe):", await cmd("getProgramBusPort", { stationId: SID }));
  setTimeout(async () => {
    await cmd("stop", { stationId: SID, deck: "A" });
    console.log("\n" + (maxLevel > 0.001 ? "✅" : "❌") + " max level over pipe: " + maxLevel.toFixed(3) + "  (" + levelEvents + " levels events)");
    console.log(maxLevel > 0.001 ? "→ engine driven + metered entirely over the named pipe. Daemon IPC works end-to-end." : "→ no signal — check the daemon/file.");
    sock.end(); process.exit(maxLevel > 0.001 ? 0 : 1);
  }, 3000);
});

sock.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.event === "levels" && m.stationId === SID) { levelEvents++; if ((m.a || 0) > maxLevel) maxLevel = m.a; }
    else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); }
  }
});
sock.on("error", (e) => { console.error("connect failed:", e.message, "\n→ start the daemon first: node audiod/ether-audiod.js"); process.exit(1); });
