// test-fader-invariant.js — the ABSOLUTE rule: automation NEVER writes a deck fader.
// Isolated daemon (own process, DB copy, monitor muted). Pins 11 short tones and runs the station through
// 10 automatic segues (overlap on) while firing the CART overlay (a jingle) twice mid-run to stand in for
// jingle seams. Samples deck A/B/C fader volume ~10Hz the WHOLE time and asserts every reading is exactly
// 1.0 — no programmatic fader movement, ever. Run: node scripts/test-fader-invariant.js
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");

const STATION = 1, OVERLAP = 2, SONG_SEC = 6, TONES = 11, TARGET_SEGUES = 10;
const srcDb = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Local", "Ether", "com.ether.radio", "openair.db");
const tmp = path.join(os.tmpdir(), "ether-fader-" + process.pid + ".db");
fs.copyFileSync(srcDb, tmp);
for (const e of ["-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} }
const PIPE = "\\\\.\\pipe\\ether-fader-" + process.pid;
const daemonLog = path.join(os.tmpdir(), "ether-fader-daemon-" + process.pid + ".log");
const wavs = [], cartWav = path.join(os.tmpdir(), `ether-fader-cart-${process.pid}.wav`);

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
for (let i = 0; i < TONES; i++) { const p = path.join(os.tmpdir(), `ether-fader-${process.pid}-${i}.wav`); writeWav(p, SONG_SEC, 200 + i * 30); wavs.push(p); }
writeWav(cartWav, 2, 660);

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
function cleanup(code) { try { daemon.kill(); } catch {} setTimeout(() => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} } [...wavs, cartWav].forEach(w => { try { fs.unlinkSync(w); } catch {} }); process.exit(code); }, 400); }

(async () => {
  console.log(`[fader-test] isolated daemon (DB copy, muted) — proving automation NEVER moves a deck fader across ${TARGET_SEGUES} segues + jingle fires`);
  let up = false; for (let i = 0; i < 80 && !(up = await pipeAlive()); i++) await sleep(500);
  ok("daemon started (pipe up)", up);
  if (!up) { try { console.error(fs.readFileSync(daemonLog, "utf8").split(/\r?\n/).slice(-25).join("\n")); } catch {} return cleanup(1); }
  const app = client(); await app.connect(); await app.cmd("ping");
  await app.cmd("init", { stationId: STATION });
  try { await app.cmd("setMonitorVolume", { stationId: STATION, volume: 0 }); } catch {}
  await app.cmd("setSegueOverlap", { stationId: STATION, seconds: OVERLAP });
  await app.cmd("setContinuous", { stationId: STATION, value: false });
  await app.cmd("replaceQueue", { stationId: STATION, items: wavs.map((w, i) => ({ filePath: w, title: "tone-" + i, artist: "", durationMs: SONG_SEC * 1000 })) });
  await app.cmd("automationStart", { stationId: STATION });

  let worstVol = 1, worstDeck = "", samples = 0;      // track the largest |deckVol − 1.0| over A/B/C
  let segues = 0, cartFires = 0, lastPlaying = null;
  const firedAt = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && segues < TARGET_SEGUES) {
    const st = await app.cmd("getState", { stationId: STATION }).catch(() => null);
    if (st) {
      // *** the invariant: every rotation-deck fader must read exactly 1.0, always ***
      for (const d of ["deckA", "deckB", "deckC"]) {
        const v = st[d] && typeof st[d].volume === "number" ? st[d].volume : 1;
        samples++;
        if (Math.abs(v - 1) > Math.abs(worstVol - 1)) { worstVol = v; worstDeck = d; }
      }
      const playing = ["deckA", "deckB", "deckC"].find(d => st[d] && st[d].status === "playing") || null;
      if (playing && lastPlaying && playing !== lastPlaying) {
        segues++;
        // Simulate a jingle seam on the 3rd and 7th segue: fire the CART overlay.
        if ((segues === 3 || segues === 7) && !firedAt.has(segues)) {
          firedAt.add(segues);
          await app.cmd("load", { stationId: STATION, deck: "CART", filePath: cartWav, title: "jingle", artist: "", gainDb: 0 }).catch(() => {});
          await app.cmd("play", { stationId: STATION, deck: "CART" }).catch(() => {});
          cartFires++;
        }
      }
      if (playing) lastPlaying = playing;
    }
    await sleep(100);
  }

  ok(`${TARGET_SEGUES} automatic segues completed`, segues >= TARGET_SEGUES, `${segues} segues`);
  ok("jingle (CART) fired mid-run to stand in for jingle seams", cartFires >= 2, `${cartFires} CART fires`);
  ok(`*** every deck fader read EXACTLY 1.0 across all ${samples} samples ***`, Math.abs(worstVol - 1) < 1e-6, `worst = ${worstDeck} @ ${worstVol.toFixed(4)}`);
  ok("NO panic in the daemon log", !logHasPanic());

  const passed = results.every(r => r[1]);
  console.log(`\n${passed ? "✅ FADER-INVARIANT PROOF — ALL PASS" : "❌ FADER-INVARIANT PROOF — FAILURES"} (daemon log: ${daemonLog})`);
  cleanup(passed ? 0 : 1);
})().catch(e => { console.error("[fader-test] error:", e && e.message); cleanup(1); });
