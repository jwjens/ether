// scripts/smoke-attach-after-restore.js — TODAY'S SEQUENCE ON THE REAL DAEMON (Jeff, 2026-10-12).
//
// docs/station-monitor-zeroed-at-attach-2026-10-12.md. Jeff: "simulate the exact sequence from today's log (engine
// restores, then the window attaches) and prove no station's level changes and no fader needs a nudge."
//
//   1. The REAL daemon (audiod/ether-audiod.js + the built native engine) on a private pipe, with a throwaway database
//      holding halloVeen's saved board (station MONITOR 0.68 as the 20:26 connect pass read it).
//   2. It restores at its own start; then main's connect step (applySavedBoard "app connect"), exactly as today.
//   3. The window attaches: the REAL renderer engine (src/audio/engine-rodio.ts, bundled with esbuild) runs its whole
//      attach path. Its bridge routes every setter to the daemon exactly as main does (_boardSend: setMonitorVolume →
//      { stationId, volume }, …) and records it.
//   4. 1.5 s later (the zero landed 0.5 s after the adopt): the live board is read back from the engine and compared.
// CONTROL: the same run with the engine-rodio.ts of the last commit (git HEAD, before the fix) must show the zero.
// Never touches the installed app, its pipe or its database.
//   node scripts/smoke-attach-after-restore.js            (the working tree)
//   node scripts/smoke-attach-after-restore.js --control  (also runs the pre-fix HEAD engine and expects it to fail)
"use strict";
const net = require("net"), path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const B = require("../audiod/board-state");

const ROOT = path.join(__dirname, "..");
const DAEMON = path.join(ROOT, "audiod", "ether-audiod.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ether-attach-restore-"));
const DB = path.join(TMP, "openair.db");
const SIDS = [1, 2];
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT);
           CREATE TABLE deck_configs (station_id INTEGER, slot TEXT, type TEXT, kind TEXT, enabled INTEGER, channel_on INTEGER, duck INTEGER, duckable INTEGER, deleted_at TEXT);
           CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);
           INSERT INTO stations (id, name) VALUES (1, 'Open Format'), (2, 'halloVeen');`);
  const dc = db.prepare("INSERT INTO deck_configs VALUES (?, ?, ?, ?, 1, ?, ?, 1, NULL)");
  const kv = db.prepare("INSERT INTO station_config_kv VALUES (?, ?, ?, NULL)");
  for (const sid of SIDS) {
    for (const [s, t, k, on, duck] of [["A", "music", "", 1, 0], ["B", "music", "", 1, 0], ["D", "source", "announcement", 1, 1], ["E", "source", "jukebox", 1, 0]]) dc.run(sid, s, t, k, on, duck);
    kv.run(sid, "monitor_volume", sid === 2 ? "0.68" : "0");
    kv.run(sid, "master_monitor_volume", "0.2320675105485232");
    kv.run(sid, "board_levels", JSON.stringify({ A: 0.8, B: 0.7, D: 0.9, E: 0.4, master: 0.9 }));
    kv.run(sid, "aux_monitor_levels", JSON.stringify({ D: 0.82, E: 0.5 }));
    kv.run(sid, "jukebox_channel_on", "1");
    kv.run(sid, "cart_channel_on", "0");
    kv.run(sid, "segue_overlap_sec", "5");
  }
  db.close();
}

function client(pipe) {
  return (cmd, args = {}) => new Promise((res) => {
    const s = net.connect(pipe); let buf = "", done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} res(v); };
    s.once("connect", () => s.write(JSON.stringify({ id: 1, cmd, ...args }) + "\n"));
    s.on("data", (d) => { buf += d; const nl = buf.indexOf("\n"); if (nl < 0) return; try { const m = JSON.parse(buf.slice(0, nl)); fin(m.ok ? m.result : { ok: false, reason: m.error }); } catch { fin(null); } });
    s.once("error", () => fin(null)); setTimeout(() => fin(null), 4000);
  });
}

/** Bundle a version of the renderer engine for node (esbuild, CJS). */
function bundle(srcFile, out) {
  const esb = path.join(ROOT, "node_modules", "esbuild");
  require(esb).buildSync({ entryPoints: [srcFile], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error" });
  return out;
}

/** window.ether as main presents it, over the daemon pipe. Every setter recorded. */
function bridge(ask, writes, rot) {
  const W = (name, cmd, map) => (...a) => { writes.push(`${name}${JSON.stringify(a)}`); return ask(cmd, map(...a)); };
  const audio = {
    daemonEnabled: async () => true,
    daemon: async (cmd, args) => { if (/^(set|apply)/.test(cmd)) writes.push(`daemon:${cmd}${JSON.stringify(args)}`); return ask(cmd, args || {}); },
    getState: (sid) => ask("getState", { stationId: sid }),
    setVolume: W("setVolume", "setVolume", (deck, volume, stationId) => ({ deck, volume, stationId })),
    setMuted: W("setMuted", "setMuted", (deck, muted, stationId) => ({ deck, muted, stationId })),
    setMonitorVolume: W("setMonitorVolume", "setMonitorVolume", (stationId, volume) => ({ stationId, volume })),
    setMasterVolume: W("setMasterVolume", "setMasterVolume", (stationId, volume) => ({ stationId, volume })),
  };
  const proxy = new Proxy(audio, { get(t, k) {
    if (k in t) return t[k];
    if (typeof k === "string" && /^set/.test(k)) return (...a) => { writes.push(`${k}${JSON.stringify(a)}`); return true; };
    return () => () => {};
  } });
  return { audio: proxy, fs: { logRotation: (m) => rot.push(m) } };
}

async function run(tag, engineFile) {
  const PIPE = process.platform === "win32" ? `\\\\.\\pipe\\ether-attach-restore-${process.pid}-${tag}` : path.join(TMP, `${tag}.sock`);
  const ask = client(PIPE);
  const child = cp.spawn(process.execPath, [DAEMON], { stdio: "ignore", env: { ...process.env, ETHER_AUDIOD_PIPE: PIPE, ETHER_DB_PATH: DB, ETHER_AUDIOD_LOG: path.join(TMP, `audiod-${tag}.log`) } });
  try {
    let up = false; for (let i = 0; i < 60 && !up; i++) { const p = await ask("ping"); up = !!(p && p.pong); if (!up) await sleep(250); }
    ok(up, `${tag}: the real daemon is up`);
    if (!up) return null;
    // 1 · THE ENGINE RESTORES (its own start) — then main's connect step, as at 20:26:05.
    await ask("applySavedBoard", { reason: "app connect" });
    const readAll = async () => { const o = {}; for (const sid of SIDS) { let b = null; for (let i = 0; i < 40; i++) { b = await ask("getBoardState", { stationId: sid }); if (b && b.ok && b.applied) break; await sleep(250); } o[sid] = b; } return o; };
    const db = new DatabaseSync(DB, { readOnly: true });
    const saved = Object.fromEntries(SIDS.map(sid => [sid, B.readSavedBoard(db, sid)]));
    const before = await readAll();
    for (const sid of SIDS) ok(B.compareBoard(saved[sid], before[sid]).length === 0, `${tag} s${sid}: the engine restored the saved board (station MONITOR ${before[sid].control.monitor_vol})`);
    // 2 · THE WINDOW ATTACHES — the real renderer engine, both stations.
    const writes = [], rot = [];
    global.window = { ether: bridge(ask, writes, rot) };
    delete require.cache[engineFile];
    const { AudioEngine } = require(engineFile);
    const engines = SIDS.map(sid => { const e = new AudioEngine(sid); e.init(); return e; });
    for (let i = 0; i < 100 && rot.filter(m => m.includes("ADOPT")).length < SIDS.length; i++) await sleep(50);
    ok(rot.filter(m => m.includes("ADOPT")).length === SIDS.length, `${tag}: both windows attached (ADOPT ×${SIDS.length})`);
    await sleep(1500);
    engines.forEach(e => e.stop());
    // 3 · READ BACK.
    const after = await readAll();
    const diffs = {};
    for (const sid of SIDS) diffs[sid] = B.compareBoard(saved[sid], after[sid]);
    db.close();
    return { writes, before, after, diffs };
  } finally { try { child.kill(); } catch {} await sleep(500); }
}

(async () => {
  console.log("daemon:", DAEMON, "\ndb:", DB);
  const cur = bundle(path.join(ROOT, "src", "audio", "engine-rodio.ts"), path.join(TMP, "engine-current.js"));
  const r = await run("fixed", cur);
  if (r) {
    ok(r.writes.length === 0, `fixed: the window wrote nothing on attach${r.writes.length ? ` — ${r.writes.join(", ")}` : ""}`);
    for (const sid of SIDS) {
      const same = ["control", "applied"].every(w => JSON.stringify(r.before[sid][w]) === JSON.stringify(r.after[sid][w]));
      ok(same, `fixed s${sid}: no level changed (station MONITOR ${r.before[sid].control.monitor_vol} → ${r.after[sid].control.monitor_vol}, MASTER ${r.after[sid].control.master_vol}, CART ${r.after[sid].control.slots.CART && r.after[sid].control.slots.CART.muted ? "OFF" : "ON"})`);
      ok(r.diffs[sid].length === 0, `fixed s${sid}: live = saved after the attach — no fader needs a nudge${r.diffs[sid].length ? ` (${r.diffs[sid].map(d => d.setting).join(",")})` : ""}`);
    }
  }
  if (process.argv.includes("--control")) {
    const headSrc = path.join(TMP, "engine-rodio.head.ts"), headBoot = path.join(TMP, "boot-seq.ts");
    fs.writeFileSync(headSrc, cp.execSync("git show HEAD:src/audio/engine-rodio.ts", { cwd: ROOT, maxBuffer: 1 << 26 }));
    fs.copyFileSync(path.join(ROOT, "src", "audio", "boot-seq.ts"), headBoot);
    const old = bundle(headSrc, path.join(TMP, "engine-head.js"));
    const c = await run("control-HEAD", old);
    if (c) {
      ok(c.writes.some(w => /^setMonitorVolume\[2,0\]/.test(w)), `CONTROL (pre-fix engine): the window zeroed halloVeen's station MONITOR on attach — ${c.writes.filter(w => /setMonitorVolume/.test(w)).join(", ")}`);
      ok(c.diffs[2].some(d => d.setting === "monitorVol" && d.live === 0), `CONTROL: live ≠ saved afterwards — ${c.diffs[2].map(d => `${d.label}: saved ${d.saved}, live ${d.live} (${d.where})`).join("; ")}`);
    }
  }
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();
