// Item 10 — proves the daemon survives its PARENT (the app) dying, not just a client
// disconnect. This is the real gapless-restart case: an auto-update QUITS the app's process
// and relaunches it; the detached daemon must keep playing across that. Two modes:
//   ETHER_SPIKE_FILE="...mp3" node audiod/accept-detach.js launch --i-am-off-air
//      → spawns the daemon DETACHED (exactly like audio-daemon-client), starts playout, then
//        THIS launcher process EXITS (simulating the app quitting/updating).
//   node audiod/accept-detach.js check
//      → from a brand-new process, confirms the orphaned daemon is still alive + playing.
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");
const MODE = process.argv[2];
const PIPE = "\\\\.\\pipe\\ether-audiod-detach";
const TMP  = path.join(os.tmpdir(), "ether-detachtest.db");
const PIDF = path.join(os.tmpdir(), "ether-detachtest.pid");
const SID = 99;
const ETHER = path.join(__dirname, "..", "dist-electron", "win-unpacked", "Ether.exe");
const RUNTIME = fs.existsSync(ETHER) ? ETHER : path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function conn() { return new Promise((res, rej) => { const s = net.connect(PIPE); s.once("connect", () => res(s)); s.once("error", rej); }); }
function rpc(s, cmd, a = {}) { return new Promise((res) => { const id = Math.floor(Math.random() * 1e9); let buf = ""; const onData = (d) => { buf += d.toString("utf8"); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id === id) { s.off("data", onData); res(m.result); return; } } }; s.on("data", onData); s.write(JSON.stringify({ id, cmd, ...a }) + "\n"); setTimeout(() => { s.off("data", onData); res(null); }, 3000); }); }
const playing = (st) => st && ["deckA", "deckB", "deckC"].some(d => st[d] && st[d].status === "playing");
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

(async () => {
  if (MODE === "launch") {
    if (!process.argv.includes("--i-am-off-air")) { console.error("Plays audio — pass --i-am-off-air."); process.exit(2); }
    const file = process.env.ETHER_SPIKE_FILE;
    if (!file) { console.error("Set ETHER_SPIKE_FILE."); process.exit(2); }
    const src = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Roaming", "com.ether.radio", "openair.db");
    for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP + e); } catch {} }
    fs.copyFileSync(src, TMP);
    // EXACTLY the audio-daemon-client spawn: detached + unref so it outlives this process.
    const daemon = cp.spawn(RUNTIME, [path.join(__dirname, "ether-audiod.js")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_DB_PATH: TMP, ETHER_AUDIOD_PIPE: PIPE }, detached: true, stdio: "ignore",
    });
    daemon.unref();
    fs.writeFileSync(PIDF, String(daemon.pid));
    // wait for up, start playout
    let s = null; for (let i = 0; i < 25; i++) { try { s = await conn(); break; } catch { await sleep(300); } }
    if (!s) { console.error("daemon never came up"); process.exit(1); }
    await rpc(s, "init", { stationId: SID });
    await rpc(s, "enqueue", { stationId: SID, items: [1, 2, 3, 4].map(i => ({ filePath: file, title: "Detach " + i, artist: "x", durationMs: 0 })) });
    await rpc(s, "automationStart", { stationId: SID });
    await sleep(2200);
    const st = await rpc(s, "getState", { stationId: SID });
    s.destroy();
    console.log("launcher: daemon pid=" + daemon.pid + " playing=" + playing(st));
    console.log("launcher EXITING NOW (simulates the app quitting / an update restart)…");
    process.exit(0);                       // ← parent dies; detached daemon must survive
  }

  if (MODE === "check") {
    const pid = Number(fs.readFileSync(PIDF, "utf8").trim());
    const alive = pidAlive(pid);
    let st = null; try { const s = await conn(); st = await rpc(s, "getState", { stationId: SID }); } catch {}
    const ok = alive && playing(st);
    console.log("daemon pid " + pid + " alive after parent died: " + alive);
    console.log("deck still playing (audio continued): " + playing(st));
    console.log("\n→ DETACH SURVIVAL: " + (ok
      ? "✅ the daemon OUTLIVED its parent process and kept playing — gapless across a real app quit/update"
      : "❌ daemon did NOT survive the parent dying — detached spawn is broken (this would be your dead air)"));
    // cleanup: stop the orphan + remove temp
    try { const s2 = await conn(); s2.write(JSON.stringify({ id: 0, cmd: "shutdown" }) + "\n"); await sleep(300); s2.destroy(); } catch {}
    for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TMP + e); } catch {} }
    try { fs.unlinkSync(PIDF); } catch {}
    process.exit(ok ? 0 : 1);
  }

  console.error("usage: accept-detach.js launch --i-am-off-air | check");
  process.exit(2);
})();
