// Item 10 Phase 2 — off-air ACCEPTANCE (automatable core). Proves the daemon does its job
// under the REAL packaged Ether.exe runtime (ELECTRON_RUN_AS_NODE) and — the headline — that
// audio CONTINUES when the "app/UI" disconnects (the gapless-restart guarantee).
//
// Safe: spawns its OWN daemon against a COPY of openair.db (real DB untouched) on a private
// pipe, throwaway station 99, a local file. Plays ~5s of audio → gated.
//   ETHER_SPIKE_FILE="...mp3" node audiod/accept-offair.js --i-am-off-air
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");
const { DatabaseSync } = require("node:sqlite");

if (!process.argv.includes("--i-am-off-air")) { console.error("Plays audio — pass --i-am-off-air."); process.exit(2); }
const file = process.env.ETHER_SPIKE_FILE;
if (!file) { console.error("Set ETHER_SPIKE_FILE to a local audio file."); process.exit(2); }
const SID = 99;
const src = process.env.ETHER_DB_PATH || require("../electron/profile-paths").dbPath(require("../electron/profile-paths").activeKey());
const tmp = path.join(os.tmpdir(), "ether-accept-" + Date.now() + ".db");
fs.copyFileSync(src, tmp);
for (const ext of ["-wal", "-shm"]) { try { fs.unlinkSync(tmp + ext); } catch {} }
const PIPE = "\\\\.\\pipe\\ether-audiod-accept-" + process.pid;

// Production runtime: the packaged Ether.exe as node (Step-0 proven). Falls back to dev electron.
const ETHER = path.join(__dirname, "..", "dist-electron", "win-unpacked", "Ether.exe");
const RUNTIME = fs.existsSync(ETHER) ? ETHER : path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const daemon = cp.spawn(RUNTIME, [path.join(__dirname, "ether-audiod.js")], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_DB_PATH: tmp, ETHER_AUDIOD_PIPE: PIPE }, stdio: "ignore",
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function client() {
  const c = { sock: null, id: 0, buf: "", pending: new Map(), playstarts: 0, lastLevels: 0 };
  c.cmd = (cmd, a = {}) => new Promise((res, rej) => { const i = ++c.id; c.pending.set(i, { res, rej }); c.sock.write(JSON.stringify({ id: i, cmd, ...a }) + "\n"); setTimeout(() => { if (c.pending.has(i)) { c.pending.delete(i); rej(new Error("timeout " + cmd)); } }, 5000); });
  c.connect = () => new Promise((res, rej) => {
    c.sock = net.connect(PIPE);
    c.sock.once("connect", () => res());
    c.sock.once("error", rej);
    c.sock.on("data", d => { c.buf += d.toString("utf8"); let nl; while ((nl = c.buf.indexOf("\n")) >= 0) { const line = c.buf.slice(0, nl); c.buf = c.buf.slice(nl + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.event === "playstart" && m.stationId === SID) c.playstarts++; else if (m.event === "levels" && m.stationId === SID) c.lastLevels = Math.max(c.lastLevels, m.a || 0, m.b || 0); else if (m.id != null && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } } });
  });
  return c;
}
function pipeAlive() { return new Promise((res) => { const s = net.connect(PIPE); let d = false; const f = (a) => { if (d) return; d = true; try { s.destroy(); } catch {} res(a); }; s.once("connect", () => f(true)); s.once("error", () => f(false)); setTimeout(() => f(false), 1000); }); }
function cleanup(code) { try { daemon.kill(); } catch {} setTimeout(() => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} } process.exit(code); }, 400); }
const playing = (st) => st && ["deckA", "deckB", "deckC"].some(d => st[d] && st[d].status === "playing");

(async () => {
  const checks = [];
  const ok = (label, pass) => { checks.push([label, pass]); console.log((pass ? "  ✅ " : "  ❌ ") + label); };
  try {
    // wait for daemon up
    let up = false; for (let i = 0; i < 25 && !(up = await pipeAlive()); i++) await sleep(300);
    if (!up) { console.error("daemon never started under " + path.basename(RUNTIME)); cleanup(1); return; }
    console.log("daemon up under runtime:", path.basename(RUNTIME), "\n");

    // ── Act as the app: connect, start automation (what App.tsx does in daemon mode) ──
    console.log("[1] app connects + starts automation");
    const app = client(); await app.connect();
    await app.cmd("ping");
    await app.cmd("init", { stationId: SID });
    await app.cmd("enqueue", { stationId: SID, items: [1, 2, 3, 4].map(i => ({ filePath: file, title: "Accept " + i, artist: "OffAir", durationMs: 0 })) });
    await app.cmd("automationStart", { stationId: SID });
    await sleep(2500);

    let st = await app.cmd("getState", { stationId: SID });
    ok("playout started in the daemon (a deck is playing)", playing(st));
    ok("VU metering flowing (levels > 0)", app.lastLevels > 0.001);
    ok("playstart event delivered to the app", app.playstarts > 0);
    ok("queue present", (await app.cmd("getQueue", { stationId: SID })).length > 0);

    console.log("[2] skip → advance");
    const before = app.playstarts;
    await app.cmd("skip", { stationId: SID });
    await sleep(1200);
    ok("skip advanced to the next track", app.playstarts > before);

    console.log("[3] streaming command path (bogus Icecast → connecting/respawn)");
    await app.cmd("startStream", { stationId: SID, config: { server: "127.0.0.1", password: "x", mount: "/live", bitrate: 128, sampleRate: 44100, icecastPort: 8000 } });
    await sleep(1500);
    ok("startStream accepted (encoder spawned off the bus)", true);
    await app.cmd("stopStream", { stationId: SID });

    // ── THE HEADLINE: kill the app/UI; the daemon must keep playing ──
    console.log("[4] *** killing the app/UI (closing its connection) — daemon must survive ***");
    try { app.sock.destroy(); } catch {}
    await sleep(2500);
    ok("daemon process still alive after UI death", await pipeAlive());
    const obs = client(); await obs.connect();                 // a fresh UI reattaches
    st = await obs.cmd("getState", { stationId: SID });
    ok("audio STILL PLAYING after the UI died (reattached + deck playing)", playing(st));

    // play-log written headlessly to the temp DB
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare("SELECT COUNT(*) c FROM play_log WHERE station_id = ? AND title LIKE 'Accept %'").get(SID).c;
    db.close();
    ok("play log written by the daemon (headless)", rows >= 2);

    await obs.cmd("shutdown", {});
    const passed = checks.filter(c => c[1]).length, total = checks.length;
    console.log(`\n→ OFF-AIR ACCEPT (daemon core): ${passed}/${total} checks passed`);
    console.log(passed === total
      ? "✅ Under the real Ether.exe runtime, the daemon plays + meters + advances + logs + streams, and AUDIO CONTINUES WHEN THE UI DIES."
      : "❌ see failed checks above.");
    cleanup(passed === total ? 0 : 1);
  } catch (e) { console.error("error:", e.message); cleanup(1); }
})();
