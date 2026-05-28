// Item 10 Phase 2 Step 5 verification: the daemon's StreamSupervisor spawns ffmpeg off the
// daemon's OWN program bus, reports status, and respawns/gives-up on failure. Points at a
// bogus local Icecast (127.0.0.1:8000, nothing listening → connection refused) so we exercise
// the full lifecycle without a real server — the successful encode-from-bus is already proven
// by scripts/spike-ffmpeg-from-programbus.js.
//
// Inits an audio engine (output device, silent — no track loaded) → gated. Private daemon +
// pipe; touches no real config.
//   node audiod/smoke-stream.js --i-am-off-air
const net = require("net"), path = require("path"), cp = require("child_process");
if (!process.argv.includes("--i-am-off-air")) { console.error("Inits the audio engine — pass --i-am-off-air."); process.exit(2); }
const SID = 99;
const PIPE = "\\\\.\\pipe\\ether-audiod-streamtest-" + process.pid;

const daemon = cp.spawn(process.execPath, [path.join(__dirname, "ether-audiod.js")], { env: { ...process.env, ETHER_AUDIOD_PIPE: PIPE }, stdio: "ignore" });

let id = 0, buf = "", sock;
const pending = new Map();
const cmd = (c, a = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); sock.write(JSON.stringify({ id: i, cmd: c, ...a }) + "\n"); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("timeout " + c)); } }, 5000); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const states = [];          // sequence of stream states observed
let lastErr = null;
function cleanup(code) { try { daemon.kill(); } catch {} setTimeout(() => process.exit(code), 200); }

function connect(retries) {
  sock = net.connect(PIPE);
  sock.on("connect", run);
  sock.on("error", () => { if (retries > 0) setTimeout(() => connect(retries - 1), 300); else { console.error("could not connect to test daemon"); cleanup(1); } });
  sock.on("data", d => { buf += d.toString("utf8"); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.event === "stream" && m.stationId === SID) { states.push(m.state); if (m.errorMsg) lastErr = m.errorMsg; console.log("  stream:", m.state, m.errorMsg ? "(" + m.errorMsg + ")" : ""); } else if (m.id != null && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } } });
}

async function run() {
  try {
    await cmd("ping");
    await cmd("init", { stationId: SID });          // brings up the program-bus TCP port
    await sleep(300);
    console.log("startStream → bogus 127.0.0.1:8000 (expect connecting + respawns; encode-from-bus already proven by the ffmpeg spike)…");
    await cmd("startStream", { stationId: SID, config: { server: "127.0.0.1", password: "x", mount: "/live", bitrate: 128, sampleRate: 44100, icecastPort: 8000 } });
    // Collect the lifecycle. The core proof is: ffmpeg spawned off the bus + status emitted +
    // respawned on failure (the 3×/10s backoff). Terminal give-up timing depends on ffmpeg's
    // OS-level connect-fail latency, so we report it but don't gate on it.
    await sleep(7000);
    const everError = states.includes("error") || !!lastErr;
    await cmd("stopStream", { stationId: SID });

    const sawConnecting = states.includes("connecting");
    const connectingCount = states.filter(s => s === "connecting").length;   // ≥2 ⇒ respawned
    console.log(`\nstates: [${states.join(" → ")}]`);
    console.log(`connecting events: ${connectingCount} (≥2 ⇒ respawn works) | reached error/give-up: ${everError} | lastErr: ${lastErr}`);
    const ok = sawConnecting && connectingCount >= 2;
    console.log("\n→ STEP 5 VERDICT: " + (ok
      ? "✅ daemon spawns ffmpeg off its OWN program bus, emits status, and respawns on failure — the encoder lives in the daemon (encode-from-bus proven separately by spike-ffmpeg-from-programbus.js)"
      : "❌ see above"));
    cleanup(ok ? 0 : 1);
  } catch (e) { console.error("error:", e.message); cleanup(1); }
}
setTimeout(() => connect(20), 900);
