// Station-isolation soak + injected-kill harness (DESIGN-TRUTH §2).
// Spawns its OWN daemon against a COPY of the dev DB (real DB untouched), private pipe, monitor
// muted (speakers silent; the cpal callback still fires so lastCallbackMs is the direct proof).
// Starts stations 1/2/3 on their real schedules, samples EACH station's own lastCallbackMs, counts
// wraps (playstarts), and mid-soak injects a per-station output kill+reopen on one station — proving
// the other two keep advancing (isolation) and the killed one self-recovers (its own reopen).
//
//   node scripts/soak-isolation.js --seconds 120 --kill-at 45 --kill-station 2
//   node scripts/soak-isolation.js --seconds 7200 --kill-at 600 --kill-station 2   # the 2h gate
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SECONDS      = Number(arg("--seconds", 120));
const KILL_AT      = Number(arg("--kill-at", Math.round(SECONDS * 0.35)));
const KILL_STATION = Number(arg("--kill-station", 2));
const STATIONS     = [1, 2, 3];
const SAMPLE_MS    = 3000;
const NAMES = { 1: "Open Format", 2: "halloVeen", 3: "Magical Forest" };

const srcDb = process.env.ETHER_DB_PATH ||
  path.join(os.homedir(), "AppData", "Local", "Ether", "com.ether.radio", "openair.db");
const tmp = path.join(os.tmpdir(), "ether-soak-" + process.pid + ".db");
fs.copyFileSync(srcDb, tmp);
for (const e of ["-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} }
const PIPE = "\\\\.\\pipe\\ether-soak-" + process.pid;

const packaged = path.join(__dirname, "..", "dist-electron", "win-unpacked", "Ether.exe");
const RUNTIME = (process.env.ETHER_USE_PACKAGED && fs.existsSync(packaged))
  ? packaged : path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const daemonLog = path.join(os.tmpdir(), "ether-soak-daemon-" + process.pid + ".log");
const dlog = fs.openSync(daemonLog, "a");
console.log("[soak] daemon log:", daemonLog);
const daemon = cp.spawn(RUNTIME, [path.join(__dirname, "..", "audiod", "ether-audiod.js")], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_DB_PATH: tmp, ETHER_AUDIOD_PIPE: PIPE }, stdio: ["ignore", dlog, dlog],
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const wraps = { 1: 0, 2: 0, 3: 0 };
function client() {
  const c = { sock: null, id: 0, buf: "", pending: new Map() };
  c.cmd = (cmd, a = {}) => new Promise((res, rej) => { const i = ++c.id; c.pending.set(i, { res, rej });
    c.sock.write(JSON.stringify({ id: i, cmd, ...a }) + "\n");
    setTimeout(() => { if (c.pending.has(i)) { c.pending.delete(i); rej(new Error("timeout " + cmd)); } }, 5000); });
  c.connect = () => new Promise((res, rej) => {
    c.sock = net.connect(PIPE);
    c.sock.once("connect", res); c.sock.once("error", rej);
    c.sock.on("data", d => { c.buf += d.toString("utf8"); let nl;
      while ((nl = c.buf.indexOf("\n")) >= 0) { const line = c.buf.slice(0, nl); c.buf = c.buf.slice(nl + 1);
        if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.event === "playstart" && wraps[m.stationId] != null) wraps[m.stationId]++;
        else if (m.id != null && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id);
          m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } } });
  });
  return c;
}
const pipeAlive = () => new Promise(res => { const s = net.connect(PIPE); let d = false;
  const f = a => { if (d) return; d = true; try { s.destroy(); } catch {} res(a); };
  s.once("connect", () => f(true)); s.once("error", () => f(false)); setTimeout(() => f(false), 1000); });
function cleanup(code) { try { daemon.kill(); } catch {}
  setTimeout(() => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} } process.exit(code); }, 400); }

const results = [];
const ok = (label, pass) => { results.push([label, pass]); console.log((pass ? "  PASS " : "  FAIL ") + label); };
const cbOf = async (app, sid) => { try { return Number(await app.cmd("lastCallbackMs", { stationId: sid })); } catch { return 0; } };

(async () => {
  console.log(`[soak] runtime=${path.basename(RUNTIME)} seconds=${SECONDS} kill-at=${KILL_AT}s kill-station=${KILL_STATION} (${NAMES[KILL_STATION]})`);
  // ── (1) daemon-start smoke ──────────────────────────────────────────────────
  let up = false; for (let i = 0; i < 80 && !(up = await pipeAlive()); i++) await sleep(500);   // up to 40s cold start
  ok("daemon started (pipe up)", up);
  if (!up) { console.error("[soak] daemon never bound pipe — tail of daemon log:");
    try { console.error(fs.readFileSync(daemonLog, "utf8").split(/\r?\n/).slice(-20).join("\n")); } catch {}
    return cleanup(1); }
  const app = client(); await app.connect(); await app.cmd("ping");
  for (const sid of STATIONS) { await app.cmd("init", { stationId: sid });
    try { await app.cmd("setMonitorVolume", { stationId: sid, volume: 0 }); } catch {}
    await app.cmd("automationStart", { stationId: sid }); }
  await sleep(6000);
  for (const sid of STATIONS) {
    const st = await app.cmd("getState", { stationId: sid }).catch(() => null);
    const playing = st && ["deckA","deckB","deckC"].some(d => st[d] && st[d].status === "playing");
    ok(`station ${sid} (${NAMES[sid]}) deck playing`, !!playing);
    ok(`station ${sid} lastCallbackMs > 0`, (await cbOf(app, sid)) > 0);
  }

  // ── (2)+(3) soak loop with mid-soak injected kill ───────────────────────────
  const t0 = Date.now(); let killed = false, killTs = 0, recoverTs = 0;
  let prev = {}; for (const sid of STATIONS) prev[sid] = await cbOf(app, sid);
  const advObserved = { 1: 0, 2: 0, 3: 0 };       // # samples a station's clock advanced
  const survivorStallsAtKill = [];                 // isolation violations during the kill window

  while ((Date.now() - t0) / 1000 < SECONDS) {
    await sleep(SAMPLE_MS);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const cur = {}; for (const sid of STATIONS) cur[sid] = await cbOf(app, sid);
    for (const sid of STATIONS) if (cur[sid] > prev[sid]) advObserved[sid]++;

    // Inject the kill once, at KILL_AT.
    if (!killed && elapsed >= KILL_AT) {
      killed = true; killTs = Date.now();
      const before = {}; for (const sid of STATIONS) before[sid] = cur[sid];
      console.log(`[soak] t=${elapsed}s INJECT kill+reopen on station ${KILL_STATION} (${NAMES[KILL_STATION]})`);
      await app.cmd("reopenOutput", { stationId: KILL_STATION }).catch(() => {});
      // Watch the recovery window: survivors must keep advancing; killed must resume.
      let recovered = false;
      for (let k = 0; k < 24; k++) {   // up to ~12s
        await sleep(500);
        const s = {}; for (const sid of STATIONS) s[sid] = await cbOf(app, sid);
        for (const sid of STATIONS) if (sid !== KILL_STATION) {
          if (!(s[sid] > before[sid])) survivorStallsAtKill.push({ sid, k });   // survivor stalled = isolation break
          before[sid] = Math.max(before[sid], s[sid]);
        }
        if (!recovered && s[KILL_STATION] > cur[KILL_STATION] + 200) { recovered = true; recoverTs = Date.now(); }
      }
      ok(`survivors kept advancing through station-${KILL_STATION} kill (isolation)`, survivorStallsAtKill.length === 0);
      ok(`killed station ${KILL_STATION} self-recovered (clock advancing again)`, recovered);
      if (recovered) console.log(`[soak] station ${KILL_STATION} recovery time: ${((recoverTs - killTs) / 1000).toFixed(1)}s`);
    }
    prev = cur;
    if (elapsed % 30 === 0) console.log(`[soak] t=${elapsed}s wraps=${JSON.stringify(wraps)} adv=${JSON.stringify(advObserved)}`);
  }

  // ── receipts ────────────────────────────────────────────────────────────────
  const totalSamples = Math.floor((SECONDS / (SAMPLE_MS / 1000)));
  for (const sid of STATIONS) ok(`station ${sid} advanced most samples (${advObserved[sid]}/~${totalSamples})`, advObserved[sid] >= totalSamples * 0.7);
  console.log(`\n[soak] wrap-survival counts: ${JSON.stringify(wraps)}`);
  console.log(`[soak] per-station clock advancement: ${JSON.stringify(advObserved)} of ~${totalSamples} samples`);
  const passed = results.every(([, p]) => p);
  console.log(`\n[soak] ${passed ? "ALL PASS" : "FAILURES PRESENT"} (${results.filter(([,p])=>p).length}/${results.length})`);
  cleanup(passed ? 0 : 1);
})().catch(e => { console.error("[soak] fatal:", e); cleanup(1); });
