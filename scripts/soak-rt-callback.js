// soak-rt-callback.js — SLICE 1 real-time SOAK (docs/dsp-rt-callback.md §9 · spec §4 slice 1 verification:
// "soak at smallest buffer size while loading tracks and moving sliders: zero xruns, no clicks").
//
// Isolated, like scripts/test-segue-overlap.js: its OWN daemon, against a COPY of the DB, on a private pipe.
// It never touches a running Ether. It PLAYS AUDIO through this machine's output device (monitor turned to
// its lowest non-zero level so the callback still runs a real device path) — run it only where that is OK.
//
// What it does:
//   · starts the daemon with ETHER_SOAK_BUFFER_FRAMES (default "min" — the device's smallest period)
//   · turns AUTO on for one station with continuous fill, so the station's own catalogue loads track after
//     track through the new decode workers
//   · moves "sliders" the whole time: the master GEQ toggles every 5 s, deck C's fader 1.0 ↔ 0.95 every 3 s
//   · every 60 s prints the audio callback's counters (DELTAS and totals) and the tracks started so far
//   · at the end: totals, the SOAK / UNDERRUN / panic lines from the daemon log, and PASS only if underruns,
//     overruns and lock misses are all 0
//
// It REFUSES to run unless the engine reports the slice-1 counters (rt_callbacks) — i.e. unless
// native/ether-audio.node is the slice-1 build. See the soak instructions for swapping it in and back.
//
// Run:  node scripts/soak-rt-callback.js [--minutes 60] [--station 1] [--buffer min|<frames>]
"use strict";
const net = require("net"), path = require("path"), os = require("os"), fs = require("fs"), cp = require("child_process");

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MINUTES = Number(arg("minutes", "60"));
const STATION = Number(arg("station", "1"));
const BUFFER = String(arg("buffer", "min"));

const srcDb = process.env.ETHER_DB_PATH || path.join(os.homedir(), "AppData", "Local", "Ether", "com.ether.radio", "openair.db");
const tmp = path.join(os.tmpdir(), "ether-soak-" + process.pid + ".db");
fs.copyFileSync(srcDb, tmp);
for (const e of ["-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} }
const PIPE = "\\\\.\\pipe\\ether-soak-" + process.pid;
const daemonLog = path.join(os.tmpdir(), "ether-soak-daemon-" + process.pid + ".log");

const RUNTIME = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const dlog = fs.openSync(daemonLog, "a");
const daemon = cp.spawn(RUNTIME, [path.join(__dirname, "..", "audiod", "ether-audiod.js")], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ETHER_DB_PATH: tmp, ETHER_AUDIOD_PIPE: PIPE, ETHER_SOAK_BUFFER_FRAMES: BUFFER },
  stdio: ["ignore", dlog, dlog],
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
const logText = () => { try { return fs.readFileSync(daemonLog, "utf8"); } catch { return ""; } };
function cleanup(code) {
  try { daemon.kill(); } catch {}
  setTimeout(() => { for (const e of ["", "-wal", "-shm"]) { try { fs.unlinkSync(tmp + e); } catch {} } process.exit(code); }, 500);
}
const rtOf = (lv) => ({
  callbacks: lv.rt_callbacks || 0, underruns: lv.rt_underruns || 0, underrunFrames: lv.rt_underrun_frames || 0,
  overruns: lv.rt_overruns || 0, lockMisses: lv.rt_lock_misses || 0, eventsDropped: lv.rt_events_dropped || 0,
  bufferClamped: lv.rt_buffer_clamped || 0, garbageLeaked: lv.rt_garbage_leaked || 0,
});

(async () => {
  console.log(`[soak] ${MINUTES} min · station ${STATION} · ETHER_SOAK_BUFFER_FRAMES=${BUFFER} · DB copy ${tmp}`);
  console.log(`[soak] daemon log: ${daemonLog}`);
  let up = false; for (let i = 0; i < 80 && !(up = await pipeAlive()); i++) await sleep(500);
  if (!up) { console.error("[soak] daemon did not start:\n" + logText().split(/\r?\n/).slice(-25).join("\n")); return cleanup(2); }
  const app = client(); await app.connect(); await app.cmd("ping");
  await app.cmd("init", { stationId: STATION });
  try { await app.cmd("setMonitorVolume", { stationId: STATION, volume: 0.01 }); } catch {}

  const lv0 = await app.cmd("getLevels", { stationId: STATION }).catch(() => null);
  if (!lv0 || typeof lv0.rt_callbacks !== "number") {
    console.error("[soak] REFUSED: this engine does not report rt_callbacks — native/ether-audio.node is not the slice-1 build.");
    return cleanup(2);
  }
  await app.cmd("setContinuous", { stationId: STATION, value: true }).catch(() => {});
  await app.cmd("automationStart", { stationId: STATION });

  const t0 = Date.now(), end = t0 + MINUTES * 60_000;
  let base = null, prevMin = null, eqOn = false, cVol = 1.0, lastEq = 0, lastVol = 0, lastReport = t0;
  const startsAt0 = (logText().match(/ LIVE — /g) || []).length;
  while (Date.now() < end) {
    const now = Date.now();
    if (now - lastEq >= 5000) { eqOn = !eqOn; lastEq = now; await app.cmd("setEq", { stationId: STATION, bands: eqOn ? [0, 2, 0, 0, 0, -1, 0, 0, 1, 0] : [0,0,0,0,0,0,0,0,0,0] }).catch(() => {}); }
    if (now - lastVol >= 3000) { cVol = cVol === 1.0 ? 0.95 : 1.0; lastVol = now; await app.cmd("setVolume", { stationId: STATION, deck: "C", volume: cVol }).catch(() => {}); }
    if (now - lastReport >= 60_000 || base === null) {
      const lv = await app.cmd("getLevels", { stationId: STATION }).catch(() => null);
      if (lv) {
        const rt = rtOf(lv);
        if (!base) base = rt;
        const d = (k) => rt[k] - (prevMin ? prevMin[k] : base[k]);
        const starts = (logText().match(/ LIVE — /g) || []).length - startsAt0;
        console.log(`[soak] t+${Math.round((now - t0) / 60000)}m  callbacks ${rt.callbacks - base.callbacks}  ` +
          `Δ underruns ${d("underruns")} overruns ${d("overruns")} lock-misses ${d("lockMisses")} events-dropped ${d("eventsDropped")}  ` +
          `| tracks started ${starts}`);
        prevMin = rt; lastReport = now;
      }
    }
    await sleep(250);
  }
  await app.cmd("automationStop", { stationId: STATION }).catch(() => {});
  const lv = await app.cmd("getLevels", { stationId: STATION }).catch(() => null);
  const rt = lv ? rtOf(lv) : null;
  const log = logText();
  const starts = (log.match(/ LIVE — /g) || []).length - startsAt0;
  console.log("\n[soak] ── RESULT ──────────────────────────────────────────────");
  if (!rt || !base) { console.log("[soak] no counters read"); return cleanup(1); }
  const tot = (k) => rt[k] - base[k];
  console.log(`[soak] duration ${MINUTES} min · callbacks ${tot("callbacks")} · tracks started ${starts}`);
  console.log(`[soak] underruns ${tot("underruns")} (${tot("underrunFrames")} silent frames) · overruns ${tot("overruns")} · lock misses ${tot("lockMisses")}`);
  console.log(`[soak] events dropped ${tot("eventsDropped")} · buffers clamped ${tot("bufferClamped")} · garbage leaked ${tot("garbageLeaked")}`);
  for (const l of log.split(/\r?\n/)) if (/SOAK:|UNDERRUN|panicked|build_output_stream/.test(l)) console.log("[soak] log: " + l);
  const pass = tot("underruns") === 0 && tot("overruns") === 0 && tot("lockMisses") === 0 && !/panicked/.test(log) && starts > 0;
  console.log(pass ? "[soak] PASS — zero underruns, zero overruns, zero lock misses, tracks loaded" : "[soak] NOT CLEAN — see the counts above");
  cleanup(pass ? 0 : 1);
})().catch(e => { console.error("[soak] error:", e && e.message); cleanup(1); });
