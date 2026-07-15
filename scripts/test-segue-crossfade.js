// test-segue-crossfade.js — OFF-AIR proof for the routine segue crossfade (4.4.63).
// Isolated harness (soak-isolation style): spawns its OWN daemon against a COPY of the DB, private pipe,
// monitor muted (levels are post-fader / pre-monitor, so they still read true program audio). NEVER
// touches the live daemon. Enqueues three SHORT tones, starts automation with segueCrossfade=3, and
// watches ONE automatic A→B segue. Asserts:
//   1. the OUTGOING deck's fader RAMPS 1 → ~0 before it ends (the fade — observed on deckA.volume),
//   2. the INCOMING deck starts while the outgoing is still audible (overlap, not a hard cut),
//   3. the master program level NEVER drops to silence across the seam (music never stops — the weave),
//   4. no panic in the daemon log.
// Run: node scripts/test-segue-crossfade.js   (uses electron-as-node → dev .node)
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");

const STATION = 1;
const SEGUE = 3;              // seconds
const srcDb = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Local", "Ether", "com.ether.radio", "openair.db");
const tmp = path.join(os.tmpdir(), "ether-segue-" + process.pid + ".db");
fs.copyFileSync(srcDb, tmp);
for (const e of ["-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} }
const PIPE = "\\\\.\\pipe\\ether-segue-" + process.pid;
const daemonLog = path.join(os.tmpdir(), "ether-segue-daemon-" + process.pid + ".log");
const wavs = [];

// N-second stereo 44100 16-bit PCM WAV at frequency `hz`.
function writeWav(p, seconds, hz) {
  const sr = 44100, ch = 2, bps = 2, n = sr * seconds;
  const data = Buffer.alloc(n * ch * bps);
  for (let i = 0; i < n; i++) { const s = Math.round(Math.sin(2 * Math.PI * hz * i / sr) * 8000); data.writeInt16LE(s, (i * ch) * bps); data.writeInt16LE(s, (i * ch + 1) * bps); }
  const hdr = Buffer.alloc(44); hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(ch, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * ch * bps, 28); hdr.writeUInt16LE(ch * bps, 32); hdr.writeUInt16LE(bps * 8, 34);
  hdr.write("data", 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(p, Buffer.concat([hdr, data]));
}
[220, 330, 440].forEach((hz, i) => { const p = path.join(os.tmpdir(), `ether-segue-${process.pid}-${i}.wav`); writeWav(p, 10, hz); wavs.push(p); });

const RUNTIME = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const dlog = fs.openSync(daemonLog, "a");
const daemon = cp.spawn(RUNTIME, [path.join(__dirname, "..", "audiod", "ether-audiod.js")], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_DB_PATH: tmp, ETHER_AUDIOD_PIPE: PIPE }, stdio: ["ignore", dlog, dlog],
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pipeAlive = () => new Promise(res => { const s = net.connect(PIPE); let d = false; const f = a => { if (d) return; d = true; try { s.destroy(); } catch {} res(a); }; s.once("connect", () => f(true)); s.once("error", () => f(false)); setTimeout(() => f(false), 1000); });
function client() {
  const c = { sock: null, id: 0, buf: "", pending: new Map() };
  c.cmd = (cmd, a = {}) => new Promise((res, rej) => { const i = ++c.id; c.pending.set(i, { res, rej }); c.sock.write(JSON.stringify({ id: i, cmd, ...a }) + "\n"); setTimeout(() => { if (c.pending.has(i)) { c.pending.delete(i); rej(new Error("timeout " + cmd)); } }, 5000); });
  c.connect = () => new Promise((res, rej) => { c.sock = net.connect(PIPE); c.sock.once("connect", res); c.sock.once("error", rej);
    c.sock.on("data", d => { c.buf += d.toString("utf8"); let nl; while ((nl = c.buf.indexOf("\n")) >= 0) { const line = c.buf.slice(0, nl); c.buf = c.buf.slice(nl + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.ok ? p.res(m.result) : p.rej(new Error(m.error)); } } }); });
  return c;
}
const results = [];
const ok = (label, pass, detail) => { results.push([label, pass]); console.log((pass ? "  PASS " : "  FAIL ") + label + (detail ? " — " + detail : "")); };
const logHasPanic = () => { try { return /panicked/.test(fs.readFileSync(daemonLog, "utf8")); } catch { return false; } };
function cleanup(code) { try { daemon.kill(); } catch {} setTimeout(() => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} } wavs.forEach(w => { try { fs.unlinkSync(w); } catch {} }); process.exit(code); }, 400); }

(async () => {
  console.log("[segue-test] isolated daemon (DB copy, muted) — proving the routine segue crossfade fades the outgoing while music never stops");
  let up = false; for (let i = 0; i < 80 && !(up = await pipeAlive()); i++) await sleep(500);
  ok("daemon started (pipe up)", up);
  if (!up) { try { console.error(fs.readFileSync(daemonLog, "utf8").split(/\r?\n/).slice(-25).join("\n")); } catch {} return cleanup(1); }
  const app = client(); await app.connect(); await app.cmd("ping");
  await app.cmd("init", { stationId: STATION });
  try { await app.cmd("setMonitorVolume", { stationId: STATION, volume: 0 }); } catch {}
  await app.cmd("setSegueCrossfade", { stationId: STATION, seconds: SEGUE });
  // Pin the queue to our short tones: continuous=false stops the scheduler refill (which would purge
  // our non-scheduled rows and play a real 3-min song), so the A→B segue happens in seconds.
  await app.cmd("setContinuous", { stationId: STATION, value: false });
  await app.cmd("replaceQueue", { stationId: STATION, items: wavs.map((w, i) => ({ filePath: w, title: "tone-" + i, artist: "", durationMs: 10000 })) });
  await app.cmd("automationStart", { stationId: STATION });

  // Wait for deck A to be playing.
  let playing = false;
  for (let i = 0; i < 40; i++) { const st = await app.cmd("getState", { stationId: STATION }).catch(() => null); if (st && st.deckA && st.deckA.status === "playing") { playing = true; break; } await sleep(250); }
  ok("station airing (deck A playing)", playing);
  if (!playing) return cleanup(1);

  // Sample state+levels ~10Hz until we observe a full A→B segue (B goes live), or time out.
  let minAvolWhilePlaying = 1, sawOverlap = false, minMasterAcrossSeam = 1, bLive = false, aEndedAt = 0, gapObserved = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 14000) {
    const st = await app.cmd("getState", { stationId: STATION }).catch(() => null);
    const lv = await app.cmd("getLevels", { stationId: STATION }).catch(() => null);
    if (st && lv) {
      const aStat = st.deckA && st.deckA.status, bStat = st.deckB && st.deckB.status;
      const aVol = (st.deckA && typeof st.deckA.volume === "number") ? st.deckA.volume : 1;
      const master = lv.master ?? 0, aLvl = lv.a ?? 0, bLvl = lv.b ?? 0;
      if (aStat === "playing") minAvolWhilePlaying = Math.min(minAvolWhilePlaying, aVol);
      // Overlap: both decks contributing audio at the same time (the crossfade window).
      if (aStat === "playing" && bStat === "playing" && aLvl > 0.001 && bLvl > 0.001) sawOverlap = true;
      // Across the seam (B live), the master program level must stay up (no silence gap).
      if (bStat === "playing") { bLive = true; minMasterAcrossSeam = Math.min(minMasterAcrossSeam, master); if (master < 0.0005) gapObserved = true; }
      if (bLive && aStat !== "playing") { aEndedAt = Date.now(); break; }  // segue complete
    }
    await sleep(100);
  }

  ok("outgoing deck A FADED (fader ramped 1 → low before it ended)", minAvolWhilePlaying <= 0.5, `min deckA.volume while playing = ${minAvolWhilePlaying.toFixed(3)}`);
  ok("incoming deck B started (segue advanced)", bLive);
  ok("crossfade OVERLAP observed (both decks audible together)", sawOverlap);
  ok("music never stopped across the seam (no silence gap)", bLive && !gapObserved, `min master across seam = ${minMasterAcrossSeam.toFixed(4)}`);
  ok("NO panic in the daemon log", !logHasPanic());

  const passed = results.every(r => r[1]);
  console.log(`\n${passed ? "✅ SEGUE-CROSSFADE PROOF — ALL PASS" : "❌ SEGUE-CROSSFADE PROOF — FAILURES"} (daemon log: ${daemonLog})`);
  cleanup(passed ? 0 : 1);
})().catch(e => { console.error("[segue-test] error:", e && e.message); cleanup(1); });
