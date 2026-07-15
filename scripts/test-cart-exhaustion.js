// test-cart-exhaustion.js — off-air proof for the 2026-07-15 CART crash fix (audio.rs:988 guard).
// Isolated harness (v4446/soak-isolation style): spawns its OWN daemon against a COPY of the DB, private
// pipe, monitor muted (cpal callback still fires — speakers silent). NEVER touches the live daemon.
// Loads a SHORT file onto the CART overlay channel (slot 6), plays it, and lets the source play to its
// NATURAL END so the mixer's "source exhausted" cleanup runs on the CART slot — the exact path that
// panicked (`DECK_LETTERS[6]` OOB) and killed the cpal output thread. Asserts: no panic; the output thread
// is still ALIVE (lastCallbackMs advancing) after exhaustion; the CART finished-flag set (deckCart ended);
// the station keeps rotating.  Run: node scripts/test-cart-exhaustion.js  (uses electron-as-node → dev .node)
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");

const STATION = 1;
const srcDb = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Local", "Ether", "com.ether.radio", "openair.db");
const tmp = path.join(os.tmpdir(), "ether-cart-" + process.pid + ".db");
fs.copyFileSync(srcDb, tmp);
for (const e of ["-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} }
const PIPE = "\\\\.\\pipe\\ether-cart-" + process.pid;
const wavPath = path.join(os.tmpdir(), "ether-cart-tone-" + process.pid + ".wav");
const daemonLog = path.join(os.tmpdir(), "ether-cart-daemon-" + process.pid + ".log");

// 2s stereo 44100 16-bit PCM WAV (quiet sine — audible check isn't the point; the exhaustion is).
function writeWav(p, seconds = 2) {
  const sr = 44100, ch = 2, bps = 2, n = sr * seconds;
  const data = Buffer.alloc(n * ch * bps);
  for (let i = 0; i < n; i++) { const s = Math.round(Math.sin(2 * Math.PI * 220 * i / sr) * 6000); data.writeInt16LE(s, (i * ch) * bps); data.writeInt16LE(s, (i * ch + 1) * bps); }
  const hdr = Buffer.alloc(44); hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write("WAVE", 8);
  hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(ch, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * ch * bps, 28); hdr.writeUInt16LE(ch * bps, 32); hdr.writeUInt16LE(bps * 8, 34);
  hdr.write("data", 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(p, Buffer.concat([hdr, data]));
}
writeWav(wavPath, 2);

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
function cleanup(code) { try { daemon.kill(); } catch {} setTimeout(() => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} } try { fs.unlinkSync(wavPath); } catch {} process.exit(code); }, 400); }

(async () => {
  console.log("[cart-test] isolated daemon (DB copy, muted) — proving CART plays to natural end without killing the output thread");
  let up = false; for (let i = 0; i < 80 && !(up = await pipeAlive()); i++) await sleep(500);
  ok("daemon started (pipe up)", up);
  if (!up) { try { console.error(fs.readFileSync(daemonLog, "utf8").split(/\r?\n/).slice(-25).join("\n")); } catch {} return cleanup(1); }
  const app = client(); await app.connect(); await app.cmd("ping");
  await app.cmd("init", { stationId: STATION });
  try { await app.cmd("setMonitorVolume", { stationId: STATION, volume: 0 }); } catch {}
  await app.cmd("automationStart", { stationId: STATION });
  await sleep(6000);
  const st0 = await app.cmd("getState", { stationId: STATION }).catch(() => null);
  ok("station airing (a deck playing)", !!(st0 && ["deckA", "deckB", "deckC"].some(d => st0[d] && st0[d].status === "playing")));
  const cb0 = Number(await app.cmd("lastCallbackMs", { stationId: STATION }).catch(() => 0));

  // Fire a jingle on CART and let it run to natural end.
  const dur = Number(await app.cmd("getFileDuration", { filePath: wavPath }).catch(() => 2));
  console.log(`[cart-test] loading ${dur.toFixed(2)}s tone onto CART, playing to natural end…`);
  await app.cmd("load", { deck: "CART", filePath: wavPath, title: "cart-exhaustion-test", artist: "", gainDb: 0, stationId: STATION });
  await app.cmd("play", { deck: "CART", stationId: STATION });
  await sleep(400);
  const lvMid = await app.cmd("getLevels", { stationId: STATION }).catch(() => ({}));
  ok("CART is firing (level_cart > 0 mid-play)", (lvMid && (lvMid.cart || lvMid.level_cart || 0) > 0.0001), `cart=${(lvMid && (lvMid.cart ?? lvMid.level_cart)) ?? "?"}`);

  // Let the CART source play to natural end + a margin so the exhaustion cleanup runs on the CART slot.
  await sleep(Math.max(2500, dur * 1000 + 2000));

  // Proofs.
  ok("NO panic in the daemon log (CART-exhaustion OOB fixed)", !logHasPanic());
  const cb1 = Number(await app.cmd("lastCallbackMs", { stationId: STATION }).catch(() => 0));
  // lastCallbackMs is "ms since the last cpal callback" — ALIVE = small/fresh, not frozen. Also confirm the
  // command round-trips at all (a dead daemon would time out). Frames advancing = the mixer thread lives.
  const lv1 = await app.cmd("getLevels", { stationId: STATION }).catch(() => null);
  const framesA = lv1 && (lv1.frames_total || 0);
  await sleep(600);
  const lv2 = await app.cmd("getLevels", { stationId: STATION }).catch(() => null);
  const framesB = lv2 && (lv2.frames_total || 0);
  ok("output thread ALIVE after CART exhaustion (frames still advancing)", (framesB > framesA), `frames ${framesA}→${framesB}`);
  const cbAgeMs = Date.now() - cb1;   // audioLastCallbackMs returns an ABSOLUTE epoch ms of the last callback
  ok("cpal callback fresh (fired recently — thread not frozen)", (cb1 > 0 && cbAgeMs >= 0 && cbAgeMs < 3000), `${cbAgeMs}ms since last callback`);
  const st1 = await app.cmd("getState", { stationId: STATION }).catch(() => null);
  const cartStatus = st1 && st1.deckCart && st1.deckCart.status;
  ok("CART finished-flag set via CART key (deckCart ended/idle, not stuck playing)", cartStatus === "ended" || cartStatus === "idle" || cartStatus === "", `deckCart=${cartStatus}`);
  ok("station STILL rotating (a deck playing after the fire)", !!(st1 && ["deckA", "deckB", "deckC"].some(d => st1[d] && st1[d].status === "playing")));

  const passed = results.every(r => r[1]);
  console.log(`\n${passed ? "✅ CART-EXHAUSTION PROOF — ALL PASS" : "❌ CART-EXHAUSTION PROOF — FAILURES"} (daemon log: ${daemonLog})`);
  cleanup(passed ? 0 : 1);
})().catch(e => { console.error("[cart-test] error:", e && e.message); cleanup(1); });
