// scripts/smoke-board-restore.js — the daemon restores the saved board ITSELF, with no app (2026-10-11).
//
// docs/board-state-on-connect-diagnosis-2026-10-11.md. Jeff's ruling: "the daemon must restore its own state when it
// restarts without the app." This starts the REAL daemon (audiod/ether-audiod.js + the built native engine) on a
// private pipe with a throwaway database holding a station's saved board, never sends it a single board command, and
// reads the engine's live board back (getBoardState). Then it kills the daemon, starts it again — still no app — and
// reads again. Both reads must match the saved board, in the control copy AND in what the audio callback mixed with.
// Never touches the installed app, its pipe or its database. Loads no audio (the engine plays silence).
//   node scripts/smoke-board-restore.js
"use strict";
const net = require("net"), path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const DAEMON = path.join(ROOT, "audiod", "ether-audiod.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ether-board-restore-"));
const DB = path.join(TMP, "openair.db");
const PIPE = process.platform === "win32" ? `\\\\.\\pipe\\ether-board-restore-${process.pid}` : path.join(TMP, "audiod.sock");
const SID = 2;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };

// The saved board — station 2 as OVEVENTS had it on 2026-10-11.
{
  const db = new DatabaseSync(DB);
  db.exec(`CREATE TABLE stations (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT);
           CREATE TABLE deck_configs (station_id INTEGER, slot TEXT, type TEXT, kind TEXT, enabled INTEGER, channel_on INTEGER, duck INTEGER, duckable INTEGER, deleted_at TEXT);
           CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);
           INSERT INTO stations (id, name) VALUES (${SID}, 'smoke');`);
  const dc = db.prepare("INSERT INTO deck_configs VALUES (?, ?, ?, ?, 1, ?, ?, 1, NULL)");
  for (const [s, t, k, on, duck] of [["A", "music", "", 1, 0], ["D", "source", "announcement", 1, 1], ["E", "source", "jingle", 1, 1], ["F", "source", "link", 0, 0], ["S1", "source", "cart", 1, 1]]) dc.run(SID, s, t, k, on, duck);
  const kv = db.prepare("INSERT INTO station_config_kv VALUES (?, ?, ?, NULL)");
  kv.run(SID, "aux_monitor_levels", JSON.stringify({ D: 0.82, E: 0.83, S1: 0.74, F: 0.56 }));
  kv.run(SID, "board_levels", JSON.stringify({ E: 0.15, D: 1, A: 0.9, master: 0.95 }));
  kv.run(SID, "monitor_volume", "0.73");
  kv.run(SID, "master_monitor_volume", "0.4641");
  db.close();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ask(cmd, args = {}) {
  return new Promise((res) => {
    const s = net.connect(PIPE); let buf = "", done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} res(v); };
    s.once("connect", () => s.write(JSON.stringify({ id: 1, cmd, ...args }) + "\n"));
    s.on("data", (d) => { buf += d; const nl = buf.indexOf("\n"); if (nl < 0) return; try { const m = JSON.parse(buf.slice(0, nl)); fin(m.ok ? m.result : { ok: false, reason: m.error }); } catch { fin(null); } });
    s.once("error", () => fin(null)); setTimeout(() => fin(null), 4000);
  });
}
function start(tag) {
  const child = cp.spawn(process.execPath, [DAEMON], { stdio: "ignore", env: { ...process.env, ETHER_AUDIOD_PIPE: PIPE, ETHER_DB_PATH: DB, ETHER_AUDIOD_LOG: path.join(TMP, `audiod-${tag}.log`) } });
  return child;
}
async function waitUp() { for (let i = 0; i < 60; i++) { const p = await ask("ping"); if (p && p.pong) return true; await sleep(250); } return false; }

async function check(tag) {
  // NO board command is sent. The only thing asked is a read.
  // The callback adopts a params block at the top of its next buffer once the output is open; poll until the copy it
  // MIXED WITH matches (or 10 s), and say how long that took. A copy that never matches fails below.
  let b = null; const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    b = await ask("getBoardState", { stationId: SID });
    if (b && b.ok && b.applied && Math.abs(b.applied.slots.S1.aux_monitor_gain - 0.74) < 1e-3 && Math.abs(b.applied.master_monitor_vol - 0.4641) < 1e-3) break;
    await sleep(250);
  }
  console.log(`  ..   ${tag}: read after ${Date.now() - t0} ms`);
  ok(!!(b && b.ok), `${tag}: the engine answers getBoardState`);
  if (!b || !b.ok) return;
  for (const where of ["control", "applied"]) {
    const p = b[where]; if (!p) { ok(false, `${tag}: no ${where} copy`); continue; }
    const s = p.slots;
    ok(Math.abs(s.S1.aux_monitor_gain - 0.74) < 1e-3 && Math.abs(s.E.aux_monitor_gain - 0.83) < 1e-3 && Math.abs(s.D.aux_monitor_gain - 0.82) < 1e-3,
       `${tag} ${where}: every Source fader's AUX row is the saved one (S1 ${s.S1.aux_monitor_gain.toFixed(3)}, E ${s.E.aux_monitor_gain.toFixed(3)}, D ${s.D.aux_monitor_gain.toFixed(3)})`);
    ok(Math.abs(s.E.volume - 0.15) < 1e-3 && Math.abs(s.A.volume - 0.9) < 1e-3, `${tag} ${where}: saved fader levels (E ${s.E.volume.toFixed(3)}, A ${s.A.volume.toFixed(3)})`);
    ok(s.F.muted === true && s.S1.muted === false, `${tag} ${where}: saved channel cuts (F off, S1 on)`);
    ok(s.D.local === "aux" && s.S1.local === "aux" && s.A.local === "main", `${tag} ${where}: each fader's local output restored (A main, D aux, S1 aux)`);
    ok(s.D.duck === true && s.D.duckable === false && s.A.duck === false && s.A.duckable === true, `${tag} ${where}: ducks / ducked restored as today (D ducks, not ducked; A ducked, does not duck)`);
    ok(Math.abs((p.fader_smoothing_ms ?? -1) - 20) < 0.1, `${tag} ${where}: fader smoothing ${p.fader_smoothing_ms} ms`);
    ok(Math.abs(p.monitor_vol - 0.73) < 1e-3 && Math.abs(p.master_monitor_vol - 0.4641) < 1e-3 && Math.abs(p.master_vol - 0.95) < 1e-3,
       `${tag} ${where}: MONITOR ${p.monitor_vol.toFixed(3)} × master ${p.master_monitor_vol.toFixed(4)}, master fader ${p.master_vol.toFixed(3)}`);
  }
  const ls = await ask("loudnessStatus");
  ok(!!(ls && typeof ls.cached === "number"), `${tag}: the loudness measurer answers (${JSON.stringify(ls)})`);
  const log = fs.readFileSync(path.join(TMP, `audiod-${tag.split(" ")[0]}.log`), "utf8");
  ok(/\[board s2\] saved board applied \(engine start\)/.test(log), `${tag}: the daemon logged its own start-up restore`);
}

(async () => {
  console.log("daemon:", DAEMON, "\npipe:", PIPE, "\ndb:", DB);
  let d = start("first");
  ok(await waitUp(), "first start: the daemon is up (no app)");
  await check("first start");
  try { d.kill(); } catch {}
  await sleep(1500);
  d = start("restart");
  ok(await waitUp(), "restart: the daemon is up again (still no app)");
  await check("restart");
  try { d.kill(); } catch {}
  // SILENT UNTIL KNOWN (Jeff, 2026-10-11): no master MONITOR saved anywhere → the engine holds the local output at 0.
  await sleep(1500);
  { const db = new DatabaseSync(DB); db.exec("DELETE FROM station_config_kv WHERE key = 'master_monitor_volume'"); db.close(); }
  d = start("nomonitor");
  ok(await waitUp(), "no saved MONITOR: the daemon is up");
  let b = null;
  for (let i = 0; i < 40; i++) { b = await ask("getBoardState", { stationId: SID }); if (b && b.ok && b.applied) break; await sleep(250); }
  ok(!!(b && b.ok && b.control.master_monitor_vol === 0 && b.applied && b.applied.master_monitor_vol === 0),
     `no saved MONITOR: the room is SILENT (control ${b && b.control && b.control.master_monitor_vol}, applied ${b && b.applied && b.applied.master_monitor_vol}) — never a placeholder`);
  ok(!!(b && b.control && Math.abs(b.control.slots.S1.aux_monitor_gain - 0.74) < 1e-3), "no saved MONITOR: everything else is still restored");
  try { d.kill(); } catch {}
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();
