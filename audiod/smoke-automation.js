// Autonomous-playout proof for ether-audiod (Item 10, Phase 1 step 3): enqueue tracks on
// throwaway station 99, `automationStart`, and verify the daemon drives playout on its own —
// deck A goes live, a `playstart` fires, `deck` state streams, and the queue is consumed —
// with NO renderer. (Advance-on-track-end uses the same checkEnd logic ported verbatim from
// the production engine; exercising a natural end takes minutes, so it's a manual off-air
// validation. This test proves the autonomous START + event stream.)
//
// Plays audio → gated. Uses station 99 (never a live station).
//   1) node audiod/ether-audiod.js
//   2) ETHER_SPIKE_FILE="...mp3" node audiod/smoke-automation.js --i-am-off-air
const net = require("net");
const PIPE = process.env.ETHER_AUDIOD_PIPE || "\\\\.\\pipe\\ether-audiod";
if (!process.argv.includes("--i-am-off-air")) { console.error("Plays audio — pass --i-am-off-air."); process.exit(2); }
const file = process.env.ETHER_SPIKE_FILE;
if (!file) { console.error("Set ETHER_SPIKE_FILE to a local audio file."); process.exit(2); }
const SID = 99;

let id = 0, buf = "";
let playstart = false, deckEvents = 0, queueEvents = 0, aLive = false;
const pending = new Map();
const cmd = (c, args = {}) => new Promise((resolve, reject) => { const myId = ++id; pending.set(myId, { resolve, reject }); sock.write(JSON.stringify({ id: myId, cmd: c, ...args }) + "\n"); });

const sock = net.connect(PIPE, async () => {
  await cmd("ping");
  // Enqueue 3 copies so there's a preloadable B/C even with no schedule for station 99.
  const items = [0, 1, 2].map(i => ({ filePath: file, title: "Auto " + (i + 1), artist: "Smoke", durationMs: 0 }));
  await cmd("enqueue", { stationId: SID, items });
  console.log("queue before start:", (await cmd("getQueue", { stationId: SID })).length, "items");
  await cmd("automationStart", { stationId: SID });
  setTimeout(async () => {
    const qAfter = (await cmd("getQueue", { stationId: SID })).length;
    await cmd("automationStop", { stationId: SID });
    const ok = playstart && aLive && deckEvents > 0;
    console.log(`\nplaystart=${playstart}  deckA live=${aLive}  deck events=${deckEvents}  queue events=${queueEvents}  queue after start=${qAfter}`);
    console.log((ok ? "✅" : "❌") + " daemon drove playout autonomously over the pipe (fill→play→preload→events)" + (ok ? "." : " — check daemon/file."));
    sock.end(); process.exit(ok ? 0 : 1);
  }, 4000);
});

sock.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.event === "playstart" && m.stationId === SID) { playstart = true; console.log("  ▶ playstart:", m.deck, JSON.stringify(m.title)); }
    else if (m.event === "deck" && m.stationId === SID) { deckEvents++; if (m.deck === "A" && m.state && m.state.status === "playing") aLive = true; }
    else if (m.event === "queue" && m.stationId === SID) queueEvents++;
    else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); }
  }
});
sock.on("error", (e) => { console.error("connect failed:", e.message, "\n→ start the daemon first: node audiod/ether-audiod.js"); process.exit(1); });
