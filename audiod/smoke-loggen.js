// Scheduler proof for ether-audiod (Item 10, Phase 1 step 3): drive the daemon's
// node:sqlite-backed loggen against the REAL library and print the on-format queue it
// produces — proving the scheduler runs inside the daemon with no renderer.
//
// READ-ONLY: `fill` only reads the DB + builds the in-memory queue; it loads no decks and
// plays NO audio (no initAudioEngine), so it's safe to run against the live station id.
//   1) node audiod/ether-audiod.js
//   2) node audiod/smoke-loggen.js            (station 1 by default; ETHER_SMOKE_SID to override)
const net = require("net");
const PIPE = process.env.ETHER_AUDIOD_PIPE || "\\\\.\\pipe\\ether-audiod";
const SID = Number(process.env.ETHER_SMOKE_SID || 1);

let id = 0, buf = "";
const pending = new Map();
const cmd = (c, args = {}) => new Promise((resolve, reject) => { const myId = ++id; pending.set(myId, { resolve, reject }); sock.write(JSON.stringify({ id: myId, cmd: c, ...args }) + "\n"); });

const sock = net.connect(PIPE, async () => {
  try {
    await cmd("ping");
    await cmd("fill", { stationId: SID });
    const q = await cmd("getQueue", { stationId: SID });
    console.log(`\nstation ${SID}: scheduler produced ${q.length} on-format tracks (via node:sqlite, in-daemon):\n`);
    q.slice(0, 20).forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t.title}${t.artist ? " — " + t.artist : ""}`));
    const ok = q.length > 0;
    console.log("\n" + (ok ? "✅" : "❌") + ` daemon scheduler ${ok ? "produced an on-format queue" : "returned nothing — check the station's schedule/clocks"}.`);
    sock.end(); process.exit(ok ? 0 : 1);
  } catch (e) { console.error("error:", e.message); process.exit(1); }
});

sock.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); }
  }
});
sock.on("error", (e) => { console.error("connect failed:", e.message, "\n→ start the daemon first: node audiod/ether-audiod.js"); process.exit(1); });
